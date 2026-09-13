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

// ============================================================================================
// MỤC 2.1 + 2.1a — REGISTRY PROVIDER ẢNH THEO CAPABILITY, KHÓA KẾ THỪA TỪ PROVIDER TEXT
// ============================================================================================
// ROOT CAUSE A (đã xác nhận): bản cũ chỉ đọc GEMINI_IMAGE_API_KEY/OPENAI_IMAGE_API_KEY và CỐ Ý
// không tái dùng khóa text. Ý định ban đầu ("tránh vô tình phát sinh chi phí ảnh") là hợp lý về
// mặt chi phí nhưng SAI về mặt sản phẩm: người dùng đã cắm GEMINI_API_KEY cho text, thấy hệ thống
// nói "cần hình minh họa", rồi nhận đúng một dòng "Không thể tạo hình minh họa" mà KHÔNG có bất kỳ
// gợi ý nào rằng họ phải khai báo thêm một biến môi trường thứ hai. isConfigured() trả false ->
// chooseVisualRenderer() không bao giờ chọn 'image_generation' -> cả hệ thống chỉ còn SVG.
//
// KIẾN TRÚC MỚI:
//   - Mỗi provider ảnh là MỘT PHẦN TỬ trong IMAGE_PROVIDER_DEFS (giữ đúng nguyên tắc B9.5: thêm
//     provider thứ N chỉ cần thêm 1 phần tử, không đẻ nhánh if/else).
//   - Khóa được phân giải theo thứ tự: <PROVIDER>_IMAGE_API_KEY (override riêng cho ảnh) ->
//     khóa TEXT của chính provider đó. Không cần khai báo thêm biến nào nếu khóa text đã đủ quyền.
//   - Thứ tự thử KẾ THỪA thứ tự ưu tiên của provider TEXT, để hành vi rotation của ảnh nhất quán
//     với text. Có thể override bằng IMAGE_PROVIDER_ORDER.
//   - CHỈ provider THẬT SỰ có API sinh ảnh công khai mới được đưa vào registry. Anthropic/DeepSeek/
//     Mistral/Groq hiện KHÔNG có endpoint text-to-image — tuyệt đối không ép chúng vào danh sách chỉ
//     vì chúng có khóa text, vì như vậy là gọi vào endpoint không tồn tại và tiêu một lượt failover
//     vô ích.
//
// ĐỌC ENV TẠI THỜI ĐIỂM GỌI, không cache vào const lúc require: test và môi trường serverless đều
// có thể đổi process.env sau khi module đã được nạp (bản cũ cache nên không test được).

const IMAGE_TIMEOUT_MS = Number(process.env.IMAGE_GENERATION_TIMEOUT_MS) || 20000;

/** Khóa text có thể là danh sách nhiều khóa ngăn cách bằng dấu phẩy (xem parseMultiEnv). Lấy khóa đầu. */
function firstKeyOf(raw) {
  return String(raw || '').split(',').map((k) => k.trim()).filter(Boolean)[0] || '';
}

/**
 * Phân giải khóa cho một provider ảnh.
 * @returns {{key:string, source:'image_specific'|'text_reuse'|null}}
 */
function resolveImageKey(def) {
  const own = firstKeyOf(process.env[def.imageKeyEnv]);
  if (own) return { key: own, source: 'image_specific' };
  for (const env of def.textKeyEnvs || []) {
    const shared = firstKeyOf(process.env[env]);
    if (shared) return { key: shared, source: 'text_reuse' };
  }
  return { key: '', source: null };
}

// ---------- REGISTRY ----------
// `order` = vị trí trong thứ tự ưu tiên provider TEXT của repo (xem server/config/extraProviders.js
// và server/utils/executionTargets.js): Gemini và OpenAI là provider gốc, Grok/xAI và OpenRouter
// đến từ EXTRA_PROVIDERS theo đúng thứ tự khai báo ở đó.
const IMAGE_PROVIDER_DEFS = [
  {
    name: 'gemini-image', order: 10,
    imageKeyEnv: 'GEMINI_IMAGE_API_KEY', textKeyEnvs: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    modelEnv: 'GEMINI_IMAGE_MODEL', defaultModel: 'gemini-2.5-flash-image',
    maxPromptTokens: 2000, costClass: 'IMAGE_COST_LOW', qualityClass: 'standard', latencyClass: 'fast',
    call: (opts) => callGeminiImage(opts)
  },
  {
    name: 'openai-image', order: 20,
    imageKeyEnv: 'OPENAI_IMAGE_API_KEY', textKeyEnvs: ['OPENAI_API_KEY'],
    modelEnv: 'OPENAI_IMAGE_MODEL', defaultModel: 'gpt-image-1',
    maxPromptTokens: 4000, costClass: 'IMAGE_COST_HIGH', qualityClass: 'high', latencyClass: 'slow',
    call: (opts) => callOpenAICompatibleImage(opts, 'https://api.openai.com/v1/images/generations')
  },
  {
    // xAI phục vụ sinh ảnh qua endpoint TƯƠNG THÍCH OpenAI (/v1/images/generations) nên dùng chung
    // adapter — không nhân bản code parse cho từng hãng.
    name: 'grok-image', order: 30,
    imageKeyEnv: 'GROK_IMAGE_API_KEY', textKeyEnvs: ['GROK_API_KEY', 'XAI_API_KEY'],
    modelEnv: 'GROK_IMAGE_MODEL', defaultModel: 'grok-2-image-1212',
    maxPromptTokens: 2000, costClass: 'IMAGE_COST_MEDIUM', qualityClass: 'standard', latencyClass: 'fast',
    call: (opts) => callOpenAICompatibleImage(opts, 'https://api.x.ai/v1/images/generations')
  },
  {
    // OpenRouter chỉ PROXY tới model của hãng khác: không có model ảnh mặc định nào đúng cho mọi tài
    // khoản. Vì vậy provider này CHỈ được bật khi người vận hành chỉ định tường minh model ảnh —
    // `requiresExplicitModel`. Bật mù sẽ gửi request tới một model không tồn tại và đốt một lượt
    // failover.
    name: 'openrouter-image', order: 40, requiresExplicitModel: true,
    imageKeyEnv: 'OPENROUTER_IMAGE_API_KEY', textKeyEnvs: ['OPENROUTER_API_KEY'],
    modelEnv: 'OPENROUTER_IMAGE_MODEL', defaultModel: '',
    maxPromptTokens: 4000, costClass: 'IMAGE_COST_MEDIUM', qualityClass: 'standard', latencyClass: 'slow',
    call: (opts) => callOpenAICompatibleImage(opts, 'https://openrouter.ai/api/v1/images/generations')
  }
];

/** Thứ tự thử ảnh. Mặc định kế thừa thứ tự provider text; IMAGE_PROVIDER_ORDER ghi đè nếu cần. */
function providerOrderOverride() {
  return String(process.env.IMAGE_PROVIDER_ORDER || '')
    .split(',').map((x) => x.trim()).filter(Boolean);
}

function isConfigured() {
  return listImageProviders().length > 0;
}

/** Tên provider ảnh sẽ được thử ĐẦU TIÊN. CHỈ trả về TÊN — không bao giờ lộ khóa (mục 2.8). */
function activeProviderName() {
  const list = listImageProviders();
  return list.length ? list[0].name : null;
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

// Phân biệt 2 LOẠI lỗi khác bản chất:
// (a) Lỗi NỘI DUNG prompt (content) — dùng CHUNG cho mọi provider vì prompt giống nhau, provider
//     nào cũng sẽ chặn/huỷ y hệt -> KHÔNG đáng thử tiếp, chỉ tốn thêm 1 lệnh gọi vô ích.
// (b) Lỗi CẤU HÌNH/KỸ THUẬT của RIÊNG 1 provider (auth sai, model ID sai, schema request sai,
//     JSON trả về dị dạng...) — KHÔNG dùng chung: mỗi provider có key/model/endpoint/cơ chế xác
//     thực khác nhau, lỗi ở Gemini không nói lên gì về OpenAI -> LUÔN đáng thử provider kế tiếp.
// BUG CŨ (đã sửa): coi mọi 4xx (trừ 429) là "lỗi input dùng chung" — SAI, vì phần lớn 4xx thực tế
// (400 sai tên model, 401/403 quyền/billing/region, 404 sai endpoint) là lỗi (b), riêng của 1
// provider. Vì vậy nay dùng DENYLIST: chỉ liệt kê đúng 2 case (a)/"không nên tiếp tục" là KHÔNG
// retryable; MỌI lý do khác đều retryable.
const NON_RETRYABLE_REASONS = new Set([
  'content_blocked', // (a) lỗi nội dung dùng chung — provider nào cũng chặn y hệt
  'cancelled'         // người dùng huỷ / hết hạn mức thời gian — không nên tiếp tục gọi thêm
]);
function isRetryableReason(reason) {
  if (!reason) return false;
  return !NON_RETRYABLE_REASONS.has(reason);
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

/**
 * listImageProviders() — provider ảnh KHẢ DỤNG, đã sắp theo thứ tự ưu tiên.
 * Một provider chỉ vào danh sách khi: (a) phân giải được khóa, và (b) xác định được model.
 * @returns {Array<object>}
 */
function listImageProviders() {
  // Công tắc TẮT HẲN: cần thiết vì khóa ảnh nay kế thừa khóa text, nên người vận hành phải có một
  // cách tường minh để nói "tôi có khóa text nhưng KHÔNG muốn tiêu tiền sinh ảnh".
  if (/^(0|false|off|no)$/i.test(String(process.env.IMAGE_GENERATION_ENABLED || '').trim())) return [];
  const override = providerOrderOverride();
  const out = [];
  for (const def of IMAGE_PROVIDER_DEFS) {
    const { key, source } = resolveImageKey(def);
    if (!key) continue;
    const model = String(process.env[def.modelEnv] || def.defaultModel || '').trim();
    if (!model) continue; // vd OpenRouter chưa chỉ định model ảnh -> không bật (requiresExplicitModel)
    out.push({
      name: def.name,
      model,
      apiKey: key,            // DÙNG NỘI BỘ. Không bao giờ đi vào log/telemetry/response (mục 2.8).
      keySource: source,      // 'image_specific' | 'text_reuse' — chỉ để quan sát, không chứa khóa.
      supportsTextToImage: true,
      maxPromptTokens: def.maxPromptTokens,
      costClass: def.costClass,
      qualityClass: def.qualityClass,
      latencyClass: def.latencyClass,
      order: def.order,
      call: (opts) => def.call({ ...opts, apiKey: key, model })
    });
  }
  if (override.length) {
    // Thứ tự do người vận hành chỉ định thắng; provider không được nêu tên vẫn giữ ở cuối theo
    // thứ tự kế thừa từ text (không âm thầm loại bỏ provider đã cấu hình).
    out.sort((a, b) => {
      const ia = override.indexOf(a.name);
      const ib = override.indexOf(b.name);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      return a.order - b.order;
    });
  } else {
    out.sort((a, b) => a.order - b.order);
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

async function callGeminiImage({ prompt, timeoutMs, signal, apiKey, model }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const linked = createLinkedAbort(timeoutMs, signal);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
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
    return { ok: true, format: 'data_url', url: `data:${inline.mime};base64,${inline.b64}`, model };
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

/**
 * Adapter DÙNG CHUNG cho mọi provider nói giao thức /v1/images/generations của OpenAI
 * (OpenAI, xAI/Grok, OpenRouter). Mục 2.1a điểm 7: thêm provider mới chỉ cần trỏ vào endpoint của
 * nó, KHÔNG đụng vào code của provider khác.
 * @param {object} opts {prompt, timeoutMs, signal, size, apiKey, model}
 * @param {string} endpoint URL đầy đủ của endpoint images/generations
 */
async function callOpenAICompatibleImage({ prompt, timeoutMs, signal, size, apiKey, model }, endpoint) {
  const linked = createLinkedAbort(timeoutMs, signal);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, prompt, size, n: 1 }),
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
      return { ok: true, format: 'data_url', url: `data:${mime};base64,${b64}`, model };
    }
    // URL phải là http(s) thật — không nhận data:/javascript:/chuỗi rác (ranh giới an toàn).
    if (typeof item.url === 'string' && /^https?:\/\//i.test(item.url)) {
      return { ok: true, format: 'image_url', url: item.url, model };
    }
    return { ok: false, reason: 'no_image_in_response' };
  } finally {
    linked.cleanup();
  }
}

/** Giữ tên cũ cho mọi call-site/test hiện có — nay chỉ là alias trỏ vào endpoint OpenAI. */
function callOpenAIImage(opts) {
  return callOpenAICompatibleImage(opts, 'https://api.openai.com/v1/images/generations');
}

module.exports = {
  generateImage, isConfigured, activeProviderName, IMAGE_TIMEOUT_MS,
  listImageProviders, classifyImageCost, isRetryableReason, IMAGE_COST, activePromptCharLimit,
  extractGeminiInline, geminiBlockReason, isLikelyBase64,
  // Mục 2.1a: registry mở rộng + phân giải khóa — export để test kiểm chứng trực tiếp.
  IMAGE_PROVIDER_DEFS, resolveImageKey, callOpenAICompatibleImage, callOpenAIImage, callGeminiImage
};
