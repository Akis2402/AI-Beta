'use strict';

// Thời gian TỐI THIỂU còn lại để một lệnh gọi ảnh có cơ hội hoàn tất ở mức degrade 'low'.
const MIN_IMAGE_CALL_MS = Number(process.env.MIN_IMAGE_CALL_MS) || 4000;

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
const hqStore = require('./visualHqStore');

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
    candidates = null, deadline, signal, onEvent = () => {}, cacheKeyExtra = {}, judge,
    // ROOT CAUSE B (mục 2.3): nội dung stage 'approach' — CHỈ dùng làm nguồn trích xuất thực thể
    // cho spec, không bao giờ được coi là câu trả lời.
    approachText = ''
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
    const spec = specBuilder.buildVisualSpec({ decision, finalAnswer, question, subject, language, grade, approachText });
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
    // MỤC 1.1: quan sát được vì sao một bài physics/optics đi ảnh hay đi SVG.
    telemetry.visualNeedsPreciseGeometry = !!spec.needsPreciseGeometry;
    telemetry.visualRouteReason = route.reason;
    telemetry.visualRealismRequired = !!route.realismRequired;
    telemetry.visualFidelity = route.fidelity || 'schematic';
    telemetry.visualUpgradeHint = route.upgradeHint || null;

    // ---------- PHẦN 22: cache ----------
    const keyParts = {
      // MỤC 1.2: phiên bản prompt ẢNH nằm trong key -> ảnh sinh bởi prompt cũ (còn nhét số liệu)
      // KHÔNG BAO GIỜ được trả lại sau khi buildImagePrompt() đã sửa.
      promptVersion: `${cacheKeyExtra.promptVersion || ''}|${specBuilder.VISUAL_PROMPT_VERSION}`,
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
      // Bản cache đã mang sẵn cờ fallbackSchematic từ lần dựng đầu — đọc lại từ chính nó, không
      // tính lại (ở đây chưa có `produced` nên không có gì để so).
      return {
        status: visual.fallbackSchematic ? 'fallback_schematic' : 'ready',
        decision, visuals: [visual], telemetry
      };
    }

    // ---------- Sinh hình theo thứ tự: primary -> fallbacks ----------
    const attempts = [route.primary, ...route.fallbacks];
    const visualDeadlineAt = Date.now() + Math.min(VISUAL_DEADLINE_MS, Number.isFinite(remaining) ? remaining - 500 : VISUAL_DEADLINE_MS);
    let produced = null;
    let lastValidation = null;
    let lastImagePrompt = null;
    let lastAttemptedImagePrompt = null;

    for (const attempt of attempts) {
      if (signal && signal.aborted) { telemetry.visualError = 'aborted'; break; }
      if (Date.now() > visualDeadlineAt) { telemetry.visualError = 'visual_deadline'; break; }
      if (attempt === 'no_visual') break;

      let out = null;
      if (attempt === 'deterministic' || attempt === 'concept_card') {
        const specForAttempt = attempt === 'concept_card' ? { ...spec, type: '__concept_card__' } : spec;
        const r = deterministic.renderDeterministic(specForAttempt);
        // MỤC 7 (đợt audit 2) — bất biến: renderer='generated_image' CHỈ khi origin='ai_generated'.
        // Đường deterministic luôn gắn origin='deterministic', không bao giờ để lẫn.
        if (r.ok) out = { format: r.format, content: r.content, renderer: r.renderer, origin: 'deterministic' };
        else telemetry.visualError = r.reason;
      } else if (attempt === 'image_generation') {
        // PHẦN 18: KHÔNG BAO GIỜ dùng image generation cho loại accuracy-critical.
        if (route.accuracyCritical) continue;
        // ---------- MỤC 2.4a: ẢNH AI LÀ LỰA CHỌN ĐƯỢC THỬ ĐẦU TIÊN cho nhóm minh hoạ ----------
        // BUG CŨ: `if (degrade === 'low') continue;` chặn CỨNG image generation cho MỌI mức
        // necessity. Một hình BẮT BUỘC (NECESSARY) hoặc được người dùng YÊU CẦU TƯỜNG MINH
        // (USER_REQUESTED) vẫn bị đá sang SVG chỉ vì ngân sách thời gian đang ở mức thấp — mâu thuẫn
        // với chính nguyên tắc "yêu cầu tường minh của người dùng ở ưu tiên cao nhất".
        // NAY: mức `low` chỉ bỏ ảnh cho necessity OPTIONAL/NONE (giữ nguyên hành vi cũ ở đó); với
        // NECESSARY/USER_REQUESTED vẫn THỬ, nhưng với ngân sách đã co lại (timeout ngắn hơn, ảnh nhỏ
        // hơn) để phù hợp thời gian còn lại. Mức `emergency` KHÔNG đổi: vẫn bỏ hình hoàn toàn (đã
        // return sớm ở đầu hàm).
        const necessityNow = decision.imageNecessity || 'NONE';
        const highNeed = necessityNow === 'NECESSARY' || necessityNow === 'USER_REQUESTED';
        if (degrade === 'low' && !highNeed) { telemetry.visualError = 'degraded_no_image_gen'; continue; }
        // Ở mức `low` vẫn phải còn đủ thời gian cho ÍT NHẤT một lệnh gọi, nếu không thì thử là vô ích.
        const lowBudgetMs = visualDeadlineAt - Date.now();
        if (degrade === 'low' && lowBudgetMs < MIN_IMAGE_CALL_MS) {
          telemetry.visualError = 'degraded_no_time_for_image';
          continue;
        }
        // PHẦN X/XI (đợt audit 6): size không còn CỐ ĐỊNH vuông ('1024x1024'/'512x512' cho mọi loại
        // hình) — nay suy ra từ spec.aspectRatio (PHẦN XI) + quality mode (PHẦN X, mặc định
        // 'standard', hạ về 'fast' khi degrade==='low' — vẫn giữ đúng bất biến cũ: mức low hạ kích
        // thước chứ không bỏ hẳn ảnh cho necessity cao).
        const sizing = imageClient.sizeForRequest({ aspectRatio: spec.aspectRatio, quality: 'standard', degrade });
        const imageSize = sizing.size;
        // B9.15: visual benefit THẤP (OPTIONAL, không phải USER_REQUESTED/NECESSARY) mà chi phí ảnh
        // CAO -> không đốt tiền cho một hình "có cũng được". Yêu cầu tường minh vẫn được ưu tiên,
        // nhưng vẫn chịu deadline/budget guard ở trên (không bypass hoàn toàn).
        const costClass = imageClient.classifyImageCost({ provider: imageClient.activeProviderName(), size: imageSize });
        telemetry.visualCostClass = costClass;
        const necessity = necessityNow;
        if (costClass === 'IMAGE_COST_HIGH' && (necessity === 'OPTIONAL' || necessity === 'NONE')) {
          telemetry.visualError = 'cost_gate_low_benefit';
          continue;
        }
        // MỤC 2.1: cắt prompt theo hạn mức ký tự CỨNG của provider trước khi gửi đi.
        const maxChars = imageClient.activePromptCharLimit() || specBuilder.DEFAULT_PROMPT_CHAR_LIMIT;
        const prompt = specBuilder.buildImagePrompt(spec, { maxChars });
        telemetry.visualPromptTokens = Math.ceil(prompt.length / 3.2);
        const img = await imageClient.generateImage({
          prompt, signal, size: imageSize, aspectRatio: sizing.aspectRatio, quality: sizing.quality,
          timeoutMs: Math.max(2000, visualDeadlineAt - Date.now()),
          deadlineAt: visualDeadlineAt // A4: failover sang provider 2 chỉ khi còn đủ thời gian
        });
        telemetry.visualProvidersTried = img.providersTried || [];
        // MỤC 2.2 + 17: nhớ prompt + necessity + title/type của đúng hình này. Trước đây CHỈ được
        // nhớ khi thành công (phục vụ nút "Tải PNG chất lượng cao"). BUG: khi image generation THẤT
        // BẠI — đúng ca cần nút "Thử tạo lại" nhất — không có gì được nhớ, nên retry endpoint không
        // có prompt nào để gọi lại. Nay LUÔN nhớ (kể cả khi fail), để nhánh !produced bên dưới có
        // thể phát cho client một stub kèm visualId dùng được cho POST /api/visual/retry.
        const promptCtx = { prompt, necessity: decision.imageNecessity || 'NONE', subject, title: spec.title, type: spec.type };
        lastAttemptedImagePrompt = promptCtx;
        if (img.ok) lastImagePrompt = promptCtx;
        if (img.costClass) telemetry.visualCostClass = img.costClass;
        // MỤC 7/8 (đợt audit 2) — img.ok=true GIỜ CHỈ xảy ra sau khi imageGenerationClient đã tự
        // validate binary thật (base64 qua verifyImageBytes, URL qua fetch+validateImageBuffer —
        // xem callOpenAICompatibleImage). Vì vậy tới đây, origin='ai_generated' là PHÁT BIỂU ĐÚNG,
        // không phải suy đoán từ "API trả 200".
        if (img.ok) out = { format: img.format, url: img.url, renderer: 'generated_image', origin: 'ai_generated', model: img.model, urlVerified: !!img.urlVerified };
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
      // PHẦN 20/32: KHÔNG đánh dấu response failed chỉ vì hình thất bại — text answer giữ nguyên.
      onEvent({ type: 'visual:error', recoverable: true, reason: telemetry.visualError || 'render_failed' });

      // ==========================================================================================
      // MỤC 16/17/36 CASE C — TOÀN BỘ đường ảnh THẤT BẠI (kể cả deterministic/concept_card, vốn
      // gần như không bao giờ hỏng) mà đây là hình NGƯỜI DÙNG YÊU CẦU TƯỜNG MINH hoặc NECESSARY:
      // KHÔNG được lặng lẽ trả visuals rỗng, vì UI sẽ chỉ còn 1 dòng "không thể tạo hình" và người
      // dùng không có cách nào yêu cầu thử lại mà không phải hỏi lại toàn bộ câu hỏi. Phát ra 1 stub
      // {visualId, renderFailed:true} kèm ngữ cảnh đã lưu vào visualHqStore để POST /api/visual/retry
      // gọi lại ĐÚNG prompt này mà không cần dựng lại lời giải.
      const necessity = decision.imageNecessity || 'NONE';
      const imageWasIntended = route.primary === 'image_generation';
      const worthRetry = imageWasIntended && (necessity === 'NECESSARY' || necessity === 'USER_REQUESTED') && lastAttemptedImagePrompt;
      if (!worthRetry) return { status: 'failed', decision, visuals: [], telemetry };

      const visualId = nextVisualId();
      hqStore.remember(visualId, lastAttemptedImagePrompt);
      const failedVisual = {
        visualId, renderFailed: true, necessity,
        title: lastAttemptedImagePrompt.title || spec.title,
        subject: lastAttemptedImagePrompt.subject || subject,
        reason: telemetry.visualError || 'image_generation_failed'
      };
      onEvent({ ...failedVisual, type: 'visual:error', recoverable: true });
      return { status: 'failed', decision, visuals: [failedVisual], telemetry };
    }

    // Rủi ro #3: nói THẲNG mức trung thực trong caption khi đề cần hình thật mà chỉ có sơ đồ. Người
    // học phải biết đây là sơ đồ khái niệm, không phải hình giải phẫu/bản đồ thật — im lặng ở đây là
    // để họ hiểu nhầm về thứ đang nhìn.
    const schematicOnly = route.realismRequired && produced.renderer !== 'generated_image';
    const schematicNote = spec.language === 'en'
      ? ' (conceptual schematic — not a true anatomical/topographic figure)'
      : ' (sơ đồ khái niệm — không phải hình giải phẫu/bản đồ thực tế)';

    // ---------- MỤC 2.7: TRẠNG THÁI `fallback_schematic` ----------
    // Phân biệt HAI ca hoàn toàn khác nhau mà UI cũ gộp làm một ("có visual = thành công"):
    //   (a) vốn dĩ LUÔN là deterministic vì accuracy-critical (đồ thị, mạch điện) -> đúng như thiết kế;
    //   (b) LẼ RA được ảnh AI (route.primary = 'image_generation', provider khả dụng) nhưng đã rơi
    //       xuống deterministic vì provider lỗi/hết thời gian -> người dùng đang nhìn một BẢN THAY THẾ.
    // Chỉ ca (b) mới được gắn nhãn fallback; ca (a) im lặng vì không có gì để nói.
    const imageWasIntended = route.primary === 'image_generation';
    const isFallbackSchematic = imageWasIntended && produced.renderer !== 'generated_image';
    telemetry.visualFallbackSchematic = isFallbackSchematic;

    const visual = {
      visualId: nextVisualId(),
      // UI đọc cờ này để hiện nhãn nhỏ "sơ đồ thay thế" thay vì coi như ảnh AI thành công.
      fallbackSchematic: isFallbackSchematic,
      fallbackReason: isFallbackSchematic ? (telemetry.visualError || 'image_generation_unavailable') : null,
      type: spec.type,
      subject: spec.subject || subject || 'visual',
      renderer: produced.renderer,
      // MỤC 7 (đợt audit 2): trường origin đi kèm renderer ra tới tận response — frontend/telemetry
      // đều đọc được đây là ảnh AI thật ('ai_generated') hay sơ đồ dựng sẵn ('deterministic'),
      // không phải suy luận ngược từ renderer nữa.
      origin: produced.origin,
      format: produced.format,
      content: produced.content,
      url: produced.url,
      title: spec.title,
      // Phòng thủ 2 lớp: nếu vì lý do gì đó spec.purpose trùng y hệt spec.title (vd fallback cũ,
      // hoặc case chưa lường hết), KHÔNG gửi nó làm caption — client (renderVisualCaption) đã hiển
      // thị title ở header rồi, gửi trùng xuống chỉ tạo ra chuỗi lặp lại vô nghĩa trong 1 card.
      caption: ((spec.purpose || '').trim() === (spec.title || '').trim() ? '' : (spec.purpose || ''))
        + (schematicOnly ? schematicNote : ''),
      fidelity: schematicOnly ? 'schematic_only' : (isFallbackSchematic ? 'fallback_schematic' : (route.fidelity || 'schematic')),
      // B9.9: UI cần phân biệt hình TỰ ĐỘNG sinh với hình do người dùng yêu cầu tường minh (và
      // trường hợp override setting "never" thì phải nói rõ vì sao vẫn có hình).
      necessity: decision.imageNecessity || 'NONE',
      overrodeNever: !!decision.overrodeNever,
      placement: decision.placement,
      // MỤC 1.3: số liệu/nhãn/công thức ĐÃ XÁC THỰC đi kèm response để client vẽ đè lên ảnh AI.
      // Ảnh AI không còn chứa số (mục 1.2) nên đây là lưới an toàn: người học chỉ nhìn thấy số
      // đến từ lời giải đã verify. KHÔNG tốn thêm lệnh gọi AI nào (mục 2.5).
      overlay: produced.renderer === 'generated_image' ? specBuilder.buildVisualOverlay(spec) : null,
      fromCache: false
    };
    if (schematicOnly) telemetry.visualFidelity = 'schematic_only';
    if (lastImagePrompt && produced.renderer === 'generated_image') {
      hqStore.remember(visual.visualId, lastImagePrompt);
    }

    // PHẦN 22: chỉ cache khi VALIDATED + COMPLETED.
    await cache.setAsync(keyParts, {
      type: visual.type, subject: visual.subject, renderer: visual.renderer, origin: visual.origin, format: visual.format,
      content: visual.content, url: visual.url, title: visual.title,
      caption: visual.caption, placement: visual.placement,
      fidelity: visual.fidelity, necessity: visual.necessity, overrodeNever: visual.overrodeNever,
      overlay: visual.overlay
    }, { validated: true, answerComplete });

    telemetry.visualGenerated = true;
    onEvent({ ...visual, type: 'visual:ready' });
    return { status: isFallbackSchematic ? 'fallback_schematic' : 'ready', decision, visuals: [visual], telemetry };
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
