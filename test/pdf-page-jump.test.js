'use strict';

// ============================================================================================
// MỤC XX (rework notebook) — SOURCE PREVIEW cho PDF: mở đúng trang trong CÙNG phiên làm việc
// ============================================================================================
// Phạm vi CỐ Ý giới hạn: doc.pdfBlob chỉ tồn tại trong bộ nhớ (không persist — xem persistDocs()),
// nên chỉ hoạt động trước khi tải lại trang. Sau reload, renderCitations() rơi về " · trang X" tĩnh
// như cũ — không lỗi, không giả vờ vẫn mở được. Test dưới đây khoá đúng 2 việc:
//   1. pdfBlob/_pdfObjectUrl KHÔNG BAO GIỜ lọt vào dữ liệu persist (persistDocs()).
//   2. renderCitations() dùng CSS var/ URL.createObjectURL hợp lệ, cache đúng 1 lần/doc (chống rò
//      bộ nhớ do gọi createObjectURL lặp lại mỗi lần render).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  - ' + name); }
  catch (e) { failed++; console.log(' FAIL - ' + name + '\n        ' + e.stack || e.message); }
}

test('1. persistDocs() strip CẢ pdfBlob lẫn _pdfObjectUrl trước khi saveAll (không lưu Blob/URL tạm xuống IndexedDB)', () => {
  const i = app.indexOf('function persistDocs()');
  assert.ok(i >= 0);
  const block = app.slice(i, i + 1500);
  assert.ok(/const \{ pdfBlob, _pdfObjectUrl, \.\.\.rest \} = d;/.test(block),
    'phải destructure bỏ CẢ 2 field tạm này trước khi ghi vào docStore');
  assert.ok(/window\.docStore\.saveAll\(activeTagged\.concat\(recentTagged\)\)/.test(block));
});

test('2. doc PDF được gán pdfBlob NGAY LÚC TẠO (chỉ khi ext===\'pdf\')', () => {
  const i = app.indexOf("pdfBlob: ext === 'pdf' ? file : undefined");
  assert.ok(i >= 0, 'thiếu gán pdfBlob = file cho PDF ngay khi tạo đối tượng doc');
});

test('3. renderCitations(): dùng doc.pdfBlob + c.sourceId để nhảy đúng trang, cache object URL 1 LẦN/doc', () => {
  const i = app.indexOf('MỤC XX (rework notebook) — nếu PDF này vẫn còn Blob');
  assert.ok(i >= 0);
  const block = app.slice(i, i + 1300);
  assert.ok(/state\.docs \|\| \[\]\)\.find\(\(d\) => d\.id === c\.sourceId\)/.test(block),
    'phải tra đúng doc qua c.sourceId (context đã có sẵn field này, không cần thêm field mới)');
  assert.ok(/if \(!srcDoc\._pdfObjectUrl\) srcDoc\._pdfObjectUrl = URL\.createObjectURL\(srcDoc\.pdfBlob\);/.test(block),
    'phải cache object URL — không gọi createObjectURL() mỗi lần render (rò bộ nhớ)');
  assert.ok(/#page=' \+ jumpPage/.test(block), 'phải dùng tham số chuẩn #page=N để trình duyệt tự nhảy trang');
  assert.ok(/} else \{[\s\S]{0,40}meta = pageLabel;/.test(block),
    'không có pdfBlob (đã reload trang) phải rơi về pageLabel tĩnh, KHÔNG throw/không để trống');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
