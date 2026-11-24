import { HttpService } from '@nestjs/axios';
import {
  type ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Module,
  UnauthorizedException,
  VersioningType,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import * as bodyParser from 'body-parser';
import { gzipSync } from 'node:zlib';
import { of, throwError } from 'rxjs';
import request from 'supertest';
import { IS_PUBLIC_KEY } from '~/common/decorators/public.decorator';
import { HttpExceptionFilter } from '~/filters/http-exception.filter';
import { PermissionsGuard } from '~/modules/auth/guards/permissions.guard';
import { RedisService } from '~/modules/redis/redis.service';
import { SaasEntitlementService } from '~/modules/saas/saas-entitlement.service';
import type { QuotaDto } from '~/modules/saas/saas.types';
import { DubbingCacheService } from './dubbing-cache.service';
import { DubbingController } from './dubbing.controller';
import { DubbingSigningService } from './dubbing-signing.service';
import { DubbingWorkerClient } from './dubbing-worker.client';
import { DubbingService } from './dubbing.service';
import type {
  SegmentsResponse,
  YoutubeSubtitlesResponse,
} from './dubbing.types';

const TEST_SIGNING_SECRET = 'unit-test-dubbing-secret';
const VALID_BEARER = 'Bearer valid-test-jwt';

function createConfigMock(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    WORKER_URL: 'http://worker.test:8000',
    WORKER_API_KEY: 'test-worker-key',
    DUBBING_SIGNING_SECRET: TEST_SIGNING_SECRET,
    DUBBING_SEGMENT_CACHE_TTL_SEC: 3600,
    DUBBING_TTS_CACHE_TTL_SEC: 3600,
    DUBBING_MAX_PAYLOAD_CHARS: 2_000_000,
    ...overrides,
  };
  return {
    get: jest.fn((key: string) => values[key]),
  };
}

function createInMemoryRedisMock() {
  const store = new Map<string, unknown>();
  const lists = new Map<string, string[]>();
  const client = {
    lpush: jest.fn(async (key: string, ...items: string[]) => {
      const arr = lists.get(key) ?? [];
      arr.unshift(...items);
      lists.set(key, arr);
      return arr.length;
    }),
    ltrim: jest.fn(async (key: string, start: number, stop: number) => {
      const arr = lists.get(key) ?? [];
      lists.set(key, arr.slice(start, stop + 1));
      return 'OK';
    }),
  };

  return {
    store,
    lists,
    client,
    get: jest.fn(async <T>(key: string): Promise<T | null> => {
      return store.has(key) ? (store.get(key) as T) : null;
    }),
    set: jest.fn(async (key: string, value: unknown) => {
      store.set(key, value);
      return 'OK';
    }),
    del: jest.fn(async (key: string) => {
      store.delete(key);
      return 1;
    }),
    getClient: jest.fn(() => client),
  };
}

class TestBearerAuthGuard {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      user?: Record<string, unknown>;
    }>();
    const auth = req.headers['authorization'];
    if (auth !== VALID_BEARER) {
      throw new UnauthorizedException('Unauthorized');
    }
    req.user = {
      id: 42,
      username: 'tester@example.com',
      email: 'tester@example.com',
      isRoot: false,
      permissions: [],
    };
    return true;
  }
}

describe('DubbingController (/api/v1/dubbing/*)', () => {
  let app: NestExpressApplication;
  let httpService: { get: jest.Mock; post: jest.Mock };
  let redisMock: ReturnType<typeof createInMemoryRedisMock>;
  let configMock: ReturnType<typeof createConfigMock>;
  let entitlementMock: {
    assertCanDub: jest.Mock;
    recordDubbingUsage: jest.Mock;
  };
  let signingService: DubbingSigningService;

  const sampleQuota: QuotaDto = {
    period: '2026-11',
    usedSeconds: 120,
    usedMinutes: 2,
    limitMinutes: 60,
    remainingMinutes: 58,
    isUnlimited: false,
    canDub: true,
    blockReason: null,
  };

  async function buildTestApp(configOverrides: Record<string, unknown> = {}) {
    httpService = { get: jest.fn(), post: jest.fn() };
    redisMock = createInMemoryRedisMock();
    configMock = createConfigMock(configOverrides);
    entitlementMock = {
      assertCanDub: jest.fn().mockResolvedValue(null),
      recordDubbingUsage: jest.fn().mockResolvedValue(sampleQuota),
    };

    @Module({
      controllers: [DubbingController],
      providers: [
        DubbingSigningService,
        DubbingCacheService,
        DubbingWorkerClient,
        DubbingService,
        { provide: ConfigService, useValue: configMock },
        { provide: HttpService, useValue: httpService },
        { provide: RedisService, useValue: redisMock },
        { provide: SaasEntitlementService, useValue: entitlementMock },
      ],
    })
    class DubbingTestModule {}

    const instance = await NestFactory.create<NestExpressApplication>(
      DubbingTestModule,
      { bodyParser: false, logger: false },
    );
    instance.use(bodyParser.json({ limit: '10mb' }));
    instance.use(
      bodyParser.raw({
        type: ['application/gzip', 'application/x-gzip'],
        limit: '10mb',
      }),
    );
    instance.setGlobalPrefix('api');
    instance.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    const reflector = instance.get(Reflector);
    instance.useGlobalGuards(
      new TestBearerAuthGuard(reflector),
      new PermissionsGuard(reflector),
    );
    instance.useGlobalFilters(new HttpExceptionFilter());
    await instance.init();
    signingService = instance.get(DubbingSigningService);
    return instance;
  }

  beforeEach(async () => {
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('Auth & Quota Enforcement', () => {
    it('returns flat 401 AUTH_REQUIRED when JWT is missing on protected dubbing endpoints', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/dubbing/segments')
        .send({ targetLang: 'vi', subtitleText: '[]' })
        .expect(401);

      expect(res.body).toMatchObject({
        statusCode: 401,
        code: 'AUTH_REQUIRED',
      });
    });

    it('returns flat 402 QUOTA_EXCEEDED with quota payload when entitlement blocks dubbing', async () => {
      const blockedQuota: QuotaDto = {
        ...sampleQuota,
        usedSeconds: 3600,
        usedMinutes: 60,
        remainingMinutes: 0,
        canDub: false,
        blockReason: 'QUOTA_EXCEEDED',
      };
      entitlementMock.assertCanDub.mockRejectedValue(
        new HttpException(
          {
            code: 'QUOTA_EXCEEDED',
            message: 'Quota exceeded',
            quota: blockedQuota,
          },
          HttpStatus.PAYMENT_REQUIRED,
        ),
      );

      const res = await request(app.getHttpServer())
        .post('/api/v1/dubbing/segments')
        .set('Authorization', VALID_BEARER)
        .send({ targetLang: 'vi', subtitleText: '[]' })
        .expect(402);

      expect(res.body).toEqual({
        statusCode: 402,
        code: 'QUOTA_EXCEEDED',
        message: 'Quota exceeded',
        quota: blockedQuota,
      });
    });

    it('returns flat 403 TENANT_SUSPENDED with quota payload when tenant is suspended', async () => {
      const suspendedQuota: QuotaDto = {
        ...sampleQuota,
        canDub: false,
        blockReason: 'TENANT_SUSPENDED',
      };
      entitlementMock.assertCanDub.mockRejectedValue(
        new ForbiddenException({
          code: 'TENANT_SUSPENDED',
          message: 'Tenant suspended',
          quota: suspendedQuota,
        }),
      );

      const res = await request(app.getHttpServer())
        .post('/api/v1/dubbing/tts')
        .set('Authorization', VALID_BEARER)
        .send({ text: 'Xin chào', lang: 'vi', sig: 'any' })
        .expect(403);

      expect(res.body).toEqual({
        statusCode: 403,
        code: 'TENANT_SUSPENDED',
        message: 'Tenant suspended',
        quota: suspendedQuota,
      });
    });
  });

  describe('GET /api/v1/dubbing/health', () => {
    it('stays public without requiring JWT and returns flat v2 health payload', async () => {
      httpService.get.mockReturnValue(
        of({
          status: 200,
          data: {
            status: 'ok',
            protocol: 'tai-tts-v1',
            capabilities: ['process-tts', 'translate-segment', 'synthesize-tts'],
          },
        }),
      );

      const res = await request(app.getHttpServer())
        .get('/api/v1/dubbing/health')
        .expect(200);

      expect(res.body).toEqual({
        status: 'ok',
        protocol: 'tai-dubbing-v2',
        worker: {
          ok: true,
          protocol: 'tai-tts-v1',
          capabilities: ['process-tts', 'translate-segment', 'synthesize-tts'],
        },
      });
      expect(httpService.get).toHaveBeenCalledWith(
        'http://worker.test:8000/health',
        expect.objectContaining({
          headers: { 'X-API-Key': 'test-worker-key' },
        }),
      );
    });

    it('reports worker.ok = false when worker is unreachable', async () => {
      httpService.get.mockReturnValue(
        throwError(() => new Error('ECONNREFUSED')),
      );

      const res = await request(app.getHttpServer())
        .get('/api/v1/dubbing/health')
        .expect(200);

      expect(res.body).toEqual({
        status: 'ok',
        protocol: 'tai-dubbing-v2',
        worker: { ok: false },
      });
    });
  });

  describe('POST /api/v1/dubbing/youtube-subtitles', () => {
    const sampleJson3 = JSON.stringify({
      events: [
        { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: '[Music]' }] },
        { tStartMs: 2000, dDurationMs: 2500, segs: [{ utf8: 'Xin chào' }] },
        { tStartMs: 4600, dDurationMs: 2400, segs: [{ utf8: 'mọi người. (vỗ tay)' }] },
        { tStartMs: 60000, dDurationMs: 3000, segs: [{ utf8: 'Phần hai.' }] },
      ],
    });
    const sampleSourceJson3 = JSON.stringify({
      events: [
        { tStartMs: 2000, dDurationMs: 5000, segs: [{ utf8: 'Hello everyone.' }] },
        { tStartMs: 60000, dDurationMs: 3000, segs: [{ utf8: 'Part two.' }] },
      ],
    });

    it('accepts application/gzip, aligns sourceText, extracts sounds, partitions segments, and signs cues', async () => {
      const payload = JSON.stringify({
        videoId: 'dQw4w9WgXcQ',
        targetLang: 'vi',
        sourceLang: 'en',
        subtitleText: sampleJson3,
        sourceText: sampleSourceJson3,
      });
      const gz = gzipSync(Buffer.from(payload, 'utf8'));

      const res = await request(app.getHttpServer())
        .post('/api/v1/dubbing/youtube-subtitles')
        .set('Authorization', VALID_BEARER)
        .set('Content-Type', 'application/gzip')
        .send(gz)
        .expect(200);

      const body = res.body as YoutubeSubtitlesResponse;
      expect(body.videoId).toBe('dQw4w9WgXcQ');
      expect(body.targetLang).toBe('vi');
      expect(body.translationSource).toBe('youtube');
      expect(body.totalSegments).toBe(2);
      expect(body.segments[0].cues).toHaveLength(1);
      expect(body.segments[0].cues[0]).toMatchObject({
        start: 2,
        duration: 5,
        text: 'Xin chào mọi người.',
        sourceText: 'Hello everyone.',
      });
      expect(
        signingService.verifyCueSignature(
          'vi',
          body.segments[0].cues[0].text,
          body.segments[0].cues[0].sig,
        ),
      ).toBe(true);
      expect(body.segments[0].sounds).toEqual([
        { start: 0, duration: 2, text: 'Music' },
        { start: 4.6, duration: 2.4, text: 'vỗ tay' },
      ]);
      expect(body.segments[1].cues[0].text).toBe('Phần hai.');
      expect(body.segments[1].cues[0].sourceText).toBe('Part two.');
    });

    it('accepts application/json with XML subtitles', async () => {
      const xml = `<transcript><text start="1.0" dur="2.0">Hello &amp; welcome.</text></transcript>`;

      const res = await request(app.getHttpServer())
        .post('/api/v1/dubbing/youtube-subtitles')
        .set('Authorization', VALID_BEARER)
        .send({
          videoId: 'xmlVideo123',
          targetLang: 'en',
          subtitleText: xml,
        })
        .expect(200);

      const body = res.body as YoutubeSubtitlesResponse;
      expect(body.totalSegments).toBe(1);
      expect(body.segments[0].cues[0].text).toBe('Hello & welcome.');
      expect(
        signingService.verifyCueSignature(
          'en',
          'Hello & welcome.',
          body.segments[0].cues[0].sig,
        ),
      ).toBe(true);
    });

    it('returns 413 when decompressed gzip payload exceeds max char limit', async () => {
      await app.close();
      app = await buildTestApp({ DUBBING_MAX_PAYLOAD_CHARS: 200 });

      const oversized = JSON.stringify({
        videoId: 'bigVideo',
        targetLang: 'vi',
        subtitleText: 'a'.repeat(500),
      });
      const gz = gzipSync(Buffer.from(oversized, 'utf8'));

      const res = await request(app.getHttpServer())
        .post('/api/v1/dubbing/youtube-subtitles')
        .set('Authorization', VALID_BEARER)
        .set('Content-Type', 'application/gzip')
        .send(gz)
        .expect(413);

      expect(res.body).toMatchObject({
        statusCode: 413,
        code: 'PAYLOAD_TOO_LARGE',
      });
    });

    it('returns 400 on invalid gzip bytes', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/dubbing/youtube-subtitles')
        .set('Authorization', VALID_BEARER)
        .set('Content-Type', 'application/gzip')
        .send(Buffer.from('not-gzip-content'))
        .expect(400);

      expect(res.body).toMatchObject({
        statusCode: 400,
        code: 'INVALID_GZIP',
      });
    });
  });

  describe('POST /api/v1/dubbing/segments', () => {
    const timedtextJson3 = JSON.stringify({
      events: [
        { tStartMs: 2000, dDurationMs: 3000, segs: [{ utf8: 'First line.' }] },
        { tStartMs: 60000, dDurationMs: 4000, segs: [{ utf8: '[Music] Second line.' }] },
      ],
    });

    it('downloads subtitleUrl, translates requested segment via worker, caches in Redis, and sets mappedFrom', async () => {
      httpService.get.mockReturnValue(
        of({ status: 200, data: timedtextJson3 }),
      );
      httpService.post.mockReturnValue(
        of({
          status: 200,
          data: {
            target_lang: 'vi',
            engine: 'gemini',
            cues: [
              {
                start: 60,
                duration: 4,
                text: 'Dòng thứ hai.',
                sourceText: 'Second line.',
              },
            ],
          },
        }),
      );

      const res1 = await request(app.getHttpServer())
        .post('/api/v1/dubbing/segments')
        .set('Authorization', VALID_BEARER)
        .send({
          subtitleUrl:
            'https://www.youtube.com/api/timedtext?v=vidABC12345&lang=en&fmt=json3&pot=token1',
          targetLang: 'vi',
          sourceLang: 'en',
          currentTime: 40,
        })
        .expect(200);

      const body1 = res1.body as SegmentsResponse;
      expect(body1).toMatchObject({
        videoId: 'vidABC12345',
        targetLang: 'vi',
        translationSource: 'ai',
        totalSegments: 2,
        segment: {
          index: 1,
          start: 60,
          end: 64,
          mappedFrom: 40,
          sounds: [{ start: 60, duration: 4, text: 'Music' }],
        },
      });
      expect(body1.segment.cues[0]).toMatchObject({
        start: 60,
        duration: 4,
        text: 'Dòng thứ hai.',
        sourceText: 'Second line.',
      });
      expect(
        signingService.verifyCueSignature(
          'vi',
          'Dòng thứ hai.',
          body1.segment.cues[0].sig,
        ),
      ).toBe(true);
      expect(httpService.post).toHaveBeenCalledTimes(1);

      const res2 = await request(app.getHttpServer())
        .post('/api/v1/dubbing/segments')
        .set('Authorization', VALID_BEARER)
        .send({
          subtitleUrl:
            'https://www.youtube.com/api/timedtext?v=vidABC12345&lang=en&fmt=json3&pot=token2',
          targetLang: 'vi',
          sourceLang: 'en',
          segment: 1,
        })
        .expect(200);

      expect((res2.body as SegmentsResponse).segment.cues[0].text).toBe(
        'Dòng thứ hai.',
      );
      expect(httpService.post).toHaveBeenCalledTimes(1);
    });

    it('returns flat 422 { code: "SUBTITLE_DOWNLOAD_FAILED" } when subtitleUrl fails', async () => {
      httpService.get.mockReturnValue(of({ status: 403, data: 'Forbidden' }));

      const res = await request(app.getHttpServer())
        .post('/api/v1/dubbing/segments')
        .set('Authorization', VALID_BEARER)
        .send({
          subtitleUrl:
            'https://www.youtube.com/api/timedtext?v=expiredVid1&lang=en&pot=expired',
          targetLang: 'vi',
          currentTime: 0,
        })
        .expect(422);

      expect(res.body).toMatchObject({
        statusCode: 422,
        code: 'SUBTITLE_DOWNLOAD_FAILED',
      });
      expect(httpService.post).not.toHaveBeenCalled();
    });

    it('degrades gracefully when Redis throws errors', async () => {
      redisMock.get.mockRejectedValue(new Error('Redis ECONNREFUSED'));
      redisMock.set.mockRejectedValue(new Error('Redis ECONNREFUSED'));

      httpService.post.mockReturnValue(
        of({
          status: 200,
          data: {
            target_lang: 'vi',
            engine: 'google',
            cues: [
              {
                start: 2,
                duration: 3,
                text: 'Dòng đầu tiên.',
                sourceText: 'First line.',
              },
            ],
          },
        }),
      );

      const res = await request(app.getHttpServer())
        .post('/api/v1/dubbing/segments')
        .set('Authorization', VALID_BEARER)
        .send({
          videoId: 'redisDownVid',
          subtitleText: timedtextJson3,
          targetLang: 'vi',
          segment: 0,
        })
        .expect(200);

      expect((res.body as SegmentsResponse).segment.cues[0].text).toBe(
        'Dòng đầu tiên.',
      );
    });

    it('coalesces concurrent in-flight segment translation requests into one worker call', async () => {
      let resolveWorker!: (value: unknown) => void;
      const deferred = new Promise((resolve) => {
        resolveWorker = resolve;
      });
      httpService.post.mockImplementation(() => {
        const { from } = require('rxjs') as typeof import('rxjs');
        return from(deferred);
      });

      const reqA = request(app.getHttpServer())
        .post('/api/v1/dubbing/segments')
        .set('Authorization', VALID_BEARER)
        .send({
          videoId: 'coalesceVid',
          subtitleText: timedtextJson3,
          targetLang: 'vi',
          segment: 0,
        });
      const reqB = request(app.getHttpServer())
        .post('/api/v1/dubbing/segments')
        .set('Authorization', VALID_BEARER)
        .send({
          videoId: 'coalesceVid',
          subtitleText: timedtextJson3,
          targetLang: 'vi',
          segment: 0,
        });

      await new Promise((r) => setTimeout(r, 30));
      resolveWorker({
        status: 200,
        data: {
          target_lang: 'vi',
          engine: 'gemini',
          cues: [
            {
              start: 2,
              duration: 3,
              text: 'Dòng hợp nhất.',
              sourceText: 'First line.',
            },
          ],
        },
      });

      const [resA, resB] = await Promise.all([reqA, reqB]);
      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);
      expect((resA.body as SegmentsResponse).segment.cues[0].text).toBe(
        'Dòng hợp nhất.',
      );
      expect((resB.body as SegmentsResponse).segment.cues[0].text).toBe(
        'Dòng hợp nhất.',
      );
      expect(httpService.post).toHaveBeenCalledTimes(1);
    });

    it('cleans worker-translated cues before caching and HMAC signing and drops empty cues', async () => {
      httpService.post.mockReturnValue(
        of({
          status: 200,
          data: {
            target_lang: 'vi',
            engine: 'gemini',
            cues: [
              {
                start: 2,
                duration: 2,
                text: '[Nhạc] (cười) Xin chào mọi người. (vỗ tay)',
                sourceText: 'Hello everyone.',
              },
              {
                start: 4.5,
                duration: 1.5,
                text: '[Tiếng vỗ tay]',
                sourceText: 'Applause',
              },
            ],
          },
        }),
      );

      const res = await request(app.getHttpServer())
        .post('/api/v1/dubbing/segments')
        .set('Authorization', VALID_BEARER)
        .send({
          videoId: 'cleanWorkerOutVid',
          subtitleText: timedtextJson3,
          targetLang: 'vi',
          segment: 0,
        })
        .expect(200);

      const body = res.body as SegmentsResponse;
      expect(body.segment.cues).toHaveLength(1);
      expect(body.segment.cues[0].text).toBe('Xin chào mọi người.');
      expect(
        signingService.verifyCueSignature(
          'vi',
          'Xin chào mọi người.',
          body.segment.cues[0].sig,
        ),
      ).toBe(true);
    });
  });

  describe('POST /api/v1/dubbing/tts', () => {
    const fakeMp3 = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0x00, 0x01, 0x02]);

    it('returns 403 when HMAC signature is missing or invalid', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/dubbing/tts')
        .set('Authorization', VALID_BEARER)
        .send({
          text: 'Xin chào',
          lang: 'vi',
          sig: 'bad-signature',
        })
        .expect(403);

      expect(res.body).toMatchObject({
        statusCode: 403,
        code: 'INVALID_TTS_SIGNATURE',
      });
      expect(httpService.post).not.toHaveBeenCalled();
    });

    it('returns inline audio/mpeg with headers and caches subsequent HIT in Redis', async () => {
      const sig = signingService.signCue('vi', 'Xin chào');
      httpService.post.mockReturnValue(
        of({
          status: 200,
          data: fakeMp3,
          headers: {
            'x-audio-duration': '1.42',
            'x-tts-voice': 'vi-VN-HoaiMyNeural',
            'x-tts-rate': '+50%',
          },
        }),
      );

      const miss = await request(app.getHttpServer())
        .post('/api/v1/dubbing/tts')
        .set('Authorization', VALID_BEARER)
        .send({
          text: 'Xin chào',
          lang: 'vi',
          voice: 'vi-VN-HoaiMyNeural',
          rate: 1.5,
          sig,
        })
        .expect(200);

      expect(miss.headers['content-type']).toMatch(/audio\/mpeg/);
      expect(miss.headers['x-audio-duration']).toBe('1.42');
      expect(miss.headers['x-tts-voice']).toBe('vi-VN-HoaiMyNeural');
      expect(miss.headers['x-tts-rate']).toBe('+50%');
      expect(miss.headers['x-cache']).toBe('MISS');
      expect(Buffer.from(miss.body as Buffer)).toEqual(fakeMp3);
      expect(httpService.post).toHaveBeenCalledTimes(1);

      const hit = await request(app.getHttpServer())
        .post('/api/v1/dubbing/tts')
        .set('Authorization', VALID_BEARER)
        .send({
          text: 'Xin chào',
          lang: 'vi',
          voice: 'vi-VN-HoaiMyNeural',
          rate: '+50%',
          sig,
        })
        .expect(200);

      expect(hit.headers['x-cache']).toBe('HIT');
      expect(hit.headers['x-audio-duration']).toBe('1.42');
      expect(Buffer.from(hit.body as Buffer)).toEqual(fakeMp3);
      expect(httpService.post).toHaveBeenCalledTimes(1);
    });

    it('supports inline: false returning JSON audioBase64', async () => {
      const sig = signingService.signCue('en', 'Hello world');
      httpService.post.mockReturnValue(
        of({
          status: 200,
          data: fakeMp3,
          headers: {
            'x-audio-duration': '0.95',
            'x-tts-voice': 'en-US-EmmaMultilingualNeural',
            'x-tts-rate': '+0%',
          },
        }),
      );

      const res = await request(app.getHttpServer())
        .post('/api/v1/dubbing/tts')
        .set('Authorization', VALID_BEARER)
        .send({
          text: 'Hello world',
          lang: 'en',
          sig,
          inline: false,
        })
        .expect(200);

      expect(res.body).toEqual({
        audioBase64: fakeMp3.toString('base64'),
        contentType: 'audio/mpeg',
        duration: 0.95,
        voice: 'en-US-EmmaMultilingualNeural',
        rate: '+0%',
      });
    });
  });

  describe('POST /api/v1/dubbing/sessions', () => {
    it('accepts up to 20 telemetry sessions, increments monthly usage, and returns updated quota', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/dubbing/sessions')
        .set('Authorization', VALID_BEARER)
        .send({
          sessions: [
            {
              sessionId: 'sess-1',
              videoId: 'dQw4w9WgXcQ',
              sourceLang: 'en',
              targetLang: 'vi',
              translationSource: 'ai',
              watchedSeconds: 120.5,
              dubbedCues: 28,
              truncatedCues: 1,
              gateForced: 0,
              fallbackCues: 0,
            },
          ],
        })
        .expect(200);

      expect(res.body).toEqual({ accepted: 1, quota: sampleQuota });
      expect(redisMock.client.lpush).toHaveBeenCalledTimes(1);
      expect(entitlementMock.recordDubbingUsage).toHaveBeenCalledTimes(1);
    });

    it('rejects batches exceeding 20 sessions with 400', async () => {
      const tooMany = Array.from({ length: 21 }, (_, idx) => ({
        videoId: `vid-${idx}`,
        targetLang: 'vi',
        watchedSeconds: 10,
      }));

      await request(app.getHttpServer())
        .post('/api/v1/dubbing/sessions')
        .set('Authorization', VALID_BEARER)
        .send({ sessions: tooMany })
        .expect(400);
    });

    it('degrades gracefully when Redis fails during session telemetry ingestion', async () => {
      redisMock.client.lpush.mockRejectedValue(new Error('Redis write failed'));

      const res = await request(app.getHttpServer())
        .post('/api/v1/dubbing/sessions')
        .set('Authorization', VALID_BEARER)
        .send({
          sessions: [
            {
              videoId: 'vid-fallback',
              targetLang: 'vi',
              watchedSeconds: 45,
            },
          ],
        })
        .expect(200);

      expect(res.body).toEqual({ accepted: 1, quota: sampleQuota });
    });
  });
});
