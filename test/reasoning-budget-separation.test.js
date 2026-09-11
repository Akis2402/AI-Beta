'use strict';

// ============================================================================================
// REGRESSION — ROOT CAUSE LỖI THINKING (PHẦN 1/2/3/4/5/6)
// ============================================================================================
// Bug gốc: `max_tokens` của provider BAO GỒM CẢ reasoning token, nhưng code cũ coi nó là ngân sách
// riêng cho câu trả lời rồi còn cấp 60% của nó cho thinking. Bộ test này khoá chặt bất biến mới:
//
//     answerBudget KHÔNG BAO GIỜ bị reasoning ăn vào. reasoning là CỘNG THÊM.

const assert = require('assert');
const { getReasoningBudgetPolicy, effortFromBudget, thinkingLevelFromBudget } = require('../server/utils/budget/reasoningPolicy');
const { resolveBudget, genericReasoningBudget } = require('../server/utils/budget/requestBudgetPlanner');
const finish = require('../server/utils/finishReason');

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, error: e.message }); }
}
async function atest(name, fn) {
  try { await fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, error: e.message }); }
}

// ---------- 1. Reasoning policy đúng theo provider ----------
test('1. Anthropic reasoning-capable -> anthropic_budget, reasoning TÍNH vào output', () => {
  const p = getReasoningBudgetPolicy('anthropic', 'claude-x', { supportsThinking: true }, { deepThinking: true });
  assert.strictEqual(p.mechanism, 'anthropic_budget');
  assert.strictEqual(p.countsAgainstOutput, true);
  assert.ok(p.minReasoningTokens >= 1024, 'Anthropic yêu cầu budget_tokens >= 1024');
});

test('2. deepThinking=false -> KHÔNG có reasoning ở mọi provider', () => {
  ['anthropic', 'openai', 'gemini'].forEach((k) => {
    const p = getReasoningBudgetPolicy(k, 'm', { supportsThinking: true }, { deepThinking: false });
    assert.strictEqual(p.native, false, k + ' không được bật reasoning khi chế độ Nhanh');
  });
});

test('3. fast=true -> KHÔNG BAO GIỜ bật native reasoning (ưu tiên latency)', () => {
  const p = getReasoningBudgetPolicy('anthropic', 'm', { supportsThinking: true }, { deepThinking: true, fast: true });
  assert.strictEqual(p.native, false);
});

test('4. model KHÔNG hỗ trợ reasoning -> fallback prompt-based, không gửi field API lạ', () => {
  const p = getReasoningBudgetPolicy('openai', 'gpt-4o', { supportsThinking: false }, { deepThinking: true });
  assert.strictEqual(p.mechanism, 'prompt');
  assert.strictEqual(p.native, false);
});

test('5. Gemini version-aware: 3.x -> level, 2.5 -> budget', () => {
  const g3 = getReasoningBudgetPolicy('gemini', 'gemini-3-pro', { supportsThinking: true }, { deepThinking: true });
  const g25 = getReasoningBudgetPolicy('gemini', 'gemini-2.5-pro', { supportsThinking: true }, { deepThinking: true });
  assert.strictEqual(g3.mechanism, 'gemini_level');
  assert.strictEqual(g25.mechanism, 'gemini_budget');
});

// ---------- 2. BẤT BIẾN CỐT LÕI: bật Thinking KHÔNG làm co answer budget ----------
test('6. ROOT CAUSE: answerBudget khi deepThinking=true >= answerBudget khi deepThinking=false', () => {
  const common = {
    provider: 'anthropic', model: 'claude-x', capabilities: { supportsThinking: true },
    stage: 'detail', problemText: 'Bài toán '.repeat(80), remainingMs: 300000, throughputTokensPerSec: 200
  };
  const fast = resolveBudget({ ...common, deepThinking: false });
  const deep = resolveBudget({ ...common, deepThinking: true });
  assert.ok(
    deep.answerBudget >= fast.answerBudget,
    `bật Thinking làm answerBudget tụt từ ${fast.answerBudget} xuống ${deep.answerBudget} — đúng bug gốc`
  );
});

test('7. ROOT CAUSE: providerMaxTokens = answerBudget + reasoningBudget (không phải chia đôi)', () => {
  const b = resolveBudget({
    provider: 'anthropic', model: 'claude-x', capabilities: { supportsThinking: true },
    stage: 'detail', problemText: 'x'.repeat(900), deepThinking: true,
    remainingMs: 300000, throughputTokensPerSec: 200
  });
  assert.ok(b.reasoningBudget > 0, 'phải có ngân sách reasoning riêng');
  assert.strictEqual(b.providerMaxTokens, b.answerBudget + b.reasoningBudget);
  assert.ok(b.providerMaxTokens > b.answerBudget, 'reasoning phải CỘNG THÊM, không trừ vào answer');
});

test('8. provider KHÔNG tính reasoning vào output -> providerMaxTokens = answerBudget', () => {
  const b = resolveBudget({
    provider: 'groq', model: 'llama', capabilities: { supportsThinking: true },
    stage: 'detail', problemText: 'x'.repeat(400), deepThinking: true, remainingMs: 300000
  });
  assert.strictEqual(b.reasoningCountsAgainstOutput, false);
  assert.strictEqual(b.providerMaxTokens, b.answerBudget);
});

test('9. 4 ngân sách TÁCH BẠCH và cộng đúng tổng', () => {
  const b = resolveBudget({
    provider: 'anthropic', model: 'c', capabilities: { supportsThinking: true },
    stage: 'detail', problemText: 'x'.repeat(500), deepThinking: true,
    requiresVisual: true, remainingMs: 300000, throughputTokensPerSec: 200
  });
  ['reasoningBudget', 'answerBudget', 'recoveryBudget', 'visualBudget'].forEach((k) => {
    assert.ok(Number.isFinite(b[k]), k + ' phải là số');
  });
  assert.ok(b.visualBudget > 0, 'requiresVisual=true phải cấp visualBudget riêng (PHẦN 30)');
  assert.strictEqual(b.totalBudget, b.answerBudget + b.recoveryBudget + b.reasoningBudget + b.visualBudget);
});

test('10. phase=recovery: answerBudget bám theo phần CÒN THIẾU (delta), reasoning giảm', () => {
  const common = {
    provider: 'anthropic', model: 'c', capabilities: { supportsThinking: true },
    stage: 'detail', problemText: 'x'.repeat(900), deepThinking: true, remainingMs: 300000,
    throughputTokensPerSec: 200
  };
  const init = resolveBudget(common);
  const rec = resolveBudget({ ...common, phase: 'recovery', deficitTokens: 2400 });
  assert.ok(rec.answerBudget >= 2000, `recovery phải được cấp đủ token cho phần thiếu (thấy ${rec.answerBudget})`);
  assert.ok(rec.reasoningBudget < init.reasoningBudget, 'lượt tiếp nối không cần suy luận lại từ đầu');
  assert.ok(rec.strategy.includes('delta_recovery'));
});

test('11. genericReasoningBudget: 0 khi không deepThinking, >0 và có sàn 1024 khi bật', () => {
  assert.strictEqual(genericReasoningBudget({ answerBudget: 3000, deepThinking: false }), 0);
  assert.ok(genericReasoningBudget({ answerBudget: 100, deepThinking: true }) >= 1024);
  const big = genericReasoningBudget({ answerBudget: 3000, complexityLevel: 'very_large', deepThinking: true });
  const small = genericReasoningBudget({ answerBudget: 3000, complexityLevel: 'short', deepThinking: true });
  assert.ok(big > small, 'bài phức tạp hơn phải được suy luận sâu hơn');
});

test('12. genericReasoningBudget phase=recovery nhỏ hơn phase=initial', () => {
  const a = genericReasoningBudget({ answerBudget: 4000, deepThinking: true });
  const b = genericReasoningBudget({ answerBudget: 4000, deepThinking: true, phase: 'recovery' });
  assert.ok(b < a);
});

// ---------- 3. Client PHẢI cộng reasoning vào max_tokens ----------
async function withFetch(stub, fn) {
  const real = global.fetch;
  global.fetch = stub;
  try { return await fn(); } finally { global.fetch = real; }
}
function okJson(body) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

(async function main() {
  await atest('13. anthropicClient: reasoningBudget -> max_tokens = answer + reasoning', async () => {
  const client = require('../server/utils/anthropicClient');
  let captured = null;
  await withFetch(async (url, opts) => {
    captured = JSON.parse(opts.body);
    return okJson({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
  }, () => client.callClaude({
    system: 's', messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 3000, reasoningBudget: 4000, deepThinking: true, fast: false,
    capabilities: { supportsThinking: true }, apiKeyOverride: 'k', modelOverride: 'm'
  }));
  assert.strictEqual(captured.max_tokens, 7000, 'max_tokens phải là 3000 (answer) + 4000 (reasoning)');
  assert.strictEqual(captured.thinking.budget_tokens, 4000);
  // Bất biến: phần còn lại cho văn bản hiển thị đúng bằng answerBudget.
  assert.strictEqual(captured.max_tokens - captured.thinking.budget_tokens, 3000);
});

  await atest('14. anthropicClient: caller CŨ (không truyền reasoningBudget) giữ hành vi cũ', async () => {
  const client = require('../server/utils/anthropicClient');
  let captured = null;
  await withFetch(async (url, opts) => {
    captured = JSON.parse(opts.body);
    return okJson({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
  }, () => client.callClaude({
    system: 's', messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 2000, deepThinking: true, fast: false,
    capabilities: { supportsThinking: true }, apiKeyOverride: 'k', modelOverride: 'm'
  }));
  assert.strictEqual(captured.max_tokens, 2000, 'tương thích ngược: không truyền reasoningBudget thì không đổi max_tokens');
  assert.ok(captured.thinking, 'vẫn bật native thinking như trước');
});

  await atest('15. geminiClient: KHÔNG còn thinkingBudget:-1 khi có reasoningBudget tường minh', async () => {
  const client = require('../server/utils/geminiClient');
  let captured = null;
  await withFetch(async (url, opts) => {
    captured = JSON.parse(opts.body);
    return okJson({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] });
  }, () => client.callGemini({
    system: 's', messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 2500, reasoningBudget: 3000, deepThinking: true, fast: false,
    capabilities: { supportsThinking: true }, apiKeyOverride: 'k', modelOverride: 'gemini-2.5-pro'
  }));
  const cfg = captured.generationConfig;
  assert.strictEqual(cfg.thinkingConfig.thinkingBudget, 3000, 'thinkingBudget:-1 cho phép model ăn hết maxOutputTokens -> text rỗng');
  assert.strictEqual(cfg.maxOutputTokens, 5500, 'maxOutputTokens phải cộng thêm reasoning');
});

  await atest('16. openaiClient: effort suy từ ngân sách + max_output_tokens cộng thêm reasoning', async () => {
  const client = require('../server/utils/openaiClient');
  let captured = null;
  await withFetch(async (url, opts) => {
    captured = JSON.parse(opts.body);
    return okJson({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] });
  }, () => client.callOpenAI({
    system: 's', messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 2000, reasoningBudget: 8000, deepThinking: true, fast: false,
    capabilities: { supportsThinking: true }, apiKeyOverride: 'k', modelOverride: 'o3'
  }));
  assert.strictEqual(captured.reasoning.effort, 'high', 'ngân sách lớn KHÔNG được hạ độ sâu reasoning');
  assert.strictEqual(captured.max_output_tokens, 10000);
});

test('17. effort/level quy đổi từ ngân sách — không bao giờ hạ độ sâu khi ngân sách lớn', () => {
  assert.strictEqual(effortFromBudget(9000), 'high');
  assert.strictEqual(effortFromBudget(3000), 'medium');
  assert.strictEqual(thinkingLevelFromBudget(9000), 'high');
});

// ---------- 4. PHẦN 5: finishReason phản ánh nguyên nhân THẬT ----------
test('18. classifyFinish phân biệt đủ 6 nguyên nhân', () => {
  assert.strictEqual(finish.classifyFinish({ raw: 'end_turn' }), finish.FINISH.STOP);
  assert.strictEqual(finish.classifyFinish({ raw: 'max_tokens' }), finish.FINISH.MAX_TOKENS);
  assert.strictEqual(finish.classifyFinish({ timedOut: true }), finish.FINISH.TIMEOUT);
  assert.strictEqual(finish.classifyFinish({ cancelled: true }), finish.FINISH.ABORT);
  assert.strictEqual(finish.classifyFinish({ interrupted: true }), finish.FINISH.STREAM_INTERRUPTED);
  assert.strictEqual(finish.classifyFinish({ error: new Error('boom') }), finish.FINISH.PROVIDER_ERROR);
});

test('19. tín hiệu tầng vận chuyển THẮNG tín hiệu nội dung (stream đứt không thể là "stop")', () => {
  assert.strictEqual(finish.classifyFinish({ raw: 'end_turn', interrupted: true }), finish.FINISH.STREAM_INTERRUPTED);
  assert.strictEqual(finish.classifyFinish({ raw: 'end_turn', cancelled: true }), finish.FINISH.ABORT);
});

test('20. recovery routing: hết token -> cấp thêm token; đứt stream -> đổi provider; abort -> dừng hẳn', () => {
  assert.ok(finish.needsMoreTokens(finish.FINISH.MAX_TOKENS));
  assert.ok(!finish.needsMoreTokens(finish.FINISH.STREAM_INTERRUPTED));
  assert.ok(finish.needsFailover(finish.FINISH.STREAM_INTERRUPTED));
  assert.ok(finish.isTerminal(finish.FINISH.ABORT));
  assert.ok(!finish.isTerminal(finish.FINISH.MAX_TOKENS));
});

test('21. normalizeFinishReason giữ NGUYÊN hợp đồng 3 giá trị cũ (không phá nơi gọi cũ)', () => {
  assert.strictEqual(finish.normalizeFinishReason('end_turn'), 'stop');
  assert.strictEqual(finish.normalizeFinishReason('length'), 'length');
  assert.strictEqual(finish.normalizeFinishReason('tool_use'), 'other');
  assert.strictEqual(finish.normalizeFinishReason(null), null);
});


let passed = 0, failed = 0;
console.log('\n== Regression: tách reasoning/answer budget — root cause lỗi Thinking ==');
results.forEach((r) => {
  if (r.pass) { passed++; console.log('  ok  - ' + r.name); }
  else { failed++; console.log(' FAIL - ' + r.name + '\n        ' + r.error); }
});
console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
