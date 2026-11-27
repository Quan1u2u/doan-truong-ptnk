#!/usr/bin/env python3
"""Máy chủ nội dung cho website Đoàn trường PTNK.

- GET  /api/noi-dung            nội dung công khai (bản tin, CLB, đơn, văn bản)
- POST /api/dang-nhap           đăng nhập quản trị (mật khẩu, PBKDF2-HMAC-SHA256)
- POST /api/dang-xuat
- PUT  /api/noi-dung            lưu toàn bộ nội dung (cần đăng nhập)
- POST /api/anh                 tải ảnh lên (base64), tự chuyển sang WebP
- POST /api/doi-mat-khau
- GET  /api/sao-luu             bản sao lưu (chỉ agent key)
- GET  /up/<ten>.webp           ảnh đã tải lên
- POST /api/don-hang            tạo đơn merch (công khai), trả mã đơn và khoá đơn
- POST /api/don-hang/<ma>/da-thanh-toan  người mua báo đã chuyển khoản, đơn được ghi lên Google Sheet
- GET/PUT /api/sheet            cấu hình Google Sheet (Apps Script) nhận đơn (cần đăng nhập)

Dữ liệu nằm trong DATA_DIR (mặc định server/data). Lần chạy đầu sẽ chép từ server/seed.
"""
import asyncio, base64, hashlib, hmac, io, json, os, re, secrets, shutil, threading, time, urllib.request
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from PIL import Image, ImageOps

HERE = Path(__file__).resolve().parent
SEED = HERE / "seed"
DATA = Path(os.environ.get("DATA_DIR", HERE / "data"))
UP = DATA / "up"
HIST = DATA / "lich-su"
ND_FILE = DATA / "noi-dung.json"
AUTH_FILE = DATA / "quan-tri.json"
DH_FILE = DATA / "don-hang.json"   # đơn đặt merch (dữ liệu cá nhân, không công khai)
PBKDF2_ITER = 310_000
TOKEN_TTL = 8 * 3600
LOCK = threading.Lock()

# ---------------------------------------------------------------- khởi tạo dữ liệu
def init_data():
    DATA.mkdir(parents=True, exist_ok=True)
    UP.mkdir(exist_ok=True)
    HIST.mkdir(exist_ok=True)
    if not ND_FILE.exists():
        shutil.copy(SEED / "noi-dung.json", ND_FILE)
    if not AUTH_FILE.exists():
        shutil.copy(SEED / "quan-tri.json", AUTH_FILE)
    if not DH_FILE.exists():
        if (SEED / "don-hang.json").exists():
            shutil.copy(SEED / "don-hang.json", DH_FILE)
        else:
            DH_FILE.write_text("[]", encoding="utf-8")
    seed_up = SEED / "up"
    if seed_up.is_dir():
        for f in seed_up.iterdir():
            if f.is_file() and not (UP / f.name).exists():
                shutil.copy(f, UP / f.name)

init_data()

def read_json(p):
    return json.loads(p.read_text(encoding="utf-8"))

def write_json(p, obj):
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(p)

# ---------------------------------------------------------------- mật khẩu & phiên
def hash_pw(pw, salt=None, it=PBKDF2_ITER):
    salt = salt or secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, it)
    return {"thuat_toan": "pbkdf2-sha256", "vong": it, "muoi": salt.hex(), "bam": dk.hex()}

def check_pw(pw, rec):
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(rec["muoi"]), int(rec["vong"]))
    return hmac.compare_digest(dk.hex(), rec["bam"])

SESSIONS = {}          # sha256(token) -> hết hạn
FAILS = {}             # khách -> [thời điểm thất bại]

def client_key(req: Request):
    # Lấy IP do proxy nối vào cuối X-Forwarded-For (không tin giá trị do trình duyệt tự gửi)
    xff = [x.strip() for x in req.headers.get("x-forwarded-for", "").split(",") if x.strip()]
    return xff[-1] if xff else (req.client.host if req.client else "?")

async def read_body(req: Request):
    try:
        body = await req.json()
    except Exception:
        raise HTTPException(400, "Dữ liệu không hợp lệ")
    if not isinstance(body, dict):
        raise HTTPException(400, "Dữ liệu không hợp lệ")
    return body

def require_auth(req: Request, agent_only=False):
    auth = read_json(AUTH_FILE)
    key = req.headers.get("x-agent-key")
    if key and auth.get("agent_bam") and hmac.compare_digest(hashlib.sha256(key.encode()).hexdigest(), auth["agent_bam"]):
        return "agent"
    if agent_only:
        raise HTTPException(403, "Chỉ dành cho agent")
    h = req.headers.get("authorization", "")
    if h.startswith("Bearer "):
        th = hashlib.sha256(h[7:].encode()).hexdigest()
        exp = SESSIONS.get(th)
        if exp and exp > time.time():
            return "admin"
        SESSIONS.pop(th, None)
    raise HTTPException(401, "Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại")

# ---------------------------------------------------------------- kiểm tra nội dung
URL_RE = re.compile(r"^(https?://|mailto:)[^\s<>\"']{1,600}$")
IMG_RE = re.compile(r"^(up/[a-f0-9]{16,64}\.webp|[a-z0-9/_.-]{1,120}\.(webp|png|jpg))$")

def s(v, n, field):
    if v is None:
        return ""
    if not isinstance(v, str):
        raise HTTPException(400, f"{field}: phải là chữ")
    v = v.strip()
    if len(v) > n:
        raise HTTPException(400, f"{field}: tối đa {n} ký tự")
    return v

def url(v, field, allow_empty=True):
    v = s(v, 600, field)
    if not v and allow_empty:
        return ""
    if not URL_RE.match(v):
        raise HTTPException(400, f"{field}: đường dẫn phải bắt đầu bằng https://")
    return v

def img(v, field):
    v = s(v, 140, field)
    if v and (".." in v or not IMG_RE.match(v)):
        raise HTTPException(400, f"{field}: ảnh không hợp lệ")
    return v

NHOM = {"hc", "pt", "clb", "tb"}
LOC = {"ht", "nt", "tt", "vh", "cd"}
VB_KEYS = ["heroKicker", "heroLead", "fact1So", "fact1Chu", "fact2So", "fact2Chu", "fact3So", "fact3Chu",
           "bchNhan", "bchMoTa", "bchLink", "clbMoTa", "lienHeTieuDe", "lienHeMoTa", "credits"]

def validate(d):
    if not isinstance(d, dict):
        raise HTTPException(400, "Dữ liệu không hợp lệ")
    lk = d.get("lienKet") or {}
    md = d.get("moDon") or {}
    lh = d.get("lienHe") or {}
    vb = d.get("vanBan") or {}
    out = {
        "lienKet": {"webTruong": url(lk.get("webTruong"), "Website trường"),
                    "traCuuDoanVien": url(lk.get("traCuuDoanVien"), "Tra cứu Đoàn viên")},
        "moDon": {"hien": bool(md.get("hien", True)),
                  "tieuDe": s(md.get("tieuDe"), 160, "Tiêu đề đơn"), "moTa": s(md.get("moTa"), 800, "Mô tả đơn"),
                  "hanChotChu": s(md.get("hanChotChu"), 80, "Hạn chót (chữ)"),
                  "hanChot": s(md.get("hanChot"), 20, "Hạn chót"),
                  "anh": img(md.get("anh"), "Ảnh đơn"),
                  "linkDon": url(md.get("linkDon"), "Link đơn"), "linkMoTa": url(md.get("linkMoTa"), "Link mô tả"),
                  "linkBaiGoc": url(md.get("linkBaiGoc"), "Link bài gốc")},
        "lienHe": {"email": s(lh.get("email"), 120, "Email"), "messenger": url(lh.get("messenger"), "Messenger"),
                   "fanpage": url(lh.get("fanpage"), "Fanpage")},
        "vanBan": {k: (url(vb.get(k), k) if k == "bchLink" else s(vb.get(k), 900, k)) for k in VB_KEYS if k in vb},
        "banTin": [], "clb": [],
    }
    if md.get("hanChot") and not re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$", out["moDon"]["hanChot"]):
        raise HTTPException(400, "Hạn chót phải có dạng 2026-11-24T23:59")
    if out["lienHe"]["email"] and not re.match(r"^[^@\s<>]+@[^@\s<>]+\.[a-z]{2,}$", out["lienHe"]["email"], re.I):
        raise HTTPException(400, "Email không hợp lệ")
    bt = d.get("banTin") or []
    if not isinstance(bt, list) or len(bt) > 2000:
        raise HTTPException(400, "Danh sách bản tin không hợp lệ")
    seen = set()
    for i, n in enumerate(bt):
        f = f"Bài #{i + 1}"
        nhom = n.get("nhom") if n.get("nhom") in NHOM else "tb"
        bid = s(n.get("id"), 40, f + " mã") or secrets.token_hex(6)
        if not re.match(r"^[A-Za-z0-9_-]+$", bid) or bid in seen:
            raise HTTPException(400, f"{f}: mã bài bị trùng hoặc sai")
        seen.add(bid)
        han = s(n.get("han"), 30, f + " hạn")
        if han and not re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\+07:00)?$", han):
            raise HTTPException(400, f"{f}: hạn không hợp lệ")
        tieu = s(n.get("tieuDe"), 160, f + " tiêu đề")
        if not tieu:
            raise HTTPException(400, f"{f}: thiếu tiêu đề")
        out["banTin"].append({
            "id": bid, "nhom": nhom, "nhan": s(n.get("nhan"), 40, f + " nhãn"),
            "ngay": s(n.get("ngay"), 40, f + " ngày"),
            "trangThai": "open" if n.get("trangThai") == "open" else "done",
            **({"han": han} if han else {}),
            "tieuDe": tieu, "moTa": s(n.get("moTa"), 600, f + " mô tả"),
            "anh": img(n.get("anh"), f + " ảnh"), "link": url(n.get("link"), f + " link"),
        })
    cl = d.get("clb") or []
    if not isinstance(cl, list) or len(cl) > 500:
        raise HTTPException(400, "Danh sách CLB không hợp lệ")
    for i, c in enumerate(cl):
        f = f"CLB #{i + 1}"
        ten = s(c.get("ten"), 120, f + " tên")
        if not ten:
            raise HTTPException(400, f"{f}: thiếu tên")
        loc = [x for x in (c.get("loc") or []) if x in LOC] or ["cd"]
        out["clb"].append({"ten": ten, "linhVuc": s(c.get("linhVuc"), 120, f + " lĩnh vực"), "loc": loc,
                           "link": url(c.get("link"), f + " link"), "anh": img(c.get("anh"), f + " ảnh")})
    out["merch"] = validate_merch(d.get("merch") or {})
    return out

def validate_merch(m):
    if not isinstance(m, dict):
        raise HTTPException(400, "Dữ liệu merch không hợp lệ")
    def price(v, field):
        try:
            v = int(v)
        except Exception:
            raise HTTPException(400, f"{field} phải là số")
        if not 0 <= v <= 10_000_000:
            raise HTTPException(400, f"{field} không hợp lệ")
        return v
    han = s(m.get("hanChot"), 20, "Hạn đặt merch")
    if han and not re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$", han):
        raise HTTPException(400, "Hạn đặt merch phải có dạng 2026-12-10T20:00")
    co_so, seen_cs = [], set()
    for i, c in enumerate((m.get("coSo") or [])[:6]):
        f = f"Cơ sở #{i + 1}"
        cid = s(c.get("id"), 30, f + " mã") or secrets.token_hex(3)
        if not re.match(r"^[A-Za-z0-9_-]+$", cid) or cid in seen_cs:
            raise HTTPException(400, f"{f}: mã bị trùng hoặc sai")
        seen_cs.add(cid)
        ten = s(c.get("ten"), 80, f + " tên")
        if ten:
            co_so.append({"id": cid, "ten": ten, "noiNhan": s(c.get("noiNhan"), 160, f + " nơi nhận")})
    if not co_so:
        co_so = [{"id": "an-dong", "ten": "Cơ sở An Đông", "noiNhan": "Văn phòng Đoàn, 153 Nguyễn Chí Thanh, phường An Đông"},
                 {"id": "dong-hoa", "ten": "Cơ sở Đông Hòa", "noiNhan": "Văn phòng Đoàn, Khu đô thị ĐHQG-HCM, phường Đông Hòa"}]
    doi_tuong = [s(x, 40, "Đối tượng") for x in (m.get("doiTuong") or []) if str(x).strip()][:10] or \
        ["Học sinh PTNK", "Cựu học sinh", "Giáo viên, nhân viên", "Phụ huynh", "Khác"]
    try:
        toi_da = max(1, min(30, int(m.get("toiDa", 10))))
    except Exception:
        raise HTTPException(400, "Số món tối đa phải là số")
    sp, seen = [], set()
    def lst(v, n, ln, field):
        return [s(x, ln, field) for x in (v or []) if str(x).strip()][:n]
    for i, p in enumerate((m.get("sanPham") or [])[:40]):
        f = f"Sản phẩm #{i + 1}"
        if not isinstance(p, dict):
            raise HTTPException(400, f"{f} không hợp lệ")
        pid = s(p.get("id"), 40, f + " mã") or secrets.token_hex(4)
        if not re.match(r"^[A-Za-z0-9_-]+$", pid) or pid in seen:
            raise HTTPException(400, f"{f}: mã bị trùng hoặc sai")
        seen.add(pid)
        ten = s(p.get("ten"), 100, f + " tên")
        if not ten:
            raise HTTPException(400, f"{f}: thiếu tên")
        sp.append({"id": pid, "ten": ten, "moTa": s(p.get("moTa"), 400, f + " mô tả"),
                   "anh": img(p.get("anh"), f + " ảnh"), "gia": price(p.get("gia", 0), f + " giá"),
                   "tuyChon": lst(p.get("tuyChon"), 12, 60, f + " tuỳ chọn"), "sizes": lst(p.get("sizes"), 12, 8, f + " size"),
                   "con": p.get("con", True) is not False})
    tt = m.get("thanhToan") or {}
    if not isinstance(tt, dict):
        raise HTTPException(400, "Thông tin thanh toán không hợp lệ")
    thanh_toan = {"anhQR": img(tt.get("anhQR"), "Ảnh QR"), "nganHang": s(tt.get("nganHang"), 80, "Ngân hàng"),
                  "soTK": s(tt.get("soTK"), 30, "Số tài khoản"), "chuTK": s(tt.get("chuTK"), 80, "Chủ tài khoản"),
                  "huongDan": s(tt.get("huongDan"), 400, "Hướng dẫn thanh toán")}
    return {
        "thanhToan": thanh_toan,
        "hien": m.get("hien", True) is not False, "hienTrangChu": m.get("hienTrangChu", True) is not False,
        "moDon": m.get("moDon", True) is not False,
        "tieuDe": s(m.get("tieuDe"), 120, "Tiêu đề merch"), "moTa": s(m.get("moTa"), 900, "Mô tả merch"),
        "ghiChu": s(m.get("ghiChu"), 600, "Ghi chú merch"), "nhanHang": s(m.get("nhanHang"), 300, "Thời gian nhận hàng"),
        "hanChot": han, "hanChotChu": s(m.get("hanChotChu"), 80, "Hạn chót (chữ)"),
        "thongBaoDong": s(m.get("thongBaoDong"), 300, "Thông báo khi chưa mở bán"),
        "sanPham": sp, "linkBaiGoc": url(m.get("linkBaiGoc"), "Link bài gốc merch"),
        "coSo": co_so, "doiTuong": doi_tuong, "toiDa": toi_da,
    }

# ---------------------------------------------------------------- ứng dụng
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

@app.middleware("http")
async def headers(req: Request, call_next):
    if req.method in ("PUT", "POST", "PATCH"):
        cl = req.headers.get("content-length")
        if cl is None or not cl.isdigit():
            return JSONResponse({"detail": "Thiếu độ dài dữ liệu"}, 411)
        if int(cl) > 12_000_000:
            return JSONResponse({"detail": "Dữ liệu quá lớn"}, 413)
    res = await call_next(req)
    res.headers["X-Content-Type-Options"] = "nosniff"
    if req.url.path.startswith("/api/"):
        res.headers["Cache-Control"] = "no-store"
    return res

@app.get("/api/noi-dung")
def get_content():
    return read_json(ND_FILE)

@app.post("/api/dang-nhap")
async def login(req: Request):
    k = client_key(req)
    now = time.time()
    for key in list(FAILS):                     # dọn các mục đã hết hạn
        FAILS[key] = [t for t in FAILS[key] if now - t < 600]
        if not FAILS[key]:
            del FAILS[key]
    if len(FAILS.get(k, [])) >= 5:
        raise HTTPException(429, "Sai mật khẩu quá nhiều lần. Thử lại sau 10 phút.")
    # Nhiều lần sai trên toàn hệ thống: làm chậm thay vì khoá hẳn, để BCH vẫn đăng nhập được
    g = len(FAILS.get("*", []))
    if g >= 40:
        await asyncio.sleep(min(8, g / 20))
    body = await read_body(req)
    pw = str(body.get("matKhau", ""))[:200]
    if not pw or not check_pw(pw, read_json(AUTH_FILE)["mat_khau"]):
        FAILS.setdefault(k, []).append(now)
        FAILS.setdefault("*", []).append(now)
        raise HTTPException(401, "Mật khẩu không đúng")
    FAILS.pop(k, None)
    tok = secrets.token_urlsafe(32)
    SESSIONS[hashlib.sha256(tok.encode()).hexdigest()] = now + TOKEN_TTL
    return {"token": tok, "hetHan": TOKEN_TTL}

@app.post("/api/dang-xuat")
def logout(req: Request):
    h = req.headers.get("authorization", "")
    if h.startswith("Bearer "):
        SESSIONS.pop(hashlib.sha256(h[7:].encode()).hexdigest(), None)
    return {"ok": True}

@app.get("/api/kiem-tra")
def whoami(req: Request):
    return {"vaiTro": require_auth(req)}

@app.put("/api/noi-dung")
async def put_content(req: Request):
    who = require_auth(req)
    data = validate(await read_body(req))
    with LOCK:
        if ND_FILE.exists():
            shutil.copy(ND_FILE, HIST / f"{time.strftime('%Y%m%d-%H%M%S')}-{who}.json")
            for old in sorted(HIST.glob("*.json"))[:-30]:
                old.unlink()
        write_json(ND_FILE, data)
    return {"ok": True, "soBai": len(data["banTin"]), "soClb": len(data["clb"])}

@app.post("/api/anh")
async def upload(req: Request):
    require_auth(req)
    body = await read_body(req)
    raw = str(body.get("data", ""))
    if "," in raw[:80]:
        raw = raw.split(",", 1)[1]
    try:
        blob = base64.b64decode(raw, validate=True)
    except Exception:
        raise HTTPException(400, "Ảnh không đọc được")
    if len(blob) > 8_000_000:
        raise HTTPException(400, "Ảnh tối đa 8 MB")
    loai = body.get("loai")
    maxw = 256 if loai == "clb" else 1000
    try:
        im = Image.open(io.BytesIO(blob))
        if im.format not in ("JPEG", "PNG", "WEBP", "GIF"):
            raise ValueError
        im = ImageOps.exif_transpose(im)
        im = im.convert("RGBA" if im.mode in ("RGBA", "LA", "P") else "RGB")
        if im.width > maxw:
            im = im.resize((maxw, round(im.height * maxw / im.width)), Image.LANCZOS)
        buf = io.BytesIO()
        if loai == "qr":   # mã QR: giữ nét để app ngân hàng quét được
            im.save(buf, "WEBP", lossless=True)
        else:
            im.save(buf, "WEBP", quality=82)
    except Exception:
        raise HTTPException(400, "Chỉ nhận ảnh JPG, PNG, WebP")
    data = buf.getvalue()
    name = hashlib.sha256(data).hexdigest()[:32] + ".webp"
    (UP / name).write_bytes(data)
    return {"anh": "up/" + name, "rong": im.width, "cao": im.height}

@app.get("/up/{name}")
def serve_up(name: str):
    if not re.match(r"^[a-f0-9]{16,64}\.webp$", name) or not (UP / name).is_file():
        raise HTTPException(404)
    return FileResponse(UP / name, media_type="image/webp", headers={"Cache-Control": "public, max-age=31536000, immutable"})

@app.post("/api/doi-mat-khau")
async def change_pw(req: Request):
    if require_auth(req) != "admin":
        raise HTTPException(403, "Agent không được đổi mật khẩu")
    body = await read_body(req)
    cu, moi = str(body.get("cu", "")), str(body.get("moi", ""))
    auth = read_json(AUTH_FILE)
    if not check_pw(cu, auth["mat_khau"]):
        raise HTTPException(400, "Mật khẩu hiện tại không đúng")
    if len(moi) < 10 or len(moi) > 200:
        raise HTTPException(400, "Mật khẩu mới cần ít nhất 10 ký tự")
    auth["mat_khau"] = hash_pw(moi)
    with LOCK:
        write_json(AUTH_FILE, auth)
    SESSIONS.clear()
    return {"ok": True}

# ---------------------------------------------------------------- đơn đặt merch
ORDER_HITS = {}

@app.post("/api/don-hang")
async def tao_don(req: Request):
    body = await read_body(req)
    if str(body.get("web", "")).strip():          # ô bẫy chống spam
        raise HTTPException(400, "Đơn không hợp lệ")
    k, now = client_key(req), time.time()
    for key in list(ORDER_HITS):
        ORDER_HITS[key] = [t for t in ORDER_HITS[key] if now - t < 600]
        if not ORDER_HITS[key]:
            del ORDER_HITS[key]
    if len(ORDER_HITS.get(k, [])) >= 40:  # nhiều HS dùng chung wifi trường (chung IP)
        raise HTTPException(429, "Bạn gửi quá nhiều đơn. Thử lại sau 10 phút.")
    m = read_json(ND_FILE).get("merch") or {}
    if not m or not m.get("hien") or not m.get("moDon"):
        raise HTTPException(400, "Hiện chưa mở đơn đặt áo")
    if m.get("hanChot"):
        from datetime import datetime, timezone, timedelta
        han = datetime.fromisoformat(m["hanChot"]).replace(tzinfo=timezone(timedelta(hours=7)))
        if datetime.now(timezone.utc) > han:
            raise HTTPException(400, "Đơn đặt áo đã đóng")
    ho = s(body.get("hoTen"), 80, "Họ tên")
    lop = s(body.get("lop"), 30, "Lớp")
    mshs = s(body.get("mshs"), 12, "MSHS")
    dt_list = m.get("doiTuong") or ["Học sinh PTNK"]
    doi_tuong = s(body.get("doiTuong"), 40, "Bạn đến từ")
    if doi_tuong not in dt_list:
        raise HTTPException(400, "Vui lòng chọn bạn đến từ đâu")
    la_hs = doi_tuong == dt_list[0]
    if la_hs and (not lop or not re.match(r"^\d{4,8}$", mshs)):
        raise HTTPException(400, "Học sinh vui lòng nhập lớp và mã số học sinh (MSHS)")
    if mshs and not re.match(r"^\d{4,8}$", mshs):
        raise HTTPException(400, "MSHS chỉ gồm chữ số")
    cs = {c["id"]: c for c in (m.get("coSo") or [])}
    co_so = cs.get(body.get("coSo"))
    if not co_so:
        raise HTTPException(400, "Vui lòng chọn cơ sở nhận áo")
    sdt = re.sub(r"[\s.-]", "", s(body.get("sdt"), 20, "Số điện thoại"))
    email = s(body.get("email"), 120, "Email")
    if len(ho) < 2:
        raise HTTPException(400, "Vui lòng nhập họ tên")
    if not re.match(r"^(\+?84|0)\d{9,10}$", sdt):
        raise HTTPException(400, "Số điện thoại không hợp lệ")
    if not email:
        raise HTTPException(400, "Vui lòng nhập email để nhận xác nhận đơn")
    if email and not re.match(r"^[^@\s<>]+@[^@\s<>]+\.[a-z]{2,}$", email, re.I):
        raise HTTPException(400, "Email không hợp lệ")
    sp = {p["id"]: p for p in m.get("sanPham", []) if p.get("con", True)}
    items, n, tong = [], 0, 0
    for it in (body.get("items") or [])[:20]:
        if not isinstance(it, dict):
            continue
        p = sp.get(it.get("sp"))
        try:
            sl = int(it.get("sl", 1))
        except Exception:
            sl = 0
        if not p or not 1 <= sl <= 10:
            raise HTTPException(400, "Vui lòng chọn sản phẩm và số lượng (1–10) cho từng dòng")
        tc = it.get("tuyChon") or ""
        if p["tuyChon"] and tc not in p["tuyChon"]:
            raise HTTPException(400, f"Vui lòng chọn mẫu cho {p['ten']}")
        size = it.get("size") or ""
        if p["sizes"] and size not in p["sizes"]:
            raise HTTPException(400, f"Vui lòng chọn size cho {p['ten']}")
        items.append({"sp": p["id"], "ten": p["ten"], "tuyChon": tc if p["tuyChon"] else "",
                      "size": size if p["sizes"] else "", "sl": sl, "gia": p["gia"]})
        n += sl
        tong += sl * p["gia"]
    toi_da = int(m.get("toiDa") or 10)
    if not items or n > toi_da:
        raise HTTPException(400, f"Mỗi đơn đặt từ 1 đến {toi_da} món")
    don = {"ma": "BCH" + secrets.token_hex(3).upper(), "luc": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now + 7 * 3600)),
           "hoTen": ho, "doiTuong": doi_tuong, "lop": lop, "mshs": mshs, "sdt": sdt, "email": email,
           "coSo": co_so["ten"], "items": items, "soAo": n,
           "tongTien": tong, "ghiChu": s(body.get("ghiChu"), 400, "Ghi chú"), "trangThai": "moi",
           "khoa": secrets.token_urlsafe(18)}
    with LOCK:
        ds = read_json(DH_FILE)
        if len(ds) >= 5000:
            raise HTTPException(503, "Hệ thống đang quá tải đơn, vui lòng liên hệ BCH")
        ds.append(don)
        write_json(DH_FILE, ds)
    ORDER_HITS.setdefault(k, []).append(now)
    return {"ma": don["ma"], "khoa": don["khoa"], "soAo": n, "tongTien": don["tongTien"], "coSo": co_so["ten"], "noiNhan": co_so["noiNhan"]}

DH_STATUS = {"moi", "bao-tt", "da-xac-nhan", "da-thanh-toan", "da-giao", "huy"}
TT_CHU = {"moi": "Chờ chuyển khoản", "bao-tt": "Đã báo chuyển khoản", "da-xac-nhan": "Đã xác nhận",
          "da-thanh-toan": "Đã nhận tiền", "da-giao": "Đã giao", "huy": "Huỷ"}

# ---------------------------------------------------------------- Google Sheet (qua Apps Script)
def _cell(v):
    v = "" if v is None else str(v)
    return "'" + v if v[:1] in ("=", "+", "-", "@") else v   # chặn chèn công thức vào Sheet

def sheet_row(d):
    chi_tiet = "; ".join(" · ".join(x for x in (it["ten"], it.get("tuyChon"), it.get("size") and "size " + it["size"]) if x) + f" × {it['sl']}"
                         for it in d["items"])
    return {k: _cell(v) for k, v in {
        "ma": d["ma"], "luc": d["luc"].replace("T", " "), "baoTT": (d.get("baoTT") or "").replace("T", " "),
        "hoTen": d["hoTen"], "doiTuong": d.get("doiTuong"), "lop": d.get("lop"), "mshs": d.get("mshs"),
        "sdt": d["sdt"], "email": d.get("email"), "coSo": d.get("coSo"), "chiTiet": chi_tiet,
        "soMon": d["soAo"], "tongTien": d["tongTien"], "ghiChu": d.get("ghiChu"),
        "trangThai": TT_CHU.get(d["trangThai"], d["trangThai"])}.items()}

def sheet_cfg():
    return (read_json(AUTH_FILE).get("sheet") or {})

def push_sheet(rows, cfg=None):
    """Gửi danh sách đơn lên Apps Script. Trả (ok, thông báo)."""
    cfg = cfg or sheet_cfg()
    if not cfg.get("url"):
        return False, "Chưa cấu hình Google Sheet"
    data = json.dumps({"khoa": cfg.get("khoa", ""), "don": rows}, ensure_ascii=False).encode()
    rq = urllib.request.Request(cfg["url"], data=data, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(rq, timeout=25) as r:
            out = json.loads(r.read().decode("utf-8", "replace") or "{}")
    except Exception as e:
        return False, f"Không gửi được lên Sheet: {type(e).__name__}"
    if not out.get("ok"):
        return False, "Sheet từ chối: " + str(out.get("loi") or "không rõ lý do")[:120]
    return True, f"Đã ghi {out.get('so', len(rows))} đơn lên Sheet"

def sync_orders(mas):
    """Ghi các đơn (theo mã) lên Sheet và đánh dấu kết quả trên từng đơn."""
    ds = read_json(DH_FILE)
    rows = [sheet_row(d) for d in ds if d["ma"] in mas]
    if not rows:
        return False, "Không có đơn để gửi"
    ok, msg = push_sheet(rows)
    with LOCK:
        ds = read_json(DH_FILE)
        for d in ds:
            if d["ma"] in mas:
                d["sheet"] = "ok" if ok else msg
        write_json(DH_FILE, ds)
    return ok, msg

def sync_bg(mas):
    if sheet_cfg().get("url"):
        threading.Thread(target=sync_orders, args=(set(mas),), daemon=True).start()

CONFIRM_HITS = {}

@app.post("/api/don-hang/{ma}/da-thanh-toan")
async def bao_thanh_toan(ma: str, req: Request):
    body = await read_body(req)
    k, now = client_key(req), time.time()
    CONFIRM_HITS[k] = [t for t in CONFIRM_HITS.get(k, []) if now - t < 600]
    if len(CONFIRM_HITS[k]) >= 60:
        raise HTTPException(429, "Thao tác quá nhiều lần, thử lại sau 10 phút")
    CONFIRM_HITS[k].append(now)
    khoa = s(body.get("khoa"), 60, "Khoá đơn")
    with LOCK:
        ds = read_json(DH_FILE)
        d = next((x for x in ds if x["ma"] == ma), None)
        if not d or not khoa or not hmac.compare_digest(d.get("khoa", ""), khoa):
            raise HTTPException(404, "Không tìm thấy đơn")
        if d["trangThai"] == "huy":
            raise HTTPException(400, "Đơn này đã bị huỷ, vui lòng liên hệ Ban Chấp hành")
        if d["trangThai"] == "moi":
            d["trangThai"] = "bao-tt"
            d["baoTT"] = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now + 7 * 3600))
            write_json(DH_FILE, ds)
    sync_bg([ma])
    return {"ok": True, "ma": ma, "trangThai": d["trangThai"]}

@app.get("/api/sheet")
def xem_sheet(req: Request):
    require_auth(req)
    c = sheet_cfg()
    return {"url": c.get("url", ""), "coKhoa": bool(c.get("khoa"))}

@app.put("/api/sheet")
async def luu_sheet(req: Request):
    require_auth(req)
    body = await read_body(req)
    u = s(body.get("url"), 300, "Link Apps Script")
    if u and not re.match(r"^https://script\.google\.com/(a/macros/[a-z0-9.-]+|macros)/s/[A-Za-z0-9_-]{20,}/exec$", u):
        raise HTTPException(400, "Link phải có dạng https://script.google.com/macros/s/.../exec")
    with LOCK:
        auth = read_json(AUTH_FILE)
        cur = auth.get("sheet") or {}
        cur["url"] = u
        k2 = s(body.get("khoa"), 100, "Khoá Sheet")
        if k2:
            cur["khoa"] = k2
        if not cur.get("khoa"):
            cur["khoa"] = secrets.token_urlsafe(18)
        auth["sheet"] = cur
        write_json(AUTH_FILE, auth)
    return {"ok": True}

@app.get("/api/sheet/khoa")
def khoa_sheet(req: Request):
    require_auth(req)
    return {"khoa": sheet_cfg().get("khoa", "")}

@app.post("/api/sheet/dong-bo")
async def dong_bo_sheet(req: Request):
    require_auth(req)
    ds = read_json(DH_FILE)
    mas = {d["ma"] for d in ds if d["trangThai"] != "moi"}
    ok, msg = await asyncio.to_thread(sync_orders, mas)
    if not ok:
        raise HTTPException(400, msg)
    return {"ok": True, "thongBao": msg}

@app.get("/api/don-hang")
def ds_don(req: Request):
    require_auth(req)
    return read_json(DH_FILE)

@app.patch("/api/don-hang/{ma}")
async def sua_don(ma: str, req: Request):
    require_auth(req)
    body = await read_body(req)
    st = body.get("trangThai")
    if st not in DH_STATUS:
        raise HTTPException(400, "Trạng thái không hợp lệ")
    with LOCK:
        ds = read_json(DH_FILE)
        for d in ds:
            if d["ma"] == ma:
                d["trangThai"] = st
                write_json(DH_FILE, ds)
                if st != "moi":
                    sync_bg([ma])
                return {"ok": True}
    raise HTTPException(404, "Không tìm thấy đơn")

@app.delete("/api/don-hang/{ma}")
def xoa_don(ma: str, req: Request):
    require_auth(req)
    with LOCK:
        ds = read_json(DH_FILE)
        moi = [d for d in ds if d["ma"] != ma]
        if len(moi) == len(ds):
            raise HTTPException(404, "Không tìm thấy đơn")
        write_json(DH_FILE, moi)
    return {"ok": True}

@app.get("/api/sao-luu")
def backup(req: Request):
    require_auth(req, agent_only=True)
    auth = read_json(AUTH_FILE)
    return {"noiDung": read_json(ND_FILE), "quanTri": {"mat_khau": auth["mat_khau"], "agent_bam": auth.get("agent_bam"), "sheet": auth.get("sheet") or {}},
            "anh": sorted(f.name for f in UP.glob("*.webp")), "donHang": read_json(DH_FILE)}

# Chế độ phát triển: phục vụ luôn thư mục public để chạy thử trên cùng một cổng
if os.environ.get("DEV_STATIC"):
    from fastapi.staticfiles import StaticFiles
    app.mount("/", StaticFiles(directory=HERE.parent / "public", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8000)), log_level="warning")
