'use strict';

// ============================================================================================
// LONG-RUN VALIDATION (mục 22/36 audit "Fix toàn diện Rotation/Thinking/Đối chiếu đa hướng")
// ============================================================================================
// Bộ test này mô phỏng NHIỀU request liên tiếp (không phải 1 request đơn lẻ) để chứng minh bằng số
// đo, không phải cảm giác:
//   - Rotation công bằng dài hạn: 100 request, 8 target khỏe -> không target nào bị "đói" lâu dài.
//   - Thinking không bị "kẹt" vào 1-2 AI sau nhiều request liên tục.
//   - Cross-check adaptive: pool càng nhiều target khỏe, số AI THAM GIA THẬT càng nhiều (không dừng
//     ở 2-3 khi còn 4-10 target khỏe) — đúng "Test 1/2/3/10/11" trong yêu cầu gốc.
//   - Cooldown hết hạn -> target tự quay lại rotation (Test 8).
//   - Target/key/model lỗi chỉ ảnh hưởng ĐÚNG phạm vi của nó (Test 5/6/7).

const assert = require('assert');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  -', name); }
  catch (e) { failed++; console.log(' FAIL -', name, '\n       ', e.stack || e.message); }
}

function freshModules() {
  ['../server/utils/aiProviders.js', '../server/utils/rotationManager.js', '../server/utils/executionTargets.js',
    '../server/utils/requestDeadline.js', '../server/utils/errorClassifier.js']
    .forEach((p) => { const r = require.resolve(p); delete require.cache[r]; });
  return {
    aiProviders: require('../server/utils/aiProviders'),
    rotationManager: require('../server/utils/rotationManager')
  };
}

function makeTarget(id, providerKey, callCounter, { shouldFail = false } = {}) {
  return {
    id, providerKey, keyId: id, modelId: `${providerKey}::m`, modelName: 'm', label: id,
    supportsWebSearch: false, capabilities: {},
    call: async ({ signal } = {}) => {
      callCounter.count[id] = (callCounter.count[id] || 0) + 1;
      if (signal && signal.aborted) { const e = new Error('aborted'); e.cancelled = true; throw e; }
      if (shouldFail) throw new Error('fake failure');
      return `answer-from-${id}`;
    },
    callStream: async () => `answer-from-${id}`
  };
}

(async () => {
  console.log('\n== Test 1/11: 100 request, 8 target khỏe -> rotation công bằng dài hạn (callWithFailover) ==');
  await test('100 request round-robin -> chênh lệch usage giữa target nhiều nhất/ít nhất nằm trong sai số hợp lý', async () => {
    const { aiProviders, rotationManager } = freshModules();
    rotationManager._resetRotationStateForTest();
    const usage = {};
    const targets = Array.from({ length: 8 }, (_, i) => makeTarget(`t${i}`, `p${i % 3}`, { count: usage }));
    for (let i = 0; i < 100; i++) {
      await aiProviders.callWithFailover(targets, { messages: [] }, {});
    }
    const counts = targets.map((t) => usage[t.id] || 0);
    const min = Math.min(...counts), max = Math.max(...counts);
    assert.strictEqual(counts.reduce((a, b) => a + b, 0), 100, 'tổng số lượt gọi phải đúng 100');
    assert.ok(min > 0, `mọi target đều phải được dùng ít nhất 1 lần sau 100 request, thấy ${JSON.stringify(usage)}`);
    assert.ok(max - min <= 2, `chênh lệch dùng nhiều nhất/ít nhất phải rất nhỏ với round-robin thuần, thấy min=${min} max=${max}`);
  });

  console.log('\n== Test 10: Thinking (deepThinking=true) 100 request liên tục -> KHÔNG stick vào 1-2 AI ==');
  await test('100 request deepThinking=true -> mọi target khỏe đều được luân phiên, không có 1 AI chiếm > 50%', async () => {
    const { aiProviders, rotationManager } = freshModules();
    rotationManager._resetRotationStateForTest();
    const usage = {};
    const targets = Array.from({ length: 5 }, (_, i) => makeTarget(`th${i}`, `p${i % 2}`, { count: usage }));
    for (let i = 0; i < 100; i++) {
      await aiProviders.callWithFailover(targets, { messages: [], deepThinking: true }, {});
    }
    const total = Object.values(usage).reduce((a, b) => a + b, 0);
    const usedTargets = Object.keys(usage).length;
    assert.strictEqual(usedTargets, targets.length, `tất cả ${targets.length} target phải được dùng qua rotation, chỉ thấy ${usedTargets}`);
    Object.values(usage).forEach((c) => {
      assert.ok(c / total < 0.5, `1 target không được chiếm > 50% lượt gọi Thinking (thấy tỉ lệ ${c}/${total})`);
    });
  });

  console.log('\n== Test 2/3: pool 4-10 target khỏe -> cross-check phải huy động NHIỀU HƠN 2-3 AI ==');
  for (const n of [4, 6, 10]) {
    await test(`${n} target khỏe -> cross-check thực tế chạy ${n} AI (adaptive, không dừng ở 2-3)`, async () => {
      const { aiProviders } = freshModules();
      const usage = { count: {} };
      const targets = Array.from({ length: n }, (_, i) => makeTarget(`cc${i}`, `p${i % 4}`, usage));
      const { accounting } = await aiProviders.gatherCrossCheckCandidates(targets, {
        system: 's', variantSystem: 'sv', messages: [], maxTokens: 100, requestId: `r-${n}`
      });
      assert.strictEqual(accounting.startedTargets, n, `phải khởi động đúng ${n} target, thấy ${accounting.startedTargets}`);
      assert.ok(accounting.startedTargets > 3 || n <= 3, `với ${n} target khỏe không được dừng ở <= 3`);
    });
  }

  console.log('\n== Test 11: 10 cross-check request liên tiếp -> participant pool xoay vòng, không luôn cùng 1 nhóm ==');
  await test('10 request cross-check liên tiếp, pool 6 target, participant cap=3 (explicit) -> tập 3 AI được chọn phải đổi qua các request', async () => {
    const { aiProviders, rotationManager } = freshModules();
    rotationManager._resetRotationStateForTest();
    const usage = { count: {} };
    const targets = Array.from({ length: 6 }, (_, i) => makeTarget(`r${i}`, `p${i % 3}`, usage));
    const seenGroups = [];
    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line no-await-in-loop
      const { candidates } = await aiProviders.gatherCrossCheckCandidates(targets, {
        system: 's', variantSystem: 'sv', messages: [], maxTokens: 100, requestId: `r11-${i}`, maxCandidates: 3
      });
      seenGroups.push(candidates.map((c) => c.label).sort().join(','));
    }
    const distinctGroups = new Set(seenGroups);
    assert.ok(distinctGroups.size > 1, `participant group phải thay đổi qua 10 request (rotation), thấy luôn 1 nhóm: ${[...distinctGroups]}`);
    assert.strictEqual(Object.keys(usage.count).length, targets.length, 'sau 10 request, mọi target trong pool 6 đều phải được dùng ít nhất 1 lần qua rotation');
  });

  console.log('\n== Test 8: cooldown hết hạn -> target tự quay lại rotation ==');
  await test('target bị cooldown do lỗi transient -> sau khi cooldownUntil qua, target quay lại eligible', async () => {
    const { rotationManager } = freshModules();
    rotationManager._resetRotationStateForTest();
    const target = { id: 'tc1', keyId: 'tc1', modelId: 'p::m' };
    rotationManager.markFailure(target, new Error('network timeout'));
    let eligible = rotationManager.getEligibleTargets([target]);
    assert.strictEqual(eligible.length, 0, 'ngay sau lỗi transient, target phải đang cooldown (không eligible)');
    // Giả lập thời gian trôi qua bằng cách patch trực tiếp cooldownUntil về quá khứ qua exportSnapshot/applySnapshot.
    const snap = rotationManager.exportSnapshot();
    Object.keys(snap.target).forEach((k) => { snap.target[k].cooldownUntil = Date.now() - 1000; });
    rotationManager._resetRotationStateForTest();
    rotationManager.applySnapshot(snap);
    eligible = rotationManager.getEligibleTargets([target]);
    assert.strictEqual(eligible.length, 1, 'sau khi cooldownUntil đã qua, target phải TỰ ĐỘNG quay lại eligible');
  });

  console.log('\n== Test 5/6: lỗi chỉ ảnh hưởng đúng phạm vi (target-level lỗi KHÔNG kéo cả key/model khác) ==');
  await test('1 target lỗi transient -> target khác CÙNG key/khác model vẫn khỏe mạnh', async () => {
    const { rotationManager } = freshModules();
    rotationManager._resetRotationStateForTest();
    const targetA = { id: 'kA::m1', keyId: 'kA', modelId: 'p::m1' };
    const targetB = { id: 'kA::m2', keyId: 'kA', modelId: 'p::m2' };
    rotationManager.markFailure(targetA, new Error('network timeout')); // transient -> scope target-level (không status)
    const eligible = rotationManager.getEligibleTargets([targetA, targetB]);
    assert.deepStrictEqual(eligible.map((t) => t.id), ['kA::m2'], 'chỉ targetA bị cooldown, targetB (khác model, cùng key) vẫn khỏe');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
