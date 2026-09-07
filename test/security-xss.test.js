'use strict';
// Regression test cho P0 mục 2: file name / source metadata (dữ liệu người dùng kiểm soát)
// KHÔNG được nối trực tiếp vào chuỗi rồi gán qua innerHTML — phải đi qua escapeHtml().
//
// Đây là static-analysis test (không cần DOM/jsdom — dự án chủ trương "không thêm dependency
// lớn nếu chưa cần"): parse mã nguồn public/js/app.js và khẳng định:
//   1. Hàm escapeHtml() tồn tại và hoạt động đúng (escape đủ 5 ký tự nguy hiểm).
//   2. Các điểm render tên tài liệu / nguồn trích dẫn ra innerHTML PHẢI bọc qua escapeHtml(...),
//      không còn kiểu nối chuỗi thô `${doc.name}` / `${c.doc}` như lỗi gốc.

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ok  - ' + msg); }
  else { failed++; console.log('  FAIL - ' + msg); }
}

const appJsPath = path.join(__dirname, '..', 'public', 'js', 'app.js');
const src = fs.readFileSync(appJsPath, 'utf8');

console.log('\n== Regression P0 mục 2: XSS qua tên file / metadata nguồn (public/js/app.js) ==');

ok(/function escapeHtml\(s\)/.test(src), 'escapeHtml() tồn tại trong app.js');

// Thực thi trực tiếp escapeHtml() để kiểm tra hành vi escape (bóc tách bằng eval trong sandbox riêng).
{
  const m = src.match(/function escapeHtml\(s\)\s*\{[\s\S]*?\n\}/);
  ok(!!m, 'trích được thân hàm escapeHtml() để kiểm thử độc lập');
  if (m) {
    // eslint-disable-next-line no-new-func
    const escapeHtml = new Function(m[0] + '; return escapeHtml;')();
    const payload = '<img src=x onerror=alert(1)>.pdf';
    const out = escapeHtml(payload);
    ok(!out.includes('<img'), 'escapeHtml() loại bỏ thẻ <img> nguy hiểm trong tên file');
    ok(out.includes('&lt;img'), 'escapeHtml() chuyển "<" thành entity &lt;');
    const full = escapeHtml('&<>"\'');
    ok(full === '&amp;&lt;&gt;&quot;&#39;', 'escapeHtml() escape đủ & < > " \' theo đúng thứ tự an toàn (escape & trước)');
  }
}

// Điểm render doc.name trong renderSources(): PHẢI qua escapeHtml(doc.name), không còn ${doc.name} thô.
ok(!/\$\{doc\.name\}/.test(src), 'không còn interpolation thô ${doc.name} (lỗi XSS gốc) trong app.js');
ok(/escapeHtml\(doc\.name\)/.test(src), 'renderSources() bọc doc.name qua escapeHtml(...) trước khi đưa vào innerHTML');

// Điểm render c.doc trong renderCitations(): PHẢI qua escapeHtml(c.doc).
ok(!/\$\{c\.doc\}\s*·/.test(src), 'không còn interpolation thô ${c.doc} trong khối trích dẫn (citations)');
ok(/escapeHtml\(c\.doc\)/.test(src), 'renderCitations() bọc c.doc (tên tài liệu nguồn) qua escapeHtml(...)');

// ---------- FIX P2/L (audit): URL runtime (link đề xuất do AI trả về) phải validate protocol ----------
// escapeHtml() KHÔNG chặn được `javascript:`/`data:` URL đặt trong href — cần sanitizeUrl() riêng
// validate protocol TRƯỚC khi đưa vào thuộc tính href.
ok(/function sanitizeUrl\(u\)/.test(src), 'sanitizeUrl() tồn tại trong app.js (validate protocol URL runtime)');
ok(/href="\$\{escapeHtml\(sanitizeUrl\(l\.url\)\)\}"/.test(src), 'renderRecommendResults() bọc l.url qua sanitizeUrl(...) trước khi đưa vào href');
{
  const m = src.match(/function sanitizeUrl\(u\)\s*\{[\s\S]*?\n\}/);
  ok(!!m, 'trích được thân hàm sanitizeUrl() để kiểm thử độc lập');
  if (m) {
    global.window = { location: { href: 'https://example.test/' } };
    // eslint-disable-next-line no-new-func
    const sanitizeUrl = new Function('window', m[0] + '; return sanitizeUrl;')(global.window);
    ok(sanitizeUrl('javascript:alert(1)') === '#', 'sanitizeUrl() chặn javascript: URI (trả về "#" vô hại)');
    ok(sanitizeUrl('data:text/html,<script>alert(1)</script>') === '#', 'sanitizeUrl() chặn data: URI');
    ok(sanitizeUrl('https://example.com/a?b=1') === 'https://example.com/a?b=1', 'sanitizeUrl() giữ nguyên URL https hợp lệ');
    ok(sanitizeUrl('http://example.com') === 'http://example.com/', 'sanitizeUrl() giữ nguyên URL http hợp lệ');
    ok(sanitizeUrl('http://') === '#', 'sanitizeUrl() trả về "#" khi input không phải URL hợp lệ (parse lỗi)');
    delete global.window;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
