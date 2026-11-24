import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  PayloadTooLargeException,
  Post,
  Req,
  Res,
  UseFilters,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { createGunzip } from 'node:zlib';
import { Public } from '~/common/decorators/public.decorator';
import { CurrentUser } from '~/modules/auth/decorators/current-user.decorator';
import type { CurrentUserType } from '~/types/current-user.type';
import { DubbingExceptionFilter } from './dubbing-exception.filter';
import { DubbingService } from './dubbing.service';
import type {
  SegmentsRequest,
  SessionsRequest,
  TtsJsonResponse,
  TtsRequest,
  YoutubeSubtitlesRequest,
} from './dubbing.types';

const MAX_COMPRESSED_BYTES = 10 * 1024 * 1024;

@ApiBearerAuth('JWT-Auth')
@UseFilters(DubbingExceptionFilter)
@ApiTags('Realtime Dubbing')
@Controller('dubbing')
export class DubbingController {
  constructor(
    private readonly dubbingService: DubbingService,
    private readonly configService: ConfigService,
  ) {}

  private get maxPayloadChars(): number {
    return (
      this.configService.get<number>('DUBBING_MAX_PAYLOAD_CHARS') || 2_000_000
    );
  }

  @Public()
  @Get('health')
  @ApiOperation({ summary: 'Realtime dubbing gateway and AI worker health' })
  async health() {
    return this.dubbingService.health();
  }

  @Post('youtube-subtitles')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Fast-path YouTube subtitles ingestion (accepts application/gzip or application/json)',
  })
  async youtubeSubtitles(
    @CurrentUser() user: CurrentUserType,
    @Req() req: Request,
  ) {
    await this.dubbingService.assertCanDub(user);
    const payload = await this.parseYoutubeSubtitlesBody(req);
    return this.dubbingService.processYoutubeSubtitles(payload);
  }

  @Post('segments')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Segmented AI translation path (seek-on-demand or lookahead)',
  })
  async segments(
    @CurrentUser() user: CurrentUserType,
    @Body() body: SegmentsRequest,
  ) {
    await this.dubbingService.assertCanDub(user);
    return this.dubbingService.getSegment(body);
  }

  @Post('tts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'HMAC-verified inline neural TTS synthesis with Redis audio+duration caching',
  })
  async tts(
    @CurrentUser() user: CurrentUserType,
    @Body() body: TtsRequest,
    @Res() res: Response,
  ) {
    await this.dubbingService.assertCanDub(user);
    const result = await this.dubbingService.synthesizeTts(body);

    res.setHeader('X-Audio-Duration', String(result.duration));
    res.setHeader('X-TTS-Voice', result.voice);
    res.setHeader('X-TTS-Rate', result.rate);
    res.setHeader('X-Cache', result.cache);
    res.setHeader('Cache-Control', 'no-store');

    if (body?.inline === false) {
      const json: TtsJsonResponse = {
        audioBase64: result.audio.toString('base64'),
        contentType: 'audio/mpeg',
        duration: result.duration,
        voice: result.voice,
        rate: result.rate,
      };
      res.status(HttpStatus.OK).json(json);
      return;
    }

    res.status(HttpStatus.OK).type('audio/mpeg').send(result.audio);
  }

  @Post('sessions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Batched dubbing playback telemetry (max 20)' })
  async sessions(
    @CurrentUser() user: CurrentUserType,
    @Body() body: SessionsRequest,
  ) {
    return this.dubbingService.ingestSessions(body?.sessions, user);
  }

  private async parseYoutubeSubtitlesBody(
    req: Request,
  ): Promise<YoutubeSubtitlesRequest> {
    const maxChars = this.maxPayloadChars;
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
    const isGzip =
      contentType.startsWith('application/gzip') ||
      contentType.startsWith('application/x-gzip');

    if (isGzip) {
      const compressed = await this.readRawBuffer(req);
      const decompressed = await this.gunzipWithLimit(compressed, maxChars);
      if (decompressed.length > maxChars) {
        throw new PayloadTooLargeException({
          code: 'PAYLOAD_TOO_LARGE',
          message: `Decompressed subtitle payload exceeds ${maxChars} characters`,
        });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(decompressed);
      } catch {
        throw new BadRequestException({
          code: 'INVALID_JSON',
          message: 'Decompressed gzip payload is not valid JSON',
        });
      }
      return parsed as YoutubeSubtitlesRequest;
    }

    const body = req.body as YoutubeSubtitlesRequest | undefined;
    if (!body || typeof body !== 'object') {
      throw new BadRequestException({
        code: 'INVALID_BODY',
        message: 'Request body must be JSON or gzipped JSON',
      });
    }

    const subtitleLen =
      typeof body.subtitleText === 'string' ? body.subtitleText.length : 0;
    const sourceLen =
      typeof body.sourceText === 'string' ? body.sourceText.length : 0;
    if (subtitleLen + sourceLen > maxChars) {
      throw new PayloadTooLargeException({
        code: 'PAYLOAD_TOO_LARGE',
        message: `Subtitle payload exceeds ${maxChars} characters`,
      });
    }

    return body;
  }

  private async readRawBuffer(req: Request): Promise<Buffer> {
    if (Buffer.isBuffer(req.body)) {
      return req.body;
    }
    if (req.readableEnded) {
      throw new BadRequestException({
        code: 'EMPTY_GZIP_BODY',
        message: 'Empty gzip request body',
      });
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += buf.length;
      if (total > MAX_COMPRESSED_BYTES) {
        throw new PayloadTooLargeException({
          code: 'PAYLOAD_TOO_LARGE',
          message: 'Compressed payload exceeds maximum size',
        });
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks, total);
  }

  private gunzipWithLimit(
    compressed: Buffer,
    maxChars: number,
  ): Promise<string> {
    const maxBytes = maxChars * 4 + 16_384;
    return new Promise<string>((resolve, reject) => {
      const gunzip = createGunzip();
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let settled = false;

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        gunzip.destroy();
        reject(err);
      };

      gunzip.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          fail(
            new PayloadTooLargeException({
              code: 'PAYLOAD_TOO_LARGE',
              message: `Decompressed subtitle payload exceeds ${maxChars} characters`,
            }),
          );
          return;
        }
        chunks.push(chunk);
      });

      gunzip.on('error', () => {
        fail(
          new BadRequestException({
            code: 'INVALID_GZIP',
            message: 'Invalid gzip payload',
          }),
        );
      });

      gunzip.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks, totalBytes).toString('utf8'));
      });

      gunzip.end(compressed);
    });
  }
}
