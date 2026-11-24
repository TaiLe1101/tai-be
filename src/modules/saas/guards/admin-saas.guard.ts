import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { CurrentUserType } from '~/types/current-user.type';

@Injectable()
export class AdminSaasGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ user?: CurrentUserType }>();
    const user = req.user;

    if (!user) {
      throw new UnauthorizedException('Người dùng chưa được xác thực');
    }

    if (user.isRoot) {
      return true;
    }

    const permissions = Array.isArray(user.permissions) ? user.permissions : [];
    const hasAdminAccess = permissions.some(
      (code) =>
        code === 'saas:manage' ||
        code === 'saas:view' ||
        code === 'settings:manager' ||
        code.startsWith('roles:') ||
        code.startsWith('system_users:') ||
        code.startsWith('app_releases:'),
    );

    if (!hasAdminAccess) {
      throw new ForbiddenException(
        'Bạn không có quyền truy cập mục quản trị SaaS',
      );
    }

    return true;
  }
}
