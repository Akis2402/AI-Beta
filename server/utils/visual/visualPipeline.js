'use strict';
const crypto = require('crypto');

// Thời gian TỐI THIỂU còn lại để một lệnh gọi ảnh có cơ hội hoàn tất ở mức degrade 'low'.
const MIN_IMAGE_CALL_MS = Number(process.env.MIN_IMAGE_CALL_MS) || 4000;

// ============================================================================================
// VISUAL PIPELINE — AI IMAGE ONLY (KHÔNG BAO GIỜ BLOCK / LÀM HỎNG TEXT ANSWER)
// ============================================================================================
// Hợp đồng tuyệt đối của module này:
//
//   1. KHÔNG BAO GIỜ throw. Mọi lỗi -> {status:'failed'} + text answer vẫn nguyên vẹn.
//   2. KHÔNG BAO GIỜ chạy trước khi text answer hoàn tất (hình phải dựng từ FINAL VERIFIED FACTS).
//   3. Có VISUAL DEADLINE RIÊNG, tách khỏi text deadline. Hết hạn -> bỏ hình, không bao giờ để
//      timeout ảnh giết cả request.
//   4. HYBRID VISUAL ENGINE: visualDeterminationEngine chọn renderer TRƯỚC. Nội dung tất định của
//      Toán/Lý/Hoá dựng được chính xác -> SVG tất định (0 token, 0 lệnh gọi image model, KHÔNG cần
//      Puter). Còn lại -> ảnh AI (Puter client-primary hoặc provider server): thất bại -> failover ->
//      tối đa 1 lần repair -> 'failed' + stub retry. SVG chỉ được dựng bằng code (deterministic/),
//      không bao giờ do LLM viết, và luôn qua validateSvg() trước khi rời server.
//   5. Scene 3D TƯƠNG TÁC không đi qua đây: Three.js (solid3d.js/scene3d.js) render từ khối
//      ```solid3d/```scene3d trong chính câu trả lời. Pipeline chỉ ghi nhận và bỏ qua.
//
// Trạng thái trả về: 'skipped' | 'ready' | 'failed'.

const decisionEngine = require('./visualDecisionEngine');
const specBuilder = require('./visualSpecBuilder');
const router = require('./visualRendererRouter');
const validator = require('./visualValidator');
const cache = require('./visualCache');
const imageClient = require('./imageGenerationClient');
const hqStore = require('./visualHqStore');
const responseGuard = require('./visualResponseGuard');
const determinationEngine = require('./visualDeterminationEngine');
const deterministic = require('./deterministic');

// Ngân sách thời gian RIÊNG cho toàn bộ hệ thống hình. Text answer luôn ưu tiên.
const VISUAL_DEADLINE_MS = Number(process.env.VISUAL_DEADLINE_MS) || 12000;
// Nếu deadline chung của request còn ít hơn mức này, KHÔNG bắt đầu tạo hình (defer/bỏ).
const MIN_REMAINING_FOR_VISUAL_MS = Number(process.env.MIN_REMAINING_FOR_VISUAL_MS) || 3000;

// ============================================================================================
// IMAGE BUDGET GUARD: DEGRADE THEO MỨC, KHÔNG PHẢI NHỊ PHÂN CÓ/KHÔNG
// ============================================================================================
//   HIGH      : full visual (prompt đầy đủ, chất lượng standard).
//   MEDIUM    : prompt gọn hơn (bỏ annotation phụ), ảnh đơn giản hơn.
//   LOW       : chỉ còn tạo ảnh cho hình NECESSARY/USER_REQUESTED, kích thước/quality hạ xuống.
//   EMERGENCY : bỏ hoàn toàn (ngưỡng MIN_REMAINING_FOR_VISUAL_MS).
// Lưu ý: mức LOW trước đây rơi về deterministic renderer — nay KHÔNG còn đường đó nữa, LOW chỉ
// thu hẹp phạm vi tạo ảnh chứ không sinh hình thay thế.
const DEGRADE_MEDIUM_MS = Number(process.env.VISUAL_DEGRADE_MEDIUM_MS) || 8000;
const DEGRADE_LOW_MS = Number(process.env.VISUAL_DEGRADE_LOW_MS) || 5000;

// Số lần repair TỐI ĐA bằng image AI khi validate trượt (yêu cầu sản phẩm: đúng 1 lần).
const MAX_IMAGE_REPAIR = 1;

// ============================================================================================
// MỤC 31/32/34 — HARD LOCK VÒNG ĐỜI HÌNH THEO STAGE
// ============================================================================================
// Bất biến: MỘT request = MỘT vòng đời hình, và vòng đời đó thuộc về stage 'approach' (hoặc nhánh
// \"chỉ lấy hình\"). Trước bản này, `stage` KHÔNG hề tồn tại trong chữ ký runVisualPipeline(): stage
// 'detail' đi qua ĐÚNG cùng một đường — decisionEngine -> judge -> specBuilder -> imageClient — nên
// mỗi lần người dùng bấm \"Giải chi tiết\" là một lần sinh ảnh nữa (và có thể thêm một lệnh gọi judge).
//
// Khoá được đặt ở ĐÂY chứ không phải chỉ ở route: đây là điểm vào DUY NHẤT của hệ thống hình, nên
// mọi đường gọi (streaming, JSON, cross-check, continuation, retry) đều bị chặn cùng một chỗ, không
// phụ thuộc người sửa route sau này có nhớ thêm guard hay không (mục 77: không vá bằng 1 câu `if`).
const GENERATING_STAGES = new Set(['approach', 'image_only']);
function stageMayGenerate(stage) {
  return GENERATING_STAGES.has(String(stage == null ? 'approach' : stage).toLowerCase());
}

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

/** Bản tóm tắt an toàn (không kèm SVG) của quyết định — để log/telemetry/test. */
function summarizeDetermination(d) {
  return {
    shouldVisualize: d.shouldVisualize, visualType: d.visualType, subject: d.subject, category: d.category, confidence: d.confidence,
    deterministic: d.deterministic, userRequested: d.userRequested, reason: d.reason, authRequired: d.authRequired, puterAuth: d.puterAuth
  };
}

let visualSeq = 0;
function nextVisualId() { visualSeq = (visualSeq + 1) % 1e9; return `vz_${Date.now().toString(36)}_${visualSeq}`; }

/**
 * CROSS-CHECK: chỉ tạo hình SAU reconciliation, và chỉ từ những VISUAL FACT ĐỒNG THUẬN.
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
 * @param {boolean} args.answerComplete true khi state === COMPLETED (không cache partial).
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
 * @param {Function} [args.judge] (spec) => Promise<{useful:boolean, confidence:number}>
 * @returns {Promise<{status:'skipped'|'ready'|'failed', decision:object, visuals:Array,
 *   telemetry:object}>}
 */
async function runVisualPipeline(args) {
  const t0 = Date.now();
  const {
    question = '', finalAnswer = '', answerComplete = false, subject = 'general',
    language = 'vi', grade = '', complexity = 'medium', userPreference = 'auto',
    candidates = null, deadline, signal, onEvent = () => {}, cacheKeyExtra = {}, judge,
    // Nội dung stage 'approach' — CHỈ dùng làm nguồn trích xuất thực thể cho spec, không bao giờ
    // được coi là câu trả lời.
    approachText = '',
    // MỤC 31/32: stage của request. Mặc định 'approach' để mọi call-site/test cũ giữ NGUYÊN hành vi.
    stage = 'approach',
    // MỤC 33: visual đã có từ vòng đời Approach (server load qua visualStateStore) — Detail chỉ
    // được DÙNG LẠI đúng tập này.
    existingVisuals = null, inputImageIds = [],
    // Trạng thái Auth Puter do CLIENT báo ('authenticated'|'unauthenticated'|'unknown'|'error').
    puterAuth = 'unknown',
    // Câu gốc của người dùng (còn nguyên động từ "vẽ…"/"cấu hình…"). Nhánh image-only chỉ giữ `question` = CHỦ ĐỀ đã bị
    // cắt động từ; SVG tất định cần câu gốc để nhận diện dữ kiện, còn ảnh AI vẫn dùng chủ đề gọn.
    rawQuestion = ''
  } = args || {};

  const telemetry = {
    visualDecision: false, visualConfidence: 0, visualType: 'no_visual', visualRenderer: 'none',
    visualGenerated: false, visualCacheHit: false, visualGenerationLatency: 0,
    visualPromptTokens: 0, visualValidation: null, visualRepairCount: 0, visualError: null,
    visualConflicts: [], visualJudgeUsed: false,
    visualDegradeLevel: 'high', visualCostClass: null, visualProvidersTried: [],
    visualNecessity: 'NONE',
    visualFidelity: 'ai_generated', visualRealismRequired: false, visualUpgradeHint: null,
    visualHighPrecision: false,
    // ---------- MỤC 34: đếm ĐÚNG những thứ tốn tiền, tách khỏi nhau ----------
    // visualGenerationLifecycleCount: số VÒNG ĐỜI sinh hình (0 hoặc 1 cho mỗi request).
    // visualProviderAttempts: số lệnh gọi API THẬT tới image provider (có thể > 1 khi failover) —
    // hai con số này KHÁC NHAU và không bao giờ được gộp làm một (mục 35).
    visualStage: stage,
    visualLifecycleLocked: false,
    visualGenerationLifecycleCount: 0,
    visualProviderAttempts: 0,
    visualProviderFailures: 0,
    visualRetryCount: 0,
    visualJudgeCalls: 0,
    visualReused: false,
    // ---------- Hybrid Visual Engine ----------
    visualDeterministic: false, visualSpecHash: null, visualSvgBytes: 0, visualSvgCacheHit: false,
    visualDeterminationReason: null, visualCategory: null, visualPuterAuth: 'unknown', visualAuthRequired: false
  };

  try {
    // ---------- MỤC 31/32: STAGE KHÔNG ĐƯỢC SINH HÌNH -> DÙNG LẠI, KHÔNG ĐI TIẾP ----------
    // Trả về TRƯỚC decisionEngine/judge/specBuilder/imageClient. Không phải \"guard thêm\" mà là một
    // nhánh trả về riêng: mọi lệnh gọi tốn token/tiền nằm SAU điểm này nên không thể lọt qua.
    if (!stageMayGenerate(stage)) {
      telemetry.visualLifecycleLocked = true;
      const reuse = Array.isArray(existingVisuals)
        ? existingVisuals.filter((v) => v && (v.url || v.format === 'image_url' || v.format === 'data_url' || (v.format === 'svg' && v.svg)))
        : [];
      if (reuse.length) {
        telemetry.visualReused = true;
        telemetry.visualType = reuse[0].type || telemetry.visualType;
        telemetry.visualRenderer = reuse[0].renderer || (reuse[0].format === 'svg' ? 'deterministic_svg' : 'generated_image');
        reuse.forEach((v) => onEvent({ ...v, type: 'visual:ready', reused: true }));
        return { status: 'reused', decision: null, visuals: reuse, telemetry };
      }
      // Approach chưa từng sinh hình (hoặc state không còn) -> Detail KHÔNG được tự bù vào.
      telemetry.visualError = 'lifecycle_locked_no_existing_visual';
      return { status: 'skipped', decision: null, visuals: [], telemetry };
    }

    // ---------- Kiểm tra ngân sách thời gian TRƯỚC KHI làm bất cứ gì ----------
    const remaining = deadline && typeof deadline.remaining === 'function' ? deadline.remaining() : Infinity;
    const degrade = resolveVisualDegradeLevel(remaining);
    telemetry.visualDegradeLevel = degrade;
    if (degrade === 'emergency') {
      // SVG tất định không tốn thời gian mạng -> vẫn cho qua khi dựng được; mọi thứ còn lại bị hoãn như cũ.
      let svgProbe = null;
      try { svgProbe = deterministic.tryRender(rawQuestion || question, subject); } catch (_) { svgProbe = null; }
      if (!svgProbe || svgProbe.status !== 'rendered') {
        telemetry.visualError = 'deferred_deadline';
        return { status: 'skipped', decision: null, visuals: [], telemetry };
      }
    }

    // ---------- TẦNG 1+2: quyết định (0 token) ----------
    let decision = decisionEngine.evaluateVisualNeed({
      question, answerPlan: finalAnswer, subject, complexity, language, userPreference
    });
    // IMAGE-ONLY = người dùng CHỈ xin một bức hình -> theo định nghĩa đó là YÊU CẦU TƯỜNG MINH. Chủ đề đã bị cắt động từ
    // ("Vẽ hình tế bào" -> "tế bào") nên bộ chấm điểm thấy "dưới ngưỡng" và bỏ hình (lỗi có sẵn từ bản gốc, phát hiện khi
    // chạy route thật). Chỉ nâng các từ chối MỀM; veto tuyệt đối và setting "never" vẫn giữ nguyên.
    if (stage === 'image_only' && !decision.shouldGenerateImage && ['below_threshold', 'borderline', 'low_value_subject'].includes(decision.reason)) {
      decision = {
        ...decision, shouldGenerateImage: true, explicitRequest: true, imageNecessity: 'USER_REQUESTED', reason: 'image_only_request',
        visualType: decision.visualType && decision.visualType !== 'no_visual' ? decision.visualType : 'concept_illustration',
        visualPurpose: decision.visualPurpose || 'minh hoạ theo yêu cầu của người dùng', suggestedCount: 1, placement: 'after_solution',
        generationPriority: 'high', confidence: Math.max(decision.confidence || 0, 0.9), borderline: false
      };
    }

    // ---------- HYBRID: Visual Determination Engine chọn SVG / Puter / không hình ----------
    const clientPrimary = String(process.env.PUTER_VISUAL_MODE || 'client_primary').toLowerCase() === 'client_primary';
    const puterAuthState = determinationEngine.normalizePuterAuth(puterAuth);
    telemetry.visualPuterAuth = puterAuthState;
    const determine = () => determinationEngine.determineVisual({
      question: rawQuestion || question, approachText, subject, decision, userPreference, puterAuth: puterAuthState, clientPrimary
    });
    let determination = determine();

    // ---------- TẦNG 3: chỉ borderline mới hỏi model (bỏ qua khi SVG tất định đã dựng được) ----------
    const svgSettled = determination.visualType === 'svg' || determination.reason === 'deterministic_validation_failed';
    if (!svgSettled && typeof judge === 'function' && decisionEngine.needsModelJudgement(decision)) {
      telemetry.visualJudgeUsed = true;
      telemetry.visualJudgeCalls += 1;
      try {
        const verdict = await judge({ question, subject, decision });
        if (verdict) { decision = decisionEngine.applyModelJudgement(decision, verdict); determination = determine(); }
      } catch (e) { /* judge lỗi -> giữ nguyên quyết định heuristic, không ảnh hưởng text */ }
    }

    telemetry.visualNecessity = decision.imageNecessity || 'NONE';
    telemetry.visualDecision = decision.shouldGenerateImage || determination.visualType === 'svg';
    telemetry.visualConfidence = determination.visualType === 'svg' ? determination.confidence : decision.confidence;
    telemetry.visualType = decision.visualType;
    telemetry.visualDeterministic = !!determination.deterministic;
    telemetry.visualDeterminationReason = determination.reason;
    telemetry.visualCategory = determination.category;

    // ---------- Nhánh 1: SVG TẤT ĐỊNH — 0 token, 0 lệnh gọi image model, KHÔNG cần Puter ----------
    if (determination.visualType === 'svg' && determination.artifact) {
      const art = determination.artifact;
      const necessity = decision.imageNecessity || 'NONE';
      const svgVisual = {
        visualId: nextVisualId(),
        type: art.category, visualType: art.category, subject: subject || art.domain,
        renderer: 'deterministic_svg', origin: 'deterministic', format: 'svg',
        svg: art.svg, alt: art.desc, title: art.title, caption: '',
        svgSpec: { specHash: art.specHash, category: art.category, engine: deterministic.ENGINE_VERSION },
        specHash: art.specHash, fidelity: 'deterministic', necessity,
        overrodeNever: !!decision.overrodeNever,
        placement: decision.placement && decision.placement !== 'none' ? decision.placement : 'after_problem_summary',
        fromCache: !!art.cacheHit
      };
      telemetry.visualRenderer = 'deterministic_svg';
      telemetry.visualFidelity = 'deterministic';
      telemetry.visualGenerated = true;
      telemetry.visualSpecHash = art.specHash;
      telemetry.visualSvgBytes = Buffer.byteLength(art.svg, 'utf8');
      telemetry.visualSvgCacheHit = !!art.cacheHit;
      telemetry.visualCacheHit = !!art.cacheHit;
      telemetry.visualGenerationLatency = Date.now() - t0;
      determinationEngine.debugLog('svg_ready', { category: art.category, specHash: art.specHash, bytes: telemetry.visualSvgBytes, cacheHit: !!art.cacheHit });
      onEvent({ ...svgVisual, type: 'visual:ready' });
      return { status: 'ready', decision, visuals: [svgVisual], telemetry, determination: summarizeDetermination(determination) };
    }

    // ---------- Nhánh 2: dữ kiện MÂU THUẪN -> không vẽ bừa, báo rõ lý do (KHÔNG gọi AI vẽ "cho có") ----------
    if (determination.reason === 'deterministic_validation_failed') {
      const first = (determination.validationErrors && determination.validationErrors[0]) || { code: 'invalid', detail: '' };
      const notice = {
        visualId: nextVisualId(), format: 'notice', noticeKind: 'validation_failed', renderer: 'deterministic_svg',
        subject, type: determination.category, title: language === 'en' ? 'Diagram not drawn' : 'Chưa vẽ hình',
        message: language === 'en'
          ? `The given data is invalid or inconsistent, so no diagram was drawn (to avoid drawing it wrong): ${first.detail}`
          : `Dữ kiện trong đề không hợp lệ hoặc mâu thuẫn nên không vẽ hình (tránh vẽ sai): ${first.detail}`,
        errorCode: first.code, errors: (determination.validationErrors || []).slice(0, 3)
      };
      telemetry.visualError = `deterministic_validation_failed:${first.code}`;
      onEvent({ ...notice, type: 'visual:ready' });
      return { status: 'skipped', decision, visuals: [notice], telemetry, determination: summarizeDetermination(determination) };
    }

    if (!decision.shouldGenerateImage) {
      return { status: 'skipped', decision, visuals: [], telemetry };
    }
    if (degrade === 'emergency') {
      telemetry.visualError = 'deferred_deadline';
      return { status: 'skipped', decision: null, visuals: [], telemetry };
    }

    // ---------- Cross-check conflict detection TRƯỚC khi dựng spec ----------
    const conflict = detectVisualFactConflicts(candidates, finalAnswer);
    telemetry.visualConflicts = conflict.conflicts;
    onEvent({ type: 'visual:pending', visualType: decision.visualType, placement: decision.placement });

    // ---------- Dựng SPEC có cấu trúc ----------
    const spec = specBuilder.buildVisualSpec({ decision, finalAnswer, question, subject, language, grade, approachText });
    if (degrade === 'medium' && Array.isArray(spec.annotations) && spec.annotations.length > 2) {
      spec.annotations = spec.annotations.slice(0, 2);
    }
    if (conflict.conflicts.length) {
      spec.objects = spec.objects.filter((o) => !conflict.conflicts.includes(o.symbol)
        || String(finalAnswer).includes(`${o.symbol} = ${o.value}`));
    }

    // ---------- Chọn renderer: generated_image | interactive_3d | no_visual ----------
    const imageProviderAvailable = imageClient.isConfigured();
    const route = router.chooseVisualRenderer(spec, {
      imageProviderAvailable,
      puterImageAvailable: clientPrimary
    });
    telemetry.visualRenderer = route.renderer;
    telemetry.visualNeedsPreciseGeometry = !!spec.needsPreciseGeometry;
    telemetry.visualHighPrecision = !!route.highPrecisionRequired;
    telemetry.visualRouteReason = route.reason;
    telemetry.visualRealismRequired = !!route.realismRequired;
    telemetry.visualFidelity = route.fidelity || 'ai_generated';
    telemetry.visualUpgradeHint = route.upgradeHint || null;

    // Scene 3D tương tác: Three.js đã lo trong chính câu trả lời, pipeline ảnh không đụng vào.
    if (route.renderer === 'interactive_3d') {
      telemetry.visualError = null;
      return { status: 'skipped', decision, visuals: [], telemetry };
    }
    if (route.renderer === 'no_visual') {
      return { status: 'skipped', decision, visuals: [], telemetry };
    }

    // ---------- Cache ----------
    const keyParts = {
      promptVersion: `${cacheKeyExtra.promptVersion || ''}|${specBuilder.VISUAL_PROMPT_VERSION}`,
      specFingerprint: specBuilder.specFingerprint(spec),
      answerStructureHash: cache.answerStructureHash(finalAnswer),
      subject, language: spec.language, renderer: route.renderer,
      model: clientPrimary
        ? `${process.env.PUTER_IMAGE_PROVIDER || 'openai-image-generation'}:${process.env.PUTER_IMAGE_MODEL || 'default'}`
        : imageClient.activeProviderName() || '',
      sourceFingerprint: cacheKeyExtra.sourceFingerprint || '',
      imageFingerprint: cacheKeyExtra.imageFingerprint || '',
      style: `${spec.style}#${spec.aspectRatio}`,
      userPreference
    };
    const cached = clientPrimary ? null : await cache.getAsync(keyParts);
    if (cached) {
      telemetry.visualCacheHit = true;
      telemetry.visualGenerated = true;
      telemetry.visualGenerationLatency = Date.now() - t0;
      const cachedVisual = { ...cached, visualId: nextVisualId(), fromCache: true };
      // PHẦN B: cache lưu ảnh ở dạng GỐC (data URL). Mỗi lần phát ra response mới lại externalize
      // với TTL mới — nếu cache cũ giữ sẵn link asset thì link đó đã hết hạn từ lâu và client nhận
      // 404 dù cache "hit".
      const visual = (await responseGuard.externalizeVisuals([cachedVisual])).visuals[0];
      onEvent({ ...visual, type: 'visual:ready' });
      return { status: 'ready', decision, visuals: [visual], telemetry };
    }

    const visualDeadlineAt = Date.now() + Math.min(VISUAL_DEADLINE_MS, Number.isFinite(remaining) ? remaining - 500 : VISUAL_DEADLINE_MS);
    const necessity = decision.imageNecessity || 'NONE';
    const highNeed = necessity === 'NECESSARY' || necessity === 'USER_REQUESTED';

    // Prompt gốc được dựng NGAY (thuần hàm, 0 token, 0 mạng) để dù chưa có provider vẫn nhớ được
    // ngữ cảnh cho nút "Thử tạo lại".
    const maxChars = imageClient.activePromptCharLimit() || specBuilder.DEFAULT_PROMPT_CHAR_LIMIT;
    const basePrompt = specBuilder.buildImagePrompt(spec, { maxChars, degrade });
    const promptCtx = { prompt: basePrompt, necessity, subject, title: spec.title, type: spec.type };
    telemetry.visualPromptTokens = Math.ceil(basePrompt.length / 3.2);

    // Client-primary mode: server prepares a job only. Puter.js owns auth, generation,
    // validation and IndexedDB storage in browser. Never hold SSE open for image generation.
    if (clientPrimary) {
      const visualId = nextVisualId();
      const visualFingerprint = crypto.createHash('sha256').update(JSON.stringify({
        promptVersion: specBuilder.VISUAL_PROMPT_VERSION,
        prompt: basePrompt,
        spec: specBuilder.specFingerprint(spec),
        source: cacheKeyExtra.sourceFingerprint || '',
        images: cacheKeyExtra.imageFingerprint || ''
      })).digest('hex').slice(0, 32);
      const visualJob = {
        visualId,
        requestId: cacheKeyExtra.requestId || null,
        visualFingerprint,
        promptVersion: specBuilder.VISUAL_PROMPT_VERSION,
        renderer: 'puter_image',
        displayProvider: 'puter',
        provider: 'puter',
        puterProvider: process.env.PUTER_IMAGE_PROVIDER || 'openai-image-generation',
        model: process.env.PUTER_IMAGE_MODEL || null,
        visualType: spec.type,
        ratioRequested: spec.aspectRatio,
        qualityRequested: degrade === 'low' ? 'fast' : 'standard',
        ratio: spec.aspectRatio,
        quality: degrade === 'low' ? 'fast' : 'standard',
        inputImageIds: Array.isArray(inputImageIds) ? inputImageIds : [],
        inputImageCount: Array.isArray(inputImageIds) ? inputImageIds.length : 0,
        inputImageMetadata: Array.isArray(inputImageIds) ? inputImageIds.map((id) => ({ imageId: id })) : [],
        prompt: basePrompt,
        title: spec.title,
        caption: spec.purpose || '',
        overlay: specBuilder.buildVisualOverlay(spec),
        fingerprint: visualFingerprint,
        createdAt: new Date().toISOString(),
        status: 'QUEUED',
        necessity,
        subject: spec.subject || subject || 'visual',
        type: spec.type,
        fidelity: 'ai_generated',
        placement: decision.placement
      };
      await hqStore.remember(visualId, { ...promptCtx, visualFingerprint, visualJob });

      // ---------- Puter CHƯA Auth: không phát job (sẽ chỉ tạo popup/lỗi), không nag khi hình chỉ là tuỳ chọn ----------
      if (determination.authRequired) {
        telemetry.visualRenderer = 'puter';
        telemetry.visualAuthRequired = true;
        const userAsked = !!determination.userRequested || highNeed;
        if (!userAsked) {
          // Hình AI chỉ là tuỳ chọn: câu trả lời chính vẫn nguyên vẹn, hình bị bỏ qua + MỘT dòng nhắc nhẹ (không phải lỗi).
          telemetry.visualError = 'puter_auth_required_skipped';
          determinationEngine.debugLog('puter_auth_skip', { necessity, reason: 'optional_visual_while_unauthenticated' });
          const skipNote = {
            visualId: nextVisualId(), format: 'notice', noticeKind: 'puter_auth_skipped', renderer: 'puter_image', subject, type: spec.type, authRequired: true,
            title: language === 'en' ? 'AI image not created' : 'Chưa tạo hình ảnh AI',
            message: language === 'en'
              ? 'The AI image was not created because Puter.js is not authenticated. You can authenticate in Settings to use it.'
              : 'Hình ảnh AI chưa được tạo vì Puter.js chưa được Auth. Bạn có thể Auth trong Settings để sử dụng.'
          };
          onEvent({ ...skipNote, type: 'visual:ready' });
          return { status: 'skipped', decision, visuals: [skipNote], telemetry, determination: summarizeDetermination(determination) };
        }
        const authStub = {
          visualId, renderFailed: true, authRequired: true, errorCode: 'PUTER_AUTH_REQUIRED', reason: 'puter_auth_required',
          recoverable: true, userRequested: !!determination.userRequested, necessity, title: spec.title, subject, type: spec.type,
          status: 'AUTH_REQUIRED', renderer: 'puter_image', job: visualJob
        };
        telemetry.visualError = 'puter_auth_required';
        onEvent({ ...authStub, type: 'visual:error' });
        return { status: 'auth_required', decision, visuals: [authStub], visualJob: null, telemetry, determination: summarizeDetermination(determination) };
      }
      telemetry.visualRenderer = 'puter';
      telemetry.visualLifecycleLocked = true;
      telemetry.visualGenerationLifecycleCount = 1;
      telemetry.visualGenerated = false;
      onEvent({ ...visualJob, type: 'visual:request' });
      return { status: 'pending', decision, visuals: [], visualJob, telemetry };
    }

    /** Thất bại toàn tập -> stub {renderFailed:true} + giữ text. KHÔNG có hình thay thế. */
    const failWith = async (reason) => {
      telemetry.visualError = reason;
      telemetry.visualGenerationLatency = Date.now() - t0;
      const visualId = nextVisualId();
      // remember() là I/O (KV) — await để chắc chắn ngữ cảnh tồn tại TRƯỚC KHI client thấy nút
      // "Thử tạo lại"; nếu không, bấm ngay lập tức sẽ nhận 404 do ghi chưa kịp xong.
      await hqStore.remember(visualId, promptCtx);
      const failedVisual = {
        visualId, renderFailed: true, necessity,
        title: spec.title, subject, type: spec.type,
        reason, upgradeHint: route.upgradeHint || null,
        providersTried: telemetry.visualProvidersTried
      };
      onEvent({ ...failedVisual, type: 'visual:error', recoverable: true });
      return { status: 'failed', decision, visuals: [failedVisual], telemetry };
    };

    // ---------- Không có provider ảnh = KHÔNG có hình (không dựng SVG thay thế) ----------
    if (route.blocked === 'no_image_provider') return await failWith('no_image_provider');
    if (signal && signal.aborted) return await failWith('aborted');
    if (degrade === 'low' && !highNeed) return await failWith('degraded_no_image_gen');
    if (degrade === 'low' && (visualDeadlineAt - Date.now()) < MIN_IMAGE_CALL_MS) {
      return await failWith('degraded_no_time_for_image');
    }

    // ---------- Sinh ảnh: provider failover (trong imageClient) + tối đa 1 lần repair ----------
    const sizing = imageClient.sizeForRequest({ aspectRatio: spec.aspectRatio, quality: 'standard', degrade });
    const costClass = imageClient.classifyImageCost({ provider: imageClient.activeProviderName(), size: sizing.size });
    telemetry.visualCostClass = costClass;
    if (costClass === 'IMAGE_COST_HIGH' && (necessity === 'OPTIONAL' || necessity === 'NONE')) {
      return await failWith('cost_gate_low_benefit');
    }

    let produced = null;
    let lastValidation = null;
    let prompt = basePrompt;

    for (let attempt = 0; attempt <= MAX_IMAGE_REPAIR; attempt++) {
      if (signal && signal.aborted) { telemetry.visualError = 'aborted'; break; }
      if (Date.now() > visualDeadlineAt) { telemetry.visualError = 'visual_deadline'; break; }

      telemetry.visualGenerationLifecycleCount = 1; // vòng đời sinh hình đã BẮT ĐẦU (mục 34)
      const img = await imageClient.generateImage({
        prompt, signal, size: sizing.size, aspectRatio: sizing.aspectRatio, quality: sizing.quality,
        timeoutMs: Math.max(2000, visualDeadlineAt - Date.now()),
        deadlineAt: visualDeadlineAt
      });
      telemetry.visualProvidersTried = img.providersTried || telemetry.visualProvidersTried;
      // MỤC 35: SỐ LỆNH GỌI API tới provider ảnh — cộng dồn qua cả các lượt repair, tách hẳn với
      // visualGenerationLifecycleCount (vẫn luôn <= 1).
      telemetry.visualProviderAttempts += (img.providersTried || []).length || 1;
      if (img.costClass) telemetry.visualCostClass = img.costClass;
      if (!img.ok) {
        telemetry.visualProviderFailures += (img.providersTried || []).length || 1;
        telemetry.visualError = img.reason;
        break;
      }

      const out = {
        format: img.format, url: img.url, renderer: 'generated_image', origin: 'ai_generated',
        model: img.model, urlVerified: !!img.urlVerified, verifiedMime: img.verifiedMime
      };
      const validation = validator.validateVisual({ spec, output: out, finalAnswer, expectedLanguage: spec.language });
      lastValidation = validation;
      if (validation.valid) { produced = { ...out, validation }; break; }

      // Trượt quality gate -> ĐÚNG 1 lần repair bằng chính image AI (kèm chỉ dẫn sửa), sau đó
      // dừng hẳn. Không có nhánh nào rơi về SVG.
      if (attempt >= MAX_IMAGE_REPAIR) { telemetry.visualError = 'validation_failed'; break; }
      telemetry.visualRepairCount++;
      telemetry.visualRetryCount++;
      prompt = `${basePrompt}\n${validator.buildVisualRepairPrompt(spec, validation.issues)}`;
    }

    telemetry.visualValidation = lastValidation ? { valid: lastValidation.valid, issues: lastValidation.issues } : null;
    telemetry.visualGenerationLatency = Date.now() - t0;

    if (!produced) return await failWith(telemetry.visualError || 'image_generation_failed');

    const visual = {
      visualId: nextVisualId(),
      type: spec.type,
      subject: spec.subject || subject || 'visual',
      renderer: 'generated_image',
      origin: produced.origin,
      format: produced.format,
      url: produced.url,
      model: produced.model,
      // MỤC XXXVIII/LXIII (master prompt 09/2026) — PROVIDER TRANSPARENCY: frontend không được
      // đoán/hard-code provider, phải hiển thị đúng provider THẬT đã tạo ra ảnh này. `providersTried`
      // là danh sách các provider đã thử ĐÚNG THEO THỨ TỰ (xem generateImage() trong
      // imageGenerationClient.js) — phần tử CUỐI CÙNG luôn là provider đã trả ok:true (mọi phần tử
      // trước đó, nếu có, là provider đã thất bại rồi failover qua). Ví dụ ['gemini-image',
      // 'openai-image'] nghĩa là Gemini lỗi, OpenAI đã tạo thành công ảnh này.
      provider: (telemetry.visualProvidersTried && telemetry.visualProvidersTried.length)
        ? telemetry.visualProvidersTried[telemetry.visualProvidersTried.length - 1]
        : null,
      title: spec.title,
      caption: ((spec.purpose || '').trim() === (spec.title || '').trim() ? '' : (spec.purpose || '')),
      fidelity: 'ai_generated',
      necessity,
      overrodeNever: !!decision.overrodeNever,
      placement: decision.placement,
      // Lớp chú thích UI NHẸ: số liệu/nhãn/công thức ĐÃ XÁC THỰC từ lời giải. Đây KHÔNG phải một
      // hình deterministic đè lên ảnh — chỉ là chú thích, ảnh vẫn là ảnh AI.
      overlay: specBuilder.buildVisualOverlay(spec),
      fromCache: false
    };
    await hqStore.remember(visual.visualId, promptCtx);

    // Chỉ cache khi VALIDATED + COMPLETED, và payload phải là ảnh AI thật.
    await cache.setAsync(keyParts, {
      type: visual.type, subject: visual.subject, renderer: visual.renderer, origin: visual.origin,
      format: visual.format, url: visual.url, model: visual.model, provider: visual.provider,
      title: visual.title, caption: visual.caption, placement: visual.placement,
      fidelity: visual.fidelity, necessity: visual.necessity, overrodeNever: visual.overrodeNever,
      overlay: visual.overlay
    }, { validated: true, answerComplete });

    telemetry.visualGenerated = true;
    // PHẦN B (P0): ảnh data-URL lớn KHÔNG được đi thẳng vào event SSE/JSON — đẩy sang asset store,
    // response chỉ mang tham chiếu. Đây là điểm DUY NHẤT hình rời khỏi pipeline nên chặn ở đây là đủ
    // cho cả /api/chat (JSON), SSE 'visual:ready' và 'done'.
    const emitted = (await responseGuard.externalizeVisuals([visual])).visuals[0];
    onEvent({ ...emitted, type: 'visual:ready' });
    return { status: 'ready', decision, visuals: [emitted], telemetry };
  } catch (e) {
    // Bất biến #1: KHÔNG BAO GIỜ throw ra ngoài.
    telemetry.visualError = 'pipeline_exception:' + (e && e.message);
    try { onEvent({ type: 'visual:error', recoverable: true, reason: 'pipeline_exception' }); } catch (_) { /* ignore */ }
    return { status: 'failed', decision: null, visuals: [], telemetry };
  }
}

module.exports = {
  runVisualPipeline, detectVisualFactConflicts, resolveVisualDegradeLevel, stageMayGenerate,
  VISUAL_DEADLINE_MS, MIN_REMAINING_FOR_VISUAL_MS, DEGRADE_MEDIUM_MS, DEGRADE_LOW_MS,
  MAX_IMAGE_REPAIR
};
