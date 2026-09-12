#!/usr/bin/env node
'use strict';

// ============================================================================================
// live-image-check.js — ĐÓNG rủi ro #1 khi đã có khóa ảnh THẬT
// ============================================================================================
// test/image-provider-contract.test.js kiểm parser bằng stub dựng theo shape tài liệu hoá. Script
// này làm nốt phần còn lại: gọi provider ẢNH THẬT đúng 1 lần mỗi provider, rồi ĐỐI CHIẾU shape thực
// tế với parser đang dùng trong sản phẩm. Nếu API đổi shape, script báo ra CHÍNH XÁC đường dẫn field
// tìm thấy dữ liệu ảnh để cập nhật extractGeminiInline()/callOpenAIImage().
//
// Dùng:
//   GEMINI_IMAGE_API_KEY=... OPENAI_IMAGE_API_KEY=... npm run live-image-check
//
// CẢNH BÁO: script này TỐN TIỀN THẬT (mỗi provider 1 ảnh). Cố ý KHÔNG nằm trong `npm test`.

const client = require('../server/utils/visual/imageGenerationClient');

const PROMPT = 'A clean educational schematic diagram of a plant cell cross-section, '
  + 'labelled in English, white background, flat vector style, no photorealism.';

/** Tìm MỌI đường dẫn field trông giống dữ liệu ảnh — dùng để báo shape mới khi parser trượt. */
function findImageLikePaths(obj, path = '$', out = [], depth = 0) {
  if (depth > 8 || obj === null || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    const p = `${path}.${k}`;
    if (typeof v === 'string') {
      if (/^https?:\/\/\S+\.(png|jpe?g|webp)/i.test(v)) out.push({ path: p, kind: 'url', sample: v.slice(0, 80) });
      else if (v.length > 200 && /^[A-Za-z0-9+/\r\n=]+$/.test(v.slice(0, 256))) out.push({ path: p, kind: 'base64', sample: `${v.length} ký tự` });
    } else if (Array.isArray(v)) {
      v.slice(0, 5).forEach((item, i) => findImageLikePaths(item, `${p}[${i}]`, out, depth + 1));
    } else {
      findImageLikePaths(v, p, out, depth + 1);
    }
  }
  return out;
}

async function rawGemini(key) {
  const model = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: PROMPT }] }] })
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function rawOpenAI(key) {
  const model = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, prompt: PROMPT, size: '1024x1024', n: 1 })
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function checkProvider(name, key, rawCall) {
  if (!key) { console.log(`  skip  - ${name}: chưa cấu hình khóa`); return null; }
  console.log(`\n  ${name}: đang gọi API thật…`);
  let raw;
  try { raw = await rawCall(key); }
  catch (e) { console.log(`  FAIL  - ${name}: lỗi mạng :: ${e.message}`); return false; }

  console.log(`          HTTP ${raw.status}`);
  if (raw.status >= 400) {
    console.log(`  FAIL  - ${name}: provider trả lỗi :: ${JSON.stringify(raw.body && raw.body.error || {}).slice(0, 200)}`);
    return false;
  }

  const found = findImageLikePaths(raw.body);
  if (!found.length) {
    console.log(`  FAIL  - ${name}: KHÔNG tìm thấy dữ liệu ảnh nào trong response.`);
    console.log('          Các key cấp 1: ' + Object.keys(raw.body || {}).join(', '));
    return false;
  }
  console.log('          Dữ liệu ảnh tìm thấy tại:');
  found.forEach((f) => console.log(`            ${f.path}  (${f.kind}, ${f.sample})`));

  // Đối chiếu: parser của sản phẩm có lấy được đúng ảnh đó không?
  const parsed = name === 'gemini-image'
    ? client.extractGeminiInline(raw.body)
    : (Array.isArray(raw.body.data) && raw.body.data[0]) || null;
  const ok = name === 'gemini-image'
    ? !!(parsed && client.isLikelyBase64(parsed.b64))
    : !!(parsed && (parsed.b64_json || /^https?:\/\//.test(String(parsed.url || ''))));

  if (ok) console.log(`  ok    - ${name}: parser của sản phẩm KHỚP shape thật.`);
  else {
    console.log(`  FAIL  - ${name}: parser TRƯỢT dù response CÓ ảnh — shape đã đổi.`);
    console.log('          Sửa extractGeminiInline()/callOpenAIImage() theo đường dẫn field ở trên,');
    console.log('          rồi thêm shape đó vào bảng OK_SHAPES trong test/image-provider-contract.test.js.');
  }
  return ok;
}

(async () => {
  console.log('== live-image-check: đối chiếu parser với shape API THẬT ==');
  console.log('   (tốn tiền thật: mỗi provider 1 ảnh)');

  const g = await checkProvider('gemini-image', process.env.GEMINI_IMAGE_API_KEY, rawGemini);
  const o = await checkProvider('openai-image', process.env.OPENAI_IMAGE_API_KEY, rawOpenAI);

  // Kiểm cả đường đi end-to-end qua chính hàm sản phẩm dùng.
  if (g !== null || o !== null) {
    console.log('\n  Đường end-to-end generateImage():');
    const r = await client.generateImage({ prompt: PROMPT, timeoutMs: 60000 });
    console.log(`    ok=${r.ok} reason=${r.reason || '-'} providersTried=[${(r.providersTried || []).join(', ')}] `
      + `costClass=${r.costClass || '-'} latency=${r.latencyMs}ms`);
  }

  const checked = [g, o].filter((x) => x !== null);
  if (!checked.length) {
    console.log('\nKhông có khóa ảnh nào được cấu hình — không kiểm được gì. RESULT: SKIPPED');
    process.exitCode = 0;
    return;
  }
  const failed = checked.filter((x) => x === false).length;
  console.log(`\n${checked.length - failed} provider khớp, ${failed} provider lệch. RESULT: ${failed ? 'FAIL' : 'PASS'}`);
  process.exitCode = failed ? 1 : 0;
})();
