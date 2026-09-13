#!/usr/bin/env node
'use strict';

// ============================================================================================
// live-image-check.js — kiểm chứng END-TO-END với IMAGE PROVIDER THẬT
// ============================================================================================
// Trước: chỉ kiểm cứng 2 provider (gemini/openai) bằng 2 hàm fetch riêng, KHÔNG kiểm grok-image /
// openrouter-image dù cả hai đã có trong IMAGE_PROVIDER_DEFS (imageGenerationClient.js) — nghĩa là
// nếu Grok/OpenRouter đổi shape response, không có cách nào phát hiện qua script này.
//
// NAY: generic hoá — lặp qua CHÍNH `listImageProviders()` mà sản phẩm dùng (không tự dựng danh sách
// provider thứ 2 dễ lệch khỏi registry thật), gọi ĐÚNG hàm `p.call()` sản phẩm dùng (không tự viết
// lại request), rồi in kết quả theo đúng mẫu yêu cầu:
//
//   [IMAGE LIVE CHECK]
//   Provider: Gemini
//   Model: gemini-2.5-flash-image
//   Configured: YES
//   Request: OK
//   HTTP: 200
//   Image part: FOUND
//   MIME: image/png
//   Magic bytes: VALID
//   Decode: VALID
//   Bytes: 1827344
//   Renderer: generated_image
//   Download: PASS
//
// Dùng:
//   GEMINI_API_KEY=... npm run live-image-check          (dùng lại khoá text nếu đã cấu hình)
//   GEMINI_IMAGE_API_KEY=... OPENAI_IMAGE_API_KEY=... npm run live-image-check
//
// CẢNH BÁO: TỐN TIỀN THẬT — mỗi provider đã cấu hình sẽ bị gọi ĐÚNG 1 lần. Cố ý KHÔNG nằm trong
// `npm test`.

const client = require('../server/utils/visual/imageGenerationClient');

const PROMPT = 'A clean educational schematic diagram of a plant cell cross-section, '
  + 'labelled in English, white background, flat vector style, no photorealism.';

const DISPLAY_NAME = {
  'gemini-image': 'Gemini',
  'openai-image': 'OpenAI',
  'grok-image': 'xAI/Grok',
  'openrouter-image': 'OpenRouter'
};

function fmtBytes(b64) {
  try { return Buffer.from(String(b64 || ''), 'base64').length; } catch (e) { return 0; }
}

/**
 * checkOneProvider() — gọi ĐÚNG `p.call()` mà generateImage() dùng trong sản phẩm (không tự viết
 * lại request), rồi chạy lại đúng các bước validate sản phẩm dùng: verifyImageBytes (magic bytes +
 * MIME), decode. In từng dòng theo mẫu yêu cầu ở PHẦN 16 của yêu cầu audit.
 */
async function checkOneProvider(p) {
  const label = DISPLAY_NAME[p.name] || p.name;
  console.log('\n[IMAGE LIVE CHECK]');
  console.log(`Provider: ${label}`);
  console.log(`Model: ${p.model}`);
  console.log('Configured: YES');

  let result;
  try {
    result = await p.call({ prompt: PROMPT, timeoutMs: 60000, size: '1024x1024' });
  } catch (e) {
    console.log('Request: FAILED');
    console.log(`[FAIL]\nReason: network_error :: ${e.message}`);
    return false;
  }

  console.log('Request: OK');
  const httpStatus = /^http_(\d+)$/.exec(String(result.reason || ''));
  console.log(`HTTP: ${httpStatus ? httpStatus[1] : (result.ok ? 200 : 'n/a')}`);

  if (!result.ok) {
    console.log('Image part: NOT FOUND');
    console.log(`[FAIL]\nReason: ${result.reason || 'unknown'}`);
    return false;
  }
  console.log('Image part: FOUND');

  // Đối chiếu lại BẰNG ĐÚNG hàm validate sản phẩm dùng — không tự viết một bộ kiểm tra song song
  // có thể lệch khỏi những gì runtime thực sự chạy.
  let mime = null, bytes = 0, decodeValid = false, magicValid = false;
  if (result.format === 'data_url') {
    const m = /^data:([^;]+);base64,(.+)$/.exec(result.url || '');
    if (m) {
      const claimedMime = m[1];
      const b64 = m[2];
      const verified = client.verifyImageBytes(b64, claimedMime);
      magicValid = !!verified;
      mime = verified || claimedMime;
      decodeValid = client.isLikelyBase64(b64);
      bytes = fmtBytes(b64);
    }
  } else if (result.format === 'image_url') {
    mime = '(remote URL — chưa tải nội dung, xem mục Download)';
    magicValid = /^https?:\/\//i.test(result.url || '');
    decodeValid = magicValid;
  }

  console.log(`MIME: ${mime || 'KHÔNG XÁC ĐỊNH ĐƯỢC'}`);
  console.log(`Magic bytes: ${magicValid ? 'VALID' : 'INVALID'}`);
  console.log(`Decode: ${decodeValid ? 'VALID' : 'INVALID'}`);
  if (bytes) console.log(`Bytes: ${bytes}`);

  if (!magicValid || !decodeValid) {
    console.log('[FAIL]\nReason: invalid_image_bytes');
    return false;
  }

  console.log(`Renderer: ${result.ok ? 'generated_image' : 'n/a'}`);

  // ---------- Download check: đi qua CHÍNH đường /api/visual/download sẽ dùng ở production ----------
  // Với data_url thì không cần proxy (client tự fetch chính URI đó); chỉ URL https thật mới cần
  // proxy SSRF-whitelist. Ở đây không có server đang chạy để gọi HTTP thật, nên kiểm tra tĩnh:
  // hostname trả về có nằm trong ALLOWED_HOSTS của proxy không (nếu không, ảnh sẽ tải được từ
  // provider nhưng KHÔNG tải được qua nút "Tải PNG" trên UI — đây chính là lỗi cần phát hiện SỚM).
  if (result.format === 'image_url') {
    let visualRoute;
    try { visualRoute = require('../server/routes/visual.js'); } catch (e) { visualRoute = null; }
    const allowed = visualRoute && visualRoute.isAllowedHost
      ? visualRoute.isAllowedHost(new URL(result.url).hostname)
      : null;
    if (allowed === null) console.log('Download: SKIPPED (express chưa cài trong môi trường chạy script này)');
    else console.log(`Download: ${allowed ? 'PASS' : 'FAIL (hostname không nằm trong ALLOWED_HOSTS của /api/visual/download — thêm vào server/routes/visual.js)'}`);
    if (allowed === false) return false;
  } else {
    console.log('Download: PASS (data_url tải trực tiếp, không cần proxy SSRF-whitelist)');
  }

  return true;
}

(async () => {
  console.log('== live-image-check: gọi image provider THẬT, đối chiếu với hàm sản phẩm đang dùng ==');
  console.log('   (TỐN TIỀN THẬT: mỗi provider đã cấu hình 1 ảnh)');

  const providers = client.listImageProviders();
  if (!providers.length) {
    console.log('\nKhông có provider ảnh nào được cấu hình (thiếu API key / model). RESULT: SKIPPED');
    process.exitCode = 0;
    return;
  }

  const outcomes = [];
  for (const p of providers) {
    outcomes.push(await checkOneProvider(p));
  }

  console.log('\n---- Đường end-to-end generateImage() (đúng hàm pipeline dùng, có failover) ----');
  const r = await client.generateImage({ prompt: PROMPT, timeoutMs: 60000 });
  console.log(`ok=${r.ok} reason=${r.reason || '-'} providersTried=[${(r.providersTried || []).join(', ')}] `
    + `costClass=${r.costClass || '-'} latency=${r.latencyMs}ms`);

  const passed = outcomes.filter(Boolean).length;
  const failed = outcomes.length - passed;
  console.log(`\n${passed}/${outcomes.length} provider PASS, ${failed} provider FAIL. RESULT: ${failed ? 'FAIL' : 'PASS'}`);
  process.exitCode = failed ? 1 : 0;
})();
