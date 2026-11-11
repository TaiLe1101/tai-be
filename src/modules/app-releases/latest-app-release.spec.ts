import type { AppRelease } from '$/prisma/client';
import { Module, VersioningType } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { HttpExceptionFilter } from '~/filters/http-exception.filter';
import { JwtAuthGuard } from '~/modules/auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '~/modules/auth/guards/permissions.guard';
import { PrismaService } from '~/modules/prisma/prisma.service';
import { AppReleasesController } from './app-releases.controller';
import { AppReleasesService } from './app-releases.service';

const published: AppRelease = {
  id: 1,
  version: '1.0.4',
  createdAt: new Date('2026-11-11T12:00:00Z'),
  updatedAt: new Date('2026-11-11T13:00:00Z'),
  publishedAt: new Date('2026-11-11T13:00:00Z'),
  installerName: 'TAI Desktop Setup 1.0.4.exe',
  installerSize: 123,
  installerSha512: 'installer-hash',
  blockmapSize: 12,
  blockmapSha512: 'blockmap-hash',
  manifest: 'private YAML content',
};
type Channel = { name: string; releaseId: number; release: AppRelease };
const prisma = {
  appReleaseChannel: {
    findUnique: jest.fn<Promise<Channel | null>, [unknown]>(),
  },
  appRelease: { findUnique: jest.fn<Promise<AppRelease | null>, [unknown]>() },
};

@Module({
  controllers: [AppReleasesController],
  providers: [AppReleasesService, { provide: PrismaService, useValue: prisma }],
})
class LatestReleaseTestModule {}

describe('GET /api/v1/app-releases/latest', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(
      LatestReleaseTestModule,
      { logger: false },
    );
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
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

  it('returns 404 when no stable release has been published', async () => {
    prisma.appReleaseChannel.findUnique.mockResolvedValue(null);
    await request(app.getHttpServer())
      .get('/api/v1/app-releases/latest')
      .expect(404);
  });

  it('does not expose a draft even if the channel points to it', async () => {
    prisma.appReleaseChannel.findUnique.mockResolvedValue({
      name: 'stable',
      releaseId: 1,
      release: { ...published, publishedAt: null },
    });
    await request(app.getHttpServer())
      .get('/api/v1/app-releases/latest')
      .expect(404);
  });

  it('is public and returns the same data as detail with no caching', async () => {
    prisma.appReleaseChannel.findUnique.mockResolvedValue({
      name: 'stable',
      releaseId: 1,
      release: published,
    });
    prisma.appRelease.findUnique.mockResolvedValue(published);
    const response = await request(app.getHttpServer())
      .get('/api/v1/app-releases/latest')
      .expect(200);
    const detail = await request(app.getHttpServer())
      .get('/api/v1/app-releases/1')
      .expect(200);
    const body = response.body as { data: Record<string, unknown> };
    expect(body.data).toEqual((detail.body as { data: unknown }).data);
    expect(body.data).toMatchObject({
      version: '1.0.4',
      status: 'published',
      isCurrent: true,
      files: {
        installer:
          '/uploads/app/release/1.0.4/TAI%20Desktop%20Setup%201.0.4.exe',
      },
    });
    expect(body.data).not.toHaveProperty('manifest');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('uses the stable pointer rather than selecting the latest uploaded release', async () => {
    prisma.appReleaseChannel.findUnique.mockResolvedValue({
      name: 'stable',
      releaseId: 1,
      release: published,
    });
    prisma.appRelease.findUnique.mockResolvedValue({
      ...published,
      id: 2,
      version: '1.0.5',
      publishedAt: null,
    });
    const response = await request(app.getHttpServer())
      .get('/api/v1/app-releases/latest')
      .expect(200);
    expect((response.body as { data: { version: string } }).data.version).toBe(
      '1.0.4',
    );
    expect(prisma.appReleaseChannel.findUnique).toHaveBeenCalledWith({
      where: { name: 'stable' },
      include: { release: true },
    });
    expect(prisma.appRelease.findUnique).not.toHaveBeenCalled();
  });
});
