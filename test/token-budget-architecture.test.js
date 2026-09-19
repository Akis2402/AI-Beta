'use strict';

// ============================================================================================
// PHẦN G mục 26 — TEST KIẾN TRÚC TOKEN BUDGET
// ============================================================================================
// Mỗi test dưới đây khoá đúng MỘT bất biến trong PHẦN H (acceptance criteria). Chúng chạy thuần
// (không mạng, không API key) trừ các test client có stub global.fetch.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  resolveBudget, genericReasoningBudget, reasoningBudgetFor
} = require('../server/utils/budget/requestBudgetPlanner');
const {
  getReasoningBudgetPolicy, fitReasoningToModel, reasoningScaleForClass,
  ANTHROPIC_MIN_THINKING, MODEL_REASONING_SHARE
} = require('../server/utils/budget/reasoningPolicy');
const tokenEconomy = require('../server/utils/tokenEconomy');
const tokenTelemetry = require('../server/utils/tokenTelemetry');

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

const PROBLEM = 'Cho tam giác ABC vuông tại A. '.repeat(12);

console.log('\n== A. Deep Thinking KHÔNG bị cộng dư 35% khi provider có native reasoning ==');

test('A1. native reasoning: answerBudget(deep) === answerBudget(fast) — không nhân 1.35', () => {
  const common = {
    provider: 'anthropic', model: 'claude-x', capabilities: { supportsThinking: true },
    stage: 'detail', problemText: PROBLEM, remainingMs: 300000, throughputTokensPerSec: 200
  };
  const fast = resolveBudget({ ...common, deepThinking: false });
  const deep = resolveBudget({ ...common, deepThinking: true });
  assert.strictEqual(deep.answerBudget, fast.answerBudget,
    `answer budget bị nhân hệ số reasoning: ${fast.answerBudget} -> ${deep.answerBudget}`);
  assert.ok(deep.reasoningBudget > 0, 'reasoning phải được cấp RIÊNG, không nằm trong answer');
});

test('A2. prompt-based (provider KHÔNG có native) VẪN được cộng thêm ngân sách suy luận', () => {
  const common = {
    provider: 'somecompat', model: 'm', capabilities: { supportsThinking: false },
    stage: 'detail', problemText: PROBLEM, remainingMs: 300000, throughputTokensPerSec: 200
  };
  const fast = resolveBudget({ ...common, deepThinking: false });
  const deep = resolveBudget({ ...common, deepThinking: true });
  assert.ok(deep.answerBudget > fast.answerBudget,
    'cơ chế prompt-based có khối suy luận nằm TRONG output nên phải có thêm chỗ');
  assert.strictEqual(deep.reasoningBudget, 0, 'không được gửi reasoning budget cho model không hỗ trợ');
  assert.strictEqual(deep.reasoningMechanism, 'prompt');
});

test('A3. không cộng reasoning hai lần: providerMaxTokens === answer + reasoning (native)', () => {
  const b = resolveBudget({
    provider: 'anthropic', model: 'claude-x', capabilities: { supportsThinking: true },
    stage: 'detail', problemText: PROBLEM, deepThinking: true, remainingMs: 300000, throughputTokensPerSec: 200
  });
  assert.strictEqual(b.providerMaxTokens, b.answerBudget + b.reasoningBudget);
});

test('A4. mọi stage đều giữ bất biến (direct/approach/candidate/reconcile/recovery)', () => {
  ['approach', 'detail', 'candidate', 'reconcile', 'reconcileLight'].forEach((stage) => {
    const f = resolveBudget({
      provider: 'anthropic', model: 'claude-x', capabilities: { supportsThinking: true },
      stage, problemText: PROBLEM, deepThinking: false, remainingMs: 300000, throughputTokensPerSec: 200
    });
    const d = resolveBudget({
      provider: 'anthropic', model: 'claude-x', capabilities: { supportsThinking: true },
      stage, problemText: PROBLEM, deepThinking: true, remainingMs: 300000, throughputTokensPerSec: 200
    });
    assert.strictEqual(d.answerBudget, f.answerBudget, `stage ${stage} bị cộng dư vào answer`);
  });
});

console.log('\n== B. Approach phải RẺ HƠN detail ==');

test('B1. approach.answerBudget < detail.answerBudget ở cùng đề bài', () => {
  const mk = (stage) => resolveBudget({
    provider: 'anthropic', model: 'claude-x', capabilities: { supportsThinking: true },
    stage, problemText: PROBLEM, deepThinking: true, remainingMs: 300000, throughputTokensPerSec: 200
  });
  const a = mk('approach');
  const d = mk('detail');
  assert.ok(a.answerBudget < d.answerBudget, `approach=${a.answerBudget} phải < detail=${d.answerBudget}`);
  assert.ok(a.reasoningBudget <= d.reasoningBudget, 'approach không được bật reasoning lớn hơn detail');
});

console.log('\n== C. reasoningBudget KHÔNG BAO GIỜ vượt khả năng model (bất biến E) ==');

test('C1. answer + reasoning <= model.maxOutputTokens', () => {
  [4096, 8192, 16384].forEach((maxOut) => {
    const b = resolveBudget({
      provider: 'anthropic', model: 'claude-x',
      capabilities: { supportsThinking: true, maxOutputTokens: maxOut },
      stage: 'reconcile', problemText: PROBLEM.repeat(6), deepThinking: true,
      remainingMs: 600000, throughputTokensPerSec: 400
    });
    assert.ok(b.answerBudget + b.reasoningBudget <= maxOut,
      `maxOut=${maxOut}: answer=${b.answerBudget} + reasoning=${b.reasoningBudget} vượt trần`);
    assert.ok(b.providerMaxTokens <= maxOut, `providerMaxTokens=${b.providerMaxTokens} vượt trần ${maxOut}`);
  });
});

test('C2. model quá nhỏ để chứa reasoning hợp lệ -> TẮT native, không gửi budget vô lệ', () => {
  const fitted = fitReasoningToModel({
    reasoningBudget: 4000, answerBudget: 1500,
    capabilities: { maxOutputTokens: 1024 },
    minReasoningTokens: ANTHROPIC_MIN_THINKING, countsAgainstOutput: true
  });
  assert.strictEqual(fitted.nativeEnabled, false, 'model 1024 token không thể vừa suy luận vừa trả lời');
  assert.strictEqual(fitted.reasoningBudget, 0);
  assert.ok(fitted.providerMaxTokens <= 1024);
});

test('C3. KHÔNG kẹp khi model không khai maxOutputTokens (giữ hành vi cũ)', () => {
  const fitted = fitReasoningToModel({
    reasoningBudget: 9000, answerBudget: 3000,
    capabilities: { supportsThinking: true },
    minReasoningTokens: ANTHROPIC_MIN_THINKING, countsAgainstOutput: true
  });
  assert.strictEqual(fitted.reasoningBudget, 9000);
  assert.strictEqual(fitted.providerMaxTokens, 12000);
  assert.strictEqual(fitted.clamped, false);
});

test('C4. reasoningBudgetFor() cũng đi qua chốt model (không có đường vòng)', () => {
  const b = reasoningBudgetFor({
    provider: 'anthropic', model: 'm', capabilities: { supportsThinking: true, maxOutputTokens: 4096 },
    deepThinking: true, answerBudget: 9000, complexityLevel: 'very_large'
  });
  assert.ok(b <= Math.floor(4096 * MODEL_REASONING_SHARE), `không được vượt trần model, thực tế ${b}`);
});

console.log('\n== D. Câu MICRO không phát sinh hàng nghìn reasoning token (bất biến F) ==');

test('D1. classifyProblem("12 * 8 = ?") -> MICRO kể cả khi người dùng BẬT Deep Thinking', () => {
  const off = tokenEconomy.classifyProblem({ problemText: '12 * 8 = ?' });
  assert.strictEqual(off.intrinsicClass, 'MICRO', `thực tế ${off.intrinsicClass}`);
  const on = tokenEconomy.classifyProblem({ problemText: '12 * 8 = ?', deepThinking: true, crossCheck: true });
  assert.strictEqual(on.intrinsicClass, 'MICRO',
    'cờ người dùng bật KHÔNG được làm đề bài trở nên khó hơn — nếu không, cổng MICRO không bao giờ kích hoạt');
  assert.notStrictEqual(on.problemClass, 'MICRO', 'nhãn ĐẦY ĐỦ vẫn giữ ngữ nghĩa cũ cho routing/cache');
});

test('D1b. đề NGẮN nhưng KHÓ không bị coi là MICRO (không cắt suy luận của bài cần suy luận)', () => {
  ['Chứng minh căn 2 là số vô tỉ', 'Tính tích phân x^2 e^x dx', 'Tìm giới hạn của dãy số trên', 'CMR n^3 - n chia hết 6']
    .forEach((q) => {
      const c = tokenEconomy.classifyProblem({ problemText: q, deepThinking: true });
      assert.notStrictEqual(c.intrinsicClass, 'MICRO', `"${q}" bị xếp MICRO -> mất ngân sách suy luận`);
      assert.ok(reasoningScaleForClass(c.intrinsicClass) > 0, `"${q}" phải còn ngân sách reasoning`);
    });
});

test('D1c. chat.js dùng intrinsicClass (không dùng problemClass) để cấp reasoning', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'chat.js'), 'utf8');
  assert.ok(/currentProblemClass\s*=\s*tePlan\.classification\.intrinsicClass/.test(src),
    'dùng problemClass sẽ khiến deepThinking=true luôn +1 điểm -> không bao giờ còn MICRO');
});

test('D2. MICRO + deepThinking -> reasoningBudget = 0 (mechanism prompt, KHÔNG phải 1024)', () => {
  const b = resolveBudget({
    provider: 'anthropic', model: 'claude-x', capabilities: { supportsThinking: true },
    stage: 'detail', problemText: '12 * 8 = ?', deepThinking: true,
    problemClass: 'MICRO', remainingMs: 300000, throughputTokensPerSec: 200
  });
  assert.strictEqual(b.reasoningBudget, 0, `MICRO vẫn bị cấp ${b.reasoningBudget} reasoning token`);
  assert.strictEqual(b.reasoningMechanism, 'prompt');
});

test('D3. genericReasoningBudget(MICRO) = 0, nhưng COMPLEX vẫn đầy đủ (không cắt bài khó)', () => {
  assert.strictEqual(genericReasoningBudget({ answerBudget: 3000, deepThinking: true, problemClass: 'MICRO' }), 0);
  const complex = genericReasoningBudget({ answerBudget: 3000, deepThinking: true, problemClass: 'VERY_COMPLEX', complexityLevel: 'very_large' });
  const standard = genericReasoningBudget({ answerBudget: 3000, deepThinking: true, problemClass: 'STANDARD', complexityLevel: 'very_large' });
  assert.ok(complex >= standard, 'bài rất phức tạp KHÔNG được suy luận ít hơn bài chuẩn');
  assert.ok(complex >= ANTHROPIC_MIN_THINKING);
});

test('D4. thang lớp bài đơn điệu và mặc định = 1 khi caller không biết lớp', () => {
  assert.strictEqual(reasoningScaleForClass(undefined), 1);
  assert.strictEqual(reasoningScaleForClass('MICRO'), 0);
  assert.ok(reasoningScaleForClass('SHORT') < reasoningScaleForClass('STANDARD'));
  assert.ok(reasoningScaleForClass('STANDARD') < reasoningScaleForClass('VERY_COMPLEX'));
});

console.log('\n== E. Recovery chỉ sinh DELTA, không giải lại từ đầu ==');

test('E1. phase=recovery: answerBudget bám deficit + reasoning giảm', () => {
  const common = {
    provider: 'anthropic', model: 'claude-x', capabilities: { supportsThinking: true },
    stage: 'detail', problemText: PROBLEM, deepThinking: true, remainingMs: 300000, throughputTokensPerSec: 200
  };
  const init = resolveBudget(common);
  const rec = resolveBudget({ ...common, phase: 'recovery', deficitTokens: 900 });
  assert.ok(rec.answerBudget < init.answerBudget + init.recoveryBudget,
    'recovery không được xin ngân sách của cả bài');
  assert.ok(rec.reasoningBudget < init.reasoningBudget,
    'lượt viết tiếp đã có kết quả trung gian, không cần suy luận lại từ đầu');
});

test('E2. continuation gửi ngữ cảnh ĐÃ NÉN, không gửi lại nguyên văn answer lớn', () => {
  const { compactPriorText } = require('../server/utils/continuation');
  let long = '';
  for (let i = 0; i < 300; i++) long += 'Ở đoạn này ta diễn giải lại toàn bộ ý tưởng đã trình bày phía trên một cách dài dòng, lặp đi lặp lại cùng một nội dung mà lượt viết tiếp hoàn toàn không cần đọc lại.\n';
  const compacted = compactPriorText(long);
  assert.ok(compacted.text.length < long.length * 0.6,
    `priorText phải được nén (${compacted.text.length} vs ${long.length})`);
  assert.ok(long.endsWith(compacted.text.slice(-200)), 'đuôi phải NGUYÊN VĂN để nối liền mạch');
});

console.log('\n== F. Cross-check: giới hạn số lượt, không retry vô hạn, không retry lỗi invalid_request ==');

test('F1. CROSS_CHECK_MAX_CANDIDATES là trần cứng, không phụ thuộc số target', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'utils', 'aiProviders.js'), 'utf8');
  assert.ok(/CROSS_CHECK_MAX_CANDIDATES/.test(src), 'phải có trần số candidate');
  assert.ok(/classification\.scope === 'invalid_request'/.test(src),
    'lỗi invalid_request phải dừng ngay, không thử tiếp target khác (tốn lượt gọi vô ích)');
});

test('F2. candidate nhận reasoningBudget riêng, không dùng con số mù', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'chat.js'), 'utf8');
  assert.ok(/reasoningBudget:\s*budgetOf\('candidate'\)\.reasoningBudget/.test(src),
    'candidate phải nhận reasoningBudget của chính stage candidate');
});

test('F3. reconcile dùng verification packet ĐÃ nén (không lặp lại candidate nguyên văn)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'chat.js'), 'utf8');
  assert.ok(/compactCandidatesForReconcile\(candidates\)/.test(src));
  assert.ok(/candidates:\s*packed\.candidates/.test(src),
    'reconcile phải dùng đúng bản compact, nếu không thì việc nén là vô nghĩa');
});

console.log('\n== G. MỘT nguồn sự thật: chat.js không còn tự tính budget song song ==');

test('G1. chat.js đi qua resolveBudget(), KHÔNG gọi calculateAdaptiveBudget() trực tiếp', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'chat.js'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(/resolveBudget\(\{/.test(code), 'phải dùng resolveBudget()');
  assert.ok(!/=\s*calculateAdaptiveBudget\(/.test(code),
    'chat.js KHÔNG được tính một budget độc lập song song với resolveBudget()');
});

test('G2. tokenEconomy cũng đi qua resolveBudget() (không còn 2 hệ budget)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'utils', 'tokenEconomy.js'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(/resolveBudget\(\{/.test(code));
  assert.ok(!/=\s*calculateAdaptiveBudget\(/.test(code));
});

console.log('\n== H. Cache: key không collision, KHÔNG lưu PARTIAL/FAILED ==');

test('H1. mỗi trường ngữ cảnh đổi -> cache key đổi (không trả nhầm kết quả của nhau)', () => {
  const cache = new tokenEconomy.TokenEconomyCache();
  const base = {
    ns: 'requestCache:v4', stage: 'detail', normalizedProblem: 'giai pt', deepThinking: 'true',
    crossCheck: 'false', modelTier: 'strong', historyFp: 'h1', lang: 'vi', detail: 'tieu chuan',
    school: 'thpt', grade: '10', subjectId: 'math', visualMode: 'auto', approachFp: 'a',
    rulesFp: 'r', sourceIdsFp: 's', contextsFp: 'c', imageFp: 'i', promptVersion: 'v1'
  };
  cache.set('L1', base, 'GOC');
  Object.keys(base).forEach((k) => {
    const variant = { ...base, [k]: base[k] + 'X' };
    assert.strictEqual(cache.get('L1', variant), null,
      `đổi field "${k}" mà vẫn trúng cache cũ -> COLLISION`);
  });
  assert.strictEqual(cache.get('L1', base), 'GOC', 'key gốc vẫn phải trúng');
});

test('H2. thứ tự field KHÔNG tạo ra 2 key khác nhau', () => {
  const cache = new tokenEconomy.TokenEconomyCache();
  cache.set('L1', { a: '1', b: '2' }, 'V');
  assert.strictEqual(cache.get('L1', { b: '2', a: '1' }), 'V');
});

test('H3. chat.js chỉ cache khi COMPLETED (không cache PARTIAL/FAILED)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'chat.js'), 'utf8');
  const writes = src.match(/tokenEconomy\.globalCache\.set\('L1'[^\n]*/g) || [];
  assert.ok(writes.length >= 2, `phải có ít nhất 2 điểm ghi cache, thấy ${writes.length}`);
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    if (!/tokenEconomy\.globalCache\.set\('L1'/.test(line)) return;
    const guard = lines.slice(Math.max(0, i - 2), i + 1).join(' ');
    assert.ok(/!\s*[\w.]*[Pp]artial/.test(guard),
      `dòng ${i + 1} ghi cache mà không có guard "không partial": ${line.trim()}`);
  });
});

test('H4. CacheAdapter: L1 bắt buộc, L2 tùy chọn và lỗi L2 KHÔNG làm hỏng request', async () => {
  const { CacheAdapter } = require('../server/utils/cache/cacheAdapter');
  const a = new CacheAdapter({ maxEntries: 3 });
  assert.strictEqual(a.hasL2(), false, 'mặc định KHÔNG có L2 (không thêm DB nặng vì cache)');
  a.set('k', 'v');
  assert.strictEqual(a.get('k'), 'v');
  a.setL2({ get: async () => { throw new Error('L2 down'); }, set: async () => { throw new Error('L2 down'); } });
  a.set('k2', 'v2');
  assert.strictEqual(a.get('k2'), 'v2', 'L2 hỏng không được ảnh hưởng L1');
  const got = await a.getAsync('missing');
  assert.strictEqual(got, null, 'L2 throw -> coi như cache miss, KHÔNG throw ra ngoài');
});

test('H5. CacheAdapter L2 read-through: hit L2 được ghi ngược lên L1', async () => {
  const { CacheAdapter } = require('../server/utils/cache/cacheAdapter');
  let reads = 0;
  const a = new CacheAdapter();
  a.setL2({ get: async () => { reads += 1; return 'cold'; }, set: async () => {} });
  assert.strictEqual(await a.getAsync('x'), 'cold');
  assert.strictEqual(await a.getAsync('x'), 'cold');
  assert.strictEqual(reads, 1, 'lượt thứ 2 phải trúng L1, không đi xuống L2 nữa');
});

console.log('\n== I. Telemetry phản ánh token THẬT, không double-count ==');

test('I1. reasoning KHÔNG bị đếm thành answer; input không bị đếm hai lần', () => {
  const rec = tokenTelemetry.createRequestTelemetry('req_test_1');
  rec.recordAttempt({
    stage: 'direct', provider: 'anthropic', model: 'm', targetId: 't1',
    answerBudget: 2000, reasoningBudget: 1500, providerMaxTokens: 3500,
    usage: { inputTokens: 1200, outputTokens: 800, reasoningTokens: 1100, cachedTokens: 300 },
    finishReason: 'stop', latencyMs: 900, status: 'success'
  });
  const t = rec.snapshot();
  assert.strictEqual(t.inputTokens, 1200);
  assert.strictEqual(t.outputTokens, 800, 'outputTokens KHÔNG được gồm reasoning');
  assert.strictEqual(t.reasoningTokens, 1100);
  assert.strictEqual(t.actualTokens, 1200 + 800 + 1100);
  assert.strictEqual(t.estimatedTokens, 0, 'có usage thật thì không ghi vào ô ước lượng');
  tokenTelemetry.releaseRequestTelemetry('req_test_1');
});

test('I2. provider KHÔNG trả usage -> ghi rõ là ESTIMATED, không giả làm exact', () => {
  const rec = tokenTelemetry.createRequestTelemetry('req_test_2');
  const a = rec.recordAttempt({ stage: 'direct', estimatedOutputTokens: 450, status: 'success' });
  assert.strictEqual(a.estimated, true);
  assert.strictEqual(a.outputTokens, null, 'không được bịa con số "thật"');
  const t = rec.snapshot();
  assert.strictEqual(t.outputTokens, 0);
  assert.strictEqual(t.estimatedTokens, 450);
  assert.strictEqual(t.attemptsEstimatedOnly, 1);
  tokenTelemetry.releaseRequestTelemetry('req_test_2');
});

test('I3. thống kê cấp request đếm đúng theo loại lượt gọi (mục 12)', () => {
  const rec = tokenTelemetry.createRequestTelemetry('req_test_3');
  rec.recordCache(false);
  rec.recordAttempt({ stage: 'cross_check_round1', status: 'success', usage: { inputTokens: 10, outputTokens: 20 } });
  rec.recordAttempt({ stage: 'cross_check_retry', status: 'success', retry: true, usage: { inputTokens: 10, outputTokens: 20 } });
  rec.recordAttempt({ stage: 'reconcile', status: 'success', usage: { inputTokens: 10, outputTokens: 20 } });
  rec.recordAttempt({ stage: 'reconcile_recovery', status: 'success', recovery: true, usage: { inputTokens: 10, outputTokens: 20 } });
  rec.recordAttempt({ stage: 'visual_spec', status: 'error' });
  const t = rec.snapshot();
  assert.strictEqual(t.callsTotal, 5);
  assert.strictEqual(t.successfulCalls, 4);
  assert.strictEqual(t.failedCalls, 1);
  assert.strictEqual(t.crossCheckCalls, 2);
  assert.strictEqual(t.reconcileCalls, 2);
  assert.strictEqual(t.recoveryCalls, 1);
  assert.strictEqual(t.visualCalls, 1);
  assert.strictEqual(t.retriedCalls, 1);
  assert.strictEqual(t.cacheMiss, 1);
  assert.strictEqual(t.continuationTokens, 20, 'token của lượt tiếp nối phải tách riêng');
  assert.strictEqual(t.retryTokens, 20);
  tokenTelemetry.releaseRequestTelemetry('req_test_3');
});

test('I4. attempt KHÔNG chứa API key hay nội dung người dùng', () => {
  const rec = tokenTelemetry.createRequestTelemetry('req_test_4');
  const a = rec.recordAttempt({
    stage: 'direct', provider: 'anthropic', apiKey: 'sk-secret', text: 'nội dung riêng tư',
    status: 'success', usage: { inputTokens: 1, outputTokens: 1 }
  });
  const json = JSON.stringify(a);
  assert.ok(!/sk-secret/.test(json), 'API key bị ghi vào telemetry');
  assert.ok(!/riêng tư/.test(json), 'nội dung người dùng bị ghi vào telemetry');
  tokenTelemetry.releaseRequestTelemetry('req_test_4');
});

console.log('\n== J. Client KHÔNG gửi tham số reasoning cho model không hỗ trợ (bất biến D) ==');

function okJson(body) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}
async function withFetch(stub, fn) {
  const real = global.fetch;
  global.fetch = stub;
  try { return await fn(); } finally { global.fetch = real; }
}

(async function main() {
  await atest('J1. anthropicClient: reasoningBudget=0 TƯỜNG MINH -> KHÔNG có field thinking', async () => {
    const client = require('../server/utils/anthropicClient');
    let captured = null;
    await withFetch(async (url, opts) => {
      captured = JSON.parse(opts.body);
      return okJson({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
    }, () => client.callClaude({
      system: 's', messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 3000, reasoningBudget: 0, deepThinking: true, fast: false,
      capabilities: { supportsThinking: true }, apiKeyOverride: 'k', modelOverride: 'm'
    }));
    assert.ok(!captured.thinking, 'MICRO/model-capped phải tắt hẳn native thinking');
    assert.strictEqual(captured.max_tokens, 3000, 'answer budget giữ nguyên');
  });

  await atest('J2. anthropicClient: max_tokens KHÔNG vượt maxOutputTokens của model', async () => {
    const client = require('../server/utils/anthropicClient');
    let captured = null;
    await withFetch(async (url, opts) => {
      captured = JSON.parse(opts.body);
      return okJson({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
    }, () => client.callClaude({
      system: 's', messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 4000, reasoningBudget: 9000, deepThinking: true, fast: false,
      capabilities: { supportsThinking: true, maxOutputTokens: 8192 },
      apiKeyOverride: 'k', modelOverride: 'm'
    }));
    assert.ok(captured.max_tokens <= 8192, `max_tokens=${captured.max_tokens} vượt trần 8192`);
    assert.ok(captured.thinking.budget_tokens < captured.max_tokens,
      'Anthropic yêu cầu budget_tokens < max_tokens');
  });

  await atest('J3. geminiClient: reasoningBudget=0 -> KHÔNG gửi thinkingConfig', async () => {
    const client = require('../server/utils/geminiClient');
    let captured = null;
    await withFetch(async (url, opts) => {
      captured = JSON.parse(opts.body);
      return okJson({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] });
    }, () => client.callGemini({
      system: 's', messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 2500, reasoningBudget: 0, deepThinking: true, fast: false,
      capabilities: { supportsThinking: true }, apiKeyOverride: 'k', modelOverride: 'gemini-2.5-pro'
    }));
    assert.ok(!captured.generationConfig.thinkingConfig, 'không được gửi thinkingConfig khi budget = 0');
    assert.strictEqual(captured.generationConfig.maxOutputTokens, 2500);
  });

  await atest('J4. geminiClient: maxOutputTokens bị kẹp theo trần model', async () => {
    const client = require('../server/utils/geminiClient');
    let captured = null;
    await withFetch(async (url, opts) => {
      captured = JSON.parse(opts.body);
      return okJson({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] });
    }, () => client.callGemini({
      system: 's', messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 4000, reasoningBudget: 9000, deepThinking: true, fast: false,
      capabilities: { supportsThinking: true, maxOutputTokens: 8192 },
      apiKeyOverride: 'k', modelOverride: 'gemini-2.5-pro'
    }));
    assert.ok(captured.generationConfig.maxOutputTokens <= 8192,
      `maxOutputTokens=${captured.generationConfig.maxOutputTokens} vượt trần`);
  });

  await atest('J5. openaiClient: reasoningBudget=0 -> KHÔNG gửi field reasoning', async () => {
    const client = require('../server/utils/openaiClient');
    let captured = null;
    await withFetch(async (url, opts) => {
      captured = JSON.parse(opts.body);
      return okJson({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] });
    }, () => client.callOpenAI({
      system: 's', messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 2000, reasoningBudget: 0, deepThinking: true, fast: false,
      capabilities: { supportsThinking: true }, apiKeyOverride: 'k', modelOverride: 'o4-mini'
    }));
    assert.ok(!captured.reasoning, "gửi 'reasoning' khi không cần -> lãng phí/400 với model không hỗ trợ");
    assert.strictEqual(captured.max_output_tokens, 2000);
  });

  await atest('J6. openaiClient: max_output_tokens bị kẹp theo trần model', async () => {
    const client = require('../server/utils/openaiClient');
    let captured = null;
    await withFetch(async (url, opts) => {
      captured = JSON.parse(opts.body);
      return okJson({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] });
    }, () => client.callOpenAI({
      system: 's', messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 4000, reasoningBudget: 9000, deepThinking: true, fast: false,
      capabilities: { supportsThinking: true, maxOutputTokens: 8192 },
      apiKeyOverride: 'k', modelOverride: 'o4-mini'
    }));
    assert.ok(captured.max_output_tokens <= 8192, `vượt trần: ${captured.max_output_tokens}`);
  });

  await atest('J7. model KHÔNG hỗ trợ reasoning -> không client nào gửi field reasoning/thinking', async () => {
    const anthropic = require('../server/utils/anthropicClient');
    const openai = require('../server/utils/openaiClient');
    let a = null;
    await withFetch(async (url, opts) => {
      a = JSON.parse(opts.body);
      return okJson({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
    }, () => anthropic.callClaude({
      system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 3000,
      reasoningBudget: 4000, deepThinking: true, capabilities: { supportsThinking: false },
      apiKeyOverride: 'k', modelOverride: 'm'
    }));
    assert.ok(!a.thinking);
    let o = null;
    await withFetch(async (url, opts) => {
      o = JSON.parse(opts.body);
      return okJson({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] });
    }, () => openai.callOpenAI({
      system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 3000,
      reasoningBudget: 4000, deepThinking: true, capabilities: { supportsThinking: false },
      apiKeyOverride: 'k', modelOverride: 'gpt-4o'
    }));
    assert.ok(!o.reasoning);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
