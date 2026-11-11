import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    // Chỉ trích xuất từ Request Header (không chấp nhận query parameter)
    const rawApiKey =
      request.headers['x-api-key'] || request.headers['X-API-KEY'];

    const apiKey = Array.isArray(rawApiKey) ? rawApiKey[0] : rawApiKey;

    if (!apiKey) {
      throw new UnauthorizedException(
        'Yêu cầu cung cấp API Key hợp lệ trong Header x-api-key',
      );
    }

    const validApiKey = this.configService.get<string>('PUBLIC_API_KEY');

    if (!validApiKey) {
      throw new UnauthorizedException(
        'Hệ thống chưa được cấu hình PUBLIC_API_KEY',
      );
    }

    // Hỗ trợ cấu hình nhiều key phân tách bởi dấu phẩy
    const validKeys = validApiKey
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);

    if (!validKeys.includes(apiKey.trim())) {
      throw new UnauthorizedException(
        'API Key không hợp lệ hoặc đã bị vô hiệu hóa',
      );
    }

    return true;
  }
}
