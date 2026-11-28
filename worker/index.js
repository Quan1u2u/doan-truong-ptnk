// Worker API cho website Đoàn trường PTNK (thay server/app.py).
// Lưu trữ: D1 (nội dung, đơn, phiên, bộ đếm chống spam, bộ nhớ đệm ảnh) và Google Drive của BCH (ảnh, bản sao lưu)
// qua Google Apps Script (apps-script/don-merch.gs). Apps Script cũng ghi đơn vào Google Sheet và gửi email xác nhận qua Gmail.
//
//   GET  /api/noi-dung            nội dung công khai
//   PUT  /api/noi-dung            lưu nội dung (cần đăng nhập)
//   POST /api/dang-nhap | /api/dang-xuat | GET /api/kiem-tra | POST /api/doi-mat-khau
//   POST /api/anh                 tải ảnh (base64), lưu trong D1
//   GET  /up/<ten>.webp           ảnh đã tải lên
//   POST /api/don-hang            tạo đơn merch (công khai)
//   POST /api/don-hang/<ma>/da-thanh-toan
//   GET  /api/don-hang, PATCH|DELETE /api/don-hang/<ma>
//   GET|PUT /api/sheet, GET /api/sheet/khoa, POST /api/sheet/dong-bo
//   GET  /api/sao-luu             (chỉ agent key)
//
// Không cần R2. Biến bí mật (wrangler secret put): ADMIN_PASSWORD (chỉ dùng lần đầu), AGENT_KEY.
import SEED from "../server/seed/noi-dung.json";

const PBKDF2_ITER = 100000;          // Cloudflare Workers chỉ cho tối đa 100.000 vòng
const TOKEN_TTL = 8 * 3600;
const MAX_IMG = 5_000_000;           // ảnh tối đa 5 MB (ảnh từ trang quản trị đã được thu nhỏ trước khi gửi)
const MAIL_KHI = ["da-xac-nhan", "da-thanh-toan"];   // trạng thái đơn kích hoạt email xác nhận
const WIN = 600;                     // cửa sổ đếm chống spam: 10 phút
const enc = new TextEncoder();

class HttpError extends Error {
  constructor(status, detail) { super(detail); this.status = status; this.detail = detail; }
}
const bad = d => new HttpError(400, d);

/* ------------------------------------------------------------ tiện ích */
const now = () => Math.floor(Date.now() / 1000);
const vnNow = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 19);
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const unhex = h => Uint8Array.from(h.match(/../g) || [], x => parseInt(x, 16));
const rndHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const rndUrl = n => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sha256 = async data => hex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data));
const safeEq = (a, b) => { a = String(a); b = String(b); if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };
const isObj = x => x !== null && typeof x === "object" && !Array.isArray(x);
const obj = x => (isObj(x) ? x : {});
const len = v => Array.from(v).length;

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", ...extra } });

async function hashPw(pw, saltHex, iter = PBKDF2_ITER) {
  const salt = saltHex ? unhex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256);
  return { thuat_toan: "pbkdf2-sha256", vong: iter, muoi: hex(salt), bam: hex(bits) };
}
async function checkPw(pw, rec) {
  if (!rec || !rec.muoi || !rec.bam) return false;
  const h = await hashPw(pw, rec.muoi, Number(rec.vong) || PBKDF2_ITER);
  return safeEq(h.bam, rec.bam);
}

/* ------------------------------------------------------------ dữ liệu (D1) */
async function kvGet(env, k) {
  const r = await env.DB.prepare("SELECT v FROM kv WHERE k = ?").bind(k).first();
  return r ? r.v : null;
}
const kvSet = (env, k, v) =>
  env.DB.prepare("INSERT INTO kv(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(k, v).run();

async function getContentText(env) {
  let v = await kvGet(env, "noi-dung");
  if (v === null) {
    v = JSON.stringify(SEED);
    await env.DB.prepare("INSERT OR IGNORE INTO kv(k, v) VALUES('noi-dung', ?)").bind(v).run();
    v = (await kvGet(env, "noi-dung")) ?? v;
  }
  return v;
}
async function getAuth(env) {
  const v = await kvGet(env, "auth");
  if (v) return JSON.parse(v);
  if (!env.ADMIN_PASSWORD) throw new HttpError(503, "Chưa cấu hình mật khẩu quản trị (ADMIN_PASSWORD)");
  const a = { mat_khau: await hashPw(String(env.ADMIN_PASSWORD)) };
  await env.DB.prepare("INSERT OR IGNORE INTO kv(k, v) VALUES('auth', ?)").bind(JSON.stringify(a)).run();
  return JSON.parse((await kvGet(env, "auth")) ?? JSON.stringify(a));
}
async function sheetCfg(env) {
  const v = await kvGet(env, "sheet");
  return v ? JSON.parse(v) : {};
}
const parseOrders = rows => rows.results.map(r => JSON.parse(r.data));
const allOrders = async env => parseOrders(await env.DB.prepare("SELECT data FROM orders ORDER BY rowid").all());
async function getOrder(env, ma) {
  const r = await env.DB.prepare("SELECT data FROM orders WHERE ma = ?").bind(ma).first();
  return r ? JSON.parse(r.data) : null;
}

/* ------------------------------------------------------------ chống spam (đếm trong D1) */
const clientKey = req => req.headers.get("cf-connecting-ip") || "?";
async function hitCount(env, k) {
  const r = await env.DB.prepare("SELECT COUNT(*) AS c FROM hits WHERE k = ? AND t > ?").bind(k, now() - WIN).first();
  return r ? r.c : 0;
}
const hitAdd = (env, k) => env.DB.prepare("INSERT INTO hits(k, t) VALUES(?, ?)").bind(k, now()).run();
const hitClear = (env, k) => env.DB.prepare("DELETE FROM hits WHERE k = ?").bind(k).run();
const hitSweep = env => env.DB.prepare("DELETE FROM hits WHERE t < ?").bind(now() - WIN).run();

/* ------------------------------------------------------------ đăng nhập & phiên */
async function requireAuth(req, env, agentOnly = false) {
  const key = req.headers.get("x-agent-key");
  if (key && env.AGENT_KEY && safeEq(await sha256(key), await sha256(String(env.AGENT_KEY)))) return "agent";
  if (agentOnly) throw new HttpError(403, "Chỉ dành cho agent");
  const h = req.headers.get("authorization") || "";
  if (h.startsWith("Bearer ")) {
    const th = await sha256(h.slice(7));
    const row = await env.DB.prepare("SELECT exp FROM sessions WHERE h = ?").bind(th).first();
    if (row && row.exp > now()) return "admin";
    if (row) await env.DB.prepare("DELETE FROM sessions WHERE h = ?").bind(th).run();
  }
  throw new HttpError(401, "Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại");
}

async function readBody(req) {
  const cl = Number(req.headers.get("content-length") || 0);
  if (cl > 12_000_000) throw new HttpError(413, "Dữ liệu quá lớn");
  let t;
  try { t = await req.text(); } catch { throw bad("Dữ liệu không hợp lệ"); }
  if (t.length > 12_000_000) throw new HttpError(413, "Dữ liệu quá lớn");
  let b;
  try { b = JSON.parse(t); } catch { throw bad("Dữ liệu không hợp lệ"); }
  if (!isObj(b)) throw bad("Dữ liệu không hợp lệ");
  return b;
}

/* ------------------------------------------------------------ kiểm tra nội dung */
const URL_RE = /^(https?:\/\/|mailto:)[^\s<>"']{1,600}$/;
const IMG_RE = /^(up\/[a-f0-9]{16,64}\.webp|[a-z0-9/_.-]{1,120}\.(webp|png|jpg))$/;
const EMAIL_RE = /^[^@\s<>]+@[^@\s<>]+\.[a-z]{2,}$/i;
const ID_RE = /^[A-Za-z0-9_-]+$/;
const NHOM = ["hc", "pt", "clb", "tb"];
const LOC = ["ht", "nt", "tt", "vh", "cd"];
const VB_KEYS = ["heroKicker", "heroLead", "fact1So", "fact1Chu", "fact2So", "fact2Chu", "fact3So", "fact3Chu",
  "bchNhan", "bchMoTa", "bchLink", "clbMoTa", "lienHeTieuDe", "lienHeMoTa", "credits"];

function str(v, n, field) {
  if (v === null || v === undefined) return "";
  if (typeof v !== "string") throw bad(`${field}: phải là chữ`);
  v = v.trim();
  if (len(v) > n) throw bad(`${field}: tối đa ${n} ký tự`);
  return v;
}
function url(v, field, allowEmpty = true) {
  v = str(v, 600, field);
  if (!v && allowEmpty) return "";
  if (!URL_RE.test(v)) throw bad(`${field}: đường dẫn phải bắt đầu bằng https://`);
  return v;
}
function img(v, field) {
  v = str(v, 140, field);
  if (v && (v.includes("..") || !IMG_RE.test(v))) throw bad(`${field}: ảnh không hợp lệ`);
  return v;
}
function list(v, field, max) {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v) || v.length > max) throw bad(`${field} không hợp lệ`);
  return v;
}

function validate(d) {
  if (!isObj(d)) throw bad("Dữ liệu không hợp lệ");
  if (!Array.isArray(d.banTin) || !Array.isArray(d.clb)) throw bad("Thiếu danh sách bản tin hoặc CLB, từ chối ghi đè");
  const lk = obj(d.lienKet), md = obj(d.moDon), lh = obj(d.lienHe), vb = obj(d.vanBan);
  const out = {
    lienKet: { webTruong: url(lk.webTruong, "Website trường"), traCuuDoanVien: url(lk.traCuuDoanVien, "Tra cứu Đoàn viên") },
    moDon: {
      hien: md.hien !== false,
      tieuDe: str(md.tieuDe, 160, "Tiêu đề đơn"), moTa: str(md.moTa, 800, "Mô tả đơn"),
      hanChotChu: str(md.hanChotChu, 80, "Hạn chót (chữ)"), hanChot: str(md.hanChot, 20, "Hạn chót"),
      anh: img(md.anh, "Ảnh đơn"),
      linkDon: url(md.linkDon, "Link đơn"), linkMoTa: url(md.linkMoTa, "Link mô tả"), linkBaiGoc: url(md.linkBaiGoc, "Link bài gốc"),
    },
    lienHe: { email: str(lh.email, 120, "Email"), messenger: url(lh.messenger, "Messenger"), fanpage: url(lh.fanpage, "Fanpage") },
    vanBan: {},
    banTin: [], clb: [],
  };
  for (const k of VB_KEYS) if (k in vb) out.vanBan[k] = k === "bchLink" ? url(vb[k], k) : str(vb[k], 900, k);
  if (out.moDon.hanChot && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(out.moDon.hanChot)) throw bad("Hạn chót phải có dạng 2026-11-24T23:59");
  if (out.lienHe.email && !EMAIL_RE.test(out.lienHe.email)) throw bad("Email không hợp lệ");

  const bt = list(d.banTin, "Danh sách bản tin", 2000), seen = new Set();
  bt.forEach((n, i) => {
    const f = `Bài #${i + 1}`;
    if (!isObj(n)) throw bad(`${f} không hợp lệ`);
    const nhom = NHOM.includes(n.nhom) ? n.nhom : "tb";
    const bid = str(n.id, 40, f + " mã") || rndHex(6);
    if (!ID_RE.test(bid) || seen.has(bid)) throw bad(`${f}: mã bài bị trùng hoặc sai`);
    seen.add(bid);
    const han = str(n.han, 30, f + " hạn");
    if (han && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\+07:00)?$/.test(han)) throw bad(`${f}: hạn không hợp lệ`);
    const tieu = str(n.tieuDe, 160, f + " tiêu đề");
    if (!tieu) throw bad(`${f}: thiếu tiêu đề`);
    out.banTin.push({
      id: bid, nhom, nhan: str(n.nhan, 40, f + " nhãn"), ngay: str(n.ngay, 40, f + " ngày"),
      trangThai: n.trangThai === "open" ? "open" : "done",
      ...(han ? { han } : {}),
      tieuDe: tieu, moTa: str(n.moTa, 600, f + " mô tả"), anh: img(n.anh, f + " ảnh"), link: url(n.link, f + " link"),
    });
  });

  list(d.clb, "Danh sách CLB", 500).forEach((c, i) => {
    const f = `CLB #${i + 1}`;
    if (!isObj(c)) throw bad(`${f} không hợp lệ`);
    const ten = str(c.ten, 120, f + " tên");
    if (!ten) throw bad(`${f}: thiếu tên`);
    const loc = (Array.isArray(c.loc) ? c.loc : []).filter(x => LOC.includes(x));
    out.clb.push({ ten, linhVuc: str(c.linhVuc, 120, f + " lĩnh vực"), loc: loc.length ? loc : ["cd"],
      link: url(c.link, f + " link"), anh: img(c.anh, f + " ảnh") });
  });
  out.merch = validateMerch(d.merch === undefined || d.merch === null ? {} : d.merch);
  return out;
}

function validateMerch(m) {
  if (!isObj(m)) throw bad("Dữ liệu merch không hợp lệ");
  const price = (v, field) => {
    const n = Math.trunc(Number(v));
    if (!Number.isFinite(n)) throw bad(`${field} phải là số`);
    if (n < 0 || n > 10_000_000) throw bad(`${field} không hợp lệ`);
    return n;
  };
  const han = str(m.hanChot, 20, "Hạn đặt merch");
  if (han && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(han)) throw bad("Hạn đặt merch phải có dạng 2026-12-10T20:00");
  let coSo = [];
  const seenCs = new Set();
  (Array.isArray(m.coSo) ? m.coSo : []).slice(0, 6).forEach((c, i) => {
    const f = `Cơ sở #${i + 1}`;
    if (!isObj(c)) throw bad(`${f} không hợp lệ`);
    const cid = str(c.id, 30, f + " mã") || rndHex(3);
    if (!ID_RE.test(cid) || seenCs.has(cid)) throw bad(`${f}: mã bị trùng hoặc sai`);
    seenCs.add(cid);
    const ten = str(c.ten, 80, f + " tên");
    if (ten) coSo.push({ id: cid, ten, noiNhan: str(c.noiNhan, 160, f + " nơi nhận") });
  });
  if (!coSo.length) coSo = [
    { id: "an-dong", ten: "Cơ sở An Đông", noiNhan: "Văn phòng Đoàn, 153 Nguyễn Chí Thanh, phường An Đông" },
    { id: "dong-hoa", ten: "Cơ sở Đông Hòa", noiNhan: "Văn phòng Đoàn, Khu đô thị ĐHQG-HCM, phường Đông Hòa" }];
  let doiTuong = (Array.isArray(m.doiTuong) ? m.doiTuong : []).filter(x => String(x).trim()).slice(0, 10).map(x => str(x, 40, "Đối tượng"));
  if (!doiTuong.length) doiTuong = ["Học sinh PTNK", "Cựu học sinh", "Giáo viên, nhân viên", "Phụ huynh", "Khác"];
  const toiDaRaw = m.toiDa === undefined || m.toiDa === null ? 10 : Math.trunc(Number(m.toiDa));
  if (!Number.isFinite(toiDaRaw)) throw bad("Số món tối đa phải là số");
  const toiDa = Math.max(1, Math.min(30, toiDaRaw));
  const lst = (v, n, ln, field) => (Array.isArray(v) ? v : []).filter(x => String(x).trim()).slice(0, n).map(x => str(x, ln, field));
  const sp = [], seen = new Set();
  (Array.isArray(m.sanPham) ? m.sanPham : []).slice(0, 40).forEach((p, i) => {
    const f = `Sản phẩm #${i + 1}`;
    if (!isObj(p)) throw bad(`${f} không hợp lệ`);
    const pid = str(p.id, 40, f + " mã") || rndHex(4);
    if (!ID_RE.test(pid) || seen.has(pid)) throw bad(`${f}: mã bị trùng hoặc sai`);
    seen.add(pid);
    const ten = str(p.ten, 100, f + " tên");
    if (!ten) throw bad(`${f}: thiếu tên`);
    sp.push({ id: pid, ten, moTa: str(p.moTa, 400, f + " mô tả"), anh: img(p.anh, f + " ảnh"), gia: price(p.gia ?? 0, f + " giá"),
      tuyChon: lst(p.tuyChon, 12, 60, f + " tuỳ chọn"), sizes: lst(p.sizes, 12, 8, f + " size"), con: p.con !== false });
  });
  const tt = m.thanhToan === undefined || m.thanhToan === null ? {} : m.thanhToan;
  if (!isObj(tt)) throw bad("Thông tin thanh toán không hợp lệ");
  return {
    thanhToan: { anhQR: img(tt.anhQR, "Ảnh QR"), nganHang: str(tt.nganHang, 80, "Ngân hàng"), soTK: str(tt.soTK, 30, "Số tài khoản"),
      chuTK: str(tt.chuTK, 80, "Chủ tài khoản"), huongDan: str(tt.huongDan, 400, "Hướng dẫn thanh toán") },
    hien: m.hien !== false, hienTrangChu: m.hienTrangChu !== false, moDon: m.moDon !== false,
    tieuDe: str(m.tieuDe, 120, "Tiêu đề merch"), moTa: str(m.moTa, 900, "Mô tả merch"), ghiChu: str(m.ghiChu, 600, "Ghi chú merch"),
    nhanHang: str(m.nhanHang, 300, "Thời gian nhận hàng"), hanChot: han, hanChotChu: str(m.hanChotChu, 80, "Hạn chót (chữ)"),
    thongBaoDong: str(m.thongBaoDong, 300, "Thông báo khi chưa mở bán"),
    sanPham: sp, linkBaiGoc: url(m.linkBaiGoc, "Link bài gốc merch"), coSo, doiTuong, toiDa,
  };
}

/* ------------------------------------------------------------ Google Sheet (Apps Script) */
const TT_CHU = { moi: "Chờ chuyển khoản", "bao-tt": "Đã báo chuyển khoản", "da-xac-nhan": "Đã xác nhận",
  "da-thanh-toan": "Đã nhận tiền", "da-giao": "Đã giao", huy: "Huỷ" };
const DH_STATUS = Object.keys(TT_CHU);

// Chặn chèn công thức vào Sheet; số điện thoại (kể cả +84...) giữ nguyên
const cell = v => {
  v = v === null || v === undefined ? "" : String(v);
  return /^[=+\-@]/.test(v) && !/^\+?\d[\d\s.-]*$/.test(v) ? "'" + v : v;
};
function sheetRow(d) {
  const chiTiet = d.items.map(it => [it.ten, it.tuyChon, it.size && "size " + it.size].filter(Boolean).join(" · ") + ` × ${it.sl}`).join("; ");
  const r = { ma: d.ma, luc: d.luc.replace("T", " "), baoTT: (d.baoTT || "").replace("T", " "), hoTen: d.hoTen, doiTuong: d.doiTuong,
    lop: d.lop, mshs: d.mshs, sdt: d.sdt, email: d.email, coSo: d.coSo, chiTiet, soMon: d.soAo, tongTien: d.tongTien, ghiChu: d.ghiChu,
    trangThai: TT_CHU[d.trangThai] || d.trangThai };
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, cell(v)]));
}
// Gọi Google Apps Script (cùng một địa chỉ /exec cho Sheet, Drive và Gmail). Trả [ok, thông báo, dữ liệu]
async function gas(env, payload) {
  const cfg = await sheetCfg(env);
  if (!cfg.url) return [false, "Chưa cấu hình Google Apps Script", null];
  let out;
  try {
    const r = await fetch(cfg.url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ khoa: cfg.khoa || "", ...payload }), redirect: "follow", signal: AbortSignal.timeout(25000) });
    out = JSON.parse((await r.text()) || "{}");
  } catch (e) { return [false, `Không kết nối được Google: ${e.name}`, null]; }
  if (!out.ok) return [false, "Google từ chối: " + String(out.loi || "không rõ lý do").slice(0, 120), null];
  return [true, "ok", out];
}
// Lấy ID Google Sheet từ link (…/spreadsheets/d/<ID>/edit) hoặc từ chính ID. Trả "" nếu để trống, null nếu sai.
const SHEET_ID_RE = /^[A-Za-z0-9_-]{20,}$/;
function parseSheetId(v) {
  v = String(v ?? "").trim();
  if (!v) return "";
  const m = v.match(/^https:\/\/docs\.google\.com\/spreadsheets\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{20,})(?:[/?#]|$)/);
  if (m) return m[1];
  return SHEET_ID_RE.test(v) ? v : null;
}
const sheetLink = id => (id ? `https://docs.google.com/spreadsheets/d/${id}/edit` : "");
async function pushSheet(env, rows) {
  const cfg = await sheetCfg(env);
  const [ok, msg, out] = await gas(env, { hanh: "don", don: rows, ...(cfg.sheetId ? { sheetId: cfg.sheetId } : {}) });
  return ok ? [true, `Đã ghi ${out.so ?? rows.length} đơn lên Sheet`] : [false, msg];
}

/* ----- email xác nhận (gửi bằng Gmail của BCH qua Apps Script) ----- */
const escHtml = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const vnd = n => Number(n || 0).toLocaleString("vi-VN") + "đ";
async function soanMail(env, d) {
  const nd = JSON.parse(await getContentText(env));
  const m = obj(nd.merch), lh = obj(nd.lienHe);
  const cs = (m.coSo || []).find(c => c.ten === d.coSo);
  const dong = d.items.map(it => `${[it.ten, it.tuyChon, it.size && "size " + it.size].filter(Boolean).join(" · ")} × ${it.sl}`);
  const nhan = m.nhanHang || "Ban Chấp hành sẽ thông báo lịch nhận hàng qua email và fanpage";
  const text = [`Chào ${d.hoTen},`, "",
    `Ban Chấp hành Đoàn trường PTNK đã xác nhận đơn merch ${d.ma} của bạn.`, "",
    "Chi tiết đơn:", ...dong.map(x => "- " + x), `Tổng tiền: ${vnd(d.tongTien)}`, "",
    `Nơi nhận: ${d.coSo}${cs?.noiNhan ? " (" + cs.noiNhan + ")" : ""}`, `Thời gian nhận hàng: ${nhan}`, "",
    "Khi nhận hàng, vui lòng mang theo mã đơn và thẻ học sinh hoặc giấy tờ tùy thân.", "",
    lh.email ? `Cần hỗ trợ, liên hệ ${lh.email} hoặc nhắn fanpage Đoàn trường.` : "Cần hỗ trợ, nhắn fanpage Đoàn trường.", "",
    "Ban Chấp hành Đoàn trường Phổ thông Năng khiếu", "",
    "Đây là email tự động từ website của Đoàn trường, vui lòng không trả lời trực tiếp thư này."].join("\n");
  const html = `<div style="font-family:Arial,sans-serif;line-height:1.5;color:#1b2a41;max-width:560px">
<p>Chào ${escHtml(d.hoTen)},</p>
<p>Ban Chấp hành Đoàn trường PTNK đã <b>xác nhận đơn merch ${escHtml(d.ma)}</b> của bạn.</p>
<p><b>Chi tiết đơn</b></p><ul>${dong.map(x => `<li>${escHtml(x)}</li>`).join("")}</ul>
<p>Tổng tiền: <b>${escHtml(vnd(d.tongTien))}</b></p>
<p><b>Nơi nhận:</b> ${escHtml(d.coSo)}${cs?.noiNhan ? "<br>" + escHtml(cs.noiNhan) : ""}<br><b>Thời gian nhận hàng:</b> ${escHtml(nhan)}</p>
<p>Khi nhận hàng, vui lòng mang theo mã đơn và thẻ học sinh hoặc giấy tờ tùy thân.</p>
<p>${lh.email ? `Cần hỗ trợ, liên hệ ${escHtml(lh.email)} hoặc nhắn fanpage Đoàn trường.` : "Cần hỗ trợ, nhắn fanpage Đoàn trường."}</p>
<p>Ban Chấp hành Đoàn trường Phổ thông Năng khiếu</p>
<p style="margin-top:20px;padding-top:12px;border-top:1px solid #d9e2f3;font-size:12px;color:#6b7a99">Đây là email tự động từ website của Đoàn trường, vui lòng không trả lời trực tiếp thư này.</p></div>`;
  return { hanh: "gui-mail", den: d.email, tieuDe: `[Đoàn trường PTNK] Xác nhận đơn merch ${d.ma}`, noiDung: text, html, traLoi: lh.email || "" };
}
// force = true: gửi lại dù đã gửi. Mặc định chỉ gửi một lần cho mỗi đơn.
async function guiMailXacNhan(env, ma, force = false) {
  const d = await getOrder(env, ma);
  if (!d || !d.email || d.trangThai === "huy") return [false, "Đơn không hợp lệ hoặc đã huỷ"];
  if (!force) {
    const r = await env.DB.prepare("UPDATE orders SET data = json_set(data, '$.emailXN', 'dang-gui') WHERE ma = ? AND (json_extract(data, '$.emailXN') IS NULL OR json_extract(data, '$.emailXN') LIKE 'loi%')").bind(ma).run();
    if (!r.meta.changes) return [false, "Đã gửi email cho đơn này rồi"];
  }
  const [ok, msg] = await gas(env, await soanMail(env, d));
  const kq = ok ? vnNow() : "loi: " + msg;
  await env.DB.prepare("UPDATE orders SET data = json_set(data, '$.emailXN', ?) WHERE ma = ?").bind(kq, ma).run();
  return [ok, ok ? "Đã gửi email xác nhận" : msg];
}

/* ----- sao lưu lên Google Drive ----- */
async function saoLuuDrive(env) {
  return gas(env, { hanh: "sao-luu", noiDung: JSON.parse(await getContentText(env)), donHang: await allOrders(env) });
}

async function syncOrders(env, mas) {
  const rows = (await allOrders(env)).filter(d => mas.has(d.ma));
  if (!rows.length) return [false, "Không có đơn để gửi"];
  const [ok, msg] = await pushSheet(env, rows.map(sheetRow));
  await env.DB.batch(rows.map(d => env.DB.prepare("UPDATE orders SET data = json_set(data, '$.sheet', ?) WHERE ma = ?").bind(ok ? "ok" : msg, d.ma)));
  return [ok, msg];
}
async function syncBg(env, ctx, mas) {
  if ((await sheetCfg(env)).url) ctx.waitUntil(syncOrders(env, new Set(mas)).catch(e => console.error("sheet", e)));
}

/* ------------------------------------------------------------ API */
async function api(req, env, ctx, p) {
  const m = req.method;
  let mt;

  if (p === "/api/noi-dung" && m === "GET") {
    return new Response(await getContentText(env), { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  }

  if (p === "/api/dang-nhap" && m === "POST") {
    const k = "login:" + clientKey(req);
    await hitSweep(env);
    if ((await hitCount(env, k)) >= 5) throw new HttpError(429, "Sai mật khẩu quá nhiều lần. Thử lại sau 10 phút.");
    const g = await hitCount(env, "login:*");
    if (g >= 40) await new Promise(r => setTimeout(r, Math.min(8000, (g / 20) * 1000)));
    const body = await readBody(req);
    const pw = String(body.matKhau ?? "").slice(0, 200);
    const auth = await getAuth(env);
    if (!pw || !(await checkPw(pw, auth.mat_khau))) {
      await hitAdd(env, k); await hitAdd(env, "login:*");
      throw new HttpError(401, "Mật khẩu không đúng");
    }
    await hitClear(env, k);
    const tok = rndUrl(32);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE exp < ?").bind(now()),
      env.DB.prepare("INSERT INTO sessions(h, exp) VALUES(?, ?)").bind(await sha256(tok), now() + TOKEN_TTL),
    ]);
    return json({ token: tok, hetHan: TOKEN_TTL });
  }

  if (p === "/api/dang-xuat" && m === "POST") {
    const h = req.headers.get("authorization") || "";
    if (h.startsWith("Bearer ")) await env.DB.prepare("DELETE FROM sessions WHERE h = ?").bind(await sha256(h.slice(7))).run();
    return json({ ok: true });
  }

  if (p === "/api/kiem-tra" && m === "GET") return json({ vaiTro: await requireAuth(req, env) });

  if (p === "/api/noi-dung" && m === "PUT") {
    const who = await requireAuth(req, env);
    const data = validate(await readBody(req));
    const old = await kvGet(env, "noi-dung");
    const stmts = [];
    if (old !== null) {
      stmts.push(env.DB.prepare("INSERT INTO hist(ts, who, v) VALUES(?, ?, ?)").bind(vnNow(), who, old));
      stmts.push(env.DB.prepare("DELETE FROM hist WHERE id NOT IN (SELECT id FROM hist ORDER BY id DESC LIMIT 30)"));
    }
    stmts.push(env.DB.prepare("INSERT INTO kv(k, v) VALUES('noi-dung', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(JSON.stringify(data)));
    await env.DB.batch(stmts);
    return json({ ok: true, soBai: data.banTin.length, soClb: data.clb.length });
  }

  if (p === "/api/anh" && m === "POST") {
    await requireAuth(req, env);
    const body = await readBody(req);
    let raw = String(body.data ?? "");
    const comma = raw.indexOf(",");
    if (comma >= 0 && comma < 80) raw = raw.slice(comma + 1);
    let bytes;
    try { bytes = Uint8Array.from(atob(raw.replace(/\s/g, "")), c => c.charCodeAt(0)); } catch { throw bad("Ảnh không đọc được"); }
    if (bytes.length > MAX_IMG) throw bad("Ảnh tối đa 5 MB. Hãy chọn ảnh nhỏ hơn.");
    const type = sniffImage(bytes);
    if (!type) throw bad("Chỉ nhận ảnh JPG, PNG, WebP");
    const name = (await sha256(bytes)).slice(0, 32) + ".webp";   // tên luôn .webp để khớp quy tắc đường dẫn ảnh
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const b64 = btoa(bin);
    if ((await sheetCfg(env)).url) {            // bản gốc nằm trên Google Drive của BCH
      const [ok, msg] = await gas(env, { hanh: "luu-anh", ten: name, loai: type, data: b64 });
      if (!ok) throw new HttpError(502, "Không lưu được ảnh lên Google Drive: " + msg);
    }                                           // (chưa nối Google thì ảnh chỉ nằm trong D1)
    await env.DB.prepare("INSERT OR IGNORE INTO images(name, type, data) VALUES(?, ?, ?)").bind(name, type, b64).run();
    return json({ anh: "up/" + name });
  }

  if (p === "/api/doi-mat-khau" && m === "POST") {
    if ((await requireAuth(req, env)) !== "admin") throw new HttpError(403, "Agent không được đổi mật khẩu");
    const body = await readBody(req);
    const cu = String(body.cu ?? ""), moi = String(body.moi ?? "");
    const auth = await getAuth(env);
    if (!(await checkPw(cu, auth.mat_khau))) throw bad("Mật khẩu hiện tại không đúng");
    if (moi.length < 10 || moi.length > 200) throw bad("Mật khẩu mới cần ít nhất 10 ký tự");
    auth.mat_khau = await hashPw(moi);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO kv(k, v) VALUES('auth', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(JSON.stringify(auth)),
      env.DB.prepare("DELETE FROM sessions"),
    ]);
    return json({ ok: true });
  }

  /* ----- đơn merch ----- */
  if (p === "/api/don-hang" && m === "POST") return taoDon(req, env);
  if (p === "/api/don-hang" && m === "GET") { await requireAuth(req, env); return json(await allOrders(env)); }

  if ((mt = p.match(/^\/api\/don-hang\/([^/]+)\/da-thanh-toan$/)) && m === "POST") {
    const ma = decodeURIComponent(mt[1]);
    const body = await readBody(req);
    const k = "confirm:" + clientKey(req);
    await hitSweep(env);
    if ((await hitCount(env, k)) >= 60) throw new HttpError(429, "Thao tác quá nhiều lần, thử lại sau 10 phút");
    await hitAdd(env, k);
    const khoa = str(body.khoa, 60, "Khoá đơn");
    const d = await getOrder(env, ma);
    if (!d || !khoa || !safeEq(d.khoa || "", khoa)) throw new HttpError(404, "Không tìm thấy đơn");
    if (d.trangThai === "huy") throw bad("Đơn này đã bị huỷ, vui lòng liên hệ Ban Chấp hành");
    let st = d.trangThai;
    if (st === "moi") {
      const r = await env.DB.prepare("UPDATE orders SET data = json_set(data, '$.trangThai', 'bao-tt', '$.baoTT', ?) WHERE ma = ? AND json_extract(data, '$.trangThai') = 'moi'").bind(vnNow(), ma).run();
      if (r.meta.changes) st = "bao-tt";
    }
    await syncBg(env, ctx, [ma]);
    return json({ ok: true, ma, trangThai: st });
  }

  if ((mt = p.match(/^\/api\/don-hang\/([^/]+)$/)) && m === "PATCH") {
    await requireAuth(req, env);
    const ma = decodeURIComponent(mt[1]);
    const st = (await readBody(req)).trangThai;
    if (!DH_STATUS.includes(st)) throw bad("Trạng thái không hợp lệ");
    const r = await env.DB.prepare("UPDATE orders SET data = json_set(data, '$.trangThai', ?) WHERE ma = ?").bind(st, ma).run();
    if (!r.meta.changes) throw new HttpError(404, "Không tìm thấy đơn");
    if (st !== "moi") await syncBg(env, ctx, [ma]);
    if (MAIL_KHI.includes(st) && (await sheetCfg(env)).url) ctx.waitUntil(guiMailXacNhan(env, ma).catch(e => console.error("mail", e)));
    return json({ ok: true });
  }

  if ((mt = p.match(/^\/api\/don-hang\/([^/]+)\/gui-mail$/)) && m === "POST") {
    await requireAuth(req, env);
    const [ok, msg] = await guiMailXacNhan(env, decodeURIComponent(mt[1]), true);
    if (!ok) throw bad(msg);
    return json({ ok: true, thongBao: msg });
  }

  if ((mt = p.match(/^\/api\/don-hang\/([^/]+)$/)) && m === "DELETE") {
    await requireAuth(req, env);
    const r = await env.DB.prepare("DELETE FROM orders WHERE ma = ?").bind(decodeURIComponent(mt[1])).run();
    if (!r.meta.changes) throw new HttpError(404, "Không tìm thấy đơn");
    return json({ ok: true });
  }

  /* ----- Google Sheet ----- */
  if (p === "/api/sheet" && m === "GET") {
    await requireAuth(req, env);
    const c = await sheetCfg(env);
    return json({ url: c.url || "", sheetUrl: sheetLink(c.sheetId), coKhoa: !!c.khoa });
  }
  if (p === "/api/sheet" && m === "PUT") {
    await requireAuth(req, env);
    const body = await readBody(req);
    const u = str(body.url, 300, "Link Apps Script");
    if (u && !/^https:\/\/script\.google\.com\/(a\/macros\/[a-z0-9.-]+|macros)\/s\/[A-Za-z0-9_-]{20,}\/exec$/.test(u))
      throw bad("Link phải có dạng https://script.google.com/macros/s/.../exec");
    const cur = await sheetCfg(env);
    cur.url = u;
    if (body.sheetUrl !== undefined) {           // không gửi trường này thì giữ nguyên sheet đang dùng
      const id = parseSheetId(str(body.sheetUrl, 300, "Link Google Sheet"));
      if (id === null) throw bad("Link Google Sheet phải có dạng https://docs.google.com/spreadsheets/d/.../edit");
      cur.sheetId = id;
    }
    const k2 = str(body.khoa, 100, "Khoá Sheet");
    if (k2) cur.khoa = k2;
    if (!cur.khoa) cur.khoa = rndUrl(18);
    await kvSet(env, "sheet", JSON.stringify(cur));
    return json({ ok: true });
  }
  if (p === "/api/sheet/khoa" && m === "GET") {
    await requireAuth(req, env);
    return json({ khoa: (await sheetCfg(env)).khoa || "" });
  }
  if (p === "/api/sheet/sao-luu" && m === "POST") {
    await requireAuth(req, env);
    const [ok, msg, out] = await saoLuuDrive(env);
    if (!ok) throw bad(msg);
    return json({ ok: true, thongBao: "Đã lưu bản sao lưu lên Google Drive: " + (out.ten || "") });
  }
  if (p === "/api/sheet/dong-bo" && m === "POST") {
    await requireAuth(req, env);
    const mas = new Set((await allOrders(env)).filter(d => d.trangThai !== "moi").map(d => d.ma));
    const [ok, msg] = await syncOrders(env, mas);
    if (!ok) throw bad(msg);
    return json({ ok: true, thongBao: msg });
  }

  if (p === "/api/sao-luu" && m === "GET") {
    await requireAuth(req, env, true);
    const auth = await getAuth(env);
    const nd = await getContentText(env);
    const anh = [...new Set([...nd.matchAll(/up\/([a-f0-9]{16,64}\.webp)/g)].map(x => x[1]))].sort();
    return json({ noiDung: JSON.parse(nd), quanTri: { mat_khau: auth.mat_khau, sheet: await sheetCfg(env) },
      anh, donHang: await allOrders(env) });
  }

  // Chẩn đoán cấu hình: chỉ trả về có/không, không lộ giá trị nào. Có thể xoá sau khi đăng nhập được.
  if (p === "/api/cau-hinh" && m === "GET") {
    return json({
      adminPassword: !!env.ADMIN_PASSWORD,
      agentKey: !!env.AGENT_KEY,
      db: await env.DB.prepare("SELECT 1 FROM kv LIMIT 1").first().then(() => true).catch(() => false),
      daCoMatKhauTrongDb: await env.DB.prepare("SELECT 1 FROM kv WHERE k = 'auth'").first().then(r => !!r).catch(() => false),
    });
  }

  throw new HttpError(404, "Không tìm thấy");
}

function sniffImage(b) {
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  return null;
}

async function taoDon(req, env) {
  const body = await readBody(req);
  if (String(body.web ?? "").trim()) throw bad("Đơn không hợp lệ");          // ô bẫy chống spam
  const k = "order:" + clientKey(req);
  await hitSweep(env);
  if ((await hitCount(env, k)) >= 40) throw new HttpError(429, "Bạn gửi quá nhiều đơn. Thử lại sau 10 phút."); // nhiều HS dùng chung wifi trường
  const m = obj(JSON.parse(await getContentText(env)).merch);
  if (!m.hien || !m.moDon) throw bad("Hiện chưa mở đơn đặt áo");
  if (m.hanChot && Date.now() > new Date(m.hanChot + ":00+07:00").getTime()) throw bad("Đơn đặt áo đã đóng");

  const ho = str(body.hoTen, 80, "Họ tên"), lop = str(body.lop, 30, "Lớp"), mshs = str(body.mshs, 12, "MSHS");
  const dtList = m.doiTuong?.length ? m.doiTuong : ["Học sinh PTNK"];
  const doiTuong = str(body.doiTuong, 40, "Bạn đến từ");
  if (!dtList.includes(doiTuong)) throw bad("Vui lòng chọn bạn đến từ đâu");
  const laHs = doiTuong === dtList[0];
  if (laHs && (!lop || !/^\d{4,8}$/.test(mshs))) throw bad("Học sinh vui lòng nhập lớp và mã số học sinh (MSHS)");
  if (mshs && !/^\d{4,8}$/.test(mshs)) throw bad("MSHS chỉ gồm chữ số");
  const coSo = (m.coSo || []).find(c => c.id === body.coSo);
  if (!coSo) throw bad("Vui lòng chọn cơ sở nhận áo");
  const sdt = str(body.sdt, 20, "Số điện thoại").replace(/[\s.-]/g, "");
  const email = str(body.email, 120, "Email");
  if (len(ho) < 2) throw bad("Vui lòng nhập họ tên");
  if (!/^(\+?84|0)\d{9,10}$/.test(sdt)) throw bad("Số điện thoại không hợp lệ");
  if (!email) throw bad("Vui lòng nhập email để nhận xác nhận đơn");
  if (!EMAIL_RE.test(email)) throw bad("Email không hợp lệ");

  const sp = new Map((m.sanPham || []).filter(p => p.con !== false).map(p => [p.id, p]));
  const items = [];
  let n = 0, tong = 0;
  for (const it of (Array.isArray(body.items) ? body.items : []).slice(0, 20)) {
    if (!isObj(it)) continue;
    const p = sp.get(it.sp);
    const sl = Math.trunc(Number(it.sl ?? 1)) || 0;
    if (!p || !(sl >= 1 && sl <= 10)) throw bad("Vui lòng chọn sản phẩm và số lượng (1–10) cho từng dòng");
    const tc = typeof it.tuyChon === "string" ? it.tuyChon : "";
    if (p.tuyChon.length && !p.tuyChon.includes(tc)) throw bad(`Vui lòng chọn mẫu cho ${p.ten}`);
    const size = typeof it.size === "string" ? it.size : "";
    if (p.sizes.length && !p.sizes.includes(size)) throw bad(`Vui lòng chọn size cho ${p.ten}`);
    items.push({ sp: p.id, ten: p.ten, tuyChon: p.tuyChon.length ? tc : "", size: p.sizes.length ? size : "", sl, gia: p.gia });
    n += sl; tong += sl * p.gia;
  }
  const toiDa = Number(m.toiDa) || 10;
  if (!items.length || n > toiDa) throw bad(`Mỗi đơn đặt từ 1 đến ${toiDa} món`);

  const don = { ma: "BCH" + rndHex(3).toUpperCase(), luc: vnNow(), hoTen: ho, doiTuong, lop, mshs, sdt, email, coSo: coSo.ten,
    items, soAo: n, tongTien: tong, ghiChu: str(body.ghiChu, 400, "Ghi chú"), trangThai: "moi", khoa: rndUrl(18) };
  const c = await env.DB.prepare("SELECT COUNT(*) AS c FROM orders").first();
  if (c.c >= 5000) throw new HttpError(503, "Hệ thống đang quá tải đơn, vui lòng liên hệ BCH");
  await env.DB.prepare("INSERT INTO orders(ma, data) VALUES(?, ?)").bind(don.ma, JSON.stringify(don)).run();
  await hitAdd(env, k);
  return json({ ma: don.ma, khoa: don.khoa, soAo: n, tongTien: tong, coSo: coSo.ten, noiNhan: coSo.noiNhan });
}

/* ------------------------------------------------------------ ảnh, trang tĩnh */
async function serveUp(req, env, name) {
  if (!/^[a-f0-9]{16,64}\.webp$/.test(name)) throw new HttpError(404, "Không tìm thấy");
  let o = await env.DB.prepare("SELECT type, data FROM images WHERE name = ?").bind(name).first();
  if (!o) {                                      // chưa có trong bộ nhớ đệm D1: lấy từ Google Drive
    const [ok, , out] = await gas(env, { hanh: "lay-anh", ten: name });
    if (!ok || !out.data) throw new HttpError(404, "Không tìm thấy");
    o = { type: out.loai || "image/webp", data: out.data };
    await env.DB.prepare("INSERT OR IGNORE INTO images(name, type, data) VALUES(?, ?, ?)").bind(name, o.type, o.data).run();
  }
  const body = req.method === "HEAD" ? null : Uint8Array.from(atob(o.data), c => c.charCodeAt(0));
  return new Response(body, { headers: {
    "Content-Type": o.type || "image/webp", "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff", ETag: `"${name}"` } });
}

const PAGES = { "/": "index.html", "/top": "index.html", "/mo-don": "index.html", "/tien-ich": "index.html", "/bantin": "index.html",
  "/bch": "index.html", "/clb": "index.html", "/admin": "index.html", "/tin-tuc": "tin-tuc.html", "/merch": "merch.html" };

export default {
  async scheduled(event, env, ctx) {            // sao lưu hằng ngày lên Google Drive (xem [triggers] trong wrangler.toml)
    ctx.waitUntil(saoLuuDrive(env).then(([ok, msg]) => { if (!ok) console.error("sao-luu", msg); }));
  },
  async fetch(req, env, ctx) {
    const u = new URL(req.url);
    const p = u.pathname.replace(/\/+$/, "") || "/";
    try {
      if (p.startsWith("/api/")) return await api(req, env, ctx, p);
      if (p.startsWith("/up/") && (req.method === "GET" || req.method === "HEAD")) return await serveUp(req, env, p.slice(4));
      if (PAGES[p] && (req.method === "GET" || req.method === "HEAD")) {
        const res = await env.ASSETS.fetch(new Request(new URL("/" + PAGES[p], u), req));
        return new Response(res.body, { status: res.status, headers: res.headers });
      }
      return await env.ASSETS.fetch(req);
    } catch (e) {
      if (e instanceof HttpError) return json({ detail: e.detail }, e.status);
      console.error(e);
      return json({ detail: "Lỗi máy chủ" }, 500);
    }
  },
};
