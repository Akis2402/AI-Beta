'use strict';

// PROMPT V5 — PHẦN O/P/AS/Q: adaptive source token budget. Trước bản vá này, trần DUY NHẤT cho
// context vào prompt là trần bảo mật (SECURITY_MAX_CONTEXTS/SECURITY_MAX_CONTEXT_LEN) — không phân
// biệt câu hỏi 1 dòng với câu hỏi đối chiếu nhiều nguồn.

const assert = require('assert');
const { classifyDifficulty, planSourceContexts, TIERS } = require('../server/utils/sourceBudgetPlanner');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ok  - ' + name); passed++; }
  catch (e) { console.log(' FAIL - ' + name + '\n        ' + e.stack); failed++; }
}

function ctx(text, extra = {}) { return { text, doc: 'doc', id: 1, ...extra }; }

console.log('\n== PHẦN O: classifyDifficulty() — deterministic, không AI ==');

test('1. câu hỏi ngắn, 0 yêu cầu, 1 nguồn -> tier THẤP NHẤT (MICRO)', () => {
  const r = classifyDifficulty({ query: 'Đáp án câu 1 là gì?', requirementLabels: [], sourceCount: 1 });
  assert.strictEqual(r.tier, 'MICRO');
});

test('2. nhiều yêu cầu (>=5) + nhiều nguồn (>=3) + câu dài -> tier CAO NHẤT (VERY_COMPLEX)', () => {
  const longQuery = 'Đối chiếu '.repeat(60);
  const r = classifyDifficulty({
    query: longQuery,
    requirementLabels: ['1.9', '1.10', '1.11', '1.12', '1.13'],
    sourceCount: 3
  });
  assert.strictEqual(r.tier, 'VERY_COMPLEX');
});

test('3. tier càng cao -> charBudget càng lớn (bảng đơn điệu tăng)', () => {
  for (let i = 1; i < TIERS.length; i++) assert.ok(TIERS[i].charBudget > TIERS[i - 1].charBudget);
});

console.log('\n== PHẦN CW: đã trong ngân sách -> KHÔNG đụng gì ==');

test('4. tổng ký tự <= budget -> trả nguyên, không cắt', () => {
  const contexts = [ctx('a'.repeat(100)), ctx('b'.repeat(100))];
  const plan = planSourceContexts(contexts, { charBudget: 10000 });
  assert.strictEqual(plan.withinBudgetAlready, true);
  assert.strictEqual(plan.contexts.length, 2);
  assert.strictEqual(plan.dropped.length, 0);
});

console.log('\n== PHẦN Q: context khớp requirementLabel -> KHÔNG BAO GIỜ bị cắt ==');

test('5. context chứa nhãn yêu cầu tường minh luôn được giữ, dù vượt ngân sách', () => {
  const contexts = [
    ctx('Bài 1.9: nội dung liên quan trực tiếp ' + 'x'.repeat(5000)),
    ctx('Đoạn không liên quan ' + 'y'.repeat(5000))
  ];
  const plan = planSourceContexts(contexts, { charBudget: 100, requirementLabels: ['bài 1.9'] });
  assert.ok(plan.contexts.some((c) => c.text.includes('Bài 1.9')), 'context khớp nhãn yêu cầu phải còn trong kết quả');
});

console.log('\n== PHẦN P/AS: chia công bằng giữa các nguồn khi cần đối chiếu ==');

test('6. 3 nguồn active, ngân sách nhỏ -> KHÔNG nguồn nào bị 0 context (PHẦN AS)', () => {
  const contexts = [
    ctx('PDF nội dung dài '.repeat(200), { sourceId: 'pdf1', retrievalTier: 1 }),
    ctx('Web nội dung dài '.repeat(200), { sourceId: 'web1', retrievalTier: 1 }),
    ctx('YouTube nội dung dài '.repeat(200), { sourceId: 'yt1', retrievalTier: 1 })
  ];
  const plan = planSourceContexts(contexts, { charBudget: 500 });
  const sourcesKept = new Set(plan.contexts.map((c) => c.sourceId));
  assert.strictEqual(sourcesKept.size, 3, 'mỗi nguồn phải còn ít nhất 1 context, không nguồn nào bị loại sạch');
});

test('7. cùng 1 nguồn nhiều context, vượt ngân sách -> cắt bớt CÓ BÁO CÁO (dropped)', () => {
  const contexts = Array.from({ length: 10 }, (_, i) => ctx('đoạn '.repeat(200), { sourceId: 'pdf1', id: i, retrievalTier: 2 }));
  const plan = planSourceContexts(contexts, { charBudget: 800 });
  assert.ok(plan.contexts.length < contexts.length, 'phải cắt bớt khi 1 nguồn duy nhất vượt ngân sách');
  assert.ok(plan.dropped.length > 0, 'PHẦN CX: cắt phải CÓ BÁO CÁO, không âm thầm');
  assert.ok(plan.dropped.every((d) => d.reason === 'source_budget_exceeded'));
});

test('8. retrievalTier thấp hơn (ưu tiên cao hơn) được giữ trước khi ngân sách hết', () => {
  const contexts = [
    ctx('X'.repeat(300), { sourceId: 'pdf1', id: 1, retrievalTier: 3 }), // semantic — ưu tiên thấp
    ctx('Y'.repeat(300), { sourceId: 'pdf1', id: 2, retrievalTier: 1 })  // exact — ưu tiên cao
  ];
  const plan = planSourceContexts(contexts, { charBudget: 300 });
  const kept = plan.contexts.map((c) => c.id);
  assert.deepStrictEqual(kept, [2], 'context tier 1 (exact) phải được giữ, tier 3 (semantic) bị cắt trước');
});

test('9. giữ nguyên THỨ TỰ GỐC của list đầu vào (không xáo trộn theo nguồn) — để citeNo dễ hiểu', () => {
  const contexts = [
    ctx('A'.repeat(50), { sourceId: 's1', id: 1, retrievalTier: 1 }),
    ctx('B'.repeat(50), { sourceId: 's2', id: 2, retrievalTier: 1 }),
    ctx('C'.repeat(50), { sourceId: 's1', id: 3, retrievalTier: 1 })
  ];
  const plan = planSourceContexts(contexts, { charBudget: 100000 }); // đủ ngân sách, giữ hết
  assert.deepStrictEqual(plan.contexts.map((c) => c.id), [1, 2, 3]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
