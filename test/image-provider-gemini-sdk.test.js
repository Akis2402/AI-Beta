'use strict';

// ============================================================================================
// gemini-sdk-image — provider ẢNH SONG SONG với gemini-image (REST), gọi qua SDK chính chủ
// @google/genai (ai.models.generateContent) thay vì tự dựng request REST.
// ============================================================================================
// Kiểm 3 việc:
//   1. KHÔNG tự bật khi chỉ có GEMINI_API_KEY/GOOGLE_API_KEY (chỉ opt-in qua GEMINI_SDK_IMAGE_API_KEY
//      riêng) — tránh chạy trùng 2 provider cùng khóa, cùng backend, cùng kiểu lỗi.
//   2. Bật đúng khi có GEMINI_SDK_IMAGE_API_KEY, đứng SAU gemini-image (order 10 < 15) trong thứ tự
//      thử mặc định.
//   3. Thiếu package @google/genai (`npm install` chưa chạy) -> KHÔNG làm sập module lẫn không throw
//      khi gọi, trả về {ok:false, reason:'sdk_not_installed'} để generateImage() tự failover tiếp,
//      đúng bất biến "không có provider ảnh KHÔNG PHẢI là lỗi".

const assert = require('assert');

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, error: e.message }); }
}

function freshClient(env) {
  for (const k of ['GEMINI_IMAGE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
    'GEMINI_SDK_IMAGE_API_KEY', 'GEMINI_SDK_IMAGE_MODEL',
    'IMAGE_PROVIDER_ORDER', 'IMAGE_GENERATION_ENABLED']) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../server/utils/visual/imageGenerationClient.js')];
  return require('../server/utils/visual/imageGenerationClient.js');
}

(async () => {
  await test('registry: gemini-sdk-image KHÔNG tự bật chỉ với GEMINI_API_KEY (không kế thừa khóa text)', () => {
    const client = freshClient({ GEMINI_API_KEY: 'g' });
    const names = client.listImageProviders().map((p) => p.name);
    assert.ok(names.includes('gemini-image'), 'gemini-image (REST) vẫn phải bật bình thường');
    assert.ok(!names.includes('gemini-sdk-image'), 'gemini-sdk-image không được tự bật ké khóa text');
  });

  await test('registry: gemini-sdk-image bật khi có GEMINI_SDK_IMAGE_API_KEY riêng, đứng sau gemini-image', () => {
    const client = freshClient({ GEMINI_API_KEY: 'g', GEMINI_SDK_IMAGE_API_KEY: 'sdk-key' });
    const names = client.listImageProviders().map((p) => p.name);
    assert.deepStrictEqual(names, ['gemini-image', 'gemini-sdk-image']);
  });

  await test('registry: gemini-sdk-image dùng model mặc định khi chưa set GEMINI_SDK_IMAGE_MODEL', () => {
    const client = freshClient({ GEMINI_SDK_IMAGE_API_KEY: 'sdk-key' });
    const p = client.listImageProviders().find((x) => x.name === 'gemini-sdk-image');
    assert.ok(p, 'phải đăng ký được chỉ với khóa riêng, không cần GEMINI_API_KEY');
    assert.strictEqual(p.model, 'gemini-2.5-flash-image');
    assert.strictEqual(p.keySource, 'image_specific');
  });

  await test('call: thiếu package @google/genai -> trả ok:false reason sdk_not_installed, KHÔNG throw', async () => {
    const client = freshClient({ GEMINI_SDK_IMAGE_API_KEY: 'sdk-key' });
    // Môi trường test không cài @google/genai -> loadGoogleGenAI() phải tự bắt lỗi require, không throw ra ngoài.
    const out = await client.callGeminiImageSdk({
      prompt: 'test prompt', timeoutMs: 2000, apiKey: 'sdk-key', model: 'gemini-2.5-flash-image'
    });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.reason, 'sdk_not_installed');
  });

  await test('generateImage: gemini-sdk-image thiếu package vẫn failover êm, không throw ra caller', async () => {
    const client = freshClient({ GEMINI_SDK_IMAGE_API_KEY: 'sdk-key' });
    const out = await client.generateImage({ prompt: 'Vẽ sơ đồ tế bào động vật, ghi rõ nhãn.' });
    assert.strictEqual(out.ok, false);
    assert.ok(out.providersTried.includes('gemini-sdk-image'));
    assert.strictEqual(out.reason, 'sdk_not_installed');
  });

  // DỌN process.env: file này chạy CHUNG 1 process với mọi test khác (test/run-all.js require()
  // tuần tự, không fork). Nếu để sót GEMINI_SDK_IMAGE_API_KEY sau khi file này xong, các test SAU
  // (vd answer-ordering.test.js, image-generation.test.js) không biết biến này tồn tại nên KHÔNG
  // xoá nó trong danh sách dọn của họ -> gemini-sdk-image âm thầm bật ké, phá số lượng provider/lệnh
  // gọi mà các test đó đang đếm cứng. Đây LÀ nguyên nhân roundtrip đầu tiên làm answer-ordering.test.js
  // FAIL — không phải lỗi ở registry, mà lỗi vệ sinh test.
  for (const k of ['GEMINI_IMAGE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
    'GEMINI_SDK_IMAGE_API_KEY', 'GEMINI_SDK_IMAGE_MODEL',
    'IMAGE_PROVIDER_ORDER', 'IMAGE_GENERATION_ENABLED']) delete process.env[k];
  delete require.cache[require.resolve('../server/utils/visual/imageGenerationClient.js')];

  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} - ${r.name}${r.pass ? '' : ' :: ' + r.error}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
})();
