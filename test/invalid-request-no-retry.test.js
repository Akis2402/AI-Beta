'use strict';

// ---------- REGRESSION: INVALID_REQUEST KHÔNG RETRY TOÀN POOL (mục PHẦN 14) ----------
// BUG GỐC: errorClassifier.classify() đã phân loại đúng scope='invalid_request' cho lỗi 400/404/422
// (payload/schema sai — sẽ lặp lại Y HỆT ở MỌI target vì đây là lỗi của chính request, không phải
// của khóa/model cụ thể) nhưng callWithFailover()/streamWithFailover()/callFastest() vẫn tự động thử
// TIẾP target khác — tốn thêm N-1 lệnh gọi AI vô ích và chắc chắn thất bại giống hệt.
// FIX: cả 3 đường gọi dừng NGAY khi gặp scope='invalid_request', không thử thêm target nào nữa.

const assert = require('assert');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  -', name); }
  catch (e) { failed++; console.log(' FAIL -', name, '\n       ', e.stack || e.message); }
}

function freshAiProviders() {
  ['../server/utils/aiProviders.js', '../server/utils/rotationManager.js', '../server/utils/modelDiscovery.js',
    '../server/utils/executionTargets.js', '../server/utils/requestDeadline.js', '../server/utils/errorClassifier.js']
    .forEach((p) => { const r = require.resolve(p); delete require.cache[r]; });
  return require('../server/utils/aiProviders');
}

function makeInvalidRequestTarget(id, providerKey, callCounter) {
  return {
    id, providerKey, keyId: id, modelId: `${providerKey}::m`, modelName: 'm', label: id,
    supportsWebSearch: false, capabilities: {},
    call: async () => { callCounter.count++; const e = new Error('schema sai: thiếu trường bắt buộc'); e.status = 400; throw e; },
    callStream: async () => { callCounter.count++; const e = new Error('schema sai: thiếu trường bắt buộc'); e.status = 400; throw e; }
  };
}

function makeTransientThenOkTarget(id, providerKey, callCounter, { failFirst = true } = {}) {
  let calls = 0;
  return {
    id, providerKey, keyId: id, modelId: `${providerKey}::m`, modelName: 'm', label: id,
    supportsWebSearch: false, capabilities: {},
    call: async () => {
      callCounter.count++; calls++;
      if (failFirst && calls === 1) { const e = new Error('network hiccup'); throw e; } // không status -> transient
      return `ok-from-${id}`;
    }
  };
}

(async () => {
  console.log('\n== PHẦN 14: invalid_request KHÔNG retry toàn pool ==');

  await test('callWithFailover: 400 (invalid_request) trên target đầu -> KHÔNG thử target 2/3 (dừng ngay, đúng 1 lệnh gọi)', async () => {
    const aiProviders = freshAiProviders();
    const callCounter = { count: 0 };
    const targets = [
      makeInvalidRequestTarget('t1', 'anthropic', callCounter),
      makeInvalidRequestTarget('t2', 'gemini', callCounter),
      makeInvalidRequestTarget('t3', 'openai', callCounter)
    ];
    await assert.rejects(() => aiProviders.callWithFailover(targets, { messages: [] }, {}));
    assert.strictEqual(callCounter.count, 1, `phải dừng sau đúng 1 lệnh gọi (invalid_request lặp lại y hệt), thấy ${callCounter.count}`);
  });

  await test('callWithFailover: lỗi transient (không status/5xx) VẪN failover bình thường sang target khác', async () => {
    const aiProviders = freshAiProviders();
    const callCounter = { count: 0 };
    const targets = [
      makeTransientThenOkTarget('t1', 'anthropic', callCounter, { failFirst: true }),
      makeTransientThenOkTarget('t2', 'gemini', callCounter, { failFirst: false })
    ];
    const { text } = await aiProviders.callWithFailover(targets, { messages: [] }, {});
    assert.strictEqual(text, 'ok-from-t2');
    assert.strictEqual(callCounter.count, 2, 'lỗi transient phải vẫn thử tiếp target khác (không bị chặn nhầm như invalid_request)');
  });

  await test('streamWithFailover: 400 (invalid_request) -> KHÔNG thử target khác', async () => {
    const aiProviders = freshAiProviders();
    const callCounter = { count: 0 };
    const targets = [
      makeInvalidRequestTarget('t1', 'anthropic', callCounter),
      makeInvalidRequestTarget('t2', 'gemini', callCounter)
    ];
    await assert.rejects(() => aiProviders.streamWithFailover(targets, { messages: [] }, () => {}, {}));
    assert.strictEqual(callCounter.count, 1, `stream cũng phải dừng sau đúng 1 lệnh gọi, thấy ${callCounter.count}`);
  });

  await test('callFastest: primary lỗi invalid_request -> KHÔNG fallback sang target còn lại', async () => {
    const aiProviders = freshAiProviders();
    const callCounter = { count: 0 };
    const targets = [
      makeInvalidRequestTarget('t1', 'anthropic', callCounter),
      makeInvalidRequestTarget('t2', 'gemini', callCounter),
      makeInvalidRequestTarget('t3', 'openai', callCounter)
    ];
    await assert.rejects(() => aiProviders.callFastest(targets, { messages: [] }, { raceSize: 1 }));
    assert.strictEqual(callCounter.count, 1, `callFastest phải dừng sau đúng 1 lệnh gọi khi invalid_request, thấy ${callCounter.count}`);
  });

  await test('gatherCrossCheckCandidates: round 1 toàn bộ invalid_request -> KHÔNG có vòng retry (không tốn thêm lệnh gọi)', async () => {
    const aiProviders = freshAiProviders();
    const callCounter = { count: 0 };
    const targets = [
      makeInvalidRequestTarget('t1', 'anthropic', callCounter),
      makeInvalidRequestTarget('t2', 'gemini', callCounter),
      makeInvalidRequestTarget('t3', 'openai', callCounter),
      makeInvalidRequestTarget('t4', 'other', callCounter)
    ];
    const { candidates } = await aiProviders.gatherCrossCheckCandidates(targets, {
      system: 's', variantSystem: 's2', messages: [], maxTokens: 100, requestId: 'r1'
    });
    assert.strictEqual(candidates.length, 0);
    // Chỉ round 1 (tối đa CROSS_CHECK_MAX_CANDIDATES=3 target mặc định) được gọi, KHÔNG có retry
    // round (vì mọi lỗi đều invalid_request) và KHÔNG có survivor round.
    assert.strictEqual(callCounter.count, aiProviders.CROSS_CHECK_MAX_CANDIDATES,
      `chỉ round 1 được gọi (đúng ${aiProviders.CROSS_CHECK_MAX_CANDIDATES} lệnh), không retry thêm, thấy ${callCounter.count}`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
