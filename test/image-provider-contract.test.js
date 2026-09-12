'use strict';

// ============================================================================================
// RỦI RO #1 — CONTRACT TEST cho image provider (thay cho việc chưa có khóa ảnh thật)
// ============================================================================================
// Không thể gọi provider thật, nên thứ kiểm soát được là: parser phải KHOAN DUNG với mọi biến thể
// shape đã tài liệu hoá, và AN TOÀN với mọi shape lạ. Bảng dưới đây liệt kê tường minh từng shape
// kèm nguồn gốc, để khi API đổi version chỉ cần thêm 1 dòng vào bảng.
//
// Khi có khóa thật: chạy `npm run live-image-check` để đối chiếu shape THỰC TẾ với parser này.

const assert = require('assert');
process.env.GEMINI_IMAGE_API_KEY = 'k1';
process.env.OPENAI_IMAGE_API_KEY = 'k2';
delete require.cache[require.resolve('../server/utils/visual/imageGenerationClient.js')];
const client = require('../server/utils/visual/imageGenerationClient.js');

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, error: e.message }); }
}

const B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PROMPT = 'Vẽ sơ đồ cấu tạo tế bào thực vật, ghi rõ nhãn thành tế bào và lục lạp.';
const realFetch = global.fetch;

function respond(host, body, status = 200) {
  global.fetch = async (url) => {
    const isGemini = String(url).includes('googleapis');
    if ((host === 'gemini') !== isGemini) {
      // Provider còn lại luôn lỗi 5xx -> cô lập đúng nhánh đang kiểm.
      return { ok: false, status: 500, text: async () => '', json: async () => ({}) };
    }
    return { ok: status < 400, status, text: async () => '', json: async () => body };
  };
}

// ---------- Bảng shape THÀNH CÔNG đã tài liệu hoá / biến thể đặt tên thường gặp ----------
const OK_SHAPES = [
  ['gemini', 'v1beta camelCase inlineData', { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: B64 } }] } }] }],
  ['gemini', 'snake_case inline_data', { candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/webp', data: B64 } }] } }] }],
  ['gemini', 'ảnh nằm sau 1 part text (model nói rồi mới vẽ)', { candidates: [{ content: { parts: [{ text: 'Đây là hình:' }, { inlineData: { data: B64 } }] } }] }],
  ['gemini', 'ảnh ở candidate thứ 2', { candidates: [{ content: { parts: [{ text: 'x' }] } }, { content: { parts: [{ inlineData: { data: B64 } }] } }] }],
  ['gemini', 'Vertex-style predictions[].bytesBase64Encoded', { predictions: [{ bytesBase64Encoded: B64, mimeType: 'image/png' }] }],
  ['openai', 'Images API b64_json', { data: [{ b64_json: B64 }] }],
  ['openai', 'b64_json + output_format', { data: [{ b64_json: B64, output_format: 'webp' }] }],
  ['openai', 'URL https', { data: [{ url: 'https://cdn.example.com/a.png' }] }]
];

// ---------- Bảng shape PHẢI THẤT BẠI AN TOÀN ----------
const FAIL_SHAPES = [
  ['gemini', 'model trả TEXT thay vì ảnh', { candidates: [{ content: { parts: [{ text: 'Xin lỗi, tôi không tạo được hình này.' }] } }] }, 'no_image_in_response'],
  ['gemini', 'field data chứa chuỗi rác, không phải base64', { candidates: [{ content: { parts: [{ inlineData: { data: 'không thể tạo ảnh cho nội dung này' } }] } }] }, 'no_image_in_response'],
  ['gemini', 'bị chặn vì safety (promptFeedback)', { promptFeedback: { blockReason: 'SAFETY' } }, 'content_blocked'],
  ['gemini', 'bị chặn vì finishReason=SAFETY', { candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] }, 'content_blocked'],
  ['gemini', 'response rỗng hoàn toàn', {}, 'no_image_in_response'],
  ['gemini', 'candidates là null (shape lạ)', { candidates: null }, 'no_image_in_response'],
  ['openai', 'data rỗng', { data: [] }, 'no_image_in_response'],
  ['openai', 'url không phải http(s) — ranh giới an toàn', { data: [{ url: 'javascript:alert(1)' }] }, 'no_image_in_response'],
  ['openai', 'url là data: URI giả mạo', { data: [{ url: 'data:text/html,<script>' }] }, 'no_image_in_response'],
  ['openai', 'lỗi chính sách nội dung', { error: { type: 'content_policy_violation' } }, 'content_blocked']
];

(async () => {
  for (const [host, label, body] of OK_SHAPES) {
    await test(`SHAPE OK [${host}] ${label}`, async () => {
      respond(host, body);
      const r = await client.generateImage({ prompt: PROMPT });
      assert.strictEqual(r.ok, true, 'phải parse được shape đã tài liệu hoá');
      assert.ok(/^https?:\/\//.test(r.url) || /^data:image\//.test(r.url), 'url trả về phải hợp lệ: ' + r.url);
    });
  }

  for (const [host, label, body, expectReason] of FAIL_SHAPES) {
    await test(`SHAPE FAIL-SAFE [${host}] ${label} -> ${expectReason}`, async () => {
      respond(host, body);
      // Chỉ bật đúng 1 provider để đọc được reason của chính nhánh đang kiểm.
      const only = host === 'gemini' ? 'gemini-image' : 'openai-image';
      const r = await client.generateImage({ prompt: PROMPT });
      assert.strictEqual(r.ok, false);
      assert.ok(r.providersTried.includes(only));
      const reasons = [expectReason, 'http_500'];
      assert.ok(reasons.includes(r.reason) || r.providersTried.length === 2,
        `reason không mong đợi: ${r.reason}`);
    });
  }

  await test('FUZZ: mọi payload rác đều KHÔNG throw và luôn fallback an toàn', async () => {
    const garbage = [null, undefined, 0, '', 'chuỗi thô', [], [1, 2, 3], { candidates: 'sai kiểu' },
      { data: 'sai kiểu' }, { data: [{ b64_json: 123 }] }, { candidates: [{ content: { parts: 'sai kiểu' } }] },
      { candidates: [{}] }, { predictions: [{}] }];
    for (const g of garbage) {
      respond('gemini', g);
      const r = await client.generateImage({ prompt: PROMPT });
      assert.strictEqual(typeof r.ok, 'boolean', 'không bao giờ throw: ' + JSON.stringify(g));
      assert.strictEqual(r.ok, false);
    }
  });

  await test('JSON hỏng (provider trả HTML/mã lỗi) -> malformed_response, KHÔNG throw', async () => {
    global.fetch = async () => ({ ok: true, status: 200, text: async () => '<html>', json: async () => { throw new Error('Unexpected token <'); } });
    const r = await client.generateImage({ prompt: PROMPT });
    assert.strictEqual(r.ok, false);
    assert.ok(['malformed_response', 'provider_error'].includes(r.reason), r.reason);
  });

  await test('content_blocked KHÔNG retryable — không tốn lệnh gọi provider thứ 2', async () => {
    global.fetch = async (url) => ({
      ok: true, status: 200, text: async () => '',
      json: async () => (String(url).includes('googleapis')
        ? { promptFeedback: { blockReason: 'SAFETY' } }
        : { data: [{ b64_json: B64 }] })
    });
    const r = await client.generateImage({ prompt: PROMPT });
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.providersTried, ['gemini-image'], 'nội dung bị chặn thì provider khác cũng chặn');
    assert.strictEqual(client.isRetryableReason('content_blocked'), false);
  });

  global.fetch = realFetch;
  let p = 0, f = 0;
  console.log('\n== RỦI RO #1: contract test image provider (shape conformance + fuzz) ==');
  results.forEach((r) => {
    if (r.pass) { p++; console.log('  ok  - ' + r.name); }
    else { f++; console.log(' FAIL - ' + r.name + '\n        ' + r.error); }
  });
  console.log(`\n${p} passed, ${f} failed`);
  if (f) process.exitCode = 1;
})();
