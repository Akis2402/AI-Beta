'use strict';

// ============================================================================================
// ADAPTER — cho phép visualPipeline.js (pipeline vẽ hình TỰ ĐỘNG trong chat) dùng đúng cỗ máy
// Gemini Imagen 3 (Primary) + OpenAI DALL-E 3 (Fallback) của Image Studio V2, thay vì hệ thống
// đa-provider gốc ở imageGenerationClient.js.
// ============================================================================================
// KHÔNG sửa visualPipeline.js/visualDecisionEngine.js/visualSpecBuilder.js/visualValidator.js —
// toàn bộ logic "KHI NÀO cần vẽ hình" (3 tầng: hard-veto/scoring/model-judge) và "vẽ ĐÚNG cái gì"
// (spec, prompt, validator, repair 1 lần, cache, cost-gate, degrade theo thời gian...) GIỮ NGUYÊN.
// File này CHỈ thay "AI NÀO thực sự gọi để sinh ra pixel", bằng cách export lại ĐÚNG 6 hàm mà
// visualPipeline.js gọi tới imageClient, với ĐÚNG shape input/output mà nó đang mong đợi — để không
// phải sửa 1 dòng nào trong pipeline hiện có, chỉ đổi đúng 1 dòng require ở đó.
//
// Cách bật: trong server/utils/visual/visualPipeline.js, đổi:
//   const imageClient = require('./imageGenerationClient');
// thành:
//   const imageClient = require('./imageGenerationClientV2Adapter');
// (xem CHANGELOG-IMAGE-STUDIO-V2-CHAT-WIRING.md để biết chính xác 1 dòng đã đổi.)

const { GEMINI_IMAGE_MODEL, OPENAI_IMAGE_MODEL, getGeminiClient, getOpenAIClient } = require('../aiClientConfig');
const { validateImageBase64 } = require('./imageBinaryValidator');
const { FALLBACK_TEST_TRIGGER } = require('./imageGenerationClientV2');
// Hàm THUẦN (không đọc khóa API, không gọi mạng) — an toàn để tái dùng nguyên trạng từ file gốc,
// tránh viết lại 2 bản logic size/cost dễ lệch nhau. Không đụng, không sửa file gốc.
const { sizeForRequest, classifyImageCost, openaiSizeFor } = require('./imageGenerationClient');

const IMAGE_TIMEOUT_MS = Number(process.env.IMAGE_GENERATION_TIMEOUT_MS) || 20000;
const GEMINI_PROMPT_CHAR_LIMIT = 2000; // Imagen 3 — hạn mức thực tế của model.
const OPENAI_PROMPT_CHAR_LIMIT = 4000; // DALL-E 3 — hạn mức thực tế của model.

/** @returns {boolean} true nếu ít nhất Primary hoặc Fallback đã có khoá. */
function isConfigured() {
  return Boolean(process.env.GEMINI_IMAGE_API_KEY) || Boolean(process.env.FALLBACK_IMAGE_API_KEY);
}

/** @returns {string|null} tên provider sẽ được thử TRƯỚC — chỉ để hiển thị/cache-key, không lộ khoá. */
function activeProviderName() {
  if (process.env.GEMINI_IMAGE_API_KEY) return 'gemini-imagen3-v2';
  if (process.env.FALLBACK_IMAGE_API_KEY) return 'openai-dalle3-v2';
  return null;
}

/** @returns {number} hạn mức ký tự prompt của provider sẽ thử trước; 0 nếu chưa cấu hình gì. */
function activePromptCharLimit() {
  if (process.env.GEMINI_IMAGE_API_KEY) return GEMINI_PROMPT_CHAR_LIMIT;
  if (process.env.FALLBACK_IMAGE_API_KEY) return OPENAI_PROMPT_CHAR_LIMIT;
  return 0;
}

/** Đua giữa promise thật với 1 timer + tôn trọng AbortSignal — SDK Gemini/OpenAI không phải lúc
 * nào cũng nhận thẳng {signal}, nên khoá thời gian ở TẦNG NÀY để không bao giờ vượt deadline. */
function withTimeout(promise, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(Object.assign(new Error('image_call_timeout'), { reason: 'http_timeout' }));
    }, Math.max(1000, timeoutMs));

    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(Object.assign(new Error('cancelled'), { reason: 'cancelled', cancelled: true }));
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    promise.then(
      (val) => { if (settled) return; settled = true; clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); resolve(val); },
      (err) => { if (settled) return; settled = true; clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); reject(err); }
    );
  });
}

/**
 * Gọi Gemini Imagen 3 (Primary) và chuẩn hoá kết quả về ĐÚNG shape mà visualPipeline.js mong đợi.
 * @returns {Promise<{ok:boolean, format?:'data_url', url?:string, model?:string, reason?:string}>}
 */
async function callGeminiPrimary({ prompt, timeoutMs, signal, aspectRatio }) {
  if (prompt.includes(FALLBACK_TEST_TRIGGER)) {
    return { ok: false, reason: 'test_backdoor_forced_failure' };
  }
  const client = getGeminiClient();
  if (!client) return { ok: false, reason: 'no_image_provider' };

  try {
    const allowedRatios = ['1:1', '3:4', '4:3', '9:16', '16:9'];
    const geminiAspect = allowedRatios.includes(aspectRatio) ? aspectRatio : '1:1';

    const response = await withTimeout(
      client.models.generateImages({
        model: GEMINI_IMAGE_MODEL,
        prompt,
        config: {
          numberOfImages: 1,
          aspectRatio: geminiAspect,
          safetyFilterLevel: 'BLOCK_MEDIUM_AND_ABOVE',
          personGeneration: 'ALLOW_ADULT'
        }
      }),
      timeoutMs,
      signal
    );

    const generated = response && Array.isArray(response.generatedImages) ? response.generatedImages : [];
    const first = generated[0];
    const b64 = first && first.image && first.image.imageBytes;
    if (!b64) return { ok: false, reason: 'no_image_in_response' };

    const validated = validateImageBase64(b64, 'image/png');
    if (!validated.valid) return { ok: false, reason: 'invalid_image_bytes' };

    return { ok: true, format: 'data_url', url: `data:${validated.detectedMime};base64,${b64}`, model: GEMINI_IMAGE_MODEL };
  } catch (e) {
    if (e && e.cancelled) return { ok: false, reason: 'cancelled' };
    if (e && e.reason === 'http_timeout') return { ok: false, reason: 'http_timeout' };
    const msg = String((e && e.message) || '');
    if (/safety|blocked|prohibited|policy/i.test(msg)) return { ok: false, reason: 'content_blocked' };
    return { ok: false, reason: 'provider_error' };
  }
}

/**
 * Gọi OpenAI DALL-E 3 (Fallback) và chuẩn hoá kết quả về ĐÚNG shape mà visualPipeline.js mong đợi.
 * @returns {Promise<{ok:boolean, format?:'data_url', url?:string, model?:string, reason?:string}>}
 */
async function callOpenAiFallback({ prompt, timeoutMs, signal, aspectRatio }) {
  const client = getOpenAIClient();
  if (!client) return { ok: false, reason: 'no_image_provider' };

  try {
    const size = openaiSizeFor(aspectRatio || '1:1');
    const response = await withTimeout(
      client.images.generate({
        model: OPENAI_IMAGE_MODEL,
        prompt,
        n: 1,
        size,
        quality: 'standard',
        response_format: 'b64_json'
      }),
      timeoutMs,
      signal
    );

    const item = response && Array.isArray(response.data) ? response.data[0] : null;
    const b64 = item && item.b64_json;
    if (!b64) return { ok: false, reason: 'no_image_in_response' };

    const validated = validateImageBase64(b64, 'image/png');
    if (!validated.valid) return { ok: false, reason: 'invalid_image_bytes' };

    return { ok: true, format: 'data_url', url: `data:${validated.detectedMime};base64,${b64}`, model: OPENAI_IMAGE_MODEL };
  } catch (e) {
    if (e && e.cancelled) return { ok: false, reason: 'cancelled' };
    if (e && e.reason === 'http_timeout') return { ok: false, reason: 'http_timeout' };
    const msg = String((e && e.message) || '');
    if (/safety|blocked|prohibited|policy|content/i.test(msg)) return { ok: false, reason: 'content_blocked' };
    return { ok: false, reason: 'provider_error' };
  }
}

/**
 * generateImage() — ĐÚNG chữ ký + ĐÚNG shape trả về mà visualPipeline.js đang gọi tới imageClient,
 * nhưng bên trong dùng cơ chế Gemini Imagen3 (Primary) -> OpenAI DALL-E3 (Fallback) của V2.
 * KHÔNG BAO GIỜ throw (bất biến #1 của pipeline).
 */
async function generateImage({ prompt, timeoutMs = IMAGE_TIMEOUT_MS, signal, size = '1024x1024', aspectRatio = '1:1', quality = 'standard', deadlineAt }) {
  const startedAt = Date.now();
  const base = { latencyMs: 0, promptChars: String(prompt || '').length, providersTried: [] };
  if (!prompt || prompt.length < 10) return { ...base, ok: false, reason: 'empty_prompt' };
  if (!isConfigured()) return { ...base, ok: false, reason: 'no_image_provider' };

  const remaining = () => (Number.isFinite(deadlineAt) ? Math.max(1000, deadlineAt - Date.now()) : timeoutMs);
  const providersTried = [];

  // ---------- Bước 1: Gemini Imagen 3 (Primary) ----------
  providersTried.push('gemini-imagen3-v2');
  let last = await callGeminiPrimary({ prompt, timeoutMs: Math.min(timeoutMs, remaining()), signal, aspectRatio });
  if (last.ok) {
    return {
      ...base, ...last, providersTried,
      costClass: classifyImageCost({ provider: 'gemini-image', size }),
      latencyMs: Date.now() - startedAt
    };
  }
  if (last.reason === 'cancelled' || last.reason === 'content_blocked') {
    return { ...base, ...last, ok: false, providersTried, latencyMs: Date.now() - startedAt };
  }
  if (remaining() < 1500) {
    return { ...base, ...last, ok: false, providersTried, latencyMs: Date.now() - startedAt };
  }

  // ---------- Bước 2: OpenAI DALL-E 3 (Fallback) ----------
  providersTried.push('openai-dalle3-v2');
  const fallback = await callOpenAiFallback({ prompt, timeoutMs: Math.min(timeoutMs, remaining()), signal, aspectRatio });
  if (fallback.ok) {
    return {
      ...base, ...fallback, providersTried,
      costClass: classifyImageCost({ provider: 'openai-image', size }),
      latencyMs: Date.now() - startedAt
    };
  }

  return { ...base, ...fallback, ok: false, providersTried, latencyMs: Date.now() - startedAt };
}

module.exports = {
  generateImage,
  isConfigured,
  activeProviderName,
  activePromptCharLimit,
  sizeForRequest,   // hàm thuần, tái dùng nguyên trạng từ imageGenerationClient.js
  classifyImageCost // hàm thuần, tái dùng nguyên trạng từ imageGenerationClient.js
};
