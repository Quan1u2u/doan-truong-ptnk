// Trang quản trị: mở bằng đường dẫn .../#admin
(() => {
const root = document.getElementById('admin-root');
if (!root) return;
const G = () => window.DOAN;
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Phiên đăng nhập chỉ giữ trong bộ nhớ: tải lại trang là phải đăng nhập lại.
let token = null;
const saveToken = t => { token = t; };

let data = null, tab = 'tin', editing = null, busy = false;

const NHOM = { hc: 'Ngày lễ & 20/11', pt: 'Phong trào', clb: 'Đoàn & CLB', tb: 'Thông báo' };
const NHAN = { hc: 'Mừng 20/11', pt: 'Phong trào', clb: 'Đoàn & CLB', tb: 'Thông báo' };
const LOC = { ht: 'Học thuật', nt: 'Nghệ thuật', tt: 'Thể thao', vh: 'Văn hóa', cd: 'Cộng đồng & Truyền thông' };
const VB = [
  ['heroKicker', 'Dòng nhỏ đầu trang'], ['heroLead', 'Lời giới thiệu đầu trang', 1],
  ['fact1So', 'Số liệu 1'], ['fact1Chu', 'Chú thích số liệu 1'], ['fact2So', 'Số liệu 2'], ['fact2Chu', 'Chú thích số liệu 2'],
  ['fact3So', 'Số liệu 3'], ['fact3Chu', 'Chú thích số liệu 3'],
  ['bchNhan', 'Nhãn phần Ban Chấp hành'], ['bchMoTa', 'Giới thiệu Ban Chấp hành', 1], ['bchLink', 'Link nút "Xem bài ra mắt"'],
  ['clbMoTa', 'Giới thiệu phần CLB', 1], ['lienHeTieuDe', 'Tiêu đề phần liên hệ'], ['lienHeMoTa', 'Mô tả phần liên hệ', 1],
  ['credits', 'Dòng chân trang', 1],
];

async function api(path, opt = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  let r;
  try { r = await fetch(`${G().API}${path}`, { ...opt, headers, cache: 'no-store' }); }
  catch (e) { throw new Error('Không kết nối được máy chủ. Thử lại sau ít giây.'); }
  let body = {};
  try { body = await r.json(); } catch (e) {}
  if (r.status === 401 && path !== '/api/dang-nhap') { saveToken(null); render(); }
  if (!r.ok) throw new Error(typeof body.detail === 'string' ? body.detail : `Lỗi máy chủ (${r.status})`);
  return body;
}

function toast(msg, bad) {
  let t = document.querySelector('.adm-toast');
  if (!t) { t = document.createElement('div'); t.className = 'adm-toast'; t.setAttribute('role', 'status'); document.body.append(t); }
  t.textContent = msg; t.classList.toggle('bad', !!bad); t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 3200);
}

async function save(msg = 'Đã lưu và cập nhật lên web') {
  if (busy) return false;
  busy = true;
  try {
    await api('/api/noi-dung', { method: 'PUT', body: JSON.stringify(data) });
    data = await api('/api/noi-dung');
    G().renderAll(structuredClone(data));
    toast(msg);
    return true;
  } catch (e) { toast(e.message, true); return false; }
  finally { busy = false; }
}

/* ---------- tiện ích form ---------- */
const field = (name, label, val = '', o = {}) => {
  const id = 'adm-' + name;
  const input = o.area
    ? `<textarea id="${id}" name="${name}" rows="${o.rows || 3}" ${o.req ? 'required' : ''} maxlength="${o.max || 900}">${esc(val)}</textarea>`
    : `<input id="${id}" name="${name}" type="${o.type || 'text'}" value="${esc(val)}" ${o.req ? 'required' : ''} ${o.ph ? `placeholder="${esc(o.ph)}"` : ''} maxlength="${o.max || 600}">`;
  return `<label class="adm-f${o.wide ? ' wide' : ''}" for="${id}"><span>${esc(label)}${o.req ? ' *' : ''}</span>${input}${o.hint ? `<small>${esc(o.hint)}</small>` : ''}</label>`;
};
const select = (name, label, val, opts) => `<label class="adm-f" for="adm-${name}"><span>${esc(label)}</span><select id="adm-${name}" name="${name}">${Object.entries(opts).map(([k, v]) => `<option value="${k}" ${k === val ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>`;
const imgField = (name, label, val, loai) => `<div class="adm-f wide adm-img" data-img="${name}" data-loai="${loai}">
  <span>${esc(label)}</span>
  <div class="adm-imgrow"><div class="adm-prev">${val ? `<img src="${esc(G().imgUrl(val))}" alt="">` : '<em>Chưa có ảnh</em>'}</div>
  <div><label class="adm-btn ghost adm-up">Chọn ảnh từ máy<input type="file" accept="image/jpeg,image/png,image/webp" hidden></label>
  ${val ? '<button type="button" class="adm-btn ghost adm-clearimg">Bỏ ảnh</button>' : ''}
  <small>JPG, PNG hoặc WebP, tối đa 8 MB. Ảnh sẽ tự thu nhỏ.</small></div></div>
  <input type="hidden" name="${name}" value="${esc(val)}"></div>`;

const toVNDate = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? `Đăng ${m[3]}/${m[2]}/${m[1]}` : ''; };
const fromVNDate = s => { const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(s || ''); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; };
const today = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);

/* ---------- các khung giao diện ---------- */
function viewLogin() {
  return `<div class="adm-login">
    <img src="./assets/favicon-192.png" alt="" width="72" height="72">
    <h2>Quản trị website Đoàn trường</h2>
    <p>Dành cho Ban Chấp hành Đoàn trường Phổ thông Năng khiếu.</p>
    <form id="adm-login-form" autocomplete="on">
      <label class="adm-f" for="adm-pw"><span>Mật khẩu quản trị</span><input id="adm-pw" type="password" autocomplete="current-password" required></label>
      <button class="adm-btn" type="submit">Đăng nhập</button>
      <p class="adm-err" id="adm-login-err" role="alert"></p>
    </form>
  </div>`;
}

function viewTin() {
  if (editing && editing.kind === 'tin') {
    const n = editing.item;
    return `<form class="adm-form" id="adm-edit">
      <h3>${editing.isNew ? 'Đăng bài mới' : 'Sửa bài'}</h3>
      <div class="adm-grid">
        ${field('tieuDe', 'Tiêu đề', n.tieuDe, { req: 1, wide: 1, max: 160 })}
        ${field('moTa', 'Tóm tắt', n.moTa, { area: 1, wide: 1, max: 600, hint: 'Một đến hai câu, hiện trên thẻ bài.' })}
        ${select('nhom', 'Nhóm', n.nhom || 'tb', NHOM)}
        ${field('nhan', 'Nhãn trên thẻ', n.nhan || NHAN[n.nhom || 'tb'], { max: 40 })}
        ${field('ngay', 'Ngày đăng', fromVNDate(n.ngay) || today(), { type: 'date' })}
        ${select('trangThai', 'Trạng thái', n.trangThai || 'done', { open: 'Đang mở', done: 'Đã kết thúc' })}
        ${field('han', 'Hạn chót (nếu có)', (n.han || '').slice(0, 16), { type: 'datetime-local', hint: 'Quá hạn bài tự chuyển "Đã kết thúc".' })}
        ${field('link', 'Link bài trên fanpage', n.link, { type: 'url', ph: 'https://www.facebook.com/...', wide: 1 })}
        ${imgField('anh', 'Ảnh bài', n.anh, 'tin')}
      </div>
      <div class="adm-actions"><button class="adm-btn" type="submit">${editing.isNew ? 'Đăng bài' : 'Lưu thay đổi'}</button><button class="adm-btn ghost" type="button" data-act="cancel">Huỷ</button></div>
    </form>`;
  }
  const rows = data.banTin.map((n, i) => `<li class="adm-row">
    <div class="adm-thumb">${n.anh ? `<img src="${esc(G().imgUrl(n.anh))}" alt="" loading="lazy">` : ''}</div>
    <div class="adm-rtext"><strong>${esc(n.tieuDe)}</strong><small>${esc(n.ngay)} · ${esc(NHOM[n.nhom] || '')}${n.trangThai === 'open' ? ' · Đang mở' : ''}</small></div>
    <div class="adm-rbtn">
      <button type="button" class="adm-ico" data-act="up" data-i="${i}" aria-label="Đưa lên" ${i ? '' : 'disabled'}>↑</button>
      <button type="button" class="adm-ico" data-act="down" data-i="${i}" aria-label="Đưa xuống" ${i < data.banTin.length - 1 ? '' : 'disabled'}>↓</button>
      <button type="button" class="adm-btn ghost sm" data-act="edit" data-i="${i}">Sửa</button>
      <button type="button" class="adm-btn danger sm" data-act="del" data-i="${i}">Xoá</button>
    </div></li>`).join('');
  return `<div class="adm-head2"><p>${data.banTin.length} bài. Trang chủ hiện 6 bài đầu, toàn bộ ở Danh mục bản tin.</p><button class="adm-btn" type="button" data-act="new">+ Đăng bài mới</button></div><ul class="adm-list">${rows}</ul>`;
}

function viewClb() {
  if (editing && editing.kind === 'clb') {
    const c = editing.item;
    return `<form class="adm-form" id="adm-edit">
      <h3>${editing.isNew ? 'Thêm CLB' : 'Sửa CLB'}</h3>
      <div class="adm-grid">
        ${field('ten', 'Tên CLB', c.ten, { req: 1, max: 120 })}
        ${field('linhVuc', 'Lĩnh vực', c.linhVuc, { max: 120, ph: 'Ví dụ: Học thuật, Kinh tế' })}
        <fieldset class="adm-f wide"><legend>Nhóm để lọc</legend><div class="adm-checks">${Object.entries(LOC).map(([k, v]) => `<label><input type="checkbox" name="loc" value="${k}" ${(c.loc || []).includes(k) ? 'checked' : ''}> ${esc(v)}</label>`).join('')}</div></fieldset>
        ${field('link', 'Fanpage CLB', c.link, { type: 'url', wide: 1, ph: 'https://www.facebook.com/...' })}
        ${imgField('anh', 'Avatar CLB', c.anh, 'clb')}
      </div>
      <div class="adm-actions"><button class="adm-btn" type="submit">${editing.isNew ? 'Thêm CLB' : 'Lưu thay đổi'}</button><button class="adm-btn ghost" type="button" data-act="cancel">Huỷ</button></div>
    </form>`;
  }
  const rows = data.clb.map((c, i) => `<li class="adm-row">
    <div class="adm-thumb round">${c.anh ? `<img src="${esc(G().imgUrl(c.anh))}" alt="" loading="lazy">` : ''}</div>
    <div class="adm-rtext"><strong>${esc(c.ten)}</strong><small>${esc(c.linhVuc)} · ${c.loc.map(k => esc(LOC[k])).join(', ')}</small></div>
    <div class="adm-rbtn">
      <button type="button" class="adm-btn ghost sm" data-act="edit" data-i="${i}">Sửa</button>
      <button type="button" class="adm-btn danger sm" data-act="del" data-i="${i}">Xoá</button>
    </div></li>`).join('');
  return `<div class="adm-head2"><p>${data.clb.length} CLB, đội nhóm.</p><button class="adm-btn" type="button" data-act="new">+ Thêm CLB</button></div><ul class="adm-list">${rows}</ul>`;
}

function viewDon() {
  const m = data.moDon;
  return `<form class="adm-form" id="adm-don">
    <label class="adm-switch"><input type="checkbox" name="hien" ${m.hien !== false ? 'checked' : ''}> Hiện khung "Đang mở đơn" trên trang chủ</label>
    <div class="adm-grid">
      ${field('tieuDe', 'Tiêu đề', m.tieuDe, { wide: 1, max: 160 })}
      ${field('moTa', 'Mô tả', m.moTa, { area: 1, wide: 1, rows: 4, max: 800 })}
      ${field('hanChot', 'Hạn chót đặt hàng (giờ Việt Nam)', m.hanChot, { type: 'datetime-local', hint: 'Dùng cho bộ đếm ngược.' })}
      ${field('hanChotChu', 'Hạn chót hiển thị', m.hanChotChu, { ph: '23g59 · Thứ Ba, 24/11/2026', max: 80 })}
      ${field('linkDon', 'Link điền đơn', m.linkDon, { type: 'url', wide: 1 })}
      ${field('linkMoTa', 'Link mô tả công việc', m.linkMoTa, { type: 'url', wide: 1 })}
      ${field('linkBaiGoc', 'Link bài gốc trên fanpage', m.linkBaiGoc, { type: 'url', wide: 1 })}
      ${imgField('anh', 'Ảnh ấn phẩm', m.anh, 'tin')}
    </div>
    <div class="adm-actions"><button class="adm-btn" type="submit">Lưu đơn đang mở</button></div>
  </form>`;
}

function viewVanBan() {
  const vb = data.vanBan || {}, lk = data.lienKet || {}, lh = data.lienHe || {};
  return `<form class="adm-form" id="adm-vb">
    <h3>Liên kết và liên hệ</h3>
    <div class="adm-grid">
      ${field('lk_traCuuDoanVien', 'Link tra cứu thông tin Đoàn viên', lk.traCuuDoanVien, { type: 'url', wide: 1, hint: 'Để trống thì ô tra cứu hiện "đang cập nhật".' })}
      ${field('lk_webTruong', 'Website trường', lk.webTruong, { type: 'url', wide: 1 })}
      ${field('lh_email', 'Email', lh.email, { type: 'email' })}
      ${field('lh_messenger', 'Link Messenger', lh.messenger, { type: 'url' })}
      ${field('lh_fanpage', 'Link fanpage', lh.fanpage, { type: 'url', wide: 1 })}
    </div>
    <h3>Văn bản trên trang</h3>
    <div class="adm-grid">${VB.map(([k, l, area]) => field('vb_' + k, l, vb[k], { area: !!area, wide: !!area || k === 'bchLink', type: k === 'bchLink' ? 'url' : 'text', max: 900 })).join('')}</div>
    <div class="adm-actions"><button class="adm-btn" type="submit">Lưu văn bản</button></div>
  </form>`;
}

function viewTk() {
  return `<form class="adm-form" id="adm-pwform">
    <h3>Đổi mật khẩu quản trị</h3>
    <div class="adm-grid">
      <label class="adm-f" for="adm-cu"><span>Mật khẩu hiện tại</span><input id="adm-cu" type="password" autocomplete="current-password" required></label>
      <label class="adm-f" for="adm-moi"><span>Mật khẩu mới (ít nhất 10 ký tự)</span><input id="adm-moi" type="password" autocomplete="new-password" minlength="10" required></label>
    </div>
    <div class="adm-actions"><button class="adm-btn" type="submit">Đổi mật khẩu</button></div>
    <p class="adm-note">Mật khẩu được lưu dưới dạng băm PBKDF2-HMAC-SHA256 (310.000 vòng, có muối), máy chủ không lưu mật khẩu gốc. Đổi mật khẩu sẽ đăng xuất mọi thiết bị.</p>
  </form>
  <div class="adm-form"><h3>Sao lưu</h3><p class="adm-note">Tải toàn bộ nội dung (bản tin, CLB, văn bản) về máy dưới dạng JSON.</p>
  <div class="adm-actions"><button class="adm-btn ghost" type="button" data-act="backup">Tải bản sao lưu</button></div></div>`;
}


/* ---------- Merch ---------- */
let orders = null;
const vnd = n => Number(n || 0).toLocaleString('vi-VN') + 'đ';
const TT = { moi: 'Chờ chuyển khoản', 'bao-tt': 'Đã báo chuyển khoản', 'da-xac-nhan': 'Đã xác nhận', 'da-thanh-toan': 'Đã nhận tiền', 'da-giao': 'Đã giao', huy: 'Huỷ' };
let sheet = null;
const loadSheet = () => api('/api/sheet').then(d => { sheet = d; render(); }).catch(e => toast(e.message, true));
const loadOrders = () => api('/api/don-hang').then(d => { orders = d.donHang || d; render(); }).catch(e => toast(e.message, true));
function viewMerch() {
  data.merch ||= { hien: true, hienTrangChu: false, moDon: false, sanPham: [] };
  const m = data.merch;
  if (editing && editing.kind === 'sp') {
    const p = editing.item;
    return `<form class="adm-form" id="adm-edit">
      <h3>${editing.isNew ? 'Thêm sản phẩm' : 'Sửa sản phẩm'}</h3>
      <div class="adm-grid">
        ${field('ten', 'Tên sản phẩm', p.ten, { req: 1, max: 100, ph: 'Ví dụ: Túi tote PTNK · trắng' })}
        ${field('gia', 'Giá (đồng)', p.gia || '', { type: 'number', req: 1 })}
        ${field('tuyChon', 'Các mẫu để chọn (cách nhau bằng dấu phẩy)', (p.tuyChon || []).join(', '), { wide: 1, max: 700, hint: 'Để trống nếu sản phẩm chỉ có một mẫu.' })}
        ${field('sizes', 'Các size (cách nhau bằng dấu phẩy)', (p.sizes || []).join(', '), { max: 120, hint: 'Để trống nếu không có size.' })}
        <label class="adm-switch"><input type="checkbox" name="con" ${p.con !== false ? 'checked' : ''}> Còn hàng</label>
        ${field('moTa', 'Mô tả ngắn', p.moTa, { area: 1, wide: 1, max: 400, rows: 2 })}
        ${imgField('anh', 'Ảnh sản phẩm', p.anh, 'tin')}
      </div>
      <div class="adm-actions"><button class="adm-btn" type="submit">${editing.isNew ? 'Thêm sản phẩm' : 'Lưu thay đổi'}</button><button class="adm-btn ghost" type="button" data-act="cancel">Huỷ</button></div>
    </form>`;
  }
  if (!orders) loadOrders();
  if (!sheet) loadSheet();
  const T = m.thanhToan || {};
  const spRows = (m.sanPham || []).map((p, i) => `<li class="adm-row">
    <div class="adm-thumb">${p.anh ? `<img src="${esc(G().imgUrl(p.anh))}" alt="" loading="lazy">` : ''}</div>
    <div class="adm-rtext"><strong>${esc(p.ten)}</strong><small>${vnd(p.gia)} · ${p.con === false ? 'Tạm hết' : 'Còn hàng'}${(p.tuyChon || []).length ? ` · ${p.tuyChon.length} mẫu` : ''}${(p.sizes || []).length ? ` · size ${esc(p.sizes.join(', '))}` : ''}</small></div>
    <div class="adm-rbtn">
      <button type="button" class="adm-btn ghost sm" data-act="sp-edit" data-i="${i}">Sửa</button>
      <button type="button" class="adm-btn danger sm" data-act="sp-del" data-i="${i}">Xoá</button>
    </div></li>`).join('');
  let od = '<p class="adm-note">Đang tải đơn…</p>';
  if (orders) {
    const live = orders.filter(o => o.trangThai !== 'huy');
    const tong = live.reduce((a, o) => a + o.tongTien, 0), ao = live.reduce((a, o) => a + o.soAo, 0);
    const sum = {};
    live.forEach(o => o.items.forEach(it => { const k = [it.ten, it.tuyChon, it.size && 'size ' + it.size].filter(Boolean).join(' · '); sum[k] = (sum[k] || 0) + it.sl; }));
    const table = Object.keys(sum).length ? `<div class="adm-tablewrap"><table class="adm-table"><thead><tr><th>Sản phẩm</th><th>Số lượng</th></tr></thead><tbody>${Object.entries(sum).sort().map(([k, v]) => `<tr><td>${esc(k)}</td><td><b>${v}</b></td></tr>`).join('')}</tbody></table></div>` : '';
    const theoCs = {}; live.forEach(o => { const k = o.coSo || 'Chưa chọn'; theoCs[k] = (theoCs[k] || 0) + o.soAo; });
    od = `<p class="adm-note">${orders.length} đơn · ${ao} món (không tính đơn huỷ) · tạm tính ${vnd(tong)}${Object.keys(theoCs).length ? ' · ' + Object.entries(theoCs).map(([k, v]) => `${esc(k)}: ${v} món`).join(', ') : ''}. Thông tin người đặt là dữ liệu cá nhân, chỉ hiện trong trang quản trị.</p>
      ${table}
      <div class="adm-actions"><button class="adm-btn ghost" type="button" data-act="od-reload">Tải lại</button><button class="adm-btn ghost" type="button" data-act="od-csv" ${orders.length ? '' : 'disabled'}>Xuất CSV (Excel)</button></div>
      <ul class="adm-list">${orders.slice().reverse().map(o => `<li class="adm-row adm-order">
        <div class="adm-rtext"><strong>${esc(o.ma)} · ${esc(o.hoTen)}${o.lop ? ' · ' + esc(o.lop) : ''}${o.mshs ? ' · MSHS ' + esc(o.mshs) : ''}</strong>
        <small>${esc(o.doiTuong || '')}${o.coSo ? ' · nhận tại ' + esc(o.coSo) : ''}</small>
        <small>${esc(o.sdt)}${o.email ? ' · ' + esc(o.email) : ''} · ${esc(o.luc.replace('T', ' ').slice(0, 16))}</small>
        <small>${o.items.map(it => `${esc([it.ten, it.tuyChon, it.size && 'size ' + it.size].filter(Boolean).join(' · '))} × ${it.sl}`).join('; ')} → <b>${vnd(o.tongTien)}</b></small>
        ${o.ghiChu ? `<small>Ghi chú: ${esc(o.ghiChu)}</small>` : ''}
        ${o.baoTT ? `<small>Báo chuyển khoản lúc ${esc(o.baoTT.replace('T', ' ').slice(0, 16))} · Sheet: ${o.sheet === 'ok' ? 'đã ghi' : esc(o.sheet || 'chưa ghi')}</small>` : ''}</div>
        <div class="adm-rbtn">
          <select data-od="${esc(o.ma)}" aria-label="Trạng thái đơn ${esc(o.ma)}">${Object.entries(TT).map(([k, v]) => `<option value="${k}" ${k === o.trangThai ? 'selected' : ''}>${v}</option>`).join('')}</select>
          <button type="button" class="adm-btn danger sm" data-act="od-del" data-ma="${esc(o.ma)}">Xoá</button>
        </div></li>`).join('') || '<li class="adm-note">Chưa có đơn nào.</li>'}</ul>`;
  }
  return `<form class="adm-form" id="adm-merch">
    <h3>Cài đặt mục Merch</h3>
    <label class="adm-switch"><input type="checkbox" name="hien" ${m.hien !== false ? 'checked' : ''}> Hiện danh sách sản phẩm trên trang Merch</label>
    <label class="adm-switch"><input type="checkbox" name="hienTrangChu" ${m.hienTrangChu !== false ? 'checked' : ''}> Hiện Merch trên trang chủ và thanh điều hướng</label>
    <label class="adm-switch"><input type="checkbox" name="moDon" ${m.moDon !== false ? 'checked' : ''}> Đang nhận đơn</label>
    <div class="adm-grid">
      ${field('tieuDe', 'Tiêu đề', m.tieuDe, { max: 120 })}
      ${field('moTa', 'Mô tả sản phẩm', m.moTa, { area: 1, wide: 1, rows: 3, max: 900 })}
      ${field('thongBaoDong', 'Thông báo khi chưa mở bán', m.thongBaoDong, { area: 1, wide: 1, rows: 2, max: 300 })}
      ${field('hanChot', 'Hạn chót đặt hàng (giờ Việt Nam)', m.hanChot, { type: 'datetime-local', hint: 'Quá hạn form tự đóng. Để trống nếu không có hạn.' })}
      ${field('hanChotChu', 'Hạn chót hiển thị', m.hanChotChu, { max: 80, ph: '20g00 · 10/12/2026' })}
      ${field('toiDa', 'Số món tối đa mỗi đơn', m.toiDa || 10, { type: 'number' })}
      ${field('doiTuong', '"Bạn đến từ" (mỗi dòng một lựa chọn)', (m.doiTuong || []).join('\n'), { area: 1, rows: 4, max: 400, hint: 'Lựa chọn đầu tiên là học sinh: bắt buộc nhập lớp và MSHS.' })}
      ${field('coSo', 'Nơi nhận hàng (mỗi dòng: Tên cơ sở | nơi nhận)', (m.coSo || []).map(c => `${c.ten} | ${c.noiNhan}`).join('\n'), { area: 1, wide: 1, rows: 3, max: 1000, hint: 'Ví dụ: Cơ sở An Đông | Văn phòng Đoàn, phòng ...' })}
      ${field('nhanHang', 'Thời gian nhận hàng', m.nhanHang, { max: 300, wide: 1, ph: 'Dự kiến 19–23/01/2027' })}
      ${field('ghiChu', 'Ghi chú dưới form', m.ghiChu, { area: 1, wide: 1, rows: 2, max: 600 })}
      ${field('linkBaiGoc', 'Link bài gốc trên fanpage', m.linkBaiGoc, { type: 'url', wide: 1 })}
    </div>
    <h3>Thanh toán chuyển khoản</h3>
    <p class="adm-note">Sau khi đặt hàng, người mua thấy mã QR và thông tin dưới đây, nội dung chuyển khoản là mã đơn (ví dụ BCH1A2B3C).</p>
    <div class="adm-grid">
      ${imgField('tt_anhQR', 'Ảnh mã QR tài khoản ngân hàng', T.anhQR, 'qr')}
      ${field('tt_nganHang', 'Ngân hàng', T.nganHang, { max: 80, ph: 'Ví dụ: Vietcombank' })}
      ${field('tt_soTK', 'Số tài khoản', T.soTK, { max: 30 })}
      ${field('tt_chuTK', 'Chủ tài khoản', T.chuTK, { max: 80, wide: 1 })}
      ${field('tt_huongDan', 'Hướng dẫn thêm (tuỳ chọn)', T.huongDan, { area: 1, wide: 1, rows: 2, max: 400 })}
    </div>
    <div class="adm-actions"><button class="adm-btn" type="submit">Lưu cài đặt Merch</button><a class="adm-btn ghost" href="./merch.html" target="_blank" rel="noopener">Xem trang Merch</a></div>
  </form>
  <div class="adm-form"><div class="adm-head2"><h3>Sản phẩm</h3><button class="adm-btn" type="button" data-act="sp-new">+ Thêm sản phẩm</button></div><ul class="adm-list">${spRows}</ul></div>
  <form class="adm-form" id="adm-sheet">
    <h3>Google Sheet nhận đơn</h3>
    <p class="adm-note">Khi người mua bấm "Tôi đã thanh toán", đơn được ghi lên Google Sheet. Đổi trạng thái đơn ở đây thì dòng trên Sheet cũng cập nhật. Cách cài: xem mục Google Sheet trong file hướng dẫn chỉnh sửa (dùng file <code>apps-script/don-merch.gs</code>).</p>
    ${!sheet ? '<p class="adm-note">Đang tải…</p>' : `<div class="adm-grid">
      ${field('url', 'URL ứng dụng web Apps Script (đuôi /exec)', sheet.url, { type: 'url', wide: 1, ph: 'https://script.google.com/macros/s/.../exec' })}
    </div>
    <p class="adm-note">Trạng thái: ${sheet.url ? 'đã kết nối' : 'chưa kết nối'}${sheet.coKhoa ? ' · đã có khoá bảo mật' : ''}.</p>
    <div class="adm-actions"><button class="adm-btn" type="submit">Lưu kết nối Sheet</button>
      <button class="adm-btn ghost" type="button" data-act="sh-khoa" ${sheet.coKhoa ? '' : 'disabled'}>Xem khoá bảo mật</button>
      <button class="adm-btn ghost" type="button" data-act="sh-sync" ${sheet.url ? '' : 'disabled'}>Ghi lại toàn bộ đơn lên Sheet</button></div>
    <p class="adm-note" id="sh-khoa-out"></p>`}
  </form>
  <div class="adm-form"><h3>Đơn đặt</h3>${od}</div>`;
}

function render() {
  const open = location.hash === '#admin';
  document.documentElement.classList.toggle('adm-open', open);
  if (!open) { root.innerHTML = ''; return; }
  if (!token) {
    root.innerHTML = `<div class="adm" role="dialog" aria-modal="true" aria-label="Quản trị website"><button class="adm-close" type="button" data-act="close" aria-label="Đóng">×</button>${viewLogin()}</div>`;
    root.querySelector('#adm-pw')?.focus();
    return;
  }
  if (!data) {
    root.innerHTML = `<div class="adm" role="dialog" aria-modal="true" aria-label="Quản trị website"><div class="adm-login"><p>Đang tải nội dung…</p></div></div>`;
    api('/api/kiem-tra').then(() => api('/api/noi-dung')).then(d => { data = d; data.vanBan ||= {}; data.lienHe ||= {}; render(); }).catch(e => { toast(e.message, true); });
    return;
  }
  const TABS = { tin: 'Bản tin', don: 'Đơn đang mở', clb: 'Câu lạc bộ', merch: 'Merch', vb: 'Văn bản & liên hệ', tk: 'Tài khoản' };
  const body = { tin: viewTin, don: viewDon, clb: viewClb, merch: viewMerch, vb: viewVanBan, tk: viewTk }[tab]();
  root.innerHTML = `<div class="adm" role="dialog" aria-modal="true" aria-label="Quản trị website">
    <header class="adm-top"><div><b>Quản trị website</b><small>Đoàn trường PTNK · thay đổi lên web ngay khi lưu</small></div>
      <div class="adm-topbtn"><a class="adm-btn ghost sm" href="./tin-tuc.html" target="_blank" rel="noopener">Xem danh mục</a><button class="adm-btn ghost sm" type="button" data-act="logout">Đăng xuất</button><button class="adm-btn sm" type="button" data-act="close">Đóng</button></div></header>
    <nav class="adm-tabs" aria-label="Mục quản trị">${Object.entries(TABS).map(([k, v]) => `<button type="button" data-tab="${k}" aria-pressed="${k === tab}">${v}</button>`).join('')}</nav>
    <div class="adm-body">${body}</div></div>`;
}

/* ---------- sự kiện ---------- */
const formObj = f => { const o = {}; new FormData(f).forEach((v, k) => { o[k] = typeof v === 'string' ? v.trim() : v; }); return o; };

root.addEventListener('click', async e => {
  const t = e.target.closest('button,[data-act]');
  if (!t) return;
  if (t.dataset.tab) { tab = t.dataset.tab; editing = null; if (tab === 'merch') { orders = null; sheet = null; } render(); return; }
  const act = t.dataset.act, i = +t.dataset.i;
  const listKey = tab === 'clb' ? 'clb' : 'banTin';
  if (act === 'close') { location.hash = ''; return; }
  if (act === 'logout') { try { await api('/api/dang-xuat', { method: 'POST' }); } catch (x) {} saveToken(null); data = null; render(); return; }
  if (act === 'cancel') { editing = null; render(); return; }
  if (act === 'new') { editing = { kind: tab === 'clb' ? 'clb' : 'tin', isNew: true, item: tab === 'clb' ? { loc: [] } : { nhom: 'pt', trangThai: 'done' } }; render(); return; }
  if (act === 'edit') { editing = { kind: tab === 'clb' ? 'clb' : 'tin', i, item: { ...data[listKey][i] } }; render(); return; }
  if (act === 'sp-new') { editing = { kind: 'sp', isNew: true, item: { con: true } }; render(); return; }
  if (act === 'sp-edit') { editing = { kind: 'sp', i, item: { ...data.merch.sanPham[i] } }; render(); return; }
  if (act === 'od-reload') { orders = null; render(); return; }
  if (act === 'sh-khoa') {
    try { const r = await api('/api/sheet/khoa'); const el = root.querySelector('#sh-khoa-out'); el.innerHTML = `Khoá bảo mật (dán vào dòng <code>KHOA</code> trong Apps Script): <code>${esc(r.khoa)}</code>`; }
    catch (x) { toast(x.message, true); }
    return;
  }
  if (act === 'sh-sync') {
    t.disabled = true;
    try { const r = await api('/api/sheet/dong-bo', { method: 'POST', body: '{}' }); toast(r.thongBao || 'Đã ghi lên Sheet'); orders = null; render(); }
    catch (x) { toast(x.message, true); t.disabled = false; }
    return;
  }
  if (act === 'od-csv') {
    const q = v => { let x = String(v ?? ''); if (/^[=+\-@\t\r]/.test(x)) x = "'" + x; return `"${x.replace(/"/g, '""')}"`; }; // chặn chèn công thức Excel
    const rows = [['Mã', 'Thời gian', 'Họ tên', 'Đến từ', 'Lớp', 'MSHS', 'SĐT', 'Email', 'Nhận tại', 'Chi tiết', 'Số món', 'Tổng tiền', 'Ghi chú', 'Trạng thái']]
      .concat(orders.map(o => [o.ma, o.luc, o.hoTen, o.doiTuong, o.lop, o.mshs, "'" + o.sdt, o.email, o.coSo, o.items.map(it => `${[it.ten, it.tuyChon, it.size].filter(Boolean).join(' ')} x${it.sl}`).join('; '), o.soAo, o.tongTien, o.ghiChu, TT[o.trangThai]]));
    const blob = new Blob(['\ufeff' + rows.map(r => r.map(q).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `don-merch-${today()}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000); return;
  }
  if (act === 'sp-del' || act === 'od-del') {
    if (t.dataset.sure !== '1') { t.dataset.sure = '1'; t.textContent = 'Bấm lần nữa để xoá'; setTimeout(() => { if (t.isConnected) { t.dataset.sure = ''; t.textContent = 'Xoá'; } }, 4000); return; }
    if (act === 'sp-del') {
      const removed = data.merch.sanPham.splice(i, 1);
      if (!(await save('Đã xoá sản phẩm'))) data.merch.sanPham.splice(i, 0, ...removed);
      render(); return;
    }
    try { await api(`/api/don-hang/${encodeURIComponent(t.dataset.ma)}`, { method: 'DELETE' }); toast('Đã xoá đơn'); orders = null; render(); }
    catch (x) { toast(x.message, true); }
    return;
  }
  if (act === 'up' || act === 'down') {
    const arr = data[listKey], j = act === 'up' ? i - 1 : i + 1;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    if (!(await save('Đã đổi thứ tự'))) [arr[i], arr[j]] = [arr[j], arr[i]];
    render(); return;
  }
  if (act === 'del') {
    if (t.dataset.sure !== '1') { t.dataset.sure = '1'; t.textContent = 'Bấm lần nữa để xoá'; setTimeout(() => { if (t.isConnected) { t.dataset.sure = ''; t.textContent = 'Xoá'; } }, 4000); return; }
    const removed = data[listKey].splice(i, 1);
    if (!(await save('Đã xoá'))) data[listKey].splice(i, 0, ...removed);
    render(); return;
  }
  if (act === 'backup') {
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `sao-luu-web-doan-${today()}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000); return;
  }
  if (t.classList.contains('adm-clearimg')) {
    const box = t.closest('[data-img]');
    box.querySelector('input[type=hidden]').value = '';
    box.querySelector('.adm-prev').innerHTML = '<em>Chưa có ảnh</em>';
    t.remove();
  }
});

root.addEventListener('change', async e => {
  const inp = e.target;
  if (inp.name === 'nhom' && editing?.kind === 'tin') {
    const nhan = root.querySelector('[name=nhan]');
    if (Object.values(NHAN).includes(nhan.value) || !nhan.value) nhan.value = NHAN[inp.value];
  }
  if (inp.dataset.od) {
    try { await api(`/api/don-hang/${encodeURIComponent(inp.dataset.od)}`, { method: 'PATCH', body: JSON.stringify({ trangThai: inp.value }) });
      const o = orders.find(x => x.ma === inp.dataset.od); if (o) o.trangThai = inp.value; toast('Đã cập nhật trạng thái đơn'); render(); }
    catch (x) { toast(x.message, true); }
    return;
  }
  if (inp.type !== 'file' || !inp.files[0]) return;
  const box = inp.closest('[data-img]'), file = inp.files[0];
  if (file.size > 8e6) { toast('Ảnh tối đa 8 MB', true); return; }
  const prev = box.querySelector('.adm-prev');
  prev.innerHTML = '<em>Đang tải ảnh lên…</em>';
  const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  try {
    const out = await api('/api/anh', { method: 'POST', body: JSON.stringify({ data: b64, loai: box.dataset.loai }) });
    box.querySelector('input[type=hidden]').value = out.anh;
    prev.innerHTML = `<img src="${esc(G().imgUrl(out.anh))}" alt="">`;
  } catch (x) { prev.innerHTML = '<em>Tải ảnh thất bại</em>'; toast(x.message, true); }
});

root.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  if (f.id === 'adm-login-form') {
    const err = root.querySelector('#adm-login-err'), btn = f.querySelector('button');
    btn.disabled = true; btn.textContent = 'Đang kiểm tra…'; err.textContent = '';
    try {
      const out = await api('/api/dang-nhap', { method: 'POST', body: JSON.stringify({ matKhau: root.querySelector('#adm-pw').value }) });
      saveToken(out.token); data = null; render();
    } catch (x) { err.textContent = x.message; btn.disabled = false; btn.textContent = 'Đăng nhập'; }
    return;
  }
  const o = formObj(f);
  if (f.id === 'adm-edit' && editing.kind === 'tin') {
    const old = editing.isNew ? {} : data.banTin[editing.i];
    const item = { ...old, tieuDe: o.tieuDe, moTa: o.moTa, nhom: o.nhom, nhan: o.nhan || NHAN[o.nhom], ngay: toVNDate(o.ngay) || old.ngay || '',
      trangThai: o.trangThai, link: o.link, anh: o.anh };
    if (o.han) item.han = o.han + ':00+07:00'; else delete item.han;
    if (editing.isNew) { item.id = 'w' + Date.now().toString(36); data.banTin.unshift(item); } else data.banTin[editing.i] = item;
    const snapshot = editing;
    if (await save(snapshot.isNew ? 'Đã đăng bài lên web' : 'Đã lưu bài')) { editing = null; render(); }
    else { if (snapshot.isNew) data.banTin.shift(); else data.banTin[snapshot.i] = old; }
    return;
  }
  if (f.id === 'adm-edit' && editing.kind === 'clb') {
    const item = { ten: o.ten, linhVuc: o.linhVuc, loc: [...f.querySelectorAll('[name=loc]:checked')].map(x => x.value), link: o.link, anh: o.anh };
    if (!item.loc.length) { toast('Chọn ít nhất một nhóm cho CLB', true); return; }
    const old = editing.isNew ? null : data.clb[editing.i];
    if (editing.isNew) data.clb.push(item); else data.clb[editing.i] = item;
    const snap = editing;
    if (await save(snap.isNew ? 'Đã thêm CLB' : 'Đã lưu CLB')) { editing = null; render(); }
    else { if (snap.isNew) data.clb.pop(); else data.clb[snap.i] = old; }
    return;
  }
  if (f.id === 'adm-edit' && editing.kind === 'sp') {
    const arr = data.merch.sanPham, old = editing.isNew ? {} : arr[editing.i];
    const split = v => (v || '').split(',').map(x => x.trim()).filter(Boolean);
    const item = { ...old, ten: o.ten, gia: Number(o.gia) || 0, tuyChon: split(o.tuyChon), sizes: split(o.sizes), moTa: o.moTa, anh: o.anh, con: !!f.querySelector('[name=con]').checked };
    if (editing.isNew) { item.id = 'm' + Date.now().toString(36); arr.push(item); } else arr[editing.i] = item;
    const snap = editing;
    if (await save(snap.isNew ? 'Đã thêm sản phẩm' : 'Đã lưu sản phẩm')) { editing = null; render(); }
    else { if (snap.isNew) arr.pop(); else arr[snap.i] = old; }
    return;
  }
  if (f.id === 'adm-sheet') {
    try { await api('/api/sheet', { method: 'PUT', body: JSON.stringify({ url: o.url }) }); toast('Đã lưu kết nối Google Sheet'); sheet = null; render(); }
    catch (x) { toast(x.message, true); }
    return;
  }
  if (f.id === 'adm-merch') {
    const old = data.merch;
    data.merch = { ...old, hien: !!f.querySelector('[name=hien]').checked, moDon: !!f.querySelector('[name=moDon]').checked,
      hienTrangChu: !!f.querySelector('[name=hienTrangChu]').checked, thongBaoDong: o.thongBaoDong,
      thanhToan: { anhQR: o.tt_anhQR, nganHang: o.tt_nganHang, soTK: o.tt_soTK, chuTK: o.tt_chuTK, huongDan: o.tt_huongDan },
      tieuDe: o.tieuDe, moTa: o.moTa, hanChot: o.hanChot, hanChotChu: o.hanChotChu,
      nhanHang: o.nhanHang, ghiChu: o.ghiChu, linkBaiGoc: o.linkBaiGoc, toiDa: Number(o.toiDa) || 10,
      doiTuong: o.doiTuong.split('\n').map(x => x.trim()).filter(Boolean),
      coSo: o.coSo.split('\n').map(x => x.trim()).filter(Boolean).map((line, k) => {
        const [ten, ...rest] = line.split('|'); const prev = (old.coSo || []).find(c => c.ten === ten.trim()) || (old.coSo || [])[k];
        return { id: prev?.id || 'cs' + k, ten: ten.trim(), noiNhan: rest.join('|').trim() };
      }) };
    if (!(await save('Đã lưu cài đặt Merch'))) data.merch = old;
    render(); return;
  }
  if (f.id === 'adm-don') {
    const old = data.moDon;
    data.moDon = { ...old, hien: !!f.querySelector('[name=hien]').checked, tieuDe: o.tieuDe, moTa: o.moTa, hanChot: o.hanChot, hanChotChu: o.hanChotChu,
      linkDon: o.linkDon, linkMoTa: o.linkMoTa, linkBaiGoc: o.linkBaiGoc, anh: o.anh };
    if (!(await save('Đã lưu đơn đang mở'))) data.moDon = old;
    render(); return;
  }
  if (f.id === 'adm-vb') {
    const old = structuredClone({ vb: data.vanBan, lk: data.lienKet, lh: data.lienHe });
    VB.forEach(([k]) => { data.vanBan[k] = o['vb_' + k] || ''; });
    data.lienKet = { webTruong: o.lk_webTruong, traCuuDoanVien: o.lk_traCuuDoanVien };
    data.lienHe = { email: o.lh_email, messenger: o.lh_messenger, fanpage: o.lh_fanpage };
    if (!(await save('Đã lưu văn bản và liên kết'))) { data.vanBan = old.vb; data.lienKet = old.lk; data.lienHe = old.lh; }
    render(); return;
  }
  if (f.id === 'adm-pwform') {
    try {
      await api('/api/doi-mat-khau', { method: 'POST', body: JSON.stringify({ cu: root.querySelector('#adm-cu').value, moi: root.querySelector('#adm-moi').value }) });
      saveToken(null); data = null; render(); toast('Đã đổi mật khẩu. Đăng nhập lại bằng mật khẩu mới.');
    } catch (x) { toast(x.message, true); }
  }
});

addEventListener('hashchange', render);
addEventListener('keydown', e => { if (e.key === 'Escape' && location.hash === '#admin' && !editing) location.hash = ''; });
if (document.readyState === 'loading') addEventListener('DOMContentLoaded', () => { if (location.hash === '#admin') render(); }); else if (location.hash === '#admin') render();
})();
