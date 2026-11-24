import type { AppRelease } from '$/prisma/client';
import { Module, RequestMethod, VersioningType } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { HttpExceptionFilter } from '~/filters/http-exception.filter';
import { JwtAuthGuard } from '~/modules/auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '~/modules/auth/guards/permissions.guard';
import { PrismaService } from '~/modules/prisma/prisma.service';
import { AppReleaseDownloadController } from './app-release-download.controller';
import { AppReleasesService } from './app-releases.service';

const publishedWithYaml: AppRelease = {
  id: 7,
  version: '1.4.0',
  createdAt: new Date('2026-11-23T12:00:00Z'),
  updatedAt: new Date('2026-11-23T13:00:00Z'),
  publishedAt: new Date('2026-11-23T13:30:00Z'),
  installerName: 'TAI Desktop Setup 1.4.0.exe',
  installerSize: 98_765_432,
  installerSha512: 'sha512-base64-value==',
  blockmapSize: 12_345,
  blockmapSha512: 'blockmap-hash==',
  manifest: [
    'version: 1.4.0',
    'files:',
    '  - url: 1.4.0/TAI%20Desktop%20Setup%201.4.0.exe',
    '    sha512: sha512-base64-value==',
    '    size: 98765432',
    'path: 1.4.0/TAI%20Desktop%20Setup%201.4.0.exe',
    'sha512: sha512-base64-value==',
    "releaseDate: '2026-11-23T13:35:00.000Z'",
    'releaseNotes: Realtime dubbing v2 and dynamic version display',
  ].join('\n'),
};

type Channel = { name: string; releaseId: number; release: AppRelease };

const prisma = {
  appReleaseChannel: {
    findUnique: jest.fn<Promise<Channel | null>, [unknown]>(),
  },
  appRelease: {
    findUnique: jest.fn<Promise<AppRelease | null>, [unknown]>(),
  },
};

@Module({
  controllers: [AppReleaseDownloadController],
  providers: [AppReleasesService, { provide: PrismaService, useValue: prisma }],
})
class AppReleaseDownloadTestModule {}

describe('Public desktop release download endpoints (/uploads/app/release/*)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(
      AppReleaseDownloadTestModule,
      { logger: false },
    );
    app.setGlobalPrefix('api', {
      exclude: [
        { path: 'uploads/app/release/{*path}', method: RequestMethod.ALL },
      ],
    });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.enableCors({
      origin: ['https://admin.example.com'],
      credentials: true,
    });
    const reflector = app.get(Reflector);
    app.useGlobalGuards(
      new JwtAuthGuard(reflector),
      new PermissionsGuard(reflector),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.resetAllMocks();
  });

  describe('GET /uploads/app/release/latest.json', () => {
    it('returns flat JSON metadata with public CORS and no-store caching', async () => {
      prisma.appReleaseChannel.findUnique.mockResolvedValue({
        name: 'stable',
        releaseId: 7,
        release: publishedWithYaml,
      });

      const res = await request(app.getHttpServer())
        .get('/uploads/app/release/latest.json')
        .set('Origin', 'https://tai-landing.example.com')
        .expect(200);

      expect(res.body).toEqual({
        version: '1.4.0',
        filename: 'TAI Desktop Setup 1.4.0.exe',
        path: '1.4.0/TAI Desktop Setup 1.4.0.exe',
        downloadUrl:
          '/uploads/app/release/1.4.0/TAI%20Desktop%20Setup%201.4.0.exe',
        fileSize: 98_765_432,
        sha512: 'sha512-base64-value==',
        releaseDate: '2026-11-23T13:35:00.000Z',
        releaseNotes: 'Realtime dubbing v2 and dynamic version display',
      });
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('falls back to publishedAt and null releaseNotes when YAML omits them', async () => {
      prisma.appReleaseChannel.findUnique.mockResolvedValue({
        name: 'stable',
        releaseId: 7,
        release: {
          ...publishedWithYaml,
          manifest: 'version: 1.4.0\npath: 1.4.0/setup.exe\n',
        },
      });

      const res = await request(app.getHttpServer())
        .get('/uploads/app/release/latest.json')
        .set('Origin', 'https://admin.example.com')
        .expect(200);

      expect(res.body).toMatchObject({
        version: '1.4.0',
        releaseDate: '2026-11-23T13:30:00.000Z',
        releaseNotes: null,
      });
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('returns 404 when no release is published', async () => {
      prisma.appReleaseChannel.findUnique.mockResolvedValue(null);

      await request(app.getHttpServer())
        .get('/uploads/app/release/latest.json')
        .expect(404);
    });

    it('returns 404 when channel points to a draft release', async () => {
      prisma.appReleaseChannel.findUnique.mockResolvedValue({
        name: 'stable',
        releaseId: 7,
        release: { ...publishedWithYaml, publishedAt: null },
      });

      await request(app.getHttpServer())
        .get('/uploads/app/release/latest.json')
        .expect(404);
    });
  });

  describe('GET /uploads/app/release/latest.yml', () => {
    it('serves YAML with public CORS and no-store caching', async () => {
      prisma.appReleaseChannel.findUnique.mockResolvedValue({
        name: 'stable',
        releaseId: 7,
        release: publishedWithYaml,
      });

      const res = await request(app.getHttpServer())
        .get('/uploads/app/release/latest.yml')
        .set('Origin', 'https://tai-landing.example.com')
        .expect(200);

      expect(res.headers['content-type']).toMatch(/text\/yaml/);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.text).toContain('version: 1.4.0');
    });
  });

  describe('GET /uploads/app/release/latest/download', () => {
    it('responds with 302 redirect to the current stable installer and no-store caching', async () => {
      prisma.appReleaseChannel.findUnique.mockResolvedValue({
        name: 'stable',
        releaseId: 7,
        release: publishedWithYaml,
      });

      const res = await request(app.getHttpServer())
        .get('/uploads/app/release/latest/download')
        .expect(302);

      expect(res.headers['location']).toBe(
        '/uploads/app/release/1.4.0/TAI%20Desktop%20Setup%201.4.0.exe',
      );
      expect(res.headers['cache-control']).toBe('no-store');
      expect(prisma.appRelease.findUnique).not.toHaveBeenCalled();
    });

    it('returns 404 when no release is published yet', async () => {
      prisma.appReleaseChannel.findUnique.mockResolvedValue(null);

      await request(app.getHttpServer())
        .get('/uploads/app/release/latest/download')
        .expect(404);
    });
  });
});
