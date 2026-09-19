'use strict';

// ---------- REGRESSION: "completion-first" pipeline (audit continuation muc 1-11) ----------
// Test thuan Node, khong can goi API that - dung lai dung cac ham exported cua completenessCheck.js/
// continuation.js/tokenEconomy.js/finishReason.js de tai hien tung kich ban muc 11 yeu cau. Chay:
// node test/completion-first.test.js (hoac qua test/run-all.js).

const assert = require('assert');
const { validateSolutionCompleteness } = require('../server/utils/completenessCheck');
const { computeRecoveryBudget, MAX_CONTINUATIONS } = require('../server/utils/continuation');
const { shouldUseReserve, extendReserveIfTruncated, allocateCoreReserve } = require('../server/utils/tokenEconomy');
const { normalizeFinishReason, finishReasonFromResponsesApi } = require('../server/utils/finishReason');
const { isFinalSuccess, assertFinalResponseComplete } = require('../server/utils/runtimeState');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  -', name); }
  catch (e) { failed++; console.log(' FAIL -', name, '\n       ', e.message); }
}

// ========================================================================
console.log('\n== 1. Cau tra loi ket thuc bang SO - khong bi coi truncated (muc 6) ==');
// ========================================================================
test('ket thuc bang so nguyen -> COMPLETE (khong can "Vay/Dap so")', () => {
  const text = 'Giai phuong trinh ta duoc nghiem duy nhat: x = 42';
  const r = validateSolutionCompleteness(text, { stage: 'detail' });
  assert.ok(isFinalSuccess(r.status, r.severity), 'phai duoc coi la thanh cong (COMPLETE hoac SOFT_INCOMPLETE)');
  assert.ok(!r.hardReasons.includes('truncated_tail'));
});

test('ket thuc bang so thap phan/%/= -> van hop le', () => {
  ['Xac suat can tim la 0.75', 'Hieu suat dat 87%', 'Ta co m = 12'].forEach((text) => {
    const r = validateSolutionCompleteness(text, { stage: 'detail' });
    assert.ok(isFinalSuccess(r.status, r.severity), `"${text}" phai hop le`);
  });
});

// ========================================================================
console.log('\n== 2. Cau tra loi ket thuc bang CONG THUC - khong bi coi truncated (muc 6) ==');
// ========================================================================
test('ket thuc bang LaTeX inline da dong $...$ -> COMPLETE', () => {
  const text = 'Theo dinh ly Pythagoras ta co $a^2 + b^2 = c^2$';
  const r = validateSolutionCompleteness(text, { stage: 'detail' });
  assert.ok(isFinalSuccess(r.status, r.severity));
});

test('ket thuc bang khoi LaTeX $$...$$ da dong -> COMPLETE', () => {
  const text = 'Rut gon bieu thuc ta duoc:\n$$x^2 - 4x + 4 = (x-2)^2$$';
  const r = validateSolutionCompleteness(text, { stage: 'detail' });
  assert.ok(isFinalSuccess(r.status, r.severity));
  assert.ok(!r.hardReasons.includes('unclosed_latex'));
});

// ========================================================================
console.log('\n== 3. Cau tra loi ket thuc bang BULLET hop le - khong bi coi truncated (muc 6) ==');
// ========================================================================
test('bullet cuoi CO noi dung that -> COMPLETE', () => {
  const text = 'Cac buoc giai:\n- Buoc 1: lap phuong trinh\n- Ket qua cuoi cung: x = 7';
  const r = validateSolutionCompleteness(text, { stage: 'detail' });
  assert.ok(isFinalSuccess(r.status, r.severity));
});

test('bullet cuoi vua MO gan nhu trong -> van bi coi truncated_tail (HARD, khong noi long qua tay)', () => {
  const text = 'Cac buoc giai:\n- Buoc 1: lap phuong trinh\n- ab';
  const r = validateSolutionCompleteness(text, { stage: 'detail' });
  assert.ok(r.hardReasons.includes('truncated_tail'));
});

// ========================================================================
console.log('\n== 4. Bai nhieu y nhung AI khong dung dung label -> chi SOFT, khong FAILED (muc 7) ==');
// ========================================================================
test('tra loi du noi dung a/b/c duoi dang van xuoi lien mach (khong danh label) + finishReason=stop -> COMPLETE ngay', () => {
  const problemText = 'a) Tinh dao ham\nb) Tinh tich phan\nc) Ve do thi';
  const text = 'Dao ham cua ham so la f\'(x) = 2x. Tich phan tuong ung bang x^2 + C. Do thi la 1 parabol di qua goc toa do.';
  const r = validateSolutionCompleteness(text, { stage: 'detail', problemText, finishReason: 'stop' });
  assert.strictEqual(r.status, 'COMPLETE');
  assert.ok(isFinalSuccess(r.status, r.severity));
});

test('thieu label + KHONG co finishReason=stop -> van chi SOFT (khong bao gio tu FAILED vi thieu label)', () => {
  const problemText = 'a) Tinh dao ham\nb) Tinh tich phan\nc) Ve do thi';
  const text = 'Dao ham cua ham so la f\'(x) = 2x. Tich phan tuong ung bang x^2 + C. Do thi la 1 parabol.';
  const r = validateSolutionCompleteness(text, { stage: 'detail', problemText });
  assert.strictEqual(r.status, 'INCOMPLETE');
  assert.strictEqual(r.severity, 'SOFT');
  assert.ok(r.softReasons.includes('missing_coverage'));
  assert.ok(isFinalSuccess(r.status, r.severity), 'SOFT van phai duoc coi la thanh cong (muc 2/9)');
});

// ========================================================================
console.log('\n== 5. Bai co LaTeX hop le (dong du moi loai) -> COMPLETE ==');
// ========================================================================
test('mix $$..$$, \\[..\\], \\(..\\) deu dong du -> khong co unclosed_latex, duoc coi la thanh cong', () => {
  const text = 'Ta co $$x=1$$ va \\[y=2\\] voi dieu kien \\(z>0\\). Vay nghiem la (1,2).';
  const r = validateSolutionCompleteness(text, { stage: 'detail' });
  assert.ok(!r.reasons.includes('unclosed_latex'));
  assert.ok(isFinalSuccess(r.status, r.severity));
});

// ========================================================================
console.log('\n== 6. Bai bi cat giua LaTeX -> HARD_INCOMPLETE (dung, khong noi long) ==');
// ========================================================================
test('$$ mo nhung khong dong -> HARD, KHONG duoc coi la thanh cong du finishReason=stop', () => {
  const text = 'Ta bien doi bieu thuc: $$x^2 + 2x + 1 = (x+1)^2 va tiep tuc dung ket qua nay de';
  const r = validateSolutionCompleteness(text, { stage: 'detail', finishReason: 'stop' });
  assert.strictEqual(r.severity, 'HARD');
  assert.ok(r.hardReasons.includes('unclosed_latex'));
  assert.ok(!isFinalSuccess(r.status, r.severity));
  let thrown = null;
  try { assertFinalResponseComplete(r); } catch (e) { thrown = e; }
  assert.ok(thrown, 'phai throw');
  assert.strictEqual(thrown.code, 'FINAL_RESPONSE_INCOMPLETE');
});

// ========================================================================
console.log('\n== 7. Bai bi cat giua code fence -> HARD_INCOMPLETE ==');
// ========================================================================
test('```js mo nhung khong co ``` dong -> HARD', () => {
  const text = 'Doan ma minh hoa:\n```js\nfunction solve(x) {\n  return x * 2;\n';
  const r = validateSolutionCompleteness(text, { stage: 'detail' });
  assert.strictEqual(r.severity, 'HARD');
  assert.ok(r.hardReasons.includes('unclosed_code_fence'));
  assert.ok(!isFinalSuccess(r.status, r.severity));
});

// ========================================================================
console.log('\n== 8. provider finish_reason=stop (chuan hoa dung, completion-first ap dung) ==');
// ========================================================================
test('normalizeFinishReason: end_turn/stop/stop_sequence/completed deu -> "stop"', () => {
  assert.strictEqual(normalizeFinishReason('end_turn'), 'stop');
  assert.strictEqual(normalizeFinishReason('stop'), 'stop');
  assert.strictEqual(normalizeFinishReason('stop_sequence'), 'stop');
  assert.strictEqual(normalizeFinishReason('STOP'), 'stop');
  assert.strictEqual(normalizeFinishReason('completed'), 'stop');
});

test('finishReason=stop + khong HARD reason (ke ca co SOFT) -> COMPLETE ngay (muc 1)', () => {
  const text = 'Ket qua cuoi cung cua bai toan la 10.';
  const r = validateSolutionCompleteness(text, { stage: 'detail', finishReason: 'stop' });
  assert.strictEqual(r.status, 'COMPLETE');
});

// ========================================================================
console.log('\n== 9. provider finish_reason=length (bi cat vi het token) -> HARD, luon luon ==');
// ========================================================================
test('normalizeFinishReason: max_tokens/length -> "length"', () => {
  assert.strictEqual(normalizeFinishReason('max_tokens'), 'length');
  assert.strictEqual(normalizeFinishReason('length'), 'length');
  assert.strictEqual(normalizeFinishReason('MAX_TOKENS'), 'length');
});

test('finishReason=length -> LUON them HARD reason finish_reason_length du van ban "trong" da dong', () => {
  const text = 'Day la cau tra loi trong co ve da hoan chinh.';
  const r = validateSolutionCompleteness(text, { stage: 'detail', finishReason: 'length' });
  assert.strictEqual(r.severity, 'HARD');
  assert.ok(r.hardReasons.includes('finish_reason_length'));
  assert.ok(!isFinalSuccess(r.status, r.severity));
});

test('finishReasonFromResponsesApi: OpenAI Responses {status, incomplete_details} gop dung', () => {
  assert.strictEqual(finishReasonFromResponsesApi({ status: 'completed' }), 'stop');
  assert.strictEqual(finishReasonFromResponsesApi({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }), 'length');
  assert.strictEqual(finishReasonFromResponsesApi({ status: 'incomplete', incomplete_details: { reason: 'content_filter' } }), 'other');
});

// ========================================================================
console.log('\n== 10. Response DAI can >2 continuation - khong con hard-cap o 2 (muc 3) ==');
// ========================================================================
test('MAX_CONTINUATIONS (safety cap) > 2 - du cho bai rat dai nhieu y', () => {
  assert.ok(MAX_CONTINUATIONS > 2, `MAX_CONTINUATIONS phai > 2 de khong chan bai dai, hien = ${MAX_CONTINUATIONS}`);
});

test('computeRecoveryBudget: van allowed=true o luot continuation thu 3, 4, 5 (vuot moc 2 cu) khi con du thoi gian', () => {
  for (let i = 2; i < MAX_CONTINUATIONS; i++) {
    const r = computeRecoveryBudget({ remainingMs: 60000, reserveRemaining: 5000, continuationsSoFar: i });
    assert.strictEqual(r.allowed, true, `luot thu ${i} phai van duoc phep (con thoi gian/reserve)`);
  }
});

test('computeRecoveryBudget: dung dung khi cham safety cap (chong vong lap vo han)', () => {
  const r = computeRecoveryBudget({ remainingMs: 60000, reserveRemaining: 5000, continuationsSoFar: MAX_CONTINUATIONS });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, 'safety_cap_reached');
});

// ========================================================================
console.log('\n== 11. Stream hoan thanh binh thuong (finishReason=stop qua toan bo pipeline) ==');
// ========================================================================
test('mo phong end-to-end: full text ket thuc gon + finishReason=stop -> COMPLETE, isFinalSuccess true', () => {
  const text = 'Vay dien tich hinh chu nhat la 24 cm2.';
  const r = validateSolutionCompleteness(text, { stage: 'detail', finishReason: 'stop' });
  assert.strictEqual(r.status, 'COMPLETE');
  assert.doesNotThrow(() => assertFinalResponseComplete(r));
});

// ========================================================================
console.log('\n== 12. Continuation het budget (reserve can) - dung dung luc, co thu mo rong truoc khi bo cuoc (muc 4) ==');
// ========================================================================
test('shouldUseReserve: reserve con -> allow true, cap theo lo (khong phai toan bo 1 lan)', () => {
  const { reserveBudget } = allocateCoreReserve(2000);
  const d = shouldUseReserve({ status: 'INCOMPLETE', severity: 'HARD' }, 0, reserveBudget);
  assert.strictEqual(d.allow, true);
  assert.ok(d.amount > 0 && d.amount <= reserveBudget);
});

test('shouldUseReserve: reserve da dung HET -> allow false', () => {
  const { reserveBudget } = allocateCoreReserve(2000);
  const d = shouldUseReserve({ status: 'INCOMPLETE', severity: 'HARD' }, reserveBudget, reserveBudget);
  assert.strictEqual(d.allow, false);
  assert.strictEqual(d.amount, 0);
});

test('shouldUseReserve: severity SOFT -> KHONG duoc tieu reserve du con (muc 2/9/10 - tiet kiem token)', () => {
  const { reserveBudget } = allocateCoreReserve(2000);
  const d = shouldUseReserve({ status: 'INCOMPLETE', severity: 'SOFT' }, 0, reserveBudget);
  assert.strictEqual(d.allow, false);
});

test('extendReserveIfTruncated: con "room" theo target tinh lai (deadline van nhieu) -> mo rong them', () => {
  const { reserveBudget } = allocateCoreReserve(2000);
  const result = extendReserveIfTruncated({ reserveBudget, reserveUsed: reserveBudget, recalculatedTarget: 3000 });
  assert.ok(result.extraGranted > 0, 'phai cap them vi recalculatedTarget (3000) > da cap (reserveBudget)');
  assert.ok(result.extendedReserveBudget > reserveBudget);
});

test('extendReserveIfTruncated: KHONG con gi de mo rong (target tinh lai da nho hon/bang da cap) -> extraGranted=0', () => {
  const { reserveBudget } = allocateCoreReserve(2000);
  const result = extendReserveIfTruncated({ reserveBudget, reserveUsed: reserveBudget, recalculatedTarget: 200 });
  assert.strictEqual(result.extraGranted, 0);
  assert.strictEqual(result.extendedReserveBudget, reserveBudget);
});

// ========================================================================
console.log('\n== 13. Timeout that (deadline can) - dung continuation, KHONG co goi them ==');
// ========================================================================
test('computeRecoveryBudget: remainingMs qua nho -> allowed=false, reason=deadline_exhausted', () => {
  const r = computeRecoveryBudget({ remainingMs: 1000, reserveRemaining: 5000, continuationsSoFar: 0 });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, 'deadline_exhausted');
});

test('response bi cat that (timeout giua chung, khong co finishReason) van duoc HARD neu cau truc hong -> dung phai FAILED', () => {
  const text = 'Ta xet tam giac ABC vuong tai A va';
  const r = validateSolutionCompleteness(text, { stage: 'detail' });
  assert.strictEqual(r.severity, 'HARD');
  assert.ok(!isFinalSuccess(r.status, r.severity));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
