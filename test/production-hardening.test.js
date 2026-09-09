'use strict';

// Test cho các fix "production hardening": cross-check giới hạn call (mục 1), model discovery
// single-flight + stale cache (mục 2), cancellation không failover/retry (mục 4), error object
// chuẩn hóa không leak API key (mục 6).

const assert = require('assert');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  -', name); }
  catch (e) { failed++; console.log(' FAIL -', name, '\n       ', e.stack || e.message); }
}

function freshAiProviders() {
  ['../server/utils/aiProviders.js', '../server/utils/rotationManager.js', '../server/utils/modelDiscovery.js',
   '../server/utils/executionTargets.js', '../server/utils/requestDeadline.js']
    .forEach((p) => { const r = require.resolve(p); delete require.cache[r]; });
  return require('../server/utils/aiProviders');
}

/** Tạo 1 fake execution target — KHÔNG đụng tới client/network thật, dùng để test thuần logic
 * điều phối (cross-check limit/cancellation) của aiProviders.js. */
function makeFakeTarget({ id, providerKey, shouldFail = false, callCounter, delayMs = 0 }) {
  return {
    id,
    providerKey,
    keyId: id,
    modelId: `${providerKey}::m`,
    modelName: 'm',
    label: id,
    supportsWebSearch: false,
    capabilities: {},
    call: async ({ signal } = {}) => {
      callCounter.count++;
      if (signal && signal.aborted) { const e = new Error('aborted'); e.cancelled = true; throw e; }
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (shouldFail) throw new Error('fake failure');
      return `answer-from-${id}`;
    }
  };
}

(async () => {
  console.log('\n== 1. Cross-check bị chặn trần số AI call (KHÔNG tỷ lệ thuận số target) ==');
  for (const n of [10, 20, 50]) {
    await test(`${n} execution target -> tổng số call cross-check vẫn bị chặn trần`, async () => {
      const aiProviders = freshAiProviders();
      const callCounter = { count: 0 };
      // Trộn nhiều provider khác nhau để pickDiverseCandidates có cơ hội thể hiện ưu tiên đa dạng.
      const targets = Array.from({ length: n }, (_, i) =>
        makeFakeTarget({ id: `t${i}`, providerKey: `provider${i % 5}`, callCounter })
      );
      const { candidates } = await aiProviders.gatherCrossCheckCandidates(targets, {
        system: 's', variantSystem: 's2', messages: [], maxTokens: 100, requestId: 'r1'
      });
      assert.ok(candidates.length >= 1, 'phải có ít nhất 1 candidate thành công');
      const maxAllowed = 2 * aiProviders.CROSS_CHECK_MAX_CANDIDATES + 1; // vòng 1 + retry + survivor
      assert.ok(
        callCounter.count <= maxAllowed,
        `số call thực tế (${callCounter.count}) phải <= ${maxAllowed}, không tỷ lệ thuận ${n} target`
      );
    });
  }

  await test('pickDiverseCandidates ưu tiên đa dạng provider trước khi lặp lại cùng 1 hãng', async () => {
    const aiProviders = freshAiProviders();
    const targets = [
      { id: 'a1', providerKey: 'anthropic' }, { id: 'a2', providerKey: 'anthropic' },
      { id: 'g1', providerKey: 'gemini' }, { id: 'o1', providerKey: 'openai' }
    ];
    const picked = aiProviders.pickDiverseCandidates(targets, 3);
    const providerKeys = picked.map((p) => p.providerKey);
    assert.strictEqual(new Set(providerKeys).size, 3, 'phải lấy đủ 3 hãng khác nhau, không lặp anthropic 2 lần khi còn hãng khác');
  });

  console.log('\n== 2. Model discovery: single-flight dedupe + stale cache khi discovery lỗi ==');
  await test('20 request concurrent discovery cùng (provider, key) -> chỉ 1 lệnh gọi mạng thật', async () => {
    delete require.cache[require.resolve('../server/utils/modelDiscovery')];
    const modelDiscovery = require('../server/utils/modelDiscovery');
    let networkCalls = 0;
    global.fetch = async () => {
      networkCalls++;
      await new Promise((r) => setTimeout(r, 20)); // mô phỏng độ trễ mạng thật để tạo cửa sổ race
      return { ok: true, text: async () => JSON.stringify({ data: [{ id: 'claude-x', display_name: 'x' }] }) };
    };
    const results = await Promise.all(
      Array.from({ length: 20 }, () => modelDiscovery.warmDiscovery('anthropic', 'sk-ant-shared', 'anthropic'))
    );
    assert.strictEqual(networkCalls, 1, `chỉ được gọi mạng đúng 1 lần, thực tế ${networkCalls} lần`);
    assert.ok(results.every((r) => r.qualityModelIds.includes('claude-x')), 'mọi request đồng thời đều phải nhận đúng kết quả discovery');
  });

  await test('discovery thất bại nhưng còn cache cũ -> vẫn dùng được (stale), không báo lỗi', async () => {
    delete require.cache[require.resolve('../server/utils/modelDiscovery')];
    const modelDiscovery = require('../server/utils/modelDiscovery');
    let call = 0;
    global.fetch = async () => {
      call++;
      if (call === 1) return { ok: true, text: async () => JSON.stringify({ data: [{ id: 'claude-good', display_name: 'g' }] }) };
      throw new Error('network down lần 2');
    };
    const first = await modelDiscovery.warmDiscovery('anthropic', 'sk-ant-x', 'anthropic');
    assert.deepStrictEqual(first.qualityModelIds, ['claude-good']);
    const second = await modelDiscovery.warmDiscovery('anthropic', 'sk-ant-x', 'anthropic', undefined, { force: true });
    assert.deepStrictEqual(second.qualityModelIds, ['claude-good'], 'discovery lỗi lần 2 phải fallback về cache cũ (stale), không trả rỗng');
  });

  console.log('\n== 4. Cancellation: không failover/retry sau khi bị hủy ==');
  await test('signal đã abort TRƯỚC callWithFailover -> không gọi bất kỳ target nào, ném lỗi cancelled', async () => {
    const aiProviders = freshAiProviders();
    const callCounter = { count: 0 };
    const controller = new AbortController();
    controller.abort();
    const targets = [makeFakeTarget({ id: 't1', providerKey: 'anthropic', callCounter })];
    await assert.rejects(
      aiProviders.callWithFailover(targets, { system: 's', messages: [], signal: controller.signal }),
      (e) => e.cancelled === true
    );
    assert.strictEqual(callCounter.count, 0, 'không được gọi target nào khi đã bị hủy từ đầu');
  });

  await test('bị hủy giữa chừng callWithFailover -> KHÔNG thử failover sang target khác', async () => {
    const aiProviders = freshAiProviders();
    const callCounter = { count: 0 };
    const controller = new AbortController();
    const targets = [
      { id: 't1', providerKey: 'a', keyId: 't1', modelId: 'a::m', modelName: 'm', label: 't1', capabilities: {},
        call: async () => { callCounter.count++; controller.abort(); const e = new Error('cancel giữa chừng'); e.cancelled = true; throw e; } },
      makeFakeTarget({ id: 't2', providerKey: 'b', callCounter })
    ];
    await assert.rejects(
      aiProviders.callWithFailover(targets, { system: 's', messages: [], signal: controller.signal }),
      (e) => e.cancelled === true
    );
    assert.strictEqual(callCounter.count, 1, 't2 không được thử sau khi t1 báo cancelled — dừng failover ngay');
  });

  await test('gatherCrossCheckCandidates với signal đã abort -> không gọi provider nào, trả candidates rỗng', async () => {
    const aiProviders = freshAiProviders();
    const callCounter = { count: 0 };
    const controller = new AbortController();
    controller.abort();
    const targets = Array.from({ length: 5 }, (_, i) => makeFakeTarget({ id: `t${i}`, providerKey: `p${i}`, callCounter }));
    const { candidates } = await aiProviders.gatherCrossCheckCandidates(targets, {
      system: 's', variantSystem: 's2', messages: [], maxTokens: 100, signal: controller.signal
    });
    assert.strictEqual(candidates.length, 0);
    assert.strictEqual(callCounter.count, 0, 'không được tốn 1 lệnh gọi AI nào khi đã bị hủy từ đầu');
  });

  console.log('\n== 6. Error object chuẩn hóa: không leak API key/stack ở production ==');
  await test('normalizeError: production ẩn debugMessage, vẫn có code/userMessage/retryable', async () => {
    delete require.cache[require.resolve('../server/utils/errorNormalize')];
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { normalizeError } = require('../server/utils/errorNormalize');
      const secretKey = 'sk-ant-super-secret-abc123';
      const err = new Error('Rate limited');
      err.status = 429;
      err.detail = `raw provider body chứa key ${secretKey}`;
      const n = normalizeError(err);
      assert.strictEqual(n.code, 'RATE_LIMIT');
      assert.strictEqual(n.retryable, true);
      assert.strictEqual(n.debugMessage, undefined, 'production không được lộ debugMessage');
      assert.ok(!JSON.stringify(n).includes(secretKey), 'response chuẩn hóa không được chứa API key dù ở đâu');
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  await test('normalizeError: mapping status -> code đúng cho các nhóm lỗi chính', async () => {
    delete require.cache[require.resolve('../server/utils/errorNormalize')];
    const { normalizeError } = require('../server/utils/errorNormalize');
    const cases = [[400, 'INVALID_INPUT'], [401, 'AUTH_CONFIG'], [404, 'MODEL_NOT_FOUND'], [408, 'TIMEOUT'], [429, 'RATE_LIMIT'], [504, 'TIMEOUT'], [502, 'PROVIDER_ERROR']];
    for (const [status, expectedCode] of cases) {
      const err = new Error('x'); err.status = status;
      assert.strictEqual(normalizeError(err).code, expectedCode, `status ${status} phải map sang ${expectedCode}`);
    }
  });

  await test('normalizeError: lỗi bị hủy (cancelled) không được coi là retryable', async () => {
    delete require.cache[require.resolve('../server/utils/errorNormalize')];
    const { normalizeError } = require('../server/utils/errorNormalize');
    const err = new Error('Yêu cầu đã bị hủy.'); err.status = 499; err.cancelled = true; err.code = 'CANCELLED';
    const n = normalizeError(err);
    assert.strictEqual(n.retryable, false);
    assert.strictEqual(n.code, 'CANCELLED');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
