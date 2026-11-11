import {
  Controller,
  Get,
  HttpException,
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

  @Get('latest.yml')
  @ApiOperation({ summary: 'Manifest của phiên bản stable hiện tại' })
  async latest(@Res() response: Response) {
    const manifest = await this.releases.latestManifest();
    response.setHeader('Cache-Control', 'no-store');
    response.type('text/yaml').send(manifest);
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
