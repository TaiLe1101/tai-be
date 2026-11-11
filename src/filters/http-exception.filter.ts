import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ResponseApi } from '~/types/response-api.type';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Lỗi không xác định';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      message =
        typeof res === 'string'
          ? res
          : ((res as any)?.message ?? exception.message);
      if (Array.isArray(message)) {
        message = message.join(', ');
      }
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `[${request.method}] ${request.url} → ${status}: ${message}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response
      .status(status)
      .json(new ResponseApi(status, HttpStatus[status], message));
  }
}
