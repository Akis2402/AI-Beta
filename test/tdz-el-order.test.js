'use strict';
// ---------- REGRESSION: startup TDZ (Temporal Dead Zone) audit — public/js/app.js ----------
// Lỗi gốc đã fix: `const el = (id) => document.getElementById(id);` từng nằm SAU chỗ gọi
// `el('stopBtn').addEventListener(...)`, khiến browser ném:
//   Uncaught ReferenceError: Cannot access 'el' before initialization
// và dừng thực thi TOÀN BỘ app.js ngay tại đó (không nút nào được gắn sự kiện nữa). Test này khẳng
// định KHÔNG BAO GIỜ tái diễn: dòng khai báo `const el = ...` phải xuất hiện trước MỌI lần gọi
// `el(` trong file. Đây là static-analysis test (không cần DOM/browser thật), chạy nhanh trong CI.

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ok  - ' + msg); }
  else { failed++; console.log('  FAIL - ' + msg); }
}

const appJsPath = path.join(__dirname, '..', 'public', 'js', 'app.js');
const src = fs.readFileSync(appJsPath, 'utf8');
const lines = src.split('\n');

console.log('\n== Regression: el() declared trước mọi lần gọi (chống TDZ ReferenceError) ==');

let declLine = -1;
let firstUseLine = -1;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const trimmed = line.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue; // bỏ dòng comment
  if (declLine === -1 && /^\s*const\s+el\s*=\s*\(/.test(line)) {
    declLine = i + 1;
  }
  if (firstUseLine === -1 && /\bel\(/.test(line) && !/^\s*const\s+el\s*=/.test(line)) {
    firstUseLine = i + 1;
  }
}

ok(declLine !== -1, `tìm thấy khai báo "const el = (id) => ..." trong app.js (dòng ${declLine})`);
ok(firstUseLine !== -1, `tìm thấy ít nhất 1 lần gọi el(...) trong app.js (dòng ${firstUseLine})`);
ok(declLine !== -1 && firstUseLine !== -1 && declLine <= firstUseLine,
  `khai báo el() (dòng ${declLine}) nằm TRƯỚC lần gọi el() đầu tiên (dòng ${firstUseLine}) — không còn TDZ ReferenceError`);

// Đảm bảo el() được khai báo rất sớm trong file (ngay sau 'use strict'/comment đầu), không bị
// lùi xuống dưới do sửa code tương lai vô tình chèn logic khác lên trước.
ok(declLine !== -1 && declLine <= 15, `el() được khai báo sớm (dòng ${declLine}, kỳ vọng ≤ 15) — tránh mọi rủi ro TDZ về sau`);

// Guard bổ sung: el('stopBtn').addEventListener phải được bọc trong kiểm tra null (mục 8: event
// listener safety) — không còn gọi trực tiếp addEventListener trên kết quả el() có thể null.
const stopBtnDirectCall = /^el\('stopBtn'\)\.addEventListener/m.test(src);
ok(!stopBtnDirectCall, `el('stopBtn').addEventListener không còn được gọi trực tiếp (không guard null) ở top-level`);
ok(/if\s*\(\s*el\('stopBtn'\)\s*\)\s*\{/.test(src), `el('stopBtn').addEventListener được bọc trong "if (el('stopBtn'))" guard`);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
