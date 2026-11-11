/* Async DB stubs preserve the Promise contract without performing I/O. */
/* eslint-disable @typescript-eslint/require-await */
import type { AppRelease } from '$/prisma/client';
import {
  Global,
  Module,
  RequestMethod,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import request from 'supertest';
import { parse, stringify } from 'yaml';
import { configureUploadsStatic } from '~/common/configs/uploads-static.config';
import { PERMISSIONS } from '~/common/constants/permissions.constant';
import { HttpExceptionFilter } from '~/filters/http-exception.filter';
import { JwtAuthGuard } from '~/modules/auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '~/modules/auth/guards/permissions.guard';
import { JwtStrategy } from '~/modules/auth/strategies/jwt.strategy';
import { PrismaService } from '~/modules/prisma/prisma.service';
import { APP_RELEASE_ROOT, APP_RELEASE_STAGING } from './app-release-upload';
import { AppReleasesModule } from './app-releases.module';
import type { AppReleasesService } from './app-releases.service';

jest.mock('./app-release-upload', () => {
  const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
  const path = jest.requireActual<typeof import('node:path')>('node:path');
  const temporaryRoot = path.join(process.cwd(), '.tmp');
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'release-tests-'));
  const actual = jest.requireActual<typeof import('./app-release-upload')>(
    './app-release-upload',
  );
  // Multer's staging destination remains its private production .tmp directory.
  // Release artifacts use an isolated temp root; test cleanup only removes owned files.
  return {
    ...actual,
    APP_RELEASE_ROOT: path.join(directory, 'uploads', 'app', 'release'),
  };
});

type ReleaseResult = Awaited<ReturnType<AppReleasesService['detail']>>;
type Transaction = Pick<
  PrismaService,
  'appRelease' | 'appReleaseChannel' | '$queryRaw'
>;
type CreateData = Omit<
  AppRelease,
  'id' | 'createdAt' | 'updatedAt' | 'publishedAt' | 'publishedById'
>;
const responseData = (response: { body: unknown }) =>
  (response.body as { data: ReleaseResult }).data;
const parseFeed = (text: string) =>
  parse(text) as {
    version: string;
    files: { url: string }[];
    releaseNotes: string;
  };
let rows: AppRelease[] = [];
let currentId: number | undefined;
let nextId = 1;
const delegates = {
  user: {
    findFirst: jest.fn(async ({ where }: { where: { id: number } }) => {
      if (![1, 2, 3].includes(where.id)) return null;
      return {
        id: where.id,
        isActive: true,
        deletedAt: null,
        isRoot: where.id === 1,
        password: 'must-not-be-returned',
        userRoles:
          where.id === 2
            ? [
                {
                  role: {
                    rolePermissions: Object.values(
                      PERMISSIONS.APP_RELEASES,
                    ).map((code) => ({ permission: { code } })),
                  },
                },
              ]
            : [],
      };
    }),
  },
  appRelease: {
    findUnique: jest.fn(
      async ({ where }: { where: { id?: number; version?: string } }) =>
        rows.find((row) =>
          where.id ? row.id === where.id : row.version === where.version,
        ) ?? null,
    ),
    create: jest.fn(async ({ data }: { data: CreateData }) => {
      const row = {
        id: nextId++,
        createdAt: new Date(),
        updatedAt: new Date(),
        publishedAt: null,
        publishedById: null,
        ...data,
      };
      rows.push(row);
      return row;
    }),
    update: jest.fn(
      async ({
        where,
        data,
      }: {
        where: { id: number };
        data: Pick<AppRelease, 'publishedAt' | 'publishedById'>;
      }) => {
        const row = rows.find((row) => row.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    ),
    delete: jest.fn(async ({ where }: { where: { id: number } }) => {
      const row = rows.find((row) => row.id === where.id)!;
      rows = rows.filter((row) => row.id !== where.id);
      return row;
    }),
    findMany: jest.fn(async () => rows),
    count: jest.fn(async () => rows.length),
  },
  appReleaseChannel: {
    findUnique: jest.fn(async () =>
      currentId
        ? {
            name: 'stable',
            releaseId: currentId,
            release: rows.find((row) => row.id === currentId),
          }
        : null,
    ),
    upsert: jest.fn(
      async ({
        create,
        update,
      }: {
        create: { releaseId: number };
        update: { releaseId: number };
      }) => {
        currentId = currentId ? update.releaseId : create.releaseId;
      },
    ),
  },
  $queryRaw: jest.fn(async () => []),
};
const prisma = {
  ...delegates,
  $transaction: jest.fn(
    async (action: (tx: Transaction) => Promise<unknown>) => {
      const snapshot = structuredClone(rows);
      const previous = currentId;
      try {
        return await action(delegates as unknown as Transaction);
      } catch (error) {
        rows = snapshot;
        currentId = previous;
        throw error;
      }
    },
  ),
};

@Global()
@Module({
  providers: [{ provide: PrismaService, useValue: prisma }],
  exports: [PrismaService],
})
class TestPrismaModule {}

@Module({ imports: [TestPrismaModule, AppReleasesModule] })
class TestApplicationModule {}

describe('desktop release API', () => {
  let app: NestExpressApplication;
  const jwt = new JwtService({ secret: 'release-test-secret' });
  const token = (id = 1) => `Bearer ${jwt.sign({ sub: { id } })}`;
  const installer = Buffer.from('MZ-test-installer-0123456789');
  const blockmap = Buffer.from('test-blockmap');
  const filename = (version: string) => `My App Setup ${version}.exe`;
  const manifest = (version: string, changes: Record<string, unknown> = {}) =>
    stringify({
      version,
      files: [
        {
          url: filename(version),
          size: installer.length,
          sha512: createHash('sha512').update(installer).digest('base64'),
        },
      ],
      path: filename(version),
      sha512: createHash('sha512').update(installer).digest('base64'),
      releaseNotes: 'Test release',
      ...changes,
    });
  const upload = (
    version: string,
    changes: Record<string, unknown> = {},
    id = 1,
  ) =>
    request(app.getHttpServer())
      .post('/api/v1/app-releases')
      .set('Authorization', token(id))
      .attach('manifest', Buffer.from(manifest(version, changes)), 'latest.yml')
      .attach('installer', installer, filename(version))
      .attach('blockmap', blockmap, `${filename(version)}.blockmap`)
      .expect((response) => {
        if (response.status === 500)
          throw new Error(JSON.stringify(response.body));
      });
  const publish = (id: number) =>
    request(app.getHttpServer())
      .post(`/api/v1/app-releases/${id}/publish`)
      .set('Authorization', token());

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(
      TestApplicationModule,
      { logger: false },
    );
    configureUploadsStatic(app, join(APP_RELEASE_ROOT, '..', '..'));
    app.setGlobalPrefix('api', {
      exclude: [
        { path: 'uploads/app/release/{*path}', method: RequestMethod.ALL },
      ],
    });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    app.useGlobalFilters(new HttpExceptionFilter());
    const reflector = app.get(Reflector);
    new JwtStrategy(
      new ConfigService({ ACCESS_TOKEN_SECRET: 'release-test-secret' }),
      prisma as unknown as PrismaService,
    );
    app.useGlobalGuards(
      new JwtAuthGuard(reflector),
      new PermissionsGuard(reflector),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    // Mock root was allocated by mkdtemp; resolve to that exact test directory only.
    const testDirectory = dirname(dirname(dirname(APP_RELEASE_ROOT)));
    if (
      !testDirectory.startsWith(join(process.cwd(), '.tmp', 'release-tests-'))
    )
      throw new Error('Unexpected test directory');
    await rm(testDirectory, { recursive: true, force: true });
  });

  it('requires JWT and permission; supports root and role permission lookup', async () => {
    await request(app.getHttpServer()).get('/api/v1/app-releases').expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/app-releases')
      .set('Authorization', token(3))
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/v1/app-releases')
      .set('Authorization', token(2))
      .expect(200);
    expect(prisma.user.findFirst.mock.calls[0][0]).toMatchObject({
      where: { deletedAt: null },
      include: {
        userRoles: {
          where: { role: { isActive: true, deletedAt: null } },
        },
      },
    });
  });

  it('returns 404 before first publish', async () => {
    await request(app.getHttpServer())
      .get('/uploads/app/release/latest.yml')
      .expect(404);
  });

  it('uploads draft without exposing artifacts, including static URL aliases', async () => {
    const response = await upload('1.0.0').expect(201);
    expect(responseData(response)).toMatchObject({
      status: 'draft',
      isCurrent: false,
      version: '1.0.0',
      uploadedById: 1,
    });
    expect(responseData(response)).not.toHaveProperty('manifest');
    for (const path of [
      responseData(response).files.installer,
      '/uploads/app/release/1.0.0/latest.yml',
      '/uploads/app/release./1.0.0/latest.yml',
      '/uploads/app%5crelease/1.0.0/latest.yml',
      '/uploads/other/%2e%2e/app/release/1.0.0/latest.yml',
    ])
      await request(app.getHttpServer()).get(path).expect(404);
    await request(app.getHttpServer())
      .get('/uploads/app/release/latest.yml')
      .expect(404);
  });

  it('rejects duplicate version, incomplete uploads and checksums; preserves original draft', async () => {
    await upload('1.0.0').expect(409);
    await upload('1.1.0', {
      files: [
        { url: filename('1.1.0'), size: installer.length, sha512: 'wrong' },
      ],
    }).expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/app-releases')
      .set('Authorization', token())
      .attach('manifest', Buffer.from(manifest('1.1.0')), 'latest.yml')
      .expect(400);
    expect(
      await readFile(join(APP_RELEASE_ROOT, '1.0.0', filename('1.0.0'))),
    ).toEqual(installer);
    expect(await readdir(APP_RELEASE_ROOT)).toEqual(['1.0.0']);
  });

  it('publishes explicitly, returns versioned manifest and supports Range/HEAD', async () => {
    const id = rows[0].id;
    await publish(id).expect(200);
    await publish(id).expect(200);
    const response = await request(app.getHttpServer())
      .get('/uploads/app/release/latest.yml')
      .expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const metadata = parseFeed(response.text);
    expect(metadata.files[0].url).toBe(
      `1.0.0/${encodeURIComponent(filename('1.0.0'))}`,
    );
    expect(metadata.releaseNotes).toBe('Test release');
    const url = `/uploads/app/release/${metadata.files[0].url}`;
    const partial = await request(app.getHttpServer())
      .get(url)
      .set('Range', 'bytes=0-1')
      .expect(206);
    expect(partial.headers['content-range']).toBe(
      `bytes 0-1/${installer.length}`,
    );
    expect(partial.body).toEqual(Buffer.from('MZ'));
    const head = await request(app.getHttpServer()).head(url).expect(200);
    expect(head.headers['content-length']).toBe(String(installer.length));
    await request(app.getHttpServer()).get(`${url}.blockmap`).expect(200);
    await request(app.getHttpServer())
      .delete(`/api/v1/app-releases/${id}`)
      .set('Authorization', token())
      .expect(409);
  });

  it('rejects downgrade, switches feed to newer release and keeps old files', async () => {
    const older = await upload('0.9.0').expect(201);
    await publish(responseData(older).id).expect(409);
    const newer = await upload('1.2.0', {}, 2).expect(201);
    await publish(responseData(newer).id).expect(200);
    await publish(rows.find((row) => row.version === '1.0.0')!.id).expect(409);
    const feed = await request(app.getHttpServer())
      .get('/uploads/app/release/latest.yml')
      .expect(200);
    expect(parseFeed(feed.text).version).toBe('1.2.0');
    await request(app.getHttpServer())
      .get(
        `/uploads/app/release/1.0.0/${encodeURIComponent(filename('1.0.0'))}`,
      )
      .expect(200);
  });

  it('blocks publication of changed files and can delete/reupload draft', async () => {
    const response = await upload('1.3.0').expect(201);
    await writeFile(
      join(APP_RELEASE_ROOT, '1.3.0', filename('1.3.0')),
      'tampered',
    );
    await publish(responseData(response).id).expect(400);
    await request(app.getHttpServer())
      .delete(`/api/v1/app-releases/${responseData(response).id}`)
      .set('Authorization', token())
      .expect(200);
    expect(await readdir(APP_RELEASE_ROOT)).not.toContain('1.3.0');
    await upload('1.3.0').expect(201);
  });

  it('rejects invalid metadata, extra fields and mismatched blockmap; cleans temporary uploads', async () => {
    await upload('1.4.0', { version: '1.4.0-beta.1' }).expect(400);
    await upload('1.4.0', {
      files: [{ url: '../other.exe', size: installer.length, sha512: 'bad' }],
    }).expect(400);
    await upload('1.4.0', { signature: 'signed' }).expect(400);
    const before = await readdir(APP_RELEASE_STAGING);
    await request(app.getHttpServer())
      .post('/api/v1/app-releases')
      .set('Authorization', token())
      .attach('manifest', Buffer.from(manifest('1.4.0')), 'latest.yml')
      .attach('installer', installer, filename('1.4.0'))
      .attach('blockmap', blockmap, 'wrong.exe.blockmap')
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/app-releases')
      .set('Authorization', token())
      .attach('manifest', Buffer.from(manifest('1.4.0')), 'latest.yml')
      .field('version', '1.4.0')
      .expect(400);
    expect(await readdir(APP_RELEASE_STAGING)).toEqual(before);
  });

  it('continues serving ordinary uploads', async () => {
    const directory = join(APP_RELEASE_ROOT, '..', '..', 'avatars');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'example.txt'), 'avatar');
    const response = await request(app.getHttpServer())
      .get('/uploads/avatars/example.txt')
      .expect(200);
    expect(response.text).toBe('avatar');
  });
});
