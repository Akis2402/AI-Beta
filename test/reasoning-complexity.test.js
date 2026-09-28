'use strict';

// MỤC 1.3 (backlog v6.22) — reasoningPolicy đọc questionProfile.complexity (TRIVIAL..EXPERT).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const rp = require('../server/utils/budget/reasoningPolicy');
const { reasoningBudgetFor, genericReasoningBudget, resolveBudget } = require('../server/utils/budget/requestBudgetPlanner');
const { classifyQuestion, COMPLEXITY_ORDER } = require('../server/utils/questionClassifier');

const results = []; const test = (n, f) => results.push({ n, f });
const caps = { supportsThinking: true, maxOutputTokens: 64000 };
const base = { provider: 'anthropic', model: 'claude-x', capabilities: caps, deepThinking: true, fast: false, answerBudget: 4000, complexityLevel: 'medium' };

test('R1. cùng model: TRIVIAL < SIMPLE < MODERATE < COMPLEX < EXPERT (đơn điệu tăng, TRIVIAL thấp hơn EXPERT rõ rệt)', () => {
  const v = COMPLEXITY_ORDER.map((c) => reasoningBudgetFor({ ...base, questionComplexity: c }));
  for (let i = 1; i < v.length; i++) assert.ok(v[i] >= v[i - 1], v.join('<'));
  assert.ok(v[4] >= v[0] * 2, `EXPERT phải >= 2x TRIVIAL: ${v.join(',')}`);
  assert.ok(v[0] > 0, 'TRIVIAL không được tắt hẳn native reasoning (đó là việc của MICRO)');
});
test('R2. không truyền complexity => y hệt hành vi cũ (A2.4)', () => {
  assert.strictEqual(reasoningBudgetFor({ ...base }), reasoningBudgetFor({ ...base, questionComplexity: 'MODERATE' }));
  assert.strictEqual(rp.reasoningScaleForComplexity(undefined), 1);
  assert.strictEqual(rp.reasoningScaleForComplexity('LẠ'), 1);
});
test('R3. MICRO vẫn thắng (0): problemClass=MICRO + EXPERT vẫn không native', () => {
  assert.strictEqual(reasoningBudgetFor({ ...base, problemClass: 'MICRO', questionComplexity: 'EXPERT' }), 0);
  assert.strictEqual(genericReasoningBudget({ answerBudget: 4000, deepThinking: true, problemClass: 'MICRO', questionComplexity: 'EXPERT' }), 0);
});
test('R4. genericReasoningBudget (đường chat.js dùng cho mọi lượt) cũng theo complexity', () => {
  const t = genericReasoningBudget({ answerBudget: 8000, deepThinking: true, questionComplexity: 'TRIVIAL' });
  const e = genericReasoningBudget({ answerBudget: 8000, deepThinking: true, questionComplexity: 'EXPERT' });
  assert.ok(t < e, `${t} < ${e}`);
  assert.strictEqual(genericReasoningBudget({ answerBudget: 8000, deepThinking: false, questionComplexity: 'EXPERT' }), 0);
});
test('R5. resolveBudget nhận questionComplexity và báo lại trong kết quả', () => {
  const mk = (c) => resolveBudget({ provider: 'anthropic', model: 'claude-x', capabilities: caps, stage: 'detail', problemText: 'Giải bài này', deepThinking: true, questionComplexity: c });
  const t = mk('TRIVIAL'), e = mk('EXPERT');
  assert.ok(t.reasoningBudget <= e.reasoningBudget, `${t.reasoningBudget} <= ${e.reasoningBudget}`);
  assert.strictEqual(e.questionComplexity, 'EXPERT'); assert.strictEqual(e.reasoningComplexityScale, rp.COMPLEXITY_REASONING_SCALE.EXPERT);
});
test('R6. classifier thật: câu định nghĩa < câu HSG ở reasoning budget cùng model', () => {
  const lo = classifyQuestion({ problemText: 'Định nghĩa dao động cơ là gì?', hasImage: false });
  const hi = classifyQuestion({ problemText: 'Bài học sinh giỏi olympic: chứng minh với mọi giá trị tham số m, nhiều cách giải', hasImage: false });
  const a = reasoningBudgetFor({ ...base, questionComplexity: lo.complexity });
  const b = reasoningBudgetFor({ ...base, questionComplexity: hi.complexity });
  assert.ok(COMPLEXITY_ORDER.indexOf(hi.complexity) > COMPLEXITY_ORDER.indexOf(lo.complexity), `${lo.complexity} vs ${hi.complexity}`);
  assert.ok(a < b, `${a} < ${b}`);
});
test('R7. wiring: MỌI call-site problemClass: currentProblemClass trong chat.js đều kèm questionComplexity', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server/routes/chat.js'), 'utf8');
  const all = (src.match(/problemClass: currentProblemClass/g) || []).length;
  const withQ = (src.match(/problemClass: currentProblemClass, questionComplexity: input\.questionProfile && input\.questionProfile\.complexity/g) || []).length;
  assert.ok(all >= 8 && all === withQ, `${withQ}/${all}`);
});

(async () => { let f = 0; for (const t of results) { try { await t.f(); console.log('  ok  -', t.n); } catch (e) { f++; console.log(' FAIL -', t.n, '\n       ', e.message); } } console.log(`\n${results.length - f} passed, ${f} failed`); process.exit(f ? 1 : 0); })();
