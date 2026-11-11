import type { NestExpressApplication } from '@nestjs/platform-express';
import { static as serveStatic } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { posix } from 'node:path';

export function configureUploadsStatic(
  app: NestExpressApplication,
  directory: string,
) {
  const middleware = serveStatic(directory);
  app.use('/uploads', (req: Request, res: Response, next: NextFunction) => {
    // Normalize URL and Windows filename aliases before deciding whether static can serve it.
    let pathname: string;
    try {
      pathname = posix.normalize(
        decodeURIComponent(req.path)
          .replace(/\\/g, '/')
          .split('/')
          .map((part) =>
            part === '..' || part === '.' ? part : part.replace(/[ .]+$/g, ''),
          )
          .join('/'),
      );
    } catch {
      res.sendStatus(400);
      return;
    }
    if (/^\/app\/release(?:\/|$)/i.test(pathname)) {
      next();
      return;
    }
    middleware(req, res, next);
  });
}
