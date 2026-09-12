'use strict';

// ---------- A2 (test K): TRẦN REASONING THEO TỪNG MODEL, KHÔNG HARDCODE 1 SỐ CHO MỌI PROVIDER ----------
// Rủi ro đã tự ghi nhận ở CHANGELOG-THINKING-VISUAL.md mục G.4: DEFAULT_MAX_REASONING (12000) áp
// dụng y hệt cho MỌI model, kể cả model có trần output thật chỉ 4096 -> xin một ngân sách mà model
// vật lý không thể cấp.

const assert = require('assert');
const {
  getReasoningBudgetPolicy, maxReasoningForModel, DEFAULT_MAX_REASONING,
  ANTHROPIC_MIN_THINKING, MODEL_REASONING_SHARE
} = require('../server/utils/budget/reasoningPolicy');
const { reasoningBudgetFor } = require('../server/utils/budget/requestBudgetPlanner');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  - ' + name); }
  catch (e) { failed++; console.log(' FAIL - ' + name + '\n        ' + e.message); }
}

test('K1. Model có maxOutputTokens THẤP (4096) -> trần reasoning bị kẹp theo model, KHÔNG phải 12000', () => {
  const caps = { supportsThinking: true, supportsAdaptiveThinking: true, maxOutputTokens: 4096 };
  const policy = getReasoningBudgetPolicy('anthropic', 'claude-haiku-4-5', caps, { deepThinking: true });
  assert.ok(policy.maxReasoningTokens < DEFAULT_MAX_REASONING,
    `phải nhỏ hơn trần global, thực tế ${policy.maxReasoningTokens}`);
  assert.strictEqual(policy.maxReasoningTokens, Math.floor(4096 * MODEL_REASONING_SHARE));
});

test('K2. Model KHÔNG khai maxOutputTokens -> giữ NGUYÊN hành vi mặc định (A2.4)', () => {
  const caps = { supportsThinking: true, supportsAdaptiveThinking: true };
  const policy = getReasoningBudgetPolicy('anthropic', 'claude-sonnet-5', caps, { deepThinking: true });
  assert.strictEqual(policy.maxReasoningTokens, DEFAULT_MAX_REASONING);
});

test('K3. Trần theo model KHÔNG BAO GIỜ tụt dưới mức tối thiểu hợp lệ của API', () => {
  const tiny = maxReasoningForModel({ maxOutputTokens: 512 });
  assert.ok(tiny >= ANTHROPIC_MIN_THINKING, `budget_tokens < ${ANTHROPIC_MIN_THINKING} sẽ bị Anthropic từ chối`);
});

test('K4. Áp dụng cho MỌI provider có native reasoning, không riêng Anthropic', () => {
  const caps = { supportsThinking: true, supportsAdaptiveThinking: true, maxOutputTokens: 8192 };
  [['openai', 'o4-mini'], ['gemini', 'gemini-2.5-pro'], ['gemini', 'gemini-3-pro'], ['anthropic', 'claude-sonnet-5']]
    .forEach(([provider, model]) => {
      const policy = getReasoningBudgetPolicy(provider, model, caps, { deepThinking: true });
      assert.strictEqual(policy.maxReasoningTokens, Math.floor(8192 * MODEL_REASONING_SHARE),
        `${provider}/${model} phải dùng trần theo model`);
    });
});

test('K5. reasoningBudgetFor() tôn trọng trần model (không vượt qua đường planner)', () => {
  const caps = { supportsThinking: true, supportsAdaptiveThinking: true, maxOutputTokens: 4096 };
  const b = reasoningBudgetFor({
    provider: 'anthropic', model: 'claude-haiku-4-5', capabilities: caps,
    deepThinking: true, answerBudget: 9000, complexityLevel: 'very_large'
  });
  assert.ok(b <= Math.floor(4096 * MODEL_REASONING_SHARE), `bị kẹp theo model, thực tế ${b}`);
});

test('K6. KHÔNG giảm reasoning cho model lớn (không được nhân danh A2 mà cắt suy luận)', () => {
  const caps = { supportsThinking: true, supportsAdaptiveThinking: true, maxOutputTokens: 64000 };
  const policy = getReasoningBudgetPolicy('anthropic', 'claude-opus-5', caps, { deepThinking: true });
  assert.strictEqual(policy.maxReasoningTokens, DEFAULT_MAX_REASONING,
    'model lớn vẫn được dùng trọn trần mặc định — A2 chỉ chặn việc xin quá khả năng model');
});

console.log('\n== A2: trần reasoning theo từng model ==');
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
