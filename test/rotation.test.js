'use strict';

// Test suite thuần Node (không dùng framework ngoài, giống test/geo2d-engine.test.js) cho cơ chế
// AI Rotation / Execution Target. Chạy: node test/rotation.test.js
//
// Mock global.fetch để không gọi mạng thật — định tuyến theo URL/header để giả lập từng
// provider (Anthropic/OpenAI/Gemini) trả lời thành công/lỗi theo kịch bản mong muốn.

const assert = require('assert');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  -', name); }
  catch (e) { failed++; console.log(' FAIL -', name, '\n       ', e.message); }
}

function freshModules() {
  ['./server/utils/executionTargets.js', './server/utils/rotationManager.js', './server/utils/aiProviders.js',
   './server/utils/anthropicClient.js', './server/utils/geminiClient.js', './server/utils/openaiClient.js',
   './server/utils/openaiCompatibleClient.js', './server/config/extraProviders.js', './server/utils/errorClassifier.js']
    .forEach((p) => { const r = require.resolve(require('path').join('..', p)); delete require.cache[r]; });
  return {
    aiProviders: require('../server/utils/aiProviders'),
    rotationManager: require('../server/utils/rotationManager')
  };
}

function setEnv(vars) {
  Object.keys(vars).forEach((k) => { if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; });
}
function clearProviderEnv() {
  setEnv({
    ANTHROPIC_API_KEY: undefined, ANTHROPIC_MODEL: undefined, ANTHROPIC_MODEL_FAST: undefined,
    OPENAI_API_KEY: undefined, OPENAI_MODEL: undefined, OPENAI_MODEL_FAST: undefined,
    GEMINI_API_KEY: undefined, GEMINI_MODEL: undefined, GEMINI_MODEL_FAST: undefined
  });
}

// ---------- Mock fetch: định tuyến theo apiKey (đọc từ header/URL) ----------
// scriptByKey: Map(apiKey -> Array<'ok'|'429'|'401'|'billing'|'503'|'400'>). Mỗi lần khóa đó được
// gọi, lấy kịch bản tiếp theo trong mảng (dùng hết thì lặp lại phần tử cuối).
function installFetchMock(scriptByKey) {
  const callLog = [];
  const cursors = new Map();
  global.fetch = async (url, opts) => {
    const headers = (opts && opts.headers) || {};
    let key = headers['x-api-key'] || (headers.Authorization || '').replace('Bearer ', '');
    if (!key && /[?&]key=/.test(url)) key = decodeURIComponent(url.match(/[?&]key=([^&]+)/)[1]);
    callLog.push({ url, key });

    const script = scriptByKey[key] || ['ok'];
    const i = cursors.get(key) || 0;
    const outcome = script[Math.min(i, script.length - 1)];
    cursors.set(key, i + 1);

    const okBody = (text) => ({
      ok: true,
      json: async () => {
        if (url.includes('generativelanguage')) return { candidates: [{ content: { parts: [{ text }] } }] };
        if (url.includes('api.openai.com')) return { output: [{ type: 'message', content: [{ type: 'output_text', text }] }] };
        return { content: [{ type: 'text', text }] };
      },
      text: async () => JSON.stringify({})
    });

    if (outcome === 'ok') return okBody(`response from ${key}`);
    if (outcome === '429') return { ok: false, status: 429, text: async () => JSON.stringify({ error: { message: 'Rate limited. Please try again in 2s.' } }) };
    if (outcome === '401') return { ok: false, status: 401, text: async () => JSON.stringify({ error: { message: 'invalid api key' } }) };
    if (outcome === 'billing') return { ok: false, status: 402, text: async () => JSON.stringify({ error: { message: 'You exceeded your current quota, check your plan and billing details.' } }) };
    if (outcome === '503') return { ok: false, status: 503, text: async () => JSON.stringify({ error: { message: 'temporarily overloaded' } }) };
    if (outcome === '400') return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'invalid request: malformed schema' } }) };
    return okBody('unexpected');
  };
  return callLog;
}

async function main() {
  console.log('\n== Execution Target enumeration (mục 1-4, 23) ==');
  await test('1 key + nhiều model sinh nhiều Execution Target riêng biệt', () => {
    clearProviderEnv();
    setEnv({ ANTHROPIC_API_KEY: 'sk-ant-1', ANTHROPIC_MODEL: 'claude-a,claude-b,claude-c' });
    const { aiProviders } = freshModules();
    const targets = aiProviders.getActiveProviders();
    assert.strictEqual(targets.length, 3, 'phải sinh đúng 3 target cho 1 khóa × 3 model');
    assert.deepStrictEqual(targets.map((t) => t.modelName).sort(), ['claude-a', 'claude-b', 'claude-c']);
    assert.ok(targets.every((t) => t.keyId === 'anthropic'), 'chỉ 1 khóa nên keyId không đánh số #');
  });

  await test('nhiều key × nhiều model sinh đúng số tổ hợp (Key×Model)', () => {
    clearProviderEnv();
    setEnv({ GEMINI_API_KEY: 'key1,key2', GEMINI_MODEL: 'modelX,modelY' });
    const { aiProviders } = freshModules();
    const targets = aiProviders.getActiveProviders();
    assert.strictEqual(targets.length, 4, '2 khóa × 2 model = 4 execution target');
    const ids = targets.map((t) => t.id).sort();
    assert.deepStrictEqual(ids, ['gemini#1::modelX', 'gemini#1::modelY', 'gemini#2::modelX', 'gemini#2::modelY']);
  });

  console.log('\n== Rotation qua toàn bộ target (mục 4, 28) ==');
  await test('callWithFailover xoay round-robin qua mọi target khi tất cả đều thành công', async () => {
    clearProviderEnv();
    setEnv({ GEMINI_API_KEY: 'k1,k2', GEMINI_MODEL: 'm1' });
    const { aiProviders } = freshModules();
    const targets = aiProviders.getActiveProviders();
    installFetchMock({ k1: ['ok', 'ok', 'ok'], k2: ['ok', 'ok', 'ok'] });
    const usedLabels = [];
    for (let i = 0; i < 4; i++) {
      const { provider } = await aiProviders.callWithFailover(targets, { system: 's', messages: [], maxTokens: 100 });
      usedLabels.push(provider.label);
    }
    // Với đúng 2 target, round-robin phải luân phiên đều — mỗi target xuất hiện đúng 2 lần trong 4 lượt.
    const counts = usedLabels.reduce((m, l) => ((m[l] = (m[l] || 0) + 1), m), {});
    assert.deepStrictEqual(Object.values(counts).sort(), [2, 2], 'mỗi target phải được dùng đều nhau qua round-robin');
  });

  console.log('\n== API key failure ảnh hưởng MỌI model dùng khóa đó (mục 7, 28) ==');
  await test('Key A lỗi 401 -> mọi target dùng Key A trở nên unavailable, Key B vẫn hoạt động', async () => {
    clearProviderEnv();
    setEnv({ GEMINI_API_KEY: 'bad-key,good-key', GEMINI_MODEL: 'm1,m2' });
    const { aiProviders, rotationManager } = freshModules();
    const targets = aiProviders.getActiveProviders();
    installFetchMock({ 'bad-key': ['401', '401'], 'good-key': ['ok', 'ok'] });

    // Gọi lần đầu bằng target của bad-key trực tiếp để kích hoạt lỗi và cooldown tầng key.
    const badTargets = targets.filter((t) => t.keyId === 'gemini#1');
    for (const t of badTargets.slice(0, 1)) {
      try { await t.call({ system: 's', messages: [] }); } catch (e) { rotationManager.markFailure(t, e); }
    }
    const eligible = rotationManager.getEligibleTargets(targets, {});
    assert.ok(eligible.every((t) => t.keyId !== 'gemini#1'), 'mọi target dùng khóa lỗi phải bị loại khỏi eligible');
    assert.ok(eligible.some((t) => t.keyId === 'gemini#2'), 'target dùng khóa còn tốt vẫn eligible');
  });

  console.log('\n== Target-specific failure KHÔNG ảnh hưởng target khác cùng model (mục 9, 28) ==');
  await test('Key A + Model X lỗi timeout -> chỉ target đó cooldown, Key B + Model X vẫn dùng được', async () => {
    clearProviderEnv();
    setEnv({ GEMINI_API_KEY: 'k1,k2', GEMINI_MODEL: 'shared-model' });
    const { aiProviders, rotationManager } = freshModules();
    const targets = aiProviders.getActiveProviders();
    const t1 = targets.find((t) => t.keyId === 'gemini#1');
    const t2 = targets.find((t) => t.keyId === 'gemini#2');
    rotationManager.markFailure(t1, Object.assign(new Error('network'), { status: 503 }));
    const eligible = rotationManager.getEligibleTargets(targets, {});
    assert.ok(!eligible.find((t) => t.id === t1.id), 'target lỗi bị cooldown');
    assert.ok(eligible.find((t) => t.id === t2.id), 'target khác (khác khóa, cùng model) không bị ảnh hưởng');
  });

  console.log('\n== Rate limit / cooldown (mục 20, 28) ==');
  await test('429 kèm "try again in Ns" -> cooldown đúng thời lượng đọc được, không loại vĩnh viễn', async () => {
    clearProviderEnv();
    setEnv({ GEMINI_API_KEY: 'k1' });
    const { aiProviders, rotationManager } = freshModules();
    const targets = aiProviders.getActiveProviders();
    const err = Object.assign(new Error('Rate limited'), { status: 429, detail: 'Please try again in 2s.' });
    const result = rotationManager.markFailure(targets[0], err);
    assert.strictEqual(result.scope, 'key');
    assert.ok(!rotationManager.getEligibleTargets(targets, {}).length, 'ngay sau lỗi phải đang cooldown');
    await new Promise((r) => setTimeout(r, 2100));
    assert.strictEqual(rotationManager.getEligibleTargets(targets, {}).length, 1, 'sau khi hết cooldown phải khả dụng lại');
  });

  console.log('\n== Billing/quota error không lộ ra người dùng (mục 11, 28) ==');
  await test('billing error bị chặn, response cuối là của target dự phòng, không chứa text billing thô', async () => {
    clearProviderEnv();
    setEnv({ GEMINI_API_KEY: 'billing-key,fine-key' });
    const { aiProviders } = freshModules();
    const targets = aiProviders.getActiveProviders();
    installFetchMock({ 'billing-key': ['billing'], 'fine-key': ['ok'] });
    const { text, tried } = await aiProviders.callWithFailover(targets, { system: 's', messages: [], maxTokens: 50 });
    assert.ok(text.includes('fine-key'), 'phải trả lời bằng target dự phòng thành công');
    assert.ok(!JSON.stringify(tried).match(/check your plan|billing details/i), 'log tried[] không được chứa nguyên văn lỗi billing của hãng');
  });

  console.log('\n== Invalid API key: đánh dấu invalid, không retry ngay (mục 20, 28) ==');
  await test('401 -> key bị đánh dấu invalid, cooldown dài (không phải vài giây)', () => {
    clearProviderEnv();
    setEnv({ GEMINI_API_KEY: 'k1' });
    const { aiProviders, rotationManager } = freshModules();
    const targets = aiProviders.getActiveProviders();
    const result = rotationManager.markFailure(targets[0], Object.assign(new Error('unauthorized'), { status: 401 }));
    assert.strictEqual(result.invalid, true);
    const snap = rotationManager.getHealthSnapshot(targets)[0];
    assert.strictEqual(snap.keyHealthy, false);
  });

  console.log('\n== Concurrency: nhiều request song song không dẫm lên nhau (mục 18, 28) ==');
  await test('nhiều callWithFailover song song không throw, không lẫn kết quả target', async () => {
    clearProviderEnv();
    setEnv({ GEMINI_API_KEY: 'k1,k2,k3' });
    const { aiProviders } = freshModules();
    const targets = aiProviders.getActiveProviders();
    installFetchMock({ k1: Array(10).fill('ok'), k2: Array(10).fill('ok'), k3: Array(10).fill('ok') });
    const results = await Promise.all(
      Array.from({ length: 6 }).map(() => aiProviders.callWithFailover(targets, { system: 's', messages: [], maxTokens: 50 }))
    );
    assert.strictEqual(results.length, 6);
    assert.ok(results.every((r) => typeof r.text === 'string' && r.text.length > 0));
  });

  console.log('\n== Không mất context khi fallback (mục 14-15) ==');
  await test('args (messages/system/settings) được truyền y nguyên qua mọi target khi fallback', async () => {
    clearProviderEnv();
    setEnv({ GEMINI_API_KEY: 'bad,good' });
    const { aiProviders } = freshModules();
    const targets = aiProviders.getActiveProviders();
    installFetchMock({ bad: ['503'], good: ['ok'] });
    let capturedBody = null;
    const realFetch = global.fetch;
    global.fetch = async (url, opts) => {
      if (url.includes('key=') && decodeURIComponent(url).includes('good')) {
        capturedBody = JSON.parse(opts.body);
      }
      return realFetch(url, opts);
    };
    const messages = [{ role: 'user', content: 'Giải phương trình bậc 2, có ảnh đính kèm' }];
    await aiProviders.callWithFailover(targets, { system: 'HỆ THỐNG: giữ nguyên ngôn ngữ', messages, maxTokens: 50 });
    assert.ok(capturedBody, 'target dự phòng phải nhận được request');
    assert.strictEqual(capturedBody.systemInstruction.parts[0].text, 'HỆ THỐNG: giữ nguyên ngôn ngữ');
    assert.deepStrictEqual(capturedBody.contents[0].parts[0].text, messages[0].content);
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed) process.exitCode = 1;
}

main();
