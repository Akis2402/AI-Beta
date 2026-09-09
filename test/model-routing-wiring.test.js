'use strict';

// ---------- REGRESSION: MODEL ROUTING PHẢI HOẠT ĐỘNG THẬT (mục PHẦN 8) ----------
// BUG GỐC: tePlan.modelTier (routeByComplexity) được TÍNH nhưng chỉ dùng ở reqLogger.log(...) —
// lệnh gọi model thật vẫn dùng `fast: callMode.fast` (chỉ phụ thuộc deepThinking, không phụ thuộc
// độ phức tạp bài) -> dead optimization. FIX: tierUsesFastModel(tier) nối modelTier vào lựa chọn
// model thật (fast:true/false) ở CẢ 2 nhánh direct (streaming + JSON), không ép fast cho bài phức
// tạp (STANDARD/COMPLEX/VERY_COMPLEX) dù deepThinking chưa bật.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const te = require('../server/utils/tokenEconomy');

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, error: e.message }); }
}

const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'chat.js'), 'utf8');

// ---------- Unit: tierUsesFastModel ----------
test('tierUsesFastModel: cheap/fast -> true (model nhẹ)', () => {
  assert.strictEqual(te.tierUsesFastModel('cheap'), true);
  assert.strictEqual(te.tierUsesFastModel('fast'), true);
});
test('tierUsesFastModel: standard/strong/strong_reasoning -> false (model đầy đủ)', () => {
  assert.strictEqual(te.tierUsesFastModel('standard'), false);
  assert.strictEqual(te.tierUsesFastModel('strong'), false);
  assert.strictEqual(te.tierUsesFastModel('strong_reasoning'), false);
});

// ---------- Unit: routeByComplexity theo problemClass (đã có nhưng xác nhận lại end-to-end) ----------
test('MICRO problem class -> tier cheap -> useFastModel true', () => {
  const tier = te.routeByComplexity({ problemClass: 'MICRO', deepThinking: false, highRisk: false });
  assert.strictEqual(tier, 'cheap');
  assert.strictEqual(te.tierUsesFastModel(tier), true);
});
test('COMPLEX problem class -> tier strong -> useFastModel false (không ép fast dù deepThinking=false)', () => {
  const tier = te.routeByComplexity({ problemClass: 'COMPLEX', deepThinking: false, highRisk: false });
  assert.strictEqual(tier, 'strong');
  assert.strictEqual(te.tierUsesFastModel(tier), false);
});
test('VERY_COMPLEX hoặc deepThinking=true -> luôn strong_reasoning -> useFastModel false', () => {
  assert.strictEqual(te.tierUsesFastModel(te.routeByComplexity({ problemClass: 'VERY_COMPLEX' })), false);
  assert.strictEqual(te.tierUsesFastModel(te.routeByComplexity({ problemClass: 'MICRO', deepThinking: true })), false);
  assert.strictEqual(te.tierUsesFastModel(te.routeByComplexity({ problemClass: 'MICRO', highRisk: true })), false);
});

// ---------- Static: chat.js thực sự dùng tierUsesFastModel(tePlan.modelTier) làm nguồn cho `fast:` ----------
test('chat.js wires tokenEconomy.tierUsesFastModel(tePlan.modelTier) vào biến useFastModel', () => {
  assert.ok(chatSrc.includes('tokenEconomy.tierUsesFastModel(tePlan.modelTier)'), 'phải gọi tierUsesFastModel(tePlan.modelTier) để tính useFastModel');
  const useFastModelDecl = (chatSrc.match(/const useFastModel = callMode\.fast && tokenEconomy\.tierUsesFastModel\(tePlan\.modelTier\);/g) || []).length;
  assert.strictEqual(useFastModelDecl, 2, `phải có đúng 2 khai báo useFastModel (streaming + JSON), thấy ${useFastModelDecl}`);
});

test('cả 4 lệnh gọi model ở nhánh direct (không cross-check) dùng useFastModel, không còn dùng callMode.fast trực tiếp', () => {
  const codeLines = chatSrc.split('\n').filter((l) => !l.trim().startsWith('//'));
  const codeSrc = codeLines.join('\n');
  assert.ok(!/fast:\s*callMode\.fast/.test(codeSrc), 'không được còn "fast: callMode.fast" trực tiếp ở lệnh gọi model — phải qua useFastModel (đã tính thêm modelTier)');
  const useFastModelUsages = (codeSrc.match(/fast:\s*useFastModel/g) || []).length;
  assert.strictEqual(useFastModelUsages, 4, `phải có đúng 4 lệnh gọi model dùng "fast: useFastModel" (thấy ${useFastModelUsages})`);
});

test('directCaller (racing callFastest vs callWithFailover) vẫn dựa trên callMode.fast (deepThinking) — không đổi hành vi UI "chế độ Nhanh"', () => {
  assert.ok(chatSrc.includes('const directCaller = callMode.fast ? callFastest : callWithFailover;'), 'racing selection vẫn phải theo deepThinking, không theo modelTier (tránh đổi hành vi UI hiện có)');
});

let passed = 0, failed = 0;
console.log('\n== Regression: MODEL ROUTING nối vào lựa chọn model thật (mục PHẦN 8) ==');
for (const r of results) {
  if (r.pass) { passed++; console.log('  ok  - ' + r.name); }
  else { failed++; console.log('  FAIL - ' + r.name + ' :: ' + r.error); }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
