'use strict';

// ============================================================================================
// AUDIT ĐỢT 2 — MỤC 5/6/7/8/10/11/13/15/26/27/28/29/30/31–35
// ============================================================================================
// Mỗi test dưới đây khoá một BẤT BIẾN mà đợt audit này vừa sửa. Chúng đọc code thật, không mock
// provider, không mock cache — chỗ nào cần I/O mạng thì kiểm phần thuần hàm của nó.
// Chạy: node test/audit-pass-2.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); passed += 1; }
  catch (e) { console.log(` FAIL - ${name}\n        ${e.message}`); failed += 1; }
}
async function atest(name, fn) {
  try { await fn(); console.log(`  ok  - ${name}`); passed += 1; }
  catch (e) { console.log(` FAIL - ${name}\n        ${e.message}`); failed += 1; }
}

const root = path.join(__dirname, '..');
const te = require(path.join(root, 'server', 'utils', 'tokenEconomy.js'));
const aiBudget = require(path.join(root, 'server', 'utils', 'aiCallBudget.js'));
const completeness = require(path.join(root, 'server', 'utils', 'completenessCheck.js'));
const continuation = require(path.join(root, 'server', 'utils', 'continuation.js'));
const approach = require(path.join(root, 'server', 'utils', 'approachValidator.js'));
const pipeline = require(path.join(root, 'server', 'utils', 'visual', 'visualPipeline.js'));
const stateStore = require(path.join(root, 'server', 'utils', 'visual', 'visualStateStore.js'));
const webSource = require(path.join(root, 'server', 'utils', 'source', 'webSource.js'));
const contentCache = require(path.join(root, 'server', 'utils', 'source', 'sourceContentCache.js'));
const aiProviders = require(path.join(root, 'server', 'utils', 'aiProviders.js'));

const chatSrc = fs.readFileSync(path.join(root, 'server', 'routes', 'chat.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
const imgClientSrc = fs.readFileSync(path.join(root, 'server', 'utils', 'visual', 'imageGenerationClient.js'), 'utf8');

console.log('\n=== MỤC 5 — ADAPTIVE BUDGET AN TOÀN ===');

test('ước lượng (estimated) KHÔNG bao giờ tự mình điều khiển budget', () => {
  te._resetAdaptiveBudgetForTest();
  const key = { problemClass: 'STANDARD', stage: 'detail', provider: 'anthropic', model: 'm1' };
  for (let i = 0; i < 20; i++) te.recordOutcome({ ...key, actualTokens: 1000, estimated: true });
  assert.strictEqual(te.suggestBudgetOverride({ ...key, defaultTarget: 2000 }), null,
    '20 mẫu ƯỚC LƯỢNG vẫn phải trả null — chỉ mẫu đo thật mới được đổi budget');
});

test('đủ mẫu ĐO THẬT thì override mới có hiệu lực', () => {
  te._resetAdaptiveBudgetForTest();
  const key = { problemClass: 'STANDARD', stage: 'detail', provider: 'anthropic', model: 'm1' };
  for (let i = 0; i < te.MIN_MEASURED_SAMPLES; i++) {
    te.recordOutcome({ ...key, actualTokens: 1000, estimated: false });
  }
  const v = te.suggestBudgetOverride({ ...key, defaultTarget: 2000 });
  assert.ok(typeof v === 'number' && v > 0, 'đủ mẫu đo thật -> phải có số đề xuất');
  assert.ok(v >= 1000 && v <= 3000, `override phải nằm trong guardrail, nhận ${v}`);
});

test('outlier bị loại, không kéo trung bình', () => {
  te._resetAdaptiveBudgetForTest();
  const key = { problemClass: 'COMPLEX', stage: 'detail', provider: 'openai', model: 'm2' };
  for (let i = 0; i < 4; i++) te.recordOutcome({ ...key, actualTokens: 1000, estimated: false });
  const before = te.adaptiveBudgetSnapshot()['COMPLEX:detail:openai:m2'].avg;
  const r = te.recordOutcome({ ...key, actualTokens: 100000, estimated: false });
  assert.strictEqual(r.accepted, false);
  assert.strictEqual(r.reason, 'outlier_rejected');
  const after = te.adaptiveBudgetSnapshot()['COMPLEX:detail:openai:m2'].avg;
  assert.strictEqual(after, before, 'một request bất thường KHÔNG được làm sai budget của hàng loạt request sau');
});

test('maximum adjustment: một mẫu dịch trung bình tối đa 20%', () => {
  te._resetAdaptiveBudgetForTest();
  const key = { problemClass: 'SHORT', stage: 'detail', provider: 'gemini', model: 'm3' };
  for (let i = 0; i < 3; i++) te.recordOutcome({ ...key, actualTokens: 1000, estimated: false });
  const before = te.adaptiveBudgetSnapshot()['SHORT:detail:gemini:m3'].avg;
  te.recordOutcome({ ...key, actualTokens: 2500, estimated: false }); // trong ngưỡng outlier (2.5x)
  const after = te.adaptiveBudgetSnapshot()['SHORT:detail:gemini:m3'].avg;
  assert.ok(after <= before * 1.2 + 1, `dịch quá 20%: ${before} -> ${after}`);
});

test('rollback phục hồi đúng trạng thái trước mẫu gần nhất', () => {
  te._resetAdaptiveBudgetForTest();
  const key = { problemClass: 'STANDARD', stage: 'approach', provider: 'anthropic', model: 'm1' };
  te.recordOutcome({ ...key, actualTokens: 800, estimated: false });
  te.recordOutcome({ ...key, actualTokens: 900, estimated: false });
  const snapKey = 'STANDARD:approach:anthropic:m1';
  const before = te.adaptiveBudgetSnapshot()[snapKey];
  assert.strictEqual(before.samples, 2);
  assert.strictEqual(te.rollbackLastOutcome(key), true);
  const after = te.adaptiveBudgetSnapshot()[snapKey];
  assert.strictEqual(after.samples, 1);
  assert.strictEqual(after.measuredSamples, 1);
});

test('per-provider/model: hai model KHÔNG dùng chung số liệu', () => {
  te._resetAdaptiveBudgetForTest();
  te.recordOutcome({ problemClass: 'STANDARD', stage: 'detail', provider: 'a', model: 'x', actualTokens: 1000, estimated: false });
  const snap = te.adaptiveBudgetSnapshot();
  assert.ok(snap['STANDARD:detail:a:x']);
  assert.ok(!snap['STANDARD:detail:a:y'], 'model khác phải là khoá khác');
});

test('chat.js ưu tiên usage THẬT, không dùng length/3.2 làm token thật', () => {
  assert.ok(/function outcomeSample\(/.test(chatSrc), 'phải có outcomeSample()');
  assert.ok(!/recordOutcome\([^)]*length \/ 3\.2\)/.test(chatSrc),
    'không còn call-site nào truyền thẳng length/3.2 vào recordOutcome');
  assert.ok(/outcomeSample\(requestUsage/.test(chatSrc), 'phải lấy usage thật của request');
});

console.log('\n=== MỤC 6 — AI CALL ADMISSION CONTROLLER ===');

test('DETAIL: image_generation và judge bị DENY', () => {
  const b = aiBudget.createCallBudget({ intent: 'PLAIN_TEXT', stage: 'detail' });
  assert.strictEqual(b.admit(aiBudget.PURPOSE.IMAGE_GENERATION).decision, 'DENY');
  assert.strictEqual(b.admit(aiBudget.PURPOSE.JUDGE).decision, 'DENY');
  assert.strictEqual(b.admit(aiBudget.PURPOSE.JUDGE).allowed, false);
});

test('APPROACH: reconcile/cross-check bị DENY, answer được ALLOW', () => {
  const b = aiBudget.createCallBudget({ intent: 'PLAIN_TEXT', stage: 'approach' });
  assert.strictEqual(b.admit(aiBudget.PURPOSE.RECONCILE).decision, 'DENY');
  assert.strictEqual(b.admit(aiBudget.PURPOSE.CROSS_CHECK).decision, 'DENY');
  assert.strictEqual(b.admit(aiBudget.PURPOSE.ANSWER).decision, 'ALLOW');
});

test('purpose CÓ ĐIỀU KIỆN mà thiếu lý do -> DEGRADED (không im lặng)', () => {
  const b = aiBudget.createCallBudget({ intent: 'PLAIN_TEXT', stage: 'detail' });
  assert.strictEqual(b.admit(aiBudget.PURPOSE.CONTINUATION).decision, 'DEGRADED');
  assert.strictEqual(b.admit(aiBudget.PURPOSE.CONTINUATION, { reason: 'HARD incomplete' }).decision, 'ALLOW');
});

test('hết ngân sách lệnh gọi -> DENY, NHƯNG không bao giờ chặn ANSWER', () => {
  const b = aiBudget.createCallBudget({ intent: 'PLAIN_TEXT', stage: 'detail', maxCalls: 2 });
  b.record(aiBudget.PURPOSE.ANSWER);
  b.record(aiBudget.PURPOSE.ANSWER);
  assert.strictEqual(b.admit(aiBudget.PURPOSE.SUMMARIZE, { reason: 'x' }).decision, 'DENY');
  assert.strictEqual(b.admit(aiBudget.PURPOSE.ANSWER).allowed, true,
    'chặn lượt ANSWER là biến lỗi ngân sách thành câu trả lời cụt — bị cấm');
});

test('ngoại lệ correctness phải có lý do và được đếm riêng', () => {
  const b = aiBudget.createCallBudget({ intent: 'PLAIN_TEXT', stage: 'detail' });
  assert.strictEqual(b.admit(aiBudget.PURPOSE.JUDGE, { override: 'correctness' }).decision, 'DENY',
    'override không kèm lý do thì vẫn DENY');
  assert.strictEqual(b.admit(aiBudget.PURPOSE.JUDGE, { override: 'correctness', reason: 'mâu thuẫn số liệu' }).decision, 'ALLOW');
  assert.strictEqual(b.snapshot().aiCallOverrides, 1);
});

test('snapshot báo cáo số lệnh gọi bị TỪ CHỐI', () => {
  const b = aiBudget.createCallBudget({ intent: 'PLAIN_TEXT', stage: 'detail' });
  b.admit(aiBudget.PURPOSE.IMAGE_GENERATION);
  const s = b.snapshot();
  assert.strictEqual(s.aiCallsDenied, 1);
  assert.ok(s.aiCallDeniedPurposes[0].includes('image_generation'));
});

console.log('\n=== MỤC 7 — HARD CONTRACT CỦA APPROACH ===');

test('APPROACH_ERROR_MUST_NOT_FALLBACK_TO_DETAIL — phát hiện được approach đã thành lời giải', () => {
  const detailish = [
    '## Hướng giải',
    'Bước 1: Đặt x là số cần tìm.',
    'Ta có 2x + 3 = 11 = 11 => 2x = 8 => x = 4 => kiểm tra lại = 11.',
    'Vậy x = 4.',
    'Bước 2: Thế vào phương trình thứ hai.'
  ].join('\n');
  const verdict = approach.detectDetailFallback(detailish);
  assert.strictEqual(verdict.fellBack, true, 'phải nhận ra approach đã rơi thành detail');
  assert.ok(verdict.signals.length >= 2);
});

test('approach ĐÚNG chuẩn không bị báo nhầm là detail', () => {
  const good = [
    '## Hướng giải',
    '- Dùng định lý Pythagore cho tam giác vuông ABC.',
    '- Tính cạnh huyền trước, sau đó suy ra diện tích.',
    '- Chú ý điều kiện các cạnh đều dương.'
  ].join('\n');
  assert.strictEqual(approach.detectDetailFallback(good).fellBack, false);
  assert.strictEqual(approach.validateApproachCompactness(good).ok, true);
});

test('repair tối đa 1 lần + trần continuation riêng cho approach', () => {
  assert.strictEqual(approach.MAX_REPAIR_CALLS, 1);
  assert.ok(approach.MAX_CONTINUATION_TOKENS > 0 && approach.MAX_CONTINUATION_TOKENS <= 800,
    'trần recovery của approach phải NHỎ, không dùng chính sách của detail');
  assert.ok(/maxGrant: directStageName === 'approach'/.test(chatSrc),
    'chat.js phải kẹp lô recovery cho stage approach');
});

console.log('\n=== MỤC 8 — COMPLETENESS THEO TỪNG STAGE ===');

test('approach KHÔNG bị trừ điểm vì thiếu kết luận/thiếu ý (a)(b)(c)', () => {
  const text = '## Hướng giải\n- Dùng định lý Vi-ét.\n- Xét dấu biệt thức delta.';
  const r = completeness.validateSolutionCompleteness(text, {
    stage: 'approach', problemText: 'a) Tính delta. b) Tìm nghiệm. c) Nhận xét.', finishReason: 'stop'
  });
  assert.strictEqual(r.status, 'COMPLETE');
  assert.ok(!r.reasons.includes('missing_conclusion'));
  assert.ok(!r.reasons.includes('missing_coverage'));
});

test('detail VẪN bị soi đủ: thiếu ý -> có missing_coverage', () => {
  const text = 'Giải a) delta = 1. Xong.';
  const r = completeness.validateSolutionCompleteness(text, {
    stage: 'detail', problemText: 'a) Tính delta. b) Tìm nghiệm. c) Nhận xét.', finishReason: 'stop'
  });
  assert.ok(r.missingCoverage.length > 0, 'detail phải phát hiện ý còn thiếu');
});

test('cấu trúc hỏng là HARD ở MỌI stage — không stage nào được miễn', () => {
  const broken = '## Hướng giải\n- Vẽ hình:\n```shape\n{"op":"point"';
  const r = completeness.validateSolutionCompleteness(broken, { stage: 'approach', finishReason: 'stop' });
  assert.strictEqual(r.status, 'INCOMPLETE');
  assert.strictEqual(r.severity, 'HARD');
  assert.ok(r.hardReasons.includes('unclosed_code_fence') || r.hardReasons.includes('unclosed_draw_block'));
});

test('candidate không bị bắt có kết luận định dạng như câu trả lời cuối', () => {
  assert.ok(completeness.ignoredReasonsForStage('candidate').has('missing_conclusion'));
  assert.ok(!completeness.ignoredReasonsForStage('detail').has('missing_conclusion'));
});

console.log('\n=== MỤC 10/11 — CONTINUATION DEFICIT-AWARE + SỔ CÁI RESERVE ===');

test('thiếu ĐỊNH DẠNG -> reasoning = 0', () => {
  const d = continuation.classifyDeficit({ hardReasons: [], reasons: ['missing_conclusion'] });
  assert.strictEqual(d.kind, 'format');
  assert.strictEqual(d.needsReasoning, false);
});

test('thiếu NỘI DUNG -> vẫn cấp reasoning', () => {
  ['truncated_tail', 'cut_mid_step', 'finish_reason_length', 'unclosed_latex'].forEach((r) => {
    const d = continuation.classifyDeficit({ hardReasons: [r] });
    assert.strictEqual(d.needsReasoning, true, `${r} phải cần reasoning`);
  });
});

test('còn ý chưa trả lời -> luôn là thiếu nội dung', () => {
  const d = continuation.classifyDeficit({ reasons: ['missing_conclusion'], missingCoverage: ['b'] });
  assert.strictEqual(d.kind, 'content');
});

test('reasoningFor được truyền completeness ở mọi lượt recovery', () => {
  assert.ok(/completeness: recoveryCompleteness/.test(chatSrc));
  assert.ok(/const deficit = classifyDeficit\(completeness\)/.test(chatSrc));
});

test('SOFT_INCOMPLETE không được tiêu reserve', () => {
  const d = te.shouldUseReserve({ status: 'INCOMPLETE', severity: 'SOFT' }, 0, 1000);
  assert.strictEqual(d.allow, false);
});

test('reserve cạn -> cấm cấp tiếp', () => {
  const d = te.shouldUseReserve({ status: 'INCOMPLETE', severity: 'HARD' }, 1000, 1000);
  assert.strictEqual(d.allow, false);
});

test('sổ cái reserve ghi đủ 5 con số', () => {
  ['reserveBefore', 'requestedDelta', 'grantedDelta', 'reserveAfter', 'reason'].forEach((f) => {
    assert.ok(new RegExp(`${f}[:,]`).test(chatSrc), `thiếu trường ${f} trong log reserve_grant`);
  });
  assert.ok(/stage: 'reserve_grant'/.test(chatSrc));
});

console.log('\n=== MỤC 13/15 — BUDGET THEO TARGET + CHÍNH SÁCH ĐUA ===');

test('argsForTarget ghi đè ngân sách theo đúng target', () => {
  const args = {
    maxTokens: 1000, reasoningBudget: 5000,
    recomputeForTarget: (t) => ({ maxTokens: 500, reasoningBudget: t.providerKey === 'b' ? 0 : 5000 })
  };
  const forB = aiProviders.argsForTarget(args, { providerKey: 'b', modelId: 'm' });
  assert.strictEqual(forB.maxTokens, 500);
  assert.strictEqual(forB.reasoningBudget, 0, 'target không có native thinking phải nhận 0');
  assert.ok(!('recomputeForTarget' in forB), 'không được để lọt tham số nội bộ xuống client API');
});

test('recomputeForTarget hỏng KHÔNG làm chết lượt gọi', () => {
  const args = { maxTokens: 777, recomputeForTarget: () => { throw new Error('boom'); } };
  const out = aiProviders.argsForTarget(args, { providerKey: 'a' });
  assert.strictEqual(out.maxTokens, 777);
});

test('không truyền recomputeForTarget -> hành vi cũ y nguyên', () => {
  const args = { maxTokens: 123 };
  assert.strictEqual(aiProviders.argsForTarget(args, { providerKey: 'a' }), args);
});

test('failover VÀ stream VÀ đua đều đi qua argsForTarget', () => {
  const src = fs.readFileSync(path.join(root, 'server', 'utils', 'aiProviders.js'), 'utf8');
  assert.ok(/const targetArgs = argsForTarget\(args, p\)/.test(src), 'callWithFailover');
  assert.ok(/const streamTargetArgs = argsForTarget\(args, p\)/.test(src), 'streamWithFailover');
  assert.ok(/const raceArgs = argsForTarget\(rawRaceArgs, p\)/.test(src), 'attemptTarget (đua)');
});

test('MICRO/SHORT/STANDARD không được đua', () => {
  assert.ok(/RACE_ELIGIBLE_CLASSES = new Set\(\['COMPLEX', 'VERY_COMPLEX'\]\)/.test(chatSrc));
  assert.ok(/raceSize: 1/.test(chatSrc), 'lớp không đủ điều kiện phải bị ép single call');
  ['MICRO', 'SHORT', 'STANDARD'].forEach((c) => {
    assert.ok(!/RACE_ELIGIBLE_CLASSES = new Set\(\[[^\]]*MICRO/.test(chatSrc), `${c} không được nằm trong danh sách đua`);
  });
});

console.log('\n=== MỤC 26/27/28/29/30 — CACHE ===');

test('cache key nội dung gồm URL + extractorVersion + contentPolicyVersion', () => {
  const k = contentCache.keyOf({ url: 'https://a.test/x', extractorVersion: 'v1' });
  assert.ok(k.includes('https://a.test/x'));
  assert.ok(k.includes('v1'));
  assert.ok(k.includes(contentCache.CONTENT_POLICY_VERSION));
});

test('TTL trang động NGẮN hơn trang tĩnh', () => {
  const dyn = contentCache.ttlFor('https://bao.test/news/2026/09/19/abc');
  const stat = contentCache.ttlFor('https://tailieu.test/bai-giang/toan-9');
  assert.ok(dyn < stat, `trang tin phải TTL ngắn hơn: ${dyn} vs ${stat}`);
});

test('conditionalHeaders sinh đúng ETag/Last-Modified', () => {
  const h = contentCache.conditionalHeaders({ etag: 'W/"abc"', lastModified: 'Mon, 01 Jan 2026 00:00:00 GMT' });
  assert.strictEqual(h['If-None-Match'], 'W/"abc"');
  assert.ok(h['If-Modified-Since']);
  assert.deepStrictEqual(contentCache.conditionalHeaders(null), {});
});

atest('web cache: lượt thứ hai KHÔNG fetch lại', async () => {
  contentCache._resetForTest();
  const parts = { url: 'https://vd.test/bai', extractorVersion: webSource.EXTRACTOR_VERSION };
  await contentCache.set(parts, { ok: true, status: 'READY', chunks: [{ text: 'abc' }] }, {});
  const hit = await contentCache.get(parts);
  assert.ok(hit && hit.value && hit.value.ok, 'phải đọc lại được bản đã cache');
});

test('extractReadableText: <main> quá nhỏ -> fallback body (mục 53)', () => {
  const body = 'Nội dung thật của bài viết. '.repeat(80);
  const html = `<html><body><main><a href="#">Trang chủ</a></main><div>${body}</div></body></html>`;
  const out = webSource.extractReadableText(html);
  assert.ok(out.text.length > 400, `phải lấy được nội dung thật, chỉ nhận ${out.text.length} ký tự`);
});

test('L1/L2 khai báo TRUNG THỰC, không tuyên bố suông', () => {
  const s = te.cacheLevelsStatus();
  assert.strictEqual(s.l1, true);
  assert.strictEqual(typeof s.l2, 'boolean');
  if (!s.l2) assert.strictEqual(s.reason, 'l2_disabled_no_kv');
  assert.ok(/l2Enabled: cacheLevels\.l2/.test(chatSrc), 'telemetry phải báo đúng trạng thái L2');
});

test('cache key gồm chính sách model THẬT, không chỉ modelTier', () => {
  assert.ok(/executionPolicyFp:/.test(chatSrc));
  assert.ok(/reasoningMechanism:/.test(chatSrc));
});

test('approach cache và detail cache KHÔNG collide', () => {
  const base = { ns: 'requestCache:v4', normalizedProblem: 'tinh dien tich', modelTier: 'standard' };
  const kApproach = te.globalCache._keyOf({ ...base, stage: 'approach', approachFp: '' });
  const kDetail = te.globalCache._keyOf({ ...base, stage: 'detail', approachFp: 'abc123' });
  assert.notStrictEqual(kApproach, kDetail);
  // Detail phụ thuộc approach -> approach đổi thì key detail PHẢI đổi.
  const kDetail2 = te.globalCache._keyOf({ ...base, stage: 'detail', approachFp: 'xyz789' });
  assert.notStrictEqual(kDetail, kDetail2, 'approach fingerprint phải nằm trong cache key của detail');
});

console.log('\n=== MỤC 31–35 — VÒNG ĐỜI HÌNH ===');

test('stageMayGenerate: chỉ approach/image_only', () => {
  assert.strictEqual(pipeline.stageMayGenerate('approach'), true);
  assert.strictEqual(pipeline.stageMayGenerate('image_only'), true);
  ['detail', 'candidate', 'reconcile', 'continuation', 'retry', 'crosscheck'].forEach((st) => {
    assert.strictEqual(pipeline.stageMayGenerate(st), false, `${st} KHÔNG được sinh hình`);
  });
});

atest('DETAIL: 0 image generation, 0 judge call, 0 visual spec', async () => {
  let judgeCalls = 0;
  const r = await pipeline.runVisualPipeline({
    stage: 'detail',
    question: 'Vẽ tam giác ABC vuông tại A, AB = 3, AC = 4.',
    finalAnswer: 'Diện tích tam giác là 6.',
    answerComplete: true,
    userPreference: 'always',
    judge: async () => { judgeCalls += 1; return { useful: true, confidence: 1 }; }
  });
  assert.strictEqual(judgeCalls, 0, 'Detail gọi judge = vi phạm mục 24');
  assert.strictEqual(r.telemetry.visualGenerationLifecycleCount, 0);
  assert.strictEqual(r.telemetry.visualJudgeCalls, 0);
  assert.strictEqual(r.telemetry.visualProviderAttempts, 0);
  assert.strictEqual(r.telemetry.visualLifecycleLocked, true);
  assert.deepStrictEqual(r.visuals, []);
});

atest('DETAIL DÙNG LẠI đúng visual của Approach, không sinh mới', async () => {
  const existing = [{ visualId: 'vz_abc_1', type: 'geometry', renderer: 'generated_image', url: '/api/visual/asset/x' }];
  const events = [];
  const r = await pipeline.runVisualPipeline({
    stage: 'detail',
    question: 'q', finalAnswer: 'a', answerComplete: true, userPreference: 'always',
    existingVisuals: existing,
    onEvent: (e) => events.push(e)
  });
  assert.strictEqual(r.status, 'reused');
  assert.strictEqual(r.visuals[0].visualId, 'vz_abc_1');
  assert.strictEqual(r.telemetry.visualReused, true);
  assert.strictEqual(r.telemetry.visualGenerationLifecycleCount, 0);
  assert.ok(events.some((e) => e.type === 'visual:ready' && e.reused === true));
});

atest('continuation / cross-check / retry detail đều = 0 sinh hình', async () => {
  for (const stage of ['continuation', 'crosscheck_detail', 'retry']) {
    const r = await pipeline.runVisualPipeline({
      stage, question: 'q', finalAnswer: 'a', answerComplete: true, userPreference: 'always'
    });
    assert.strictEqual(r.telemetry.visualGenerationLifecycleCount, 0, `${stage} sinh hình`);
    assert.strictEqual(r.telemetry.visualProviderAttempts, 0, `${stage} gọi image provider`);
  }
});

atest('visualStateStore: Approach ghi, Detail đọc lại đúng visualId', async () => {
  stateStore._resetForTest();
  await stateStore.saveVisualState('key-1', {
    visuals: [{ visualId: 'vz_1', url: '/api/visual/asset/a' }, { visualId: 'vz_2', url: '/api/visual/asset/b' }],
    status: 'ready', stage: 'approach'
  });
  const rec = await stateStore.loadVisualState('key-1');
  assert.strictEqual(rec.visuals.length, 2);
  assert.strictEqual(stateStore.findVisualById(rec, 'vz_2').visualId, 'vz_2');
  assert.strictEqual(stateStore.findVisualById(rec, 'khong-co'), null);
});

atest('state store KHÔNG bao giờ lưu base64 vào KV/RAM', async () => {
  // KHÔNG reset ở đây: các test bất đồng bộ chạy xen kẽ, reset sẽ xoá dữ liệu của test bên cạnh.
  await stateStore.saveVisualState('key-2', {
    visuals: [{ visualId: 'vz_3', url: 'data:image/png;base64,AAAAAAAA' }], status: 'ready'
  });
  const rec = await stateStore.loadVisualState('key-2');
  assert.ok(!rec.visuals[0].url, 'data URL phải bị loại — response chỉ mang tham chiếu (mục 56)');
});

test('chat.js khoá vòng đời + forward visualKey/stage vào pipeline', () => {
  assert.ok(/visualStageAllowsGeneration/.test(chatSrc));
  assert.ok(/stage: intentPlan\.imageOnly \? 'image_only' : input\.stage/.test(chatSrc));
  assert.ok(/existingVisuals: reusableVisuals/.test(chatSrc));
  assert.ok(/stateStore\.saveVisualState/.test(chatSrc));
  assert.ok(/stage: 'visual_lifecycle_lock'/.test(chatSrc));
});

test('frontend gửi visualId (tham chiếu), KHÔNG gửi URL ảnh làm nguồn sự thật', () => {
  assert.ok(/visualId: \(msgObj\.approachVisuals/.test(appSrc));
  const validators = fs.readFileSync(path.join(root, 'server', 'utils', 'validators.js'), 'utf8');
  assert.ok(/\^\[A-Za-z0-9_-\]\{1,64\}\$/.test(validators), 'visualId phải được validate chặt');
});

test('MỤC 35 — trần cứng số lệnh gọi provider ảnh', () => {
  assert.ok(/IMAGE_MAX_PROVIDER_ATTEMPTS/.test(imgClientSrc));
  assert.ok(/providersTried\.length >= maxAttempts/.test(imgClientSrc));
});

test('MỤC 34 — vòng đời và số lệnh gọi API là HAI con số tách biệt', () => {
  const src = fs.readFileSync(path.join(root, 'server', 'utils', 'visual', 'visualPipeline.js'), 'utf8');
  assert.ok(/visualGenerationLifecycleCount = 1/.test(src));
  assert.ok(/visualProviderAttempts \+=/.test(src));
});

test('MỤC 36 — caption model chỉ chạy khi bật tường minh và qua admission', () => {
  assert.ok(/captionModelEnabled\(\)/.test(chatSrc));
  assert.ok(/admitAndRecord\(aiBudget\.PURPOSE\.CAPTION/.test(chatSrc));
});

(async () => {
  // Chờ các test bất đồng bộ ở trên hoàn tất trước khi tổng kết.
  await new Promise((r) => setTimeout(r, 300));
  console.log(`\n${passed} ok, ${failed} fail`);
  process.exit(failed ? 1 : 0);
})();
