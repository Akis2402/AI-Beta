'use strict';

// ============================================================================================
// REGRESSION — CANONICAL VISUAL CACHE POLICY GATE (Master Prompt V6.17.3 / V6.17.10)
// ============================================================================================
// Bắt ĐÚNG ROOT CAUSE của T1, không bắt triệu chứng:
//   payload ghi vào result cache thiếu metadata policy -> lần đọc sau bị sanitize fail-closed gỡ
//   mất `visualJob` -> cache-hit không còn phát được `visual:request` -> "text cache hit == no visual".
//
// Test này ở mức UNIT/HELPER (ưu tiên của V6.17.11). E2E xuyên route nằm ở
// test/puter-visualjob-cache-e2e.test.js và chỉ dùng để khoá behavior đầu-cuối.
//
// Ma trận bắt buộc:
//   P1. cache entry sau generation có visualPolicyVersion === CURRENT
//   P2. cache-hit giữ nguyên visualJob + visualId cũ (không sinh job mới)
//   P3. cache-hit JSON giữ visualJob
//   P4. stale cache thiếu policyVersion vẫn bị sanitize/remove
//   P5. policy NEVER vẫn gỡ visualJob dù cache version mới
//   P6. tất cả 4 cache-writer branches đều ghi canonical visual metadata
//   C1..C8 (V6.17.10) — cache/policy matrix
// ============================================================================================

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const policy = require('../server/utils/visual/visualPolicy');
const decisionEngine = require('../server/utils/visual/visualDecisionEngine');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  -', name); }
  catch (e) { failed++; console.log(' FAIL -', name, '\n        ' + (e && e.message)); }
}

const JOB = {
  visualId: 'vz_fixed_1',
  visualFingerprint: 'fp_abcdef',
  renderer: 'puter_image',
  prompt: 'a parabola y = x^2 on a coordinate plane',
  status: 'QUEUED'
};

/** Một visualRun client-primary điển hình (pipeline trả status 'pending' + visualJob). */
const RUN_PENDING = { status: 'pending', visuals: [], visualJob: JOB };
/** Một visualRun không có hình. */
const RUN_NONE = { status: 'skipped', visuals: [], visualJob: null };

const AUTO = policy.resolveRoutePolicy({ userPreference: 'auto', stage: 'approach', question: 'Vẽ bằng AI hình minh hoạ parabol y = x^2' });
const ALWAYS = policy.resolveRoutePolicy({ userPreference: 'always', stage: 'approach', question: 'Vẽ bằng AI hình minh hoạ parabol y = x^2' });
const NEVER_PLAIN = policy.resolveRoutePolicy({ userPreference: 'never', stage: 'approach', question: 'Giải phương trình bậc hai x^2 - 3x + 2 = 0' });
const NEVER_EXPLICIT = policy.resolveRoutePolicy({ userPreference: 'never', stage: 'approach', question: 'Vẽ hình minh hoạ parabol y = x^2 giúp tôi' });
const DETAIL = policy.resolveRoutePolicy({ userPreference: 'auto', stage: 'detail', question: 'Vẽ bằng AI hình minh hoạ parabol y = x^2' });

console.log('\n== P. Canonical cache payload / fail-closed sanitize ==');

test('P1. payload sau generation mang visualPolicyVersion HIỆN TẠI + đủ cờ policy', () => {
  const out = policy.finalizeVisualCachePayload({ text: 'answer', state: 'COMPLETED' }, RUN_PENDING, ALWAYS);
  assert.strictEqual(out.visualPolicyVersion, policy.VISUAL_POLICY_VERSION);
  assert.strictEqual(out.visualPolicy, 'ALWAYS');
  assert.strictEqual(out.visualBlocking, false, 'hình KHÔNG BAO GIỜ chặn text');
  assert.strictEqual(out.visualPending, false, 'payload đã hoàn tất thì không còn gì "sẽ tới sau"');
  assert.strictEqual(out.text, 'answer', 'text phải nguyên vẹn');
  assert.ok(out.visualJob, 'visualJob phải có mặt trong payload được cache');
  assert.ok(Array.isArray(out.visuals));
  assert.strictEqual(out.visualStatus, 'pending');
});

test('P2. cache-hit trả lại ĐÚNG job đã cache (cùng visualId/fingerprint), KHÔNG sinh job mới', () => {
  const cached = policy.finalizeVisualCachePayload({ text: 'answer' }, RUN_PENDING, AUTO);
  const s = policy.sanitizeCachedPayload(cached, AUTO);
  assert.strictEqual(s.stale, false);
  assert.strictEqual(s.visualReplayAllowed, true);
  assert.strictEqual(s.payload.visualJob.visualId, JOB.visualId, 'visualId phải y hệt — client dedupe qua IndexedDB');
  assert.strictEqual(s.payload.visualJob.visualFingerprint, JOB.visualFingerprint);
  assert.strictEqual(s.payload.visualJob.renderer, 'puter_image');
});

test('P3. cache-hit JSON non-stream giữ visualJob (không có SSE để bù)', () => {
  const cached = policy.finalizeVisualCachePayload({ text: 'answer' }, RUN_PENDING, AUTO);
  const s = policy.sanitizeCachedPayload(cached, AUTO);
  assert.ok(s.payload.visualJob && s.payload.visualJob.prompt, 'JSON phải mang đủ job + prompt');
});

test('P4. cache THIẾU visualPolicyVersion -> FAIL-CLOSED: gỡ visualJob, GIỮ text', () => {
  const legacy = { text: 'answer cũ', visuals: [], visualStatus: 'pending', visualJob: JOB };
  const s = policy.sanitizeCachedPayload(legacy, ALWAYS);
  assert.strictEqual(s.stale, true);
  assert.strictEqual(s.reason, 'missing_policy_version');
  assert.strictEqual(s.visualReplayAllowed, false);
  assert.strictEqual(s.payload.visualJob, null);
  assert.deepStrictEqual(s.payload.visuals, []);
  assert.strictEqual(s.payload.text, 'answer cũ', 'text KHÔNG được mất theo');
});

test('P4b. cache SAI phiên bản (version khác) cũng bị sanitize', () => {
  const old = { text: 'answer', visualPolicyVersion: 'vp-0', visualJob: JOB };
  const s = policy.sanitizeCachedPayload(old, ALWAYS);
  assert.strictEqual(s.stale, true);
  assert.strictEqual(s.reason, 'stale_policy_version');
  assert.strictEqual(s.payload.visualJob, null);
});

test('P5. policy NEVER (không có yêu cầu tường minh) vẫn gỡ visualJob dù cache version MỚI', () => {
  const fresh = policy.finalizeVisualCachePayload({ text: 'answer' }, RUN_PENDING, ALWAYS);
  assert.strictEqual(fresh.visualPolicyVersion, policy.VISUAL_POLICY_VERSION);
  const s = policy.sanitizeCachedPayload(fresh, NEVER_PLAIN);
  assert.strictEqual(s.stale, false, 'entry KHÔNG stale — chặn là do policy, không phải version');
  assert.strictEqual(s.reason, 'policy_blocks_visual');
  assert.strictEqual(s.visualReplayAllowed, false);
  assert.strictEqual(s.payload.visualJob, null);
  assert.strictEqual(s.payload.visualPolicy, 'NEVER');
});

test('P6. CẢ 4 cache-writer branch + nhánh image-only dùng helper canonical, không tự ghép tay', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'chat.js'), 'utf8');
  const writers = src.match(/globalCache\.set\(/g) || [];
  assert.strictEqual(writers.length, 4, 'phải đúng 4 cache writer — thêm writer mới thì phải cập nhật test này');
  const finalize = src.match(/policy\.finalizeVisualCachePayload\(/g) || [];
  assert.ok(finalize.length >= 5, 'cả 4 writer + image-only phải đi qua finalizeVisualCachePayload(), thấy: ' + finalize.length);
  // Không được quay lại kiểu gán thủ công từng field ở route.
  assert.ok(!/DonePayload\.visualJob\s*=/.test(src), 'không được gán visualJob thủ công ở route');
  // Route ĐƯỢC PHÉP log phiên bản (đọc từ module), nhưng KHÔNG được tự ghép giá trị vào payload.
  src.split('\n').forEach((line, i) => {
    if (!line.includes('visualPolicyVersion')) return;
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // chú thích, không phải code
    assert.ok(/visualSystem\.policy\.VISUAL_POLICY_VERSION/.test(line),
      `dòng ${i + 1} tự ghép visualPolicyVersion thay vì lấy từ visualPolicy: ${line.trim()}`);
  });
  // Cửa đọc cache phải fail-closed qua sanitize, không còn check trần renderer.
  assert.ok(/policy\.sanitizeCachedPayload\(/.test(src), 'nhánh cache-hit phải đi qua sanitizeCachedPayload()');
  assert.ok(!/resultCacheValue\.visualJob\s*&&\s*resultCacheValue\.visualJob\.renderer/.test(src),
    'không được replay fail-OPEN chỉ theo renderer');
});

console.log('\n== C. Ma trận cache / policy (V6.17.10) ==');

test('C1. Fresh cache + AUTO + visualJob -> replay allowed', () => {
  const fresh = policy.finalizeVisualCachePayload({ text: 't' }, RUN_PENDING, AUTO);
  assert.strictEqual(policy.sanitizeCachedPayload(fresh, AUTO).visualReplayAllowed, true);
  const freshAlways = policy.finalizeVisualCachePayload({ text: 't' }, RUN_PENDING, ALWAYS);
  assert.strictEqual(policy.sanitizeCachedPayload(freshAlways, ALWAYS).visualReplayAllowed, true);
});

test('C2. Fresh cache + NEVER + câu hỏi thường -> visualJob bị gỡ', () => {
  const fresh = policy.finalizeVisualCachePayload({ text: 't' }, RUN_PENDING, AUTO);
  const s = policy.sanitizeCachedPayload(fresh, NEVER_PLAIN);
  assert.strictEqual(s.payload.visualJob, null);
});

test('C3. Fresh cache + NEVER + yêu cầu hình TƯỜNG MINH -> vẫn replay (đúng explicit-override A3)', () => {
  assert.strictEqual(NEVER_EXPLICIT.explicitVisualRequest, true, 'phải nhận diện được yêu cầu tường minh');
  assert.strictEqual(NEVER_EXPLICIT.allowVisualReplay, true);
  const fresh = policy.finalizeVisualCachePayload({ text: 't' }, RUN_PENDING, AUTO);
  const s = policy.sanitizeCachedPayload(fresh, NEVER_EXPLICIT);
  assert.strictEqual(s.visualReplayAllowed, true);
  assert.strictEqual(s.payload.visualJob.visualId, JOB.visualId);
});

test('C4. Stale cache thiếu policyVersion -> visualJob removed', () => {
  const s = policy.sanitizeCachedPayload({ text: 't', visualJob: JOB }, ALWAYS);
  assert.strictEqual(s.payload.visualJob, null);
  assert.strictEqual(s.visualReplayAllowed, false);
});

test('C5. Cache ghi sau generation luôn có policyVersion hiện tại (mọi run, kể cả không hình)', () => {
  [RUN_PENDING, RUN_NONE, null].forEach((run) => {
    const out = policy.finalizeVisualCachePayload({ text: 't' }, run, AUTO);
    assert.strictEqual(out.visualPolicyVersion, policy.VISUAL_POLICY_VERSION);
    assert.ok('visualJob' in out && 'visuals' in out && 'visualStatus' in out, 'shape phải ổn định');
  });
});

test('C6. Cached JSON non-stream giữ visualJob khi được phép', () => {
  const fresh = policy.finalizeVisualCachePayload({ text: 't' }, RUN_PENDING, AUTO);
  assert.ok(policy.sanitizeCachedPayload(fresh, AUTO).payload.visualJob);
});

test('C7. Cached SSE: chỉ phát visual:request khi replay allowed VÀ renderer là puter_image', () => {
  const fresh = policy.finalizeVisualCachePayload({ text: 't' }, RUN_PENDING, AUTO);
  const ok = policy.sanitizeCachedPayload(fresh, AUTO);
  assert.ok(ok.visualReplayAllowed && ok.payload.visualJob.renderer === 'puter_image');
  // Renderer khác (legacy server_fallback: hình đã nằm sẵn trong `visuals`) -> không có job để chạy.
  const svgRun = { status: 'ready', visuals: [{ visualId: 'v1', renderer: 'deterministic_svg' }], visualJob: null };
  const svgCached = policy.finalizeVisualCachePayload({ text: 't' }, svgRun, AUTO);
  const s = policy.sanitizeCachedPayload(svgCached, AUTO);
  assert.strictEqual(s.visualReplayAllowed, false, 'không có visualJob thì không có gì để replay');
  assert.strictEqual(s.reason, 'no_visual_job');
  assert.strictEqual(s.payload.visuals.length, 1, 'nhưng artifact SVG đã có vẫn phải giữ nguyên');
});

test('C8. Text trong cache vẫn hợp lệ kể cả khi artifact hình bị gỡ', () => {
  const legacy = { text: 'lời giải đầy đủ', state: 'COMPLETED', citationMap: { a: 1 }, visualJob: JOB };
  const s = policy.sanitizeCachedPayload(legacy, ALWAYS);
  assert.strictEqual(s.payload.text, 'lời giải đầy đủ');
  assert.strictEqual(s.payload.state, 'COMPLETED');
  assert.deepStrictEqual(s.payload.citationMap, { a: 1 });
});

console.log('\n== Danh tính / vòng đời (V6.17.4 / V6.17.7) ==');

test('L1. REPLAY không bị khoá theo stage: detail re-entry vẫn ATTACH được job cũ', () => {
  assert.strictEqual(DETAIL.allowVisualLifecycle, false, 'detail KHÔNG được sinh hình mới');
  assert.strictEqual(DETAIL.allowVisualReplay, true, 'nhưng vẫn được dùng lại job đã có');
  const fresh = policy.finalizeVisualCachePayload({ text: 't' }, RUN_PENDING, AUTO);
  assert.strictEqual(policy.sanitizeCachedPayload(fresh, DETAIL).payload.visualJob.visualId, JOB.visualId);
});

test('L2. sanitize KHÔNG làm biến đổi object cache gốc (không "sửa" entry cũ cho hợp lệ)', () => {
  const legacy = { text: 't', visualJob: JOB };
  policy.sanitizeCachedPayload(legacy, ALWAYS);
  assert.ok(legacy.visualJob, 'entry gốc phải nguyên vẹn — sanitize chỉ tác động lên bản sao đi ra');
  assert.strictEqual(legacy.visualPolicyVersion, undefined);
});

test('L3. payload đi ra mang cờ policy của REQUEST HIỆN TẠI, không phải của entry cũ', () => {
  const fresh = policy.finalizeVisualCachePayload({ text: 't' }, RUN_PENDING, ALWAYS);
  assert.strictEqual(fresh.visualPolicy, 'ALWAYS');
  const s = policy.sanitizeCachedPayload(fresh, NEVER_PLAIN);
  assert.strictEqual(s.payload.visualPolicy, 'NEVER', 'cache cũ không được ghi đè lựa chọn mới của người dùng');
});

test('L4. completionFlags: visualPending chỉ true khi stage được phép sinh hình', () => {
  assert.strictEqual(policy.completionFlags(AUTO, { visualMayFollow: true }).visualPending, true);
  assert.strictEqual(policy.completionFlags(DETAIL, { visualMayFollow: true }).visualPending, false);
  assert.strictEqual(policy.completionFlags(NEVER_PLAIN, { visualMayFollow: true }).visualPending, false);
  assert.strictEqual(policy.completionFlags(AUTO, { visualMayFollow: false }).visualPending, false);
});

test('L5. isExplicitVisualRequest là SOURCE OF TRUTH dùng chung với decision engine', () => {
  assert.strictEqual(typeof decisionEngine.isExplicitVisualRequest, 'function');
  assert.strictEqual(decisionEngine.isExplicitVisualRequest('Vẽ hình minh hoạ tam giác ABC'), true);
  assert.strictEqual(decisionEngine.isExplicitVisualRequest('Giải phương trình x^2 = 4'), false);
  // Cùng một câu phải cho cùng kết luận ở cả hai nơi (không được trôi khỏi nhau).
  const q = 'Vẽ hình minh hoạ tam giác ABC';
  const d = decisionEngine.evaluateVisualNeed({ question: q, subject: 'math', userPreference: 'never' });
  assert.strictEqual(d.overrodeNever, true, 'decision engine cũng phải coi đây là override never');
  assert.strictEqual(policy.resolveRoutePolicy({ userPreference: 'never', stage: 'approach', question: q }).allowVisualReplay, true);
});

test('L6. normalizePolicy: giá trị lạ/rỗng -> AUTO (an toàn, không ép hình)', () => {
  ['', null, undefined, 'bogus'].forEach((v) => assert.strictEqual(policy.normalizePolicy(v), 'AUTO'));
  assert.strictEqual(policy.normalizePolicy('NEVER'), 'NEVER');
  assert.strictEqual(policy.normalizePolicy('Always'), 'ALWAYS');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
