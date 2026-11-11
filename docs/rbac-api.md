# Tài Liệu Tích Hợp API: Quản Lý Vai Trò & Phân Quyền (RBAC)

Tài liệu này cung cấp đặc tả kỹ thuật chi tiết dành cho các lập trình viên Frontend (Web / Mobile) để tích hợp toàn bộ các chức năng thuộc module RBAC (Role-Based Access Control).

---

## 1. Thông Tin Chung & Quy Chuẩn

- **Base URL**: `/rbac`
- **Content-Type**: `application/json`
- **Xác thực (Authentication)**: 
  - Mọi request đều yêu cầu Access Token trong Header:
    ```http
    Authorization: Bearer <access_token>
    ```

### Cấu trúc Response chuẩn (`ResponseApi<T>`)
Tất cả các API đều trả về định dạng wrapper đồng nhất:
```typescript
interface ResponseApi<T, M = any> {
  statusCode: number;           // HTTP status code (200, 400, 401, 404, 500)
  status: string;               // Mã trạng thái ứng dụng (VD: "CREATE_ROLE_SUCCESS")
  message: string;              // Thông báo mô tả tiếng Việt
  data: T | null;               // Dữ liệu chính trả về
  pagination: Pagination | null;// Dùng cho các API có phân trang
  meta: M | null;               // Thông tin phụ (VD: filter parameters)
}

interface Pagination {
  page: number;                 // Trang hiện tại (1-based)
  limit: number;                // Số lượng item trên một trang
  totalItems: number;           // Tổng số bản ghi thỏa điều kiện
  totalPage: number;            // Tổng số trang
}
```

---

## 2. TypeScript Interfaces / Types

```typescript
// 1. Đối tượng Quyền Hạn
export interface Permission {
  id: number;
  code: string;                 // Mã quyền duy nhất (VD: "system_users:view")
  name: string;                 // Tên hiển thị (VD: "Xem người dùng")
  description?: string | null;  // Mô tả chức năng của quyền
  group: string;                // Nhóm quyền (VD: "Người dùng", "Vai trò") -> Dùng group UI
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// 2. Đối tượng Vai Trò
export interface Role {
  id: number;
  code: string;                 // Mã vai trò duy nhất (VD: "ADMIN", "ACCOUNTANT")
  name: string;                 // Tên hiển thị vai trò (VD: "Kế toán viên")
  description?: string | null;  // Mô tả vai trò
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// 3. Chi tiết Vai Trò (Kèm quyền hạn đã gán)
export interface RolePermissionDetail {
  roleId: number;
  permissionId: number;
  permission: Permission;
}

export interface RoleDetail extends Role {
  rolePermissions: RolePermissionDetail[];
}

// 4. Payload tạo mới vai trò
export interface CreateRoleDTO {
  code: string;                 // Bắt buộc, không dấu/viết hoa (VD: "HR_MANAGER")
  name: string;                 // Bắt buộc (VD: "Trưởng phòng nhân sự")
  description?: string;         // Không bắt buộc
  userIds?: number[];           // Mảng id user được gán ngay vào role (optional)
  permissionIds: number[];      // Bắt buộc, mảng ID các quyền được cấp (tối thiểu 1 id)
}

// 5. Payload cập nhật thông tin vai trò
export interface UpdateRoleDTO extends CreateRoleDTO {}

// 6. Payload phân lại quyền cho vai trò
export interface AssignPermissionDTO {
  permissionIds: number[];      // Bắt buộc, danh sách ID quyền được phân
}

// 7. Query params phân trang & tìm kiếm
export interface RolePaginationQuery {
  page?: number;                // Mặc định: 1
  limit?: number;               // Mặc định: 10 (tối đa 100)
  q?: string;                   // Từ khóa tìm kiếm theo tên vai trò
  sortBy?: string;              // Mặc định: "createdAt"
  sortOrder?: 'asc' | 'desc';   // Mặc định: "desc"
}
```

---

## 3. Danh Sách Chi Tiết Các Endpoints

### 3.1. Lấy danh sách tất cả quyền hạn
> **Mục đích**: Dùng để render toàn bộ các checkbox / accordion phân quyền trên giao diện Tạo mới & Chỉnh sửa vai trò.

- **Method**: `GET`
- **URL**: `/rbac/permissions`
- **Headers**: `Authorization: Bearer <token>`
- **Response `200 OK`**:
```json
{
  "statusCode": 200,
  "status": "GET_PERMISSIONS_SUCCESS",
  "message": "Lấy danh sách quyền hạn thành công",
  "data": [
    {
      "id": 1,
      "code": "system_users:view",
      "name": "Xem người dùng",
      "description": "Xem danh sách và thông tin người dùng",
      "group": "Người dùng",
      "isActive": true
    },
    {
      "id": 2,
      "code": "system_users:create",
      "name": "Tạo người dùng",
      "description": "Tạo mới người dùng",
      "group": "Người dùng",
      "isActive": true
    },
    {
      "id": 5,
      "code": "roles:view",
      "name": "Xem vai trò",
      "description": "Xem danh sách vai trò",
      "group": "Vai trò",
      "isActive": true
    }
  ],
  "pagination": null,
  "meta": null
}
```

---

### 3.2. Lấy danh sách vai trò (Phân trang & Tìm kiếm)
> **Mục đích**: Hiển thị bảng (Table / DataGrid) danh sách các vai trò hiện có trong hệ thống.

- **Method**: `GET`
- **URL**: `/rbac/roles`
- **Query Parameters**:
  | Param | Type | Mặc định | Mô tả |
  | :--- | :--- | :--- | :--- |
  | `page` | `number` | `1` | Số trang cần lấy (tối thiểu 1) |
  | `limit` | `number` | `10` | Số lượng bản ghi mỗi trang (1 - 100) |
  | `q` | `string` | `undefined` | Từ khóa tìm kiếm theo tên vai trò |
  | `sortBy` | `string` | `"createdAt"` | Tên trường cần sắp xếp |
  | `sortOrder` | `string` | `"desc"` | Hướng sắp xếp: `"asc"` hoặc `"desc"` |

- **Request mẫu**: `GET /rbac/roles?page=1&limit=10&q=Kế toán`
- **Response `200 OK`**:
```json
{
  "statusCode": 200,
  "status": "GET_ALL_ROLE_SUCCESS",
  "message": "Lấy danh sách vai trò thành công",
  "data": [
    {
      "id": 1,
      "code": "ADMIN",
      "name": "Quản trị viên",
      "description": "Toàn quyền quản trị hệ thống",
      "isActive": true,
      "createdAt": "2026-11-01T08:00:00.000Z",
      "updatedAt": "2026-11-01T08:00:00.000Z"
    },
    {
      "id": 2,
      "code": "ACCOUNTANT",
      "name": "Kế toán viên",
      "description": "Quản lý hóa đơn và chứng từ",
      "isActive": true,
      "createdAt": "2026-11-02T09:30:00.000Z",
      "updatedAt": "2026-11-02T09:30:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "totalItems": 2,
    "totalPage": 1
  },
  "meta": {
    "q": "Kế toán"
  }
}
```

---

### 3.3. Tạo vai trò mới
> **Mục đích**: Tạo một vai trò mới, đồng thời cấp ngay danh sách quyền hạn và gán người dùng vào vai trò nếu có.

- **Method**: `POST`
- **URL**: `/rbac/roles`
- **Headers**: `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body**:
```json
{
  "code": "ACCOUNTANT",
  "name": "Kế toán viên",
  "description": "Phụ trách các nghiệp vụ kế toán doanh nghiệp",
  "permissionIds": [1, 2, 5],
  "userIds": [10, 15]
}
```
| Field | Type | Required | Validate / Ghi chú |
| :--- | :--- | :--- | :--- |
| `code` | `string` | **Bắt buộc** | Không được để trống, duy nhất trong hệ thống |
| `name` | `string` | **Bắt buộc** | Không được để trống |
| `description` | `string` | Không | Mô tả chức năng vai trò |
| `permissionIds` | `number[]` | **Bắt buộc** | Mảng ID các quyền được gán, không được rỗng |
| `userIds` | `number[]` | Không | Mảng ID các user nhận role này ngay khi tạo |

- **Response `200 OK`**:
```json
{
  "statusCode": 200,
  "status": "CREATE_ROLE_SUCCESS",
  "message": "Thêm vai trò mới thành công",
  "data": {
    "id": 3,
    "code": "ACCOUNTANT",
    "name": "Kế toán viên",
    "description": "Phụ trách các nghiệp vụ kế toán doanh nghiệp",
    "isActive": true,
    "createdAt": "2026-11-06T10:00:00.000Z",
    "updatedAt": "2026-11-06T10:00:00.000Z"
  },
  "pagination": null,
  "meta": null
}
```

- **Mã lỗi có thể gặp**:
  - `400 Bad Request`: `code` hoặc `name` bị trống, `permissionIds` không phải mảng hoặc bị rỗng.
  - `409 Conflict`: `code` vai trò đã tồn tại trên hệ thống.

---

### 3.4. Xem chi tiết vai trò
> **Mục đích**: Lấy thông tin vai trò kèm toàn bộ các quyền hạn đã được cấp. Sử dụng khi mở Modal / Drawer xem chi tiết hoặc chỉnh sửa.

- **Method**: `GET`
- **URL**: `/rbac/roles/detail/:id`
- **Params**: `id` (số nguyên) - ID của vai trò
- **Ví dụ**: `GET /rbac/roles/detail/3`
- **Response `200 OK`**:
```json
{
  "statusCode": 200,
  "status": "DETAIL_ROLE_SUCCESS",
  "message": "Chi tiết vai trò thành công",
  "data": {
    "id": 3,
    "code": "ACCOUNTANT",
    "name": "Kế toán viên",
    "description": "Phụ trách các nghiệp vụ kế toán",
    "isActive": true,
    "createdAt": "2026-11-06T10:00:00.000Z",
    "updatedAt": "2026-11-06T10:00:00.000Z",
    "rolePermissions": [
      {
        "roleId": 3,
        "permissionId": 1,
        "permission": {
          "id": 1,
          "code": "system_users:view",
          "name": "Xem người dùng",
          "description": "Xem danh sách và thông tin người dùng",
          "group": "Người dùng",
          "isActive": true
        }
      },
      {
        "roleId": 3,
        "permissionId": 5,
        "permission": {
          "id": 5,
          "code": "roles:view",
          "name": "Xem vai trò",
          "description": "Xem danh sách vai trò",
          "group": "Vai trò",
          "isActive": true
        }
      }
    ]
  },
  "pagination": null,
  "meta": null
}
```

- **Mã lỗi có thể gặp**:
  - `404 Not Found`: Không tìm thấy vai trò với ID tương ứng.

---

### 3.5. Cập nhật thông tin vai trò
> **Mục đích**: Cập nhật tên, mã hoặc mô tả của vai trò.

- **Method**: `PUT`
- **URL**: `/rbac/roles/:id`
- **Params**: `id` (số nguyên) - ID vai trò
- **Request Body**:
```json
{
  "code": "ACCOUNTANT_LEAD",
  "name": "Kế toán trưởng",
  "description": "Quản lý và ký duyệt chứng từ kế toán"
}
```
- **Response `200 OK`**:
```json
{
  "statusCode": 200,
  "status": "UPDATE_ROLE_SUCCESS",
  "message": "Cập nhật vai trò thành công",
  "data": {
    "id": 3,
    "code": "ACCOUNTANT_LEAD",
    "name": "Kế toán trưởng",
    "description": "Quản lý và ký duyệt chứng từ kế toán",
    "isActive": true,
    "updatedAt": "2026-11-06T10:30:00.000Z"
  },
  "pagination": null,
  "meta": null
}
```

---

### 3.6. Phân lại quyền cho vai trò
> **Mục đích**: Gán lại danh sách quyền hạn cho vai trò (ghi đè toàn bộ các quyền cũ).

- **Method**: `PUT`
- **URL**: `/rbac/roles/assign/:id`
- **Params**: `id` (số nguyên) - ID vai trò
- **Request Body**:
```json
{
  "permissionIds": [1, 2, 5, 6, 7]
}
```
- **Response `200 OK`**:
```json
{
  "statusCode": 200,
  "status": "ASSIGN_PERMISSION_SUCCESS",
  "message": "Phần quyền cho vai trò hệ thống thành công",
  "data": {
    "id": 3,
    "code": "ACCOUNTANT_LEAD",
    "name": "Kế toán trưởng",
    "rolePermissions": [
      {
        "roleId": 3,
        "permissionId": 1,
        "permission": {
          "id": 1,
          "code": "system_users:view",
          "name": "Xem người dùng"
        }
      }
    ]
  },
  "pagination": null,
  "meta": null
}
```

---

### 3.7. Xóa vai trò
> **Mục đích**: Xóa vai trò khỏi hệ thống.

- **Method**: `DELETE`
- **URL**: `/rbac/roles/:id`
- **Params**: `id` (số nguyên) - ID vai trò cần xóa
- **Response `200 OK`**:
```json
{
  "statusCode": 200,
  "status": "DELETE_ROLE_SUCCESS",
  "message": "Xóa vai trò thành công",
  "data": {
    "id": 3,
    "code": "ACCOUNTANT_LEAD"
  },
  "pagination": null,
  "meta": null
}
```

---

### 3.8. Đồng bộ lại danh sách quyền hệ thống (System Sync)
> **Mục đích**: Đồng bộ tự động các quyền định nghĩa trong metadata code vào Database (dành cho Admin hệ thống).

- **Method**: `POST`
- **URL**: `/rbac/permissions/refresh`
- **Response `200 OK`**:
```json
{
  "statusCode": 200,
  "status": "REFRESH_SUCCESS",
  "message": "Làm mới quyền hạn thành công",
  "data": [ ... danh sách permissions sau đồng bộ ... ]
}
```

---

## 4. Hướng Dẫn Luồng Tích Hợp UI/UX (Frontend Workflow)

### Luồng 1: Màn hình Tạo vai trò mới
```
1. Frontend load dữ liệu danh mục quyền:
   -> Gọi GET /rbac/permissions
   -> Nhóm danh sách theo trường `group` (ví dụ: { "Người dùng": [...], "Vai trò": [...] })
   -> Render thành các nhóm Checkbox trên Form.

2. Người dùng điền Form:
   - Mã vai trò (code)
   - Tên vai trò (name)
   - Tích chọn các quyền cần cấp (lưu mảng ID vào `permissionIds`)

3. Submit:
   -> Gọi POST /rbac/roles với body: { code, name, description, permissionIds }
   -> Nhận thông báo thành công, reload lại bảng vai trò.
```

### Luồng 2: Màn hình Phân quyền / Chỉnh sửa vai trò
```
1. Khi bấm nút "Sửa" hoặc "Phân quyền" của một Role:
   -> Gọi đồng thời 2 API:
      - GET /rbac/permissions (tất cả quyền trong hệ thống)
      - GET /rbac/roles/detail/:id (thông tin vai trò và các quyền hiện có)

2. Đặt trạng thái ban đầu (Initial State):
   - selectedPermissionIds = role.rolePermissions.map(rp => rp.permissionId)
   - Checkbox nào có id nằm trong selectedPermissionIds sẽ được bật (checked).

3. Khi người dùng lưu thay đổi quyền:
   -> Gọi PUT /rbac/roles/assign/:id với body: { permissionIds: selectedPermissionIds }
```

---

## 5. Tổng Hợp Mã Trạng Thái HTTP (Status Codes)

| HTTP Code | Ý nghĩa | Xử lý khuyến nghị trên FE |
| :--- | :--- | :--- |
| `200 OK` | Thao tác thành công | Đóng modal, hiển thị Toast success, refresh data table. |
| `400 Bad Request` | Dữ liệu đầu vào sai validation | Hiển thị thông báo lỗi dưới các trường input tương ứng. |
| `401 Unauthorized` | Token hết hạn / Chưa đăng nhập | Xóa token trong Storage, chuyển hướng về trang `/login`. |
| `403 Forbidden` | Không có quyền thực hiện thao tác | Hiển thị Toast cảnh báo "Bạn không có quyền thực hiện thao tác này". |
| `404 Not Found` | Không tìm thấy vai trò với ID truyền vào | Hiển thị Toast lỗi, load lại danh sách vai trò. |
| `500 Server Error` | Lỗi máy chủ | Hiển thị thông báo "Hệ thống đang bận, vui lòng thử lại sau". |

