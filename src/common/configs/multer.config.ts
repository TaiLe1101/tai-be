import { BadRequestException } from '@nestjs/common';
import { existsSync, mkdirSync } from 'fs';
import { diskStorage } from 'multer';
import { extname, join } from 'path';

export const TASK_EVIDENCE_UPLOAD_DIR = join(
  process.cwd(),
  'uploads',
  'task-evidences',
);

export const taskEvidenceMulterOptions = {
  storage: diskStorage({
    destination: (req, file, cb) => {
      if (!existsSync(TASK_EVIDENCE_UPLOAD_DIR)) {
        mkdirSync(TASK_EVIDENCE_UPLOAD_DIR, { recursive: true });
      }
      cb(null, TASK_EVIDENCE_UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      const ext = extname(file.originalname).toLowerCase();
      cb(null, `evidence-${uniqueSuffix}${ext}`);
    },
  }),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
    files: 1, // Tối đa 1 file ảnh
  },
  fileFilter: (req: any, file: Express.Multer.File, cb: any) => {
    const allowedMimeTypes = [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/jpg',
    ];
    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new BadRequestException(
          'Định dạng file không hợp lệ. Chỉ chấp nhận file ảnh (.jpg, .jpeg, .png, .webp)',
        ),
        false,
      );
    }
  },
};
