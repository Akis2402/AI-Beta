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

// ============================================================================================
// B9.3 — IMAGE BUDGET GUARD: DEGRADE THEO MỨC, KHÔNG PHẢI NHỊ PHÂN CÓ/KHÔNG
// ============================================================================================
// requestBudgetPlanner.js đã tách `visualBudget` riêng (không lấn answerBudget). Bổ sung ở đây:
// khi deadline TỔNG của request sắp cạn tại đúng thời điểm quyết định tạo hình, hệ thống hạ cấp
// dần thay vì hoặc-làm-đầy-đủ-hoặc-bỏ:
//   HIGH      : full visual (deterministic hoặc image gen theo router).
//   MEDIUM    : prompt gọn hơn + hình đơn giản hơn (bỏ annotation phụ trong spec).
//   LOW       : KHÔNG gọi image API, chỉ còn đường deterministic (0 token, 0 mạng).
//   EMERGENCY : bỏ hoàn toàn (ngưỡng MIN_REMAINING_FOR_VISUAL_MS đã có sẵn, giữ nguyên 3000ms).
const DEGRADE_MEDIUM_MS = Number(process.env.VISUAL_DEGRADE_MEDIUM_MS) || 8000;
const DEGRADE_LOW_MS = Number(process.env.VISUAL_DEGRADE_LOW_MS) || 5000;

/**
 * resolveVisualDegradeLevel() — mức hạ cấp theo thời gian còn lại của request.
 * @param {number} remainingMs Infinity khi không có deadline (chạy ngoài request thật/test).
 * @returns {'high'|'medium'|'low'|'emergency'}
 */
function resolveVisualDegradeLevel(remainingMs) {
  if (!Number.isFinite(remainingMs)) return 'high';
  if (remainingMs < MIN_REMAINING_FOR_VISUAL_MS) return 'emergency';
  if (remainingMs < DEGRADE_LOW_MS) return 'low';
  if (remainingMs < DEGRADE_MEDIUM_MS) return 'medium';
  return 'high';
}

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
    visualConflicts: [], visualJudgeUsed: false,
    // B9.3/B9.15/A4: quan sát được mức hạ cấp, chi phí ảnh, và các provider đã thử.
    visualDegradeLevel: 'high', visualCostClass: null, visualProvidersTried: [],
    visualNecessity: 'NONE',
    // Rủi ro #3: mức TRUNG THỰC của hình. 'schematic_only' = đề cần hình thật nhưng hệ thống chỉ
    // dựng được sơ đồ (chưa cấu hình image provider) — người vận hành cần thấy con số này, nếu
    // không sẽ tưởng hệ thống đang phục vụ tốt trong khi hình chỉ hữu ích hạn chế.
    visualFidelity: 'schematic', visualRealismRequired: false, visualUpgradeHint: null
  };

  try {
    // ---------- PHẦN 30: kiểm tra ngân sách thời gian TRƯỚC KHI làm bất cứ gì ----------
    const remaining = deadline && typeof deadline.remaining === 'function' ? deadline.remaining() : Infinity;
    const degrade = resolveVisualDegradeLevel(remaining);
    telemetry.visualDegradeLevel = degrade;
    if (degrade === 'emergency') {
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

    telemetry.visualNecessity = decision.imageNecessity || 'NONE';
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
    // B9.3 mức MEDIUM: bỏ bớt annotation phụ để prompt/hình gọn hơn — KHÔNG bỏ nhãn/entity chính
    // (chúng là thứ visualValidator kiểm tra, bỏ đi là hình sai).
    if (degrade === 'medium' && Array.isArray(spec.annotations) && spec.annotations.length > 2) {
      spec.annotations = spec.annotations.slice(0, 2);
    }
    if (conflict.conflicts.length) {
      spec.objects = spec.objects.filter((o) => !conflict.conflicts.includes(o.symbol)
        || String(finalAnswer).includes(`${o.symbol} = ${o.value}`));
    }

    // ---------- PHẦN 19: chọn renderer ----------
    const imageProviderAvailable = imageClient.isConfigured();
    const route = router.chooseVisualRenderer(spec, { imageProviderAvailable });
    telemetry.visualRenderer = route.renderer;
    telemetry.visualRealismRequired = !!route.realismRequired;
    telemetry.visualFidelity = route.fidelity || 'schematic';
    telemetry.visualUpgradeHint = route.upgradeHint || null;

    // ---------- PHẦN 22: cache ----------
    const keyParts = {
      promptVersion: cacheKeyExtra.promptVersion || '',
      specFingerprint: specBuilder.specFingerprint(spec),
      answerStructureHash: cache.answerStructureHash(finalAnswer),
      subject, language: spec.language, renderer: route.renderer,
      model: route.primary === 'image_generation' ? (imageClient.activeProviderName() || '') : 'deterministic',
      sourceFingerprint: cacheKeyExtra.sourceFingerprint || '',
      imageFingerprint: cacheKeyExtra.imageFingerprint || '',
      // Rủi ro #3: `renderer` đã nằm trong key, nhưng thêm fidelity để một bản sơ đồ "schematic_only"
      // không bao giờ được trả lại sau khi image provider đã được cấu hình.
      style: `${spec.style}#${route.fidelity || 'schematic'}`,
      userPreference
    };
    // A5: bản async -> cache hit được CẢ khi hình do một serverless instance KHÁC tạo ra.
    const cached = await cache.getAsync(keyParts);
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
        // B9.3 mức LOW: hết thời gian cho một lượt gọi mạng — chỉ giữ đường deterministic.
        if (degrade === 'low') { telemetry.visualError = 'degraded_no_image_gen'; continue; }
        // B9.15: visual benefit THẤP (OPTIONAL, không phải USER_REQUESTED/NECESSARY) mà chi phí ảnh
        // CAO -> không đốt tiền cho một hình "có cũng được". Yêu cầu tường minh vẫn được ưu tiên,
        // nhưng vẫn chịu deadline/budget guard ở trên (không bypass hoàn toàn).
        const costClass = imageClient.classifyImageCost({ provider: imageClient.activeProviderName(), size: '1024x1024' });
        telemetry.visualCostClass = costClass;
        const necessity = decision.imageNecessity || 'NONE';
        if (costClass === 'IMAGE_COST_HIGH' && (necessity === 'OPTIONAL' || necessity === 'NONE')) {
          telemetry.visualError = 'cost_gate_low_benefit';
          continue;
        }
        const prompt = specBuilder.buildImagePrompt(spec);
        telemetry.visualPromptTokens = Math.ceil(prompt.length / 3.2);
        const img = await imageClient.generateImage({
          prompt, signal, timeoutMs: Math.max(2000, visualDeadlineAt - Date.now()),
          deadlineAt: visualDeadlineAt // A4: failover sang provider 2 chỉ khi còn đủ thời gian
        });
        telemetry.visualProvidersTried = img.providersTried || [];
        if (img.costClass) telemetry.visualCostClass = img.costClass;
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

    // Rủi ro #3: nói THẲNG mức trung thực trong caption khi đề cần hình thật mà chỉ có sơ đồ. Người
    // học phải biết đây là sơ đồ khái niệm, không phải hình giải phẫu/bản đồ thật — im lặng ở đây là
    // để họ hiểu nhầm về thứ đang nhìn.
    const schematicOnly = route.realismRequired && produced.renderer !== 'generated_image';
    const schematicNote = spec.language === 'en'
      ? ' (conceptual schematic — not a true anatomical/topographic figure)'
      : ' (sơ đồ khái niệm — không phải hình giải phẫu/bản đồ thực tế)';

    const visual = {
      visualId: nextVisualId(),
      type: spec.type,
      renderer: produced.renderer,
      format: produced.format,
      content: produced.content,
      url: produced.url,
      title: spec.title,
      caption: (spec.purpose || '') + (schematicOnly ? schematicNote : ''),
      fidelity: schematicOnly ? 'schematic_only' : (route.fidelity || 'schematic'),
      // B9.9: UI cần phân biệt hình TỰ ĐỘNG sinh với hình do người dùng yêu cầu tường minh (và
      // trường hợp override setting "never" thì phải nói rõ vì sao vẫn có hình).
      necessity: decision.imageNecessity || 'NONE',
      overrodeNever: !!decision.overrodeNever,
      placement: decision.placement,
      fromCache: false
    };
    if (schematicOnly) telemetry.visualFidelity = 'schematic_only';

    // PHẦN 22: chỉ cache khi VALIDATED + COMPLETED.
    await cache.setAsync(keyParts, {
      type: visual.type, renderer: visual.renderer, format: visual.format,
      content: visual.content, url: visual.url, title: visual.title,
      caption: visual.caption, placement: visual.placement,
      fidelity: visual.fidelity, necessity: visual.necessity, overrodeNever: visual.overrodeNever
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

module.exports = {
  runVisualPipeline, detectVisualFactConflicts, resolveVisualDegradeLevel,
  VISUAL_DEADLINE_MS, MIN_REMAINING_FOR_VISUAL_MS, DEGRADE_MEDIUM_MS, DEGRADE_LOW_MS
};
