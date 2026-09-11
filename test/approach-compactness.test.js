'use strict';

// ---------- REGRESSION: APPROACH COMPACTNESS VALIDATOR + REPAIR (mục II/XXX) ----------
// APPROACH = ĐỊNH HƯỚNG, DETAIL = LỜI GIẢI. Validator phải phát hiện approach quá dài/leak đáp số/
// tính toán chi tiết mà KHÔNG cần gọi AI; repair phải chỉ sửa 1 lần, ngắn, không regenerate toàn bộ.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { validateApproachCompactness, buildApproachRepairPrompt, extractApproachSection } = require('../server/utils/approachValidator');

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, error: e.message }); }
}

const GOOD_APPROACH = `## Tóm tắt đề bài
Tam giác ABC vuông tại A, AB = 3, AC = 4. Tính BC.
## Hướng giải
- Áp dụng định lý Pythagoras cho tam giác vuông ABC.
- Tính BC từ AB và AC.
- Kiểm tra đơn vị và điều kiện tam giác vuông.
`;

const BAD_TOO_MANY_BULLETS = `## Hướng giải
- Bước 1.
- Bước 2.
- Bước 3.
- Bước 4.
- Bước 5.
- Bước 6.
- Bước 7.
`;

const BAD_FINAL_ANSWER = `## Hướng giải
- Áp dụng định lý Pythagoras.
- Vậy: x = 5
`;

const BAD_CALC_CHAIN = `## Hướng giải
- Biến đổi: 2x + 3 = 7 => 2x = 4 => x = 2 => kết quả cuối là 2
`;

const BAD_STEP_NUMBERING = `## Hướng giải
Bước 1: Đặt ẩn x là số cần tìm.
Bước 2: Lập phương trình.
`;

// ---------- 1. approach không vượt 4-5 bullet ----------
test('1. approach hợp lệ (<=5 bullet) -> PASS', () => {
  const r = validateApproachCompactness(extractApproachSection(GOOD_APPROACH));
  assert.strictEqual(r.ok, true);
});
test('1b. approach quá nhiều bullet (7) -> FAIL', () => {
  const r = validateApproachCompactness(extractApproachSection(BAD_TOO_MANY_BULLETS));
  assert.strictEqual(r.ok, false);
  assert.ok(r.violations.some((v) => v.startsWith('too_many_bullets')));
});

// ---------- 2. approach không chứa final answer ----------
test('2. approach chứa đáp số cuối -> FAIL', () => {
  const r = validateApproachCompactness(extractApproachSection(BAD_FINAL_ANSWER));
  assert.strictEqual(r.ok, false);
  assert.ok(r.violations.includes('contains_final_answer'));
});

// ---------- 3. approach không chứa detailed calculations ----------
test('3. approach chứa chuỗi tính toán dài -> FAIL', () => {
  const r = validateApproachCompactness(extractApproachSection(BAD_CALC_CHAIN));
  assert.strictEqual(r.ok, false);
  assert.ok(r.violations.includes('long_calculation_chain'));
});

// ---------- 4. approach không biến thành essay (đánh số Bước như detail) ----------
test('4. approach dùng đánh số "Bước 1:" như detail -> FAIL', () => {
  const r = validateApproachCompactness(extractApproachSection(BAD_STEP_NUMBERING));
  assert.strictEqual(r.ok, false);
  assert.ok(r.violations.includes('detailed_step_numbering'));
});

// ---------- 5. approach repair hoạt động (sinh prompt hợp lệ, không rỗng) ----------
test('5. buildApproachRepairPrompt() sinh prompt ngắn, chứa lý do vi phạm + bản gốc', () => {
  const r = validateApproachCompactness(extractApproachSection(BAD_FINAL_ANSWER));
  const prompt = buildApproachRepairPrompt(BAD_FINAL_ANSWER, r.violations);
  assert.ok(prompt.includes('contains_final_answer'));
  assert.ok(prompt.includes(BAD_FINAL_ANSWER));
  assert.ok(/TỐI ĐA 5/.test(prompt));
});

// ---------- 6. approach không bị ảnh hưởng bởi deepThinking (validator không nhận cờ deepThinking) ----------
test('6. validateApproachCompactness() không có tham số deepThinking -> contract độc lập tuyệt đối', () => {
  assert.strictEqual(validateApproachCompactness.length, 1, 'hàm chỉ nhận 1 tham số (text), không có deepThinking -> chứng minh 2 khái niệm tách biệt hoàn toàn');
});

// ---------- Wiring: chat.js phải gọi maybeRepairApproach() ở cả 2 nhánh direct (stream + JSON) ----------
test('chat.js gọi maybeRepairApproach() ở nhánh stream trực tiếp và nhánh JSON trực tiếp', () => {
  const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'chat.js'), 'utf8');
  const usages = (chatSrc.match(/await maybeRepairApproach\(/g) || []).length;
  assert.strictEqual(usages, 2, `phải có đúng 2 lượt gọi maybeRepairApproach (stream + JSON), thấy ${usages}`);
});

test('maybeRepairApproach() không retry vô hạn (đúng 1 lượt callWithFailover, có try/catch nuốt lỗi)', () => {
  const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'chat.js'), 'utf8');
  const fnMatch = chatSrc.match(/async function maybeRepairApproach\([\s\S]*?\n}\n/);
  assert.ok(fnMatch, 'phải tìm thấy định nghĩa maybeRepairApproach()');
  const body = fnMatch[0];
  const callCount = (body.match(/callWithFailover\(/g) || []).length;
  assert.strictEqual(callCount, 1, `chỉ được gọi callWithFailover đúng 1 lần (không retry), thấy ${callCount}`);
  assert.ok(/catch\s*\(/.test(body), 'phải có try/catch để lỗi repair không làm hỏng câu trả lời chính');
});

let passed = 0, failed = 0;
console.log('\n== Regression: APPROACH COMPACTNESS VALIDATOR + REPAIR (mục II/XXX) ==');
for (const r of results) {
  if (r.pass) { passed++; console.log('  ok  - ' + r.name); }
  else { failed++; console.log('  FAIL - ' + r.name + ' :: ' + r.error); }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
