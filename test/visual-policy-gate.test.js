'use strict';

// ============================================================================================
// V6.15 — VISUAL POLICY HARD SHORT-CIRCUIT (server/utils/visual/visualPolicy.js)
// ============================================================================================
// Bao phủ đúng bộ test P0 mà master prompt V6.15.11 yêu cầu (N1-N7), cộng test cho
// completionFlags() (V6.15.5) và sanitizeCachedPayload() (V6.15.7). Chạy thuần Node, 0 network,
// 0 express — khớp quy ước harness hiện có (test/run-all.js liệt kê mọi *.test.js).

const assert = require('assert');
const policy = require('../server/utils/visual/visualPolicy');
const pipeline = require('../server/utils/visual/visualPipeline');

const results = [];
function test(name, fn) { try { fn(); results.push({ name, pass: true }); } catch (e) { results.push({ name, pass: false, error: e && e.message }); } }
async function atest(name, fn) { try { await fn(); results.push({ name, pass: true }); } catch (e) { results.push({ name, pass: false, error: e && e.message }); } }

(async function main() {
  console.log('\n== P0 — Never semantic gate (V6.15.11) ==');

  await atest('N1. NEVER + câu hỏi thường -> text OK, tuyệt đối 0 công việc hình', async () => {
    let judgeCalled = false;
    const r = await pipeline.runVisualPipeline({
      question: 'Giải phương trình x² - 5x + 6 = 0', finalAnswer: 'x=2 hoặc x=3', subject: 'math',
      answerComplete: true, userPreference: 'never',
      judge: async () => { judgeCalled = true; return { useful: true, confidence: 1 }; }
    });
    assert.strictEqual(r.status, 'skipped');
    assert.strictEqual(r.skippedByPolicy, true);
    assert.strictEqual(r.telemetry.visualLifecycleAllowed, false);
    assert.strictEqual(r.telemetry.visualWorkStarted, false);
    assert.strictEqual(r.telemetry.visualJudgeCalls, 0);
    assert.strictEqual(r.telemetry.visualProviderAttempts, 0);
    assert.strictEqual(r.telemetry.visualCacheDispatch, false);
    assert.strictEqual(judgeCalled, false, 'judge tuyệt đối không được gọi khi never chặn');
  });

  test('N2. NEVER + deadline gần hết -> policy resolve KHÔNG phụ thuộc deadline (chặn trước khi đọc remaining())', () => {
    const p = policy.resolveVisualPolicy({ userPreference: 'never', question: 'Tính đạo hàm của f(x) = x^2', stage: 'approach' });
    assert.strictEqual(p.allowVisualLifecycle, false);
    assert.strictEqual(p.reason, 'user_preference_never');
  });

  await atest('N2b. Tích hợp: NEVER + deadline=0ms vẫn skipped, KHÔNG probe SVG (Root Cause B)', async () => {
    const deadline = { remaining: () => 0 };
    const r = await pipeline.runVisualPipeline({
      question: 'Cho tam giác ABC vuông tại A. Tính BC.', finalAnswer: 'BC = 5', subject: 'math',
      answerComplete: true, userPreference: 'never', deadline
    });
    assert.strictEqual(r.status, 'skipped');
    assert.strictEqual(r.telemetry.visualDeterministic, false, 'SVG tất định KHÔNG được thử khi never chặn, kể cả emergency deadline');
  });

  test('N3. NEVER + yêu cầu tường minh ("Vẽ đồ thị…") -> vẫn được phép cho lượt này', () => {
    const p = policy.resolveVisualPolicy({ userPreference: 'never', question: 'Vẽ đồ thị hàm số y=x^2', stage: 'approach' });
    assert.strictEqual(p.allowVisualLifecycle, true);
    assert.strictEqual(p.explicitRequest, true);
    assert.strictEqual(p.reason, 'explicit_override_never');
  });

  test('N4. NEVER + stage image_only -> luôn coi là yêu cầu tường minh (đường "chỉ lấy hình")', () => {
    const p = policy.resolveVisualPolicy({ userPreference: 'never', question: 'tế bào', stage: 'image_only', explicitRequest: true });
    assert.strictEqual(p.allowVisualLifecycle, true);
    assert.strictEqual(p.blocking, true, 'image-only là PRIMARY artifact -> blocking=true (V6.15.6 exception)');
  });

  test('N5. NEVER + cache cũ có visualJob -> sanitizeCachedPayload() gỡ sạch, không phát visual:request', () => {
    const neverPolicy = policy.resolveVisualPolicy({ userPreference: 'never', question: 'Tính 2+2', stage: 'approach' });
    const cached = { text: 'đáp án', visuals: [{ url: 'x' }], visualJob: { renderer: 'puter_image', prompt: 'x' }, visualPolicyVersion: policy.VISUAL_POLICY_VERSION };
    const { payload, visualReplayAllowed } = policy.sanitizeCachedPayload(cached, neverPolicy);
    assert.strictEqual(visualReplayAllowed, false);
    assert.strictEqual(payload.visuals, undefined);
    assert.strictEqual(payload.visualJob, undefined);
    assert.strictEqual(payload.visualPending, false);
    assert.strictEqual(payload.text, 'đáp án', 'phần TEXT vẫn được giữ nguyên — chỉ hình bị chặn');
  });

  test('N5b. Cache từ phiên bản CŨ (thiếu visualPolicyVersion) không được replay hình dù policy hiện tại cho phép', () => {
    const autoPolicy = policy.resolveVisualPolicy({ userPreference: 'auto', question: 'Tính diện tích hình tròn', stage: 'approach' });
    const staleCached = { text: 'đáp án', visualJob: { renderer: 'puter_image' } };
    const { visualReplayAllowed } = policy.sanitizeCachedPayload(staleCached, autoPolicy);
    assert.strictEqual(visualReplayAllowed, false, 'cache thiếu policyVersion phải bị coi là không đáng tin cho phần hình (fail-closed)');
  });

  test('N5c. Cache MỚI (đúng policyVersion) + policy hiện tại cho phép -> được replay', () => {
    const autoPolicy = policy.resolveVisualPolicy({ userPreference: 'auto', question: 'Tính diện tích hình tròn', stage: 'approach' });
    const freshCached = { text: 'đáp án', visualJob: { renderer: 'puter_image' }, visualPolicyVersion: policy.VISUAL_POLICY_VERSION };
    const { visualReplayAllowed, payload } = policy.sanitizeCachedPayload(freshCached, autoPolicy);
    assert.strictEqual(visualReplayAllowed, true);
    assert.strictEqual(payload.visualJob.renderer, 'puter_image');
  });

  test('N6. resolveVisualPolicy() là hàm THUẦN — 2 lượt gọi độc lập cho đúng 2 kết quả tương ứng userPreference truyền vào', () => {
    const requestA = policy.resolveVisualPolicy({ userPreference: 'never', question: 'Tính 1+1', stage: 'approach' });
    const requestB = policy.resolveVisualPolicy({ userPreference: 'auto', question: 'Tính 1+1', stage: 'approach' });
    assert.strictEqual(requestA.allowVisualLifecycle, false);
    assert.strictEqual(requestB.allowVisualLifecycle, true);
  });

  test('N7. 5 lượt gọi liên tiếp dưới NEVER đều skipped độc lập, không tích luỹ side effect', () => {
    for (let i = 0; i < 5; i += 1) {
      const p = policy.resolveVisualPolicy({ userPreference: 'never', question: `Tính ${i}+${i}`, stage: 'approach' });
      assert.strictEqual(p.allowVisualLifecycle, false);
    }
  });

  console.log('\n== L — SSE / completion semantics (V6.15.5) ==');

  test('L1. completionFlags(never, không explicit) -> visualPending=false, visualBlocking=false', () => {
    const p = policy.resolveVisualPolicy({ userPreference: 'never', question: 'Tính 2+2', stage: 'approach' });
    const flags = policy.completionFlags(p, { visualMayFollow: p.allowVisualLifecycle });
    assert.strictEqual(flags.visualPending, false);
    assert.strictEqual(flags.visualBlocking, false);
    assert.strictEqual(flags.visualPolicy.skippedByPolicy, true);
  });

  test('L2. completionFlags(auto, cho phép) -> visualPending=true (đuôi hình optional vẫn còn trên stream)', () => {
    const p = policy.resolveVisualPolicy({ userPreference: 'auto', question: 'Vẽ tam giác ABC', stage: 'approach' });
    const flags = policy.completionFlags(p, { visualMayFollow: p.allowVisualLifecycle });
    assert.strictEqual(flags.visualPending, true);
  });

  test('L3. image_only luôn blocking=true khi caller xác nhận visualMayFollow=true', () => {
    const p = policy.resolveVisualPolicy({ userPreference: 'always', question: 'tạo hình tế bào', stage: 'image_only', explicitRequest: true });
    const flags = policy.completionFlags(p, { visualMayFollow: true });
    assert.strictEqual(flags.visualBlocking, true);
  });

  console.log('\n== Regression: AUTO/ALWAYS không bị policy gate mới chặn nhầm ==');

  test('R1. AUTO không có yêu cầu tường minh vẫn đi tiếp vào pipeline bình thường (không bị coi là never)', () => {
    const p = policy.resolveVisualPolicy({ userPreference: 'auto', question: 'Cho tam giác ABC vuông tại A, AB=3, AC=4', stage: 'approach' });
    assert.strictEqual(p.allowVisualLifecycle, true);
    assert.strictEqual(p.mode, 'auto');
  });

  test('R2. ALWAYS luôn cho lifecycle chạy tiếp (không bị policy gate mới chặn)', () => {
    const p = policy.resolveVisualPolicy({ userPreference: 'always', question: 'Tính 1+1', stage: 'approach' });
    assert.strictEqual(p.allowVisualLifecycle, true);
  });

  test('R3. Giá trị userPreference lạ -> chuẩn hoá về auto (khớp validators.js), không throw', () => {
    const p = policy.resolveVisualPolicy({ userPreference: 'yes-please', question: 'Tính 1+1', stage: 'approach' });
    assert.strictEqual(p.mode, 'auto');
  });

  await atest('R4. Tích hợp: AUTO + câu hỏi hình học vẫn đi tới quyết định thật (không bị skippedByPolicy)', async () => {
    const r = await pipeline.runVisualPipeline({
      question: 'Cho tam giác ABC vuông tại A, AB=3, AC=4. Vẽ hình minh hoạ.',
      finalAnswer: 'BC = 5', subject: 'math', answerComplete: true, userPreference: 'auto'
    });
    assert.notStrictEqual(r.status, 'skipped');
  });

  let passed = 0;
  let failed = 0;
  results.forEach((r) => {
    if (r.pass) { passed += 1; console.log('  ok  - ' + r.name); }
    else { failed += 1; console.log(' FAIL - ' + r.name + '\n        ' + r.error); }
  });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
