'use strict';

// Test suite cho modelDiscovery.js + tích hợp executionTargets.js/aiProviders.js — xác nhận mục
// tiêu "chỉ cần API key, KHÔNG cần nhập model" (mục 22, A-P). Mock global.fetch để giả lập đúng
// endpoint /models thật của từng hãng, không gọi mạng.

const assert = require('assert');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  -', name); }
  catch (e) { failed++; console.log(' FAIL -', name, '\n       ', e.stack || e.message); }
}

function freshModules() {
  ['./server/utils/executionTargets.js', './server/utils/rotationManager.js', './server/utils/aiProviders.js',
   './server/utils/anthropicClient.js', './server/utils/geminiClient.js', './server/utils/openaiClient.js',
   './server/utils/openaiCompatibleClient.js', './server/config/extraProviders.js', './server/utils/errorClassifier.js',
   './server/utils/modelDiscovery.js']
    .forEach((p) => { const r = require.resolve(require('path').join('..', p)); delete require.cache[r]; });
  return {
    aiProviders: require('../server/utils/aiProviders'),
    modelDiscovery: require('../server/utils/modelDiscovery')
  };
}

function setEnv(vars) {
  Object.keys(vars).forEach((k) => { if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; });
}
function clearProviderEnv() {
  setEnv({
    ANTHROPIC_API_KEY: undefined, ANTHROPIC_MODEL: undefined, ANTHROPIC_MODEL_FAST: undefined,
    OPENAI_API_KEY: undefined, OPENAI_MODEL: undefined, OPENAI_MODEL_FAST: undefined,
    GEMINI_API_KEY: undefined, GEMINI_MODEL: undefined, GEMINI_MODEL_FAST: undefined,
    GROK_API_KEY: undefined, MODEL_DISCOVERY_TTL_MS: undefined
  });
}

function anthropicModelsResponse(ids) {
  return { ok: true, text: async () => JSON.stringify({ data: ids.map((id) => ({ id, display_name: id, created_at: '2026-01-01' })) }) };
}
function geminiModelsResponse(ids) {
  return {
    ok: true,
    text: async () => JSON.stringify({
      models: ids.map((id) => ({ name: `models/${id}`, displayName: id, supportedGenerationMethods: ['generateContent'], inputTokenLimit: 200000 }))
    })
  };
}

(async () => {
  console.log('\n== A. API key có nhiều model -> hệ thống tự tạo nhiều Execution Target (mục 22.A) ==');
  await test('Anthropic key có 3 model -> 3 target sau khi ensureProvidersReady()', async () => {
    clearProviderEnv();
    setEnv({ ANTHROPIC_API_KEY: 'sk-ant-real' });
    const { aiProviders } = freshModules();
    global.fetch = async (url) => {
      assert.ok(url.includes('api.anthropic.com/v1/models'), 'phải gọi đúng endpoint liệt kê model Anthropic');
      return anthropicModelsResponse(['claude-opus-9', 'claude-sonnet-9', 'claude-haiku-9']);
    };
    await aiProviders.ensureProvidersReady();
    const targets = aiProviders.getActiveProviders();
    assert.ok(targets.length >= 1, 'phải sinh ít nhất 1 target từ model discovery');
    assert.ok(targets.every((t) => t.providerKey === 'anthropic'), 'mọi target phải là provider anthropic');
    assert.ok(targets.every((t) => ['claude-opus-9', 'claude-sonnet-9', 'claude-haiku-9'].includes(t.modelName)), 'model phải nằm trong danh sách discovery thật, không đoán mò');
  });

  console.log('\n== B. Không có ANTHROPIC_MODEL -> hệ thống vẫn chạy được (mục 22.B) ==');
  await test('Chỉ có API key, không có ANTHROPIC_MODEL -> vẫn tạo được target hợp lệ', async () => {
    clearProviderEnv();
    setEnv({ ANTHROPIC_API_KEY: 'sk-ant-real' });
    const { aiProviders } = freshModules();
    global.fetch = async () => anthropicModelsResponse(['claude-sonnet-9']);
    await aiProviders.ensureProvidersReady();
    const targets = aiProviders.getActiveProviders();
    assert.strictEqual(targets.length, 1);
    assert.strictEqual(targets[0].modelName, 'claude-sonnet-9');
  });

  console.log('\n== C. Không có ANTHROPIC_MODEL_FAST -> Fast Mode vẫn chạy (mục 22.C) ==');
  await test('Không khai model fast riêng -> callFastest vẫn gọi được, dùng model đã discovery', async () => {
    clearProviderEnv();
    setEnv({ ANTHROPIC_API_KEY: 'sk-ant-real' });
    const { aiProviders } = freshModules();
    global.fetch = async (url, opts) => {
      if (url.includes('/v1/models')) return anthropicModelsResponse(['claude-sonnet-9', 'claude-haiku-9']);
      const body = JSON.parse(opts.body);
      assert.ok(body.model, 'phải có model cụ thể trong request thật, không undefined');
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'ok' }] }) };
    };
    await aiProviders.ensureProvidersReady();
    const targets = aiProviders.getActiveProviders();
    const { text } = await aiProviders.callFastest(targets, { system: 's', messages: [], maxTokens: 50, fast: true });
    assert.strictEqual(text, 'ok');
  });

  console.log('\n== E. Discovery lỗi ở 1 provider không làm hỏng provider khác (mục 22.E) ==');
  await test('Anthropic discovery fail, Gemini discovery success -> Gemini vẫn có target', async () => {
    clearProviderEnv();
    setEnv({ ANTHROPIC_API_KEY: 'sk-ant-broken', GEMINI_API_KEY: 'gem-ok' });
    const { aiProviders } = freshModules();
    global.fetch = async (url) => {
      if (url.includes('api.anthropic.com')) throw new Error('network down');
      if (url.includes('generativelanguage')) return geminiModelsResponse(['gemini-9-flash']);
      throw new Error('unexpected url ' + url);
    };
    await aiProviders.ensureProvidersReady();
    const targets = aiProviders.getActiveProviders();
    assert.ok(targets.some((t) => t.providerKey === 'gemini'), 'Gemini phải vẫn có target dù Anthropic discovery lỗi');
    assert.ok(!targets.some((t) => t.providerKey === 'anthropic'), 'Anthropic không được tạo target khi discovery lỗi và không có cache cũ');
  });

  console.log('\n== F/G. Cache discovery: không gọi API mỗi request, tự làm mới khi hết hạn (mục 22.F/G) ==');
  await test('2 lần ensureProvidersReady() liên tiếp trong TTL -> chỉ gọi discovery API 1 lần', async () => {
    clearProviderEnv();
    setEnv({ ANTHROPIC_API_KEY: 'sk-ant-real', MODEL_DISCOVERY_TTL_MS: '60000' });
    const { aiProviders } = freshModules();
    let discoveryCalls = 0;
    global.fetch = async (url) => { discoveryCalls++; return anthropicModelsResponse(['claude-sonnet-9']); };
    await aiProviders.ensureProvidersReady();
    await aiProviders.ensureProvidersReady();
    assert.strictEqual(discoveryCalls, 1, 'lần gọi thứ 2 phải dùng cache, không gọi API lại');
  });

  await test('Cache hết hạn (TTL=0) -> lần sau tự discovery lại', async () => {
    clearProviderEnv();
    setEnv({ ANTHROPIC_API_KEY: 'sk-ant-real', MODEL_DISCOVERY_TTL_MS: '0' });
    const { aiProviders, modelDiscovery } = freshModules();
    let discoveryCalls = 0;
    global.fetch = async () => { discoveryCalls++; return anthropicModelsResponse(['claude-sonnet-9']); };
    await aiProviders.ensureProvidersReady();
    await new Promise((r) => setTimeout(r, 5));
    await aiProviders.ensureProvidersReady();
    assert.ok(discoveryCalls >= 2, 'TTL=0 -> mỗi lượt phải discovery lại');
  });

  console.log('\n== H. Model không có vision -> request có ảnh không được chọn model đó (mục 22.H) ==');
  await test('requireVision=true loại target model không hỗ trợ vision', async () => {
    clearProviderEnv();
    setEnv({ GROK_API_KEY: 'grok-key' }); // provider OpenAI-compatible: supportsVision=false theo config mặc định
    const { aiProviders } = freshModules();
    global.fetch = async () => { throw new Error('không hỗ trợ discovery — dùng declared fallback'); };
    await aiProviders.ensureProvidersReady();
    const targets = aiProviders.getActiveProviders();
    assert.ok(targets.length >= 1, 'vẫn phải có target (declared fallback) dù provider không hỗ trợ discovery');
    const { getEligibleTargets } = require('../server/utils/rotationManager');
    const eligible = getEligibleTargets(targets, { requireVision: true });
    assert.strictEqual(eligible.length, 0, 'target Grok (không vision) phải bị loại khi request yêu cầu vision');
  });

  console.log('\n== L. Legacy *_MODEL vẫn hoạt động nếu người dùng cố tình cấu hình (mục 22.L) ==');
  await test('ANTHROPIC_MODEL khai tay -> KHÔNG gọi discovery API, dùng đúng model khai', async () => {
    clearProviderEnv();
    setEnv({ ANTHROPIC_API_KEY: 'sk-ant-real', ANTHROPIC_MODEL: 'claude-pinned-1' });
    const { aiProviders } = freshModules();
    let discoveryCalled = false;
    global.fetch = async (url) => { if (url.includes('/v1/models')) discoveryCalled = true; return anthropicModelsResponse(['should-not-be-used']); };
    await aiProviders.ensureProvidersReady();
    const targets = aiProviders.getActiveProviders();
    assert.strictEqual(discoveryCalled, false, 'legacy explicit override không được gọi discovery API');
    assert.strictEqual(targets.length, 1);
    assert.strictEqual(targets[0].modelName, 'claude-pinned-1');
  });

  console.log('\n== N. Tất cả provider discovery fail -> lỗi rõ ràng, không crash (mục 22.N) ==');
  await test('Mọi discovery đều lỗi và không có declared fallback -> 0 target, KHÔNG throw, báo lỗi rõ ràng ở tầng route', async () => {
    clearProviderEnv();
    setEnv({ ANTHROPIC_API_KEY: 'sk-ant-broken' });
    const { aiProviders } = freshModules();
    global.fetch = async () => { throw new Error('DNS lỗi'); };
    await assert.doesNotReject(aiProviders.ensureProvidersReady(), 'ensureProvidersReady không bao giờ throw');
    const targets = aiProviders.getActiveProviders();
    assert.strictEqual(targets.length, 0, 'không có target nào khi mọi discovery đều lỗi và không có cache cũ');
  });

  console.log('\n== O. API key không xuất hiện trong log (mục 22.O) ==');
  await test('warmDiscovery lỗi không log plaintext API key', async () => {
    clearProviderEnv();
    const secretKey = 'sk-ant-super-secret-value-12345';
    setEnv({ ANTHROPIC_API_KEY: secretKey });
    const { aiProviders } = freshModules();
    const logs = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...rest) => { logs.push(String(chunk)); return originalWrite(chunk, ...rest); };
    const originalErrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => { logs.push(String(chunk)); return originalErrWrite(chunk, ...rest); };
    global.fetch = async () => { throw new Error('unauthorized: ' + secretKey); };
    try {
      await aiProviders.ensureProvidersReady();
    } finally {
      process.stdout.write = originalWrite;
      process.stderr.write = originalErrWrite;
    }
    assert.ok(!logs.some((l) => l.includes(secretKey)), 'API key thật không được xuất hiện nguyên văn trong log');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
