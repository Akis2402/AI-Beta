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

// ============================================================================================
// A4 — FAILOVER GIỮA CÁC IMAGE PROVIDER (ĐÚNG 1 LẦN, KHÔNG LOOP)
// ============================================================================================
// BUG CŨ: `GEMINI_IMAGE_KEY ? callGeminiImage(...) : callOpenAIImage(...)` — cấu hình CẢ HAI khóa
// thì chỉ Gemini được thử; Gemini lỗi 5xx là bỏ luôn, không đụng tới OpenAI dù khóa đã sẵn. Không
// nhất quán với triết lý failover đã có cho text provider (aiProviders.js).
//
// NAY: danh sách provider có CAPABILITY (B9.5 — thêm provider thứ 3 chỉ cần thêm 1 phần tử, không
// đẻ thêm nhánh if/else), thử theo thứ tự ưu tiên, và CHỈ thử provider kế tiếp khi lỗi thuộc nhóm
// RETRYABLE. Tổng số lệnh gọi luôn <= số provider đã cấu hình, KHÔNG có vòng lặp ẩn nào (SECTION D).

/** Lỗi tạm thời -> đáng thử provider khác. Lỗi input (empty_prompt...) thì KHÔNG. */
const RETRYABLE_REASONS = new Set(['provider_error', 'no_image_in_response', 'http_429', 'http_500', 'http_502', 'http_503', 'http_504']);
// 'content_blocked'/'malformed_response' CỐ Ý không nằm trong danh sách: nội dung bị chặn thì
// provider nào cũng chặn, thử tiếp chỉ tốn thêm 1 lệnh gọi.
function isRetryableReason(reason) {
  if (!reason) return false;
  if (RETRYABLE_REASONS.has(reason)) return true;
  return /^http_5\d\d$/.test(reason); // mọi 5xx đều là lỗi phía provider
}

// B9.15 — IMAGE COST POLICY. Deterministic renderer không đi qua file này nên luôn LOW (0 cost API).
const IMAGE_COST = { LOW: 'IMAGE_COST_LOW', MEDIUM: 'IMAGE_COST_MEDIUM', HIGH: 'IMAGE_COST_HIGH' };
/**
 * classifyImageCost() — phân loại chi phí 1 lệnh gọi image API theo provider + kích thước yêu cầu.
 * @param {{provider?:string, size?:string, renderer?:string}} opts
 * @returns {'IMAGE_COST_LOW'|'IMAGE_COST_MEDIUM'|'IMAGE_COST_HIGH'}
 */
function classifyImageCost({ provider, size = '1024x1024', renderer } = {}) {
  if (renderer && renderer !== 'image_generation') return IMAGE_COST.LOW; // deterministic = 0 cost API
  const pixels = (() => {
    const m = /^(\d+)x(\d+)$/.exec(String(size || ''));
    return m ? Number(m[1]) * Number(m[2]) : 1024 * 1024;
  })();
  if (provider === 'gemini-image') return pixels > 1024 * 1024 ? IMAGE_COST.MEDIUM : IMAGE_COST.LOW;
  return pixels >= 1024 * 1024 ? IMAGE_COST.HIGH : IMAGE_COST.MEDIUM;
}

/** Danh sách provider ảnh có capability — B9.5 (capability-aware router, không hard-code if/else). */
function listImageProviders() {
  const out = [];
  if (GEMINI_IMAGE_KEY) {
    out.push({
      name: 'gemini-image', model: GEMINI_IMAGE_MODEL, supportsTextToImage: true,
      maxPromptTokens: 2000, costClass: IMAGE_COST.LOW, qualityClass: 'standard', latencyClass: 'fast',
      call: (opts) => callGeminiImage(opts)
    });
  }
  if (OPENAI_IMAGE_KEY) {
    out.push({
      name: 'openai-image', model: OPENAI_IMAGE_MODEL, supportsTextToImage: true,
      maxPromptTokens: 4000, costClass: IMAGE_COST.HIGH, qualityClass: 'high', latencyClass: 'slow',
      call: (opts) => callOpenAIImage(opts)
    });
  }
  return out;
}

/**
 * activePromptCharLimit() — MỤC 2.1: hạn mức ký tự CỨNG của provider sẽ được thử ĐẦU TIÊN.
 * Lấy mức chặt nhất trong các provider đã cấu hình để prompt luôn hợp lệ kể cả khi failover sang
 * provider thứ 2 (không dựng lại prompt giữa chừng).
 * @returns {number} 0 khi chưa cấu hình provider nào.
 */
function activePromptCharLimit() {
  const providers = listImageProviders();
  if (!providers.length) return 0;
  return providers.reduce((min, p) => Math.min(min, Number(p.maxPromptTokens) || Infinity), Infinity);
}

/**
 * generateImage() — sinh 1 ảnh từ prompt ĐÃ ĐƯỢC DỰNG TỪ SPEC (PHẦN 17: prompt tối thiểu).
 * KHÔNG BAO GIỜ throw: mọi lỗi trả về {ok:false, reason} để caller giữ nguyên text answer.
 *
 * @param {{prompt:string, timeoutMs?:number, signal?:AbortSignal, size?:string}} opts
 * @returns {Promise<{ok:boolean, format?:'data_url', url?:string, model?:string, reason?:string,
 *   latencyMs:number, promptChars:number}>}
 */
async function generateImage({ prompt, timeoutMs = IMAGE_TIMEOUT_MS, signal, size = '1024x1024', deadlineAt }) {
  const startedAt = Date.now();
  const base = { latencyMs: 0, promptChars: String(prompt || '').length, providersTried: [] };
  if (!prompt || prompt.length < 10) return { ...base, ok: false, reason: 'empty_prompt', latencyMs: 0 };
  if (!isConfigured()) return { ...base, ok: false, reason: 'no_image_provider', latencyMs: 0 };

  const providers = listImageProviders();
  const providersTried = [];
  let last = { ok: false, reason: 'no_image_provider' };

  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    if (signal && signal.aborted) { last = { ok: false, reason: 'cancelled' }; break; }
    // Còn đủ thời gian trong deadline còn lại mới được thử provider kế tiếp (A4.1).
    const remaining = Number.isFinite(deadlineAt) ? deadlineAt - Date.now() : timeoutMs;
    if (i > 0 && remaining < 1500) { last = { ...last, reason: last.reason || 'visual_deadline' }; break; }
    const callTimeout = Math.max(1000, Math.min(timeoutMs, Number.isFinite(deadlineAt) ? remaining : timeoutMs));

    providersTried.push(p.name);
    try {
      last = await p.call({ prompt, timeoutMs: callTimeout, signal, size });
    } catch (e) {
      // Kể cả huỷ (abort) cũng KHÔNG throw lên trên — text answer không được phụ thuộc vào ảnh.
      last = { ok: false, reason: (e && e.cancelled) ? 'cancelled' : 'provider_error' };
    }
    if (last.ok) {
      return {
        ...base, ...last, providersTried,
        costClass: classifyImageCost({ provider: p.name, size }),
        latencyMs: Date.now() - startedAt
      };
    }
    // Lỗi input hoặc người dùng huỷ -> KHÔNG thử provider khác (A4.1: chỉ RETRYABLE mới failover).
    if (!isRetryableReason(last.reason)) break;
  }

  return { ...base, ...last, ok: false, providersTried, latencyMs: Date.now() - startedAt };
}

// ============================================================================================
// RỦI RO #1 — CHƯA KIỂM CHỨNG VỚI IMAGE PROVIDER THẬT: GIẢM THIỂU BẰNG PARSER KHOAN DUNG
// ============================================================================================
// Chưa có khóa ảnh thật để chạy end-to-end, nên điều DUY NHẤT kiểm soát được là: parser không được
// GIÒN. Mọi biến thể shape đã tài liệu hoá (và các biến thể đặt tên thường gặp giữa các version
// v1beta/v1, camelCase/snake_case) đều được chấp nhận; mọi shape LẠ đều rơi êm về
// 'no_image_in_response' (RETRYABLE -> thử provider còn lại -> cuối cùng là deterministic renderer),
// KHÔNG BAO GIỜ throw, không bao giờ coi "có response" là thành công (B9.8).
//
// Khi có khóa thật, chạy `npm run live-image-check` để đối chiếu shape thực tế với parser này.

/** Trích base64 + mime từ MỌI biến thể inline-data của Gemini đã biết. */
function extractGeminiInline(data) {
  const candidates = Array.isArray(data && data.candidates) ? data.candidates : [];
  for (const cand of candidates) {
    const content = cand && (cand.content || cand.Content);
    const parts = (content && (content.parts || content.Parts)) || [];
    for (const part of parts) {
      const inline = part && (part.inlineData || part.inline_data);
      const b64 = inline && (inline.data || inline.bytesBase64Encoded);
      if (b64) return { b64, mime: inline.mimeType || inline.mime_type || 'image/png' };
    }
  }
  // Một số bản trả thẳng ở cấp gốc (predictions[] của Vertex-style endpoint).
  const preds = Array.isArray(data && data.predictions) ? data.predictions : [];
  for (const pr of preds) {
    const b64 = pr && (pr.bytesBase64Encoded || pr.b64_json);
    if (b64) return { b64, mime: pr.mimeType || 'image/png' };
  }
  return null;
}

/** Lý do model TỪ CHỐI (safety/recitation) — KHÔNG retryable, thử provider khác cũng bị chặn y hệt. */
function geminiBlockReason(data) {
  const fb = data && (data.promptFeedback || data.prompt_feedback);
  const blocked = fb && (fb.blockReason || fb.block_reason);
  if (blocked) return 'content_blocked';
  const finish = (((data && data.candidates) || [])[0] || {}).finishReason;
  if (finish && /SAFETY|RECITATION|BLOCK|PROHIBITED/i.test(String(finish))) return 'content_blocked';
  return null;
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
    let data;
    try { data = await res.json(); } catch (e) { return { ok: false, reason: 'malformed_response' }; }
    const blocked = geminiBlockReason(data);
    if (blocked) return { ok: false, reason: blocked };
    const inline = extractGeminiInline(data);
    // Model trả TEXT thay vì ảnh -> đây là FAILURE, không phải thành công (B9.8).
    if (!inline || !isLikelyBase64(inline.b64)) return { ok: false, reason: 'no_image_in_response' };
    return { ok: true, format: 'data_url', url: `data:${inline.mime};base64,${inline.b64}`, model: GEMINI_IMAGE_MODEL };
  } finally {
    linked.cleanup();
  }
}

/** Chặn trường hợp provider trả chuỗi rác/thông báo lỗi vào đúng field đáng lẽ chứa ảnh. */
function isLikelyBase64(s) {
  // Độ dài KHÔNG phải tiêu chí phân biệt (fixture test dùng chuỗi rất ngắn, ảnh thật thì rất dài);
  // thứ phân biệt là BẢNG KÝ TỰ: prose trả nhầm vào field ảnh luôn có khoảng trắng/dấu tiếng Việt.
  if (typeof s !== 'string' || s.length < 4) return false;
  return /^[A-Za-z0-9+/\r\n=]+$/.test(s.slice(0, 512));
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
    let data;
    try { data = await res.json(); } catch (e) { return { ok: false, reason: 'malformed_response' }; }
    // Bị từ chối vì nội dung -> không retryable (provider khác cũng chặn tương tự).
    if (data && data.error && /safety|policy|content/i.test(String(data.error.type || data.error.code || ''))) {
      return { ok: false, reason: 'content_blocked' };
    }
    const item = (Array.isArray(data && data.data) ? data.data : [])[0];
    if (!item) return { ok: false, reason: 'no_image_in_response' };
    const b64 = item.b64_json || item.b64Json;
    if (b64 && isLikelyBase64(b64)) {
      const mime = item.output_format ? `image/${item.output_format}` : 'image/png';
      return { ok: true, format: 'data_url', url: `data:${mime};base64,${b64}`, model: OPENAI_IMAGE_MODEL };
    }
    // URL phải là http(s) thật — không nhận data:/javascript:/chuỗi rác (ranh giới an toàn).
    if (typeof item.url === 'string' && /^https?:\/\//i.test(item.url)) {
      return { ok: true, format: 'image_url', url: item.url, model: OPENAI_IMAGE_MODEL };
    }
    return { ok: false, reason: 'no_image_in_response' };
  } finally {
    linked.cleanup();
  }
}

module.exports = {
  generateImage, isConfigured, activeProviderName, IMAGE_TIMEOUT_MS,
  listImageProviders, classifyImageCost, isRetryableReason, IMAGE_COST, activePromptCharLimit,
  extractGeminiInline, geminiBlockReason, isLikelyBase64
};
