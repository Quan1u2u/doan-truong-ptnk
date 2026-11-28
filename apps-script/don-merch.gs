/**
 * Cầu nối giữa website Đoàn trường PTNK (Cloudflare Worker) và tài khoản Google của BCH.
 * Một địa chỉ /exec làm bốn việc:
 *   1. "don"      ghi đơn Merch vào Google Sheet (mỗi đơn một dòng, tìm theo Mã đơn)
 *   2. "luu-anh" / "lay-anh"   lưu và đọc ảnh trong Google Drive (thư mục "Web Đoàn PTNK/anh")
 *   3. "gui-mail" gửi email xác nhận đơn bằng Gmail của tài khoản này
 *   4. "sao-luu"  lưu bản sao lưu JSON hằng ngày (thư mục "Web Đoàn PTNK/sao-luu", giữ 30 bản mới nhất)
 *
 * Cách cài (làm một lần, bằng tài khoản Google của BCH):
 * 1. Vào script.google.com (hoặc Tiện ích mở rộng → Apps Script trong một Google Sheet bất kỳ), tạo dự án.
 * 2. Xoá code mẫu, dán toàn bộ file này vào, sửa KHOA bên dưới cho giống
 *    "Khoá bảo mật" hiện trong trang quản trị website (tab Merch → Google).
 * 3. Bấm Triển khai → Tùy chọn triển khai mới → Loại: Ứng dụng web.
 *    Thực thi với tư cách: Tôi. Người có quyền truy cập: Bất kỳ ai.
 * 4. Cấp quyền (Sheet, Drive, Gmail), chép "URL ứng dụng web" (đuôi /exec) dán vào trang quản trị rồi bấm Lưu.
 *
 * Đổi Google Sheet nhận đơn: KHÔNG cần tạo script mới, KHÔNG đổi URL /exec.
 * Chỉ cần dán link Google Sheet mới vào ô "Link Google Sheet" trong trang quản trị rồi Lưu.
 * Website gửi kèm ID của sheet trong mỗi lần ghi đơn (trường sheetId), script mở đúng sheet đó.
 * Tài khoản chạy script phải có quyền chỉnh sửa sheet đó. Nếu website chưa gửi sheetId,
 * script dùng sheet mà nó được gắn vào (cách cũ), nên bản triển khai cũ vẫn chạy bình thường.
 *
 * Khi sửa file này: Triển khai → Quản lý bản triển khai → biểu tượng bút chì → Phiên bản: Mới → Triển khai.
 * (URL giữ nguyên.) Nếu Google hỏi quyền mới thì cấp lại.
 *
 * Hạn mức Gmail: khoảng 100 email/ngày với tài khoản @gmail.com, 1500/ngày với Google Workspace.
 */
const KHOA = 'DAN-KHOA-BAO-MAT-VAO-DAY';
const TEN_TRANG = 'Đơn merch';
const THU_MUC_GOC = 'Web Đoàn PTNK';
const GIU_BAN_SAO_LUU = 30;
const COT = [
  ['ma', 'Mã đơn'], ['luc', 'Thời gian đặt'], ['baoTT', 'Báo chuyển khoản lúc'], ['trangThai', 'Trạng thái'],
  ['hoTen', 'Họ và tên'], ['doiTuong', 'Bạn đến từ'], ['lop', 'Lớp'], ['mshs', 'MSHS'],
  ['sdt', 'Số điện thoại'], ['email', 'Email'], ['coSo', 'Nhận tại'], ['chiTiet', 'Chi tiết đơn'],
  ['soMon', 'Số món'], ['tongTien', 'Tổng tiền (đ)'], ['ghiChu', 'Ghi chú'],
];

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (x) { return tra({ ok: false, loi: 'Dữ liệu không hợp lệ' }); }
  if (!body || body.khoa !== KHOA) return tra({ ok: false, loi: 'Sai khoá bảo mật' });
  try {
    switch (body.hanh || 'don') {
      case 'don': return ghiDon(body);
      case 'luu-anh': return luuAnh(body);
      case 'lay-anh': return layAnh(body);
      case 'gui-mail': return guiMail(body);
      case 'sao-luu': return saoLuu(body);
      default: return tra({ ok: false, loi: 'Thao tác không hỗ trợ' });
    }
  } catch (x) {
    return tra({ ok: false, loi: String(x && x.message || x).slice(0, 200) });
  }
}

/* ---------- 1. Google Sheet ---------- */
function ghiDon(body) {
  const ds = Array.isArray(body.don) ? body.don : [];
  const id = String(body.sheetId || '');
  if (id && !/^[A-Za-z0-9_-]{20,}$/.test(id)) return tra({ ok: false, loi: 'ID Google Sheet không hợp lệ' });
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    let ss;
    if (id) {
      try { ss = SpreadsheetApp.openById(id); }
      catch (x) { return tra({ ok: false, loi: 'Không mở được Google Sheet. Kiểm tra link và quyền chỉnh sửa của tài khoản chạy script' }); }
    } else {
      ss = SpreadsheetApp.getActiveSpreadsheet();
      if (!ss) return tra({ ok: false, loi: 'Chưa có link Google Sheet. Dán link vào trang quản trị' });
    }
    const sh = ss.getSheetByName(TEN_TRANG) || ss.insertSheet(TEN_TRANG);
    if (sh.getLastRow() === 0) {
      sh.appendRow(COT.map(c => c[1]));
      sh.getRange(1, 1, 1, COT.length).setFontWeight('bold').setBackground('#dbe7ff');
      sh.setFrozenRows(1);
      sh.getRange('A:O').setNumberFormat('@'); // giữ nguyên số 0 đầu SĐT, MSHS
    }
    const n = Math.max(sh.getLastRow() - 1, 0);
    const maCu = n ? sh.getRange(2, 1, n, 1).getValues().map(r => String(r[0])) : [];
    ds.forEach(d => {
      const row = COT.map(c => d[c[0]] == null ? '' : String(d[c[0]]));
      const i = maCu.indexOf(String(d.ma));
      if (i >= 0) sh.getRange(i + 2, 1, 1, row.length).setValues([row]);
      else { sh.appendRow(row); maCu.push(String(d.ma)); }
    });
    return tra({ ok: true, so: ds.length });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- 2. Google Drive: ảnh ---------- */
function layHoacTao_(cha, ten) {
  const it = cha.getFoldersByName(ten);
  return it.hasNext() ? it.next() : cha.createFolder(ten);
}
function thuMuc_(ten) {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('THU_MUC_' + ten);
  if (id) { try { return DriveApp.getFolderById(id); } catch (x) { /* thư mục đã bị xoá: tạo lại */ } }
  const f = layHoacTao_(layHoacTao_(DriveApp.getRootFolder(), THU_MUC_GOC), ten);
  props.setProperty('THU_MUC_' + ten, f.getId());
  return f;
}
function tenAnhHopLe_(ten) { return typeof ten === 'string' && /^[a-f0-9]{16,64}\.webp$/.test(ten); }

function luuAnh(body) {
  if (!tenAnhHopLe_(body.ten)) return tra({ ok: false, loi: 'Tên ảnh không hợp lệ' });
  const loai = ['image/webp', 'image/png', 'image/jpeg'].indexOf(body.loai) >= 0 ? body.loai : 'image/webp';
  const f = thuMuc_('anh');
  if (!f.getFilesByName(body.ten).hasNext()) {          // tên là mã băm nội dung nên trùng tên = trùng ảnh
    f.createFile(Utilities.newBlob(Utilities.base64Decode(String(body.data || '')), loai, body.ten));
  }
  return tra({ ok: true });
}
function layAnh(body) {
  if (!tenAnhHopLe_(body.ten)) return tra({ ok: false, loi: 'Tên ảnh không hợp lệ' });
  const it = thuMuc_('anh').getFilesByName(body.ten);
  if (!it.hasNext()) return tra({ ok: false, loi: 'Không có ảnh' });
  const file = it.next();
  return tra({ ok: true, loai: file.getMimeType(), data: Utilities.base64Encode(file.getBlob().getBytes()) });
}

/* ---------- 3. Gmail ---------- */
function guiMail(body) {
  const den = String(body.den || '');
  if (!/^[^@\s<>]+@[^@\s<>]+\.[a-z]{2,}$/i.test(den) || den.length > 120) return tra({ ok: false, loi: 'Email người nhận không hợp lệ' });
  const opt = { name: 'Đoàn trường PTNK', htmlBody: String(body.html || '') };
  if (/^[^@\s<>]+@[^@\s<>]+\.[a-z]{2,}$/i.test(String(body.traLoi || ''))) opt.replyTo = body.traLoi;
  MailApp.sendEmail(den, String(body.tieuDe || 'Đoàn trường PTNK').slice(0, 200), String(body.noiDung || ''), opt);
  return tra({ ok: true });
}

/* ---------- 4. Sao lưu ---------- */
function saoLuu(body) {
  const ngay = Utilities.formatDate(new Date(), 'Asia/Ho_Chi_Minh', 'yyyy-MM-dd');
  const ten = 'sao-luu-' + ngay + '.json';
  const noiDung = JSON.stringify({ luc: new Date().toISOString(), noiDung: body.noiDung, donHang: body.donHang }, null, 1);
  const f = thuMuc_('sao-luu');
  const it = f.getFilesByName(ten);
  if (it.hasNext()) it.next().setContent(noiDung); else f.createFile(ten, noiDung, MimeType.PLAIN_TEXT);
  const tatCa = [];
  const ds = f.getFiles();
  while (ds.hasNext()) { const x = ds.next(); tatCa.push([x.getName(), x]); }
  tatCa.sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(GIU_BAN_SAO_LUU).forEach(p => p[1].setTrashed(true));
  return tra({ ok: true, ten: ten });
}

function doGet() {
  return tra({ ok: true, ten: 'Cầu nối website Đoàn trường PTNK với Google' });
}

function tra(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
