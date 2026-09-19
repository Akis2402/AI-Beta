'use strict';

// ============================================================================================
// B2 — TEST QUAN TRỌNG NHẤT: reasoningBudget KHÔNG ĐƯỢC RƠI MẤT trên đường xuống provider
// ============================================================================================
// LỖI GỐC ĐÃ XÁC NHẬN (trước bản sửa này): chat.js LUÔN truyền
// `reasoningBudget: budgetOf('candidate').reasoningBudget` vào gatherCrossCheckCandidates(), nhưng
// chữ ký hàm KHÔNG destructure field đó và cả 3 điểm gọi p.call(...) bên trong (round 1, retry,
// survivor) đều không forward. Hệ quả: MỌI candidate ở chế độ đối chiếu đa hướng chạy với
// reasoningBudget = undefined -> Anthropic rơi về nhánh legacy nativeThinkingBudget(maxTokens),
// tức reasoning ĂN VÀO answer budget đúng như lỗi mà reasoningPolicy.js sinh ra để sửa.
//
// Bộ test đi qua ĐÚNG chuỗi thật: gatherCrossCheckCandidates() -> target.call() -> provider client,
// cho cả 5 trường hợp provider (Anthropic, OpenAI reasoning, Gemini 2.5, Gemini 3+, không native).

const assert = require('assert');
const { gatherCrossCheckCandidates } = require('../server/utils/aiProviders');
const { getReasoningBudgetPolicy, effortFromBudget, thinkingLevelFromBudget } = require('../server/utils/budget/reasoningPolicy');

let passed = 0, failed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, error: e.message }); }
}

/** Execution target giả — ghi lại NGUYÊN VẸN args mà aiProviders truyền xuống. */
function makeTarget(id, providerKey, modelName, capabilities, seen, opts = {}) {
  const target = {
    id, providerKey, keyId: id, modelId: `${providerKey}::${modelName}`, modelName,
    label: `${providerKey} (${modelName})`, key: id, supportsWebSearch: false, capabilities,
    call: async (args) => {
      seen.push({ id, providerKey, modelName, args });
      if (opts.fail) throw Object.assign(new Error('provider lỗi giả lập'), { status: 502 });
      return `Lời giải của ${id}. Đáp số: **x = 2**`;
    },
    callStream: async () => ''
  };
  return target;
}

const REASONING_BUDGET = 5200;
const MAX_TOKENS = 4000;

async function runGather(targets) {
  const seen = [];
  const list = targets(seen);
  const out = await gatherCrossCheckCandidates(list, {
    system: 'SYS', variantSystem: 'SYS+VARIANT', messages: [{ role: 'user', content: 'đề bài' }],
    maxTokens: MAX_TOKENS,
    reasoningBudget: REASONING_BUDGET,
    deepThinking: true,
    maxCandidates: 3
  });
  return { seen, out };
}

(async () => {
  await test('B2-1. reasoningBudget tới ĐÚNG mọi candidate ở vòng 1 (không rơi mất khâu nào)', async () => {
    const { seen, out } = await runGather((seen) => [
      makeTarget('t-anthropic', 'anthropic', 'claude-sonnet-5', { supportsThinking: true, supportsAdaptiveThinking: true }, seen),
      makeTarget('t-openai', 'openai', 'o4-mini', { supportsThinking: true, supportsAdaptiveThinking: false }, seen),
      makeTarget('t-gemini', 'gemini', 'gemini-2.5-pro', { supportsThinking: true, supportsAdaptiveThinking: true }, seen)
    ]);
    assert.ok(out.candidates.length >= 2, 'phải thu được candidate');
    assert.ok(seen.length >= 2, 'phải có lệnh gọi thật');
    seen.forEach((s) => {
      assert.strictEqual(s.args.reasoningBudget, REASONING_BUDGET,
        `${s.id}: reasoningBudget bị rơi mất (nhận ${s.args.reasoningBudget})`);
      assert.strictEqual(s.args.maxTokens, MAX_TOKENS, `${s.id}: answerBudget phải nguyên vẹn, KHÔNG bị reasoning trừ vào`);
      assert.strictEqual(s.args.deepThinking, true);
    });
  });

  await test('B2-2. reasoningBudget cũng tới lượt RETRY của target lỗi (không chỉ vòng 1)', async () => {
    const seen = [];
    const targets = [
      makeTarget('t-fail', 'anthropic', 'claude-sonnet-5', { supportsThinking: true }, seen, { fail: true }),
      makeTarget('t-ok', 'openai', 'gpt-5', { supportsThinking: true }, seen),
      makeTarget('t-spare', 'gemini', 'gemini-3-pro', { supportsThinking: true }, seen)
    ];
    await gatherCrossCheckCandidates(targets, {
      system: 'SYS', variantSystem: 'SYSV', messages: [{ role: 'user', content: 'q' }],
      maxTokens: MAX_TOKENS, reasoningBudget: REASONING_BUDGET, deepThinking: true, maxCandidates: 3
    });
    assert.ok(seen.length >= 2);
    seen.forEach((s) => assert.strictEqual(s.args.reasoningBudget, REASONING_BUDGET,
      `${s.id} (kể cả lượt retry) phải nhận đúng reasoningBudget`));
  });

  await test('B2-3. lượt "góc nhìn khác" (survivor) cũng nhận đúng reasoningBudget', async () => {
    const seen = [];
    const targets = [makeTarget('t-solo', 'anthropic', 'claude-sonnet-5', { supportsThinking: true }, seen)];
    await gatherCrossCheckCandidates(targets, {
      system: 'SYS', variantSystem: 'SYSV', messages: [{ role: 'user', content: 'q' }],
      maxTokens: MAX_TOKENS, reasoningBudget: REASONING_BUDGET, deepThinking: true, maxCandidates: 2
    });
    assert.ok(seen.length >= 2, 'chỉ có 1 target -> phải có lượt survivor thứ 2');
    seen.forEach((s) => assert.strictEqual(s.args.reasoningBudget, REASONING_BUDGET));
  });

  await test('B2-4. 5 trường hợp provider: policy dịch reasoningBudget sang ĐÚNG cơ chế native của mình', () => {
    const cases = [
      ['anthropic', 'claude-sonnet-5', { supportsThinking: true, supportsAdaptiveThinking: true }, 'anthropic_budget', true],
      ['openai', 'o4-mini', { supportsThinking: true, supportsAdaptiveThinking: false }, 'openai_effort', true],
      ['gemini', 'gemini-2.5-pro', { supportsThinking: true, supportsAdaptiveThinking: true }, 'gemini_budget', true],
      ['gemini', 'gemini-3-pro-preview', { supportsThinking: true, supportsAdaptiveThinking: true }, 'gemini_level', true],
      ['grok', 'grok-4', { supportsThinking: false, supportsAdaptiveThinking: false }, 'prompt', false]
    ];
    cases.forEach(([provider, model, caps, mechanism, native]) => {
      const policy = getReasoningBudgetPolicy(provider, model, caps, { deepThinking: true, fast: false });
      assert.strictEqual(policy.mechanism, mechanism, `${provider}/${model} phải dùng cơ chế ${mechanism}`);
      assert.strictEqual(policy.native, native);
    });
    // Không lẫn cơ chế giữa 2 thế hệ Gemini.
    assert.strictEqual(effortFromBudget(REASONING_BUDGET), 'medium');
    assert.strictEqual(thinkingLevelFromBudget(REASONING_BUDGET), 'high');
  });

  await test('B2-5. provider KHÔNG native reasoning vẫn nhận field (client tự bỏ qua — an toàn)', async () => {
    const seen = [];
    const targets = [
      makeTarget('t-compat-1', 'grok', 'grok-4', { supportsThinking: false }, seen),
      makeTarget('t-compat-2', 'deepseek', 'deepseek-chat', { supportsThinking: false }, seen)
    ];
    await gatherCrossCheckCandidates(targets, {
      system: 'SYS', variantSystem: 'SYSV', messages: [{ role: 'user', content: 'q' }],
      maxTokens: MAX_TOKENS, reasoningBudget: REASONING_BUDGET, deepThinking: true, maxCandidates: 2
    });
    seen.forEach((s) => assert.strictEqual(s.args.reasoningBudget, REASONING_BUDGET,
      'truyền luôn là an toàn: client tự gate theo capability, không gửi field lạ lên API'));
  });

  await test('B7. retry KHÔNG trao cùng 1 target thay thế cho nhiều slot lỗi (duplicate target)', async () => {
    const seen = [];
    const targets = [
      makeTarget('fail-1', 'anthropic', 'm1', { supportsThinking: true }, seen, { fail: true }),
      makeTarget('fail-2', 'openai', 'm2', { supportsThinking: true }, seen, { fail: true }),
      makeTarget('spare-1', 'gemini', 'm3', { supportsThinking: true }, seen),
      makeTarget('spare-2', 'grok', 'm4', { supportsThinking: false }, seen)
    ];
    await gatherCrossCheckCandidates(targets, {
      system: 'SYS', variantSystem: 'SYSV', messages: [{ role: 'user', content: 'q' }],
      maxTokens: MAX_TOKENS, reasoningBudget: REASONING_BUDGET, deepThinking: true, maxCandidates: 2
    });
    const counts = seen.reduce((acc, s) => { acc[s.id] = (acc[s.id] || 0) + 1; return acc; }, {});
    Object.entries(counts).forEach(([id, n]) => {
      assert.ok(n <= 1, `target ${id} bị gọi ${n} lần trong cùng 1 round — duplicate target (B7)`);
    });
  });

  let p = 0, f = 0;
  console.log('\n== B2: reasoningBudget propagation qua gatherCrossCheckCandidates ==');
  results.forEach((r) => {
    if (r.pass) { p++; console.log('  ok  - ' + r.name); }
    else { f++; console.log(' FAIL - ' + r.name + '\n        ' + r.error); }
  });
  console.log(`\n${p} passed, ${f} failed`);
  if (f) process.exitCode = 1;
})();
