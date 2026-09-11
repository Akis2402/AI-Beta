'use strict';

// ============================================================================================
// PHẦN 20/21/24/30/31/32 — VISUAL PIPELINE (KHÔNG BAO GIỜ BLOCK / LÀM HỎNG TEXT ANSWER)
// ============================================================================================
// Hợp đồng tuyệt đối của module này:
//
//   1. KHÔNG BAO GIỜ throw. Mọi lỗi -> {status:'failed'} + text answer vẫn nguyên vẹn (PHẦN 20/32).
//   2. KHÔNG BAO GIỜ chạy trước khi text answer hoàn tất (PHẦN 24: hình phải dựng từ FINAL VERIFIED
//      FACTS, không phải candidate đầu tiên).
//   3. Có VISUAL DEADLINE RIÊNG, tách khỏi text deadline (PHẦN 30). Hết hạn -> bỏ hình, không bao
//      giờ để timeout ảnh giết cả request.
//   4. Deterministic renderer chạy đồng bộ (nhanh, 0 token, không mạng); chỉ image generation mới
//      thực sự bất đồng bộ/tốn thời gian.
//
// Trạng thái trả về khớp PHẦN 32: 'skipped' | 'ready' | 'failed'.

const decisionEngine = require('./visualDecisionEngine');
const specBuilder = require('./visualSpecBuilder');
const router = require('./visualRendererRouter');
const deterministic = require('./deterministicRenderer');
const validator = require('./visualValidator');
const cache = require('./visualCache');
const imageClient = require('./imageGenerationClient');

// PHẦN 30: ngân sách thời gian RIÊNG cho toàn bộ hệ thống hình. Text answer luôn ưu tiên.
const VISUAL_DEADLINE_MS = Number(process.env.VISUAL_DEADLINE_MS) || 12000;
// Nếu deadline chung của request còn ít hơn mức này, KHÔNG bắt đầu tạo hình (defer/bỏ).
const MIN_REMAINING_FOR_VISUAL_MS = Number(process.env.MIN_REMAINING_FOR_VISUAL_MS) || 3000;

let visualSeq = 0;
function nextVisualId() { visualSeq = (visualSeq + 1) % 1e9; return `vz_${Date.now().toString(36)}_${visualSeq}`; }

/**
 * PHẦN 24 — CROSS-CHECK: chỉ tạo hình SAU reconciliation, và chỉ từ những VISUAL FACT ĐỒNG THUẬN.
 *
 * Nếu các candidate mâu thuẫn về dữ kiện hình (AI1 nói quỹ đạo hướng lên, AI2 hướng xuống), hệ
 * thống KHÔNG được vẽ theo candidate đầu tiên. Hàm này so các dữ kiện TRÍCH ĐƯỢC từ từng candidate
 * với dữ kiện trích từ FINAL ANSWER: fact nào mâu thuẫn với final answer bị LOẠI khỏi spec.
 *
 * @param {Array<{label:string,text:string}>} candidates
 * @param {string} finalAnswer
 * @returns {{conflicts:string[], agreed:boolean, checked:boolean}}
 */
function detectVisualFactConflicts(candidates, finalAnswer) {
  if (!Array.isArray(candidates) || candidates.length < 2) return { conflicts: [], agreed: true, checked: false };
  const finalQ = specBuilder.extractQuantities(finalAnswer);
  const finalMap = new Map(finalQ.map((q) => [q.symbol, `${q.value}${q.unit}`]));
  const conflicts = new Set();
  candidates.forEach((c) => {
    specBuilder.extractQuantities(String(c.text || '').slice(0, 3000)).forEach((q) => {
      const inFinal = finalMap.get(q.symbol);
      if (inFinal && inFinal !== `${q.value}${q.unit}`) conflicts.add(q.symbol);
    });
  });
  return { conflicts: [...conflicts], agreed: conflicts.size === 0, checked: true };
}

/**
 * runVisualPipeline() — chạy TOÀN BỘ hệ thống hình cho 1 câu trả lời ĐÃ HOÀN TẤT.
 *
 * @param {object} args
 * @param {string} args.question
 * @param {string} args.finalAnswer FINAL VERIFIED TEXT (sau reconcile nếu cross-check).
 * @param {boolean} args.answerComplete true khi state === COMPLETED (PHẦN 22: không cache partial).
 * @param {string} [args.subject]
 * @param {string} [args.language]
 * @param {string} [args.grade]
 * @param {string} [args.complexity]
 * @param {'auto'|'always'|'never'} [args.userPreference]
 * @param {Array} [args.candidates] candidate cross-check (nếu có) — dùng để phát hiện mâu thuẫn.
 * @param {object} [args.deadline] GLOBAL request deadline (chỉ ĐỌC, không tạo mới).
 * @param {AbortSignal} [args.signal]
 * @param {Function} [args.onEvent] (event) => void — 'visual:pending'|'visual:ready'|'visual:error'.
 * @param {object} [args.cacheKeyExtra] {promptVersion, sourceFingerprint, imageFingerprint}
 * @param {Function} [args.judge] (spec) => Promise<{useful:boolean, confidence:number}> — TẦNG 3
 *   (PHẦN 25), chỉ được gọi cho case borderline. Không truyền -> bỏ qua tầng 3.
 * @returns {Promise<{status:'skipped'|'ready'|'failed', decision:object, visuals:Array,
 *   telemetry:object}>}
 */
async function runVisualPipeline(args) {
  const t0 = Date.now();
  const {
    question = '', finalAnswer = '', answerComplete = false, subject = 'general',
    language = 'vi', grade = '', complexity = 'medium', userPreference = 'auto',
    candidates = null, deadline, signal, onEvent = () => {}, cacheKeyExtra = {}, judge
  } = args || {};

  const telemetry = {
    visualDecision: false, visualConfidence: 0, visualType: 'no_visual', visualRenderer: 'none',
    visualGenerated: false, visualCacheHit: false, visualGenerationLatency: 0,
    visualPromptTokens: 0, visualValidation: null, visualRepairCount: 0, visualError: null,
    visualConflicts: [], visualJudgeUsed: false
  };

  try {
    // ---------- PHẦN 30: kiểm tra ngân sách thời gian TRƯỚC KHI làm bất cứ gì ----------
    const remaining = deadline && typeof deadline.remaining === 'function' ? deadline.remaining() : Infinity;
    if (Number.isFinite(remaining) && remaining < MIN_REMAINING_FOR_VISUAL_MS) {
      telemetry.visualError = 'deferred_deadline';
      return { status: 'skipped', decision: null, visuals: [], telemetry };
    }

    // ---------- TẦNG 1+2: quyết định (0 token) ----------
    let decision = decisionEngine.evaluateVisualNeed({
      question, answerPlan: finalAnswer, subject, complexity, language, userPreference
    });

    // ---------- TẦNG 3: chỉ borderline mới hỏi model (PHẦN 25) ----------
    if (typeof judge === 'function' && decisionEngine.needsModelJudgement(decision)) {
      telemetry.visualJudgeUsed = true;
      try {
        const verdict = await judge({ question, subject, decision });
        if (verdict) decision = decisionEngine.applyModelJudgement(decision, verdict);
      } catch (e) { /* judge lỗi -> giữ nguyên quyết định heuristic, không ảnh hưởng text */ }
    }

    telemetry.visualDecision = decision.shouldGenerateImage;
    telemetry.visualConfidence = decision.confidence;
    telemetry.visualType = decision.visualType;

    if (!decision.shouldGenerateImage) {
      return { status: 'skipped', decision, visuals: [], telemetry };
    }

    // ---------- PHẦN 24: cross-check conflict detection TRƯỚC khi dựng spec ----------
    const conflict = detectVisualFactConflicts(candidates, finalAnswer);
    telemetry.visualConflicts = conflict.conflicts;
    // Mâu thuẫn KHÔNG làm bỏ hình: FINAL ANSWER đã là bản reconcile, nó là nguồn sự thật. Nhưng các
    // ký hiệu mâu thuẫn bị LOẠI khỏi spec để hình không bao giờ hiển thị số của candidate bị bác bỏ.
    onEvent({ type: 'visual:pending', visualType: decision.visualType, placement: decision.placement });

    // ---------- Dựng SPEC có cấu trúc (PHẦN 16) ----------
    const spec = specBuilder.buildVisualSpec({ decision, finalAnswer, question, subject, language, grade });
    if (conflict.conflicts.length) {
      spec.objects = spec.objects.filter((o) => !conflict.conflicts.includes(o.symbol)
        || String(finalAnswer).includes(`${o.symbol} = ${o.value}`));
    }

    // ---------- PHẦN 19: chọn renderer ----------
    const imageProviderAvailable = imageClient.isConfigured();
    const route = router.chooseVisualRenderer(spec, { imageProviderAvailable });
    telemetry.visualRenderer = route.renderer;

    // ---------- PHẦN 22: cache ----------
    const keyParts = {
      promptVersion: cacheKeyExtra.promptVersion || '',
      specFingerprint: specBuilder.specFingerprint(spec),
      answerStructureHash: cache.answerStructureHash(finalAnswer),
      subject, language: spec.language, style: spec.style, renderer: route.renderer,
      model: route.primary === 'image_generation' ? (imageClient.activeProviderName() || '') : 'deterministic',
      sourceFingerprint: cacheKeyExtra.sourceFingerprint || '',
      imageFingerprint: cacheKeyExtra.imageFingerprint || '',
      userPreference
    };
    const cached = cache.get(keyParts);
    if (cached) {
      telemetry.visualCacheHit = true;
      telemetry.visualGenerated = true;
      telemetry.visualGenerationLatency = Date.now() - t0;
      const visual = { ...cached, visualId: nextVisualId(), fromCache: true };
      onEvent({ ...visual, type: 'visual:ready' });
      return { status: 'ready', decision, visuals: [visual], telemetry };
    }

    // ---------- Sinh hình theo thứ tự: primary -> fallbacks ----------
    const attempts = [route.primary, ...route.fallbacks];
    const visualDeadlineAt = Date.now() + Math.min(VISUAL_DEADLINE_MS, Number.isFinite(remaining) ? remaining - 500 : VISUAL_DEADLINE_MS);
    let produced = null;
    let lastValidation = null;

    for (const attempt of attempts) {
      if (signal && signal.aborted) { telemetry.visualError = 'aborted'; break; }
      if (Date.now() > visualDeadlineAt) { telemetry.visualError = 'visual_deadline'; break; }
      if (attempt === 'no_visual') break;

      let out = null;
      if (attempt === 'deterministic' || attempt === 'concept_card') {
        const specForAttempt = attempt === 'concept_card' ? { ...spec, type: '__concept_card__' } : spec;
        const r = deterministic.renderDeterministic(specForAttempt);
        if (r.ok) out = { format: r.format, content: r.content, renderer: r.renderer };
        else telemetry.visualError = r.reason;
      } else if (attempt === 'image_generation') {
        // PHẦN 18: KHÔNG BAO GIỜ dùng image generation cho loại accuracy-critical.
        if (route.accuracyCritical) continue;
        const prompt = specBuilder.buildImagePrompt(spec);
        telemetry.visualPromptTokens = Math.ceil(prompt.length / 3.2);
        const img = await imageClient.generateImage({
          prompt, signal, timeoutMs: Math.max(2000, visualDeadlineAt - Date.now())
        });
        if (img.ok) out = { format: img.format, url: img.url, renderer: 'generated_image', model: img.model };
        else telemetry.visualError = img.reason;
      }

      if (!out) continue;

      // ---------- PHẦN 26: QUALITY GATE ----------
      const validation = validator.validateVisual({ spec, output: out, finalAnswer, expectedLanguage: spec.language });
      lastValidation = validation;
      if (validation.valid) { produced = { ...out, validation }; break; }
      telemetry.visualRepairCount++;
      // Không repair bằng cách gọi lại model nhiều lần: chuyển thẳng sang fallback kế tiếp
      // (deterministic/concept_card luôn rẻ và đúng hơn 1 vòng repair tốn token).
    }

    telemetry.visualValidation = lastValidation ? { valid: lastValidation.valid, issues: lastValidation.issues } : null;
    telemetry.visualGenerationLatency = Date.now() - t0;

    if (!produced) {
      // PHẦN 20/32: KHÔNG đánh dấu response failed chỉ vì hình thất bại.
      onEvent({ type: 'visual:error', recoverable: true, reason: telemetry.visualError || 'render_failed' });
      return { status: 'failed', decision, visuals: [], telemetry };
    }

    const visual = {
      visualId: nextVisualId(),
      type: spec.type,
      renderer: produced.renderer,
      format: produced.format,
      content: produced.content,
      url: produced.url,
      title: spec.title,
      caption: spec.purpose,
      placement: decision.placement,
      fromCache: false
    };

    // PHẦN 22: chỉ cache khi VALIDATED + COMPLETED.
    cache.set(keyParts, {
      type: visual.type, renderer: visual.renderer, format: visual.format,
      content: visual.content, url: visual.url, title: visual.title,
      caption: visual.caption, placement: visual.placement
    }, { validated: true, answerComplete });

    telemetry.visualGenerated = true;
    onEvent({ ...visual, type: 'visual:ready' });
    return { status: 'ready', decision, visuals: [visual], telemetry };
  } catch (e) {
    // Bất biến #1: KHÔNG BAO GIỜ throw ra ngoài.
    telemetry.visualError = 'pipeline_exception:' + (e && e.message);
    try { onEvent({ type: 'visual:error', recoverable: true, reason: 'pipeline_exception' }); } catch (_) { /* ignore */ }
    return { status: 'failed', decision: null, visuals: [], telemetry };
  }
}

module.exports = { runVisualPipeline, detectVisualFactConflicts, VISUAL_DEADLINE_MS, MIN_REMAINING_FOR_VISUAL_MS };
