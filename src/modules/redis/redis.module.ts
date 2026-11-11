import { Module } from '@nestjs/common';
import { RedisService } from './redis.service';
import { RedisProvider } from '~/modules/redis/redis.provider';

@Module({
  providers: [RedisProvider, RedisService],
  exports: [RedisService],
})
export class RedisModule { }
