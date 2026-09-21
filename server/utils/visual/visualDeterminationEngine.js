'use strict';

// ============================================================================================
// VISUAL DETERMINATION ENGINE — MODULE CANONICAL quyết định "hình nào, bằng gì" (Hybrid Visual Engine)
// ============================================================================================
//   USER QUESTION -> SUBJECT -> (cần hình?) -> (SVG tất định dựng chính xác được?)
//        SVG được  -> deterministic SVG engine (0 token, 0 lệnh gọi image model, KHÔNG cần Puter)
//        SVG không -> Puter AI Image (chỉ khi cần & Puter đã Auth) | không hình
//
// Phân vai (KHÔNG có router cạnh tranh):
//   visualDecisionEngine   : "có nên có hình không, quan trọng mức nào" (0 token).
//   visualDeterminationEngine (file này): "SVG hay Puter hay không hình" — điểm QUYẾT ĐỊNH DUY NHẤT.
//   visualRendererRouter   : chỉ được gọi SAU khi file này chọn 'puter-image'; nó phân giải nhánh
//                            ảnh AI (generated_image | interactive_3d | no_visual). Không tự chọn SVG.
//
// Đầu vào tối thiểu (mục XXXI): câu hỏi + vài dữ kiện — KHÔNG truyền cả hội thoại.
// Đầu ra: {shouldVisualize, visualType:'svg'|'puter-image'|'none', subject, category, confidence,
//          deterministic, userRequested, reason, ...} + artifact SVG khi visualType === 'svg'.

const deterministic = require('./deterministic');
const { fold } = require('./deterministic/factUtils');

const DEBUG = () => String(process.env.PUTER_VISUAL_DEBUG || '').toLowerCase() === 'true';
/** Log chẩn đoán (KHÔNG BAO GIỜ log token/secret/nội dung đề bài dài). Chỉ khi PUTER_VISUAL_DEBUG=true. */
function debugLog(scope, obj) {
  if (!DEBUG()) return;
  try { console.log(`[VISUAL] ${scope} ${JSON.stringify(obj)}`); } catch (_) { /* ignore */ }
}

// ---------------- Ý ĐỊNH NGƯỜI DÙNG (mục XLVII) ----------------
const AI_PHRASE_RE = /\b(?:bang|boi|nho|with|by|using|via)\s+(?:ai|puter|tri tue nhan tao)\b/i;
const AI_IMAGE_RE = /\b(?:anh|hinh)\s+ai\b|\bai image\b|\bai[- ]generated\b/i;
const HAS_IMAGE_WORD_RE = /\b(?:ve|tao|sinh|hinh|anh|minh hoa|bieu dien|draw|generate|render|image|picture|illustrat\w*)\b/i;
/** "bằng AI" chỉ nghĩa là "ép ảnh AI" khi câu đang nói về HÌNH ("vẽ/tạo/hình/ảnh..."); "giải bằng AI" thì không. */
const WANT_AI_RE = { test: (f) => AI_IMAGE_RE.test(f) || (AI_PHRASE_RE.test(f) && HAS_IMAGE_WORD_RE.test(f)) };
const REALISTIC_RE = /chan thuc|thuc te|realistic|photo(?:graph|realistic)?|anh that|nhu that|phong thi nghiem|\blab(?:oratory)? (?:scene|environment)|3d render|nghe thuat|artistic|illustration minh hoa dep|cinematic/i;
const WANT_EXACT_RE = /chinh xac|deterministic|so do (?:luc|mach|electron|obitan|nguyen tu)|ve (?:so do|cau truc|cau hinh|mo hinh|luc|mach)|mo hinh (?:bohr|nguyen tu)|ky hieu lewis|cau truc (?:electron|lewis)|bieu dien luc/i;
const VISUAL_VERB_RE = /\b(ve|ve hinh|hinh ve|hinh anh|tao hinh|so do|minh hoa|bieu dien|mo hinh|diagram|draw|sketch|plot|illustrate|visuali[sz]e)\b/i;

/** Lý do decision engine từ chối mà người dùng KHÔNG có quyền override (veto tuyệt đối/tuỳ chọn 'never'). */
const SOFT_DECLINE = new Set(['below_threshold', 'borderline']);

const PUTER_AUTH = new Set(['authenticated', 'unauthenticated', 'unknown', 'error']);
function normalizePuterAuth(v) { return PUTER_AUTH.has(v) ? v : 'unknown'; }

/**
 * determineVisual()
 * @param {object} a
 * @param {string} a.question
 * @param {string} [a.approachText] chỉ dùng làm nguồn dữ kiện PHỤ khi đề thiếu số liệu (giới hạn 1500 ký tự).
 * @param {string} [a.subject]
 * @param {object} a.decision kết quả visualDecisionEngine.evaluateVisualNeed()
 * @param {'auto'|'always'|'never'} [a.userPreference]
 * @param {'authenticated'|'unauthenticated'|'unknown'|'error'} [a.puterAuth] trạng thái Auth Puter do CLIENT báo.
 * @param {boolean} [a.clientPrimary] Puter chạy ở trình duyệt (yêu cầu Auth phía client).
 * @returns {object}
 */
function determineVisual(a = {}) {
  const question = String(a.question || '');
  const decision = a.decision || { shouldGenerateImage: false, reason: 'no_decision' };
  const subject = a.subject || 'general';
  const puterAuth = normalizePuterAuth(a.puterAuth);
  const clientPrimary = a.clientPrimary !== false;
  const f = fold(question).toLowerCase();

  const base = {
    shouldVisualize: false, visualType: 'none', subject, category: 'none', confidence: 0, deterministic: false,
    userRequested: !!decision.explicitRequest, reason: 'none', puterAuth, authRequired: false, artifact: null, validationErrors: null,
    forcedBy: null, necessity: decision.imageNecessity || 'NONE'
  };
  const wantsAI = WANT_AI_RE.test(f);
  const realistic = REALISTIC_RE.test(f);
  const userRequested = !!decision.explicitRequest || wantsAI || WANT_EXACT_RE.test(f);
  base.userRequested = userRequested;

  const out = (o) => { const r = { ...base, ...o }; debugLog('determination', { subject: r.subject, category: r.category, visualType: r.visualType, deterministic: r.deterministic, confidence: r.confidence, userRequested: r.userRequested, reason: r.reason, puterAuth: r.puterAuth, authRequired: r.authRequired }); return r; };

  // 1) Quyết định "có cần hình không" thuộc decision engine — trừ khi người dùng ĐÃ NÓI RÕ muốn sơ đồ chính xác
  //    và decision chỉ từ chối "mềm" (dưới ngưỡng/borderline), khi đó SVG rẻ như 0 đồng nên vẫn cho vẽ.
  let need = !!decision.shouldGenerateImage;
  let softOverride = false;
  if (!need) {
    const soft = SOFT_DECLINE.has(decision.reason);
    if (soft && VISUAL_VERB_RE.test(f) && deterministic.supportedSubject(subject) || (soft && VISUAL_VERB_RE.test(f) && subject === 'general')) softOverride = true;
    if (!softOverride) return out({ reason: decision.reason || 'decision_no_visual' });
  }

  // 2) Người dùng ép AI ("Tạo bằng AI", "chân thực", "phòng thí nghiệm chân thực") -> Puter, KHÔNG SVG.
  const forceAI = wantsAI || realistic;
  if (!forceAI) {
    // 3) Thử SVG tất định
    let det = { status: 'not_deterministic', reason: 'unsupported_subject' };
    if (deterministic.supportedSubject(subject) || subject === 'general' || !subject) {
      try { det = deterministic.tryRender(question, subject, { supplementalText: a.approachText }); } catch (e) { det = { status: 'not_deterministic', reason: `engine_error:${e && e.message}` }; }
    }
    if (det.status === 'rendered') {
      return out({
        shouldVisualize: true, visualType: 'svg', category: det.category, confidence: det.confidence, deterministic: true,
        reason: softOverride ? 'deterministic_explicit_visual' : (WANT_EXACT_RE.test(f) ? 'user_requested_exact_svg' : 'deterministic_svg_available'),
        artifact: det, forcedBy: WANT_EXACT_RE.test(f) ? 'user' : null
      });
    }
    if (det.status === 'contradiction') {
      // KHÔNG bịa: dữ kiện mâu thuẫn -> không vẽ SVG sai, cũng không nhờ AI vẽ "cho có".
      return out({ shouldVisualize: false, visualType: 'none', category: det.category, deterministic: true, confidence: 0.9, reason: 'deterministic_validation_failed', validationErrors: det.errors });
    }
    if (softOverride) return out({ reason: decision.reason || 'decision_no_visual' });
  } else if (softOverride) {
    return out({ reason: decision.reason || 'decision_no_visual' });
  }

  // 4) Nhánh Puter AI Image (chỉ khi decision engine cần hình)
  const authRequired = clientPrimary && puterAuth === 'unauthenticated';
  return out({
    shouldVisualize: true, visualType: 'puter-image', category: decision.visualType || 'ai_image', confidence: decision.confidence || 0.5,
    deterministic: false, reason: forceAI ? 'user_forced_ai_image' : 'not_svg_representable', authRequired, forcedBy: forceAI ? 'user' : null
  });
}

module.exports = { determineVisual, debugLog, normalizePuterAuth, WANT_AI_RE, REALISTIC_RE, WANT_EXACT_RE };
