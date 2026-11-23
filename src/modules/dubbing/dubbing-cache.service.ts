import { Injectable, Logger, Optional } from '@nestjs/common';
import { RedisService } from '~/modules/redis/redis.service';
import type { DubbingSessionTelemetry } from './dubbing.types';

const RECENT_SESSIONS_KEY = 'dub:sessions:recent';
const MAX_RECENT_SESSIONS = 1000;

@Injectable()
export class DubbingCacheService {
  private readonly logger = new Logger(DubbingCacheService.name);

  constructor(@Optional() private readonly redisService?: RedisService) {}

  async getJson<T>(key: string): Promise<T | null> {
    if (!this.redisService) return null;
    try {
      return await this.redisService.get<T>(key);
    } catch (error) {
      this.logger.warn(
        `Redis GET failed for ${key}; continuing without cache: ${this.errorMessage(error)}`,
      );
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!this.redisService) return;
    try {
      await this.redisService.set(key, value, ttlSeconds);
    } catch (error) {
      this.logger.warn(
        `Redis SET failed for ${key}; continuing without cache: ${this.errorMessage(error)}`,
      );
    }
  }

  async recordSessions(sessions: DubbingSessionTelemetry[]): Promise<void> {
    if (sessions.length === 0) return;

    if (!this.redisService) {
      this.logger.log(
        `Recorded ${sessions.length} dubbing telemetry session(s) (Redis unavailable)`,
      );
      return;
    }

    try {
      const client = this.redisService.getClient();
      const serialized = sessions.map((session) =>
        JSON.stringify({
          ...session,
          receivedAt: Date.now(),
        }),
      );
      await client.lpush(RECENT_SESSIONS_KEY, ...serialized);
      await client.ltrim(RECENT_SESSIONS_KEY, 0, MAX_RECENT_SESSIONS - 1);
    } catch (error) {
      this.logger.warn(
        `Redis telemetry write failed; logged ${sessions.length} session(s) locally: ${this.errorMessage(error)}`,
      );
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
