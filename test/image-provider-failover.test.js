'use strict';

// ---------- A4: FAILOVER GIỮA 2 IMAGE PROVIDER, ĐÚNG 1 LẦN, KHÔNG LOOP ----------
// LỖI GỐC: `GEMINI_IMAGE_KEY ? callGeminiImage(...) : callOpenAIImage(...)` — cấu hình cả 2 khóa thì
// chỉ Gemini được thử; Gemini lỗi 5xx là bỏ luôn dù khóa OpenAI đã sẵn sàng. Không nhất quán với
// triết lý failover đã có cho text provider.
// Bộ test này chạy trên `fetch` giả nên KHÔNG gọi mạng thật.

const assert = require('assert');

process.env.GEMINI_IMAGE_API_KEY = 'test-gemini-key';
process.env.OPENAI_IMAGE_API_KEY = 'test-openai-key';
delete require.cache[require.resolve('../server/utils/visual/imageGenerationClient.js')];
const client = require('../server/utils/visual/imageGenerationClient.js');

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, error: e.message }); }
}

const realFetch = global.fetch;
let calls = [];
function mockFetch(plan) {
  calls = [];
  global.fetch = async (url) => {
    const host = String(url).includes('googleapis') ? 'gemini' : 'openai';
    calls.push(host);
    const r = plan[host];
    if (r === 'http500') return { ok: false, status: 500, text: async () => '', json: async () => ({}) };
    if (r === 'notext') return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'xin lỗi tôi không vẽ được' }] } }], data: [] }) };
    if (r === 'badrequest') return { ok: false, status: 400, text: async () => '', json: async () => ({}) };
    return {
      ok: true, status: 200,
      json: async () => (host === 'gemini'
        ? { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }] } }] }
        : { data: [{ b64_json: 'BBBB' }] })
    };
  };
}

const PROMPT = 'Vẽ tam giác ABC vuông tại A với đường cao AH, ghi rõ nhãn các đỉnh.';

(async () => {
  await test('S/AB. Gemini lỗi 5xx + OpenAI trả ảnh hợp lệ -> ok:true, providersTried gồm CẢ HAI', async () => {
    mockFetch({ gemini: 'http500', openai: 'ok' });
    const r = await client.generateImage({ prompt: PROMPT });
    assert.strictEqual(r.ok, true, 'phải failover sang OpenAI thay vì bỏ cuộc');
    assert.deepStrictEqual(r.providersTried, ['gemini-image', 'openai-image']);
    assert.strictEqual(calls.length, 2, 'đúng 2 lệnh gọi, không hơn');
  });

  await test('Q/AB. CẢ HAI provider lỗi -> ok:false sau ĐÚNG 2 lần gọi (không lặp vô hạn)', async () => {
    mockFetch({ gemini: 'http500', openai: 'http500' });
    const r = await client.generateImage({ prompt: PROMPT });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(calls.length, 2, `phải dừng sau 2 lần, thực tế ${calls.length}`);
    assert.deepStrictEqual(r.providersTried, ['gemini-image', 'openai-image']);
  });

  await test('A4. "model trả text thay vì ảnh" là lỗi RETRYABLE -> vẫn thử provider còn lại', async () => {
    mockFetch({ gemini: 'notext', openai: 'ok' });
    const r = await client.generateImage({ prompt: PROMPT });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(calls.length, 2);
  });

  await test('A4. Lỗi INPUT (http 4xx) KHÔNG được failover — lỗi chắc chắn lặp lại y hệt', async () => {
    mockFetch({ gemini: 'badrequest', openai: 'ok' });
    const r = await client.generateImage({ prompt: PROMPT });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(calls.length, 1, 'không được tốn thêm 1 lệnh gọi vô ích');
  });

  await test('A4. empty_prompt / prompt rác -> 0 lệnh gọi API, không throw', async () => {
    mockFetch({ gemini: 'ok', openai: 'ok' });
    const r = await client.generateImage({ prompt: 'x' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'empty_prompt');
    assert.strictEqual(calls.length, 0);
  });

  await test('A4. Deadline sắp cạn -> KHÔNG bắt đầu provider thứ 2 (giữ hợp đồng deadline riêng của hình)', async () => {
    mockFetch({ gemini: 'http500', openai: 'ok' });
    const r = await client.generateImage({ prompt: PROMPT, deadlineAt: Date.now() + 200 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(calls.length, 1);
  });

  await test('B9.15. classifyImageCost: deterministic = LOW, OpenAI 1024x1024 = HIGH', () => {
    assert.strictEqual(client.classifyImageCost({ renderer: 'deterministic' }), 'IMAGE_COST_LOW');
    assert.strictEqual(client.classifyImageCost({ provider: 'openai-image', size: '1024x1024' }), 'IMAGE_COST_HIGH');
    assert.strictEqual(client.classifyImageCost({ provider: 'gemini-image', size: '512x512' }), 'IMAGE_COST_LOW');
  });

  await test('B9.5. router capability-aware: mỗi provider khai đủ capability, không hard-code if/else', () => {
    const list = client.listImageProviders();
    assert.strictEqual(list.length, 2);
    list.forEach((p) => {
      ['name', 'model', 'supportsTextToImage', 'maxPromptTokens', 'costClass', 'qualityClass', 'latencyClass']
        .forEach((f) => assert.ok(f in p, `${p.name} thiếu capability field: ${f}`));
    });
  });

  global.fetch = realFetch;
  let p = 0, f = 0;
  console.log('\n== A4: image provider failover + cost policy ==');
  results.forEach((r) => {
    if (r.pass) { p++; console.log('  ok  - ' + r.name); }
    else { f++; console.log(' FAIL - ' + r.name + '\n        ' + r.error); }
  });
  console.log(`\n${p} passed, ${f} failed`);
  if (f) process.exitCode = 1;
})();
