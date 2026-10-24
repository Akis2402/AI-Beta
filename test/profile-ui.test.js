'use strict';
// ---------- Hồ sơ: pill không hiện token · Cài đặt chuyển vào Hồ sơ · tab Sử dụng · Bảo mật ----------
// Chạy mã THẬT public/js/ui/authUI.js trên public/index.html THẬT trong jsdom; fetch được giả lập.
// Chạy: node test/profile-ui.test.js
require('./_depGuard').requireDeps(['jsdom'], 'profile-ui.test.js');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const pub = path.join(__dirname, '..', 'public');
const HTML = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const SRC = fs.readFileSync(path.join(pub, 'js', 'ui', 'authUI.js'), 'utf8');

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('  ok  - ' + msg); } else { failed++; console.log('  FAIL - ' + msg); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const USER = { id: 'u1', email: 'an.nguyen@example.com', displayName: 'An Nguyễn', bio: 'Lớp 11', phone: '0912 345 678', providers: ['email'], role: 'user' };
const ITEMS = (() => {
  const day = (n, h) => { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(h, 0, 0, 0); return d.toISOString(); };
  return [
    { at: day(0, 10), kind: 'chat', model: 'm1', input: 900, output: 300, total: 1200 },
    { at: day(0, 8), kind: 'vision', model: 'm2', input: 3000, output: 500, total: 3500 },
    { at: day(2, 9), kind: 'chat', model: 'm1', input: 400, output: 100, total: 500 },
    { at: day(30, 9), kind: 'chat', model: 'm1', input: 400, output: 100, total: 9999 } // ngoài 7 ngày
  ];
})();

async function boot({ status = 'authenticated', quota } = {}) {
  const calls = [];
  const langHandlers = [];
  const vc = new VirtualConsole(); vc.on('jsdomError', () => { /* navigation not implemented: bỏ qua */ });
  const dom = new JSDOM(HTML, { url: 'http://localhost/index.html', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const win = dom.window;
  const q = quota || { status: 'active', tokensUsed: 40500, tokensReserved: 0, tokenLimit: 50000, retryAfterSeconds: 0 };
  let pwReply = { ok: true, status: 200, body: { ok: true } };
  win.confirm = () => true;
  win.languageStore = { getUILanguage: () => 'vi', subscribe: (fn) => { langHandlers.push(fn); } };
  win.fetch = async (url, opts = {}) => {
    const u = String(url); const method = (opts.method || 'GET').toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: u, method, body });
    const res = (code, b) => ({ ok: code >= 200 && code < 300, status: code, headers: { get: () => null }, json: async () => b });
    if (u.includes('/api/auth/session')) return res(200, status === 'authenticated' ? { status, enforcement: true, user: USER } : { status, enforcement: true, user: null });
    if (u.includes('/api/auth/quota')) return res(200, q);
    if (u.includes('/api/auth/usage')) return res(200, { items: ITEMS });
    if (u.includes('/api/auth/profile')) return res(200, { ok: true, displayName: body.displayName !== undefined ? body.displayName : USER.displayName, bio: body.bio !== undefined ? body.bio : USER.bio, phone: body.phone !== undefined ? body.phone : USER.phone });
    if (u.includes('/api/auth/password')) return res(pwReply.status, pwReply.body);
    if (u.includes('/api/auth/logout-all')) return res(200, { ok: true, status: 'unauthenticated', revoked: true });
    if (u.includes('/api/assets')) return res(200, { keys: [], assets: {} });
    return res(404, {});
  };
  win.eval(SRC);
  await new Promise((r) => (win.document.readyState === 'complete' ? r() : win.addEventListener('load', r)));
  await sleep(80);
  return { win, doc: win.document, calls, langHandlers, setPw: (r) => { pwReply = r; } };
}
const $ = (doc, sel) => doc.querySelector(sel);
const tabs = (doc) => Array.from(doc.querySelectorAll('.tg-tab')).map((b) => b.getAttribute('data-k'));
const setVal = (win, el, v) => { el.value = v; el.dispatchEvent(new win.Event('input', { bubbles: true })); };

(async () => {
  const idsIn = (root) => Array.from(root.querySelectorAll('[id]')).map((e) => e.id).sort();
  const sectionIdsOf = (doc) => Array.from(doc.querySelectorAll('#settingsModal > .set-section')).reduce((a, s) => a.concat(s.id ? [s.id] : [], Array.from(s.querySelectorAll('[id]')).map((e) => e.id)), []).sort();

  console.log('\n== Màn hình chính: KHÔNG hiện token ==');
  let t = await boot();
  const pill = $(t.doc, '.tg-pill');
  ok(!!pill, 'có pill tài khoản');
  ok(pill.textContent.includes('An Nguyễn'), 'pill hiện tên hiển thị');
  ok(!/\d[\d.,]*\s*\/\s*\d/.test(pill.textContent) && !/40[.,]?500|50[.,]?000/.test(pill.textContent), 'pill KHÔNG hiện số token đã dùng/giới hạn');
  ok(!/\d/.test(pill.getAttribute('aria-label') || ''), 'aria-label của pill không chứa số token');
  ok(pill.getAttribute('data-initial') === 'A', 'pill có chữ cái đầu làm avatar');
  const banner = t.doc.querySelector('.tg-banner');
  ok(!banner || !/\d{2,}[.,]?\d{3}/.test(banner.textContent), 'banner không lộ số token khi dùng 81%');

  console.log('\n== Cài đặt chuyển vào Hồ sơ ==');
  const sectionIds = sectionIdsOf(t.doc);
  const nSections = t.doc.querySelectorAll('#settingsModal > .set-section').length;
  const totalSections = t.doc.querySelectorAll('.set-section').length; // gồm cả các .set-section nằm ngoài hộp cài đặt
  ok(nSections >= 1, `hộp cài đặt gốc có ${nSections} mục (toàn trang ${totalSections})`);
  $(t.doc, '#settingsBtnTop').click();
  await sleep(30);
  const overlay = $(t.doc, '.tg-prof') && $(t.doc, '.tg-prof').parentElement;
  ok(overlay && !overlay.hidden, 'bấm nút Cài đặt (thanh trên) => mở hộp thoại Hồ sơ');
  ok(!$(t.doc, '#settingsOverlay').classList.contains('show'), 'hộp cài đặt cũ KHÔNG mở');
  ok(tabs(t.doc).join() === 'profile,settings,usage,security', 'có đủ 4 tab: Hồ sơ, Cài đặt, Sử dụng, Bảo mật');
  ok($(t.doc, '#tgTab-settings').getAttribute('aria-selected') === 'true' && !$(t.doc, '#tgPanel-settings').hidden, 'tab Cài đặt đang chọn');
  ok(t.doc.querySelectorAll('#tgPanel-settings .set-section').length === nSections && t.doc.querySelectorAll('#settingsModal .set-section').length === 0, `cả ${nSections} mục cài đặt được CHUYỂN (không nhân đôi) sang tab Cài đặt`);
  const movedIds = Array.from($(t.doc, '#tgPanel-settings').querySelectorAll('.set-section [id], .set-section[id]')).map((e) => e.id).sort();
  ok(sectionIds.length > 0 && JSON.stringify(movedIds) === JSON.stringify(sectionIds), `giữ nguyên toàn bộ ${sectionIds.length} id của mục cài đặt (app.js vẫn gắn được listener)`);
  ok(!!$(t.doc, '#tgPrefMotion') && !!$(t.doc, '#tgPrefAlert'), 'có cài đặt mới: Giảm chuyển động, Nhắc khi gần hết hạn mức');
  $(t.doc, '#tgPrefMotion').click();
  ok(t.doc.documentElement.classList.contains('tg-reduce-motion') && JSON.parse(t.win.localStorage.getItem('tg_prefs_v1')).reduceMotion === true, 'bật "Giảm chuyển động" => áp dụng ngay và lưu lại');
  $(t.doc, '#tgPrefMotion').click();
  ok(!t.doc.documentElement.classList.contains('tg-reduce-motion'), 'tắt lại được');

  // đóng rồi mở lại bằng nút thanh bên
  $(t.doc, '.tg-x').click();
  ok($(t.doc, '.tg-prof').parentElement.hidden === true, 'đóng hộp thoại');
  $(t.doc, '#settingsBtnSide').click(); await sleep(20);
  ok($(t.doc, '.tg-prof').parentElement.hidden === false && t.doc.querySelectorAll('#tgPanel-settings .set-section').length === nSections, 'nút thanh bên cũng mở Hồ sơ -> Cài đặt, mục cài đặt không bị mất');

  // app.js gọi thẳng openSettings(): mô phỏng bằng cách bật lớp .show
  $(t.doc, '.tg-x').click();
  t.win.closeSettings = () => $(t.doc, '#settingsOverlay').classList.remove('show');
  $(t.doc, '#settingsOverlay').classList.add('show'); await sleep(30);
  ok(!$(t.doc, '#settingsOverlay').classList.contains('show') && $(t.doc, '.tg-prof').parentElement.hidden === false, 'openSettings() gọi trực tiếp (vd. Puter) cũng chuyển sang Hồ sơ');

  console.log('\n== Đổi ngôn ngữ không làm mất DOM cài đặt ==');
  t.langHandlers.forEach((fn) => fn());
  await sleep(30);
  ok(t.doc.querySelectorAll('.set-section').length === totalSections, `sau đổi ngôn ngữ trang vẫn đủ ${totalSections} .set-section (không mất, không nhân đôi)`);
  ok(t.doc.querySelectorAll('#tgPanel-settings .set-section').length === nSections, 'hộp thoại đang mở được dựng lại, mục cài đặt vẫn nằm trong tab Cài đặt');

  console.log('\n== Tab Sử dụng ==');
  t.calls.length = 0;
  $(t.doc, '#tgTab-usage').click(); await sleep(40);
  const usage = $(t.doc, '#tgPanel-usage');
  ok(/40[.,]500/.test(usage.textContent) && /50[.,]000/.test(usage.textContent), 'hiện đã dùng 40.500 / 50.000 token');
  ok(usage.textContent.includes('81%'), 'hiện phần trăm (81%)');
  ok($(t.doc, '#tgPanel-usage .tg-bar').getAttribute('data-hot') === '1', 'thanh chuyển màu cảnh báo khi ≥ 80%');
  ok(t.calls.some((c) => c.url.includes('/api/auth/usage')), 'tải lịch sử từ /api/auth/usage');
  ok(t.doc.querySelectorAll('#tgPanel-usage .tg-col').length === 7, 'biểu đồ 7 ngày có 7 cột');
  const stats = Array.from(t.doc.querySelectorAll('#tgPanel-usage .tg-stat b')).map((b) => b.textContent.replace(/\D/g, ''));
  ok(stats[0] === '4700' && stats[1] === '5200' && stats[2] === '4', `thống kê: hôm nay 4.700, 7 ngày 5.200 (bỏ mục 30 ngày trước), 4 lượt — nhận ${stats.join('/')}`);
  ok(t.doc.querySelectorAll('#tgPanel-usage tbody tr').length === 4, 'bảng hoạt động gần đây có 4 dòng');
  ok(/Hỏi đáp/.test(usage.textContent) && /Đọc ảnh/.test(usage.textContent), 'tên loại tiếng Việt (Hỏi đáp / Đọc ảnh)');
  ok(!!$(t.doc, '#tgPanel-usage [role="img"][aria-label]'), 'biểu đồ có mô tả cho trình đọc màn hình');

  console.log('\n== Tab Hồ sơ ==');
  $(t.doc, '#tgTab-profile').click(); await sleep(20);
  ok($(t.doc, '#tgfName').value === 'An Nguyễn' && $(t.doc, '#tgfBio').value === 'Lớp 11' && $(t.doc, '#tgfPhone').value === '0912 345 678' && $(t.doc, '#tgfEmail').readOnly, 'điền sẵn tên, giới thiệu, số điện thoại; email chỉ đọc');
  t.calls.length = 0;
  $(t.doc, '#tgPanel-profile .tg-btn.primary').click(); await sleep(10);
  ok(t.calls.length === 0 && /Chưa có thay đổi/.test($(t.doc, '#tgPanel-profile .tg-msg').textContent), 'không đổi gì => không gọi server');
  setVal(t.win, $(t.doc, '#tgfBio'), 'Học toán'); setVal(t.win, $(t.doc, '#tgfPhone'), '');
  ok($(t.doc, '#tgPanel-profile .tg-count').textContent === '8/280', 'đếm ký tự giới thiệu');
  $(t.doc, '#tgPanel-profile .tg-btn.primary').click(); await sleep(30);
  const patch = t.calls.find((c) => c.method === 'PATCH');
  ok(patch && patch.body.bio === 'Học toán' && patch.body.phone === '' && !('displayName' in patch.body), 'chỉ gửi trường đã đổi (bio, phone), không gửi displayName');
  ok(/Đã lưu hồ sơ/.test($(t.doc, '#tgPanel-profile .tg-msg').textContent), 'báo đã lưu');
  setVal(t.win, $(t.doc, '#tgfName'), '   '); t.calls.length = 0;
  $(t.doc, '#tgPanel-profile .tg-btn.primary').click(); await sleep(10);
  ok(t.calls.length === 0 && $(t.doc, '#tgPanel-profile .tg-msg').classList.contains('err'), 'tên rỗng bị chặn ở client');

  console.log('\n== Tab Bảo mật ==');
  $(t.doc, '#tgTab-security').click(); await sleep(20);
  t.calls.length = 0;
  setVal(t.win, $(t.doc, '#tgpCur'), 'Cu-123456'); setVal(t.win, $(t.doc, '#tgpNew'), 'Moi-123456'); setVal(t.win, $(t.doc, '#tgpCf'), 'Khac-123456');
  $(t.doc, '#tgPanel-security .tg-btn.primary').click(); await sleep(10);
  ok(t.calls.length === 0 && $(t.doc, '#tgPanel-security .tg-msg').classList.contains('err'), 'xác nhận mật khẩu lệch => chặn ở client, không gọi server');
  setVal(t.win, $(t.doc, '#tgpCf'), 'Moi-123456');
  $(t.doc, '#tgPanel-security .tg-btn.primary').click(); await sleep(30);
  const pw = t.calls.find((c) => c.url.includes('/api/auth/password'));
  ok(pw && pw.method === 'POST' && pw.body.currentPassword === 'Cu-123456' && pw.body.newPassword === 'Moi-123456', 'gửi POST /api/auth/password đúng nội dung');
  ok($(t.doc, '#tgpCur').value === '' && $(t.doc, '#tgpNew').value === '' && /Đã đổi mật khẩu/.test($(t.doc, '#tgPanel-security .tg-msg').textContent), 'thành công: xoá các ô mật khẩu và báo đã đổi');
  t.setPw({ ok: false, status: 400, body: { code: 'invalid_current_password', error: 'x' } });
  setVal(t.win, $(t.doc, '#tgpCur'), 'sai'); setVal(t.win, $(t.doc, '#tgpNew'), 'Moi-123456'); setVal(t.win, $(t.doc, '#tgpCf'), 'Moi-123456');
  $(t.doc, '#tgPanel-security .tg-btn.primary').click(); await sleep(30);
  ok(/không đúng/.test($(t.doc, '#tgPanel-security .tg-msg').textContent) && $(t.doc, '.tg-pill'), 'mật khẩu hiện tại sai => thông báo rõ và KHÔNG bị đăng xuất');
  t.calls.length = 0;
  Array.from(t.doc.querySelectorAll('#tgPanel-security .tg-btn.danger'))[1].click(); await sleep(30);
  ok(t.calls.some((c) => c.url.includes('/api/auth/logout-all') && c.method === 'POST'), '"Đăng xuất mọi thiết bị" gọi /api/auth/logout-all');
  ok($(t.doc, '.tg-prof').parentElement.hidden === true && /Đăng nhập/.test($(t.doc, '.tg-pill').textContent), 'sau đó đóng hộp thoại và pill về "Đăng nhập"');

  console.log('\n== Tài khoản Google (chưa có mật khẩu) ==');
  const g = await boot();
  g.win.eval('void 0');
  USER.providers = ['google'];
  const g2 = await boot();
  $(g2.doc, '.tg-pill').click(); await sleep(20);
  $(g2.doc, '#tgTab-security').click(); await sleep(20);
  ok(!$(g2.doc, '#tgpCur') && /Google/.test($(g2.doc, '#tgPanel-security').textContent), 'chỉ có Google => không hiện form đổi mật khẩu, có giải thích');
  USER.providers = ['email'];

  console.log('\n== Khách (chưa đăng nhập) ==');
  const gu = await boot({ status: 'unauthenticated' });
  $(gu.doc, '#settingsBtnTop').click(); await sleep(30);
  ok(tabs(gu.doc).join() === 'settings' || $(gu.doc, '.tg-tabs').hidden === true, 'khách chỉ thấy Cài đặt (không có Sử dụng/Bảo mật)');
  ok(gu.doc.querySelectorAll('#tgPanel-settings .set-section').length === nSections, 'khách vẫn dùng được toàn bộ cài đặt AI');
  ok(!!Array.from(gu.doc.querySelectorAll('.tg-prof-head button')).find((b) => /Đăng nhập/.test(b.textContent)), 'có nút Đăng nhập trong hộp thoại');
  ok(gu.calls.every((c) => !c.url.includes('/api/auth/usage')), 'khách không gọi API usage');

  console.log('\n== Nhắc khi gần hết hạn mức ==');
  const al = await boot();
  await sleep(30);
  ok(!!$(al.doc, '.tg-toast') && !$(al.doc, '.tg-toast').hidden && /80%/.test($(al.doc, '.tg-toast').textContent), 'dùng 81% => hiện toast nhắc 80%');
  const al2 = await boot({ quota: { status: 'active', tokensUsed: 1000, tokensReserved: 0, tokenLimit: 50000, retryAfterSeconds: 0 } });
  ok(!$(al2.doc, '.tg-toast') || $(al2.doc, '.tg-toast').hidden, 'dùng 2% => không nhắc');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
