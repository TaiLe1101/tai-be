import { Module } from '@nestjs/common';
import { AppReleaseDownloadController } from './app-release-download.controller';
import { AppReleasesController } from './app-releases.controller';
import { AppReleasesService } from './app-releases.service';
import { AppReleaseChunksController } from './app-release-chunks.controller';
import { AppReleaseChunksService } from './app-release-chunks.service';

@Module({
  controllers: [
    AppReleaseChunksController,
    AppReleasesController,
    AppReleaseDownloadController,
  ],
  providers: [AppReleasesService, AppReleaseChunksService],
})
export class AppReleasesModule {}
