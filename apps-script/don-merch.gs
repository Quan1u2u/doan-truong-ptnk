/**
 * Nhận đơn Merch từ website Đoàn trường PTNK và ghi vào Google Sheet.
 *
 * Cách cài (làm một lần, bằng tài khoản Google của BCH):
 * 1. Tạo một Google Sheet mới, vào Tiện ích mở rộng → Apps Script.
 * 2. Xoá code mẫu, dán toàn bộ file này vào, sửa KHOA bên dưới cho giống
 *    "Khoá bảo mật" hiện trong trang quản trị website (tab Merch → Google Sheet).
 * 3. Bấm Triển khai → Tùy chọn triển khai mới → Loại: Ứng dụng web.
 *    Thực thi với tư cách: Tôi. Người có quyền truy cập: Bất kỳ ai.
 * 4. Cấp quyền, chép "URL ứng dụng web" (đuôi /exec) dán vào trang quản trị rồi bấm Lưu.
 *
 * Mỗi đơn là một dòng, tìm theo Mã đơn: đơn mới thì thêm dòng, đơn đã có thì cập nhật dòng cũ.
 */
const KHOA = 'DAN-KHOA-BAO-MAT-VAO-DAY';
const TEN_TRANG = 'Đơn merch';
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
  const ds = Array.isArray(body.don) ? body.don : [];
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
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

function doGet() {
  return tra({ ok: true, ten: 'Nhận đơn Merch Đoàn trường PTNK' });
}

function tra(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
