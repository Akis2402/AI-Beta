'use strict';
// ---------- Akis: ảnh linh vật + favicon PHẢI là CHÍNH ẢNH GỐC của người dùng ----------
// Yêu cầu: dùng 100% ảnh đã upload, không tạo ảnh mới, không vẽ lại, không AI sinh ảnh.
// Ảnh chỉ được CẮT KHUNG + THU NHỎ rồi nhúng dạng data URI. Test này khoá cứng sha256 của đúng các byte đó:
// ai thay bằng ảnh khác (hoặc vẽ lại bằng SVG) thì test đỏ ngay.

require('./_depGuard').requireDeps(['jsdom'], 'akis-mascot-image.test.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { JSDOM } = require('jsdom');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ok  - ' + msg); } else { failed++; console.log('  FAIL - ' + msg); }
}
const pub = path.join(__dirname, '..', 'public');
const read = (p) => fs.readFileSync(path.join(pub, p), 'utf8');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const HERO_SHA = '98bd2e846e803b5fd10168c926553a29deed27be96a3ac88faa036c8f87416fb'; // WebP 560x410, cắt từ ảnh gốc
const FAVICON_SHA = '9355b50c14933712c1b206cd19cb1bb057df55992ef667084d3b62f7a7c874e4'; // JPEG 96x96, cắt từ ảnh gốc

console.log('\n== Akis dùng đúng ảnh gốc ==');

// ---- 1. akisImage.js
const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
w.eval(read('js/mascot/akisImage.js'));
const uri = w.AKIS_IMG || '';
ok(/^data:image\/webp;base64,[A-Za-z0-9+/=]+$/.test(uri), 'AKIS_IMG là data URI WebP hợp lệ (CSP img-src data: cho phép, không cần file nhị phân)');
const hero = Buffer.from(uri.split(',')[1] || '', 'base64');
ok(sha(hero) === HERO_SHA, 'byte ảnh linh vật khớp sha256 với ảnh gốc đã cắt khung (không bị thay/vẽ lại)');
ok(hero.slice(0, 4).toString() === 'RIFF' && hero.slice(8, 12).toString() === 'WEBP' && hero.slice(12, 16).toString() === 'VP8 ', 'cấu trúc RIFF/WEBP/VP8 hợp lệ');
const dims = [(hero[26] | (hero[27] << 8)) & 0x3fff, (hero[28] | (hero[29] << 8)) & 0x3fff];
ok(dims[0] === 560 && dims[1] === 410, 'kích thước ảnh nhúng 560x410');
ok(Array.isArray(w.AKIS_IMG_SIZE) && w.AKIS_IMG_SIZE[0] === dims[0] && w.AKIS_IMG_SIZE[1] === dims[1], 'AKIS_IMG_SIZE khớp kích thước thật');

// ---- 2. favicon.svg = vỏ SVG bọc đúng ảnh gốc, KHÔNG có nét vẽ
const fav = read('favicon.svg');
const m = fav.match(/<image[^>]*\shref="data:image\/jpeg;base64,([^"]+)"/);
ok(!!m, 'favicon.svg chứa <image href="data:image/jpeg;base64,...">');
const favBytes = Buffer.from(m ? m[1] : '', 'base64');
ok(sha(favBytes) === FAVICON_SHA, 'byte ảnh trong favicon khớp sha256 với ảnh gốc đã cắt khung');
ok(favBytes[0] === 0xff && favBytes[1] === 0xd8, 'favicon là JPEG hợp lệ (SOI FFD8)');
ok((fav.match(/<image\b/g) || []).length === 1, 'favicon chỉ có ĐÚNG 1 <image>');
ok(!/<(path|circle|ellipse|polygon|polyline|line|text)\b/i.test(fav), 'favicon KHÔNG có hình vẽ tay nào (path/circle/ellipse/polygon/line/text)');
ok(/viewBox="0 0 96 96"/.test(fav), 'favicon có viewBox vuông 96x96');
for (const page of ['index.html', 'landing.html', 'auth.html']) {
  const html = read(page);
  ok(/<link[^>]+rel="icon"[^>]+href="\/favicon\.svg"/.test(html) || /<link[^>]+href="\/favicon\.svg"[^>]+rel="icon"/.test(html), `${page} dùng /favicon.svg làm favicon`);
}

// ---- 3. mascot.js: KHÔNG vẽ lại
const mascotSrc = read('js/mascot/mascot.js');
ok(!/createElementNS|<svg|<path|\bfill=|stroke=/.test(mascotSrc), 'mascot.js không tạo/vẽ SVG (không createElementNS/<svg>/<path>)');
ok(!/\bfetch\s*\(|XMLHttpRequest|api\.anthropic|openai|generate|dall|image-gen/i.test(mascotSrc.replace(/\/\*[\s\S]*?\*\//g, '')), 'mascot.js không gọi mạng / không sinh ảnh bằng AI');

// ---- 4. hành vi của mascot
w.eval(mascotSrc);
const A = w.AkisMascot;
ok(!!A && typeof A.create === 'function' && typeof A.createBubble === 'function', 'AkisMascot.create / createBubble tồn tại');
const EXPECT_STATES = ['idle', 'wave', 'look', 'peek', 'type-email', 'hide-eyes', 'working', 'success', 'error', 'sleepy', 'point-left', 'point-right', 'hold-card', 'spin-3d', 'celebrate'];
ok(JSON.stringify(A.STATES) === JSON.stringify(EXPECT_STATES), 'đủ 15 trạng thái theo đặc tả');
const mk = A.create({ size: 200, variant: 'full' });
w.document.body.appendChild(mk.el);
const img = mk.el.querySelector('img.ak-img');
ok(!!img && img.getAttribute('src') === uri, 'thẻ <img> của linh vật dùng đúng AKIS_IMG (cùng một ảnh với trang)');
ok(img && img.getAttribute('alt') === '' && mk.el.getAttribute('aria-hidden') === 'true', 'ảnh trang trí: alt rỗng + aria-hidden (văn bản thật nằm ở bong bóng thoại)');
ok(mk.el.querySelectorAll('img').length === 1 && !mk.el.querySelector('svg'), 'linh vật chỉ gồm 1 ảnh, không có SVG vẽ thêm');
ok(mk.getState() === 'idle', 'trạng thái mặc định idle');
for (const s of EXPECT_STATES) { mk.setState(s); if (mk.getState() !== s || mk.el.getAttribute('data-state') !== s) { ok(false, `setState('${s}')`); } }
ok(true, 'setState nhận cả 15 trạng thái và phản ánh vào data-state');
mk.setState('khong-ton-tai');
ok(mk.getState() === 'idle', 'trạng thái lạ rơi về idle');
mk.lookAt(9, -9);
ok(mk.el.style.getPropertyValue('--look-x') === '1.000' && mk.el.style.getPropertyValue('--look-y') === '-1.000', 'lookAt bị kẹp trong [-1, 1]');
mk.setProgress(5);
ok(mk.el.style.getPropertyValue('--p') === '1.0000', 'setProgress bị kẹp trong [0, 1]');
mk.setProp('shield'); mk.setProp('khong-co');
ok(mk.el.getAttribute('data-prop') === 'none', 'prop lạ rơi về none');
const body = A.create({ size: 96, variant: 'body' });
ok(body.el.classList.contains('ak-body-only') && body.el.querySelector('img').getAttribute('src') === uri, 'bản "body" chỉ cắt khung bằng CSS, vẫn là cùng một ảnh');
const bubble = A.createBubble();
bubble.say('Xin chào');
ok(bubble.el.getAttribute('role') === 'status' && bubble.el.getAttribute('aria-live') === 'polite' && bubble.el.textContent === 'Xin chào' && bubble.el.classList.contains('is-on'), 'bong bóng thoại: role=status, aria-live=polite, chứa văn bản thật');
bubble.hide();
ok(!bubble.el.classList.contains('is-on'), 'hide() tắt bong bóng');
mk.destroy();
ok(!w.document.body.contains(mk.el), 'destroy() gỡ linh vật khỏi DOM');

// ---- 5. mọi trang nạp ảnh TRƯỚC mascot.js
for (const page of ['index.html', 'landing.html', 'auth.html']) {
  const html = read(page);
  const a = html.search(/\/js\/mascot\/akisImage(?:\.[0-9a-f]{10})?\.js/);
  const b = html.search(/\/js\/mascot\/mascot(?:\.[0-9a-f]{10})?\.js/);
  ok(a >= 0 && b > a, `${page}: akisImage.js nạp trước mascot.js`);
}

// ---- 6. CSS: chuyển động chỉ là của chính ảnh, tôn trọng reduced-motion
const css = read('css/mascot.css');
ok(/prefers-reduced-motion:\s*reduce/.test(css), 'mascot.css có @media prefers-reduced-motion');
ok(!/(?:^|[;{\s])(?:fill|stroke)\s*:/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), 'mascot.css không tô/vẽ nét nào (không fill/stroke)');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
