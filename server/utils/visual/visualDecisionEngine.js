'use strict';

// ============================================================================================
// PHẦN 12/13/14/15/25/27 — VISUAL DECISION ENGINE
// ============================================================================================
// Câu hỏi duy nhất mà module này trả lời:
//
//     "Câu trả lời này có TỐT HƠN ĐÁNG KỂ nếu có hình minh họa không?"
//
// Nguyên tắc cốt lõi (PHẦN 25): KHÔNG tạo một reasoning loop khổng lồ chỉ để quyết định có vẽ hình
// hay không. Quyết định đi qua 3 tầng, tầng sau CHỈ chạy khi tầng trước không kết luận được:
//
//   TẦNG 1 — HARD VETO      (rẻ nhất, 0 token): câu hỏi/câu trả lời rơi vào danh sách PHẦN 14.
//   TẦNG 2 — SCORING        (rẻ, 0 token):      heuristic có trọng số, cho ra score + confidence.
//   TẦNG 3 — MODEL JUDGE    (tốn token):        CHỈ cho vùng borderline quanh ngưỡng.
//
// Output KHÔNG BAO GIỜ lộ chain-of-thought của evaluator ra người dùng (PHẦN 12) — chỉ là dữ liệu
// nội bộ, telemetry đọc được, UI chỉ thấy hình (hoặc không thấy gì).

// Toàn bộ bảng trọng số/ngưỡng/veto nằm ở visualScoringConfig.js — xem lý do tách ở đầu file đó.
const CFG = require('./visualScoringConfig');
const { SETTING, THRESHOLD, BORDERLINE_BAND, SUBJECT_SIGNALS, GENERIC_SIGNALS, HARD_VETO, LOW_VALUE_SUBJECTS, MODIFIERS, SPATIAL_RE, PROCESS_RE } = CFG;

/**
 * Ước lượng "độ dư thừa" — hình chỉ lặp lại điều text đã nói rõ thì KHÔNG đáng tạo (PHẦN 14).
 * Ví dụ: câu trả lời đã có sẵn bảng markdown đầy đủ, hoặc đã có khối ```shape/```plot do chính
 * pipeline vẽ hình cũ dựng ra -> hình thứ hai là dư thừa.
 */
function estimateRedundancy(answerText) {
  if (!answerText) return 0;
  let r = 0;
  if (/```(shape|solid3d|plot|scene3d)/.test(answerText)) r += MODIFIERS.redundancyDrawing; // đã có hình dựng sẵn
  const tableRows = (answerText.match(/^\s*\|.+\|\s*$/gm) || []).length;
  if (tableRows >= 4) r += MODIFIERS.redundancyTable; // bảng đã đủ trình bày dữ liệu
  return Math.min(1, r);
}

/**
 * evaluateVisualNeed() — TẦNG 1 + TẦNG 2 (thuần heuristic, 0 token).
 *
 * @param {object} input
 * @param {string} input.question Đề bài gốc.
 * @param {string} [input.answerPlan] Câu trả lời (hoặc phần đầu của nó) đã có — dùng để đo dư thừa.
 * @param {string} [input.subject] subjectId ('math'|'physics'|...).
 * @param {string} [input.grade]
 * @param {string} [input.language]
 * @param {string} [input.complexity] 'short'|'medium'|'large'|'very_large'
 * @param {'auto'|'always'|'never'} [input.userPreference='auto']
 * @returns {{shouldGenerateImage:boolean, confidence:number, visualType:string, visualPurpose:string,
 *   suggestedCount:number, placement:string, generationPriority:'low'|'medium'|'high',
 *   score:number, threshold:number, borderline:boolean, reason:string, signals:object}}
 */
function evaluateVisualNeed(input = {}) {
  const {
    question = '', answerPlan = '', subject = 'general', complexity = 'medium',
    userPreference = SETTING.AUTO
  } = input;

  const pref = [SETTING.AUTO, SETTING.ALWAYS, SETTING.NEVER].includes(userPreference) ? userPreference : SETTING.AUTO;
  const threshold = THRESHOLD[pref];

  const noVisual = (reason, extra = {}) => ({
    shouldGenerateImage: false, confidence: 0, visualType: 'no_visual',
    visualPurpose: '', suggestedCount: 0, placement: 'none', generationPriority: 'low',
    score: 0, threshold, borderline: false, reason, signals: {}, ...extra
  });

  // ---------- PHẦN 27: người dùng chọn "Never" ----------
  if (pref === SETTING.NEVER) return noVisual('user_preference_never');

  const q = String(question || '').trim();
  if (!q) return noVisual('empty_question');

  // ---------- TẦNG 1: HARD VETO (PHẦN 14) ----------
  const veto = HARD_VETO.find((v) => v.re.test(q));
  // Ngoại lệ: người dùng YÊU CẦU TƯỜNG MINH ("minh hoạ", "vẽ hình") thì tôn trọng yêu cầu đó.
  const explicitRequest = GENERIC_SIGNALS.some((s) => s.explicit && s.re.test(q));
  if (veto && !explicitRequest) return noVisual(veto.reason);
  if (LOW_VALUE_SUBJECTS.has(subject) && !explicitRequest) return noVisual('low_value_subject');

  // ---------- TẦNG 2: SCORING ----------
  const signalList = (SUBJECT_SIGNALS[subject] || []).concat(GENERIC_SIGNALS);
  const haystack = q + '\n' + String(answerPlan || '').slice(0, 4000);
  const matched = [];
  let educationalValue = 0;
  let bestType = 'no_visual';
  let bestWeight = 0;

  signalList.forEach((sig) => {
    if (!sig.re.test(haystack)) return;
    matched.push({ type: sig.type, w: sig.w });
    educationalValue += sig.w;
    if (sig.w > bestWeight && sig.type !== 'auto') { bestWeight = sig.w; bestType = sig.type; }
  });

  // Yêu cầu tường minh mà chưa suy ra được loại hình -> để visualSpecBuilder chọn theo môn.
  if (explicitRequest && bestType === 'no_visual') bestType = defaultTypeForSubject(subject);

  // Quan hệ KHÔNG GIAN (toạ độ, hướng, vị trí tương đối) — thứ mà văn bản diễn đạt rất kém.
  const spatialRelationship = SPATIAL_RE.test(haystack) ? MODIFIERS.spatialRelationship : 0;
  // Quá trình nhiều bước/nhiều trạng thái.
  const processVisibility = PROCESS_RE.test(haystack) ? MODIFIERS.processVisibility : 0;
  // Bài phức tạp có nhiều dữ kiện -> hình giúp tổ chức thông tin.
  const complexityBonus = complexity === 'very_large' ? MODIFIERS.complexityVeryLarge
    : complexity === 'large' ? MODIFIERS.complexityLarge : 0;

  const redundancy = estimateRedundancy(answerPlan);
  // Chi phí: hình cần render/gọi model; ambiguity: đề mơ hồ thì hình dễ vẽ sai (PHẦN 14).
  const ambiguity = q.length < 25 && !explicitRequest ? MODIFIERS.ambiguityPenalty : 0;
  const cost = MODIFIERS.costPenalty;

  const score = Math.max(0, Math.min(1,
    educationalValue + spatialRelationship + processVisibility + complexityBonus
    - redundancy - cost - ambiguity
  ));

  const borderline = Number.isFinite(threshold) && Math.abs(score - threshold) <= BORDERLINE_BAND;
  const should = score >= threshold && bestType !== 'no_visual';

  // PHẦN 23.9/23.10: một câu trả lời nhiều ví dụ tương tự KHÔNG mặc định tạo nhiều hình —
  // suggestedCount luôn là 1 trừ khi thực sự có ≥2 loại hình KHÁC HẲN nhau được yêu cầu.
  const distinctTypes = new Set(matched.map((m) => m.type).filter((t) => t !== 'auto'));
  const suggestedCount = should ? (distinctTypes.size >= 3 && score > 0.85 ? 2 : 1) : 0;

  return {
    shouldGenerateImage: should,
    confidence: Number(Math.min(1, score / (Number.isFinite(threshold) ? Math.max(threshold, 0.01) : 1) * 0.85).toFixed(3)),
    visualType: should ? bestType : 'no_visual',
    visualPurpose: should ? purposeFor(bestType) : '',
    suggestedCount,
    placement: should ? placementFor(bestType) : 'none',
    generationPriority: score >= threshold + 0.2 ? 'high' : score >= threshold ? 'medium' : 'low',
    score: Number(score.toFixed(3)),
    threshold,
    borderline,
    reason: should ? 'above_threshold' : (borderline ? 'borderline' : 'below_threshold'),
    signals: {
      educationalValue: Number(educationalValue.toFixed(3)),
      spatialRelationship, processVisibility, complexityBonus,
      redundancy: Number(redundancy.toFixed(3)), ambiguity, cost,
      matchedTypes: [...distinctTypes]
    }
  };
}

function defaultTypeForSubject(subject) {
  switch (subject) {
    case 'math': return 'geometry_diagram';
    case 'physics': return 'physics_diagram';
    case 'chemistry': return 'chemistry_structure';
    case 'biology': return 'biology_diagram';
    case 'geography': return 'map_diagram';
    case 'computer-science': return 'flowchart';
    default: return 'concept_illustration';
  }
}

function purposeFor(type) {
  const map = {
    physics_diagram: 'minh hoạ vật thể, lực và quan hệ hình học của bài toán',
    circuit_diagram: 'minh hoạ sơ đồ mạch điện và cách mắc các phần tử',
    optics_diagram: 'minh hoạ đường đi của tia sáng qua hệ quang học',
    mathematical_plot: 'vẽ đồ thị/quỹ đạo để thấy dạng và các điểm đặc biệt',
    geometry_diagram: 'dựng hình phẳng đúng quan hệ giữa các điểm/đoạn/góc',
    geometry_3d: 'dựng hình không gian để thấy quan hệ giữa các mặt/cạnh',
    chemistry_structure: 'minh hoạ cấu trúc/liên kết của phân tử hoặc nguyên tử',
    apparatus_diagram: 'minh hoạ bố trí dụng cụ thí nghiệm',
    biology_diagram: 'minh hoạ cấu trúc sinh học và vị trí các thành phần',
    flowchart: 'minh hoạ trình tự các bước/giai đoạn của quá trình',
    architecture_diagram: 'minh hoạ các thành phần hệ thống và luồng dữ liệu',
    data_structure_diagram: 'minh hoạ cấu trúc dữ liệu và liên kết giữa các nút',
    network_diagram: 'minh hoạ topology mạng',
    map_diagram: 'minh hoạ vị trí/phân bố trên bản đồ',
    chart: 'trực quan hoá số liệu',
    concept_illustration: 'minh hoạ khái niệm một cách trực quan'
  };
  return map[type] || 'minh hoạ nội dung lời giải';
}

function placementFor(type) {
  // Đồ thị/hình hình học thường cần xuất hiện SỚM (đọc đề xong là muốn thấy hình);
  // flowchart/quy trình hợp lý hơn khi đặt sau phần trình bày các bước.
  return ['mathematical_plot', 'geometry_diagram', 'geometry_3d', 'physics_diagram', 'circuit_diagram', 'optics_diagram'].includes(type)
    ? 'after_problem_summary'
    : 'after_solution';
}

/**
 * needsModelJudgement() — TẦNG 3 gate (PHẦN 25). CHỈ true cho vùng borderline, để không đốt token
 * cho những case đã hiển nhiên ở cả 2 phía.
 */
function needsModelJudgement(decision) {
  return !!(decision && decision.borderline && Number.isFinite(decision.threshold));
}

/**
 * applyModelJudgement() — gộp phán quyết của model (chỉ 1 nhãn yes/no + confidence) vào quyết định
 * heuristic. Model KHÔNG được phép bật hình cho case đã bị HARD VETO (PHẦN 14 là tuyệt đối).
 */
function applyModelJudgement(decision, judgement) {
  if (!decision || !judgement || typeof judgement.useful !== 'boolean') return decision;
  if (decision.visualType === 'no_visual' && !judgement.useful) return decision;
  const shouldGenerateImage = judgement.useful;
  return {
    ...decision,
    shouldGenerateImage,
    visualType: shouldGenerateImage && decision.visualType === 'no_visual'
      ? (judgement.visualType || 'concept_illustration')
      : decision.visualType,
    suggestedCount: shouldGenerateImage ? Math.max(1, decision.suggestedCount) : 0,
    confidence: Number(Math.min(1, (decision.confidence + (judgement.confidence || 0.5)) / 2).toFixed(3)),
    reason: shouldGenerateImage ? 'model_judgement_yes' : 'model_judgement_no'
  };
}

module.exports = {
  evaluateVisualNeed,
  needsModelJudgement,
  applyModelJudgement,
  estimateRedundancy,
  defaultTypeForSubject,
  SETTING,
  THRESHOLD,
  BORDERLINE_BAND,
  config: CFG
};
