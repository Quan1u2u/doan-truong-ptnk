# Deploy lên Cloudflare Workers

Yêu cầu: Node 20+, tài khoản Cloudflare (gói Free là đủ; không cần R2).

```bash
npm install
npx wrangler login

# 1. Tạo cơ sở dữ liệu D1, chép database_id in ra vào wrangler.toml
npx wrangler d1 create doan-ptnk
npx wrangler d1 execute doan-ptnk --remote --file=worker/schema.sql

# 2. Đặt bí mật
npx wrangler secret put ADMIN_PASSWORD   # mật khẩu admin ban đầu (>= 10 ký tự), chỉ dùng lần đăng nhập đầu tiên
npx wrangler secret put AGENT_KEY        # khoá cho agent-api.py (chuỗi ngẫu nhiên dài)

# 3. Triển khai
npx wrangler deploy
```

- Chạy thử trên máy: chép `.dev.vars.example` thành `.dev.vars`, chạy `npx wrangler d1 execute doan-ptnk --local --file=worker/schema.sql`, rồi `npx wrangler dev`.
- Sau lần đăng nhập đầu, vào Quản trị → Tài khoản để đổi mật khẩu. Sau đó `ADMIN_PASSWORD` không còn tác dụng.
- Nội dung ban đầu lấy từ `server/seed/noi-dung.json` (nạp vào D1 ở lần truy cập đầu). Mọi chỉnh sửa sau đó nằm trong D1.
- Sửa `app.js`, `admin.js`, `base.css`, `noi-dung.js` thì chạy `python3 cap-nhat-sha256.py` trước khi deploy.
- `agent-api.py`: đặt `API=https://<worker>.workers.dev` và `AGENT_KEY=<giá trị đã đặt ở bước 3>`.

## Khác với bản FastAPI cũ
- Mật khẩu băm PBKDF2 100.000 vòng (giới hạn của Workers), nên mật khẩu cũ không chuyển sang được; dùng `ADMIN_PASSWORD` mới.
- Ảnh được thu nhỏ và đổi sang WebP ngay trên trình duyệt khi tải lên từ trang quản trị. Ảnh gửi qua `agent-api.py` được lưu nguyên bản (tối đa 5 MB).
- IP người dùng lấy từ `CF-Connecting-IP`, nên giới hạn đăng nhập sai không bị giả mạo bằng header.
- Meta `api-base` để trống vì API và trang cùng một origin.
- Đơn hàng cũ (nếu có) cần nhập lại vào bảng `orders` của D1; liên hệ để mình viết script chuyển.

## Kết nối Google (Sheet, Drive, Gmail)

Một Google Apps Script (`apps-script/don-merch.gs`) chạy bằng tài khoản Google của BCH và làm bốn việc:
ghi đơn lên Google Sheet, lưu ảnh và bản sao lưu vào Google Drive (thư mục `Web Đoàn PTNK`), và gửi email xác nhận bằng Gmail.

1. Tạo Google Sheet mới → Tiện ích mở rộng → Apps Script, dán nội dung `apps-script/don-merch.gs`.
2. Đổi `KHOA` thành một chuỗi bí mật dài. Chép đúng chuỗi đó vào ô "Khoá bảo mật" trong trang quản trị (tab Merch → Kết nối Google).
3. Triển khai → Ứng dụng web (chạy với tư cách: Tôi, quyền truy cập: Bất kỳ ai). Cấp quyền Sheet, Drive, Gmail.
4. Dán URL `/exec` vào trang quản trị rồi Lưu. Bấm "Sao lưu lên Drive ngay" để thử.
5. Sửa file `.gs` sau này thì phải Triển khai → Quản lý bản triển khai → Sửa → Phiên bản mới.

Cách hoạt động:
- **Ảnh:** bản gốc nằm trong Drive; Worker giữ bản đệm trong D1 để trang tải nhanh. Nếu chưa nối Google, ảnh chỉ nằm trong D1.
- **Email xác nhận:** tự gửi một lần khi đơn chuyển sang "Đã xác nhận" hoặc "Đã nhận tiền". Nút "Gửi email xác nhận" trên từng đơn để gửi lại. Gmail thường giới hạn khoảng 100 email mỗi ngày (tài khoản @gmail.com).
- **Sao lưu:** mỗi ngày lúc 03:00 (giờ Việt Nam), Worker gửi nội dung và đơn hàng lên Drive, giữ 30 bản mới nhất.
- Nội dung email nằm ở hàm `soanMail` trong `worker/index.js`.
