'use strict';
// ---------- Trang landing (/), trang đăng nhập (/auth), auth client, route, header: kiểm cấu trúc + an toàn ----------
require('./_depGuard').requireDeps(['jsdom'], 'landing-auth-pages.test.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ok  - ' + msg); } else { failed++; console.log('  FAIL - ' + msg); }
}
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// ---- dịch: vi/en đầy đủ cặp khoá
const sandbox = { window: {} };
vm.runInNewContext(read('public/js/i18n/translations.js'), sandbox);
const T = sandbox.window.TRANSLATIONS;
const has = (k) => !!(T.vi[k] && T.en[k]);

const pages = { 'public/landing.html': 'landing', 'public/auth.html': 'auth' };
for (const [file, name] of Object.entries(pages)) {
  console.log(`\n== ${name}: ${file} ==`);
  const html = read(file);
  ok(/<html lang="vi">/.test(html), 'có <html lang>');
  ok(/<meta name="viewport"[^>]*viewport-fit=cover/.test(html), 'viewport có viewport-fit=cover (vùng an toàn trên điện thoại)');
  ok((html.match(/<h1[\s>]/g) || []).length === 1, 'đúng 1 thẻ <h1>');
  ok(/<main id="main"/.test(html) && /class="skip" href="#main"/.test(html), 'có <main id="main"> và liên kết "bỏ qua tới nội dung chính"');
  ok(!/<script(?![^>]*\ssrc=)[^>]*>/i.test(html), 'KHÔNG có <script> nội tuyến (CSP script-src không cho unsafe-inline)');
  ok(!/\son[a-z]+\s*=\s*["']/i.test(html), 'KHÔNG có thuộc tính sự kiện nội tuyến (onclick=...)');
  ok(!/\sstyle\s*=/i.test(html), 'KHÔNG dùng thuộc tính style nội tuyến');
  ok(/<link[^>]+href="\/favicon\.svg"/.test(html), 'dùng /favicon.svg (ảnh Akis) làm favicon');
  ok(!/<img[^>]+src="[^"]+\.(png|jpe?g|gif|webp)"/i.test(html), 'không nạp ảnh bitmap rời (ảnh Akis nhúng trong akisImage.js)');
  const ext = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => new URL(m[1]).origin);
  ok(ext.every((o) => o === 'https://fonts.googleapis.com' || o === 'https://fonts.gstatic.com'), 'chỉ tham chiếu ngoài tới Google Fonts (CSP cho phép)');
  const keys = new Set();
  for (const m2 of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) keys.add(m2[1]);
  const missing = [...keys].filter((k) => !has(k));
  ok(keys.size > 5 && missing.length === 0, `mọi khoá data-i18n* (${keys.size}) có đủ bản vi + en` + (missing.length ? ' — THIẾU: ' + missing.join(', ') : ''));
  const imgs = [...html.matchAll(/<img\b[^>]*>/g)].map((m2) => m2[0]);
  ok(imgs.every((t2) => /\salt="/.test(t2)), 'mọi <img> đều có thuộc tính alt');
  ok([...html.matchAll(/<button\b[^>]*>/g)].every((b) => /\stype="/.test(b[0])), 'mọi <button> khai báo type (không vô tình submit form)');
}

console.log('\n== landing: 8 mục theo đặc tả, chỉ 1 request ==');
const landing = read('public/landing.html');
ok((landing.match(/data-akis-state=/g) || []).length === 8, 'đúng 8 mục (hero + 7 mục) mang data-akis-state');
ok(/id="hero"/.test(landing) && /id="start"/.test(landing), 'có mục mở đầu và mục CTA cuối');
ok(/href="\/auth\?mode=signup"/.test(landing) && /href="\/auth"/.test(landing) && /href="\/index\.html"/.test(landing), 'CTA trỏ /auth?mode=signup, /auth và /index.html');

console.log('\n== auth.html: form + a11y ==');
const auth = read('public/auth.html');
ok(/<form id="apForm" novalidate>/.test(auth), 'form đăng nhập có novalidate (tự kiểm tra bằng JS, thông báo đa ngôn ngữ)');
for (const id of ['apEmail', 'apPw', 'apPw2']) ok(new RegExp(`<label for="${id}"`).test(auth), `ô #${id} có <label for>`);
ok(/id="apEmail"[^>]*autocomplete="username"/.test(auth) && /id="apPw"[^>]*autocomplete="current-password"/.test(auth), 'autocomplete đúng cho trình quản lý mật khẩu');
ok(/role="tablist"/.test(auth) && /role="tab"/.test(auth), 'tab đăng nhập/đăng ký dùng role=tablist/tab');
ok(/id="apMsg"[^>]*aria-live="polite"/.test(auth), 'vùng thông báo lỗi/thành công aria-live=polite');
ok(/<meta name="robots" content="noindex"/.test(auth), 'trang đăng nhập noindex');

console.log('\n== 0 token AI: JS của trang chỉ chạm /api/auth/* ==');
const AI_ROUTES = /\/api\/(chat|generate|recommend|study|source|visual)\b/;
for (const f of ['public/js/pages/landing.js', 'public/js/pages/auth.js', 'public/js/auth/authClient.js', 'public/js/mascot/mascot.js', 'public/js/ui/mascotCompanion.js']) {
  const code = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  ok(!AI_ROUTES.test(code), `${f}: không gọi route AI`);
  ok(!/\beval\s*\(|new Function\s*\(|document\.write\s*\(|\.innerHTML\s*=\s*[^'"]*\+/.test(code.replace(/tour\.innerHTML = '[^']*'/, '')), `${f}: không eval/new Function/document.write/innerHTML động`);
  const fetches = [...code.matchAll(/(?:fetch|api)\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  ok(fetches.every((u) => u.startsWith('/api/auth/') || ['GET', 'POST'].includes(u)), `${f}: mọi request đều tới /api/auth/*`);
}

console.log('\n== authClient: SHA-256 / PoW / safeNext / errorKey ==');
const clientSandbox = { module: { exports: {} }, TextEncoder, URL, Promise, Math, Date, setTimeout, Uint8Array, DataView };
clientSandbox.globalThis = clientSandbox;
vm.runInNewContext(read('public/js/auth/authClient.js'), clientSandbox);
const C = clientSandbox.module.exports;
const nodeSha = (s) => crypto.createHash('sha256').update(s).digest();
const enc = new TextEncoder();
let shaOk = true;
for (const s of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(119), 'salt:12345', 'Trợ Giải ✓']) {
  if (Buffer.compare(Buffer.from(C._sha256(enc.encode(s))), nodeSha(s)) !== 0) { shaOk = false; console.log('    lệch với chuỗi độ dài ' + s.length); }
}
ok(shaOk, 'SHA-256 thuần JS (hằng số tính từ căn nguyên tố) khớp crypto của Node với 8 vector, gồm biên 55/56/64 byte');
ok(C._leadingZeroBits(Uint8Array.of(0, 0, 0x1f)) === 19 && C._leadingZeroBits(Uint8Array.of(0x80)) === 0 && C._leadingZeroBits(new Uint8Array(4)) === 32, 'leadingZeroBits đúng');

(async () => {
  const lz = (buf) => { let n = 0; for (const b of buf) { if (b === 0) { n += 8; continue; } n += Math.clz32(b) - 24; break; } return n; };
  const nonce = await C._solvePow('testsalt', 10, crypto.webcrypto.subtle);
  ok(lz(nodeSha('testsalt:' + nonce)) >= 10, 'solvePow (WebCrypto) trả nonce thoả >= 10 bit 0');
  const nonce2 = await C._solvePow('testsalt', 10, null);
  ok(lz(nodeSha('testsalt:' + nonce2)) >= 10, 'solvePow (SHA-256 dự phòng, ngữ cảnh không có crypto.subtle) cũng thoả');
  ok(nonce === nonce2, 'hai đường giải cho cùng nonce nhỏ nhất');

  ok(C.safeNext('/index.html') === '/index.html' && C.safeNext('/index.html?x=1') === '/index.html?x=1', 'safeNext: giữ /index.html và query');
  for (const bad of ['//evil.com', 'https://evil.com', '/\\evil.com', '/index.html/../../x', '/api/auth/logout', 'javascript:alert(1)', '/ok\nSet-Cookie:x', null, undefined, 42, '', '/' + 'a'.repeat(400)]) {
    if (C.safeNext(bad) !== '/index.html') ok(false, 'safeNext chặn: ' + JSON.stringify(bad));
  }
  ok(true, 'safeNext chặn open-redirect (//host, URL tuyệt đối, backslash, đường dẫn khác, xuống dòng, kiểu lạ, quá dài)');

  ok(C.isEmail('a@b.co') && !C.isEmail('a@b') && !C.isEmail('a b@c.com') && !C.isEmail(''), 'isEmail');
  ok(C.isStrongPassword('abcd1234') && !C.isStrongPassword('abcdefgh') && !C.isStrongPassword('1234567') && !C.isStrongPassword('12345678'), 'isStrongPassword (>=8, có chữ và số)');
  const hasKey = (k) => has(k);
  ok(C.errorKey({ code: 'invalid_credentials' }, hasKey) === 'ap.err.invalid_credentials', 'errorKey: mã đã biết -> khoá riêng');
  ok(C.errorKey({ code: 'pow_replay' }, hasKey) === 'ap.err.pow_invalid' && C.errorKey({ code: 'pow_expired' }, hasKey) === 'ap.err.pow_expired', 'errorKey: pow_* gộp về pow_invalid (trừ pow_expired)');
  ok(C.errorKey({ code: '<script>x' }, hasKey) === 'ap.err.generic' && C.errorKey({}, hasKey) === 'ap.err.generic' && C.errorKey(null, hasKey) === 'ap.err.generic', 'errorKey: mã lạ/rỗng -> generic (không bao giờ hiện chuỗi thô của server)');
  for (const k of Object.keys(T.vi).filter((x) => x.startsWith('ap.err.'))) if (!T.en[k]) ok(false, 'thiếu en cho ' + k);
  ok(true, 'mọi ap.err.* đều có bản en');

  console.log('\n== route + header ==');
  const proxy = read('proxy.ts');
  ok(/'\/landing\.html'/.test(proxy) && /'\/auth\.html'/.test(proxy) && /matcher:\s*\['\/',\s*'\/auth'\]/.test(proxy), 'proxy.ts: "/" -> /landing.html, "/auth" -> /auth.html, matcher chỉ 2 đường dẫn');
  ok(/redirect\('\/landing\.html'\)/.test(read('app/page.tsx')), 'app/page.tsx dự phòng redirect về /landing.html');
  const vj = JSON.parse(read('vercel.json'));
  for (const src of ['/', '/index.html', '/landing.html', '/auth', '/auth.html']) {
    const rule = vj.headers.find((h) => h.source === src);
    ok(rule && rule.headers.some((h) => h.key === 'Cache-Control' && /no-store/.test(h.value)), `vercel.json: ${src} => Cache-Control no-store`);
  }
  const csp = vj.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
  ok(!/script-src[^;]*unsafe-inline/.test(csp) && /img-src 'self' data: blob:/.test(csp) && /font-src 'self' https:\/\/fonts\.gstatic\.com/.test(csp), 'CSP không đổi: script-src không unsafe-inline; img-src cho data: (ảnh Akis nhúng); font Google');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
