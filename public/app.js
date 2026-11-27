// Giao diện website Đoàn trường PTNK.
// Nội dung lấy từ máy chủ (/api/noi-dung, quản lý tại /#admin); nếu máy chủ chưa phản hồi thì dùng bản dự phòng noi-dung.js.
(() => {
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const safeUrl = u => /^(https?:|mailto:)/i.test(String(u || '')) ? String(u) : '';

/* Địa chỉ máy chủ: thẻ <meta name="api-base"> được thay khi triển khai */
const rawBase = document.querySelector('meta[name="api-base"]')?.content || '';
const API = rawBase.startsWith('__PORT_') ? '' : rawBase.replace(/\/$/, '');
const imgUrl = a => !a ? '' : a.startsWith('up/') ? `${API}/${a}` : `./assets/${a}`;
window.DOAN = { API, imgUrl, esc, safeUrl };

if (location.pathname === '/merch' && $('[data-merch-teaser]')) location.replace('/merch');
let D = window.NOI_DUNG;
const norm = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase();
const STATUS = { open: 'Đang mở', done: 'Đã kết thúc' };

/* ---------- Văn bản & liên hệ ---------- */
function renderText() {
  const vb = D.vanBan || {};
  $$('[data-vb]').forEach(el => { const v = vb[el.dataset.vb]; if (v) el.textContent = v; });
  $$('[data-vb-href]').forEach(el => { const v = safeUrl(vb[el.dataset.vbHref]); if (v) el.href = v; });
  const lh = D.lienHe || {};
  const em = $('#lh-email');
  if (em && lh.email) { em.href = 'mailto:' + lh.email; em.textContent = lh.email; }
  if ($('#lh-messenger') && safeUrl(lh.messenger)) $('#lh-messenger').href = lh.messenger;
  if ($('#lh-fanpage') && safeUrl(lh.fanpage)) $('#lh-fanpage').href = lh.fanpage;
}

/* ---------- Đơn đang mở ---------- */
let tickTimer;
function renderMoDon() {
  const sec = $('[data-mo-don]');
  if (!sec) return;
  const M = D.moDon || {};
  sec.hidden = M.hien === false;
  $$('a[href="/mo-don"]').forEach(a => { a.hidden = M.hien === false; });
  $('#md-tieude').textContent = M.tieuDe || '';
  $('#md-mota').textContent = M.moTa || '';
  $('#md-han').textContent = M.hanChotChu || '';
  if (M.anh) $('#md-anh').src = imgUrl(M.anh);
  [['#ctv-form', M.linkDon], ['#md-jd', M.linkMoTa], ['#md-goc', M.linkBaiGoc]].forEach(([s, u]) => {
    const el = $(s); const v = safeUrl(u);
    el.hidden = !v; if (v) el.href = v;
  });
  const DEADLINE = M.hanChot ? new Date(M.hanChot + ':00+07:00').getTime() : NaN;
  const countEl = $('#ctv-count'), statusEl = $('#ctv-status');
  const tick = () => {
    const ms = DEADLINE - Date.now();
    if (!(ms > 0)) {
      countEl.textContent = 'Đơn đã đóng';
      statusEl.textContent = 'Đã đóng đơn';
      statusEl.classList.remove('live');
      return;
    }
    statusEl.textContent = 'Đang mở đơn';
    statusEl.classList.add('live');
    const d = Math.floor(ms / 864e5), h = Math.floor(ms / 36e5) % 24, m = Math.floor(ms / 6e4) % 60;
    countEl.textContent = d > 0 ? `Còn ${d} ngày ${h} giờ` : `Còn ${h} giờ ${m} phút`;
  };
  clearInterval(tickTimer);
  tick();
  tickTimer = setInterval(tick, 30000);
}

/* ---------- Lối tắt ---------- */
function renderLoiTat() {
  const t = $('#lk-truong');
  if (!t) return;
  t.href = safeUrl(D.lienKet?.webTruong) || 'https://ptnk.edu.vn/';
  const dv = $('#lk-doanvien');
  const u = safeUrl(D.lienKet?.traCuuDoanVien);
  if (u) {
    dv.href = u; dv.classList.remove('pending'); dv.removeAttribute('aria-disabled');
    $('#lk-dv-note').textContent = 'Kiểm tra thông tin Đoàn viên, chi đoàn và quá trình sinh hoạt Đoàn của bạn';
    dv.querySelector('b').textContent = '↗';
  } else {
    dv.removeAttribute('href'); dv.classList.add('pending'); dv.setAttribute('aria-disabled', 'true');
    $('#lk-dv-note').textContent = 'Ban Chấp hành đang cập nhật đường dẫn tra cứu. Cần hỗ trợ, nhắn fanpage Đoàn trường nhé.';
    dv.querySelector('b').textContent = '…';
  }
}

/* ---------- Bản tin ---------- */
const list = $('#cards');
const HOME = list?.dataset.mode === 'home';
let cat = new URLSearchParams(location.search).get('nhom') || 'all', limit = 12;
const card = n => `
      <article class="card c-${esc(n.nhom)}">
        <a href="${esc(safeUrl(n.link) || '/tin-tuc')}" target="_blank" rel="noopener noreferrer">
          <div class="thumb">${n.anh ? `<img loading="lazy" src="${esc(imgUrl(n.anh))}" alt="">` : '<span class="noimg" aria-hidden="true">Đoàn trường PTNK</span>'}</div>
          <div class="body">
            <div class="meta"><span class="tag">${esc(n.nhan)}</span><span class="st ${esc(n.trangThai)}">${STATUS[n.trangThai] || ''}</span></div>
            <h3>${esc(n.tieuDe)}</h3>
            <p>${esc(n.moTa)}</p>
            <div class="foot-row"><small>${esc(n.ngay)}</small><span>${n.link ? 'Xem trên fanpage ↗' : ''}</span></div>
          </div>
        </a>
      </article>`;
const getNews = () => (D.banTin || []).map(n => ({ ...n, trangThai: n.trangThai === 'open' && n.han && Date.now() > new Date(n.han).getTime() ? 'done' : n.trangThai }));
function renderNews() {
  if (!list) return;
  const news = getNews();
  const sync = $('#news-sync');
  if (sync) sync.textContent = 'Các bài đăng từ fanpage Đoàn trường Phổ thông Năng khiếu, ĐHQG-HCM';
  if (HOME) {
    list.innerHTML = news.slice(0, 6).map(card).join('');
    const all = $('#news-all');
    if (all) { all.textContent = `Xem tất cả ${news.length} bài trong danh mục →`; all.hidden = news.length <= 6; }
    return;
  }
  const q = $('#news-q'), k = norm(q ? q.value.trim() : '');
  const shown = news.filter(n => (cat === 'all' || n.nhom === cat) && (!k || norm(n.tieuDe + ' ' + n.moTa).includes(k)));
  list.innerHTML = shown.slice(0, limit).map(card).join('') || '<p class="empty">Không tìm thấy bài phù hợp.</p>';
  const more = $('#news-more');
  more.hidden = shown.length <= limit;
  more.textContent = `Xem thêm bài (${shown.length - limit})`;
  $('#news-count').textContent = `Đang hiển thị ${Math.min(limit, shown.length)}/${shown.length} bài`;
  $$('[data-cat]').forEach(b => {
    const c = b.dataset.cat;
    const n = c === 'all' ? news.length : news.filter(x => x.nhom === c).length;
    b.hidden = !n;
    let badge = b.querySelector('.n');
    if (!badge) { badge = document.createElement('span'); badge.className = 'n'; b.append(' ', badge); }
    badge.textContent = n;
    b.setAttribute('aria-pressed', String(c === cat));
  });
}
if (list && !HOME) {
  $$('[data-cat]').forEach(b => b.addEventListener('click', () => { cat = b.dataset.cat; limit = 12; renderNews(); }));
  $('#news-q')?.addEventListener('input', () => { limit = 12; renderNews(); });
  $('#news-more').addEventListener('click', () => { limit += 12; renderNews(); });
}

/* ---------- Câu lạc bộ ---------- */
let loc = 'all';
function renderClubs() {
  const ul = $('#clb-list');
  if (!ul) return;
  const clubs = D.clb || [];
  $('#clb-total').textContent = clubs.length;
  $$('[data-loc]').forEach(b => {
    const k = b.dataset.loc;
    let badge = b.querySelector('.n');
    if (!badge) { badge = document.createElement('span'); badge.className = 'n'; b.append(' ', badge); }
    badge.textContent = k === 'all' ? clubs.length : clubs.filter(c => c.loc.includes(k)).length;
  });
  const q = norm($('#clb-q').value.trim());
  const shown = clubs.filter(c => (loc === 'all' || c.loc.includes(loc)) && (!q || norm(c.ten + ' ' + c.linhVuc).includes(q)));
  ul.innerHTML = shown.map(c => {
    const badge = c.anh
      ? `<img class="cavatar" src="${esc(imgUrl(c.anh))}" alt="" loading="lazy" width="48" height="48">`
      : `<span class="cbadge b-${esc(c.loc[0])}" aria-hidden="true">${esc(c.ten.replace(/^(PTNK|The)\s+/i, '').charAt(0))}</span>`;
    const inner = `${badge}
      <span class="ctext"><strong>${esc(c.ten)}</strong><small>${esc(c.linhVuc)}</small></span>${safeUrl(c.link) ? '<b aria-hidden="true">↗</b>' : ''}`;
    return `<li>${safeUrl(c.link) ? `<a href="${esc(c.link)}" target="_blank" rel="noopener noreferrer">${inner}</a>` : `<div>${inner}</div>`}</li>`;
  }).join('') || '<li class="empty">Không tìm thấy CLB phù hợp.</li>';
  $('#clb-count').textContent = `Đang hiển thị ${shown.length}/${clubs.length} CLB`;
}
if ($('#clb-list')) {
  $$('[data-loc]').forEach(b => b.addEventListener('click', () => {
    $$('[data-loc]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    loc = b.dataset.loc;
    renderClubs();
  }));
  $('#clb-q').addEventListener('input', renderClubs);
}


/* ---------- Merch: cửa hàng, giỏ hàng, thanh toán ---------- */
const vnd = n => Number(n || 0).toLocaleString('vi-VN') + 'đ';
const merchOpen = M => M.moDon && (!M.hanChot || Date.now() < new Date(M.hanChot + ':00+07:00').getTime());
const avail = M => (M.sanPham || []).filter(p => p.con !== false);
const spOf = (M, id) => (M.sanPham || []).find(p => p.id === id);
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
let cart = store.get('mc-gio', []), merchBound = false, toastT = 0;
const cartKey = l => [l.sp, l.tuyChon, l.size].join('|');
const cartN = () => cart.reduce((a, l) => a + l.sl, 0);
const cartTien = M => cart.reduce((a, l) => a + l.sl * ((spOf(M, l.sp) || {}).gia || 0), 0);
const lineName = (M, l) => [(spOf(M, l.sp) || {}).ten, l.tuyChon, l.size && 'size ' + l.size].filter(Boolean).join(' · ');
const saveCart = () => store.set('mc-gio', cart);
function toastMc(t) {
  const el = $('#mc-toast'); if (!el) return;
  el.textContent = t; el.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), 2200);
}
function cleanCart(M) {
  cart = cart.filter(l => { const p = spOf(M, l.sp); return p && p.con !== false && (!(p.tuyChon || []).length || p.tuyChon.includes(l.tuyChon)) && (!(p.sizes || []).length || p.sizes.includes(l.size)); });
}
function renderCart(M) {
  const n = cartN(), tien = cartTien(M), toiDa = M.toiDa || 10;
  $('#mc-cart-list').innerHTML = cart.map((l, i) => {
    const p = spOf(M, l.sp) || {};
    return `<li class="cart-it">
      ${p.anh ? `<img src="${esc(imgUrl(p.anh))}" alt="" loading="lazy">` : '<span></span>'}
      <div><strong>${esc(p.ten)}</strong>${l.tuyChon || l.size ? `<small>${esc([l.tuyChon, l.size && 'Size ' + l.size].filter(Boolean).join(' · '))}</small>` : ''}<b>${vnd(p.gia * l.sl)}</b></div>
      <div class="qty sm"><button type="button" data-cq="${i}" data-d="-1" aria-label="Bớt một">−</button><span aria-label="Số lượng">${l.sl}</span><button type="button" data-cq="${i}" data-d="1" aria-label="Thêm một" ${n >= toiDa ? 'disabled' : ''}>+</button></div>
      <button type="button" class="cart-rm" data-crm="${i}" aria-label="Bỏ ${esc(p.ten)} khỏi giỏ">Bỏ</button>
    </li>`;
  }).join('');
  $('#mc-cart-empty').hidden = !!cart.length;
  $('#mc-sum-sl').textContent = `${n} món`;
  $('#mc-sum-tien').textContent = vnd(tien);
  $('#mc-toida').textContent = `Tối đa ${toiDa} món mỗi đơn.`;
  $('#mc-checkout').disabled = !cart.length;
  $('#mc-bar-sl').textContent = `${n} món`;
  $('#mc-bar-tien').textContent = vnd(tien);
  $('#mc-cartbar').classList.toggle('has', n > 0);
}
function cardHtml(M, p, open) {
  const tc = p.tuyChon || [], sz = p.sizes || [], can = open && p.con !== false;
  return `<li class="mc-item${p.con === false ? ' out' : ''}" data-id="${esc(p.id)}">
    <div class="mc-img">${p.anh ? `<img src="${esc(imgUrl(p.anh))}" alt="${esc(p.ten)}" loading="lazy">` : ''}${p.con === false ? '<span>Tạm hết</span>' : ''}</div>
    <strong>${esc(p.ten)}</strong><b class="mc-gia">${vnd(p.gia)}</b><small>${esc(p.moTa)}</small>
    ${can ? `<div class="mc-pickopts">
      ${tc.length ? `<label><span>Mẫu</span><select data-o="tuyChon">${tc.map(z => `<option>${esc(z)}</option>`).join('')}</select></label>` : ''}
      ${sz.length ? `<label class="sz"><span>Size</span><select data-o="size">${sz.map((z, k) => `<option ${k === Math.min(1, sz.length - 1) ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select></label>` : ''}
    </div>
    <div class="mc-buy"><div class="qty"><button type="button" data-q="-1" aria-label="Bớt một">−</button><input data-o="sl" type="number" min="1" max="10" value="1" inputmode="numeric" aria-label="Số lượng ${esc(p.ten)}"><button type="button" data-q="1" aria-label="Thêm một">+</button></div>
      <button type="button" class="btn primary mc-addcart" data-add="${esc(p.id)}">Thêm vào giỏ</button></div>`
    : (tc.length || sz.length ? `<small class="mc-opt">${[tc.length ? `${tc.length} mẫu` : '', sz.length ? `size ${sz.join(', ')}` : ''].filter(Boolean).join(' · ')}</small>` : '')}
  </li>`;
}
function renderMerch() {
  const M = D.merch;
  const show = !!(M && M.hien !== false && (M.sanPham || []).length);
  const onHome = show && M.hienTrangChu !== false;
  $$('nav a[href="/merch"]:not([aria-current])').forEach(a => { a.hidden = !onHome; });
  const tz = $('[data-merch-teaser]');
  if (tz) {
    tz.hidden = !onHome;
    if (onHome) {
      $('#mct-tieude').textContent = M.tieuDe || 'Merch PTNK';
      const gias = M.sanPham.map(p => p.gia).filter(Boolean);
      $('#mct-gia').textContent = `${M.sanPham.length} sản phẩm` + (gias.length ? ` · từ ${vnd(Math.min(...gias))}` : '') + (merchOpen(M) ? ' · Đang nhận đơn' : '');
      const first = M.sanPham.find(p => p.anh);
      if (first) $('#mct-img').src = imgUrl(first.anh);
      $('#mct-btn').textContent = merchOpen(M) ? 'Vào cửa hàng →' : 'Xem sản phẩm →';
    }
  }
  if (!$('[data-merch]')) return;
  const open = !!(show && merchOpen(M) && avail(M).length);
  const closed = $('#mc-closed');
  closed.hidden = open;
  closed.textContent = show ? (M.thongBaoDong || 'Hiện chưa mở bán. Theo dõi fanpage Đoàn trường để nhận thông báo.') : 'Hiện Đoàn trường chưa mở bán merch. Theo dõi fanpage để nhận thông báo.';
  $('#mc-shop').hidden = !show;
  $('#mc-shop').classList.toggle('is-open', open);
  $('#mc-cart').hidden = !open;
  $('#mc-cartbar').hidden = !open;
  const pend = store.get('mc-don-cho', null);
  $('#mc-pending').hidden = !pend;
  if (pend) $('#mc-pending-ma').textContent = pend.ma;
  if (!show) { $('#mc-mota').textContent = ''; return; }
  $('#mc-tieude').textContent = M.tieuDe || 'Merch PTNK';
  $('#mc-mota').textContent = M.moTa || '';
  const st = $('#mc-status');
  st.hidden = !open;
  st.textContent = 'Đang nhận đơn' + (M.hanChotChu ? ` · hạn ${M.hanChotChu}` : '') + (M.nhanHang ? ` · nhận hàng ${M.nhanHang}` : '');
  st.classList.add('live');
  $('#mc-list').innerHTML = M.sanPham.map(p => cardHtml(M, p, open)).join('');
  if (open) { cleanCart(M); saveCart(); renderCart(M); }
  bindMerch();
}

/* Hộp thoại đặt hàng: thông tin → thanh toán → hoàn tất */
function step(name) {
  $$('#mc-dlg .dlg-step').forEach(el => { el.hidden = el.dataset.step !== name; });
  const order = ['info', 'pay', 'done'], k = order.indexOf(name);
  $$('#mc-dlg .steps li').forEach((li, i) => { li.classList.toggle('on', i === k); li.classList.toggle('past', i < k); });
  const dlg = $('#mc-dlg');
  if (!dlg.open) dlg.showModal();
  dlg.scrollTop = 0;
}
function fillInfo(M) {
  const dtSel = $('#mc-doituong'), dts = M.doiTuong || ['Học sinh PTNK'], cur = dtSel.value;
  dtSel.innerHTML = dts.map(x => `<option ${x === cur ? 'selected' : ''}>${esc(x)}</option>`).join('');
  const hs = () => { const on = dtSel.value === dts[0]; $$('[data-hs]').forEach(l => { l.hidden = !on; }); };
  hs(); dtSel.onchange = hs;
  const curCs = ($('#mc-form [name=coSo]:checked') || {}).value;
  $('#mc-coso').innerHTML = (M.coSo || []).map(c => `<label class="mc-cs"><input type="radio" name="coSo" value="${esc(c.id)}" ${c.id === curCs ? 'checked' : ''}><span><b>${esc(c.ten)}</b><small>${esc(c.noiNhan)}</small></span></label>`).join('');
  $('#mc-review').innerHTML = cart.map(l => `<li><span>${esc(lineName(M, l))} × ${l.sl}</span><b>${vnd(l.sl * (spOf(M, l.sp) || {}).gia)}</b></li>`).join('');
  $('#mc-rv-sl').textContent = `${cartN()} món`;
  $('#mc-rv-tien').textContent = vnd(cartTien(M));
  $('#mc-ghichu').textContent = M.ghiChu || '';
  $('#mc-msg').textContent = '';
}
function copyBtn(v, label) {
  return `<button type="button" class="copy" data-copy="${esc(v)}" aria-label="Sao chép ${esc(label)}">Sao chép</button>`;
}
function showPay(don) {
  const T = (D.merch || {}).thanhToan || {};
  $('#mc-pay-ma').textContent = don.ma;
  $('#mc-qr').innerHTML = T.anhQR ? `<img src="${esc(imgUrl(T.anhQR))}" alt="Mã QR chuyển khoản ${esc(T.nganHang || '')}"><figcaption>Quét bằng app ngân hàng</figcaption>`
    : '<figcaption>Ban Chấp hành chưa tải mã QR. Hãy chuyển khoản theo thông tin bên cạnh.</figcaption>';
  const rows = [
    T.nganHang && ['Ngân hàng', esc(T.nganHang)],
    T.soTK && ['Số tài khoản', `<span class="mono">${esc(T.soTK)}</span>${copyBtn(T.soTK, 'số tài khoản')}`],
    T.chuTK && ['Chủ tài khoản', esc(T.chuTK)],
    ['Số tiền', `<b>${vnd(don.tongTien)}</b>${copyBtn(String(don.tongTien), 'số tiền')}`],
    ['Nội dung chuyển khoản', `<span class="mono">${esc(don.ma)}</span>${copyBtn(don.ma, 'nội dung chuyển khoản')}`],
  ].filter(Boolean);
  $('#mc-payinfo').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  $('#mc-huongdan').textContent = T.huongDan || 'Sau khi chuyển khoản xong, bấm "Tôi đã thanh toán". Ban Chấp hành kiểm tra và gửi email xác nhận cho bạn.';
  $('#mc-pay-msg').textContent = '';
  step('pay');
}
function bindMerch() {
  if (merchBound) return;
  merchBound = true;
  const list = $('#mc-list'), dlg = $('#mc-dlg'), f = $('#mc-form');
  list.addEventListener('click', e => {
    const q = e.target.closest('[data-q]');
    if (q) { const inp = q.parentElement.querySelector('input'); inp.value = Math.max(1, Math.min(10, (parseInt(inp.value, 10) || 1) + +q.dataset.q)); return; }
    const b = e.target.closest('[data-add]');
    if (!b) return;
    const M = D.merch, card = b.closest('.mc-item'), p = spOf(M, b.dataset.add);
    const get = k => card.querySelector(`[data-o="${k}"]`)?.value || '';
    const sl = Math.max(1, Math.min(10, parseInt(get('sl'), 10) || 1));
    const l = { sp: p.id, tuyChon: (p.tuyChon || []).length ? get('tuyChon') : '', size: (p.sizes || []).length ? get('size') : '', sl };
    const toiDa = M.toiDa || 10;
    if (cartN() + sl > toiDa) { toastMc(`Mỗi đơn tối đa ${toiDa} món.`); return; }
    const same = cart.find(x => cartKey(x) === cartKey(l));
    if (same) same.sl += sl; else cart.push(l);
    saveCart(); renderCart(M);
    toastMc(`Đã thêm ${lineName(M, l)} × ${sl} vào giỏ`);
    b.classList.add('done'); setTimeout(() => b.classList.remove('done'), 900);
  });
  $('#mc-cart').addEventListener('click', e => {
    const M = D.merch, q = e.target.closest('[data-cq]'), rm = e.target.closest('[data-crm]');
    if (q) { const l = cart[+q.dataset.cq]; l.sl += +q.dataset.d; if (l.sl < 1) cart.splice(+q.dataset.cq, 1); }
    else if (rm) cart.splice(+rm.dataset.crm, 1);
    else return;
    saveCart(); renderCart(M);
  });
  const cartEl = $('#mc-cart');
  $('#mc-cartbar').addEventListener('click', () => { cartEl.classList.add('show'); document.documentElement.classList.add('cart-lock'); });
  $('#mc-cart-x').addEventListener('click', () => { cartEl.classList.remove('show'); document.documentElement.classList.remove('cart-lock'); });
  $('#mc-checkout').addEventListener('click', () => {
    if (!cart.length) return;
    cartEl.classList.remove('show'); document.documentElement.classList.remove('cart-lock');
    fillInfo(D.merch); step('info');
    setTimeout(() => f.querySelector('[name=hoTen]').focus(), 50);
  });
  $('#mc-pending-go').addEventListener('click', () => { const p = store.get('mc-don-cho', null); if (p) showPay(p); });
  dlg.addEventListener('click', e => {
    if (e.target.closest('[data-close]') || e.target.id === 'mc-dlg-x') { dlg.close(); return; }
    const c = e.target.closest('[data-copy]');
    if (c) {
      const done = () => { c.textContent = 'Đã chép'; setTimeout(() => { c.textContent = 'Sao chép'; }, 1500); };
      navigator.clipboard?.writeText(c.dataset.copy).then(done, () => {});
    }
  });
  dlg.addEventListener('close', () => renderMerch());
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const msg = $('#mc-msg'), btn = $('#mc-submit'), M = D.merch;
    const fd = new FormData(f);
    const isHs = fd.get('doiTuong') === (M.doiTuong || ['Học sinh PTNK'])[0];
    const body = { hoTen: fd.get('hoTen').trim(), doiTuong: fd.get('doiTuong'), lop: isHs ? fd.get('lop').trim() : '', mshs: isHs ? fd.get('mshs').trim() : '',
      coSo: fd.get('coSo') || '', sdt: fd.get('sdt').trim(), email: fd.get('email').trim(),
      ghiChu: fd.get('ghiChu').trim(), web: fd.get('web'), items: cart.map(l => ({ sp: l.sp, tuyChon: l.tuyChon, size: l.size, sl: l.sl })) };
    const bad = t => { msg.textContent = t; msg.className = 'mc-msg bad'; };
    if (body.hoTen.length < 2) return bad('Vui lòng nhập họ tên.');
    if (!/^(\+?84|0)\d{9,10}$/.test(body.sdt.replace(/[\s.-]/g, ''))) return bad('Số điện thoại chưa đúng.');
    if (isHs && !body.lop) return bad('Vui lòng nhập lớp.');
    if (isHs && !/^\d{4,8}$/.test(body.mshs)) return bad('Vui lòng nhập mã số học sinh (chỉ gồm chữ số).');
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(body.email)) return bad('Vui lòng nhập email để nhận xác nhận đơn.');
    if (!body.coSo) return bad('Vui lòng chọn cơ sở nhận hàng.');
    btn.disabled = true; btn.textContent = 'Đang tạo đơn…'; msg.textContent = '';
    try {
      const r = await fetch(`${API}/api/don-hang`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof out.detail === 'string' ? out.detail : 'Đặt hàng chưa được, thử lại sau ít phút.');
      const don = { ma: out.ma, khoa: out.khoa, tongTien: out.tongTien, soAo: out.soAo, noiNhan: out.noiNhan || out.coSo };
      store.set('mc-don-cho', don);
      cart = []; saveCart(); renderCart(D.merch);
      showPay(don);
    } catch (x) { bad(x.message.startsWith('Failed') ? 'Không kết nối được máy chủ, thử lại sau.' : x.message); }
    finally { btn.disabled = false; btn.textContent = 'Đặt hàng và thanh toán'; }
  });
  $('#mc-paid').addEventListener('click', async () => {
    const don = store.get('mc-don-cho', null), btn = $('#mc-paid'), msg = $('#mc-pay-msg');
    if (!don) return;
    btn.disabled = true; btn.textContent = 'Đang gửi…'; msg.textContent = '';
    try {
      const r = await fetch(`${API}/api/don-hang/${encodeURIComponent(don.ma)}/da-thanh-toan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ khoa: don.khoa }) });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof out.detail === 'string' ? out.detail : 'Chưa gửi được, thử lại sau ít phút.');
      store.set('mc-don-cho', null);
      $('#mc-done-ma').textContent = don.ma;
      $('#mc-done-txt').textContent = `Đơn ${don.soAo} món, ${vnd(don.tongTien)}. Ban Chấp hành sẽ đối soát chuyển khoản và gửi email xác nhận cùng lịch nhận hàng tại ${don.noiNhan}. Hãy lưu lại mã đơn.`;
      step('done');
    } catch (x) { msg.textContent = x.message.startsWith('Failed') ? 'Không kết nối được máy chủ, thử lại sau.' : x.message; msg.className = 'mc-msg bad'; }
    finally { btn.disabled = false; btn.textContent = 'Tôi đã thanh toán'; }
  });
}

function renderAll(data) {
  if (data) D = data;
  renderText(); renderMoDon(); renderLoiTat(); renderNews(); renderClubs(); renderMerch();
  $$('a[href^="http"]').forEach(a => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
}
window.DOAN.renderAll = renderAll;
window.DOAN.getData = () => D;

/* Hiện ngay bản dự phòng, sau đó thay bằng nội dung mới nhất từ máy chủ */
renderAll();
const ctrl = new AbortController();
setTimeout(() => ctrl.abort(), 15000);
fetch(`${API}/api/noi-dung`, { signal: ctrl.signal, cache: 'no-store' })
  .then(r => r.ok ? r.json() : Promise.reject(r.status))
  .then(d => { if (d && Array.isArray(d.banTin)) renderAll(d); })

  .catch(() => {});

/* Điều hướng bằng pathname, không dùng fragment (#...) */
const routeSections = {
  '/top': null, '/mo-don': '#mo-don', '/tien-ich': '#tien-ich',
  '/bantin': '#bantin', '/bch': '#bch', '/clb': '#clb'
};
const route = location.pathname.replace(/\/$/, '') || '/top';
const target = routeSections[route];
if (Object.prototype.hasOwnProperty.call(routeSections, route)) {
  requestAnimationFrame(() => {
    if (target) document.querySelector(target)?.scrollIntoView({ block: 'start' });
    else window.scrollTo(0, 0);
  });
}
const nav = $$('nav a[href^="/"]');
nav.forEach(a => a.classList.toggle('current', a.getAttribute('href') === route));
})();
