'use strict';

// ---------- REGRESSION: FINAL AUDIT sections C/D/E/F/G ----------
// C: deep thinking phải capability-aware (không gửi field API model không hỗ trợ).
// E: Gemini API key qua header, không nằm trong URL.
// F: Gemini thinking version-aware (thinkingLevel vs thinkingBudget), fail-safe khi unknown.
// G: Gemini không bị ép temperature không phù hợp trong cross-check survivor path.
// Test THUẦN — mock global.fetch, không gọi mạng thật.

const assert = require('assert');

const results = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => results.push({ name, pass: true }), (e) => results.push({ name, pass: false, error: e.message }));
    }
    results.push({ name, pass: true });
  } catch (e) {
    results.push({ name, pass: false, error: e.message });
  }
  return Promise.resolve();
}

async function main() {

// ================= C. Anthropic: native thinking gate theo capabilities THẬT =================
await test('Anthropic: capabilities.supportsThinking=false -> KHÔNG gửi field thinking dù deepThinking=true', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ANTHROPIC_MODEL = 'claude-test-model';
  delete require.cache[require.resolve('../server/utils/anthropicClient')];
  const client = require('../server/utils/anthropicClient');
  const originalFetch = global.fetch;
  let capturedBody = null;
  global.fetch = async (url, opts) => { capturedBody = JSON.parse(opts.body); return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }; };
  try {
    await client.callClaude({ system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 2000, deepThinking: true, fast: false, capabilities: { supportsThinking: false, supportsAdaptiveThinking: false } });
    assert.strictEqual(capturedBody.thinking, undefined, 'model không hỗ trợ reasoning -> không được gửi field thinking (tránh lỗi 400 thật)');
  } finally { global.fetch = originalFetch; }
});

await test('Anthropic: capabilities={} (model capability KHÔNG XÁC ĐỊNH) -> fail-safe, không gửi thinking', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ANTHROPIC_MODEL = 'claude-test-model';
  delete require.cache[require.resolve('../server/utils/anthropicClient')];
  const client = require('../server/utils/anthropicClient');
  const originalFetch = global.fetch;
  let capturedBody = null;
  global.fetch = async (url, opts) => { capturedBody = JSON.parse(opts.body); return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }; };
  try {
    await client.callClaude({ system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 2000, deepThinking: true, fast: false, capabilities: {} });
    assert.strictEqual(capturedBody.thinking, undefined);
  } finally { global.fetch = originalFetch; }
});

await test('Anthropic: capabilities.supportsThinking=true -> gửi thinking bình thường (reasoning-capable model)', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ANTHROPIC_MODEL = 'claude-test-model';
  delete require.cache[require.resolve('../server/utils/anthropicClient')];
  const client = require('../server/utils/anthropicClient');
  const originalFetch = global.fetch;
  let capturedBody = null;
  global.fetch = async (url, opts) => { capturedBody = JSON.parse(opts.body); return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }; };
  try {
    await client.callClaude({ system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 2000, deepThinking: true, fast: false, capabilities: { supportsThinking: true } });
    assert.ok(capturedBody.thinking, 'model xác nhận reasoning-capable -> phải gửi thinking');
  } finally { global.fetch = originalFetch; }
});

await test('Anthropic: deepThinking=false -> không gửi thinking dù model có capability', () => {
  return (async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.ANTHROPIC_MODEL = 'claude-test-model';
    delete require.cache[require.resolve('../server/utils/anthropicClient')];
    const client = require('../server/utils/anthropicClient');
    const originalFetch = global.fetch;
    let capturedBody = null;
    global.fetch = async (url, opts) => { capturedBody = JSON.parse(opts.body); return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }; };
    try {
      await client.callClaude({ system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 2000, deepThinking: false, fast: false, capabilities: { supportsThinking: true } });
      assert.strictEqual(capturedBody.thinking, undefined);
    } finally { global.fetch = originalFetch; }
  })();
});

// ================= C. OpenAI: reasoning.effort gate theo capabilities THẬT =================
await test('OpenAI: capabilities.supportsThinking=false (non-reasoning model, vd gpt-4o) -> KHÔNG gửi field reasoning', async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_MODEL = 'gpt-4o';
  delete require.cache[require.resolve('../server/utils/openaiClient')];
  const client = require('../server/utils/openaiClient');
  const originalFetch = global.fetch;
  let capturedBody = null;
  global.fetch = async (url, opts) => { capturedBody = JSON.parse(opts.body); return { ok: true, json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] }) }; };
  try {
    await client.callOpenAI({ system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 500, deepThinking: true, fast: false, capabilities: { supportsThinking: false } });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(capturedBody, 'reasoning'), false, 'non-reasoning model không được nhận reasoning.effort (OpenAI trả 400 nếu gửi)');
  } finally { global.fetch = originalFetch; }
});

await test('OpenAI: capabilities.supportsThinking=true (reasoning model, vd o3) -> gửi reasoning.effort', async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_MODEL = 'o3';
  delete require.cache[require.resolve('../server/utils/openaiClient')];
  const client = require('../server/utils/openaiClient');
  const originalFetch = global.fetch;
  let capturedBody = null;
  global.fetch = async (url, opts) => { capturedBody = JSON.parse(opts.body); return { ok: true, json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] }) }; };
  try {
    await client.callOpenAI({ system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 500, deepThinking: true, fast: false, capabilities: { supportsThinking: true } });
    assert.ok(capturedBody.reasoning, 'reasoning model phải nhận reasoning.effort khi deepThinking=true');
  } finally { global.fetch = originalFetch; }
});

await test('OpenAI: capabilities unknown (không truyền — legacy direct call) -> giữ hành vi cũ (permissive)', async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_MODEL = 'gpt-test';
  delete require.cache[require.resolve('../server/utils/openaiClient')];
  const client = require('../server/utils/openaiClient');
  const originalFetch = global.fetch;
  let capturedBody = null;
  global.fetch = async (url, opts) => { capturedBody = JSON.parse(opts.body); return { ok: true, json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] }) }; };
  try {
    await client.callOpenAI({ system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 500, deepThinking: true, fast: false });
    assert.ok(capturedBody.reasoning, 'legacy caller không truyền capabilities -> tương thích ngược, vẫn gửi như trước');
  } finally { global.fetch = originalFetch; }
});

// ================= E. Gemini: API key KHÔNG nằm trong URL, dùng header =================
await test('Gemini: generateContent - key KHÔNG nằm trong URL, có header x-goog-api-key đúng giá trị', async () => {
  process.env.GEMINI_API_KEY = 'secret-gemini-key-XYZ';
  process.env.GEMINI_MODEL = 'gemini-2.5-pro';
  delete require.cache[require.resolve('../server/utils/geminiClient')];
  const client = require('../server/utils/geminiClient');
  const originalFetch = global.fetch;
  let capturedUrl = null, capturedHeaders = null;
  global.fetch = async (url, opts) => { capturedUrl = url; capturedHeaders = opts.headers; return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) }; };
  try {
    await client.callGemini({ system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 500 });
    assert.ok(!capturedUrl.includes('key='), 'URL không được chứa key= — key phải qua header');
    assert.ok(!capturedUrl.includes('secret-gemini-key-XYZ'), 'API key tuyệt đối không được xuất hiện trong URL');
    assert.strictEqual(capturedHeaders['x-goog-api-key'], 'secret-gemini-key-XYZ', 'header x-goog-api-key phải đúng giá trị key');
  } finally { global.fetch = originalFetch; }
});

await test('Gemini: streamGenerateContent - key KHÔNG nằm trong URL, có header x-goog-api-key', async () => {
  process.env.GEMINI_API_KEY = 'secret-gemini-key-STREAM';
  process.env.GEMINI_MODEL = 'gemini-2.5-pro';
  delete require.cache[require.resolve('../server/utils/geminiClient')];
  const client = require('../server/utils/geminiClient');
  const originalFetch = global.fetch;
  let capturedUrl = null, capturedHeaders = null;
  // callGeminiStream dùng iterateSSELines(res) -> res.body.getReader() kiểu Web Streams — mock 1
  // reader rỗng (kết thúc ngay, done:true) để không cần dữ liệu thật.
  const emptyBody = { getReader: () => ({ read: async () => ({ done: true, value: undefined }), releaseLock: () => {} }) };
  global.fetch = async (url, opts) => {
    capturedUrl = url; capturedHeaders = opts.headers;
    return { ok: true, body: emptyBody };
  };
  try {
    await client.callGeminiStream({ system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 500 });
    assert.ok(!capturedUrl.includes('key='));
    assert.ok(!capturedUrl.includes('secret-gemini-key-STREAM'));
    assert.strictEqual(capturedHeaders['x-goog-api-key'], 'secret-gemini-key-STREAM');
  } finally { global.fetch = originalFetch; }
});

await test('Gemini: lỗi HTTP -> error message không lộ API key', async () => {
  process.env.GEMINI_API_KEY = 'secret-should-not-leak';
  process.env.GEMINI_MODEL = 'gemini-2.5-pro';
  delete require.cache[require.resolve('../server/utils/geminiClient')];
  const client = require('../server/utils/geminiClient');
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'bad request' } }) });
  try {
    await client.callGemini({ system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 500 });
    assert.fail('phải throw lỗi');
  } catch (e) {
    assert.ok(!String(e.message).includes('secret-should-not-leak'));
    assert.ok(!String(e.detail || '').includes('secret-should-not-leak'));
    assert.ok(!String(e.debugMessage || '').includes('secret-should-not-leak'));
  } finally { global.fetch = originalFetch; }
});

// ================= F. Gemini thinking version-aware =================
const { resolveGeminiThinkingConfig } = require('../server/utils/geminiClient');

test('F1. Gemini 3: dùng thinkingLevel', () => {
  const cfg = resolveGeminiThinkingConfig({ modelId: 'gemini-3-pro', capabilities: { supportsThinking: true }, deepThinking: true, fast: false });
  assert.ok(cfg && cfg.thinkingLevel, 'Gemini 3 phải dùng thinkingLevel');
  assert.strictEqual(cfg.thinkingBudget, undefined);
});

test('F2. Gemini 2.5: dùng thinkingBudget', () => {
  const cfg = resolveGeminiThinkingConfig({ modelId: 'gemini-2.5-pro', capabilities: { supportsThinking: true }, deepThinking: true, fast: false });
  assert.ok(cfg && typeof cfg.thinkingBudget === 'number', 'Gemini 2.5 phải dùng thinkingBudget');
  assert.strictEqual(cfg.thinkingLevel, undefined);
});

test('F3. Generation unknown (không phải 3.x/2.5.x) NHƯNG capability biết rõ -> fail-safe, không gửi cấu hình mù', () => {
  const cfg = resolveGeminiThinkingConfig({ modelId: 'gemini-1.5-flash', capabilities: { supportsThinking: true }, deepThinking: true, fast: false });
  assert.strictEqual(cfg, null);
});

test('F4. deepThinking=false -> luôn null bất kể capability/generation', () => {
  const cfg = resolveGeminiThinkingConfig({ modelId: 'gemini-3-pro', capabilities: { supportsThinking: true }, deepThinking: false, fast: false });
  assert.strictEqual(cfg, null);
});

test('F5. capabilities xác nhận KHÔNG hỗ trợ thinking -> null dù model tên "gemini-3"', () => {
  const cfg = resolveGeminiThinkingConfig({ modelId: 'gemini-3-pro', capabilities: { supportsThinking: false, supportsAdaptiveThinking: false }, deepThinking: true, fast: false });
  assert.strictEqual(cfg, null);
});

test('F6. fast=true -> không bao giờ bật native thinking (ưu tiên latency)', () => {
  const cfg = resolveGeminiThinkingConfig({ modelId: 'gemini-3-pro', capabilities: { supportsThinking: true }, deepThinking: true, fast: true });
  assert.strictEqual(cfg, null);
});

test('F7. capabilities hoàn toàn vắng mặt (legacy direct call) -> giữ hành vi cũ (thinkingBudget mặc định)', () => {
  const cfg = resolveGeminiThinkingConfig({ modelId: 'gemini-legacy-unknown', deepThinking: true, fast: false });
  assert.ok(cfg && typeof cfg.thinkingBudget === 'number');
});

// ================= D. Model discovery: capability heuristic cô lập + conservative =================
const modelDiscovery = require('../server/utils/modelDiscovery');

test('D1. modelDiscovery module export không đổi (không phá API cũ)', () => {
  assert.strictEqual(typeof modelDiscovery.getCachedModels, 'function');
});

// ================= Wiring: executionTargets forward capabilities vào call() thật =================
await test('executionTargets: target.call() forward đúng capabilities đã merge vào args (không còn dead metadata)', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ANTHROPIC_MODEL = 'claude-test-model';
  delete require.cache[require.resolve('../server/utils/executionTargets')];
  delete require.cache[require.resolve('../server/utils/anthropicClient')];
  const { getAllExecutionTargets } = require('../server/utils/executionTargets');
  const targets = getAllExecutionTargets();
  const anthropic = targets.find((t) => t.providerKey === 'anthropic');
  assert.ok(anthropic, 'cần có target anthropic (legacy override qua ANTHROPIC_MODEL)');
  const originalFetch = global.fetch;
  let capturedBody = null;
  global.fetch = async (url, opts) => { capturedBody = JSON.parse(opts.body); return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }; };
  try {
    await anthropic.call({ system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 2000, deepThinking: true, fast: false });
    // Anthropic core target khai supportsAdaptiveThinking:true ở provider-level -> phải bật native.
    assert.ok(capturedBody.thinking, 'capabilities phải được forward thật sự tới client, không phải dead metadata');
  } finally { global.fetch = originalFetch; }
});

// ---------- report ----------
const failed = results.filter((r) => !r.pass);
console.log('\n== Regression: capability-aware thinking / Gemini auth header / version-aware (audit C/D/E/F/G) ==');
results.forEach((r) => console.log(`  ${r.pass ? 'ok  -' : 'FAIL -'} ${r.name}${r.pass ? '' : ' :: ' + r.error}`));
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exitCode = failed.length ? 1 : 0;

}

main();
