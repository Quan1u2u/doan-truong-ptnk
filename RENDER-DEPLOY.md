# Triển khai website Đoàn trường PTNK trên Render

## Cấu hình đã chuẩn bị

- Render Web Service chạy FastAPI + Uvicorn.
- Phục vụ giao diện trong `public/` và API trong `server/app.py` trên cùng một domain.
- `DATA_DIR=/var/data` để dữ liệu nội dung, tài khoản quản trị, đơn hàng, lịch sử và ảnh tải lên nằm trên persistent disk.
- `render.yaml` khai báo health check tại `/api/noi-dung`.
- Persistent disk 1 GB; cấu hình `starter` vì Render Free Web Service không hỗ trợ persistent disk.

## Triển khai

1. Giải nén mã nguồn và tạo một repository GitHub riêng tư.
2. Đưa toàn bộ nội dung thư mục dự án lên repository (bao gồm `render.yaml`, `server/`, `public/`, `requirements.txt`). Không đưa `server/data/`, `.env`, mật khẩu hay bản sao lưu chứa dữ liệu cá nhân lên Git.
3. Mở Render Dashboard, chọn **New → Blueprint** và kết nối repository GitHub.
4. Render đọc `render.yaml`. Kiểm tra service `doan-truong-ptnk`, region Singapore, plan Starter và persistent disk 1 GB.
5. Xác nhận tạo Blueprint và chờ deploy hoàn tất.
6. Mở URL `https://doan-truong-ptnk.onrender.com` (hoặc URL `onrender.com` Render cấp nếu tên đã được sử dụng).
7. Kiểm tra `/api/noi-dung`, trang chủ, trang tin tức, trang merch và `/admin`.
8. Đăng nhập trang quản trị bằng mật khẩu quản trị hiện tại của dự án. Sau khi đăng nhập, đổi mật khẩu trong phần quản trị và kiểm tra lại đăng nhập.
9. Nếu dùng Google Sheets cho đơn Merch: mở cấu hình Google Sheet trong trang quản trị, nhập URL Apps Script đã triển khai và lưu khoá bảo mật tương ứng.

## Lưu ý quan trọng

- Không thể khôi phục mật khẩu quản trị từ giá trị băm trong `server/seed/quan-tri.json`. Cần biết mật khẩu hiện tại trước khi đưa website vào sử dụng. Không gửi mật khẩu cho người khác hoặc đưa vào GitHub.
- Render Free không hỗ trợ persistent disk cho Web Service. Vì website ghi nội dung, ảnh tải lên và đơn hàng vào filesystem, không dùng Free cho vận hành thật nếu chưa chuyển dữ liệu sang một dịch vụ lưu trữ bền vững khác.
- Persistent disk chỉ bảo toàn dữ liệu ghi dưới `/var/data`; dữ liệu này không được commit lên Git.
- Repository nên để Private vì mã nguồn có cấu hình quản trị và dữ liệu nội dung nội bộ.
- Sau deploy, kiểm tra kỹ trang quản trị, luồng tạo đơn và đồng bộ Google Sheets trước khi công bố rộng rãi.
