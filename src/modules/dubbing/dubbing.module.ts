import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { RedisModule } from '~/modules/redis/redis.module';
import { DubbingCacheService } from './dubbing-cache.service';
import { DubbingController } from './dubbing.controller';
import { DubbingSigningService } from './dubbing-signing.service';
import { DubbingWorkerClient } from './dubbing-worker.client';
import { DubbingService } from './dubbing.service';

@Module({
  imports: [HttpModule, RedisModule],
  controllers: [DubbingController],
  providers: [
    DubbingSigningService,
    DubbingCacheService,
    DubbingWorkerClient,
    DubbingService,
  ],
  exports: [DubbingService, DubbingSigningService],
})
export class DubbingModule {}
