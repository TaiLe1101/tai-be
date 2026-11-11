import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '~/common/decorators/permissions.decorator';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) { }

  canActivate(context: ExecutionContext): boolean {
    const requiredPermission = this.reflector.getAllAndOverride<string>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Nếu endpoint không khai báo @RequirePermissions -> Cho phép truy cập
    if (!requiredPermission) return true;

    const req = context.switchToHttp().getRequest();
    const user = req.user;

    if (!user) {
      throw new UnauthorizedException('Người dùng chưa được xác thực');
    }

    // Bypass quyền nếu là vai trò ADMIN hệ thống
    if (user.role && user.role === 'ROOT' || user.role === 'DEVELOPER') {
      return true;
    }

    const userPermissions: string[] = user.permissions || [];


    const hasAllPermissions = userPermissions.includes(requiredPermission);

    if (!hasAllPermissions) {
      throw new ForbiddenException('Bạn không có quyền thực hiện thao tác này');
    }

    return true;
  }
}
