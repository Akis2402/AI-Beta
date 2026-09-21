'use strict';

// ============================================================================================
// LỖ HỔNG PHÁT HIỆN TRONG ĐỢT AUDIT NÀY: grok-image và openrouter-image đã được thêm vào
// IMAGE_PROVIDER_DEFS (imageGenerationClient.js) nhưng KHÔNG có test nào kiểm registry/failover
// cho 2 provider này — test/image-provider-contract.test.js và image-provider-failover.test.js
// chỉ dựng mock cho gemini/openai. File này lấp đúng chỗ trống đó:
//   1. Cả 4 provider (gemini/openai/grok/openrouter) đều đăng ký đúng khi có đủ khoá.
//   2. `requiresExplicitModel` của openrouter: KHÔNG bật nếu thiếu OPENROUTER_IMAGE_MODEL.
//   3. Khoá ảnh của grok kế thừa đúng từ GROK_API_KEY lẫn XAI_API_KEY (2 tên biến môi trường).
//   4. Failover chạy được qua TOÀN BỘ chuỗi 4 provider khi 3 provider đầu đều lỗi kỹ thuật.
//   5. IMAGE_PROVIDER_ORDER sắp lại thứ tự đúng như khai báo.

const assert = require('assert');

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, error: e.message }); }
}

function freshClient(env) {
  for (const k of ['GEMINI_IMAGE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
    'OPENAI_IMAGE_API_KEY', 'OPENAI_API_KEY',
    'GROK_IMAGE_API_KEY', 'GROK_API_KEY', 'XAI_API_KEY',
    'OPENROUTER_IMAGE_API_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_IMAGE_MODEL',
    'IMAGE_PROVIDER_ORDER', 'IMAGE_GENERATION_ENABLED']) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../server/utils/visual/imageGenerationClient.js')];
  return require('../server/utils/visual/imageGenerationClient.js');
}

const B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PROMPT = 'Vẽ mặt cắt tế bào động vật, ghi rõ nhãn nhân và ti thể.';
const realFetch = global.fetch;

(async () => {
  await test('registry: openrouter-image KHÔNG đăng ký khi thiếu OPENROUTER_IMAGE_MODEL (requiresExplicitModel)', () => {
    const client = freshClient({ OPENROUTER_API_KEY: 'k' });
    const names = client.listImageProviders().map((p) => p.name);
    assert.ok(!names.includes('openrouter-image'), 'openrouter không được bật khi chưa chỉ định model ảnh');
  });

  await test('registry: openrouter-image ĐĂNG KÝ khi có đủ khoá + OPENROUTER_IMAGE_MODEL', () => {
    const client = freshClient({ OPENROUTER_API_KEY: 'k', OPENROUTER_IMAGE_MODEL: 'some/image-model' });
    const names = client.listImageProviders().map((p) => p.name);
    assert.ok(names.includes('openrouter-image'));
  });

  await test('registry: grok-image kế thừa khoá từ GROK_API_KEY', () => {
    const client = freshClient({ GROK_API_KEY: 'gk' });
    const p = client.listImageProviders().find((x) => x.name === 'grok-image');
    assert.ok(p, 'grok-image phải đăng ký được từ GROK_API_KEY');
    assert.strictEqual(p.keySource, 'text_reuse');
  });

  await test('registry: grok-image kế thừa khoá từ XAI_API_KEY khi GROK_API_KEY vắng mặt', () => {
    const client = freshClient({ XAI_API_KEY: 'xk' });
    const p = client.listImageProviders().find((x) => x.name === 'grok-image');
    assert.ok(p, 'grok-image phải đăng ký được từ XAI_API_KEY');
  });

  await test('registry: cả 4 provider cùng đăng ký khi đủ khoá, đúng thứ tự mặc định gemini<openai<grok<openrouter', () => {
    const client = freshClient({
      GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o', GROK_API_KEY: 'x',
      OPENROUTER_API_KEY: 'r', OPENROUTER_IMAGE_MODEL: 'vendor/model'
    });
    const names = client.listImageProviders().map((p) => p.name);
    assert.deepStrictEqual(names, ['gemini-image', 'openai-image', 'grok-image', 'openrouter-image']);
  });

  await test('registry: IMAGE_PROVIDER_ORDER ghi đè thứ tự thử', () => {
    const client = freshClient({
      GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o', GROK_API_KEY: 'x',
      IMAGE_PROVIDER_ORDER: 'grok-image,gemini-image,openai-image'
    });
    const names = client.listImageProviders().map((p) => p.name);
    assert.deepStrictEqual(names, ['grok-image', 'gemini-image', 'openai-image']);
  });

  await test('failover: 3 provider đầu lỗi kỹ thuật (5xx/400/malformed) -> provider thứ 4 (openrouter) vẫn được thử và thành công', async () => {
    const client = freshClient({
      GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o', GROK_API_KEY: 'x',
      OPENROUTER_API_KEY: 'r', OPENROUTER_IMAGE_MODEL: 'vendor/model'
    });
    const calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).includes('googleapis')) return { ok: false, status: 500, text: async () => '', json: async () => ({}) };
      if (String(url).includes('api.openai.com')) return { ok: false, status: 400, text: async () => '', json: async () => ({}) };
      if (String(url).includes('api.x.ai')) return { ok: true, status: 200, json: async () => { throw new Error('bad json'); } };
      if (String(url).includes('openrouter.ai')) return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: B64 }] }) };
      throw new Error('unexpected url ' + url);
    };
    try {
      const r = await client.generateImage({ prompt: PROMPT });
      assert.strictEqual(r.ok, true, 'phải thành công ở provider thứ 4 sau khi 3 provider đầu lỗi kỹ thuật khác nhau');
      assert.deepStrictEqual(r.providersTried, ['gemini-image', 'openai-image', 'grok-image', 'openrouter-image']);
      assert.ok(/^data:image\/png;base64,/.test(r.url));
    } finally { global.fetch = realFetch; }
  });

  await test('failover: content_blocked ở provider ĐẦU dừng ngay, không tốn lượt gọi grok/openrouter', async () => {
    const client = freshClient({
      GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o', GROK_API_KEY: 'x',
      OPENROUTER_API_KEY: 'r', OPENROUTER_IMAGE_MODEL: 'vendor/model'
    });
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ promptFeedback: { blockReason: 'SAFETY' } }) });
    try {
      const r = await client.generateImage({ prompt: PROMPT });
      assert.strictEqual(r.ok, false);
      assert.deepStrictEqual(r.providersTried, ['gemini-image']);
    } finally { global.fetch = realFetch; }
  });

  global.fetch = realFetch;
  let p = 0, f = 0;
  console.log('\n== BỔ SUNG: registry + failover cho grok-image/openrouter-image (chưa từng có test) ==');
  results.forEach((r) => {
    if (r.pass) { p++; console.log('  ok  - ' + r.name); }
    else { f++; console.log(' FAIL - ' + r.name + '\n        ' + r.error); }
  });
  console.log(`\n${p} passed, ${f} failed`);
  if (f) process.exitCode = 1;
})();
