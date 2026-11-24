import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Res,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { basename, dirname } from 'node:path';
import { Public } from '~/common/decorators/public.decorator';
import { AppReleasesService } from './app-releases.service';

@Public()
@ApiTags('Desktop auto update (public)')
@Controller({ path: 'uploads/app/release', version: VERSION_NEUTRAL })
export class AppReleaseDownloadController {
  constructor(private readonly releases: AppReleasesService) {}

  private applyPublicCors(response: Response) {
    response.removeHeader('Access-Control-Allow-Credentials');
    response.setHeader('Access-Control-Allow-Origin', '*');
  }

  @Get('latest.yml')
  @ApiOperation({ summary: 'Manifest của phiên bản stable hiện tại' })
  async latest(@Res() response: Response) {
    const manifest = await this.releases.latestManifest();
    this.applyPublicCors(response);
    response.setHeader('Cache-Control', 'no-store');
    response.type('text/yaml').send(manifest);
  }

  @Get('latest.json')
  @ApiOperation({
    summary: 'Metadata JSON của phiên bản stable hiện tại cho landing page',
  })
  async latestJson(@Res() response: Response) {
    const metadata = await this.releases.latestPublicMetadata();
    this.applyPublicCors(response);
    response.setHeader('Cache-Control', 'no-store');
    response.json(metadata);
  }

  @Get('latest/download')
  @ApiOperation({
    summary: 'Chuyển hướng 302 tới bộ cài của phiên bản stable hiện tại',
  })
  async latestDownload(@Res() response: Response) {
    const downloadUrl = await this.releases.latestDownloadUrl();
    response.setHeader('Cache-Control', 'no-store');
    response.redirect(HttpStatus.FOUND, downloadUrl);
  }

  @Get(':version/:filename')
  @ApiOperation({
    summary: 'Tải file của phiên bản đã phát hành (hỗ trợ Range/HEAD)',
  })
  async download(
    @Param('version') version: string,
    @Param('filename') filename: string,
    @Res() response: Response,
  ) {
    const path = await this.releases.publicFile(version, filename);
    response.type(
      filename === 'latest.yml' ? 'text/yaml' : 'application/octet-stream',
    );
    await new Promise<void>((resolve, reject) => {
      response.sendFile(
        basename(path),
        {
          root: dirname(path),
          acceptRanges: true,
          cacheControl: true,
          maxAge: '1y',
          immutable: true,
        },
        (error) => {
          if (!error || response.headersSent) {
            resolve();
            return;
          }
          const status = (error as Error & { status?: number }).status ?? 500;
          reject(
            new HttpException(
              status === 404
                ? 'Không tìm thấy file phát hành'
                : 'Không thể tải file phát hành',
              status,
            ),
          );
        },
      );
    });
  }
}
