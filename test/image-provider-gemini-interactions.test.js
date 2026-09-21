'use strict';

// ============================================================================================
// gemini-interactions-image — REST thuần POST /v1beta/interactions (Interactions API, GA 06/2026).
// ============================================================================================
// Response shape THẬT khác hẳn generateContent: steps[] thay vì candidates[], content[] thay vì
// content.parts[]. File này khoá đúng shape đó lại bằng test, để lần sau ai đó "tối ưu" gộp chung
// parser với extractGeminiInline() sẽ bị test này chặn ngay (2 API không tương thích shape).

const assert = require('assert');

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, error: e.message }); }
}

function freshClient(env) {
  for (const k of ['GEMINI_IMAGE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
    'GEMINI_INTERACTIONS_IMAGE_API_KEY', 'GEMINI_INTERACTIONS_IMAGE_MODEL',
    'IMAGE_PROVIDER_ORDER', 'IMAGE_GENERATION_ENABLED']) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../server/utils/visual/imageGenerationClient.js')];
  return require('../server/utils/visual/imageGenerationClient.js');
}

async function withFetch(stub, fn) {
  const real = global.fetch;
  global.fetch = stub;
  try { return await fn(); } finally { global.fetch = real; }
}

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async () => {
  await test('registry: gemini-interactions-image KHÔNG tự bật chỉ với GEMINI_API_KEY', () => {
    const client = freshClient({ GEMINI_API_KEY: 'g' });
    const names = client.listImageProviders().map((p) => p.name);
    assert.ok(names.includes('gemini-image'));
    assert.ok(!names.includes('gemini-interactions-image'));
  });

  await test('registry: bật khi có khóa riêng, model mặc định gemini-3.1-flash-image', () => {
    const client = freshClient({ GEMINI_INTERACTIONS_IMAGE_API_KEY: 'ik' });
    const p = client.listImageProviders().find((x) => x.name === 'gemini-interactions-image');
    assert.ok(p);
    assert.strictEqual(p.model, 'gemini-3.1-flash-image');
    assert.strictEqual(p.keySource, 'image_specific');
  });

  await test('call: thành công -> đọc đúng steps[].content[] (KHÔNG phải candidates[])', async () => {
    const client = freshClient({ GEMINI_INTERACTIONS_IMAGE_API_KEY: 'ik' });
    let seenUrl = '', seenHeaders = null, seenBody = null;
    const out = await withFetch(async (url, opts) => {
      seenUrl = String(url); seenHeaders = opts.headers; seenBody = JSON.parse(opts.body);
      return {
        ok: true, status: 200,
        json: async () => ({
          steps: [
            { type: 'thought', content: [{ type: 'text', text: 'suy nghĩ nội bộ' }] },
            { type: 'model_output', content: [{ type: 'image', data: PNG_B64, mime_type: 'image/png' }] }
          ]
        })
      };
    }, () => client.generateImage({ prompt: 'vẽ sơ đồ tế bào động vật' }));
    assert.strictEqual(out.ok, true);
    assert.ok(out.url.startsWith('data:image/png;base64,'));
    assert.strictEqual(seenUrl, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    assert.strictEqual(seenHeaders['x-goog-api-key'], 'ik');
    assert.strictEqual(seenBody.model, 'gemini-3.1-flash-image');
    assert.deepStrictEqual(seenBody.input, [{ type: 'text', text: 'vẽ sơ đồ tế bào động vật' }]);
  });

  await test('call: chỉ có step "thought" (không có model_output) -> no_image_in_response', async () => {
    const client = freshClient({ GEMINI_INTERACTIONS_IMAGE_API_KEY: 'ik' });
    const out = await withFetch(async () => ({
      ok: true, status: 200,
      json: async () => ({ steps: [{ type: 'thought', content: [{ type: 'image', data: PNG_B64 }] }] })
    }), () => client.generateImage({ prompt: 'vẽ sơ đồ tế bào động vật' }));
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.reason, 'no_image_in_response');
  });

  await test('call: HTTP lỗi -> reason mang mã status, không throw', async () => {
    const client = freshClient({ GEMINI_INTERACTIONS_IMAGE_API_KEY: 'ik' });
    const out = await withFetch(async () => ({ ok: false, status: 503, json: async () => ({}) }),
      () => client.generateImage({ prompt: 'vẽ sơ đồ tế bào động vật' }));
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.reason, 'http_503');
  });

  await test('call: field data là chuỗi rác (không phải base64 ảnh) -> no_image_in_response, KHÔNG giả vờ thành công', async () => {
    const client = freshClient({ GEMINI_INTERACTIONS_IMAGE_API_KEY: 'ik' });
    const out = await withFetch(async () => ({
      ok: true, status: 200,
      json: async () => ({ steps: [{ type: 'model_output', content: [{ type: 'image', data: 'xin lỗi tôi không thể tạo ảnh này' }] }] })
    }), () => client.generateImage({ prompt: 'vẽ sơ đồ tế bào động vật' }));
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.reason, 'no_image_in_response');
  });

  // Dọn process.env — file này chạy chung 1 process với mọi test khác (xem lý do chi tiết trong
  // test/image-provider-gemini-sdk.test.js).
  for (const k of ['GEMINI_IMAGE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
    'GEMINI_INTERACTIONS_IMAGE_API_KEY', 'GEMINI_INTERACTIONS_IMAGE_MODEL',
    'IMAGE_PROVIDER_ORDER', 'IMAGE_GENERATION_ENABLED']) delete process.env[k];
  delete require.cache[require.resolve('../server/utils/visual/imageGenerationClient.js')];

  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} - ${r.name}${r.pass ? '' : ' :: ' + r.error}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
})();
