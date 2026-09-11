'use strict';

// ============================================================================================
// PHẦN 29 — API / PROVIDER SAFETY cho image generation
// ============================================================================================
// Image provider TÁCH HẲN khỏi text provider registry (aiProviders.js/executionTargets.js):
//   - không gửi API key sai provider
//   - không gửi text request sang image endpoint (và ngược lại)
//   - không gửi unsupported parameters
//   - lỗi của image API KHÔNG BAO GIỜ được phép làm hỏng text API (mọi lỗi ở đây đều trả về
//     {ok:false}, không throw ra ngoài pipeline chính — xem visualPipeline.js)
//
// Nếu không cấu hình provider ảnh nào -> isConfigured()=false -> router tự chọn deterministic
// renderer (PHẦN 19) hoặc bỏ hình. KHÔNG có provider ảnh KHÔNG PHẢI là lỗi.

const { createLinkedAbort, makeCancelledError } = require('../abortLink');

// Khóa RIÊNG cho image generation. Cố ý KHÔNG tái dùng GEMINI_API_KEY/OPENAI_API_KEY mặc định —
// người vận hành phải bật tường minh (tránh vô tình phát sinh chi phí ảnh).
const GEMINI_IMAGE_KEY = process.env.GEMINI_IMAGE_API_KEY || '';
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
const OPENAI_IMAGE_KEY = process.env.OPENAI_IMAGE_API_KEY || '';
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const IMAGE_TIMEOUT_MS = Number(process.env.IMAGE_GENERATION_TIMEOUT_MS) || 20000;

function isConfigured() {
  return !!(GEMINI_IMAGE_KEY || OPENAI_IMAGE_KEY);
}
function activeProviderName() {
  if (GEMINI_IMAGE_KEY) return 'gemini-image';
  if (OPENAI_IMAGE_KEY) return 'openai-image';
  return null;
}

/**
 * generateImage() — sinh 1 ảnh từ prompt ĐÃ ĐƯỢC DỰNG TỪ SPEC (PHẦN 17: prompt tối thiểu).
 * KHÔNG BAO GIỜ throw: mọi lỗi trả về {ok:false, reason} để caller giữ nguyên text answer.
 *
 * @param {{prompt:string, timeoutMs?:number, signal?:AbortSignal, size?:string}} opts
 * @returns {Promise<{ok:boolean, format?:'data_url', url?:string, model?:string, reason?:string,
 *   latencyMs:number, promptChars:number}>}
 */
async function generateImage({ prompt, timeoutMs = IMAGE_TIMEOUT_MS, signal, size = '1024x1024' }) {
  const startedAt = Date.now();
  const base = { latencyMs: 0, promptChars: String(prompt || '').length };
  if (!prompt || prompt.length < 10) return { ...base, ok: false, reason: 'empty_prompt', latencyMs: 0 };
  if (!isConfigured()) return { ...base, ok: false, reason: 'no_image_provider', latencyMs: 0 };

  try {
    const result = GEMINI_IMAGE_KEY
      ? await callGeminiImage({ prompt, timeoutMs, signal })
      : await callOpenAIImage({ prompt, timeoutMs, signal, size });
    return { ...base, ...result, latencyMs: Date.now() - startedAt };
  } catch (e) {
    // Kể cả huỷ (abort) cũng KHÔNG throw lên trên — text answer không được phụ thuộc vào ảnh.
    return { ...base, ok: false, reason: (e && e.cancelled) ? 'cancelled' : 'provider_error', latencyMs: Date.now() - startedAt };
  }
}

async function callGeminiImage({ prompt, timeoutMs, signal }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent`;
  const linked = createLinkedAbort(timeoutMs, signal);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_IMAGE_KEY },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
      signal: linked.signal
    });
    if (!res.ok) return { ok: false, reason: 'http_' + res.status };
    const data = await res.json();
    const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
    const inline = parts.find((p) => p.inlineData && p.inlineData.data);
    if (!inline) return { ok: false, reason: 'no_image_in_response' };
    const mime = inline.inlineData.mimeType || 'image/png';
    return { ok: true, format: 'data_url', url: `data:${mime};base64,${inline.inlineData.data}`, model: GEMINI_IMAGE_MODEL };
  } finally {
    linked.cleanup();
  }
}

async function callOpenAIImage({ prompt, timeoutMs, signal, size }) {
  const linked = createLinkedAbort(timeoutMs, signal);
  try {
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_IMAGE_KEY}` },
      body: JSON.stringify({ model: OPENAI_IMAGE_MODEL, prompt, size, n: 1 }),
      signal: linked.signal
    });
    if (!res.ok) return { ok: false, reason: 'http_' + res.status };
    const data = await res.json();
    const item = (data.data || [])[0];
    if (!item) return { ok: false, reason: 'no_image_in_response' };
    if (item.b64_json) return { ok: true, format: 'data_url', url: `data:image/png;base64,${item.b64_json}`, model: OPENAI_IMAGE_MODEL };
    if (item.url) return { ok: true, format: 'image_url', url: item.url, model: OPENAI_IMAGE_MODEL };
    return { ok: false, reason: 'no_image_in_response' };
  } finally {
    linked.cleanup();
  }
}

module.exports = { generateImage, isConfigured, activeProviderName, IMAGE_TIMEOUT_MS };
