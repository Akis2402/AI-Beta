'use strict';

// ============================================================================================
// VISUAL POLICY — CANONICAL VISUAL CACHE CONTRACT (Master Prompt V6.17.3 / V6.17.4)
// ============================================================================================
// Vấn đề gốc mà module này giải quyết (PRODUCTION BUG T1):
//
//   Trước bản này, `routes/chat.js` ghi thẳng `donePayload` / `directDonePayload` /
//   `jsonDonePayload` / `finalJsonPayload` vào `tokenEconomy.globalCache`. Payload đó có
//   `visualJob` nhưng KHÔNG có bất kỳ metadata policy nào. Hệ quả:
//
//     1. Không có cách nào phân biệt cache entry sinh ra dưới policy nào, ở phiên bản contract
//        nào — một entry cũ (trước khi có visualJob) và một entry mới nhìn giống hệt nhau.
//     2. Nhánh cache-hit replay `visual:request` VÔ ĐIỀU KIỆN theo `renderer === 'puter_image'`:
//        người dùng đổi setting sang "never" vẫn bị phát lại job hình (fail-OPEN).
//     3. Một entry cũ/stale vẫn được replay dù contract của job đã đổi.
//
//   Module này là SOURCE OF TRUTH DUY NHẤT cho:
//     - `VISUAL_POLICY_VERSION`  : phiên bản hợp lệ của cache replay.
//     - `resolveRoutePolicy()`   : policy hiệu lực của REQUEST HIỆN TẠI (không phải của cache).
//     - `completionFlags()`      : metadata policy gắn vào MỌI payload rời khỏi route.
//     - `finalizeVisualCachePayload()` : shape canonical được GỬI ĐI và GHI VÀO CACHE (một shape).
//     - `sanitizeCachedPayload()`: cửa đọc cache, FAIL-CLOSED.
//
// NGUYÊN TẮC FAIL-CLOSED (V6.17.14 — KHÔNG ĐƯỢC NỚI LỎNG):
//   Thiếu `visualPolicyVersion`, hoặc sai phiên bản, hoặc policy hiện tại chặn hình
//   -> GIỮ TEXT, GỠ artifact hình, KHÔNG replay `visual:request`, KHÔNG tự sinh ảnh mới.
//   Cache KHÔNG BAO GIỜ được trở thành lý do tạo ảnh mới (V6.17.8).
//
// PHÂN TÁCH DANH TÍNH (V6.17.4) — không được trộn:
//   visualId            = danh tính ARTIFACT
//   visualFingerprint   = danh tính CACHE của hình
//   visualPolicyVersion = tính hợp lệ của REPLAY
//   cacheKeyParts       = danh tính CACHE của text
// Cache hit != new generation. Cache replay != provider call.

const decisionEngine = require('./visualDecisionEngine');
const { stageMayGenerate } = require('./visualPipeline');

// Phiên bản contract của visual payload nằm trong result cache. TĂNG SỐ NÀY mỗi khi shape của
// `visualJob` / `visuals` / cờ policy thay đổi theo cách khiến entry cũ không còn replay đúng.
// Entry ghi ở phiên bản khác sẽ bị coi là stale và bị sanitize (fail-closed), KHÔNG bị "châm chước".
const VISUAL_POLICY_VERSION = 'vp-1';

const POLICY = { AUTO: 'AUTO', ALWAYS: 'ALWAYS', NEVER: 'NEVER' };

/**
 * normalizePolicy() — quy setting người dùng ('auto'|'always'|'never') về policy canonical.
 * Giá trị lạ/không có -> AUTO (an toàn: AUTO vẫn bị decision engine chấm điểm, không ép hình).
 * @param {string} [userPreference]
 * @returns {'AUTO'|'ALWAYS'|'NEVER'}
 */
function normalizePolicy(userPreference) {
  const v = String(userPreference == null ? '' : userPreference).trim().toLowerCase();
  if (v === 'never') return POLICY.NEVER;
  if (v === 'always') return POLICY.ALWAYS;
  return POLICY.AUTO;
}

/**
 * resolveRoutePolicy() — policy hình của REQUEST HIỆN TẠI (0 token, thuần heuristic).
 *
 * Phải luôn giải theo request đang chạy, KHÔNG BAO GIỜ theo giá trị nằm trong cache: đó chính là
 * điều khiến một cache entry cũ có thể "ghi đè" lựa chọn mới của người dùng.
 *
 * @param {object} a
 * @param {string} [a.userPreference] settings.visual
 * @param {string} [a.stage] 'approach'|'detail'|'image_only'
 * @param {string} [a.question] câu hỏi gốc — để phát hiện yêu cầu hình TƯỜNG MINH
 * @param {boolean} [a.imageOnly] route đã phân loại đây là request "chỉ lấy hình"
 * @returns {{version:string, policy:string, explicitVisualRequest:boolean,
 *   allowVisualLifecycle:boolean, allowVisualReplay:boolean}}
 */
function resolveRoutePolicy(a = {}) {
  const policy = normalizePolicy(a.userPreference);
  const explicitVisualRequest = !!a.imageOnly
    || decisionEngine.isExplicitVisualRequest(a.question || '');
  // A3 (visualDecisionEngine): setting "never" vẫn THUA một yêu cầu tường minh của người dùng.
  // Giữ đúng cùng một quy tắc ở đây để policy của cache không mâu thuẫn với policy của pipeline.
  const visualAllowed = policy !== POLICY.NEVER || explicitVisualRequest;
  // Sinh hình MỚI chỉ hợp lệ ở stage được phép (approach / image_only) — mục 31/32.
  const lifecycleStage = stageMayGenerate(a.imageOnly ? 'image_only' : a.stage);
  return {
    version: VISUAL_POLICY_VERSION,
    policy,
    explicitVisualRequest,
    allowVisualLifecycle: visualAllowed && lifecycleStage,
    // REPLAY (phát lại job/artifact ĐÃ CÓ) không phải sinh hình mới, nên KHÔNG bị khoá theo stage:
    // đây chính là đường "re-entry / reload -> ATTACH execution cũ" của V6.17.7.
    allowVisualReplay: visualAllowed
  };
}

/**
 * completionFlags() — metadata policy gắn vào MỌI payload hoàn tất (SSE `done` và JSON).
 *
 * `visualPending` = "text xong rồi, hình CÓ THỂ tới sau bằng sự kiện riêng".
 * `visualBlocking` = luôn false: hình KHÔNG BAO GIỜ chặn text (bất biến của visualPipeline).
 *
 * @param {object} routePolicy kết quả resolveRoutePolicy()
 * @param {{visualMayFollow?:boolean}} [opts]
 * @returns {{visualPolicyVersion:string, visualPolicy:string, visualPending:boolean, visualBlocking:boolean}}
 */
function completionFlags(routePolicy, opts = {}) {
  const visualMayFollow = !!opts.visualMayFollow;
  return {
    visualPolicyVersion: VISUAL_POLICY_VERSION,
    visualPolicy: routePolicy ? routePolicy.policy : POLICY.AUTO,
    visualPending: !!(visualMayFollow && routePolicy && routePolicy.allowVisualLifecycle),
    visualBlocking: false
  };
}

/**
 * finalizeVisualCachePayload() — shape CANONICAL DUY NHẤT của một kết quả đã hoàn tất.
 *
 * Đây là điểm gom V6.17.3.D: KHÔNG lặp lại công thức `visualPolicyVersion: ...` ở 4-6 chỗ trong
 * route. Giá trị trả về vừa là thứ được GỬI cho client, vừa là thứ được GHI vào result cache —
 * "send one shape, cache another shape" là chính bug đang vá nên không được phép tồn tại.
 *
 * @param {object} basePayload payload text đã hoàn tất
 * @param {object|null} visualRun kết quả runVisualPipeline()
 * @param {object} routePolicy kết quả resolveRoutePolicy()
 * @returns {object} payload canonical
 */
function finalizeVisualCachePayload(basePayload, visualRun, routePolicy) {
  const visuals = visualRun && Array.isArray(visualRun.visuals) ? visualRun.visuals : [];
  return {
    ...(basePayload || {}),
    visuals,
    visualStatus: visualRun ? (visualRun.status || null) : null,
    visualJob: visualRun ? (visualRun.visualJob || null) : null,
    // Payload đã hoàn tất: không còn gì "sẽ tới sau" nữa.
    ...completionFlags(routePolicy, { visualMayFollow: false })
  };
}

/**
 * sanitizeCachedPayload() — CỬA ĐỌC CACHE, FAIL-CLOSED.
 *
 * Text trong cache LUÔN được giữ (V6.17.10 C8: cache text vẫn hợp lệ kể cả khi hình bị gỡ).
 * Artifact hình chỉ sống sót khi CẢ HAI điều kiện đều đúng:
 *   1. entry được ghi ở đúng `VISUAL_POLICY_VERSION` hiện tại; và
 *   2. policy của REQUEST HIỆN TẠI cho phép hình.
 *
 * @param {object} cached giá trị lấy từ result cache
 * @param {object} routePolicy kết quả resolveRoutePolicy()
 * @returns {{payload:object, stale:boolean, visualReplayAllowed:boolean, hasVisualJob:boolean, reason:string}}
 */
function sanitizeCachedPayload(cached, routePolicy) {
  const payload = { ...(cached || {}) };
  const version = payload.visualPolicyVersion;
  const stale = version !== VISUAL_POLICY_VERSION;
  const policyAllows = !!(routePolicy && routePolicy.allowVisualReplay);
  const job = payload.visualJob;
  const hasVisualJob = !!(job && job.renderer);

  let reason = 'replay_allowed';
  if (stale) reason = version == null ? 'missing_policy_version' : 'stale_policy_version';
  else if (!policyAllows) reason = 'policy_blocks_visual';
  else if (!hasVisualJob) reason = 'no_visual_job';

  const keepVisuals = !stale && policyAllows;
  if (!keepVisuals) {
    // GỠ artifact hình, GIỮ NGUYÊN text. Không "sửa" entry cũ cho hợp lệ, không hạ chuẩn guard.
    payload.visualJob = null;
    payload.visuals = [];
    payload.visualStatus = null;
  }
  // Payload đi ra ngoài luôn mang cờ policy của REQUEST HIỆN TẠI, không phải cờ của entry cũ.
  Object.assign(payload, completionFlags(routePolicy, { visualMayFollow: false }));

  return {
    payload,
    stale,
    visualReplayAllowed: keepVisuals && hasVisualJob,
    hasVisualJob,
    reason
  };
}

module.exports = {
  VISUAL_POLICY_VERSION,
  POLICY,
  normalizePolicy,
  resolveRoutePolicy,
  completionFlags,
  finalizeVisualCachePayload,
  sanitizeCachedPayload
};
