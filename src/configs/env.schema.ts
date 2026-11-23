import { z } from 'zod';

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['dev', 'test', 'prod']),
    PORT: z.coerce.number(),
    APP_NAME: z.string(),
    SALT_ROUNDS: z.coerce.number(),
    CORS_ORIGINS_CLIENT: z.string(),

    DB_HOST: z.string(),
    DB_PORT: z.coerce.number(),
    DB_USER: z.string(),
    DB_PASS: z.string(),
    DB_NAME: z.string(),

    REDIS_HOST: z.string(),
    REDIS_PORT: z.coerce.number(),
    REDIS_USERNAME: z.string(),
    REDIS_PASSWORD: z.string(),
    REDIS_KEY_PREFIX: z.string(),

    WORKER_URL: z.string().default('http://127.0.0.1:8000'),
    WORKER_API_KEY: z.string().default(''),
    DUBBING_SIGNING_SECRET: z.string().default('tai-dubbing-dev-signing-secret'),
    DUBBING_SEGMENT_CACHE_TTL_SEC: z.coerce.number().int().positive().default(86400),
    DUBBING_TTS_CACHE_TTL_SEC: z.coerce.number().int().positive().default(86400),
    DUBBING_MAX_PAYLOAD_CHARS: z.coerce.number().int().positive().default(2_000_000),
  })
  .passthrough();

export type EnvVariables = z.infer<typeof envSchema>;
