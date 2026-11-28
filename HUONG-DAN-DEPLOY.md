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

1. Vào script.google.com, tạo dự án mới (hoặc Tiện ích mở rộng → Apps Script trong một Google Sheet bất kỳ), dán nội dung `apps-script/don-merch.gs`.
2. Đổi `KHOA` thành một chuỗi bí mật dài. Chép đúng chuỗi đó vào ô "Khoá bảo mật" trong trang quản trị (tab Merch → Kết nối Google).
3. Triển khai → Ứng dụng web (chạy với tư cách: Tôi, quyền truy cập: Bất kỳ ai). Cấp quyền Sheet, Drive, Gmail.
4. Dán URL `/exec` và link Google Sheet nhận đơn vào trang quản trị rồi Lưu. Bấm "Sao lưu lên Drive ngay" để thử.
5. Sửa file `.gs` sau này thì phải Triển khai → Quản lý bản triển khai → Sửa → Phiên bản mới (URL `/exec` giữ nguyên).

**Đổi sang Google Sheet khác:** chỉ cần đổi ô "Link Google Sheet nhận đơn" trong trang quản trị rồi Lưu, rồi bấm "Ghi lại toàn bộ đơn lên Sheet" nếu muốn chép các đơn cũ sang Sheet mới. Không cần tạo script mới và không phải đổi URL `/exec`. Website gửi kèm ID của Sheet trong mỗi lần ghi đơn. Tài khoản Google chạy script phải có quyền chỉnh sửa Sheet đó. Nếu ô này để trống, script ghi vào Sheet mà nó được gắn vào (cách cũ).

**Nâng cấp từ bản script cũ:** dán lại `don-merch.gs` mới, Triển khai → Quản lý bản triển khai → Sửa → Phiên bản mới, và cấp thêm quyền truy cập Google Sheets khi Google hỏi (mở Sheet theo ID cần quyền rộng hơn quyền "chỉ Sheet hiện tại").

Cách hoạt động:
- **Ảnh:** bản gốc nằm trong Drive; Worker giữ bản đệm trong D1 để trang tải nhanh. Nếu chưa nối Google, ảnh chỉ nằm trong D1.
- **Email xác nhận:** tự gửi một lần khi đơn chuyển sang "Đã xác nhận" hoặc "Đã nhận tiền". Nút "Gửi email xác nhận" trên từng đơn để gửi lại. Gmail thường giới hạn khoảng 100 email mỗi ngày (tài khoản @gmail.com).
- **Sao lưu:** mỗi ngày lúc 03:00 (giờ Việt Nam), Worker gửi nội dung và đơn hàng lên Drive, giữ 30 bản mới nhất.
- Nội dung email nằm ở hàm `soanMail` trong `worker/index.js`.

## Agent đồng bộ bản tin từ fanpage (`agent-fanpage.py`)

Agent lấy 20 bài mới nhất của fanpage, bài nào đã có (trùng mã bài hoặc link) thì bỏ qua, bài nào chưa có thì thu nhỏ ảnh, tải lên và thêm vào đầu danh sách bản tin, cùng định dạng với các bản tin trước. Bản tin cũ không bị sửa.
Nhóm, nhãn và hạn chót được đoán theo từ khoá, nên hãy xem lại trong trang quản trị sau mỗi lần chạy. Khi bài có chữ "mở đơn/đăng ký/tuyển" kèm "hạn ... dd/mm/yyyy" còn hiệu lực thì bài được đặt trạng thái "open" và có `han`.

Agent dùng Facebook Graph API (cách chính thức, ổn định) chứ không cào trang web, vì Facebook cấm và liên tục chặn việc cào.

### Lấy Page access token (làm một lần, bằng tài khoản quản trị fanpage)
1. Vào developers.facebook.com → My Apps → Create App (loại Business hoặc Other). App để ở chế độ Development là đủ khi bạn là quản trị viên của trang.
2. Tools → Graph API Explorer: chọn app, chọn quyền `pages_show_list` và `pages_read_engagement`, bấm Generate Access Token và chọn fanpage.
3. Token này sống ngắn. Đổi sang dài hạn: gọi `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=<APP_ID>&client_secret=<APP_SECRET>&fb_exchange_token=<TOKEN_NGAN>` để lấy user token dài hạn, rồi gọi `https://graph.facebook.com/v21.0/me/accounts?access_token=<USER_TOKEN_DAI>`. Trường `access_token` của fanpage trong kết quả chính là **Page token không hết hạn**.
4. Giữ bí mật token và App Secret. Giao diện và quyền của Meta thay đổi theo thời gian, nếu có chỗ khác thì xem tài liệu Graph API của Meta.

### Chạy thử trên máy
```bash
pip install pillow
export API=https://doantruongptnk.phamlmquan.workers.dev
export AGENT_KEY=<secret AGENT_KEY của Worker>
export FB_PAGE_TOKEN=<Page token>
python3 agent-fanpage.py --thu     # chỉ in ra bài sẽ thêm
python3 agent-fanpage.py           # thêm thật
```

### Chạy tự động mỗi 6 giờ (GitHub Actions)
Trong repo: Settings → Secrets and variables → Actions. Thêm Secret `AGENT_KEY`, Secret `FB_PAGE_TOKEN` và Variable `API_URL` (địa chỉ website). Workflow `.github/workflows/dong-bo-fanpage.yml` sẽ chạy theo lịch, hoặc bấm Run workflow trong tab Actions. GitHub tạm dừng lịch tự động nếu repo không có hoạt động nào trong 60 ngày.

Lưu ý: agent đọc rồi ghi cả danh sách bản tin, nên nếu bạn đang sửa bản tin trong trang quản trị đúng lúc agent chạy thì có thể bị ghi đè (Worker luôn lưu bản cũ trong lịch sử, giữ 30 bản gần nhất).
