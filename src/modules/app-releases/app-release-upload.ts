import { BadRequestException } from '@nestjs/common';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { diskStorage } from 'multer';

export const APP_RELEASE_ROOT = join(
  process.cwd(),
  'uploads',
  'app',
  'release',
);
// Outside the public uploads directory, including incomplete multipart requests.
export const APP_RELEASE_STAGING = join(process.cwd(), '.tmp', 'app-releases');
export const MAX_RELEASE_FILE_SIZE = 500 * 1024 * 1024;

export const appReleaseMulterOptions: MulterOptions = {
  storage: diskStorage({
    destination: (_req, _file, cb) => {
      try {
        mkdirSync(APP_RELEASE_STAGING, { recursive: true });
        cb(null, APP_RELEASE_STAGING);
      } catch (error) {
        cb(error as Error, APP_RELEASE_STAGING);
      }
    },
    filename: (_req, _file, cb) => cb(null, randomUUID()),
  }),
  limits: {
    fileSize: MAX_RELEASE_FILE_SIZE,
    files: 3,
    fields: 0,
    parts: 4,
  },
  fileFilter: (_req, file, cb) => {
    const valid =
      (file.fieldname === 'manifest' && file.originalname === 'latest.yml') ||
      (file.fieldname === 'installer' && file.originalname.endsWith('.exe')) ||
      (file.fieldname === 'blockmap' &&
        file.originalname.endsWith('.exe.blockmap'));
    if (!valid || !isSafeArtifactName(file.originalname)) {
      cb(
        new BadRequestException('Tên file hoặc trường upload không hợp lệ'),
        false,
      );
      return;
    }
    cb(null, true);
  },
};

export function isSafeArtifactName(name: string): boolean {
  return (
    name.length <= 200 &&
    /^[a-zA-Z0-9][a-zA-Z0-9 ._()+-]*$/.test(name) &&
    !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name) &&
    !name.endsWith('.') &&
    !name.endsWith(' ')
  );
}

export type AppReleaseFiles = {
  manifest?: Express.Multer.File[];
  installer?: Express.Multer.File[];
  blockmap?: Express.Multer.File[];
};
