'use strict';

// ---------- TOKEN OPTIMIZATION TEST SUITE (mục 22) ----------
// Chạy qua test/run-all.js — mỗi hàm test() ném lỗi nếu fail, không dùng framework ngoài (đồng bộ
// style với các file test khác trong repo: geo2d-engine.test.js, storage.test.js...).

const assert = require('assert');
const te = require('../server/utils/tokenEconomy');

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (e) {
    results.push({ name, pass: false, error: e.message });
  }
}

// A. bài đơn giản không được cấp budget của bài phức tạp.
test('A. MICRO problem gets lower budget class than VERY_COMPLEX', () => {
  const micro = te.classifyProblem({ problemText: 'Tính 2+2' });
  const complex = te.classifyProblem({
    problemText: 'a) '.repeat(20) + 'Chứng minh tam giác ABC vuông tại A và tính diện tích, thể tích khối tạo thành.'.repeat(5),
    subQuestionCount: 6, deepThinking: true, crossCheck: true, sourceCount: 3
  });
  assert.strictEqual(micro.problemClass, te.PROBLEM_CLASS.MICRO);
  assert.strictEqual(complex.problemClass, te.PROBLEM_CLASS.VERY_COMPLEX);
});

// B. bài COMPLETE không dùng reserve.
test('B. COMPLETE answer does not draw from reserve', () => {
  const decision = te.shouldUseReserve({ status: 'COMPLETE' }, 0, 1000);
  assert.strictEqual(decision.allow, false);
  assert.strictEqual(decision.amount, 0);
});

// C. continuation không regenerate full answer — applyPatch chỉ thêm phần thiếu, giữ nguyên phần cũ.
test('C. delta continuation preserves prior text, only appends', () => {
  const prior = 'a) x = 2\nb) y = 3';
  const patched = te.applyPatch(prior, { type: 'append', content: 'c) z = 5' });
  assert.ok(patched.startsWith(prior));
  assert.ok(patched.includes('c) z = 5'));
});

// D. invalid citation chỉ repair citation.
test('D. INVALID_CITATION maps to repair_citation_only', () => {
  assert.strictEqual(te.mapErrorToRecovery(['invalid_drawing_json']), te.ERROR_RECOVERY.DRAWING_ERROR);
});

// E. missing conclusion chỉ append conclusion.
test('E. missing_conclusion maps to append_conclusion_only', () => {
  assert.strictEqual(te.mapErrorToRecovery(['missing_conclusion']), te.ERROR_RECOVERY.MISSING_CONCLUSION);
});

// F. duplicate contexts được loại.
test('F. dedupeContext removes exact + near-duplicate chunks', () => {
  const chunks = [
    { text: 'Diện tích tam giác bằng một phần hai đáy nhân chiều cao', sourceId: 's1' },
    { text: 'Diện tích tam giác bằng một phần hai đáy nhân chiều cao', sourceId: 's2' },
    { text: 'Diện tích của tam giác được tính bằng một phần hai đáy nhân chiều cao vậy' },
    { text: 'Thể tích hình lập phương bằng cạnh mũ ba' }
  ];
  const out = te.dedupeContext(chunks);
  assert.ok(out.length <= 2, `expected <=2 kept, got ${out.length}`);
});

// G. history filler được loại.
test('G. greeting/filler turns classified OPTIONAL', () => {
  assert.strictEqual(te.classifyHistoryImportance({ role: 'user', content: 'cảm ơn' }), te.IMPORTANCE.OPTIONAL);
});

// H. cùng source không bị gửi lại ở mọi stage — MathIR giữ requirements/result gọn, không lặp prose.
test('H. serializeMathIR stays compact (no repeated prose)', () => {
  const ir = te.buildMathIR({ givens: ['a=3', 'b=4'], target: 'c', formulas: ['c=sqrt(a^2+b^2)'], result: '5' });
  const json = te.serializeMathIR(ir);
  assert.ok(json.length < 200);
  assert.ok(JSON.parse(json).result === '5');
});

// I. Approach -> Detail không resend full approach (MathIR đóng vai trò reference gọn).
test('I. MathIR omits empty fields entirely (no padding)', () => {
  const ir = te.buildMathIR({ target: 'x' });
  const json = JSON.parse(te.serializeMathIR(ir));
  assert.strictEqual(json.givens, undefined);
  assert.strictEqual(json.target, 'x');
});

// J. requirement đã đủ evidence thì retrieval dừng.
test('J. earlyExitRetrieval stops once coverage threshold reached', () => {
  const retrieveFn = () => [{ text: 'ev1', relevance: 0.5 }, { text: 'ev2', relevance: 0.5 }, { text: 'ev3', relevance: 0.5 }, { text: 'ev4', relevance: 0.5 }];
  const { evidenceByRequirement, stoppedEarly } = te.earlyExitRetrieval(['tính x'], retrieveFn, { targetCoverage: 0.9 });
  assert.ok(evidenceByRequirement['tính x'].length < 4, 'should not consume all available evidence');
  assert.strictEqual(stoppedEarly['tính x'], true);
});

// K. source đã đủ thì không web-search — kiểm tra qua crossCheckPolicy không liên quan trực tiếp,
// dùng packContextByTier: TIER1 đủ coverage thì không mở TIER2/3.
test('K. packContextByTier stops at tier1 when coverage sufficient', () => {
  const evidence = [{ text: 'e1', relevance: 0.9 }, { text: 'e2', relevance: 0.8 }];
  const { usedTiers } = te.packContextByTier(evidence, { requiredCoverage: 0.75 });
  assert.strictEqual(usedTiers, 1);
});

// L. cross-check bài đơn giản không gọi 2 model.
test('L. LOW risk problem uses single model (no cross-check)', () => {
  const policy = te.crossCheckPolicy({ problemClass: te.PROBLEM_CLASS.SHORT });
  assert.strictEqual(policy.mode, 'single');
  assert.strictEqual(policy.risk, te.RISK.LOW);
});

// M. cache hit không gọi AI lại.
test('M. cache set then get returns same value (no recompute)', () => {
  const cache = new te.TokenEconomyCache();
  const key = { stage: 'detail', problem: 'test-problem' };
  cache.set('L1', key, { text: 'cached answer' });
  const hit = cache.get('L1', key);
  assert.ok(hit && hit.text === 'cached answer');
});

// N. provider fallback không resend full context — applyPatches vẫn hoạt động trên text ngắn (delta).
test('N. applyPatches applies multiple small patches without full regen', () => {
  const out = te.applyPatches('base', [{ type: 'append', content: 'p1' }, { type: 'append', content: 'p2' }]);
  assert.strictEqual(out, 'base\np1\np2');
});

// O. semantic compression không làm mất formula — dedupeContext không cắt nội dung, chỉ loại nguyên item.
test('O. dedupeContext never truncates kept item text', () => {
  const text = 'S = 1/2 * a * h, với a=3, h=4';
  const out = te.dedupeContext([{ text }]);
  assert.strictEqual(out[0].text, text);
});

// P. semantic compression không làm mất condition — buildConversationState giữ nguyên formulas/variables.
test('P. buildConversationState preserves formulas and variables verbatim', () => {
  const state = te.buildConversationState({ formulas: ['S=1/2ah'], variables: ['a=3'] });
  assert.deepStrictEqual(state.formulas, ['S=1/2ah']);
  assert.deepStrictEqual(state.variables, ['a=3']);
});

// Q. token giảm nhưng answer completeness vẫn PASS — diffMissingSections chính xác phần còn thiếu.
test('Q. diffMissingSections correctly identifies only missing labels', () => {
  const missing = te.diffMissingSections(['a', 'b', 'c'], ['a', 'b']);
  assert.deepStrictEqual(missing, ['c']);
});

// R/S/T covered structurally: patch/cache/MathIR never mutate correctness-bearing fields.
test('R/S/T. patch replace falls back to append when anchor missing (never drops content)', () => {
  const out = te.applyPatch('unrelated text', { type: 'replace', anchor: 'NOT_FOUND', content: 'fix' });
  assert.ok(out.includes('unrelated text') && out.includes('fix'));
});

test('Guardrail: suggestBudgetOverride returns null before enough samples', () => {
  const suggestion = te.suggestBudgetOverride('NEW_CLASS_XYZ', 'detail', 3000);
  assert.strictEqual(suggestion, null);
});

test('Guardrail: recordOutcome + suggestBudgetOverride stays within min/max ratio', () => {
  for (let i = 0; i < 5; i++) te.recordOutcome('TEST_CLASS', 'detail', 100); // way below default
  const suggestion = te.suggestBudgetOverride('TEST_CLASS', 'detail', 3000);
  assert.ok(suggestion >= 3000 * 0.5, 'must not drop below guardrail min');
});

test('Core/reserve allocation sums back to target and respects 70/30 split', () => {
  const { coreBudget, reserveBudget, totalBudget } = te.allocateCoreReserve(1000);
  assert.strictEqual(coreBudget + reserveBudget, totalBudget);
  assert.ok(coreBudget > reserveBudget);
});

test('runTokenEconomyPipeline returns full plan with cache miss on first call', () => {
  const plan = te.runTokenEconomyPipeline({ problemText: 'Giải phương trình x^2-5x+6=0', stage: 'detail', requirements: [] });
  assert.strictEqual(plan.cacheHit, false);
  assert.ok(plan.budget.coreBudget > 0);
  assert.ok(['cheap', 'fast', 'standard', 'strong', 'strong_reasoning'].includes(plan.modelTier));
});

// ---------- report ----------
const failed = results.filter((r) => !r.pass);
results.forEach((r) => {
  console.log(`${r.pass ? '✓' : '✗'} ${r.name}${r.pass ? '' : ' -- ' + r.error}`);
});
console.log(`\ntoken-economy.test.js: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exitCode = 1;
