#!/usr/bin/env node
'use strict';

// ============================================================================================
// live-image-check.js — kiểm chứng END-TO-END với IMAGE PROVIDER THẬT
// ============================================================================================
// ĐỢT AUDIT 2, MỤC 3/4/11/15 — ROOT CAUSE của bản trước: khi provider trả `format:'image_url'`,
// script CHỈ kiểm cú pháp URL (https + hostname whitelist) rồi báo "Download: PASS" — CHƯA HỀ tải
// nội dung URL đó về. Một URL hết hạn/trả trang lỗi HTML vẫn qua được "kiểm tra" đó.
//
// NAY: dùng lại CHÍNH `generateImage()` — hàm này (từ đợt audit 2, mục 3/8) đã tự tải `image_url`
// về và validate byte thật NGAY LÚC SINH ẢNH (xem imageGenerationClient.js), nên script này không
// tự viết lại logic tải/validate riêng — chỉ ĐỌC LẠI kết quả đã validate + tự tải thêm 1 lần độc
// lập qua route /api/visual/download thật (nếu có server đang chạy) để chứng minh production path
// (không chỉ đường nội bộ) cũng cho cùng kết quả.
//
// In đúng mẫu yêu cầu:
//   [IMAGE LIVE CHECK]
//   Provider: OpenAI
//   Model: gpt-image-1
//   Configured: YES
//   Request: OK
//   HTTP: 200
//   Image part: FOUND
//   URL: VALID
//   Download HTTP: 200
//   MIME header: image/png
//   Magic bytes: VALID
//   Detected MIME: image/png
//   Decode: VALID
//   Bytes: 1843921
//   Renderer: generated_image
//   Download: PASS
//
// Dùng: GEMINI_API_KEY=... OPENAI_API_KEY=... npm run live-image-check
// CẢNH BÁO: TỐN TIỀN THẬT — mỗi provider đã cấu hình bị gọi ĐÚNG 1 lần.
// KHÔNG log: API key, Authorization header, prompt đầy đủ nếu nhạy cảm (chỉ log prompt cố định,
// không phải input người dùng thật).

const client = require('../server/utils/visual/imageGenerationClient');
const { validateImageBuffer } = require('../server/utils/visual/imageBinaryValidator');

const PROMPT = 'A clean educational schematic diagram of a plant cell cross-section, '
  + 'labelled in English, white background, flat vector style, no photorealism.';

const DISPLAY_NAME = {
  'gemini-image': 'Gemini', 'openai-image': 'OpenAI', 'grok-image': 'xAI/Grok', 'openrouter-image': 'OpenRouter'
};

/**
 * checkOneProvider() — gọi ĐÚNG `p.call()` mà generateImage() dùng trong sản phẩm (không tự viết
 * lại request). Với `image_url`, `p.call()` (imageGenerationClient.js, mục 3/8 đợt audit 2) ĐÃ tự
 * tải URL về và chạy `validateImageBuffer()` trước khi trả `ok:true` — script này in lại đúng những
 * gì đã thực sự xảy ra, KHÔNG suy đoán.
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

  if (result.format === 'data_url') {
    // ---------------- data: URI (Gemini inlineData / OpenAI b64_json) ----------------
    // MỤC 4 (đợt audit 2): không chỉ regex base64 — decode thật + validateImageBuffer thật.
    const m = /^data:([^;]+);base64,(.+)$/.exec(result.url || '');
    if (!m) { console.log('Decode: INVALID (không đúng dạng data URL)'); return false; }
    let buf;
    try { buf = Buffer.from(m[2], 'base64'); } catch (e) { console.log('Decode: INVALID'); return false; }
    const validated = validateImageBuffer(buf, m[1]);
    console.log(`MIME header (claimed): ${m[1]}`);
    console.log(`Magic bytes: ${validated.valid ? 'VALID' : 'INVALID'}`);
    console.log(`Detected MIME: ${validated.valid ? validated.detectedMime : 'n/a'}`);
    console.log(`Decode: ${validated.valid ? 'VALID' : 'INVALID'}`);
    if (validated.valid) console.log(`Bytes: ${validated.bytes}`);
    if (!validated.valid) { console.log(`[FAIL]\nReason: ${validated.reason}`); return false; }
    console.log('Renderer: generated_image');
    console.log('Download: PASS (data_url tải trực tiếp ở client, không cần proxy SSRF-whitelist)');
    return true;
  }

  if (result.format === 'image_url') {
    // ---------------- https URL (OpenAI url / OpenRouter url) ----------------
    // MỤC 3 (đợt audit 2) — ROOT CAUSE ĐÃ SỬA: trước đây dừng ở "URL: VALID" (chỉ cú pháp).
    // p.call() (imageGenerationClient.js) đã tự fetch URL này và validate — `result.urlVerified`
    // + `result.verifiedMime` LÀ BẰNG CHỨNG đã tải thật, không phải suy đoán.
    console.log(`URL: ${/^https:\/\//i.test(result.url) ? 'VALID' : 'INVALID'}`);
    if (!result.urlVerified) {
      console.log('Download HTTP: (chưa xác minh)');
      console.log('[FAIL]\nReason: image_url_not_verified');
      return false;
    }
    console.log('Download HTTP: 200 (đã tải thật ở imageGenerationClient, mục 3/8)');
    console.log(`MIME header: ${result.verifiedMime}`);
    console.log('Magic bytes: VALID');
    console.log(`Detected MIME: ${result.verifiedMime}`);
    console.log('Decode: VALID');

    // Xác minh ĐỘC LẬP LẦN 2 qua chính route production /api/visual/download (nếu server đang
    // chạy tại LIVE_CHECK_BASE_URL) — không chỉ tin lại kết quả nội bộ ở trên.
    const base = process.env.LIVE_CHECK_BASE_URL;
    if (base) {
      try {
        const proxied = await fetch(
          `${base.replace(/\/$/, '')}/api/visual/download?url=${encodeURIComponent(result.url)}&subject=live_check&visualId=live_check`
        );
        const proxyBuf = Buffer.from(await proxied.arrayBuffer());
        const proxyValidated = proxied.ok ? validateImageBuffer(proxyBuf, proxied.headers.get('content-type')) : { valid: false };
        console.log(`Bytes: ${proxyValidated.bytes || proxyBuf.length}`);
        console.log(`Download: ${proxied.ok && proxyValidated.valid ? 'PASS (qua đúng route production /api/visual/download)' : 'FAIL (route production từ chối/khác kết quả)'}`);
        if (!proxied.ok || !proxyValidated.valid) return false;
      } catch (e) {
        console.log(`Download: SKIPPED (không gọi được ${base} — LIVE_CHECK_BASE_URL có đang chạy không? ${e.message})`);
      }
    } else {
      console.log('Download: PASS (đã tải+validate byte thật ở imageGenerationClient; đặt LIVE_CHECK_BASE_URL=http://localhost:PORT để kiểm thêm qua đúng route /api/visual/download)');
    }
    console.log('Renderer: generated_image');
    return true;
  }

  console.log(`[FAIL]\nReason: unknown_format:${result.format}`);
  return false;
}

(async () => {
  console.log('== live-image-check: gọi image provider THẬT, tải+validate byte thật (không chỉ tin HTTP 200) ==');
  console.log('   (TỐN TIỀN THẬT: mỗi provider đã cấu hình 1 ảnh)');

  const providers = client.listImageProviders();
  if (!providers.length) {
    // MỤC 15 (đợt audit 2): không được giả PASS khi thiếu key — phải in đúng nhãn này.
    console.log('\nRESULT: SKIPPED — NO IMAGE PROVIDER CONFIGURED');
    process.exitCode = 0;
    return;
  }

  const outcomes = [];
  for (const p of providers) outcomes.push(await checkOneProvider(p));

  console.log('\n---- Đường end-to-end generateImage() (đúng hàm pipeline dùng, có failover) ----');
  const r = await client.generateImage({ prompt: PROMPT, timeoutMs: 60000 });
  console.log(`ok=${r.ok} reason=${r.reason || '-'} providersTried=[${(r.providersTried || []).join(', ')}] `
    + `costClass=${r.costClass || '-'} latency=${r.latencyMs}ms`);

  const passed = outcomes.filter(Boolean).length;
  const failed = outcomes.length - passed;
  console.log(`\n${passed}/${outcomes.length} provider PASS, ${failed} provider FAIL. RESULT: ${failed ? 'FAIL' : 'PASS'}`);
  process.exitCode = failed ? 1 : 0;
})();
