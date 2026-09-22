'use strict';

// ============================================================================================
// V6.15 — VISUAL POLICY GATE DUY NHẤT (resolveVisualPolicy)
// ============================================================================================
// Root cause (audit V6.15.0):
//   A. `settings.visual = 'never'` chỉ được kiểm tra BÊN TRONG decisionEngine — tức là SAU khi
//      pipeline đã đi qua nhánh deadline/degrade, nhánh emergency (dựng SVG tất định) và
//      decisionEngine.evaluateVisualNeed(). "never" là một policy, không phải một tuỳ chọn UI.
//   B. Route vẫn gọi runVisualsFor() -> runVisualPipeline() cho MỌI câu trả lời thường và giữ SSE mở
//      cho tới khi pipeline trả về.
//   C. Cache hit phát lại `visual:request` từ visualJob cũ bất kể policy hiện tại.
//
// Module này là ĐIỂM QUYẾT ĐỊNH DUY NHẤT. visualPipeline, route chat và đường phát lại cache đều
// gọi hàm này — không nơi nào tự viết lại logic "never" (V6.15.14: không copy vào 5-10 file).
//
// Nguồn của "yêu cầu tường minh" là CHÍNH bộ tín hiệu explicit của decisionEngine
// (visualScoringConfig.GENERIC_SIGNALS) nên hai nơi không thể lệch nhau.
// ============================================================================================

const CFG = require('./visualScoringConfig');

const { SETTING, GENERIC_SIGNALS } = CFG;

/** Tăng khi ngữ nghĩa policy đổi: cache tạo bởi phiên bản cũ (chưa hiểu policy) tự thành MISS. */
const VISUAL_POLICY_VERSION = 'vp2';

const VALID_MODES = Object.freeze([SETTING.AUTO, SETTING.ALWAYS, SETTING.NEVER]);

const REASON = Object.freeze({
  NEVER: 'user_preference_never',
  EXPLICIT_OVERRIDE_NEVER: 'explicit_override_never',
  ALWAYS: 'user_preference_always',
  AUTO: 'user_preference_auto',
  EXPLICIT: 'explicit_visual_request',
  IMAGE_ONLY: 'image_only_request'
});

/** Chuẩn hoá về đúng 1 trong auto|always|never. Giá trị lạ -> 'auto' (khớp validators.js). */
function normalizeVisualMode(value) {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  return VALID_MODES.includes(v) ? v : SETTING.AUTO;
}

/**
 * Người dùng có YÊU CẦU TƯỜNG MINH một hình cho chính lượt này không.
 * Dùng cùng danh sách tín hiệu explicit với visualDecisionEngine.
 */
function detectExplicitVisualIntent(question) {
  const q = String(question == null ? '' : question);
  if (!q) return false;
  return GENERIC_SIGNALS.some((s) => s && s.explicit && s.re.test(q));
}

/**
 * resolveVisualPolicy() — cổng policy. Thuần hàm, 0 I/O, 0 token, KHÔNG đọc setting sống.
 *
 * @param {object} a
 * @param {'auto'|'always'|'never'} [a.userPreference] snapshot lúc bắt đầu request (đã qua validator)
 * @param {string} [a.question] câu gốc của người dùng (còn nguyên động từ "vẽ…")
 * @param {string} [a.stage] 'approach'|'detail'|'image_only'…
 * @param {boolean} [a.explicitRequest] caller đã biết đây là yêu cầu hình tường minh (vd đường image-only)
 * @returns {{mode:string, explicitRequest:boolean, allowVisualLifecycle:boolean, reason:string,
 *   blocking:boolean, policyVersion:string}}
 */
function resolveVisualPolicy({ userPreference, question, stage, explicitRequest } = {}) {
  const mode = normalizeVisualMode(userPreference);
  const explicit = explicitRequest === true || detectExplicitVisualIntent(question);
  const st = String(stage == null ? 'approach' : stage).toLowerCase();

  let allow;
  let reason;
  if (mode === SETTING.NEVER) {
    allow = explicit;
    reason = explicit ? REASON.EXPLICIT_OVERRIDE_NEVER : REASON.NEVER;
  } else {
    allow = true;
    reason = explicit ? REASON.EXPLICIT : (mode === SETTING.ALWAYS ? REASON.ALWAYS : REASON.AUTO);
  }
  // `blocking`: hình là artifact CHÍNH của request (đường image-only) -> chỉ khi đó tail hình mới
  // được coi là một phần của "hoàn tất". Hình phụ trợ (auto/always) KHÔNG bao giờ là critical path.
  const blocking = allow && st === 'image_only';
  return Object.freeze({ mode, explicitRequest: explicit, allowVisualLifecycle: allow, reason, blocking, policyVersion: VISUAL_POLICY_VERSION });
}

/**
 * Telemetry bất biến cho nhánh "bị policy chặn" (V6.15.10). Mọi bộ đếm = 0; `visualSkippedByPolicy`
 * tách BẠCH với lỗi (failed) và với "không cần hình" (below_threshold).
 */
function skippedTelemetry(policy, stage) {
  return {
    visualPolicy: policy.mode,
    visualPolicyReason: policy.reason,
    visualPolicyVersion: policy.policyVersion,
    visualLifecycleAllowed: false,
    visualBlocking: false,
    visualWorkStarted: false,
    visualSkippedByPolicy: true,
    visualJudgeCalls: 0,
    visualProviderAttempts: 0,
    visualCacheRead: false,
    visualCacheDispatch: false,
    visualGenerationLifecycleCount: 0,
    visualStage: stage == null ? 'approach' : stage,
    visualError: null,
    // Cùng shape với telemetry nhánh bình thường (visualPipeline.js) để mọi consumer (route log,
    // test, dashboard) đọc field nào cũng có giá trị xác định — không phải suy luận từ "vắng mặt".
    visualDeterministic: false, visualType: 'no_visual', visualRenderer: 'none', visualDecision: false
  };
}

/** Kết quả pipeline chuẩn cho nhánh bị policy chặn. `decision` giữ hình dạng cũ (test/log cũ đọc reason). */
function skippedResult(policy, stage) {
  return {
    status: 'skipped',
    skippedByPolicy: true,
    decision: {
      shouldGenerateImage: false, confidence: 0, visualType: 'no_visual', visualPurpose: '',
      suggestedCount: 0, placement: 'none', generationPriority: 'low', score: 0, threshold: Infinity,
      borderline: false, reason: policy.reason, imageNecessity: 'NONE', signals: {}
    },
    visuals: [],
    telemetry: skippedTelemetry(policy, stage)
  };
}

/**
 * Cờ hoàn tất SSE (V6.15.5). `visualBlocking` trả lời đúng MỘT câu hỏi cho client:
 * "sau sự kiện done còn sự kiện hình nào trên stream này không?".
 *   false -> không còn gì; client resolve NGAY, không chờ đuôi hình không tồn tại.
 *   true  -> còn visual:* trên stream; client đọc tiếp tới khi server đóng.
 */
function completionFlags(policy, { visualMayFollow } = {}) {
  const follow = !!(policy && policy.allowVisualLifecycle && visualMayFollow);
  return {
    visualPending: follow,
    visualBlocking: follow,
    // Flat field (không lồng) để sanitizeCachedPayload() so sánh trực tiếp khi payload này sau đó
    // được ghi vào cache và đọc lại ở một request khác.
    visualPolicyVersion: VISUAL_POLICY_VERSION,
    visualPolicy: {
      mode: policy ? policy.mode : SETTING.AUTO,
      reason: policy ? policy.reason : REASON.AUTO,
      lifecycleAllowed: !!(policy && policy.allowVisualLifecycle),
      skippedByPolicy: !!(policy && !policy.allowVisualLifecycle),
      version: VISUAL_POLICY_VERSION
    }
  };
}

/**
 * Lọc một payload cache trước khi PHÁT LẠI (V6.15.7). Khi policy hiện tại không cho vòng đời hình,
 * mọi artifact hình trong cache (visuals/visualJob/…) bị gỡ và KHÔNG được phát visual:request.
 * Cache do phiên bản cũ (thiếu policyVersion) cũng bị coi là không đáng tin cho hình.
 */
function sanitizeCachedPayload(payload, policy) {
  if (!payload || typeof payload !== 'object') return { payload, visualReplayAllowed: false };
  const stale = payload.visualPolicyVersion !== VISUAL_POLICY_VERSION;
  const allowed = !!(policy && policy.allowVisualLifecycle) && !stale;
  if (allowed) return { payload, visualReplayAllowed: true };
  const clean = { ...payload };
  delete clean.visuals;
  delete clean.visualJob;
  delete clean.visualStatus;
  clean.visualPending = false;
  return { payload: clean, visualReplayAllowed: false };
}

module.exports = {
  VISUAL_POLICY_VERSION, REASON, VALID_MODES,
  normalizeVisualMode, detectExplicitVisualIntent, resolveVisualPolicy,
  skippedTelemetry, skippedResult, completionFlags, sanitizeCachedPayload
};
