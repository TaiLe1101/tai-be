import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  APP_RELEASE_STAGING,
  isSafeArtifactName,
  MAX_RELEASE_FILE_SIZE,
} from './app-release-upload';
import type { AppReleaseFiles } from './app-release-upload';
import { AppReleasesService } from './app-releases.service';

export const RELEASE_CHUNK_SIZE = 5 * 1024 * 1024;
const TTL = 24 * 60 * 60 * 1000;
const fields = ['manifest', 'installer', 'blockmap'] as const;
type Field = (typeof fields)[number];
type FileInfo = { name: string; size: number };
type Session = {
  files: Record<Field, FileInfo>;
  expiresAt: number;
  result?: Awaited<ReturnType<AppReleasesService['upload']>>;
};

@Injectable()
export class AppReleaseChunksService implements OnModuleInit, OnModuleDestroy {
  private readonly root = join(APP_RELEASE_STAGING, 'chunks');
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly releases: AppReleasesService) {}

  onModuleInit() {
    void this.sweep().catch(() => undefined);
    this.timer = setInterval(
      () => void this.sweep().catch(() => undefined),
      10 * 60 * 1000,
    );
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  async create(body: unknown) {
    const files = (body as { files?: Record<Field, FileInfo> } | null)?.files;
    if (!files || Object.keys(files).length !== 3)
      throw new BadRequestException('Cần đủ thông tin 3 file');
    for (const field of fields) {
      const file = files[field];
      if (
        !file ||
        typeof file.name !== 'string' ||
        !isSafeArtifactName(file.name) ||
        !Number.isSafeInteger(file.size) ||
        file.size <= 0 ||
        file.size >
          (field === 'manifest' ? 1024 * 1024 : MAX_RELEASE_FILE_SIZE) ||
        !(field === 'manifest'
          ? file.name === 'latest.yml'
          : file.name.endsWith(
              field === 'installer' ? '.exe' : '.exe.blockmap',
            ))
      ) {
        throw new BadRequestException(`Thông tin file ${field} không hợp lệ`);
      }
    }
    if (files.blockmap.name !== `${files.installer.name}.blockmap`)
      throw new BadRequestException('Tên blockmap không khớp bộ cài');
    const uploadId = randomUUID();
    const directory = this.directory(uploadId);
    await mkdir(directory, { recursive: true });
    await this.save(directory, { files, expiresAt: Date.now() + TTL });
    return { uploadId, chunkSize: RELEASE_CHUNK_SIZE };
  }

  async chunk(
    id: string,
    field: string,
    index: number,
    file?: Express.Multer.File,
  ) {
    if (
      !fields.includes(field as Field) ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      !file
    ) {
      throw new BadRequestException('Phần upload không hợp lệ');
    }
    return this.lock(id, async (directory, session) => {
      if (session.result) throw new ConflictException('Upload đã hoàn tất');
      const info = session.files[field as Field];
      const expected = Math.min(
        RELEASE_CHUNK_SIZE,
        info.size - index * RELEASE_CHUNK_SIZE,
      );
      if (expected <= 0 || file.size !== expected)
        throw new BadRequestException('Kích thước phần upload không hợp lệ');
      const target = join(directory, `${field}-${index}`);
      // Atomic replacement makes retrying a chunk safe after a lost response.
      const temporary = join(directory, randomUUID());
      try {
        await writeFile(temporary, file.buffer);
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
      session.expiresAt = Date.now() + TTL;
      await this.save(directory, session);
      return { index };
    });
  }

  async complete(id: string) {
    return this.lock(id, async (directory, session) => {
      if (session.result) return session.result;
      // Check all parts before invoking upload(), which consumes assembled files.
      for (const field of fields) {
        const info = session.files[field];
        for (
          let index = 0;
          index < Math.ceil(info.size / RELEASE_CHUNK_SIZE);
          index++
        ) {
          const part = await stat(join(directory, `${field}-${index}`)).catch(
            () => null,
          );
          if (
            part?.size !==
            Math.min(RELEASE_CHUNK_SIZE, info.size - index * RELEASE_CHUNK_SIZE)
          ) {
            throw new BadRequestException(`Thiếu phần ${index} của ${field}`);
          }
        }
      }
      const files: AppReleaseFiles = {};
      try {
        for (const field of fields) {
          const info = session.files[field];
          const path = join(directory, `${field}-assembled`);
          await writeFile(path, '');
          for (
            let index = 0;
            index < Math.ceil(info.size / RELEASE_CHUNK_SIZE);
            index++
          ) {
            await pipeline(
              createReadStream(join(directory, `${field}-${index}`)),
              createWriteStream(path, { flags: 'a' }),
            );
          }
          files[field] = [
            {
              path,
              originalname: info.name,
              size: info.size,
              fieldname: field,
            } as Express.Multer.File,
          ];
        }
        session.result = await this.releases.upload(files);
        await this.save(directory, session);
        await this.removeParts(directory);
        return session.result;
      } finally {
        await Promise.all(
          fields.map((field) =>
            rm(join(directory, `${field}-assembled`), { force: true }),
          ),
        );
      }
    });
  }

  async cancel(id: string) {
    return this.lock(id, async (directory) => {
      await rm(join(directory, 'session.json'), { force: true });
      await this.removeParts(directory);
      return { cancelled: true };
    });
  }

  private directory(id: string) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        id,
      )
    )
      throw new BadRequestException('Upload ID không hợp lệ');
    return join(this.root, id);
  }

  private async lock<T>(
    id: string,
    action: (directory: string, session: Session) => Promise<T>,
  ) {
    const directory = this.directory(id);
    const lockPath = join(directory, '.lock');
    try {
      await mkdir(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new NotFoundException('Phiên upload không tồn tại');
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new ConflictException(
          'Phiên upload đang xử lý, vui lòng thử lại',
        );
      throw error;
    }
    try {
      const session = await readFile(join(directory, 'session.json'), 'utf8')
        .then((value) => JSON.parse(value) as Session)
        .catch(() => null);
      if (!session || session.expiresAt < Date.now())
        throw new NotFoundException('Phiên upload đã hết hạn');
      return await action(directory, session);
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }

  private async save(directory: string, session: Session) {
    await writeFile(join(directory, 'session.tmp'), JSON.stringify(session));
    await rename(
      join(directory, 'session.tmp'),
      join(directory, 'session.json'),
    );
  }

  private async removeParts(directory: string) {
    for (const name of await readdir(directory)) {
      if (/^(manifest|installer|blockmap)-/.test(name))
        await rm(join(directory, name), { force: true });
    }
  }

  private async sweep() {
    await mkdir(this.root, { recursive: true });
    for (const id of await readdir(this.root)) {
      if (!/^[0-9a-f-]{36}$/.test(id)) continue;
      const directory = this.directory(id);
      // A crashed process may leave a lock; remove the entire expired session only.
      const modified = await stat(directory).catch(() => null);
      if (modified && Date.now() - modified.mtimeMs > TTL)
        await rm(directory, { recursive: true, force: true });
    }
  }
}
