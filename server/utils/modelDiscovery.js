'use strict';

// ---------- Model Discovery: nguồn DUY NHẤT sự thật về "model nào thực sự tồn tại" ----------
// Mục tiêu (xem yêu cầu gốc, mục 2-12, 24, 27): người dùng chỉ cần API key, KHÔNG cần nhập model.
// Module này chịu trách nhiệm: gọi API liệt kê model THẬT của từng hãng, chuẩn hoá kết quả, chọn
// model "mạnh" (chất lượng) và model "nhanh" (fast) theo capability của request, cache kết quả để
// không gọi API discovery mỗi request, và KHÔNG BAO GIỜ coi 1 tên model đoán mò/hard-code là "đã xác
// nhận tồn tại" — mọi ExecutionTarget chỉ được tạo từ model đã đi qua discovery (hoặc explicit
// legacy override do người dùng tự khai trong .env — xem executionTargets.js).
//
// aiProviders.js gọi ensureProvidersReady() (orchestration) trước khi build execution target;
// executionTargets.js chỉ ĐỌC cache qua getCachedModels() (đồng bộ, không gọi mạng) — tách trách
// nhiệm đúng kiến trúc hiện có (client biết API riêng hãng, discovery biết cách liệt kê model,
// executionTargets chỉ lắp ráp target).

const TTL_MS = (() => {
  const n = Number(process.env.MODEL_DISCOVERY_TTL_MS);
  return Number.isFinite(n) && n >= 0 ? n : 15 * 60 * 1000;
})();
const DISCOVERY_TIMEOUT_MS = (() => {
  const n = Number(process.env.MODEL_DISCOVERY_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 8000;
})();

// ---------- Cache in-memory: provider + hash(API key) -> {models, discoveredAt, expiresAt, lastError} ----------
// KHÔNG bao giờ lưu plaintext API key làm cache key hay trong log — chỉ lưu 1 hash ngắn, một chiều,
// đủ để phân biệt các khoá khác nhau của cùng 1 provider (mục 8).
const CACHE = new Map();

function hashKey(raw) {
  const s = String(raw || '');
  let h1 = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h1 ^= s.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193);
  }
  return (h1 >>> 0).toString(36) + ':' + s.length;
}

function cacheKey(provider, apiKey) {
  return `${provider}::${hashKey(apiKey)}`;
}

/**
 * Đọc cache ĐỒNG BỘ (không gọi mạng) — dùng bởi executionTargets.js khi build target.
 * Trả entry kể cả khi đã hết hạn (stale-while-revalidate: có dữ liệu cũ còn hơn không có gì trong
 * lúc chờ warmDiscovery() làm mới ở lượt request sau — mục 8/9: discovery lỗi không được làm sập
 * toàn bộ request, dùng cache cũ nếu còn).
 * @returns {{models:Array, qualityModelIds:Array<string>, fastModelIds:Array<string>,
 *   capsById:Object, discoveredAt:number, expiresAt:number, lastError?:string, stale:boolean}|null}
 */
function getCachedModels(provider, apiKey) {
  const entry = CACHE.get(cacheKey(provider, apiKey));
  if (!entry) return null;
  return { ...entry, stale: Date.now() > entry.expiresAt };
}

function isFresh(provider, apiKey) {
  const entry = CACHE.get(cacheKey(provider, apiKey));
  return !!entry && Date.now() <= entry.expiresAt;
}

function invalidateModelCache(provider, apiKey) {
  CACHE.delete(cacheKey(provider, apiKey));
}

// ---------- L2 cache backend (tùy chọn) — điểm mở rộng để sau này cắm Redis/Vercel KV ----------
// Mặc định KHÔNG có L2 (mọi thứ chỉ chạy qua CACHE in-memory L1 ở trên — mỗi instance/lambda cold
// start tự discovery lại, chấp nhận được vì có TTL + single-flight). Khi cần chia sẻ cache GIỮA
// NHIỀU serverless instance (Vercel) hoặc tồn tại qua cold start, cắm 1 backend qua
// `configureL2CacheBackend({ get(key), set(key, entry, ttlMs) })` — get/set nhận đúng `entry` đã
// serialize được (JSON-safe, không chứa hàm) — modelDiscovery.js là NƠI DUY NHẤT biết cấu trúc entry,
// KHÔNG cần sửa executionTargets.js/aiProviders.js/routes/* khi đổi backend (đúng yêu cầu tách kiến
// trúc). L1 (CACHE Map) LUÔN là nguồn đọc ĐỒNG BỘ cho executionTargets.js — L2 chỉ dùng để HYDRATE
// L1 khi L1 miss (cold start), qua warmDiscovery() ở dưới, không thay thế vai trò đọc đồng bộ của L1.
let l2Backend = null;
function configureL2CacheBackend(backend) {
  l2Backend = backend && typeof backend.get === 'function' && typeof backend.set === 'function' ? backend : null;
}
async function l2Get(key) {
  if (!l2Backend) return null;
  try { return await l2Backend.get(key); } catch (e) { return null; } // L2 lỗi không được làm hỏng discovery (giống mọi lỗi discovery khác)
}
async function l2Set(key, entry) {
  if (!l2Backend) return;
  try { await l2Backend.set(key, entry, TTL_MS); } catch (e) { /* fire-and-forget — không throw, không chặn request */ }
}

/** Đánh dấu 1 model cụ thể là lỗi (404/deprecated/unsupported ở runtime thật, mục 21) — loại khỏi
 * danh sách được chọn ngay lập tức mà KHÔNG cần đợi hết TTL, rồi để lượt request sau tự discovery lại. */
function markModelInvalid(provider, apiKey, modelId) {
  const key = cacheKey(provider, apiKey);
  const entry = CACHE.get(key);
  if (!entry) return;
  entry.qualityModelIds = (entry.qualityModelIds || []).filter((m) => m !== modelId);
  entry.fastModelIds = (entry.fastModelIds || []).filter((m) => m !== modelId);
  entry.models = (entry.models || []).filter((m) => m.id !== modelId);
  // Hết hạn ngay để lượt sau ensureProvidersReady() bắt buộc discovery lại thay vì dùng bản đã lọc
  // (bản đã lọc chỉ dùng NGAY LẦN NÀY để failover tức thời, xem aiProviders.js retryAfterInvalidModel).
  entry.expiresAt = 0;
}

function setCache(provider, apiKey, { models, qualityModelIds, fastModelIds, capsById, lastError }) {
  const entry = {
    models: models || [],
    qualityModelIds: qualityModelIds || [],
    fastModelIds: fastModelIds || [],
    capsById: capsById || {},
    discoveredAt: Date.now(),
    expiresAt: Date.now() + TTL_MS,
    lastError: lastError ? String(lastError.message || lastError).slice(0, 300) : undefined
  };
  CACHE.set(cacheKey(provider, apiKey), entry);
  // Write-through L2 (nếu có cấu hình) — fire-and-forget, không chặn request, không throw ra ngoài
  // (mục 2: nguồn sự thật vẫn là L1 đồng bộ; L2 chỉ giúp instance/lambda KHÁC hoặc sau cold start đỡ
  // phải discovery lại từ đầu).
  l2Set(cacheKey(provider, apiKey), entry);
  return entry;
}

// ---------- Bộ lọc loại model KHÔNG phù hợp cho chat (mục 5.9) ----------
// embedding/audio/image-generation/moderation/rerank/tts... — model những loại này KHÔNG nhận
// messages dạng chat, gọi vào sẽ luôn lỗi 400. Loại thẳng khỏi ứng viên trước khi chấm điểm.
const NON_CHAT_MODEL_RE = /(embed|whisper|tts|speech|audio|moderation|rerank|dall-e|dalle|image-gen|imagen|stable-diffusion|clip|codex-mini|text-moderation|omni-moderation)/i;
const DEPRECATED_HINT_RE = /(deprecated|legacy|old|-preview-\d{4}|instruct$)/i;

function isChatEligible(id) {
  return !!id && !NON_CHAT_MODEL_RE.test(id);
}

async function fetchJson(url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    const bodyText = await res.text();
    let json = null;
    try { json = bodyText ? JSON.parse(bodyText) : null; } catch (e) { /* không phải JSON — bỏ qua */ }
    if (!res.ok) {
      const err = new Error(`Model discovery HTTP ${res.status}` + (json && json.error && json.error.message ? `: ${json.error.message}` : ''));
      err.status = res.status;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Adapter: Anthropic ----------
// GET /v1/models — https://docs.anthropic.com/en/api/models-list
// FIX P1/D (audit): /v1/models KHÔNG trả field capability "extended thinking" tường minh — TRƯỚC
// ĐÂY mọi model Claude bị đánh dấu supportsReasoning:true, kể cả các dòng KHÔNG hỗ trợ extended
// thinking (vd claude-3-haiku/opus/sonnet bản gốc, claude-3-5-*) => anthropicClient.js có thể gửi
// `thinking:{enabled}` cho model không hỗ trợ và bị Anthropic trả 400. Cô lập heuristic (tên model)
// vào 1 regex duy nhất, dễ audit/cập nhật: chỉ Claude 3.7+ và dòng Claude 4 (opus-4/sonnet-4/
// haiku-4.x) mới hỗ trợ extended thinking — mặc định false cho model không khớp (conservative).
const ANTHROPIC_REASONING_CAPABLE_RE = /(claude-)?(3-7-sonnet|opus-4|sonnet-4|haiku-4(\.\d+)?)/i;

async function discoverAnthropicModels(apiKey) {
  const data = await fetchJson('https://api.anthropic.com/v1/models?limit=100', {
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
  });
  const list = (data && data.data) || [];
  return list
    .filter((m) => isChatEligible(m.id))
    .map((m) => {
      const id = m.id;
      const isHaiku = /haiku/i.test(id);
      const isOpus = /opus/i.test(id);
      return {
        id,
        displayName: m.display_name || id,
        provider: 'anthropic',
        inputCapabilities: { text: true, vision: true },
        outputCapabilities: { text: true },
        supportsStreaming: true,
        supportsTools: true,
        supportsReasoning: ANTHROPIC_REASONING_CAPABLE_RE.test(id),
        supportsWebSearch: true,
        contextWindow: m.context_window || null,
        // A2: trần output THẬT của model — /v1/models của Anthropic chưa trả field này ở mọi bản,
        // nên đọc có điều kiện; thiếu -> null -> reasoningPolicy giữ DEFAULT_MAX_REASONING (A2.4).
        maxOutputTokens: Number(m.max_output_tokens || m.max_tokens) || null,
        qualityScore: isOpus ? 95 : (isHaiku ? 60 : 80),
        speedScore: isHaiku ? 95 : (isOpus ? 40 : 65),
        raw: { created_at: m.created_at }
      };
    });
}

// ---------- Adapter: OpenAI ----------
// GET /v1/models — https://platform.openai.com/docs/api-reference/models/list
async function discoverOpenAIModels(apiKey) {
  const data = await fetchJson('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  const list = (data && data.data) || [];
  return list
    .filter((m) => isChatEligible(m.id) && /^(gpt-|o[0-9]|chatgpt)/i.test(m.id) && !/instruct/i.test(m.id))
    .map((m) => {
      const id = m.id;
      const isMini = /mini|nano/i.test(id);
      // FIX P1/D (audit): /v1/models của OpenAI KHÔNG trả field capability "reasoning" tường minh —
      // đây là heuristic DUY NHẤT, cô lập ở 1 dòng regex để dễ audit/cập nhật. Độ tin cậy: CAO cho
      // dòng "o<số>" (o1/o3/o4...) và "gpt-5" — đây là quy ước đặt tên chính thức OpenAI dùng riêng
      // cho model reasoning, không trùng với dòng non-reasoning (gpt-4o, gpt-4-turbo, gpt-3.5...).
      // Mặc định false (conservative) cho MỌI id không khớp — tránh gửi `reasoning.effort` (payload
      // OpenAI từ chối) cho model không hỗ trợ chỉ vì đoán nhầm theo tên.
      const isReasoning = /^o[0-9]|gpt-5/i.test(id);
      return {
        id,
        displayName: id,
        provider: 'openai',
        inputCapabilities: { text: true, vision: !/^gpt-3\.5/i.test(id) },
        outputCapabilities: { text: true },
        supportsStreaming: true,
        supportsTools: true,
        supportsReasoning: isReasoning,
        supportsWebSearch: true,
        contextWindow: null,
        // A2: /v1/models của OpenAI không trả giới hạn output -> null (không đoán mò theo tên model).
        maxOutputTokens: null,
        qualityScore: isMini ? 60 : (isReasoning ? 90 : 80),
        speedScore: isMini ? 90 : 55,
        raw: { owned_by: m.owned_by }
      };
    });
}

// ---------- Adapter: Gemini ----------
// GET /v1beta/models — https://ai.google.dev/api/models#method:-models.list
// FIX P1/D (audit): KHÔNG còn hard-code supportsReasoning:true cho MỌI model Gemini — Google chưa
// trả field capability "thinking" tường minh qua /v1beta/models, nên phải dùng heuristic dựa trên
// tên model (cô lập trong 1 regex duy nhất, dễ audit/cập nhật khi Google ra thế hệ mới). Chỉ dòng
// "thinking" thực sự hỗ trợ thinkingConfig (2.5+/3.x) mới được đánh dấu true; các dòng cũ hơn
// (1.0/1.5, hoặc bất kỳ id nào không khớp) mặc định false — conservative, tránh gửi thinkingConfig
// mù cho model không hỗ trợ (geminiClient.resolveGeminiThinkingConfig() dựa vào đúng cờ này).
const GEMINI_REASONING_CAPABLE_RE = /gemini-(2\.5|3(\.\d+)?)/i;

async function discoverGeminiModels(apiKey) {
  // FIX P1/E (audit): API key qua header x-goog-api-key thay vì query string ?key=... — không còn
  // lộ khóa trong URL (log proxy/CDN trung gian, v.v.) — áp dụng nhất quán với geminiClient.js.
  const data = await fetchJson('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
    headers: { 'x-goog-api-key': apiKey }
  });
  const list = (data && data.models) || [];
  return list
    .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
    .map((m) => {
      const id = String(m.name || '').replace(/^models\//, '');
      if (!isChatEligible(id)) return null;
      const isLite = /lite|flash-8b/i.test(id);
      const isPro = /pro/i.test(id);
      return {
        id,
        displayName: m.displayName || id,
        provider: 'gemini',
        inputCapabilities: { text: true, vision: true },
        outputCapabilities: { text: true },
        supportsStreaming: true,
        supportsTools: true,
        supportsReasoning: GEMINI_REASONING_CAPABLE_RE.test(id),
        supportsWebSearch: true,
        contextWindow: m.inputTokenLimit || null,
        // A2: Gemini /v1beta/models trả outputTokenLimit tường minh — dùng thẳng, không đoán.
        maxOutputTokens: Number(m.outputTokenLimit) || null,
        qualityScore: isPro ? 90 : (isLite ? 55 : 75),
        speedScore: isLite ? 95 : (isPro ? 45 : 70),
        raw: {}
      };
    })
    .filter(Boolean);
}

// ---------- Adapter: OpenAI-compatible provider bổ sung (Grok/DeepSeek/Mistral/Groq/OpenRouter...) ----------
// Không phải hãng nào cũng có endpoint /models tương thích — nếu thất bại (404/timeout/không phải
// JSON hợp lệ), trả về null (KHÔNG throw) để caller biết "provider này không hỗ trợ discovery" và
// áp dụng chiến lược fallback rõ ràng (mục 13) thay vì coi lỗi mạng là "không có model nào".
function deriveModelsURL(cfg) {
  if (cfg.discoveryURL) return cfg.discoveryURL;
  try {
    const u = new URL(cfg.baseURL);
    // .../v1/chat/completions -> .../v1/models (chuẩn phổ biến của mọi hãng OpenAI-compatible)
    u.pathname = u.pathname.replace(/\/chat\/completions\/?$/, '/models');
    return u.toString();
  } catch (e) {
    return null;
  }
}

async function discoverOpenAICompatibleModels(cfg, apiKey) {
  const url = deriveModelsURL(cfg);
  if (!url) return null;
  let data;
  try {
    data = await fetchJson(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  } catch (e) {
    return null; // hãng này không hỗ trợ discovery (hoặc key/endpoint không đúng) — không phải lỗi fatal
  }
  const list = (data && (data.data || data.models)) || [];
  if (!Array.isArray(list) || !list.length) return null;
  return list
    .map((m) => (typeof m === 'string' ? m : (m.id || m.name)))
    .filter(isChatEligible)
    .map((id) => ({
      id,
      displayName: id,
      provider: cfg.key,
      inputCapabilities: { text: true, vision: !!cfg.supportsVision },
      outputCapabilities: { text: true },
      supportsStreaming: true,
      supportsTools: true,
      supportsReasoning: !!cfg.supportsThinking,
      maxOutputTokens: Number(cfg.maxOutputTokens) || null,
      supportsWebSearch: false,
      contextWindow: null,
      qualityScore: /mini|small|lite|8b|instant/i.test(id) ? 55 : 75,
      speedScore: /mini|small|lite|8b|instant|flash/i.test(id) ? 90 : 55,
      raw: {}
    }));
}

/**
 * discoverModels: điểm vào chung — chọn đúng adapter theo `providerType`.
 * @param {'anthropic'|'openai'|'gemini'|'openai-compatible'} providerType
 * @param {string} apiKey
 * @param {object} [compatibleConfig] bắt buộc khi providerType === 'openai-compatible'
 * @returns {Promise<Array|null>} null nghĩa là provider này không hỗ trợ discovery (mục 13)
 */
async function discoverModels(providerType, apiKey, compatibleConfig) {
  if (providerType === 'anthropic') return discoverAnthropicModels(apiKey);
  if (providerType === 'openai') return discoverOpenAIModels(apiKey);
  if (providerType === 'gemini') return discoverGeminiModels(apiKey);
  if (providerType === 'openai-compatible') return discoverOpenAICompatibleModels(compatibleConfig, apiKey);
  throw new Error(`modelDiscovery: providerType không hỗ trợ: ${providerType}`);
}

// ---------- Chọn model "mạnh" / "nhanh" theo capability của request (mục 5, 6, 10) ----------
function scoreForBest(m, req) {
  if (!m || !isChatEligible(m.id)) return -Infinity;
  if (req.requireVision && !(m.inputCapabilities && m.inputCapabilities.vision)) return -Infinity;
  let score = typeof m.qualityScore === 'number' ? m.qualityScore : 50;
  if (req.requireWebSearch && !m.supportsWebSearch) score -= 40;
  if (req.preferReasoning && !m.supportsReasoning) score -= 15;
  if (m.contextWindow) score += Math.min(10, m.contextWindow / 100000);
  if (DEPRECATED_HINT_RE.test(m.id)) score -= 20;
  if (/preview|experimental|exp\b/i.test(m.id)) score -= 5;
  return score;
}

function scoreForFast(m, req) {
  if (!m || !isChatEligible(m.id)) return -Infinity;
  if (req.requireVision && !(m.inputCapabilities && m.inputCapabilities.vision)) return -Infinity;
  let score = typeof m.speedScore === 'number' ? m.speedScore : 50;
  if (DEPRECATED_HINT_RE.test(m.id)) score -= 20;
  return score;
}

/**
 * chooseBestModel(): xếp hạng và trả về top-N model "mạnh" phù hợp nhất với capability yêu cầu.
 * Không có ứng viên nào khớp CỨNG (vd bắt buộc vision) -> thử lại KHÔNG ép capability đó (fallback
 * gần nhất, mục 10) thay vì trả rỗng — chỉ trả rỗng khi model list gốc rỗng.
 * @param {string} provider
 * @param {Array} models Danh sách model đã normalize (từ discoverModels()).
 * @param {{requireVision?:boolean, requireWebSearch?:boolean, preferReasoning?:boolean}} [capabilities]
 * @param {number} [topN]
 * @returns {Array<string>} danh sách id model, đã sắp theo điểm giảm dần
 */
function chooseBestModel(provider, models, capabilities = {}, topN = 3) {
  if (!Array.isArray(models) || !models.length) return [];
  let ranked = models
    .map((m) => ({ m, score: scoreForBest(m, capabilities) }))
    .filter((x) => x.score > -Infinity)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length && capabilities.requireVision) {
    // Không model nào có vision -> nới lỏng, không crash (mục 10)
    ranked = models
      .map((m) => ({ m, score: scoreForBest(m, { ...capabilities, requireVision: false }) }))
      .filter((x) => x.score > -Infinity)
      .sort((a, b) => b.score - a.score);
  }
  return ranked.slice(0, topN).map((x) => x.m.id);
}

/**
 * chooseFastModel(): trả về top-N model "nhanh" phù hợp. Nếu không tìm được model nhanh RIÊNG biệt
 * (vd provider chỉ có đúng 1 model phù hợp), fallback về đúng model đó cho cả 2 vai trò (mục 6) —
 * KHÔNG BAO GIỜ trả về 1 model chưa được discovery xác nhận.
 * @returns {Array<string>}
 */
function chooseFastModel(provider, models, capabilities = {}, topN = 2) {
  if (!Array.isArray(models) || !models.length) return [];
  let ranked = models
    .map((m) => ({ m, score: scoreForFast(m, capabilities) }))
    .filter((x) => x.score > -Infinity)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length && capabilities.requireVision) {
    ranked = models
      .map((m) => ({ m, score: scoreForFast(m, { ...capabilities, requireVision: false }) }))
      .filter((x) => x.score > -Infinity)
      .sort((a, b) => b.score - a.score);
  }
  return ranked.slice(0, topN).map((x) => x.m.id);
}

/**
 * warmDiscovery(): gọi discovery THẬT (nếu cache đã hết hạn/chưa có) rồi chọn model mạnh/nhanh, ghi
 * cache. KHÔNG BAO GIỜ throw ra ngoài — lỗi discovery được nuốt lại, dùng cache cũ nếu còn (mục 8/9),
 * nếu không có cache cũ thì trả entry rỗng (models:[]) để executionTargets.js hiểu "provider này tạm
 * thời không khả dụng", KHÔNG làm sập các provider khác.
 * @param {string} provider baseKey nội bộ (vd 'anthropic', 'grok'...)
 * @param {string} apiKey
 * @param {'anthropic'|'openai'|'gemini'|'openai-compatible'} providerType
 * @param {object} [compatibleConfig]
 * @param {{force?:boolean}} [opts]
 * @returns {Promise<object>} cache entry (xem setCache)
 */
// ---------- Single-flight: nhiều request đồng thời discovery CÙNG (provider, apiKey) chỉ gọi mạng 1 lần ----------
// Không có cơ chế này, N request concurrent (vd 20 request tới cùng lúc khi cache vừa hết hạn/cold
// start) đều thấy cache miss/stale và đều tự gọi /models — tạo N lệnh gọi mạng trùng lặp thay vì 1.
// `inFlightWarm` giữ đúng 1 Promise ĐANG CHẠY cho mỗi cacheKey — request tới sau khi đã có 1 lượt
// đang chạy chỉ CHỜ chung kết quả đó thay vì tự khởi tạo lượt discovery mới.
const inFlightWarm = new Map();

async function warmDiscovery(provider, apiKey, providerType, compatibleConfig, opts = {}) {
  if (!apiKey) return null;
  const key = cacheKey(provider, apiKey);
  if (!opts.force && isFresh(provider, apiKey)) return getCachedModels(provider, apiKey);

  const existing = inFlightWarm.get(key);
  if (existing) return existing; // đã có 1 lượt discovery đang chạy cho đúng (provider, key) này — dùng chung

  const promise = warmDiscoveryUncached(provider, apiKey, providerType, compatibleConfig, opts)
    .finally(() => inFlightWarm.delete(key));
  inFlightWarm.set(key, promise);
  return promise;
}

async function warmDiscoveryUncached(provider, apiKey, providerType, compatibleConfig, opts = {}) {
  const key = cacheKey(provider, apiKey);
  // L1 miss (cold start) -> thử hydrate từ L2 trước khi gọi mạng thật (mục 2: kiến trúc sẵn sàng cho
  // Redis/KV sau này mà không phải sửa gì ở executionTargets.js/aiProviders.js/routes/*).
  if (!CACHE.has(key)) {
    const hydrated = await l2Get(key);
    if (hydrated && hydrated.qualityModelIds && hydrated.qualityModelIds.length && Date.now() <= hydrated.expiresAt) {
      CACHE.set(key, hydrated);
      if (!opts.force) return { ...hydrated, stale: false };
    }
  }

  try {
    const models = await discoverModels(providerType, apiKey, compatibleConfig);
    if (models === null) {
      // Provider không hỗ trợ discovery (mục 13) — dùng declared fallback của config (KHÔNG phải
      // đoán mò từ .env) nếu có, đánh dấu rõ ràng bằng lastError để observability biết đây là
      // fallback chứ không phải "đã xác nhận qua API liệt kê model".
      const fallbackId = compatibleConfig && compatibleConfig.defaultModel;
      const fallbackFastId = (compatibleConfig && (compatibleConfig.defaultFastModel || compatibleConfig.defaultModel));
      if (fallbackId) {
        const fabricated = [{
          id: fallbackId, displayName: fallbackId, provider, inputCapabilities: { text: true, vision: !!(compatibleConfig && compatibleConfig.supportsVision) },
          outputCapabilities: { text: true }, supportsStreaming: true, supportsTools: true,
          supportsReasoning: !!(compatibleConfig && compatibleConfig.supportsThinking), supportsWebSearch: false, contextWindow: null,
          maxOutputTokens: Number(compatibleConfig && compatibleConfig.maxOutputTokens) || null,
          qualityScore: 70, speedScore: 60
        }];
        if (fallbackFastId && fallbackFastId !== fallbackId) {
          fabricated.push({ ...fabricated[0], id: fallbackFastId, displayName: fallbackFastId, speedScore: 90, qualityScore: 55 });
        }
        return setCache(provider, apiKey, {
          models: fabricated,
          qualityModelIds: [fallbackId],
          fastModelIds: [fallbackFastId || fallbackId],
          capsById: Object.fromEntries(fabricated.map((f) => [f.id, f])),
          lastError: 'provider không có endpoint /models — dùng declared fallback trong extraProviders.js (chưa xác nhận qua API)'
        });
      }
      const stale = getCachedModels(provider, apiKey);
      if (stale && stale.qualityModelIds && stale.qualityModelIds.length) return stale;
      return setCache(provider, apiKey, { models: [], qualityModelIds: [], fastModelIds: [], lastError: 'provider không hỗ trợ model discovery và không có defaultModel khai báo' });
    }

    const qualityModelIds = chooseBestModel(provider, models, {});
    const fastModelIds = chooseFastModel(provider, models, {});
    const capsById = Object.fromEntries(models.map((m) => [m.id, m]));
    return setCache(provider, apiKey, {
      models,
      qualityModelIds,
      fastModelIds: fastModelIds.length ? fastModelIds : qualityModelIds,
      capsById
    });
  } catch (err) {
    // Discovery lỗi (mạng/401/timeout...) -> KHÔNG crash, dùng cache cũ nếu còn (mục 8/9).
    const stale = getCachedModels(provider, apiKey);
    if (stale && stale.qualityModelIds && stale.qualityModelIds.length) {
      return { ...stale, lastError: String(err.message || err).slice(0, 300) };
    }
    return setCache(provider, apiKey, { models: [], qualityModelIds: [], fastModelIds: [], lastError: err });
  }
}

module.exports = {
  discoverModels,
  discoverAnthropicModels,
  discoverOpenAIModels,
  discoverGeminiModels,
  discoverOpenAICompatibleModels,
  chooseBestModel,
  chooseFastModel,
  getCachedModels,
  invalidateModelCache,
  markModelInvalid,
  warmDiscovery,
  configureL2CacheBackend,
  isChatEligible,
  // exposed cho test (không phải API public dùng ở nơi khác)
  __TTL_MS: TTL_MS,
  __getInFlightCount: () => inFlightWarm.size
};
