import { SetMetadata } from '@nestjs/common';
import { PermissionCode } from '~/common/constants/permissions.constant';

export const PERMISSIONS_KEY = 'permissions';

/**
 * Decorator yêu cầu một hoặc nhiều quyền để truy cập endpoint.
 *
 * @param permissions Danh sách các quyền (được gợi ý kiểu từ PermissionCode)
 *
 * Ví dụ:
 * `@RequirePermissions(PERMISSIONS.ROLES.VIEW)`
 * `@RequirePermissions('users:create', 'users:update')`
 */
export const RequirePermission = (permission: PermissionCode) =>
  SetMetadata(PERMISSIONS_KEY, permission);
