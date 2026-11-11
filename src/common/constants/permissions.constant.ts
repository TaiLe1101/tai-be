export const PERMISSIONS = {
  APP_RELEASES: {
    VIEW: 'app_releases:view',
    UPLOAD: 'app_releases:upload',
    PUBLISH: 'app_releases:publish',
    DELETE: 'app_releases:delete',
  },
  SYSTEM_USERS: {
    VIEW: 'system_users:view',
    CREATE: 'system_users:create',
    UPDATE: 'system_users:update',
    DELETE: 'system_users:delete',
  },
  ROLES: {
    VIEW: 'roles:view',
    CREATE: 'roles:create',
    UPDATE: 'roles:update',
    DELETE: 'roles:delete',
    ASSIGN: 'roles:assign',
  },
  SETTINGS: {
    MANAGER: 'settings:manager',
  },
  LOGIN_LOGS: {
    VIEW: 'login_logs:view',
  },
} as const;

type NestedValue<T> =
  T extends Record<string, infer U>
  ? U extends Record<string, unknown>
  ? NestedValue<U>
  : string
  : never;

export type PermissionCode = NestedValue<typeof PERMISSIONS>;

export const SYSTEM_PERMISSIONS_METADATA = [
  { code: PERMISSIONS.APP_RELEASES.VIEW, name: 'Xem phiên bản ứng dụng', description: 'Xem danh sách và chi tiết phiên bản desktop app', group: 'Phiên bản ứng dụng' },
  { code: PERMISSIONS.APP_RELEASES.UPLOAD, name: 'Upload phiên bản ứng dụng', description: 'Upload bộ file để tạo bản nháp desktop app', group: 'Phiên bản ứng dụng' },
  { code: PERMISSIONS.APP_RELEASES.PUBLISH, name: 'Phát hành phiên bản ứng dụng', description: 'Phát hành phiên bản desktop app lên kênh stable', group: 'Phiên bản ứng dụng' },
  { code: PERMISSIONS.APP_RELEASES.DELETE, name: 'Xóa bản nháp ứng dụng', description: 'Xóa phiên bản desktop app chưa phát hành', group: 'Phiên bản ứng dụng' },
  // USERS
  {
    code: PERMISSIONS.SYSTEM_USERS.VIEW,
    name: 'Xem người dùng',
    description: 'Xem danh sách và thông tin người dùng',
    group: 'Người dùng',
  },
  {
    code: PERMISSIONS.SYSTEM_USERS.CREATE,
    name: 'Tạo người dùng',
    description: 'Tạo mới người dùng',
    group: 'Người dùng',
  },
  {
    code: PERMISSIONS.SYSTEM_USERS.UPDATE,
    name: 'Cập nhật người dùng',
    description: 'Chỉnh sửa thông tin người dùng',
    group: 'Người dùng',
  },
  {
    code: PERMISSIONS.SYSTEM_USERS.DELETE,
    name: 'Xóa người dùng',
    description: 'Xóa người dùng khỏi hệ thống',
    group: 'Người dùng',
  },

  // ROLES
  {
    code: PERMISSIONS.ROLES.VIEW,
    name: 'Xem vai trò',
    description: 'Xem danh sách vai trò hệ thống',
    group: 'Vai trò',
  },
  {
    code: PERMISSIONS.ROLES.CREATE,
    name: 'Tạo vai trò',
    description: 'Tạo mới vai trò hệ thống',
    group: 'Vai trò',
  },
  {
    code: PERMISSIONS.ROLES.UPDATE,
    name: 'Cập nhật vai trò',
    description: 'Chỉnh sửa thông tin vai trò',
    group: 'Vai trò',
  },
  {
    code: PERMISSIONS.ROLES.DELETE,
    name: 'Xóa vai trò',
    description: 'Xóa vai trò khỏi hệ thống',
    group: 'Vai trò',
  },
  {
    code: PERMISSIONS.ROLES.ASSIGN,
    name: 'Gán quyền vai trò',
    description: 'Gán và phân quyền cho vai trò',
    group: 'Vai trò',
  },

  // LOGIN LOGS
  {
    code: PERMISSIONS.LOGIN_LOGS.VIEW,
    name: 'Xem lịch sử đăng nhập',
    description: 'Xem danh sách lịch sử đăng nhập hệ thống',
    group: 'Nhật ký hệ thống',
  },

  // SETTINGS
  {
    code: PERMISSIONS.SETTINGS.MANAGER,
    name: 'Quản lý cấu hình',
    description: 'Quản lý cấu hình hệ thống',
    group: 'Cấu hình',
  },
];
