'use strict';

// ---------- REGRESSION: CROSS-CHECK KHÔNG ĐƯỢC GIẢM SỐ CANDIDATE THEO RISK ----------
// LỊCH SỬ: bản trước dùng crossCheckPolicy() để giảm candidate risk=LOW từ 3 xuống 2 nhằm tiết kiệm
// token. Yêu cầu spec mới (mục XII/XXII "token-compression v2") CẤM việc này: "Không giảm số lượng
// verification chỉ vì token" — LOW risk vẫn phải cross-check ĐẦY ĐỦ số candidate mặc định, token
// saving chỉ được đến từ nén representation/context, không phải cắt bớt số lượt gọi verify.
// FIX: chat.js không còn gọi crossCheckPolicy() để suy ra maxCandidates nữa — luôn gather đúng
// CROSS_CHECK_MAX_CANDIDATES mặc định khi input.crossCheck=true, bất kể problemClass/risk.
// crossCheckPolicy()/detectGeometryProofHint() vẫn giữ trong tokenEconomy.js (hàm thuần, có thể tái
// dùng sau này) — chỉ KHÔNG còn được dùng để cắt candidate.

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

// ---------- Unit: crossCheckPolicy / detectGeometryProofHint (hàm thuần vẫn tồn tại, vẫn đúng) ----------
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

// ---------- Static: chat.js KHÔNG được giảm candidate theo risk nữa (mục XII/XXII) ----------
test('chat.js KHÔNG còn dùng crossCheckPolicy()/ccMaxCandidates để cắt số candidate', () => {
  assert.ok(!/ccMaxCandidates/.test(chatSrc), 'ccMaxCandidates phải bị loại bỏ khỏi chat.js — không được cắt candidate theo risk');
  assert.ok(!/tokenEconomy\.crossCheckPolicy\(/.test(chatSrc), 'chat.js không còn gọi crossCheckPolicy() để suy ra số candidate');
});

test('gatherCrossCheckCandidates() được gọi KHÔNG kèm maxCandidates ở cả 2 nhánh (dùng đủ mặc định)', () => {
  const usages = (chatSrc.match(/gatherCrossCheckCandidates\(activeProviders, \{[\s\S]{0,400}?\}\)/g) || []);
  assert.strictEqual(usages.length, 2, `phải có đúng 2 lượt gọi gatherCrossCheckCandidates (streaming + JSON), thấy ${usages.length}`);
  usages.forEach((u) => assert.ok(!u.includes('maxCandidates'), 'không được truyền maxCandidates xuống — luôn dùng CROSS_CHECK_MAX_CANDIDATES mặc định'));
});

test('gatherCrossCheckCandidates() vẫn nhận maxCandidates optional (API giữ nguyên cho nơi gọi khác/test), mặc định = CROSS_CHECK_MAX_CANDIDATES', () => {
  assert.ok(aiProvidersSrc.includes('maxCandidates = CROSS_CHECK_MAX_CANDIDATES'), 'phải có default param maxCandidates = CROSS_CHECK_MAX_CANDIDATES');
});

// ---------- Không bao giờ giảm dưới 2 (an toàn kẹp sàn, dù hiện tại không còn nhánh nào truyền số nhỏ hơn mặc định) ----------
test('gatherCrossCheckCandidates không bao giờ giảm dưới 2 candidate (Math.max(2, ...))', () => {
  assert.ok(aiProvidersSrc.includes('Math.max(2, Math.min(maxCandidates,'), 'phải kẹp sàn tối thiểu 2 candidate — không được bỏ hẳn cross-check khi user đã bật');
});

let passed = 0, failed = 0;
console.log('\n== Regression: CROSS-CHECK KHÔNG giảm số candidate theo risk (mục XII/XXII) ==');
for (const r of results) {
  if (r.pass) { passed++; console.log('  ok  - ' + r.name); }
  else { failed++; console.log('  FAIL - ' + r.name + ' :: ' + r.error); }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
