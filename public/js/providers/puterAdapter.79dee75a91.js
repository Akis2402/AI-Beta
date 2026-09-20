'use strict';

/* =====================================================================================
   puterAdapter.js — PHẦN A: tích hợp Puter.js làm AI provider bổ sung/fallback.

   LƯU Ý KIẾN TRÚC QUAN TRỌNG (khác các provider hiện có):
   Puter.js (https://js.puter.com/v2/) là SDK CHẠY Ở TRÌNH DUYỆT — `puter.ai.chat()` xác thực
   bằng phiên đăng nhập Puter CỦA NGƯỜI DÙNG (Puter tự mở popup đăng nhập khi cần), KHÔNG dùng
   API key kiểu server-to-server như Anthropic/OpenAI/Gemini hiện có (server/utils/*Client.js).
   Vì vậy Puter KHÔNG THỂ trở thành 1 execution target gọi được từ server (không có khái niệm
   "khoá API server" hợp lệ cho việc này — cố nhét 1 khoá tĩnh vào server sẽ VI PHẠM "Không được
   hard-code Puter API key" trong yêu cầu gốc, vì Puter không phát hành loại khoá đó cho mục đích
   này). Adapter này do đó chạy Ở PHÍA CLIENT, và cắm vào vị trí "Puter" trong sơ đồ Provider
   Router (xem providerRouter.js) như một NHÁNH THỰC THI RIÊNG — không đi qua /api/chat.

   Interface thống nhất (PHẦN C): normalize output về đúng 4 sự kiện mà apiPostStream() (app.js)
   đã dùng với provider hiện có — { onDelta(textChunk), onStatus(msg,state), done, error } — để
   phần còn lại của app (render, resumable buffer, conversationTaskManager...) không cần biết nó
   đang nói chuyện với provider nào.
   ===================================================================================== */

let puterSdkLoadPromise = null;
/** Nạp SDK Puter.js LAZY — chỉ khi thực sự cần dùng (không tải trước, không ảnh hưởng cold-start). */
function ensurePuterSdk() {
  if (window.puter && window.puter.ai && typeof window.puter.ai.txt2img === 'function') return Promise.resolve(window.puter);
  if (puterSdkLoadPromise) return puterSdkLoadPromise;
  puterSdkLoadPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://js.puter.com/v2/';
    s.async = true;
    s.onload = () => {
      if (window.puter && window.puter.ai && typeof window.puter.ai.txt2img === 'function') resolve(window.puter);
      else reject(new Error('Puter SDK đã tải nhưng puter.ai.txt2img không tồn tại.'));
    };
    s.onerror = () => reject(new Error('Không tải được Puter SDK (js.puter.com) — kiểm tra kết nối mạng/CSP.'));
    document.head.appendChild(s);
  });
  return puterSdkLoadPromise;
}

const DEFAULT_PUTER_IMAGE_PROVIDER = 'openai-image-generation';
const PUTER_IMAGE_CAPABILITIES = {
  'openai-image-generation': {
    default: { ratioMode: 'fixed', fixedRatios: ['1:1', '16:9', '9:16'], multiImage: true, maxInputImages: 8, quality: ['low', 'medium', 'high'] },
    'gpt-image-1-mini': { ratioMode: 'fixed', fixedRatios: ['1:1', '16:9', '9:16'], multiImage: true, maxInputImages: 8, quality: ['low', 'medium', 'high'] },
    'gpt-image-2': { ratioMode: 'arbitrary', multiImage: true, maxInputImages: 8, quality: ['low', 'medium', 'high', 'auto'] }
  },
  gemini: { default: { ratioMode: 'exact', multiImage: true, maxInputImages: 8, quality: ['512', '1K', '2K', '4K'] } },
  together: { default: { ratioMode: 'fixed', fixedRatios: ['1:1', '16:9', '9:16'], multiImage: false, maxInputImages: 1, quality: [] } },
  xai: { default: { ratioMode: 'none', multiImage: true, maxInputImages: 3, quality: ['1k', '2k'] } },
  'replicate-image-generation': { default: { ratioMode: 'model-dependent', multiImage: false, maxInputImages: 1, quality: [] } }
};

function resolvePuterImageProvider(request = {}) {
  return request.puterProvider || request.configuredProvider || DEFAULT_PUTER_IMAGE_PROVIDER;
}

function getPuterImageCapabilities({ provider, model } = {}) {
  const resolved = provider || DEFAULT_PUTER_IMAGE_PROVIDER;
  const registry = PUTER_IMAGE_CAPABILITIES[resolved];
  if (!registry) return { provider: resolved, model: model || null, ratioMode: 'none', multiImage: false, maxInputImages: 0, quality: [] };
  return { provider: resolved, model: model || null, ...(registry[model] || registry.default) };
}

function getImageCapabilities(provider, model) {
  return getPuterImageCapabilities({ provider, model });
}

function getAuthState(puter) {
  if (!puter || !puter.auth || typeof puter.auth.isSignedIn !== 'function') return { signedIn: false, known: false };
  return { signedIn: !!puter.auth.isSignedIn(), known: true };
}

async function signIn() {
  const puter = await ensurePuterSdk();
  if (!puter.auth || typeof puter.auth.signIn !== 'function') throw new Error('Puter sign-in không khả dụng.');
  try {
    await puter.auth.signIn();
  } catch (e) {
    const msg = String((e && e.message) || '').toLowerCase();
    const code = /popup|blocked/.test(msg) ? 'popup_blocked'
      : /closed|cancel/.test(msg) ? 'auth_cancelled' : 'auth_required';
    throw Object.assign(new Error(code), { code });
  }
  return getAuthState(puter);
}

function ratioObject(ratio) {
  const m = /^(\d+):(\d+)$/.exec(String(ratio || '1:1'));
  return m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 1, h: 1 };
}

function mapRatioToPuter({ ratio, provider, model }) {
  const requestedRatio = ratio || '1:1';
  const caps = getPuterImageCapabilities({ provider, model });
  if (caps.ratioMode === 'exact' || caps.ratioMode === 'arbitrary') {
    return { requestedRatio, appliedRatio: ratioObject(requestedRatio), ratioMode: caps.ratioMode, ratioDegraded: false };
  }
  if (caps.ratioMode === 'fixed') {
    const appliedRatio = caps.fixedRatios.includes(requestedRatio) ? requestedRatio : (requestedRatio === '9:16' ? '9:16' : requestedRatio === '1:1' ? '1:1' : '16:9');
    return { requestedRatio, appliedRatio, ratioMode: 'fixed', ratioDegraded: appliedRatio !== requestedRatio };
  }
  return { requestedRatio, appliedRatio: null, ratioMode: caps.ratioMode, ratioDegraded: true };
}

function mapQualityToPuter({ quality, provider, model }) {
  const caps = getPuterImageCapabilities({ provider, model });
  const internal = quality || 'standard';
  const maps = {
    'openai-image-generation': { fast: 'low', standard: 'medium', high: 'high' },
    gemini: { fast: '512', standard: '1K', high: '2K' },
    xai: { fast: '1k', standard: '1k', high: '2k' }
  };
  const mapped = (maps[caps.provider] || {})[internal] || (caps.quality.includes(internal) ? internal : null);
  return { requestedQuality: internal, appliedQuality: mapped, qualityDegraded: !mapped && caps.quality.length > 0 };
}

function providerImageOptions(request) {
  const provider = resolvePuterImageProvider(request);
  const model = request.model || null;
  const caps = getPuterImageCapabilities({ provider, model });
  const ratio = mapRatioToPuter({ ratio: request.ratio, provider, model });
  const quality = mapQualityToPuter({ quality: request.quality, provider, model });
  const options = {};
  if (model) options.model = model;
  if (request.explicitProvider !== false) options.provider = provider;
  if (ratio.appliedRatio && typeof ratio.appliedRatio === 'object') options.ratio = ratio.appliedRatio;
  if (provider === 'together' && ratio.appliedRatio) options.aspect_ratio = ratio.appliedRatio;
  if (quality.appliedQuality) options.quality = quality.appliedQuality;
  if (Array.isArray(request.inputImages) && request.inputImages.length) {
    if (!caps.multiImage && request.inputImages.length > 1) throw Object.assign(new Error('Provider không hỗ trợ nhiều ảnh đầu vào.'), { code: 'input_images_unsupported' });
    if (caps.maxInputImages && request.inputImages.length > caps.maxInputImages) {
      throw Object.assign(new Error(`Provider chỉ hỗ trợ tối đa ${caps.maxInputImages} ảnh đầu vào.`), { code: 'input_images_limit' });
    }
    options.input_images = request.inputImages;
  }
  if (request.testMode === true) options.test_mode = true;
  return options;
}

function normalizeImageResult(result) {
  const isImage = typeof HTMLImageElement !== 'undefined' && result instanceof HTMLImageElement;
  const robustImage = result && result.nodeType === 1 && String(result.tagName).toLowerCase() === 'img';
  if (!isImage && !robustImage) throw Object.assign(new Error('Puter không trả về HTMLImageElement.'), { code: 'invalid_output' });
  const src = result.src;
  if (!src || typeof src !== 'string') throw Object.assign(new Error('Puter không trả về ảnh hợp lệ.'), { code: 'invalid_output' });
  return { element: result, dataUrl: src, format: /^data:/i.test(src) ? 'data_url' : 'image_url', apiProvider: result.provider || null };
}

const inFlightImageJobs = new Map();
function makeJobKey(request) { return request.visualId || request.visualFingerprint || `${request.prompt}|${request.ratio || ''}`; }

async function generatePuterImage(request = {}) {
  const key = makeJobKey(request);
  if (inFlightImageJobs.has(key)) return inFlightImageJobs.get(key);
  const promise = (async () => {
    const puter = await ensurePuterSdk();
    const auth = getAuthState(puter);
    if (auth.known && !auth.signedIn) {
      const err = new Error('Kết nối Puter để tạo hình AI');
      err.code = 'PUTER_AUTH_REQUIRED';
      err.authRequired = true;
      throw err;
    }
    const options = providerImageOptions(request);
    const result = await puter.ai.txt2img(String(request.prompt || ''), options);
    return {
      ...normalizeImageResult(result), provider: 'puter',
      puterProvider: resolvePuterImageProvider(request), model: request.model || null,
      visualId: request.visualId, ratio: mapRatioToPuter(request), quality: mapQualityToPuter(request)
    };
  })();
  inFlightImageJobs.set(key, promise);
  try { return await promise; } finally { inFlightImageJobs.delete(key); }
}

/** PHẦN S: capability vision — Puter hỗ trợ ảnh tuỳ model; kiểm tra field trả về khi cần. */
function puterSupportsVision(model) {
  // Model GPT-4o/Claude/Gemini proxy qua Puter thường hỗ trợ vision; danh sách này chỉ là gợi ý
  // AN TOÀN (bảo thủ) — nếu không chắc, providerRouter sẽ ưu tiên provider có vision xác nhận.
  return /gpt-4o|gpt-4\.1|claude|gemini/i.test(model || '');
}

/**
 * Gọi Puter AI chat, chuẩn hoá thành cùng interface với apiPostStream() hiện có.
 * @param {{system:string, messages:Array, model?:string, image?:{mediaType,base64}, signal?:AbortSignal}} req
 * @param {{onDelta:Function, onStatus:Function}} callbacks
 * @returns {Promise<{text:string, provider:'puter', model:string, usage?:object, finishReason:string}>}
 */
async function streamPuter(req, { onDelta, onStatus } = {}) {
  onStatus && onStatus((window.t ? window.t('provider.puterFallback') : 'Đang dùng nhà cung cấp dự phòng (Puter)...'), 'info');
  const puter = await ensurePuterSdk();

  // Puter chưa có phiên đăng nhập -> puter.ai.chat() sẽ tự mở popup xác thực; báo trước cho người
  // dùng biết (PHẦN A: "Không được thay thế mù quáng provider hiện tại" — đây CHỈ là fallback khi
  // được providerRouter chọn, không tự ý chặn luồng chính).
  if (puter.auth && typeof puter.auth.isSignedIn === 'function' && !puter.auth.isSignedIn()) {
    onStatus && onStatus((window.t ? window.t('provider.puterLoginRequired') : 'Cần đăng nhập Puter để dùng nhà cung cấp dự phòng này.'), 'info');
  }

  const model = req.model || 'gpt-4o-mini';
  // Puter's puter.ai.chat(prompt, options) chấp nhận messages dạng OpenAI-style qua options.messages
  // (đã hỗ trợ trong SDK v2) hoặc 1 chuỗi prompt đơn — dùng dạng messages để giữ system + history.
  const puterMessages = [];
  if (req.system) puterMessages.push({ role: 'system', content: req.system });
  (req.messages || []).forEach((m) => puterMessages.push(m));
  if (req.image && req.image.base64) {
    const last = puterMessages[puterMessages.length - 1];
    if (last && last.role === 'user') {
      last.content = [
        { type: 'text', text: typeof last.content === 'string' ? last.content : '' },
        { type: 'image_url', image_url: { url: `data:${req.image.mediaType};base64,${req.image.base64}` } }
      ];
    }
  }

  let full = '';
  const finish = async () => {
    // API stream() trả AsyncIterable các delta; fallback non-stream nếu SDK phiên bản không hỗ trợ.
    try {
      const resp = await puter.ai.chat(puterMessages, { model, stream: true });
      if (resp && typeof resp[Symbol.asyncIterator] === 'function') {
        for await (const part of resp) {
          if (req.signal && req.signal.aborted) throw makePuterCancelledError();
          const chunk = (part && (part.text || (part.message && part.message.content))) || '';
          if (chunk) { full += chunk; onDelta && onDelta(chunk); }
        }
      } else {
        const text = (resp && (resp.text || resp.message && resp.message.content)) || String(resp || '');
        full = text;
        onDelta && onDelta(text);
      }
    } catch (e) {
      if (req.signal && req.signal.aborted) throw makePuterCancelledError();
      throw normalizePuterError(e);
    }
  };
  await finish();
  return { text: full, provider: 'puter', model, usage: null, finishReason: 'stop' };
}

function makePuterCancelledError() {
  const e = new Error('Đã hủy (Puter)');
  e.name = 'AbortError';
  e.cancelled = true;
  return e;
}

/** PHẦN AF: chuẩn hoá lỗi Puter về cùng error code như errorNormalize.js phía server dùng, để UI
 * dịch bằng error.* key sẵn có thay vì hiển thị message thô tiếng Anh của Puter. */
function normalizePuterError(e) {
  const msg = String((e && e.message) || e || '');
  let code = 'error.generic';
  if (/timeout/i.test(msg)) code = 'error.timeout';
  else if (/rate.?limit|429/i.test(msg)) code = 'error.rateLimit';
  else if (/network|fetch/i.test(msg)) code = 'error.network';
  else if (/unavailable|503/i.test(msg)) code = 'error.unavailable';
  else if (/invalid|400/i.test(msg)) code = 'error.invalidRequest';
  const err = new Error(window.t ? window.t(code) : msg);
  err.code = code;
  err.provider = 'puter';
  err.original = e;
  return err;
}

window.puterAdapter = {
  ensurePuterSdk, streamPuter, puterSupportsVision, getAuthState, signIn,
  generatePuterImage, normalizeImageResult, puterSupportsImageCapability: (provider) => !!PUTER_IMAGE_CAPABILITIES[provider],
  getImageCapabilities, resolvePuterImageProvider, getPuterImageCapabilities,
  mapRatioToPuter, mapQualityToPuter, providerImageOptions, DEFAULT_PUTER_IMAGE_PROVIDER
};
