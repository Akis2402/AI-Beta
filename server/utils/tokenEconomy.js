'use strict';

// ---------- TOKEN ECONOMY ENGINE (mục 21) ----------
// Module độc lập, KHÔNG thay thế adaptiveBudget/semanticCompression/completenessCheck/continuation/
// sourceCoverage đã có (những module đó vẫn là nguồn xử lý chính) — tokenEconomy.js là LỚP ĐIỀU PHỐI
// bọc ngoài, cộng thêm các cơ chế mà pipeline cũ CHƯA có: phân lớp bài (MICRO..VERY_COMPLEX),
// core+reserve budget, MathIR, context dedup/packing tổng quát, cache đa cấp, model routing,
// cross-check policy, patch answer, telemetry. Mọi tiết kiệm token nằm ở APPLICATION LAYER (mục 23),
// không nhồi vào prompt model.

const { estimateTokens, calculateAdaptiveBudget } = require('./adaptiveBudget');

// ================= 21.1 ADAPTIVE TOKEN BUDGET — PHÂN LỚP BÀI =================
const PROBLEM_CLASS = { MICRO: 'MICRO', SHORT: 'SHORT', STANDARD: 'STANDARD', COMPLEX: 'COMPLEX', VERY_COMPLEX: 'VERY_COMPLEX' };

/**
 * classifyProblem() gắn nhãn 5 lớp theo mục 21.1, dựng trên estimateProblemComplexity() đã có
 * (adaptiveBudget) rồi cộng thêm tín hiệu source/drawing/deepThinking/crossCheck mà hàm gốc chưa xét.
 * @returns {{problemClass:string, score:number, signals:object}}
 */
function classifyProblem({
  problemText = '', hasImage = false, hasDrawing = false, sourceCount = 0,
  sourceComplexity = 0, deepThinking = false, crossCheck = false, subQuestionCount = 0
} = {}) {
  const charLength = problemText.length;
  let score = 0;

  if (charLength <= 60 && subQuestionCount <= 1) score += 0; // MICRO baseline
  else if (charLength <= 200 && subQuestionCount <= 2) score += 1;
  else if (charLength <= 500 && subQuestionCount <= 3) score += 2;
  else if (charLength <= 1200 && subQuestionCount <= 5) score += 3;
  else score += 4;

  if (hasImage) score += 1;
  if (hasDrawing) score += 1;
  if (sourceCount > 0) score += 1;
  if (sourceCount >= 3) score += 1;
  if (sourceComplexity > 0.6) score += 1;
  if (deepThinking) score += 1;
  if (crossCheck) score += 1;
  if (subQuestionCount >= 4) score += 1;

  let problemClass;
  if (score <= 0) problemClass = PROBLEM_CLASS.MICRO;
  else if (score <= 2) problemClass = PROBLEM_CLASS.SHORT;
  else if (score <= 4) problemClass = PROBLEM_CLASS.STANDARD;
  else if (score <= 6) problemClass = PROBLEM_CLASS.COMPLEX;
  else problemClass = PROBLEM_CLASS.VERY_COMPLEX;

  return { problemClass, score, signals: { charLength, hasImage, hasDrawing, sourceCount, sourceComplexity, deepThinking, crossCheck, subQuestionCount } };
}

// ================= 21.2 TOKEN RESERVE + DYNAMIC EXTENSION =================
const CORE_RATIO = 0.7;
const RESERVE_RATIO = 0.3;

/**
 * allocateCoreReserve() chia budget target (từ calculateAdaptiveBudget) thành core/reserve —
 * pay-as-needed thay vì always-spend-max. Reserve CHỈ được tiêu khi completeness check fail.
 * @param {number} targetBudget
 * @returns {{coreBudget:number, reserveBudget:number, totalBudget:number}}
 */
function allocateCoreReserve(targetBudget) {
  const total = Math.max(200, Math.round(targetBudget));
  const core = Math.max(150, Math.round(total * CORE_RATIO));
  const reserve = Math.max(50, total - core);
  return { coreBudget: core, reserveBudget: reserve, totalBudget: core + reserve };
}

/**
 * Quyết định có được mở reserve hay không — CHỈ khi completeness fail (mục 21.2). Nếu COMPLETE thì
 * không được đụng vào reserve dù còn dư.
 * @param {{status:string}} completeness kết quả validateSolutionCompleteness()
 * @param {number} reserveUsedSoFar
 * @param {number} reserveBudget
 */
function shouldUseReserve(completeness, reserveUsedSoFar, reserveBudget) {
  if (!completeness || completeness.status === 'COMPLETE') return { allow: false, amount: 0 };
  const remaining = reserveBudget - reserveUsedSoFar;
  if (remaining <= 0) return { allow: false, amount: 0 };
  // Continuation không cần cả reserve cùng lúc — cấp theo lô nhỏ (delta), không phải toàn bộ reserve
  // một lần (đúng tinh thần "generateMissingDelta" ở 21.13, không phải "regenerate full").
  const amount = Math.min(remaining, Math.max(200, Math.round(reserveBudget * 0.5)));
  return { allow: true, amount };
}

// ================= 21.5 MATHEMATICAL IR =================
/**
 * buildMathIR() nén 1 bài toán/1 bước giải thành structured representation siêu gọn, dùng để truyền
 * giữa các stage (Approach -> Detail -> verification -> cross-check -> continuation -> drawing)
 * thay vì lặp lại toàn bộ prose. Đây là DATA STRUCTURE — nơi gọi tự quyết định lúc nào serialize gửi
 * model (JSON.stringify gọn, không format đẹp) và lúc nào chỉ dùng nội bộ để tính diff/patch.
 * @returns {{givens:string[], target:string, formulas:string[], intermediate:string[], result:string,
 *   requirements:string[], drawingId:string|null}}
 */
function buildMathIR({ givens = [], target = '', formulas = [], intermediate = [], result = '', requirements = [], drawingId = null } = {}) {
  return {
    givens: [...new Set(givens.filter(Boolean))],
    target: target || '',
    formulas: [...new Set(formulas.filter(Boolean))],
    intermediate: intermediate.filter(Boolean),
    result: result || '',
    requirements: [...new Set(requirements.filter(Boolean))],
    drawingId: drawingId || null
  };
}

/** Serialize MathIR ở dạng gọn nhất có thể để gửi model — không pretty-print, không key thừa. */
function serializeMathIR(ir) {
  const compact = {};
  if (ir.givens && ir.givens.length) compact.givens = ir.givens;
  if (ir.target) compact.target = ir.target;
  if (ir.formulas && ir.formulas.length) compact.formulas = ir.formulas;
  if (ir.intermediate && ir.intermediate.length) compact.intermediate = ir.intermediate;
  if (ir.result) compact.result = ir.result;
  if (ir.requirements && ir.requirements.length) compact.requirements = ir.requirements;
  if (ir.drawingId) compact.drawingId = ir.drawingId;
  return JSON.stringify(compact);
}

// ================= 21.7 CONTEXT DEDUPLICATION (tổng quát, không chỉ history) =================
function normalizeForFingerprint(str) {
  return String(str || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Fingerprint rẻ (không phải crypto hash) đủ dùng để so trùng/gần trùng nội bộ 1 request. */
function fingerprint(str) {
  const norm = normalizeForFingerprint(str);
  let hash = 0;
  for (let i = 0; i < norm.length; i++) {
    hash = (hash * 31 + norm.charCodeAt(i)) | 0;
  }
  return `${norm.length}:${hash}`;
}

/**
 * Jaccard tương tự trên tập từ 3+ ký tự — dùng để bắt "gần như giống nhau" (không chỉ trùng tuyệt đối).
 */
function jaccardSimilarity(a, b) {
  const wa = new Set(normalizeForFingerprint(a).split(/\W+/).filter((w) => w.length >= 3));
  const wb = new Set(normalizeForFingerprint(b).split(/\W+/).filter((w) => w.length >= 3));
  if (!wa.size || !wb.size) return 0;
  let inter = 0;
  wa.forEach((w) => { if (wb.has(w)) inter++; });
  const union = wa.size + wb.size - inter;
  return union ? inter / union : 0;
}

const NEAR_DUP_THRESHOLD = 0.85;

/**
 * dedupeContext() loại chunk trùng hoàn toàn hoặc gần trùng (mục 21.7), giữ bản có metadata/evidence
 * tốt hơn (ưu tiên: có sourceId > có page > dài hơn > xuất hiện trước).
 * @param {Array<{text:string, sourceId?:string, page?:number}>} chunks
 * @returns {Array} danh sách đã loại trùng, giữ nguyên item object gốc (không cắt nội dung).
 */
function dedupeContext(chunks) {
  if (!Array.isArray(chunks) || chunks.length < 2) return chunks || [];

  const score = (c) => (c.sourceId ? 2 : 0) + (c.page != null ? 1 : 0) + Math.min(1, (c.text || '').length / 2000);

  const kept = [];
  const seenExact = new Map(); // fingerprint -> index trong kept

  for (const chunk of chunks) {
    const fp = fingerprint(chunk.text);
    if (seenExact.has(fp)) {
      const idx = seenExact.get(fp);
      if (score(chunk) > score(kept[idx])) kept[idx] = chunk;
      continue;
    }
    // So gần trùng với các chunk đã giữ (chỉ so với danh sách kept — đủ tốt cho quy mô 1 request).
    let dupIdx = -1;
    for (let i = 0; i < kept.length; i++) {
      if (jaccardSimilarity(chunk.text, kept[i].text) >= NEAR_DUP_THRESHOLD) { dupIdx = i; break; }
    }
    if (dupIdx >= 0) {
      if (score(chunk) > score(kept[dupIdx])) kept[dupIdx] = chunk;
      continue;
    }
    seenExact.set(fp, kept.length);
    kept.push(chunk);
  }
  return kept;
}

// ================= 21.8 CONTEXT PACKING (TIER 1/2/3) =================
/**
 * packContextByTier() sắp evidence theo 3 tầng quan trọng, chỉ mở TIER2/3 nếu TIER1 chưa đủ coverage.
 * @param {Array<{text:string, relevance?:number}>} evidence relevance trong [0,1], mặc định tính theo
 *   thứ tự truyền vào nếu không có sẵn.
 * @param {{requiredCoverage?:number}} opts
 * @returns {{tier1:Array, tier2:Array, tier3:Array, selected:Array, usedTiers:number}}
 */
function packContextByTier(evidence, opts = {}) {
  const requiredCoverage = opts.requiredCoverage != null ? opts.requiredCoverage : 0.75;
  const list = (evidence || []).map((e, i) => ({ ...e, relevance: e.relevance != null ? e.relevance : Math.max(0, 1 - i * 0.15) }));
  const sorted = [...list].sort((a, b) => b.relevance - a.relevance);

  const tier1 = sorted.filter((e) => e.relevance >= 0.66);
  const tier2 = sorted.filter((e) => e.relevance >= 0.33 && e.relevance < 0.66);
  const tier3 = sorted.filter((e) => e.relevance < 0.33);

  const coverageOf = (arr) => (list.length ? arr.length / list.length : 0);

  let selected = [...tier1];
  let usedTiers = 1;
  if (coverageOf(selected) < requiredCoverage && tier2.length) {
    selected = [...selected, ...tier2];
    usedTiers = 2;
  }
  if (coverageOf(selected) < requiredCoverage && tier3.length) {
    selected = [...selected, ...tier3];
    usedTiers = 3;
  }
  return { tier1, tier2, tier3, selected, usedTiers };
}

// ================= 21.9/21.10 REQUIREMENT-BASED RETRIEVAL + EARLY EXIT =================
/**
 * earlyExitRetrieval() mô phỏng vòng lặp retrieve-per-requirement, dừng ngay khi coverage đạt
 * threshold — không tiếp tục lấy thêm evidence "cho chắc" (mục 21.10).
 * @param {string[]} requirements
 * @param {(req:string)=>Array<{text:string, relevance:number}>} retrieveFn hàm retrieve 1 requirement,
 *   trả evidence đã sort theo relevance giảm dần.
 * @param {{targetCoverage?:number, maxEvidencePerReq?:number}} opts
 * @returns {{evidenceByRequirement:object, stoppedEarly:object, totalEvidence:number}}
 */
function earlyExitRetrieval(requirements, retrieveFn, opts = {}) {
  const targetCoverage = opts.targetCoverage != null ? opts.targetCoverage : 0.92;
  const maxEvidencePerReq = opts.maxEvidencePerReq || 5;

  const evidenceByRequirement = {};
  const stoppedEarly = {};
  let totalEvidence = 0;

  for (const req of requirements) {
    const available = typeof retrieveFn === 'function' ? (retrieveFn(req) || []) : [];
    const picked = [];
    let coverage = 0;
    for (const ev of available) {
      if (picked.length >= maxEvidencePerReq) break;
      picked.push(ev);
      coverage = Math.min(1, coverage + (ev.relevance != null ? ev.relevance : 0.3));
      if (coverage >= targetCoverage) { stoppedEarly[req] = true; break; }
    }
    if (!(req in stoppedEarly)) stoppedEarly[req] = false;
    evidenceByRequirement[req] = picked;
    totalEvidence += picked.length;
  }
  return { evidenceByRequirement, stoppedEarly, totalEvidence };
}

// ================= 21.13 DELTA CONTINUATION helpers (bổ sung, không thay continuation.js) =================
/**
 * diffMissingSections() so 2 danh sách coverage (đã trả lời vs bắt buộc) để biết chính xác phần
 * PATCH cần sinh — dùng trước khi gọi buildContinuationPrompt (continuation.js) để log/telemetry biết
 * kích thước delta thực tế thay vì đoán.
 */
function diffMissingSections(requiredLabels, answeredLabels) {
  const answered = new Set((answeredLabels || []).map((s) => String(s).toLowerCase()));
  return (requiredLabels || []).filter((l) => !answered.has(String(l).toLowerCase()));
}

// ================= 21.14 ANSWER PATCHING =================
/**
 * applyPatch() áp 1 patch nhỏ vào response hiện có mà KHÔNG regenerate toàn bộ.
 * @param {string} text response gốc
 * @param {{type:'insert_after'|'replace'|'append', anchor?:string, content:string}} patch
 * @returns {string}
 */
function applyPatch(text, patch) {
  if (!patch || !patch.content) return text;
  if (patch.type === 'append') return `${text}\n${patch.content}`;
  if (patch.type === 'replace' && patch.anchor) {
    if (text.includes(patch.anchor)) return text.split(patch.anchor).join(patch.content);
    return `${text}\n${patch.content}`; // anchor không còn tồn tại -> an toàn nhất là append, không mất nội dung
  }
  if (patch.type === 'insert_after' && patch.anchor) {
    const idx = text.indexOf(patch.anchor);
    if (idx === -1) return `${text}\n${patch.content}`;
    const insertAt = idx + patch.anchor.length;
    return text.slice(0, insertAt) + '\n' + patch.content + text.slice(insertAt);
  }
  return `${text}\n${patch.content}`;
}

/** applyPatches() áp tuần tự nhiều patch — thứ tự trong mảng là thứ tự áp dụng. */
function applyPatches(text, patches) {
  return (patches || []).reduce((acc, p) => applyPatch(acc, p), text);
}

// ================= 21.15/21.16 CONVERSATION STATE + HISTORY TTL =================
const IMPORTANCE = { CRITICAL: 'CRITICAL', IMPORTANT: 'IMPORTANT', OPTIONAL: 'OPTIONAL' };

const CRITICAL_HINT_RE = /\$[^$]+\$|```(shape|solid3d|plot)|=\s*-?\d|\b[A-Za-z]\s*=\s*[\d./-]/;
const GREETING_RE = /^(chào|hi|hello|cảm ơn|thanks|ok(ay)?|dạ|vâng)[\s!.,]*$/i;

/**
 * classifyHistoryImportance() gắn nhãn CRITICAL/IMPORTANT/OPTIONAL cho 1 lượt hội thoại (mục 21.16).
 * Dùng để loại OPTIONAL trước tiên khi budget thấp — bổ sung cho compressHistoryForBudget() đã có
 * (semanticCompression.js), không thay thế: có thể dùng hàm này để lọc TRƯỚC khi gọi
 * compressHistoryForBudget để giảm tập ứng viên ngay từ đầu khi budget cực thấp.
 */
function classifyHistoryImportance(turn) {
  const content = String((turn && turn.content) || '');
  if (GREETING_RE.test(content.trim()) || content.trim().length < 4) return IMPORTANCE.OPTIONAL;
  if (CRITICAL_HINT_RE.test(content)) return IMPORTANCE.CRITICAL;
  if (content.length > 40) return IMPORTANCE.IMPORTANT;
  return IMPORTANCE.OPTIONAL;
}

/**
 * buildConversationState() nén history thành structured state gọn (mục 21.15) — trả về object nhỏ để
 * đưa vào system/context thay vì gửi lại nguyên văn từng lượt hỏi-đáp cũ.
 */
function buildConversationState({ history = [], solvedRequirements = [], formulas = [], variables = [], drawingId = null, sourceIds = [], currentAnswer = '', unresolved = [] } = {}) {
  const importances = history.map((h) => ({ ...h, importance: classifyHistoryImportance(h) }));
  return {
    turnCount: history.length,
    criticalTurns: importances.filter((h) => h.importance === IMPORTANCE.CRITICAL).length,
    solvedRequirements: [...new Set(solvedRequirements)],
    formulas: [...new Set(formulas)],
    variables: [...new Set(variables)],
    drawingId,
    sourceIds: [...new Set(sourceIds)],
    currentAnswer,
    unresolved: [...new Set(unresolved)]
  };
}

// ================= 21.18 MULTI-LEVEL CACHE (L1-L6) =================
// In-memory cache — đủ cho 1 tiến trình server; TTL ngắn để tránh trả kết quả cũ cho câu hỏi có vẻ
// giống nhưng thực chất khác (cache key PHẢI gồm model/prompt version/settings/problem hash — mục
// 21.18, tránh "dùng cache sai khiến kết quả cũ xuất hiện cho prompt mới").
const LEVELS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'];
const DEFAULT_TTL_MS = { L1: 10 * 60 * 1000, L2: 15 * 60 * 1000, L3: 30 * 60 * 1000, L4: 20 * 60 * 1000, L5: 15 * 60 * 1000, L6: 10 * 60 * 1000 };
const MAX_ENTRIES_PER_LEVEL = 500;

class TokenEconomyCache {
  constructor() {
    this.store = new Map(LEVELS.map((l) => [l, new Map()]));
  }

  _keyOf(parts) {
    // Cache key bao gồm mọi thứ ẢNH HƯỞNG output — không chỉ nội dung câu hỏi.
    return Object.keys(parts).sort().map((k) => `${k}=${normalizeForFingerprint(String(parts[k]))}`).join('|');
  }

  get(level, keyParts) {
    const map = this.store.get(level);
    if (!map) return null;
    const key = this._keyOf(keyParts);
    const entry = map.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) { map.delete(key); return null; }
    return entry.value;
  }

  set(level, keyParts, value, ttlMs) {
    const map = this.store.get(level);
    if (!map) return;
    if (map.size >= MAX_ENTRIES_PER_LEVEL) {
      // Evict entry cũ nhất — Map giữ thứ tự insert nên key đầu tiên là cũ nhất.
      const firstKey = map.keys().next().value;
      if (firstKey !== undefined) map.delete(firstKey);
    }
    const key = this._keyOf(keyParts);
    map.set(key, { value, expiresAt: Date.now() + (ttlMs || DEFAULT_TTL_MS[level] || 10 * 60 * 1000) });
  }

  clear(level) {
    if (level) this.store.get(level)?.clear();
    else LEVELS.forEach((l) => this.store.get(l).clear());
  }

  stats() {
    const out = {};
    LEVELS.forEach((l) => { out[l] = this.store.get(l).size; });
    return out;
  }
}

// Singleton — dùng chung cho cả tiến trình server (không tạo cache riêng mỗi request).
const globalCache = new TokenEconomyCache();

// ================= 21.19/21.20 CROSS-CHECK TOKEN ECONOMY =================
const RISK = { LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH' };

/**
 * crossCheckPolicy() quyết định mức độ verify cần thiết theo mục 21.19 — không phải bài nào cũng
 * cần 2 model. `sourceConflict`/`modelDisagreement` do nơi gọi tự phát hiện (đã có sẵn trong pipeline
 * cross-check hiện tại) và truyền vào để nâng risk lên HIGH khi cần.
 * @returns {{risk:string, mode:'single'|'lightweight_verify'|'dual_model', verifyAnswerFirst:boolean}}
 */
function crossCheckPolicy({ problemClass, hasGeometryProof = false, algebraTransformCount = 0, sourceConflict = false, modelDisagreement = false, answerUncertainty = false } = {}) {
  const highRisk = hasGeometryProof || algebraTransformCount >= 4 || sourceConflict || modelDisagreement || answerUncertainty;
  const mediumRisk = !highRisk && (problemClass === PROBLEM_CLASS.COMPLEX || problemClass === PROBLEM_CLASS.VERY_COMPLEX || algebraTransformCount >= 2);

  if (highRisk) return { risk: RISK.HIGH, mode: 'dual_model', verifyAnswerFirst: true };
  if (mediumRisk) return { risk: RISK.MEDIUM, mode: 'lightweight_verify', verifyAnswerFirst: true };
  return { risk: RISK.LOW, mode: 'single', verifyAnswerFirst: false };
}

/**
 * planVerification() cụ thể hoá mục 21.20 — ưu tiên verify final answer trước, chỉ regenerate toàn
 * bộ reasoning khi verifier phát hiện xung đột thật sự.
 * @returns {{steps:string[]}} thứ tự các bước verifier nên làm, dừng ngay khi bước nào phát hiện lỗi.
 */
function planVerification(policy) {
  if (policy.mode === 'single') return { steps: [] };
  const steps = ['final_answer'];
  if (policy.mode === 'dual_model' || policy.mode === 'lightweight_verify') {
    steps.push('key_formulas', 'critical_intermediate_results', 'assumptions');
  }
  return { steps }; // 'full_reasoning' CHỈ thêm vào bên ngoài khi 1 trong các bước trên fail
}

// ================= 21.26 MODEL ROUTING THEO ĐỘ PHỨC TẠP =================
/**
 * routeByComplexity() chọn 1 "tier" model theo problemClass — nơi gọi tự map tier -> tên
 * model/provider cụ thể (đã có sẵn trong aiProviders.js/executionTargets.js), hàm này chỉ quyết định
 * TIER, không biết chi tiết provider. deepThinking/highRisk LUÔN override lên 'strong_reasoning'.
 * @returns {'cheap'|'fast'|'standard'|'strong'|'strong_reasoning'}
 */
function routeByComplexity({ problemClass, deepThinking = false, highRisk = false } = {}) {
  if (deepThinking || highRisk) return 'strong_reasoning';
  switch (problemClass) {
    case PROBLEM_CLASS.MICRO: return 'cheap';
    case PROBLEM_CLASS.SHORT: return 'fast';
    case PROBLEM_CLASS.STANDARD: return 'standard';
    case PROBLEM_CLASS.COMPLEX: return 'strong';
    case PROBLEM_CLASS.VERY_COMPLEX: return 'strong_reasoning';
    default: return 'standard';
  }
}

// ================= 21.28 TOKEN AWARE ERROR RECOVERY =================
const ERROR_RECOVERY = {
  INVALID_CITATION: 'repair_citation_only',
  MISSING_CONCLUSION: 'append_conclusion_only',
  DRAWING_ERROR: 'patch_drawing_only',
  MATH_CONFLICT: 'verify_critical_step',
  TIMEOUT: 'continue_from_state'
};

/** mapErrorToRecovery() dịch completeness.reasons[] (đã có) sang chiến lược recovery hẹp nhất có thể. */
function mapErrorToRecovery(reasons = []) {
  if (reasons.includes('drawing_canonical_mismatch') || reasons.includes('invalid_drawing_json')) return ERROR_RECOVERY.DRAWING_ERROR;
  if (reasons.includes('missing_conclusion')) return ERROR_RECOVERY.MISSING_CONCLUSION;
  if (reasons.includes('missing_coverage')) return 'generate_missing_delta';
  return 'continue_from_state';
}

// ================= 21.30 TOKEN TELEMETRY =================
/**
 * TelemetryRecorder — 1 instance mỗi request (không phải singleton toàn cục — mỗi request có
 * inputTokens/outputTokens riêng). record() cộng dồn theo field, không log nội dung/secrets.
 */
class TelemetryRecorder {
  constructor() {
    this.data = {
      inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0,
      retrievalTokens: 0, historyTokens: 0, retryTokens: 0, continuationTokens: 0,
      totalTokens: 0, estimatedCost: 0, solvedRequirements: 0, totalRequirements: 0
    };
  }

  record(field, amount) {
    if (!(field in this.data)) return;
    this.data[field] += Math.max(0, Math.round(amount || 0));
    this.data.totalTokens = this.data.inputTokens + this.data.outputTokens + this.data.reasoningTokens
      + this.data.retrievalTokens + this.data.retryTokens + this.data.continuationTokens;
  }

  setRequirements(solved, total) {
    this.data.solvedRequirements = solved;
    this.data.totalRequirements = total;
  }

  tokenEfficiency() {
    return this.data.totalTokens ? this.data.solvedRequirements / this.data.totalTokens : 0;
  }

  wastedTokenRatio(wastedTokens) {
    return this.data.totalTokens ? Math.min(1, wastedTokens / this.data.totalTokens) : 0;
  }

  snapshot() {
    return { ...this.data, tokenEfficiency: this.tokenEfficiency() };
  }
}

// ================= 21.31 AUTOMATIC TOKEN OPTIMIZATION LOOP =================
// Lưu ước lượng token thực tế đã đủ để COMPLETE cho từng (problemClass, stage) — dùng để hạ budget
// lần sau cho lớp bài tương tự, có guardrail trên/dưới để không co quá đà.
const budgetByProblemClass = new Map(); // key `${problemClass}:${stage}` -> {avg, samples}
const GUARDRAIL_MIN_RATIO = 0.5; // không hạ dưới 50% budget mặc định của adaptiveBudget
const GUARDRAIL_MAX_RATIO = 1.5; // không nâng quá 150%

/**
 * recordOutcome() gọi sau mỗi request COMPLETE để cập nhật lịch sử ước lượng (mục 21.31).
 * @param {string} problemClass
 * @param {string} stage
 * @param {number} actualTokensUsed token thực tế đã dùng để đạt COMPLETE
 */
function recordOutcome(problemClass, stage, actualTokensUsed) {
  const key = `${problemClass}:${stage}`;
  const prev = budgetByProblemClass.get(key) || { avg: actualTokensUsed, samples: 0 };
  const samples = prev.samples + 1;
  // Exponential moving average — thích ứng dần, không bị lệch mạnh vì 1 outlier.
  const avg = prev.samples === 0 ? actualTokensUsed : prev.avg * 0.8 + actualTokensUsed * 0.2;
  budgetByProblemClass.set(key, { avg, samples });
}

/**
 * suggestBudgetOverride() trả về budget đề xuất dựa trên lịch sử, đã áp guardrail so với budget mặc
 * định của calculateAdaptiveBudget — trả null nếu chưa đủ dữ liệu lịch sử (< 3 mẫu).
 */
function suggestBudgetOverride(problemClass, stage, defaultTarget) {
  const key = `${problemClass}:${stage}`;
  const stat = budgetByProblemClass.get(key);
  if (!stat || stat.samples < 3) return null;
  const clamped = Math.min(defaultTarget * GUARDRAIL_MAX_RATIO, Math.max(defaultTarget * GUARDRAIL_MIN_RATIO, stat.avg * 1.1));
  return Math.round(clamped);
}

// ================= 21.33 TOKEN ECONOMY DECISION PIPELINE =================
/**
 * runTokenEconomyPipeline() thực hiện các bước KHÔNG cần gọi AI của mục 21.33 (NORMALIZE ->
 * CLASSIFY -> CHECK CACHE -> EXTRACT REQUIREMENTS -> COMPRESS CONTEXT -> BUILD MathIR -> ALLOCATE
 * BUDGET) và trả về 1 plan để nơi gọi (route handler) dùng cho bước GENERATE thật sự (vẫn gọi
 * calculateAdaptiveBudget/compressHistoryForBudget/aiProviders như hiện có — module này không gọi AI).
 *
 * @param {{problemText:string, historyText?:string, contextsText?:string, approachText?:string,
 *   contexts?:Array, history?:Array, stage:string, hasImage?:boolean, hasDrawing?:boolean,
 *   deepThinking?:boolean, crossCheck?:boolean, remainingMs?:number, requirements?:string[],
 *   cacheKeyExtra?:object}} input
 * @returns {object} plan
 */
function runTokenEconomyPipeline(input) {
  const {
    problemText = '', historyText = '', contextsText = '', approachText = '',
    contexts = [], history = [], stage = 'detail', hasImage = false, hasDrawing = false,
    deepThinking = false, crossCheck = false, remainingMs, requirements = [], cacheKeyExtra = {}
  } = input;

  // NORMALIZE (dùng chung fingerprint đã có ở trên).
  const normalizedProblem = normalizeForFingerprint(problemText);

  // CLASSIFY COMPLEXITY.
  const classification = classifyProblem({
    problemText, hasImage, hasDrawing, sourceCount: contexts.length,
    sourceComplexity: contexts.length ? Math.min(1, contexts.length / 6) : 0,
    deepThinking, crossCheck, subQuestionCount: requirements.length
  });

  // CHECK CACHE (L1 — normalized request) trước khi làm bất kỳ việc gì tốn hơn.
  const cacheKeyParts = { stage, normalizedProblem, deepThinking: String(deepThinking), crossCheck: String(crossCheck), ...cacheKeyExtra };
  const cached = globalCache.get('L1', cacheKeyParts);

  // COMPRESS CONTEXT — dedupe tổng quát trên contexts (bổ sung compressHistoryForBudget đã lo history).
  const dedupedContexts = dedupeContext(contexts);
  const packed = packContextByTier(dedupedContexts.map((c, i) => ({ ...c, relevance: c.relevance != null ? c.relevance : Math.max(0, 1 - i * 0.12) })));

  // BUILD MathIR khung rỗng — nơi gọi (promptBuilder/route) điền givens/formulas/result thực tế sau
  // khi có Approach; ở đây chỉ dựng sườn + requirements đã trích.
  const mathIR = buildMathIR({ requirements });

  // ALLOCATE CORE + RESERVE BUDGET — dựa trên adaptiveBudget hiện có, rồi thử override theo lịch sử
  // (mục 21.31) trong giới hạn guardrail.
  const baseBudget = calculateAdaptiveBudget({ stage, problemText, historyText, contextsText, approachText, hasImage, deepThinking, crossCheck, remainingMs });
  const historicalOverride = suggestBudgetOverride(classification.problemClass, stage, baseBudget.target);
  const effectiveTarget = historicalOverride != null ? Math.min(baseBudget.max, Math.max(baseBudget.min, historicalOverride)) : baseBudget.target;
  const { coreBudget, reserveBudget, totalBudget } = allocateCoreReserve(effectiveTarget);

  // MODEL ROUTING.
  const modelTier = routeByComplexity({ problemClass: classification.problemClass, deepThinking, highRisk: crossCheck });

  return {
    classification,
    cacheHit: cached != null,
    cachedValue: cached,
    cacheKeyParts,
    dedupedContexts,
    packedContext: packed,
    mathIR,
    budget: { ...baseBudget, coreBudget, reserveBudget, totalBudget, effectiveTarget, historicalOverride },
    modelTier
  };
}

module.exports = {
  PROBLEM_CLASS,
  classifyProblem,
  allocateCoreReserve,
  shouldUseReserve,
  buildMathIR,
  serializeMathIR,
  fingerprint,
  jaccardSimilarity,
  dedupeContext,
  packContextByTier,
  earlyExitRetrieval,
  diffMissingSections,
  applyPatch,
  applyPatches,
  IMPORTANCE,
  classifyHistoryImportance,
  buildConversationState,
  TokenEconomyCache,
  globalCache,
  RISK,
  crossCheckPolicy,
  planVerification,
  routeByComplexity,
  ERROR_RECOVERY,
  mapErrorToRecovery,
  TelemetryRecorder,
  recordOutcome,
  suggestBudgetOverride,
  runTokenEconomyPipeline
};
