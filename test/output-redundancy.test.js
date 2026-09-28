'use strict';
// MỤC 2.2 (backlog v6.22, .70) — output redundancy: đếm nhánh + phương trình lặp, tất định, chỉ log.
const assert = require('assert');
const fs = require('fs'); const path = require('path');
const { measureOutputRedundancy: m } = require('../server/utils/outputRedundancy');
const tests = []; const test = (n, f) => tests.push({ n, f });

test('O1. 1 lời giải sạch: 0 nhánh dư, 0 phương trình lặp', () => {
  const r = m('## Lời giải\nTa có $x^2 - 4 = 0$.\nSuy ra $x = 2$ hoặc $x = -2$.\n## Kết luận\nNghiệm: $x=\\pm 2$.');
  assert.strictEqual(r.repeatedEquationCount, 0); assert.strictEqual(r.branchCount, 0);
});
test('O2. Cách 1 / Cách 2 / Cách 3 -> branchCount=3 (kể cả heading, bullet, in đậm)', () => {
  const r = m('## Cách 1\nabc\n**Cách 2**\nxyz\n- Cách 3: dùng đạo hàm\n');
  assert.strictEqual(r.branchCount, 3);
});
test('O3. Method/Approach tiếng Anh; cùng số nhánh nhắc lại 2 lần chỉ tính 1', () => {
  assert.strictEqual(m('### Method 1\n...\n### Method 2\n...').branchCount, 2);
  assert.strictEqual(m('Cách 1\n...\nCách 1\n...').branchCount, 1);
});
test('O4. phương trình lặp: cùng biểu thức viết 3 lần (khác khoảng trắng/\\left\\right) -> 2 lần lặp', () => {
  const r = m('Ta có $f(x) = 3x^2 + 2x$.\nTức là $f(x)=3x^2+2x$.\nVậy \\( \\left f(x) = 3x^2 + 2x \\right \\).');
  assert.strictEqual(r.repeatedEquationCount, 2); assert.strictEqual(r.uniqueEquationCount, 1);
});
test('O5. phương trình ngắn tầm thường (x=1) không bị đếm lặp', () => {
  assert.strictEqual(m('$x=1$ rồi $x=1$ nữa').repeatedEquationCount, 0);
});
test('O6. $$ nhiều dòng + dòng toán thuần văn bản được đếm', () => {
  const r = m('$$\nE = mc^2\n$$\nE = mc^2\n');
  assert.strictEqual(r.repeatedEquationCount, 1);
});
test('O7. câu văn dài có dấu "=" không bị coi là phương trình', () => {
  assert.strictEqual(m('Khi đặt biến này bằng giá trị kia thì kết quả = đúng như dự kiến của chúng ta.\nKhi đặt biến này bằng giá trị kia thì kết quả = đúng như dự kiến của chúng ta.').repeatedEquationCount, 0);
});
test('O8. đầu vào rỗng/không phải chuỗi không ném lỗi', () => {
  for (const v of ['', null, undefined, 42, {}]) assert.doesNotThrow(() => m(v));
});
test('O9. wiring: sseWrite(done) + 2 điểm res.json phát output_redundancy; helper không ném, chỉ log 1 lần', () => {
  const chat = fs.readFileSync(path.join(__dirname, '../server/routes/chat.js'), 'utf8');
  assert.ok(/if \(event === 'done' && data\) observeOutputRedundancy\(res, data\.text\)/.test(chat));
  // 4 lần xuất hiện = 1 định nghĩa hàm + 3 điểm gọi (sseWrite 'done', 2 nhánh res.json)
  assert.strictEqual((chat.match(/observeOutputRedundancy\(res, /g) || []).length, 4);
  assert.ok(chat.includes("stage: 'output_redundancy'"));
});
(async () => {
  let p = 0, f = 0;
  for (const t of tests) { try { await t.f(); p++; console.log('  ok  -', t.n); } catch (e) { f++; console.log(' FAIL -', t.n, '\n       ', e.message); } }
  console.log(`\n${p} passed, ${f} failed`); process.exit(f ? 1 : 0);
})();
