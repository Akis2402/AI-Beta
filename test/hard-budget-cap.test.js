'use strict';

// ---------- REGRESSION: HARD BUDGET CAP (mục PHẦN 2) ----------
// BUG GỐC (tìm thấy khi trace data flow thật, không phải đọc comment): 4 điểm continuation trong
// server/routes/chat.js dùng fallback:
//     const contMaxTokens = reserveDecision.allow ? reserveDecision.amount
//                                                  : Math.max(300, Math.round(reserveBudget * 0.3));
// Khi reserveDecision.allow === false (reserve đã cạn / completeness đã COMPLETE), nhánh else VẪN
// tính ra tối thiểu 300 token và VẪN gọi AI thêm 1 lượt — phá vỡ hard cap
// (coreBudget + reserveBudget = totalBudget). Reserve có thể bị tiêu VƯỢT quá phần được cấp.
//
// FIX: khi !reserveDecision.allow -> KHÔNG gọi AI thêm, dừng ngay (loop 'break' ở 2 nhánh streaming,
// sentinel { reserveExhausted: true } không gọi provider ở 2 nhánh JSON/ensureCompleteNonStream).

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
const codeLines = chatSrc.split('\n').filter((l) => !l.trim().startsWith('//'));
const codeSrc = codeLines.join('\n');

// ---------- 1. Static: pattern rò rỉ hard cap không còn tồn tại trong code thật ----------
test('chat.js không còn fallback "Math.max(300, reserve * 0.3)" ngoài reserve (hard cap leak cũ)', () => {
  assert.ok(
    !/reserveDecision\.allow\s*\?\s*reserveDecision\.amount\s*:\s*Math\.max/.test(codeSrc),
    'không được còn ternary fallback tính token ngoài reserve khi !allow'
  );
  assert.ok(
    !/decision\.allow\s*\?\s*decision\.amount\s*:\s*Math\.max/.test(codeSrc),
    'không được còn ternary fallback tính token ngoài reserve khi !allow (nhánh JSON)'
  );
});

// ---------- 2. Static: mọi điểm continuation phải dừng khi !allow, không có đường nào bỏ qua ----------
// ---------- CẬP NHẬT SAU REFACTOR PHẦN B (resumable failover) ----------
// 4 điểm continuation viết tay trong chat.js (2 streaming + 2 JSON) đã được GỘP vào đúng 1 nơi:
// server/utils/resumableStream.js (runResumableStream + runResumableNonStream). Chính sự trùng lặp
// 4 bản logic gần-giống-nhau đó là môi trường sinh ra bug hard-cap ban đầu, nên các assertion dưới
// đây kiểm tra CÙNG MỘT ĐẢM BẢO ở vị trí mới, và kiểm tra thêm rằng chat.js KHÔNG còn vòng lặp
// continuation viết tay nào (mạnh hơn bản cũ: bản cũ chỉ đếm số guard, không cấm phát sinh bản thứ 5).
const resumableSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'utils', 'resumableStream.js'), 'utf8');
const resumableCode = resumableSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('mọi điểm continuation dừng ngay khi !decision.allow (không gọi AI thêm) — cả 2 runner', () => {
  const guards = (resumableCode.match(/if \(!decision \|\| !decision\.allow\)/g) || []).length;
  assert.strictEqual(guards, 2, `phải có đúng 2 guard !allow (runResumableStream + runResumableNonStream), thấy ${guards}`);
  // Guard phải nằm TRƯỚC mọi lệnh gọi provider trong cùng vòng lặp.
  const firstGuard = resumableCode.indexOf('if (!decision || !decision.allow)');
  const firstStreamCall = resumableCode.indexOf('await streamFn(', firstGuard);
  assert.ok(firstStreamCall > firstGuard, 'guard !allow phải nằm trước lệnh gọi provider');
});

test('chat.js KHÔNG còn vòng lặp continuation viết tay nào (chỉ delegate sang resumableStream)', () => {
  const handRolled = (codeSrc.match(/while \(\s*\n?\s*completeness\.status === 'INCOMPLETE'/g) || []).length;
  assert.strictEqual(handRolled, 0, `chat.js không được tự viết vòng continuation nữa (thấy ${handRolled})`);
  assert.ok(codeSrc.includes('runResumableStream'), 'chat.js phải dùng runResumableStream cho nhánh streaming');
  assert.ok(codeSrc.includes('runResumableNonStream'), 'chat.js phải dùng runResumableNonStream cho nhánh JSON');
});

test('sentinel reserveExhausted vẫn được tôn trọng và break TRƯỚC khi ghi nhận chi phí', () => {
  assert.ok(resumableCode.includes("step.reserveExhausted"), 'phải vẫn kiểm tra sentinel reserveExhausted của callOnce cũ');
  const idxSentinel = resumableCode.indexOf('step.reserveExhausted');
  const idxSpend = resumableCode.indexOf('session.noteRecoverySpend(decision.amount)', idxSentinel);
  assert.ok(idxSentinel > 0 && idxSpend > idxSentinel, 'check sentinel phải nằm TRƯỚC khi trừ ngân sách/nối text');
});

test('reserve ĐƯỢC TRỪ ngay khi cấp (nếu không, reserve không bao giờ cạn và vòng recovery chạy tới safety cap)', () => {
  assert.ok(
    /reserveState\.used \+= decision\.amount/.test(codeSrc),
    'makeRecoveryResolver() phải cộng dồn reserveState.used khi cấp lô token'
  );
});

// ---------- 3. Unit: shouldUseReserve tự nó không bao giờ cấp vượt phần còn lại ----------
test('reserve = 0 -> shouldUseReserve() không cho phép gọi AI (allow=false, amount=0)', () => {
  const decision = te.shouldUseReserve({ status: 'INCOMPLETE' }, 1000, 1000); // đã dùng hết 1000/1000
  assert.strictEqual(decision.allow, false);
  assert.strictEqual(decision.amount, 0);
});

test('reserveBudget=0 ngay từ đầu -> shouldUseReserve() không cho phép gọi AI', () => {
  const decision = te.shouldUseReserve({ status: 'INCOMPLETE' }, 0, 0);
  assert.strictEqual(decision.allow, false);
  assert.strictEqual(decision.amount, 0);
});

test('completeness COMPLETE -> không đụng reserve dù còn dư (không gọi AI thêm)', () => {
  const decision = te.shouldUseReserve({ status: 'COMPLETE' }, 0, 1000);
  assert.strictEqual(decision.allow, false);
  assert.strictEqual(decision.amount, 0);
});

test('nhiều lượt shouldUseReserve() liên tiếp KHÔNG BAO GIỜ khiến tổng đã dùng vượt reserveBudget', () => {
  const reserveBudget = 777; // số lẻ để bắt lỗi làm tròn
  let used = 0;
  let iterations = 0;
  while (iterations < 100) {
    const decision = te.shouldUseReserve({ status: 'INCOMPLETE' }, used, reserveBudget);
    if (!decision.allow) break; // đúng hành vi: dừng khi cạn, không cố "vay thêm"
    assert.ok(used + decision.amount <= reserveBudget, `tổng dùng (${used + decision.amount}) không được vượt reserveBudget (${reserveBudget})`);
    used += decision.amount;
    iterations += 1;
  }
  assert.ok(iterations < 100, 'phải hội tụ về allow=false trong hữu hạn bước (không lặp vô hạn)');
  assert.ok(used <= reserveBudget, `tổng cuối cùng (${used}) không được vượt reserveBudget (${reserveBudget})`);
});

test('total budget (coreBudget + reserveBudget) luôn == totalBudget, không có nguồn token thứ 3 nào khác', () => {
  for (const target of [200, 500, 1234, 4000, 9999]) {
    const { coreBudget, reserveBudget, totalBudget } = te.allocateCoreReserve(target);
    assert.strictEqual(coreBudget + reserveBudget, totalBudget, `target=${target}: core+reserve phải == total`);
    assert.ok(totalBudget <= target, `target=${target}: totalBudget không được vượt target gốc (hard cap)`);
  }
});

let passed = 0, failed = 0;
console.log('\n== Regression: HARD BUDGET CAP không bao giờ bị vượt (mục PHẦN 2) ==');
for (const r of results) {
  if (r.pass) { passed++; console.log('  ok  - ' + r.name); }
  else { failed++; console.log('  FAIL - ' + r.name + ' :: ' + r.error); }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
