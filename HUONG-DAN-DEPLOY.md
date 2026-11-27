# Deploy lên Cloudflare Workers

Yêu cầu: Node 20+, tài khoản Cloudflare (gói Free chạy được D1 và R2; R2 cần gắn phương thức thanh toán nhưng gói miễn phí đủ dùng).

```bash
npm install
npx wrangler login

# 1. Tạo cơ sở dữ liệu D1, chép database_id in ra vào wrangler.toml
npx wrangler d1 create doan-ptnk
npx wrangler d1 execute doan-ptnk --remote --file=worker/schema.sql

# 2. Tạo kho ảnh R2
npx wrangler r2 bucket create doan-ptnk-up

# 3. Đặt bí mật
npx wrangler secret put ADMIN_PASSWORD   # mật khẩu admin ban đầu (>= 10 ký tự), chỉ dùng lần đăng nhập đầu tiên
npx wrangler secret put AGENT_KEY        # khoá cho agent-api.py (chuỗi ngẫu nhiên dài)

# 4. Triển khai
npx wrangler deploy
```

- Chạy thử trên máy: chép `.dev.vars.example` thành `.dev.vars`, chạy `npx wrangler d1 execute doan-ptnk --local --file=worker/schema.sql`, rồi `npx wrangler dev`.
- Sau lần đăng nhập đầu, vào Quản trị → Tài khoản để đổi mật khẩu. Sau đó `ADMIN_PASSWORD` không còn tác dụng.
- Nội dung ban đầu lấy từ `server/seed/noi-dung.json` (nạp vào D1 ở lần truy cập đầu). Mọi chỉnh sửa sau đó nằm trong D1.
- Sửa `app.js`, `admin.js`, `base.css`, `noi-dung.js` thì chạy `python3 cap-nhat-sha256.py` trước khi deploy.
- `agent-api.py`: đặt `API=https://<worker>.workers.dev` và `AGENT_KEY=<giá trị đã đặt ở bước 3>`.

## Khác với bản FastAPI cũ
- Mật khẩu băm PBKDF2 100.000 vòng (giới hạn của Workers), nên mật khẩu cũ không chuyển sang được; dùng `ADMIN_PASSWORD` mới.
- Ảnh được thu nhỏ và đổi sang WebP ngay trên trình duyệt khi tải lên từ trang quản trị. Ảnh gửi qua `agent-api.py` được lưu nguyên bản (tối đa 8 MB).
- IP người dùng lấy từ `CF-Connecting-IP`, nên giới hạn đăng nhập sai không bị giả mạo bằng header.
- Meta `api-base` để trống vì API và trang cùng một origin.
- Đơn hàng cũ (nếu có) cần nhập lại vào bảng `orders` của D1; liên hệ để mình viết script chuyển.
