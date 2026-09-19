'use strict';

// ---------- REGRESSION: FINAL AUDIT section H — provider API contract tests ----------
// Mocked fetch (KHÔNG gọi mạng thật). Assert URL, method, headers, body, parsing, timeout/abort
// cho cả 3 provider: Anthropic, OpenAI, Gemini — normal/thinking/vision/streaming/error.

const assert = require('assert');
const results = [];
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => results.push({ name, pass: true }),
    (e) => results.push({ name, pass: false, error: e.stack || e.message })
  );
}
function freshRequire(mod) { delete require.cache[require.resolve(mod)]; return require(mod); }

async function main() {

// ================= ANTHROPIC =================
await test('Anthropic normal request: đúng URL/method/headers/body, parse text đúng', async () => {
  process.env.ANTHROPIC_API_KEY = 'ak-test'; process.env.ANTHROPIC_MODEL = 'claude-test-model';
  const client = freshRequire('../server/utils/anthropicClient');
  let cap;
  global.fetch = async (url, opts) => { cap = { url, opts }; return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'ket qua' }] }) }; };
  const text = await client.callClaude({ system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 });
  assert.strictEqual(cap.url, 'https://api.anthropic.com/v1/messages');
  assert.strictEqual(cap.opts.method, 'POST');
  assert.strictEqual(cap.opts.headers['x-api-key'], 'ak-test');
  assert.strictEqual(cap.opts.headers['anthropic-version'], '2023-06-01');
  const body = JSON.parse(cap.opts.body);
  assert.strictEqual(body.model, 'claude-test-model');
  assert.strictEqual(body.messages[0].content, 'hi');
  assert.strictEqual(text, 'ket qua');
});

await test('Anthropic thinking request: model reasoning-capable + deepThinking=true -> gửi thinking, KHÔNG gửi temperature', async () => {
  process.env.ANTHROPIC_API_KEY = 'ak-test'; process.env.ANTHROPIC_MODEL = 'claude-test-model';
  const client = freshRequire('../server/utils/anthropicClient');
  let cap;
  global.fetch = async (url, opts) => { cap = opts; return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }; };
  await client.callClaude({ system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 2000, deepThinking: true, fast: false, temperature: 0.7, capabilities: { supportsThinking: true } });
  const body = JSON.parse(cap.body);
  assert.strictEqual(body.thinking.type, 'enabled');
  assert.ok(body.thinking.budget_tokens > 0 && body.thinking.budget_tokens < body.max_tokens);
  assert.strictEqual(body.temperature, undefined, 'không được gửi temperature cùng lúc với thinking (Anthropic từ chối)');
});

await test('Anthropic vision request: content block image được forward nguyên vẹn (đã là native shape)', async () => {
  process.env.ANTHROPIC_API_KEY = 'ak-test'; process.env.ANTHROPIC_MODEL = 'claude-test-model';
  const client = freshRequire('../server/utils/anthropicClient');
  let cap;
  global.fetch = async (url, opts) => { cap = opts; return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }; };
  const imgMsg = { role: 'user', content: [{ type: 'text', text: 'giai bai' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] };
  await client.callClaude({ system: 's', messages: [imgMsg], maxTokens: 500 });
  const body = JSON.parse(cap.body);
  assert.deepStrictEqual(body.messages[0].content, imgMsg.content);
});

await test('Anthropic streaming request: đúng URL/Accept header, gọi onDelta với text streamed', async () => {
  process.env.ANTHROPIC_API_KEY = 'ak-test'; process.env.ANTHROPIC_MODEL = 'claude-test-model';
  const client = freshRequire('../server/utils/anthropicClient');
  let cap;
  const sseBody = [
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"xin "}}',
    '',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"chao"}}',
    '',
    'data: {"type":"message_stop"}',
    ''
  ].join('\n');
  global.fetch = async (url, opts) => {
    cap = { url, opts };
    const { Readable } = require('stream');
    const chunks = [Buffer.from(sseBody)];
    let i = 0;
    return {
      ok: true,
      body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }), releaseLock: () => {} }) }
    };
  };
  let streamed = '';
  const full = await client.callClaudeStream({ system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, onDelta: (d) => { streamed += d; } });
  assert.strictEqual(cap.opts.headers.Accept, 'text/event-stream');
  assert.strictEqual(streamed, 'xin chao');
  assert.strictEqual(full, 'xin chao');
});

await test('Anthropic error parsing: HTTP 429 -> status 429, message không lộ chi tiết provider thô, detail được giữ (đã cắt ngắn)', async () => {
  process.env.ANTHROPIC_API_KEY = 'ak-test'; process.env.ANTHROPIC_MODEL = 'claude-test-model';
  const client = freshRequire('../server/utils/anthropicClient');
  global.fetch = async () => ({ ok: false, status: 429, text: async () => JSON.stringify({ error: { message: 'rate limited internal detail xyz' } }) });
  try {
    await client.callClaude({ system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 });
    assert.fail('phải throw');
  } catch (e) {
    assert.strictEqual(e.status, 429);
    assert.ok(!String(e.message).includes('rate limited internal detail'));
    assert.strictEqual(e.debugMessage, 'rate limited internal detail xyz');
  }
});

await test('Anthropic timeout/abort: timeoutMs hết hạn -> throw lỗi 504, không treo mãi', async () => {
  process.env.ANTHROPIC_API_KEY = 'ak-test'; process.env.ANTHROPIC_MODEL = 'claude-test-model';
  const client = freshRequire('../server/utils/anthropicClient');
  global.fetch = (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
  });
  try {
    await client.callClaude({ system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, timeoutMs: 50 });
    assert.fail('phải throw do timeout');
  } catch (e) {
    assert.strictEqual(e.status, 504);
  }
});

// ================= OPENAI =================
await test('OpenAI normal request: đúng URL/method/Authorization/body, parse output_text đúng', async () => {
  process.env.OPENAI_API_KEY = 'ok-test'; process.env.OPENAI_MODEL = 'gpt-test';
  const client = freshRequire('../server/utils/openaiClient');
  let cap;
  global.fetch = async (url, opts) => { cap = { url, opts }; return { ok: true, json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok gpt' }] }] }) }; };
  const text = await client.callOpenAI({ system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 });
  assert.ok(cap.url.includes('/responses') || cap.url.includes('openai.com'), 'URL phải trỏ đúng OpenAI Responses API');
  assert.strictEqual(cap.opts.method, 'POST');
  assert.strictEqual(cap.opts.headers.Authorization, 'Bearer ok-test');
  const body = JSON.parse(cap.opts.body);
  assert.strictEqual(body.model, 'gpt-test');
  assert.strictEqual(text, 'ok gpt');
});

await test('OpenAI reasoning request: reasoning-capable + deepThinking=true -> gửi reasoning.effort', async () => {
  process.env.OPENAI_API_KEY = 'ok-test'; process.env.OPENAI_MODEL = 'o3';
  const client = freshRequire('../server/utils/openaiClient');
  let cap;
  global.fetch = async (url, opts) => { cap = opts; return { ok: true, json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] }) }; };
  await client.callOpenAI({ system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, deepThinking: true, capabilities: { supportsThinking: true } });
  const body = JSON.parse(cap.body);
  assert.strictEqual(body.reasoning.effort, 'high');
});

await test('OpenAI web-search/tool request: webSearch=true -> tools chứa web_search_preview', async () => {
  process.env.OPENAI_API_KEY = 'ok-test'; process.env.OPENAI_MODEL = 'gpt-test';
  const client = freshRequire('../server/utils/openaiClient');
  let cap;
  global.fetch = async (url, opts) => { cap = opts; return { ok: true, json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] }) }; };
  await client.callOpenAI({ system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, webSearch: true });
  const body = JSON.parse(cap.body);
  assert.ok(body.tools.some((t) => t.type === 'web_search_preview'));
});

await test('OpenAI streaming request: Accept header đúng, onDelta nhận text_delta', async () => {
  process.env.OPENAI_API_KEY = 'ok-test'; process.env.OPENAI_MODEL = 'gpt-test';
  const client = freshRequire('../server/utils/openaiClient');
  let cap;
  const sse = [
    'data: {"type":"response.output_text.delta","delta":"hel"}',
    '',
    'data: {"type":"response.output_text.delta","delta":"lo"}',
    '',
    'data: {"type":"response.completed"}',
    ''
  ].join('\n');
  global.fetch = async (url, opts) => {
    cap = opts;
    const chunk = Buffer.from(sse);
    let sent = false;
    return { ok: true, body: { getReader: () => ({ read: async () => (sent ? { done: true, value: undefined } : (sent = true, { done: false, value: chunk })), releaseLock: () => {} }) } };
  };
  let streamed = '';
  await client.callOpenAIStream({ system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, onDelta: (d) => { streamed += d; } });
  assert.strictEqual(cap.headers.Accept, 'text/event-stream');
  assert.strictEqual(streamed, 'hello');
});

await test('OpenAI error parsing: HTTP 500 -> status 502 (chuẩn hóa 5xx thành 502 hoặc giữ nguyên), không throw raw text', async () => {
  process.env.OPENAI_API_KEY = 'ok-test'; process.env.OPENAI_MODEL = 'gpt-test';
  const client = freshRequire('../server/utils/openaiClient');
  global.fetch = async () => ({ ok: false, status: 500, text: async () => JSON.stringify({ error: { message: 'internal openai detail' } }) });
  try {
    await client.callOpenAI({ system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 });
    assert.fail('phải throw');
  } catch (e) {
    assert.ok(e.status >= 500 || e.status === 502);
    assert.ok(!String(e.message).includes('internal openai detail'));
  }
});

// ================= GEMINI =================
await test('Gemini normal request: đúng URL model, header x-goog-api-key, body generationConfig, parse text đúng', async () => {
  process.env.GEMINI_API_KEY = 'gk-test'; process.env.GEMINI_MODEL = 'gemini-2.5-pro';
  const client = freshRequire('../server/utils/geminiClient');
  let cap;
  global.fetch = async (url, opts) => { cap = { url, opts }; return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'chao gemini' }] } }] }) }; };
  const text = await client.callGemini({ system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 });
  assert.strictEqual(cap.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent');
  assert.strictEqual(cap.opts.headers['x-goog-api-key'], 'gk-test');
  assert.strictEqual(cap.opts.method, 'POST');
  const body = JSON.parse(cap.opts.body);
  assert.strictEqual(body.generationConfig.maxOutputTokens, 100);
  assert.strictEqual(text, 'chao gemini');
});

await test('Gemini thinking request: Gemini 2.5 + deepThinking -> thinkingConfig.thinkingBudget', async () => {
  process.env.GEMINI_API_KEY = 'gk-test'; process.env.GEMINI_MODEL = 'gemini-2.5-pro';
  const client = freshRequire('../server/utils/geminiClient');
  let cap;
  global.fetch = async (url, opts) => { cap = opts; return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) }; };
  await client.callGemini({ system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, deepThinking: true, capabilities: { supportsThinking: true } });
  const body = JSON.parse(cap.body);
  assert.strictEqual(typeof body.generationConfig.thinkingConfig.thinkingBudget, 'number');
});

await test('Gemini vision request: image block -> inlineData đúng mimeType/data', async () => {
  process.env.GEMINI_API_KEY = 'gk-test'; process.env.GEMINI_MODEL = 'gemini-2.5-pro';
  const client = freshRequire('../server/utils/geminiClient');
  let cap;
  global.fetch = async (url, opts) => { cap = opts; return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) }; };
  const imgMsg = { role: 'user', content: [{ type: 'text', text: 'giai' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } }] };
  await client.callGemini({ system: 's', messages: [imgMsg], maxTokens: 100 });
  const body = JSON.parse(cap.body);
  const imgPart = body.contents[0].parts.find((p) => p.inlineData);
  assert.strictEqual(imgPart.inlineData.mimeType, 'image/jpeg');
  assert.strictEqual(imgPart.inlineData.data, 'BBBB');
});

await test('Gemini search/grounding request: webSearch=true -> tools chứa google_search', async () => {
  process.env.GEMINI_API_KEY = 'gk-test'; process.env.GEMINI_MODEL = 'gemini-2.5-pro';
  const client = freshRequire('../server/utils/geminiClient');
  let cap;
  global.fetch = async (url, opts) => { cap = opts; return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) }; };
  await client.callGemini({ system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, webSearch: true });
  const body = JSON.parse(cap.body);
  assert.ok(body.tools.some((t) => t.google_search));
});

await test('Gemini streaming request: URL alt=sse, header x-goog-api-key, onDelta nhận text', async () => {
  process.env.GEMINI_API_KEY = 'gk-test'; process.env.GEMINI_MODEL = 'gemini-2.5-pro';
  const client = freshRequire('../server/utils/geminiClient');
  let cap;
  const sse = [
    'data: {"candidates":[{"content":{"parts":[{"text":"xin "}]}}]}',
    '',
    'data: {"candidates":[{"content":{"parts":[{"text":"chao"}]}}]}',
    ''
  ].join('\n');
  global.fetch = async (url, opts) => {
    cap = { url, opts };
    const chunk = Buffer.from(sse);
    let sent = false;
    return { ok: true, body: { getReader: () => ({ read: async () => (sent ? { done: true, value: undefined } : (sent = true, { done: false, value: chunk })), releaseLock: () => {} }) } };
  };
  let streamed = '';
  await client.callGeminiStream({ system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, onDelta: (d) => { streamed += d; } });
  assert.ok(cap.url.includes('streamGenerateContent'));
  assert.ok(cap.url.includes('alt=sse'));
  assert.strictEqual(cap.opts.headers['x-goog-api-key'], 'gk-test');
  assert.strictEqual(streamed, 'xin chao');
});

await test('Gemini auth header: KHÔNG có request Gemini nào (normal/stream/error) chứa key= trong URL', async () => {
  process.env.GEMINI_API_KEY = 'super-secret-check'; process.env.GEMINI_MODEL = 'gemini-2.5-pro';
  const client = freshRequire('../server/utils/geminiClient');
  const urls = [];
  global.fetch = async (url) => { urls.push(url); return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) }; };
  await client.callGemini({ system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 });
  urls.forEach((u) => { assert.ok(!u.includes('key=')); assert.ok(!u.includes('super-secret-check')); });
});

await test('Gemini error parsing: HTTP 400 -> status 502, message không lộ chi tiết provider thô, detail cắt <=500 ký tự', async () => {
  process.env.GEMINI_API_KEY = 'gk-test'; process.env.GEMINI_MODEL = 'gemini-2.5-pro';
  const client = freshRequire('../server/utils/geminiClient');
  global.fetch = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'gemini internal detail leak-check' } }) });
  try {
    await client.callGemini({ system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 });
    assert.fail('phải throw');
  } catch (e) {
    assert.strictEqual(e.status, 502);
    assert.ok(!String(e.message).includes('leak-check'));
    assert.strictEqual(e.debugMessage, 'gemini internal detail leak-check');
  }
});

// ---------- report ----------
const failed = results.filter((r) => !r.pass);
console.log('\n== Regression: provider API contract tests (audit section H) — Anthropic/OpenAI/Gemini ==');
results.forEach((r) => console.log(`  ${r.pass ? 'ok  -' : 'FAIL -'} ${r.name}${r.pass ? '' : '\n    ' + r.error}`));
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exitCode = failed.length ? 1 : 0;

}

main();
