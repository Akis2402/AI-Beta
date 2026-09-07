'use strict';

// Test thuần Node (không framework ngoài) cho các module mới: adaptiveBudget, completenessCheck,
// continuation, drawingValidator, semanticCompression. Chạy: node test/pipeline.test.js
// (hoặc `npm test` để chạy cùng mọi *.test.js khác — xem test/run-all.js)

const assert = require('assert');
const {
  calculateAdaptiveBudget, estimateProblemComplexity, estimateInputTokenLoad, HARD_CEILING
} = require('../server/utils/adaptiveBudget');
const {
  validateSolutionCompleteness, extractCoverageList, checkCoverage
} = require('../server/utils/completenessCheck');
const { buildContinuationPrompt, appendContinuationTurn, MAX_CONTINUATIONS } = require('../server/utils/continuation');
const { validateDrawingBlock, validateAllDrawingBlocks, extractDrawBlocks } = require('../server/utils/drawingValidator');
const { compressHistoryForBudget } = require('../server/utils/semanticCompression');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  -', name); }
  catch (e) { failed++; console.log(' FAIL -', name, '\n       ', e.message); }
}

// ---------- Adaptive budget: bài ngắn vs bài dài (mục 23/24) ----------
test('adaptive budget: short problem gets a small budget', () => {
  const b = calculateAdaptiveBudget({ stage: 'detail', problemText: 'Tính 2+2 bằng bao nhiêu?' });
  assert.ok(b.target < 2000, `expected small target, got ${b.target}`);
  assert.ok(b.min < b.target && b.target <= b.max);
});

test('adaptive budget: long multi-part problem gets a large budget', () => {
  const longProblem = Array.from({ length: 6 }, (_, i) => `${String.fromCharCode(97 + i)}) Chứng minh phần ${i + 1} của bài toán hình học phức tạp này với đầy đủ dữ kiện.`).join('\n');
  const b = calculateAdaptiveBudget({ stage: 'detail', problemText: longProblem });
  assert.ok(b.target > 3000, `expected large target, got ${b.target}`);
});

test('adaptive budget: never exceeds HARD_CEILING even for extreme input', () => {
  const huge = 'a) '.repeat(2000) + 'x'.repeat(20000);
  const b = calculateAdaptiveBudget({ stage: 'reconcile', problemText: huge, deepThinking: true, crossCheck: true });
  assert.ok(b.max <= HARD_CEILING);
});

test('adaptive budget: approach stage budget is smaller than detail for the same problem', () => {
  const problemText = 'a) Tính đạo hàm. b) Tìm cực trị. c) Vẽ đồ thị.';
  const approach = calculateAdaptiveBudget({ stage: 'approach', problemText });
  const detail = calculateAdaptiveBudget({ stage: 'detail', problemText });
  assert.ok(approach.target < detail.target);
});

test('estimateProblemComplexity: counts distinct sub-questions', () => {
  const c = estimateProblemComplexity({ problemText: 'a) Tính A\nb) Tính B\nc) Tính C' });
  assert.ok(c.subQuestionCount >= 3);
});

test('estimateInputTokenLoad: scales with text length', () => {
  const small = estimateInputTokenLoad({ problemText: 'abc' });
  const big = estimateInputTokenLoad({ problemText: 'abc'.repeat(1000) });
  assert.ok(big.total > small.total);
});

// ---------- Completeness check (mục 15/25) ----------
test('completeness: well-formed short answer is COMPLETE', () => {
  const r = validateSolutionCompleteness('Vậy x = 5. Đáp số: x = 5.', { stage: 'detail' });
  assert.strictEqual(r.status, 'COMPLETE');
});

test('completeness: empty/near-empty response is INVALID', () => {
  const r = validateSolutionCompleteness('   ', { stage: 'detail' });
  assert.strictEqual(r.status, 'INVALID');
});

test('completeness: unclosed code fence is INCOMPLETE', () => {
  const r = validateSolutionCompleteness('Bước 1: dùng công thức\n```js\nconsole.log(1)', { stage: 'detail' });
  assert.strictEqual(r.status, 'INCOMPLETE');
  assert.ok(r.reasons.includes('unclosed_code_fence'));
});

test('completeness: unclosed shape block is INCOMPLETE', () => {
  const r = validateSolutionCompleteness('Lời giải...\n```shape\n{"type":"polygon","points":[[0,0]]}', { stage: 'detail' });
  assert.strictEqual(r.status, 'INCOMPLETE');
  assert.ok(r.reasons.includes('unclosed_draw_block'));
});

test('completeness: unclosed $$ latex is INCOMPLETE', () => {
  const r = validateSolutionCompleteness('Ta có $$x^2 + 1 = 0 và tiếp tục biến đổi', { stage: 'detail' });
  assert.strictEqual(r.status, 'INCOMPLETE');
  assert.ok(r.reasons.includes('unclosed_latex'));
});

test('completeness: response cut mid-word/connector is INCOMPLETE', () => {
  const r = validateSolutionCompleteness('Ta xét tam giác ABC vuông tại A và', { stage: 'detail' });
  assert.strictEqual(r.status, 'INCOMPLETE');
  assert.ok(r.reasons.includes('truncated_tail'));
});

test('completeness: missing sub-question coverage is INCOMPLETE', () => {
  const problemText = 'a) Tính chu vi. b) Tính diện tích. c) Tính bán kính đường tròn ngoại tiếp.';
  const coverageList = extractCoverageList(problemText);
  assert.deepStrictEqual(coverageList, ['a', 'b', 'c']);
  const partial = 'a) Chu vi = 12.\nb) Diện tích = 6.\nVậy xong.';
  const r = validateSolutionCompleteness(partial, { stage: 'detail', coverageList });
  assert.strictEqual(r.status, 'INCOMPLETE');
  assert.deepStrictEqual(r.missingCoverage, ['c']);
});

test('completeness: full coverage of all sub-questions passes coverage check', () => {
  const problemText = 'a) Tính A. b) Tính B.';
  const coverageList = extractCoverageList(problemText);
  const full = 'a) A = 1.\nb) B = 2.\nVậy đáp số: A=1, B=2.';
  const { missing } = checkCoverage(full, coverageList);
  assert.deepStrictEqual(missing, []);
});

test('extractCoverageList: ignores single accidental match (needs >=2 labels)', () => {
  const list = extractCoverageList('Giải phương trình 1) x + 2 = 5');
  assert.deepStrictEqual(list, []);
});

// ---------- Continuation ----------
test('continuation: prompt mentions missing parts and forbids repeating', () => {
  const prompt = buildContinuationPrompt({ priorText: 'a) xong', reasons: ['truncated_tail'], missingCoverage: ['b', 'c'] });
  assert.ok(prompt.includes('b, c'));
  assert.ok(/KHÔNG.*lặp lại/i.test(prompt));
});

test('continuation: appendContinuationTurn keeps original messages and appends assistant+user turns', () => {
  const original = [{ role: 'user', content: 'đề bài' }];
  const merged = appendContinuationTurn(original, 'phần đã có', { reasons: [], missingCoverage: [] });
  assert.strictEqual(merged.length, 3);
  assert.strictEqual(merged[0], original[0]);
  assert.strictEqual(merged[1].role, 'assistant');
  assert.strictEqual(merged[2].role, 'user');
});

test('continuation: MAX_CONTINUATIONS is a small finite bound (no infinite retry)', () => {
  assert.ok(MAX_CONTINUATIONS >= 1 && MAX_CONTINUATIONS <= 5);
});

// ---------- Drawing validation (mục 21/26) ----------
test('drawing: valid simple polygon shape passes', () => {
  const r = validateDrawingBlock({ kind: 'shape', raw: '{"type":"polygon","points":[[0,0],[4,0],[2,3]],"labels":["A","B","C"]}' });
  assert.strictEqual(r.valid, true);
});

test('drawing: malformed JSON is invalid', () => {
  const r = validateDrawingBlock({ kind: 'shape', raw: '{"type":"polygon",points:[[0,0]]}' });
  assert.strictEqual(r.valid, false);
});

test('drawing: program shape with dangling point reference is invalid', () => {
  const raw = JSON.stringify({
    type: 'program',
    points: [{ id: 'A', op: 'free', x: 0, y: 0 }, { id: 'B', op: 'free', x: 1, y: 1 }],
    segments: [{ points: ['A', 'Z'] }] // Z không tồn tại
  });
  const r = validateDrawingBlock({ kind: 'shape', raw });
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('Z')));
});

test('drawing: duplicate point ids are invalid', () => {
  const raw = JSON.stringify({
    type: 'program',
    points: [{ id: 'A', op: 'free', x: 0, y: 0 }, { id: 'A', op: 'free', x: 1, y: 1 }]
  });
  const r = validateDrawingBlock({ kind: 'shape', raw });
  assert.strictEqual(r.valid, false);
});

test('drawing: valid solid3d pyramid passes', () => {
  const r = validateDrawingBlock({ kind: 'solid3d', raw: '{"type":"pyramid","base":"square","baseSize":4,"height":6}' });
  assert.strictEqual(r.valid, true);
});

test('drawing: unknown solid3d type is invalid', () => {
  const r = validateDrawingBlock({ kind: 'solid3d', raw: '{"type":"dodecahedron"}' });
  assert.strictEqual(r.valid, false);
});

test('drawing: valid plot passes, plot with >4 expressions fails', () => {
  const ok = validateDrawingBlock({ kind: 'plot', raw: '{"expressions":["x^2"],"xrange":[-5,5]}' });
  assert.strictEqual(ok.valid, true);
  const bad = validateDrawingBlock({ kind: 'plot', raw: '{"expressions":["x","x","x","x","x"],"xrange":[-5,5]}' });
  assert.strictEqual(bad.valid, false);
});

test('drawing: extractDrawBlocks finds only closed fences', () => {
  const text = 'text\n```shape\n{"type":"polygon","points":[[0,0]]}\n```\nmore text';
  const blocks = extractDrawBlocks(text);
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].kind, 'shape');
});

test('validateAllDrawingBlocks: reports invalid block within a full response', () => {
  const text = 'Lời giải...\n```shape\n{"type":"polygon","points":[[0,0]]}\n```\n```plot\n{"expressions":["x","x","x","x","x"],"xrange":[-1,1]}\n```';
  const results = validateAllDrawingBlocks(text);
  const invalid = results.filter((b) => !b.valid);
  assert.strictEqual(invalid.length, 1);
  assert.strictEqual(invalid[0].kind, 'plot');
});

// ---------- Semantic compression (mục 22) ----------
test('semantic compression: keeps all history when short', () => {
  const history = [
    { role: 'user', content: 'câu 1' }, { role: 'assistant', content: 'trả lời 1' }
  ];
  const { history: out, droppedCount } = compressHistoryForBudget(history);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(droppedCount, 0);
});

test('semantic compression: drops oldest whole turns first when over budget, never truncates mid-turn', () => {
  const history = [];
  for (let i = 0; i < 10; i++) {
    history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `turn ${i} `.repeat(200) });
  }
  const { history: out, droppedCount } = compressHistoryForBudget(history, { budgetTokens: 500 });
  assert.ok(droppedCount > 0, 'expected some old turns to be dropped');
  // mỗi phần tử còn lại phải NGUYÊN VẸN (không bị cắt giữa chuỗi) — so khớp với 1 trong các turn gốc
  out.forEach((h) => {
    assert.ok(history.some((orig) => orig.content === h.content), 'kept turn must be byte-identical to an original turn, not truncated');
  });
  // luôn giữ ít nhất 2 lượt gần nhất
  assert.strictEqual(out[out.length - 1].content, history[history.length - 1].content);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exitCode = 1;
