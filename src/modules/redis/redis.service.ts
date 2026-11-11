import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisService {
    constructor(@Inject('REDIS_CLIENT') private redis: Redis) { }

    getClient(): Redis {
        return this.redis;
    }

    async set(key: string, value: any, ttl?: number) {
        const data = JSON.stringify(value);

        if (ttl) {
            return this.redis.set(key, data, 'EX', ttl);
        }

        return this.redis.set(key, data);
    }

    async get<T>(key: string): Promise<T | null> {
        const data = await this.redis.get(key);
        return data ? JSON.parse(data) : null;
    }

    async del(key: string) {
        return this.redis.del(key);
    }
}
