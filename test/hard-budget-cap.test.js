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
test('cả 4 điểm continuation streaming đều "break" ngay khi !reserveDecision.allow (không gọi AI thêm)', () => {
  const breakGuards = (codeSrc.match(/if \(!reserveDecision\.allow\) break;/g) || []).length;
  assert.strictEqual(breakGuards, 2, `phải có đúng 2 guard "if (!reserveDecision.allow) break;" ở 2 nhánh streaming (thấy ${breakGuards})`);
});

test('cả 2 điểm continuation JSON (ensureCompleteNonStream) trả sentinel thay vì gọi AI khi !decision.allow', () => {
  const sentinelGuards = (codeSrc.match(/if \(!decision\.allow\) return Promise\.resolve\(\{ reserveExhausted: true \}\);/g) || []).length;
  assert.strictEqual(sentinelGuards, 2, `phải có đúng 2 guard sentinel ở nhánh JSON (thấy ${sentinelGuards})`);
});

test('ensureCompleteNonStream() dừng vòng lặp ngay khi nhận sentinel reserveExhausted, không tính là continuation đã dùng', () => {
  assert.ok(chatSrc.includes('if (contResult && contResult.reserveExhausted) break;'), 'phải kiểm tra sentinel và break trước khi cộng continuations/nối text');
  // continuations chỉ += 1 SAU dòng check sentinel -> vòng lặp reserveExhausted không tính là 1 lượt gọi AI
  const idxSentinel = chatSrc.indexOf('if (contResult && contResult.reserveExhausted) break;');
  const idxIncrement = chatSrc.indexOf('continuations += 1;', idxSentinel);
  assert.ok(idxSentinel > 0 && idxIncrement > idxSentinel, 'check sentinel phải nằm TRƯỚC dòng continuations += 1');
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
