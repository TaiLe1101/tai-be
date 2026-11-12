# Upload bản phát hành theo phần

Admin sử dụng luồng này cho cả `latest.yml`, bộ cài `.exe` và `.exe.blockmap`.
Giới hạn vẫn là 1 MiB cho manifest và 500 MiB cho mỗi file còn lại.

Các endpoint nằm dưới `/api/v1/app-releases/uploads`:

1. `POST /`: gửi `{ files: { manifest: { name, size }, installer: { name, size }, blockmap: { name, size } } }`. Phản hồi `data` gồm `uploadId` và `chunkSize` (5 MiB).
2. `PUT /:uploadId/:field/:index`: multipart có trường `chunk`; chỉ số bắt đầu từ 0. Mỗi phần phải đúng kích thước đã khai báo, phần cuối có thể nhỏ hơn. Có thể gửi lại cùng chỉ số. Admin gửi tối đa 3 request đồng thời và thử lại tối đa 4 lần sau lần gửi đầu khi lỗi mạng hoặc HTTP 408/409/429/5xx.
3. `POST /:uploadId/complete`: kiểm tra đủ phần, ghép trên ổ đĩa, kiểm tra manifest/checksum và tạo bản nháp bằng luồng hiện có. Gọi lại khi thành công trả về cùng kết quả trong thời hạn phiên.
4. `DELETE /:uploadId`: hủy phiên và xóa các phần tạm. Phiên đang xử lý trả về 409 để tránh xóa file đang ghép.

Các phần nằm trong `.tmp/app-releases/chunks`, ngoài thư mục public. Phiên hết hạn sau 24 giờ không hoạt động; tác vụ dọn chạy lúc khởi động và mỗi 10 phút. Phần đã ghép được xóa sau khi hoàn tất. API upload multipart cũ vẫn hoạt động.

Triển khai backend trước Admin. Reverse proxy cần cho phép multipart lớn hơn 5 MiB (ví dụ giới hạn body 8 MiB); request hoàn tất cần đủ thời gian để ghép và kiểm tra file, Admin chờ tối đa 120 giây mỗi lần. Khi chạy nhiều backend instance, dùng chung volume cho `.tmp/app-releases` và `uploads/app/release`; khóa thư mục đồng bộ các thao tác trên cùng phiên.

Kiểm tra backend: `npm test -- --runInBand app-releases` (gồm upload 150 MiB, phần đến sai thứ tự, thử lại, thiếu phần, giới hạn kích thước và hủy). Kiểm tra Admin: `npm run test:upload` trong `tai-admin`.
