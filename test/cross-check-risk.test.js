'use strict';

// ---------- REGRESSION: CROSS-CHECK DỰA TRÊN RISK (mục PHẦN 10) ----------
// BUG GỐC: crossCheckPolicy() được viết sẵn nhưng KHÔNG BAO GIỜ được gọi trong chat.js — mọi request
// bật input.crossCheck=true đều gather đúng CROSS_CHECK_MAX_CANDIDATES (mặc định 3) candidate bất kể
// bài dễ hay khó. FIX: risk=LOW (bài đơn giản, không hình học/không phức tạp) giảm còn 2 candidate —
// vẫn tôn trọng lựa chọn bật cross-check của người dùng (KHÔNG bỏ qua hoàn toàn), risk MEDIUM/HIGH
// giữ nguyên hành vi cũ (không giảm khi thực sự cần — geometry proof, bài phức tạp).

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
const aiProvidersSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'utils', 'aiProviders.js'), 'utf8');

// ---------- Unit: crossCheckPolicy / detectGeometryProofHint ----------
test('MICRO/SHORT problem, không hình học -> risk LOW -> mode single', () => {
  const p = te.crossCheckPolicy({ problemClass: 'MICRO', hasGeometryProof: false });
  assert.strictEqual(p.risk, 'LOW');
});
test('COMPLEX/VERY_COMPLEX problem -> risk tối thiểu MEDIUM', () => {
  const p = te.crossCheckPolicy({ problemClass: 'COMPLEX', hasGeometryProof: false });
  assert.ok(p.risk === 'MEDIUM' || p.risk === 'HIGH');
});
test('hasGeometryProof=true -> luôn HIGH risk (dual_model) dù problem class thấp', () => {
  const p = te.crossCheckPolicy({ problemClass: 'MICRO', hasGeometryProof: true });
  assert.strictEqual(p.risk, 'HIGH');
  assert.strictEqual(p.mode, 'dual_model');
});
test('detectGeometryProofHint() nhận diện đề bài chứng minh hình học', () => {
  assert.strictEqual(te.detectGeometryProofHint('Cho tam giác ABC, chứng minh AB vuông góc với CD'), true);
  assert.strictEqual(te.detectGeometryProofHint('Tính 2 + 2 bằng bao nhiêu'), false);
});

// ---------- Static: chat.js thực sự gọi crossCheckPolicy() và truyền maxCandidates xuống ----------
test('chat.js gọi tokenEconomy.crossCheckPolicy() ở CẢ 2 nhánh (streaming + JSON), không còn dead code', () => {
  const usages = (chatSrc.match(/tokenEconomy\.crossCheckPolicy\(/g) || []).length;
  assert.strictEqual(usages, 2, `phải có đúng 2 lượt gọi crossCheckPolicy (streaming + JSON), thấy ${usages}`);
});

test('chat.js truyền maxCandidates xuống gatherCrossCheckCandidates khi risk LOW (giảm từ 3 xuống 2)', () => {
  const usages = (chatSrc.match(/ccMaxCandidates = ccPolicy\.risk === 'LOW' \? 2 : undefined/g) || []).length;
  assert.strictEqual(usages, 2, `phải có đúng 2 chỗ tính ccMaxCandidates theo risk (thấy ${usages})`);
});

test('gatherCrossCheckCandidates() chấp nhận maxCandidates param thực sự ảnh hưởng số target gọi (không phải dead param)', () => {
  assert.ok(aiProvidersSrc.includes('maxCandidates = CROSS_CHECK_MAX_CANDIDATES'), 'phải có default param maxCandidates');
  assert.ok(aiProvidersSrc.includes('pickDiverseCandidates(eligibleInRotationOrder(providers, { requireVision }), Math.max(2, Math.min(maxCandidates, CROSS_CHECK_MAX_CANDIDATES)))'), 'round 1 phải dùng maxCandidates thực tế (kẹp trong [2, CROSS_CHECK_MAX_CANDIDATES]), không hardcode CROSS_CHECK_MAX_CANDIDATES cứng');
});

test('risk MEDIUM/HIGH KHÔNG giảm candidate (giữ hành vi cross-check đầy đủ khi thực sự cần)', () => {
  assert.strictEqual(te.crossCheckPolicy({ problemClass: 'STANDARD', hasGeometryProof: true }).risk, 'HIGH');
  // ccMaxCandidates chỉ set khi risk === 'LOW' -> MEDIUM/HIGH giữ nguyên undefined -> CROSS_CHECK_MAX_CANDIDATES mặc định
  const codeLines = chatSrc.split('\n').filter((l) => !l.trim().startsWith('//'));
  assert.ok(codeLines.some((l) => l.includes("risk === 'LOW' ? 2 : undefined")), 'chỉ risk LOW mới giảm candidate, các mức khác giữ mặc định');
});

// ---------- Không bao giờ giảm dưới 2 (vẫn phải có gì đó để "đối chiếu") ----------
test('gatherCrossCheckCandidates không bao giờ giảm dưới 2 candidate (Math.max(2, ...))', () => {
  assert.ok(aiProvidersSrc.includes('Math.max(2, Math.min(maxCandidates,'), 'phải kẹp sàn tối thiểu 2 candidate — không được bỏ hẳn cross-check khi user đã bật');
});

let passed = 0, failed = 0;
console.log('\n== Regression: CROSS-CHECK DỰA TRÊN RISK, không chỉ toggle (mục PHẦN 10) ==');
for (const r of results) {
  if (r.pass) { passed++; console.log('  ok  - ' + r.name); }
  else { failed++; console.log('  FAIL - ' + r.name + ' :: ' + r.error); }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
