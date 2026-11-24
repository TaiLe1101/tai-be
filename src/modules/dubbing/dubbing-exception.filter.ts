import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

/**
 * Scoped exception filter for /api/v1/dubbing/* returning flat JSON errors
 * (preserving structured codes such as AUTH_REQUIRED, SUBTITLE_DOWNLOAD_FAILED,
 * QUOTA_EXCEEDED, SUBSCRIPTION_EXPIRED, TENANT_SUSPENDED, and optional quota).
 */
@Catch()
export class DubbingExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DubbingExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code: string = HttpStatus[status] ?? 'INTERNAL_SERVER_ERROR';
    let message = 'Internal server error';
    let quota: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      code =
        status === HttpStatus.UNAUTHORIZED
          ? 'AUTH_REQUIRED'
          : (HttpStatus[status] ?? 'HTTP_EXCEPTION');
      const res = exception.getResponse();

      if (typeof res === 'string') {
        message = res;
      } else if (res && typeof res === 'object') {
        const obj = res as Record<string, unknown>;
        if (typeof obj.code === 'string' && obj.code.trim()) {
          code = obj.code;
        }
        if ('quota' in obj && obj.quota !== undefined) {
          quota = obj.quota;
        }
        if (Array.isArray(obj.message)) {
          message = obj.message.join(', ');
        } else if (typeof obj.message === 'string') {
          message = obj.message;
        } else {
          message = exception.message;
        }
      } else {
        message = exception.message;
      }
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `[${request.method}] ${request.url} -> ${status} (${code}): ${message}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json({
      statusCode: status,
      code,
      message,
      ...(quota !== undefined ? { quota } : {}),
    });
  }
}
