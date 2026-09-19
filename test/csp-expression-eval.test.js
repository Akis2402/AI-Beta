'use strict';

// PHẦN C — REGRESSION: mặt cong 3D phải tính được mà KHÔNG cần 'unsafe-eval'.
// Bug gốc: scene3d.js dùng new Function(...) -> CSP production chặn -> try/catch nuốt lỗi -> hình
// biến mất im lặng. Test này khoá cả hai mặt: (1) không còn cơ chế eval trong mã client,
// (2) trình tính thay thế cho kết quả ĐÚNG và từ chối mọi thứ ngoài ngữ pháp toán.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ExprEval = require('../public/js/exprEval.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ok  - ' + name); passed++; }
  catch (e) { console.log(' FAIL - ' + name + '\n        ' + e.message); failed++; }
}
const near = (a, b) => Math.abs(a - b) < 1e-9;

console.log('\n== C1: mã client KHÔNG còn cơ chế nào cần unsafe-eval ==');

const clientDir = path.join(__dirname, '..', 'public', 'js');
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    // Bỏ qua bản đã fingerprint do `npm run build` sinh ra (bản sao của chính file gốc).
    if (/\.[0-9a-f]{10}\.js$/.test(e.name)) return [];
    return e.isDirectory() ? walk(p) : (p.endsWith('.js') ? [p] : []);
  });
}

test('không file client nào GỌI new Function / eval (chỉ được nhắc trong comment)', () => {
  const offenders = [];
  walk(clientDir).forEach((file) => {
    // Loại BÌNH LUẬN trước khi quét: các file này CỐ Ý nhắc tên `new Function` trong phần giải thích
    // root cause; thứ phải bắt là lệnh GỌI thật trong mã.
    const stripped = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
    stripped.split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      if (/\bnew\s+Function\s*\(/.test(code) || /(^|[^.\w])eval\s*\(/.test(code)) {
        offenders.push(`${path.basename(file)}:${i + 1}`);
      }
    });
  });
  assert.deepStrictEqual(offenders, [], 'còn nơi gọi eval/new Function: ' + offenders.join(', '));
});

test('CSP ở security.js và vercel.json KHÔNG chứa unsafe-eval', () => {
  const sec = fs.readFileSync(path.join(__dirname, '..', 'server', 'middleware', 'security.js'), 'utf8');
  const vercel = fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8');
  assert.ok(!/unsafe-eval/.test(sec.replace(/\/\/.*$/gm, '')), 'security.js không được khai unsafe-eval');
  assert.ok(!/unsafe-eval/.test(vercel), 'vercel.json không được khai unsafe-eval');
});

test('scene3d.js dùng ExprEval, và không rơi ngược về eval khi ExprEval thiếu', () => {
  const src = fs.readFileSync(path.join(clientDir, 'scene3d.js'), 'utf8');
  assert.ok(/window\.ExprEval/.test(src), 'phải dùng trình tính an toàn');
  assert.ok(/if \(!compiler\) return null;/.test(src), 'thiếu ExprEval -> không hình, KHÔNG fallback sang eval');
});

console.log('\n== C2: kết quả tính ĐÚNG với ngữ pháp thật project cần ==');

[
  ['x^2 + y^2', 2, 3, 13],
  ['sin(x)', Math.PI / 2, 0, 1],
  ['cos(y)', 0, 0, 1],
  ['sqrt(x*x + y*y)', 3, 4, 5],
  ['((x + 1) * (y - 1)) / 2', 3, 5, 8],
  ['-x^2', 3, 0, -9],
  ['2^3^2', 0, 0, 512],
  ['pi', 0, 0, Math.PI],
  ['atan2(y, x)', 1, 1, Math.PI / 4],
  ['abs(0 - x) + max(x, y)', 2, 7, 9]
].forEach(([expr, x, y, want]) => {
  test(`tính đúng: ${expr}`, () => {
    const fn = ExprEval.compileXY(expr);
    assert.ok(fn, 'phải biên dịch được');
    assert.ok(near(fn(x, y), want), `nhận ${fn(x, y)}, mong ${want}`);
  });
});

console.log('\n== C3: từ chối mọi thứ ngoài ngữ pháp (không có đường thoát ra JS) ==');

[
  ['window.location', 'truy cập đối tượng trình duyệt'],
  ['document.cookie', 'truy cập cookie'],
  ['fetch("http://evil")', 'gọi mạng'],
  ['x.constructor', 'truy cập thuộc tính'],
  ['x.__proto__.polluted = 1', 'prototype pollution'],
  ['this', 'ngữ cảnh JS'],
  ['globalThis', 'ngữ cảnh JS'],
  ['(function(){return 1})()', 'định nghĩa hàm'],
  ['x; alert(1)', 'nhiều câu lệnh'],
  ['x ? 1 : 2', 'toán tử ngoài ngữ pháp'],
  ['x++', 'toán tử gán'],
  ['unknownFn(x)', 'hàm ngoài danh sách trắng'],
  ['zzz', 'định danh lạ'],
  ['x +', 'cú pháp hỏng'],
  ['((x)', 'ngoặc lệch'],
  ['sin(x, y)', 'sai số tham số'],
  ['x'.repeat(600), 'biểu thức quá dài'],
  ['', 'rỗng']
].forEach(([expr, why]) => {
  test(`từ chối (${why}): ${String(expr).slice(0, 28)}`, () => {
    assert.strictEqual(ExprEval.compileXY(expr), null, 'phải trả null, KHÔNG được biên dịch');
  });
});

console.log('\n== C4: giá trị biên — NaN/Infinity không được làm sập renderer ==');

test('chia cho 0 -> Infinity (caller tự lọc), không throw', () => {
  assert.strictEqual(ExprEval.compileXY('1 / (x - x)')(1, 0), Infinity);
});
test('sqrt số âm -> NaN, không throw', () => {
  assert.ok(Number.isNaN(ExprEval.compileXY('sqrt(0 - 1)')(0, 0)));
});
test('biểu thức lồng quá sâu bị chặn theo số nút', () => {
  const deep = '(' .repeat(300) + 'x' + ')'.repeat(300);
  assert.strictEqual(ExprEval.compileXY(deep), null);
});
test('biến chưa truyền -> NaN, không đọc trộm biến ngoài', () => {
  const res = ExprEval.compile('x + y', ['x', 'y']);
  assert.ok(Number.isNaN(res.fn({ x: 1 })));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
