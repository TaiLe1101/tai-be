# API phát hành desktop app Windows

Phạm vi: một ứng dụng Windows, generic provider của electron-updater, kênh stable.
Upload đủ bộ file tạo **bản nháp**; gọi API phát hành riêng để desktop app thấy bản mới.
Version đọc từ `latest.yml`, chỉ chấp nhận SemVer stable như `1.2.3`.

## Cài đặt

```powershell
npx prisma migrate deploy --config prisma7.config.ts
npx prisma generate --config prisma7.config.ts
npm run build
```

Migration thêm `app_releases`, `app_release_channels` và bốn permission.
Có thể đồng bộ lại quyền bằng `POST /api/v1/rbac/permissions/refresh` theo luồng RBAC hiện tại.
Gán quyền cho role bằng API RBAC. User `isRoot=true` được bỏ qua kiểm tra quyền.
Backend nạp lại quyền từ role và permission đang hoạt động trên mỗi request JWT.

## API public lấy bản mới nhất cho landing page

`GET /api/v1/app-releases/latest` không yêu cầu JWT hoặc permission.
API trả `ResponseApi` với `data` giống API detail, gồm version, thông tin file,
`publishedAt`, `status: "published"`, `isCurrent: true` và `files`.
Frontend dùng `data.files.installer` (đường dẫn tương đối với domain backend) cho nút tải.

API lấy bản đang được phát hành trên kênh stable, bỏ qua các bản nháp mới upload.
Chưa có bản phát hành thì trả HTTP 404. Response thành công có `Cache-Control: no-store`.

Ví dụ: `https://api-tai.localtest.me/api/v1/app-releases/latest`.

## API quản trị

Tất cả yêu cầu `Authorization: Bearer <access_token>` và trả `ResponseApi` hiện có.

| Method | URL | Permission | Mục đích |
|---|---|---|---|
| GET | `/api/v1/app-releases` | `app_releases:view` | Danh sách phân trang |
| GET | `/api/v1/app-releases/:id` | `app_releases:view` | Chi tiết |
| POST | `/api/v1/app-releases` | `app_releases:upload` | Upload ba file, tạo draft |
| POST | `/api/v1/app-releases/:id/publish` | `app_releases:publish` | Phát hành lên stable |
| DELETE | `/api/v1/app-releases/:id` | `app_releases:delete` | Xóa draft và file |

Danh sách hỗ trợ `page`, `limit` (tối đa 100), `q` (tìm version), `status=draft|published`,
`sortBy=id|version|createdAt|publishedAt`, `sortOrder=asc|desc`.
Sắp xếp `version` là thứ tự chuỗi; kiểm tra phát hành sử dụng so sánh SemVer.

Upload dùng `multipart/form-data`, không gửi field văn bản:

| Field | File | Giới hạn |
|---|---|---|
| `manifest` | `latest.yml` | 1 MiB |
| `installer` | `[my-app].exe` | 500 MiB |
| `blockmap` | `[my-app].exe.blockmap` | 500 MiB |

Tên blockmap phải bằng tên installer + `.blockmap`. Tên file cho phép chữ ASCII, số,
khoảng trắng, `.`, `_`, `(`, `)`, `+`, `-`; tối đa 200 ký tự, không có đường dẫn.
Không đổi tên installer sau khi build. MIME type không được dùng để xác thực vì file build thường có MIME octet-stream.

```powershell
curl.exe -X POST http://localhost:3000/api/v1/app-releases `
  -H "Authorization: Bearer <token>" `
  -F "manifest=@latest.yml" `
  -F "installer=@My App Setup 1.2.3.exe" `
  -F "blockmap=@My App Setup 1.2.3.exe.blockmap"

curl.exe -X POST http://localhost:3000/api/v1/app-releases/1/publish `
  -H "Authorization: Bearer <token>"
```

Upload trả HTTP 201; các API khác trả 200. `data` có thông tin version, installer,
size, SHA-512, người upload/phát hành, `publishedAt`, `status`, `isCurrent`, và `files`
chứa ba URL tương đối. URL file của draft chưa tải công khai được.
`published` nghĩa là đã từng phát hành; `isCurrent` chỉ bản stable đang được quảng bá.
`manifest` trong DB là nội dung YAML phục vụ feed, không đưa vào JSON quản trị.

Quy tắc:

- Version trùng trả 409; muốn thay file draft thì xóa draft rồi upload lại.
- Chỉ phát hành version lớn hơn stable hiện tại. Gọi lại publish bản đang stable là idempotent.
- Sau mỗi lần publish thành công, chỉ giữ **hai bản đã phát hành**: stable hiện tại và bản đã phát hành gần nhất trước đó (so sánh SemVer). Các bản phát hành cũ hơn bị xóa cả bản ghi DB và thư mục chứa ba file.
- Ví dụ: phát hành `1.0.2` thì giữ `1.0.2` và `1.0.1`, xóa `1.0.0`. Khi mới upload bản nháp hoặc publish thất bại thì không dọn bản cũ. Bản nháp không thuộc giới hạn hai bản phát hành và vẫn được xóa bằng API xóa draft.
- Không cho phép xóa thủ công bản đã phát hành bằng API xóa draft. Khi dọn tự động, link của bản bị xóa sẽ trả 404; máy đang tải bản đó có thể phải kiểm tra cập nhật lại.
- Upload/publish kiểm tra SHA-512, size và tên installer trong YAML; publish kiểm tra lại file trên đĩa.
- Upload không đủ ba file, YAML lỗi, checksum sai: 400. Quá giới hạn file: 413. Thiếu JWT: 401. Thiếu quyền: 403.
- Chỉ hỗ trợ `files` gồm một installer. Không hỗ trợ prerelease, nhiều kiến trúc, `packages` hoặc manifest có `signature`/`signatures`.
- `.blockmap` phải do electron-builder tạo cùng build với `.exe`; server kiểm tra tên và checksum lưu trữ, không giải mã cấu trúc blockmap để chứng minh nó khớp installer.

## Feed public cho electron-updater

```yaml
publish:
  provider: generic
  url: https://your-domain.example/uploads/app/release/
```

| URL | Nội dung |
|---|---|
| `/uploads/app/release/latest.yml` | YAML của stable hiện tại, `Cache-Control: no-store` |
| `/uploads/app/release/1.2.3/My%20App%20Setup%201.2.3.exe` | Installer đã phát hành, hỗ trợ HEAD/Range |
| `/uploads/app/release/1.2.3/My%20App%20Setup%201.2.3.exe.blockmap` | Blockmap đã phát hành |
| `/uploads/app/release/1.2.3/latest.yml` | YAML gốc của build đã phát hành |

`latest.yml` ở URL chung được trả động từ con trỏ stable trong DB, không tạo thêm bản sao vật lý ở thư mục gốc.
Server chuẩn hóa `files[].url`, `path` và `blockMapUrl` (nếu có) tới `<version>/<filename>`
trong feed chung. SHA-512, release notes và các metadata khác được giữ lại.
Ba file gốc nằm tại `uploads/app/release/<version>/`.
File của draft và đường dẫn khác không được phục vụ bởi static middleware.

Tham khảo định dạng feed và blockmap: [electron-builder Auto Update](https://www.electron.build/docs/features/auto-update/).

## Vận hành

Backend cần quyền ghi `uploads/app/release` và `.tmp/app-releases`; cả hai cần cùng filesystem để rename file.
Nếu chạy nhiều backend instance, tất cả phải dùng chung volume và DB. Các thao tác thay đổi
release được tuần tự hóa bằng PostgreSQL advisory transaction lock.
Database transaction cập nhật metadata và con trỏ stable cùng lúc; không thay thế manifest công khai khi upload.

Reverse proxy phải chuyển `/uploads/app/release/` đến backend, giữ header `Range`/`If-Range`,
không serve trực tiếp thư mục release hoặc cache `latest.yml`. Cấu hình giới hạn request body
đủ cho toàn bộ multipart (ví dụ nginx `client_max_body_size 1100m`) và timeout upload phù hợp.

Không có transaction phân tán giữa DB và filesystem. Backend dọn file khi request thất bại bình thường;
nếu process bị kill hoặc mất điện, có thể còn file staging hoặc thư mục version không có bản ghi DB.
Cần đối chiếu DB trước khi dọn thủ công.
Việc dọn bản phát hành cũ chạy sau khi transaction phát hành đã commit, trong một transaction riêng có cùng advisory lock.
Thư mục cũ được chuyển vào staging trước khi xóa bản ghi; nếu transaction dọn thất bại thì khôi phục thư mục.
Nếu không dọn được, backend ghi log và vẫn trả kết quả phát hành thành công để stable mới tiếp tục hoạt động;
gọi lại API publish cho bản đang stable (hoặc publish bản tiếp theo) sẽ thử dọn lại. Nếu chỉ lỗi xóa file staging,
bản ghi cũ đã bị xóa và file staging còn lại cần được dọn sau khi xử lý lỗi ổ đĩa.
Backup DB và volume release cùng nhau.
