import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export interface ClientInfo {
  ipAddress: string;
  userAgent?: string;
  device?: string;
}

/**
 * Trích xuất địa chỉ IP thực tế của client (hỗ trợ proxy, nginx, cloudflare, docker, IPv6)
 */
export function extractClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  let ip: string | undefined;

  if (typeof forwarded === 'string') {
    ip = forwarded.split(',')[0]?.trim();
  } else if (Array.isArray(forwarded) && forwarded.length > 0) {
    ip = forwarded[0]?.trim();
  }

  if (!ip) {
    const realIp = req.headers['x-real-ip'];
    if (typeof realIp === 'string') {
      ip = realIp.trim();
    }
  }

  if (!ip) {
    ip = req.ip || req.socket?.remoteAddress || 'Unknown';
  }

  // Chuẩn hóa IPv6 cục bộ về IPv4 dễ nhìn
  if (ip === '::1') {
    return '127.0.0.1';
  }
  if (ip.startsWith('::ffff:')) {
    return ip.replace('::ffff:', '');
  }

  return ip;
}

/**
 * Phân tích user-agent để lấy tên trình duyệt và hệ điều hành thân thiện
 */
export function extractDevice(userAgent?: string): string {
  if (!userAgent) {
    return 'Unknown Device';
  }

  if (userAgent.includes('PostmanRuntime')) {
    return 'Postman';
  }

  // Xác định hệ điều hành (OS)
  let os = 'Unknown OS';
  if (/windows nt 10/i.test(userAgent)) os = 'Windows 10/11';
  else if (/windows nt 6.3/i.test(userAgent)) os = 'Windows 8.1';
  else if (/windows nt 6.1/i.test(userAgent)) os = 'Windows 7';
  else if (/macintosh|mac os x/i.test(userAgent)) os = 'macOS';
  else if (/iphone|ipad|ipod/i.test(userAgent)) os = 'iOS';
  else if (/android/i.test(userAgent)) os = 'Android';
  else if (/linux/i.test(userAgent)) os = 'Linux';

  // Xác định trình duyệt (Browser)
  let browser = 'Unknown Browser';
  if (/edg/i.test(userAgent)) browser = 'Edge';
  else if (/opr|opera/i.test(userAgent)) browser = 'Opera';
  else if (/chrome|crios/i.test(userAgent)) browser = 'Chrome';
  else if (/firefox|fxios/i.test(userAgent)) browser = 'Firefox';
  else if (/safari/i.test(userAgent)) browser = 'Safari';

  return `${browser} on ${os}`;
}

/**
 * Custom Param Decorator lấy thông tin client (IP, User-Agent, Device) từ request
 *
 * @example
 * @Post('login')
 * login(@Body() body: LoginDto, @ClientInfo() clientInfo: ClientInfo) {
 *   console.log(clientInfo.ipAddress, clientInfo.device);
 * }
 */
export const ClientInfoParam = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ClientInfo => {
    const request = ctx.switchToHttp().getRequest<Request>();
    const userAgent = request.headers['user-agent'];
    const ipAddress = extractClientIp(request);
    const device = extractDevice(userAgent);

    return {
      ipAddress,
      userAgent: typeof userAgent === 'string' ? userAgent : undefined,
      device,
    };
  },
);
