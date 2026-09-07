'use strict';
// ---------- REGRESSION: FINAL AUDIT section M — CDN supply-chain (SRI) ----------
// Static-analysis test: parse public/index.html và khẳng định MỌI <script src="https://...">
// hoặc <link rel="stylesheet" href="https://..."> trỏ tới domain CDN bên thứ 3 đều có
// integrity="sha384-..." + crossorigin="anonymous" — chặn supply-chain attack (CDN bị compromise/
// MITM chèn code độc hại thì trình duyệt sẽ từ chối tải file không khớp hash).
//
// CÁCH TÁI TẠO HASH khi nâng version 1 thư viện (không cần truy cập trực tiếp cdnjs/jsdelivr — cả
// 2 CDN này đều mirror NGUYÊN VẸN, không build lại, đúng file trong gói npm cùng version):
//   npm pack <package>@<version>          # tải đúng bản npm chính chủ
//   tar xzf <package>-<version>.tgz
//   openssl dgst -sha384 -binary <đường-dẫn-file-đúng-tên-cdn-đang-trỏ> | openssl base64 -A
//   -> dán vào integrity="sha384-<kết quả>"
// LƯU Ý: nếu cdnjs/jsdelivr từng đổi pipeline khác npm gốc, hash sẽ lệch — nên xác nhận lại 1 lần
// trên môi trường có mạng thật (mở DevTools Network, so sánh) trước khi deploy production.

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ok  - ' + msg); }
  else { failed++; console.log('  FAIL - ' + msg); }
}

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

console.log('\n== Regression P2/M: SRI cho toàn bộ CDN asset bên thứ 3 (public/index.html) ==');

// Bắt mọi <script src="..."> và <link ... href="..."> có domain bên thứ 3 (http/https, không phải
// /css/... hay /js/... nội bộ, không phải fonts.googleapis.com vì đó chỉ là CSS @import font, không
// phải file thực thi/style tĩnh tải trực tiếp qua <link rel="stylesheet" href=CDN>).
const tagRe = /<(script|link)\b[^>]*\b(?:src|href)="(https:\/\/(?:cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net)\/[^"]+)"[^>]*>/g;
const found = [];
let m;
while ((m = tagRe.exec(html))) found.push({ tag: m[1], url: m[2], full: m[0] });

ok(found.length >= 7, `tìm thấy đủ 7 asset CDN cần kiểm (đếm được ${found.length}: pdf.js, mammoth, katex.css, katex.js, katex auto-render, mathjs, three.js, docx)`);

found.forEach((f) => {
  ok(/integrity="sha384-[A-Za-z0-9+/=]{64,}"/.test(f.full), `${f.url} có integrity sha384 hợp lệ`);
  ok(/crossorigin="anonymous"/.test(f.full), `${f.url} có crossorigin="anonymous" (bắt buộc để SRI hoạt động với response CORS)`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
