import { Module } from '@nestjs/common';
import { AppReleaseDownloadController } from './app-release-download.controller';
import { AppReleasesController } from './app-releases.controller';
import { AppReleasesService } from './app-releases.service';

@Module({
  controllers: [AppReleasesController, AppReleaseDownloadController],
  providers: [AppReleasesService],
})
export class AppReleasesModule {}
