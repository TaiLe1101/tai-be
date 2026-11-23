import { HttpService } from '@nestjs/axios';
import {
  BadGatewayException,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import type {
  WorkerHealthStatus,
  WorkerTranslateSegmentRequest,
  WorkerTranslateSegmentResponse,
} from './dubbing.types';

export const SUBTITLE_DOWNLOAD_FAILED_CODE = 'SUBTITLE_DOWNLOAD_FAILED';

export class SubtitleDownloadFailedException extends UnprocessableEntityException {
  constructor(message: string) {
    super({
      code: SUBTITLE_DOWNLOAD_FAILED_CODE,
      message,
    });
  }
}

export interface WorkerSynthesizeTtsResult {
  audio: Buffer;
  duration: number;
  voice: string;
  rate: string;
}

@Injectable()
export class DubbingWorkerClient {
  private readonly logger = new Logger(DubbingWorkerClient.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  private get workerUrl(): string {
    return (
      this.configService.get<string>('WORKER_URL') || 'http://127.0.0.1:8000'
    )
      .trim()
      .replace(/\/+$/, '');
  }

  private get workerApiKey(): string {
    return (this.configService.get<string>('WORKER_API_KEY') || '').trim();
  }

  private get maxPayloadChars(): number {
    return (
      this.configService.get<number>('DUBBING_MAX_PAYLOAD_CHARS') || 2_000_000
    );
  }

  private workerHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.workerApiKey) {
      headers['X-API-Key'] = this.workerApiKey;
    }
    return headers;
  }

  async checkHealth(): Promise<WorkerHealthStatus> {
    try {
      const response = await firstValueFrom(
        this.httpService.get<{
          status?: string;
          protocol?: string;
          capabilities?: string[];
        }>(`${this.workerUrl}/health`, {
          headers: this.workerHeaders(),
          timeout: 5000,
        }),
      );
      const data = response.data ?? {};
      return {
        ok: response.status >= 200 && response.status < 300 && data.status === 'ok',
        ...(typeof data.protocol === 'string' ? { protocol: data.protocol } : {}),
        ...(Array.isArray(data.capabilities)
          ? { capabilities: data.capabilities }
          : {}),
      };
    } catch (error) {
      this.logger.warn(
        `Worker health check failed (${this.workerUrl}): ${this.formatError(error)}`,
      );
      return { ok: false };
    }
  }

  async downloadSubtitleUrl(subtitleUrl: string): Promise<string> {
    let parsed: URL;
    try {
      parsed = new URL(subtitleUrl);
    } catch {
      throw new SubtitleDownloadFailedException('Invalid subtitleUrl');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new SubtitleDownloadFailedException(
        'subtitleUrl must use http or https',
      );
    }

    try {
      // Origin-isolated: never send worker/server credentials to external subtitle URLs.
      const response = await firstValueFrom(
        this.httpService.get<string>(parsed.href, {
          responseType: 'text',
          timeout: 15_000,
          maxContentLength: this.maxPayloadChars * 4,
          headers: {
            Accept: 'application/json, text/xml, application/xml, text/plain, */*',
          },
          validateStatus: () => true,
        }),
      );

      if (response.status < 200 || response.status >= 300) {
        throw new SubtitleDownloadFailedException(
          `Subtitle URL responded with HTTP ${response.status}`,
        );
      }

      const body =
        typeof response.data === 'string'
          ? response.data
          : response.data !== undefined && response.data !== null
            ? JSON.stringify(response.data)
            : '';

      if (!body.trim()) {
        throw new SubtitleDownloadFailedException(
          'Subtitle URL returned an empty body',
        );
      }

      return body;
    } catch (error) {
      if (error instanceof SubtitleDownloadFailedException) {
        throw error;
      }
      throw new SubtitleDownloadFailedException(
        `Failed to download subtitle URL: ${this.formatError(error)}`,
      );
    }
  }

  async translateSegment(
    payload: WorkerTranslateSegmentRequest,
  ): Promise<WorkerTranslateSegmentResponse> {
    try {
      const response = await firstValueFrom(
        this.httpService.post<WorkerTranslateSegmentResponse>(
          `${this.workerUrl}/translate-segment`,
          payload,
          {
            headers: {
              ...this.workerHeaders(),
              'Content-Type': 'application/json',
            },
            timeout: 60_000,
          },
        ),
      );
      return response.data;
    } catch (error) {
      this.logger.error(
        `Worker /translate-segment failed: ${this.formatError(error)}`,
      );
      throw new BadGatewayException({
        code: 'WORKER_TRANSLATION_FAILED',
        message: 'Failed to translate subtitle segment via AI worker',
      });
    }
  }

  async synthesizeTts(payload: {
    text: string;
    lang: string;
    voice?: string;
    rate?: string | number;
  }): Promise<WorkerSynthesizeTtsResult> {
    try {
      const response = await firstValueFrom(
        this.httpService.post<ArrayBuffer | Buffer>(
          `${this.workerUrl}/synthesize-tts`,
          payload,
          {
            headers: {
              ...this.workerHeaders(),
              'Content-Type': 'application/json',
            },
            responseType: 'arraybuffer',
            timeout: 30_000,
          },
        ),
      );

      const audio = Buffer.isBuffer(response.data)
        ? response.data
        : Buffer.from(response.data);

      const headers = response.headers ?? {};
      const durationHeader = this.readHeader(headers, 'x-audio-duration');
      const parsedDuration = durationHeader
        ? Number.parseFloat(durationHeader)
        : 0;
      const duration =
        Number.isFinite(parsedDuration) && parsedDuration > 0
          ? parsedDuration
          : 0;

      const voice =
        this.readHeader(headers, 'x-tts-voice') || payload.voice || '';
      const rate =
        this.readHeader(headers, 'x-tts-rate') ||
        (payload.rate !== undefined ? String(payload.rate) : '+0%');

      return { audio, duration, voice, rate };
    } catch (error) {
      this.logger.error(
        `Worker /synthesize-tts failed: ${this.formatError(error)}`,
      );
      throw new BadGatewayException({
        code: 'WORKER_TTS_FAILED',
        message: 'Failed to synthesize TTS audio via AI worker',
      });
    }
  }

  private readHeader(
    headers: Record<string, unknown>,
    name: string,
  ): string | undefined {
    const raw = headers[name] ?? headers[name.toLowerCase()];
    if (Array.isArray(raw)) {
      return typeof raw[0] === 'string' ? raw[0] : undefined;
    }
    return typeof raw === 'string' ? raw : undefined;
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
