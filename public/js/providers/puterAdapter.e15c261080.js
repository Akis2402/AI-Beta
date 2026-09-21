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

/* =====================================================================================
   PUTER = MỘT visual backend (không phải phụ thuộc cứng) + CANONICAL AUTH STATE
   -------------------------------------------------------------------------------------
   Nguyên tắc (Master prompt Puter Auth):
     • Auth Puter CHỈ diễn ra khi người dùng CLICK nút trong Settings. Không bao giờ tự mở popup
       lúc load trang, trong tác vụ nền, khi SSE event tới, khi retry hay khi fallback provider.
       Lý do kỹ thuật (docs.puter.com/security): mọi lệnh gọi dịch vụ cloud của Puter
       (puter.ai.*) khi CHƯA đăng nhập sẽ tự bật luồng đăng nhập — nên MỌI đường gọi puter.ai.*
       trong file này phải đi qua requireAuthenticated() và bị chặn khi chưa Auth.
     • Kiểm tra trạng thái = puter.auth.isSignedIn() (đồng bộ, không popup, không mạng).
     • MỘT trạng thái duy nhất (authState) cho Settings / Visual Determination / Puter Image Engine /
       popup thông báo / thẻ hình lỗi — không có 4–5 chỗ tự kiểm tra riêng.
   ===================================================================================== */

const PUTER_SDK_URL = 'https://js.puter.com/v2/';
const PUTER_SDK_LOAD_TIMEOUT_MS = 15000;

/** Mã lỗi Puter thống nhất (mục XXXIX) — UI/log/test dùng đúng các mã này, không dùng lỗi chung chung. */
const PUTER_ERR = Object.freeze({
  AUTH_REQUIRED: 'PUTER_AUTH_REQUIRED',
  AUTH_GESTURE_REQUIRED: 'PUTER_AUTH_GESTURE_REQUIRED',
  SDK_UNAVAILABLE: 'PUTER_SDK_UNAVAILABLE',
  AUTH_FAILED: 'PUTER_AUTH_FAILED',
  GENERATION_FAILED: 'PUTER_GENERATION_FAILED',
  INVALID_RESULT: 'PUTER_INVALID_RESULT',
  IMAGE_VALIDATION_FAILED: 'PUTER_IMAGE_VALIDATION_FAILED',
  RATE_LIMIT: 'PUTER_RATE_LIMIT',
  NETWORK_ERROR: 'PUTER_NETWORK_ERROR',
  PROVIDER_ERROR: 'PUTER_PROVIDER_ERROR',
  INSUFFICIENT_FUNDS: 'PUTER_INSUFFICIENT_FUNDS',
  CONTENT_REFUSED: 'PUTER_CONTENT_REFUSED'
});
const AUTH_STATUS = Object.freeze({ UNKNOWN: 'unknown', UNAUTHENTICATED: 'unauthenticated', AUTHENTICATED: 'authenticated', ERROR: 'error' });

function puterError(code, message, extra) {
  const e = new Error(message || code);
  e.code = code;
  e.provider = 'puter';
  if (code === PUTER_ERR.AUTH_REQUIRED || code === PUTER_ERR.AUTH_FAILED) e.authRequired = true;
  return Object.assign(e, extra || {});
}

/** Log chẩn đoán — bật bằng ?puterDebug=1 hoặc localStorage 'tro-giai:puter-debug'='1'. KHÔNG log token/secret. */
function puterDebugEnabled() {
  try {
    return /[?&]puterDebug=1\b/.test(String((window.location && window.location.search) || '')) || window.localStorage.getItem('tro-giai:puter-debug') === '1';
  } catch (_) { return false; }
}
function puterDebug(event, data) {
  if (!puterDebugEnabled()) return;
  try { console.log('[PUTER]', event, data || ''); } catch (_) { /* ignore */ }
}

let puterSdkLoadPromise = null;
let puterSdkFailed = false;
const sdkPresent = () => !!(window.puter && typeof window.puter === 'object');
const sdkHasImage = () => !!(window.puter && window.puter.ai && typeof window.puter.ai.txt2img === 'function');

/** Nạp SDK bằng thẻ <script> — KHÔNG gọi bất kỳ API Puter nào nên KHÔNG thể sinh popup. */
function loadPuterSdk() {
  if (sdkPresent()) return Promise.resolve(window.puter);
  if (puterSdkLoadPromise) return puterSdkLoadPromise;
  puterSdkLoadPromise = new Promise((resolve, reject) => {
    let done = false;
    const fail = (msg) => { if (done) return; done = true; puterSdkLoadPromise = null; reject(puterError(PUTER_ERR.SDK_UNAVAILABLE, msg)); };
    const timer = setTimeout(() => fail('Tải Puter SDK quá thời gian.'), PUTER_SDK_LOAD_TIMEOUT_MS);
    const s = document.createElement('script');
    s.src = PUTER_SDK_URL;
    s.async = true;
    s.onload = () => {
      clearTimeout(timer);
      if (done) return;
      if (sdkPresent()) { done = true; puterDebug('sdk-loaded'); resolve(window.puter); } else fail('Puter SDK đã tải nhưng window.puter không tồn tại.');
    };
    s.onerror = () => { clearTimeout(timer); fail('Không tải được Puter SDK (js.puter.com) — kiểm tra kết nối mạng/CSP.'); };
    document.head.appendChild(s);
  });
  return puterSdkLoadPromise;
}

/** SDK đủ điều kiện tạo ảnh (puter.ai.txt2img có mặt). */
function ensurePuterSdk() {
  return loadPuterSdk().then((p) => {
    if (!sdkHasImage()) throw puterError(PUTER_ERR.SDK_UNAVAILABLE, 'Puter SDK không có puter.ai.txt2img.');
    return p;
  });
}

// ---------------- CANONICAL AUTH STATE ----------------
let authState = Object.freeze({ provider: 'puter', status: AUTH_STATUS.UNKNOWN, checkedAt: null, user: null, sdkLoaded: false, busy: false, errorCode: null, errorMessage: null });
const authListeners = new Set();
let forcedAuthError = false; // token bị từ chối lúc gọi dịch vụ -> giữ 'error' tới khi user Re-Auth thành công

function getAuthSnapshot() { return authState; }
function isAuthenticated() { return authState.status === AUTH_STATUS.AUTHENTICATED; }
function subscribeAuth(fn) {
  authListeners.add(fn);
  return () => authListeners.delete(fn);
}
function setAuthState(patch) {
  const prev = authState;
  authState = Object.freeze({ ...prev, ...patch });
  const changed = ['status', 'user', 'busy', 'errorCode', 'sdkLoaded'].some((k) => JSON.stringify(prev[k]) !== JSON.stringify(authState[k]));
  if (changed) {
    puterDebug('auth-state', { status: authState.status, busy: authState.busy, errorCode: authState.errorCode });
    authListeners.forEach((fn) => { try { fn(authState, prev); } catch (_) { /* listener lỗi không được làm hỏng state */ } });
    try { window.dispatchEvent(new CustomEvent('puter:auth-changed', { detail: authState })); } catch (_) { /* ignore */ }
  }
  return authState;
}

/** Đọc trạng thái ĐỒNG BỘ từ SDK (không popup, không mạng). An toàn để gọi bất kỳ lúc nào. */
function refreshAuthState() {
  const p = window.puter;
  if (!p || !p.auth || typeof p.auth.isSignedIn !== 'function') {
    return setAuthState({ status: puterSdkFailed ? AUTH_STATUS.ERROR : AUTH_STATUS.UNKNOWN, checkedAt: Date.now(), sdkLoaded: !!p, errorCode: puterSdkFailed ? PUTER_ERR.SDK_UNAVAILABLE : null, user: null });
  }
  let signed = false;
  try { signed = !!p.auth.isSignedIn(); } catch (e) {
    return setAuthState({ status: AUTH_STATUS.ERROR, checkedAt: Date.now(), sdkLoaded: true, errorCode: PUTER_ERR.AUTH_FAILED, errorMessage: String((e && e.message) || e) });
  }
  if (signed && forcedAuthError) {
    return setAuthState({ status: AUTH_STATUS.ERROR, checkedAt: Date.now(), sdkLoaded: true, errorCode: PUTER_ERR.AUTH_FAILED });
  }
  const st = setAuthState({ status: signed ? AUTH_STATUS.AUTHENTICATED : AUTH_STATUS.UNAUTHENTICATED, checkedAt: Date.now(), sdkLoaded: true, errorCode: null, errorMessage: null, user: signed ? authState.user : null });
  if (signed && !authState.user) fetchUserInfo();
  return st;
}
function fetchUserInfo() {
  try {
    const p = window.puter && window.puter.auth;
    const pr = p && typeof p.getUser === 'function' ? p.getUser() : null;
    if (pr && typeof pr.then === 'function') {
      pr.then((u) => { if (u && authState.status === AUTH_STATUS.AUTHENTICATED) setAuthState({ user: { username: u.username || null } }); }).catch(() => { /* chỉ là thông tin phụ */ });
    }
  } catch (_) { /* ignore */ }
}

/** Khởi tạo: nạp SDK + đọc trạng thái. IDEMPOTENT, KHÔNG BAO GIỜ mở popup, KHÔNG BAO GIỜ throw. */
let initPromise = null;
function initPuterAuth() {
  if (initPromise) return initPromise;
  initPromise = loadPuterSdk().then(() => refreshAuthState()).catch((e) => {
    puterSdkFailed = true;
    return setAuthState({ status: AUTH_STATUS.ERROR, checkedAt: Date.now(), sdkLoaded: false, errorCode: PUTER_ERR.SDK_UNAVAILABLE, errorMessage: String((e && e.message) || e) });
  });
  return initPromise;
}
function retryInitPuterAuth() { initPromise = null; puterSdkFailed = false; puterSdkLoadPromise = null; return initPuterAuth(); }

/** Cổng chặn DUY NHẤT trước mọi lệnh gọi puter.ai.* — chưa Auth thì KHÔNG chạm vào SDK dịch vụ. */
async function requireAuthenticated() {
  await initPuterAuth();
  refreshAuthState();
  if (authState.status === AUTH_STATUS.ERROR && authState.errorCode === PUTER_ERR.SDK_UNAVAILABLE) throw puterError(PUTER_ERR.SDK_UNAVAILABLE, authState.errorMessage || 'Puter SDK không khả dụng.');
  if (authState.status !== AUTH_STATUS.AUTHENTICATED) throw puterError(PUTER_ERR.AUTH_REQUIRED, 'Cần Auth Puter.js trong Settings để dùng tính năng này.');
  return window.puter;
}

/**
 * Auth — CHỈ được gọi từ sự kiện click THẬT của người dùng (Settings). Yêu cầu `event.isTrusted === true`
 * nên gọi từ code nền / element.click() / dispatchEvent đều bị từ chối. puter.auth.signIn() được gọi
 * ĐỒNG BỘ trong cùng lượt xử lý click để trình duyệt không chặn popup.
 */
function signInFromUserGesture(opts = {}) {
  const ev = opts && opts.event;
  if (!ev || ev.isTrusted !== true) return Promise.reject(puterError(PUTER_ERR.AUTH_GESTURE_REQUIRED, 'Auth Puter chỉ chạy khi người dùng bấm nút trong Settings.'));
  const p = window.puter;
  if (!p || !p.auth || typeof p.auth.signIn !== 'function') {
    retryInitPuterAuth();
    return Promise.reject(puterError(PUTER_ERR.SDK_UNAVAILABLE, 'Puter SDK chưa sẵn sàng — đã thử tải lại, hãy bấm lại sau vài giây.'));
  }
  setAuthState({ busy: true, errorCode: null, errorMessage: null });
  let pending;
  try { pending = p.auth.signIn(); } catch (e) { pending = Promise.reject(e); }
  puterDebug('signin-started');
  return Promise.resolve(pending).then(() => {
    forcedAuthError = false;
    setAuthState({ busy: false });
    const st = refreshAuthState();
    puterDebug('signin-finished', { status: st.status });
    return st;
  }, (e) => {
    const msg = String((e && (e.message || e.msg)) || '').toLowerCase();
    const code = /popup|blocked/.test(msg) ? 'popup_blocked' : /closed|cancel|dismiss/.test(msg) ? 'auth_cancelled' : 'auth_failed';
    setAuthState({ busy: false, errorCode: PUTER_ERR.AUTH_FAILED, errorMessage: code });
    refreshAuthState();
    setAuthState({ errorCode: PUTER_ERR.AUTH_FAILED, errorMessage: code });
    throw puterError(PUTER_ERR.AUTH_FAILED, code, { reason: code });
  });
}
/** Đăng xuất — CHỈ khi SDK thật sự có puter.auth.signOut (không tạo API giả). */
function canSignOut() { return !!(window.puter && window.puter.auth && typeof window.puter.auth.signOut === 'function'); }
async function signOutPuter() {
  if (!canSignOut()) throw puterError(PUTER_ERR.SDK_UNAVAILABLE, 'SDK không hỗ trợ đăng xuất.');
  setAuthState({ busy: true });
  try { await window.puter.auth.signOut(); } finally { forcedAuthError = false; setAuthState({ busy: false, user: null }); refreshAuthState(); }
  return authState;
}

/**
 * classifyPuterError() — chuẩn hoá lỗi thô của SDK/mạng thành mã PUTER_* (docs: reject {message, code[, errorCode]},
 * upstream_* cho lỗi nhà cung cấp, insufficient_funds/402, moderation_flagged).
 */
function classifyPuterError(e) {
  if (e && typeof e.code === 'string' && e.code.startsWith('PUTER_')) return e;
  const raw = [e && e.code, e && e.errorCode, e && e.status, e && e.message, e && e.msg].filter((x) => x != null).join(' ').toLowerCase();
  let code = PUTER_ERR.GENERATION_FAILED;
  if (/insufficient_funds|insufficient funds|\b402\b|out of credit|not enough credit/.test(raw)) code = PUTER_ERR.INSUFFICIENT_FUNDS;
  else if (/moderation_flagged|content.?policy|safety|refus/.test(raw)) code = PUTER_ERR.CONTENT_REFUSED;
  else if (/token_auth_failed|unauthori[sz]ed|\b401\b|\b403\b|not signed in|sign ?in required|auth_required|forbidden|invalid token/.test(raw)) code = PUTER_ERR.AUTH_FAILED;
  else if (/rate.?limit|\b429\b|too many/.test(raw)) code = PUTER_ERR.RATE_LIMIT;
  else if (/invalid_output|invalid_result|not.*htmlimageelement|không trả về/.test(raw)) code = PUTER_ERR.INVALID_RESULT;
  else if (/upstream_|provider|\b5\d\d\b|bad gateway|unavailable/.test(raw)) code = PUTER_ERR.PROVIDER_ERROR;
  else if (/network|failed to fetch|fetch|timeout|timed out|offline|err_|load failed|abort/.test(raw)) code = PUTER_ERR.NETWORK_ERROR;
  const err = puterError(code, (e && e.message) || code, { original: e, retryable: [PUTER_ERR.RATE_LIMIT, PUTER_ERR.NETWORK_ERROR, PUTER_ERR.PROVIDER_ERROR, PUTER_ERR.GENERATION_FAILED].includes(code) });
  if (code === PUTER_ERR.AUTH_FAILED) { forcedAuthError = true; refreshAuthState(); }
  return err;
}

const DEFAULT_PUTER_IMAGE_PROVIDER = 'openai-image-generation';
const PUTER_IMAGE_CAPABILITIES = {
  'openai-image-generation': {
    default: { ratioMode: 'fixed', fixedRatios: ['1:1', '16:9', '9:16'], multiImage: true, maxInputImages: 8, quality: ['low', 'medium', 'high'] },
    'gpt-image-1-mini': { ratioMode: 'fixed', fixedRatios: ['1:1', '16:9', '9:16'], multiImage: true, maxInputImages: 8, quality: ['low', 'medium', 'high'] },
    'gpt-image-1': { ratioMode: 'fixed', fixedRatios: ['1:1', '16:9', '9:16'], multiImage: true, maxInputImages: 8, quality: ['low', 'medium', 'high'] },
    'gpt-image-1.5': { ratioMode: 'fixed', fixedRatios: ['1:1', '16:9', '9:16'], multiImage: true, maxInputImages: 8, quality: ['low', 'medium', 'high'] },
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

/** Tương thích cũ: {signedIn, known} suy ra từ CANONICAL state (không tự kiểm tra riêng). */
function getAuthState() {
  return { signedIn: authState.status === AUTH_STATUS.AUTHENTICATED, known: authState.status !== AUTH_STATUS.UNKNOWN, status: authState.status };
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
    // Cổng Auth: chưa Auth -> KHÔNG chạm vào puter.ai.* (nếu chạm, SDK sẽ tự bật luồng đăng nhập).
    await requireAuthenticated();
    const puter = await ensurePuterSdk();
    const options = providerImageOptions(request);
    puterDebug('generation-started', { provider: options.provider || null, model: options.model || null });
    let result;
    try {
      result = await puter.ai.txt2img(String(request.prompt || ''), options);
    } catch (e) {
      throw classifyPuterError(e);
    }
    puterDebug('result-received', { type: result && result.constructor && result.constructor.name });
    let normalized;
    try { normalized = normalizeImageResult(result); } catch (e) { throw puterError(PUTER_ERR.INVALID_RESULT, e.message); }
    return {
      ...normalized, provider: 'puter',
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
  // Cổng Auth: fallback chat KHÔNG BAO GIỜ được kích hoạt popup đăng nhập từ tác vụ nền.
  // (providerRouter cũng kiểm tra trước; đây là lớp phòng thủ thứ 2.)
  const puter = await requireAuthenticated();
  onStatus && onStatus((window.t ? window.t('provider.puterFallback') : 'Đang dùng nhà cung cấp dự phòng (Puter)...'), 'info');

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
  ensurePuterSdk, streamPuter, puterSupportsVision, getAuthState,
  // Tương thích cũ: signIn() KHÔNG còn chạy tự do — bắt buộc truyền {event} là click thật (xem signInFromUserGesture).
  signIn: (opts) => signInFromUserGesture(opts),
  generatePuterImage, normalizeImageResult, puterSupportsImageCapability: (provider) => !!PUTER_IMAGE_CAPABILITIES[provider],
  getImageCapabilities, resolvePuterImageProvider, getPuterImageCapabilities,
  mapRatioToPuter, mapQualityToPuter, providerImageOptions, DEFAULT_PUTER_IMAGE_PROVIDER,
  classifyPuterError, PUTER_ERR,
  // CANONICAL AUTH — nguồn sự thật DUY NHẤT về trạng thái Puter.
  auth: {
    STATUS: AUTH_STATUS, ERR: PUTER_ERR,
    getState: getAuthSnapshot, isAuthenticated, subscribe: subscribeAuth,
    init: initPuterAuth, retryInit: retryInitPuterAuth, refresh: refreshAuthState,
    signIn: signInFromUserGesture, signOut: signOutPuter, canSignOut,
    requireAuthenticated
  },
  debug: puterDebug
};
