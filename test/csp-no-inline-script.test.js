'use strict';
// ---------- REGRESSION: CSP — không còn <script> nội tuyến trong public/index.html ----------
// Lỗi gốc đã fix: boot-error-handler từng nằm trong 1 thẻ <script> nội tuyến ngay <head>, nhưng
// vercel.json và server/middleware/security.js đều khai báo script-src KHÔNG có 'unsafe-inline' =>
// trình duyệt chặn thẳng script đó, ném:
//   Executing inline script violates the following Content Security Policy directive: "script-src ..."
// Đã tách sang public/js/boot.js, nạp bằng <script src="/js/boot.js">. Test này khẳng định
// KHÔNG CÒN bất kỳ <script>...</script> nội tuyến (có nội dung JS bên trong thẻ) nào trong
// index.html — mọi <script> đều phải là <script src="...">. Cũng khẳng định CSP hiện tại (cả
// vercel.json lẫn server/middleware/security.js) KHÔNG chứa 'unsafe-inline' trong script-src, để
// nếu sau này ai đó "sửa nhanh" bằng cách thêm unsafe-inline thay vì tách file, test sẽ tự nhắc lại
// đúng ràng buộc kiến trúc (không hạ chuẩn bảo mật) thay vì im lặng cho qua.

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ok  - ' + msg); }
  else { failed++; console.log('  FAIL - ' + msg); }
}

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

console.log('\n== Regression: không còn inline <script> trong index.html (CSP script-src compliance) ==');

// Bỏ HTML comment TRƯỚC KHI quét <script> — chú thích trong file có nhắc tới chữ "<script>" dưới
// dạng văn bản giải thích (không phải thẻ thật), nếu không loại bỏ sẽ tạo false positive.
const htmlNoComments = html.replace(/<!--[\s\S]*?-->/g, '');
const scriptTagRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
let m;
let inlineFound = 0;
let totalScripts = 0;
while ((m = scriptTagRe.exec(htmlNoComments))) {
  totalScripts++;
  const attrs = m[1];
  const body = m[2].trim();
  const hasSrc = /\bsrc\s*=/.test(attrs);
  if (!hasSrc && body.length > 0) {
    inlineFound++;
    console.log(`  FAIL - <script> nội tuyến (không có src=) chứa ${body.length} ký tự code, cần chuyển ra file /js/*.js`);
  }
}
ok(totalScripts > 0, `tìm thấy ${totalScripts} thẻ <script> trong index.html để kiểm tra`);
ok(inlineFound === 0, `không còn thẻ <script> nội tuyến nào (tất cả đều dùng src=) — CSP script-src không cần 'unsafe-inline'`);
ok(html.includes('<script src="/js/boot.js"></script>'), `boot.js được nạp qua <script src="/js/boot.js"> (bên ngoài, hợp lệ với CSP 'self')`);

// boot.js phải nạp SỚM — trước mọi script CDN (pdf.js/mammoth/katex/mathjs/three/docx) — để bắt
// được lỗi ngay cả khi các CDN đó tải/parse thất bại.
const bootIdx = html.indexOf('<script src="/js/boot.js">');
const firstCdnIdx = html.indexOf('<script src="https://');
ok(bootIdx !== -1 && (firstCdnIdx === -1 || bootIdx < firstCdnIdx),
  'boot.js được nạp TRƯỚC mọi <script> CDN bên thứ 3 trong index.html');

const bootJsPath = path.join(__dirname, '..', 'public', 'js', 'boot.js');
ok(fs.existsSync(bootJsPath), 'file public/js/boot.js tồn tại');

// CSP directive: script-src không được có 'unsafe-inline' (giữ đúng chuẩn bảo mật thay vì hạ thấp).
const vercelJson = fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8');
const cspLine = (vercelJson.match(/"Content-Security-Policy"[^}]*"value":\s*"([^"]*)"/) || [])[1] || '';
const scriptSrcMatch = cspLine.match(/script-src ([^;]*)/);
ok(!!scriptSrcMatch, 'vercel.json có khai báo script-src trong CSP');
ok(!!scriptSrcMatch && !scriptSrcMatch[1].includes("'unsafe-inline'"),
  "vercel.json script-src KHÔNG chứa 'unsafe-inline' (giữ chuẩn bảo mật, không hạ thấp để né lỗi)");

const securityJs = fs.readFileSync(path.join(__dirname, '..', 'server', 'middleware', 'security.js'), 'utf8');
const scriptSrcServerMatch = securityJs.match(/scriptSrc:\s*\[([^\]]*)\]/);
ok(!!scriptSrcServerMatch, 'server/middleware/security.js có khai báo scriptSrc trong helmet CSP');
ok(!!scriptSrcServerMatch && !scriptSrcServerMatch[1].includes("'unsafe-inline'"),
  "server/middleware/security.js scriptSrc KHÔNG chứa 'unsafe-inline' (nhất quán với vercel.json)");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
