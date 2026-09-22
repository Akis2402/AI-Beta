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
const { SETTING, THRESHOLD, BORDERLINE_BAND, SUBJECT_SIGNALS, GENERIC_SIGNALS, ENGLISH_SIGNALS, ADVANCED_SIGNALS, HARD_VETO, LOW_VALUE_SUBJECTS, MODIFIERS, SPATIAL_RE, PROCESS_RE } = CFG;

// ---------- B9.1: 5 mức nhu cầu hình, theo đúng ngữ nghĩa sản phẩm ----------
// USER_REQUESTED luôn nằm TRÊN CÙNG trong image routing priority (B9.6) — kể cả khi score thấp.
const NECESSITY = {
  NONE: 'NONE',
  OPTIONAL: 'OPTIONAL',
  HELPFUL: 'HELPFUL',
  NECESSARY: 'NECESSARY',
  USER_REQUESTED: 'USER_REQUESTED'
};

function classifyNecessity({ explicitRequest, score, threshold, borderline, should }) {
  // USER_REQUESTED chỉ có nghĩa khi hình THỰC SỰ được tạo. Nếu quyết định cuối vẫn là KHÔNG vẽ
  // (bị HARD_VETO chặn, hoặc hình sẽ dư thừa vì câu trả lời đã có sẵn khối vẽ), gán USER_REQUESTED
  // sẽ nói dối tầng routing/telemetry rằng đây là hình ưu tiên cao nhất.
  if (explicitRequest && should) return NECESSITY.USER_REQUESTED;
  if (!should) return borderline ? NECESSITY.OPTIONAL : NECESSITY.NONE;
  if (Number.isFinite(threshold) && score >= threshold + 0.2) return NECESSITY.NECESSARY;
  if (Number.isFinite(threshold) && score >= threshold) return NECESSITY.HELPFUL;
  return borderline ? NECESSITY.OPTIONAL : NECESSITY.NONE;
}

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
  // A3: khi override setting "never" bằng yêu cầu tường minh, THRESHOLD[never] (vô cực/không dùng
  // được) sẽ chặn mọi score — nên chấm điểm theo ngưỡng AUTO, đúng như khi người dùng để mặc định.
  const explicitOverrideNever = pref === SETTING.NEVER
    && GENERIC_SIGNALS.some((s) => s.explicit && s.re.test(String(question || '')));
  const threshold = explicitOverrideNever ? THRESHOLD[SETTING.AUTO] : THRESHOLD[pref];

  const noVisual = (reason, extra = {}) => ({
    shouldGenerateImage: false, confidence: 0, visualType: 'no_visual',
    visualPurpose: '', suggestedCount: 0, placement: 'none', generationPriority: 'low',
    score: 0, threshold, borderline: false, reason, imageNecessity: NECESSITY.NONE, signals: {}, ...extra
  });

  const q = String(question || '').trim();
  if (!q) return noVisual('empty_question');

  // ---------- A3: YÊU CẦU TƯỜNG MINH phải được tính TRƯỚC mọi nhánh chặn ----------
  // BUG CŨ: `if (pref === NEVER) return noVisual(...)` chạy TRƯỚC khi tính explicitRequest, nên
  // người dùng đã tắt hình trong settings mà gõ thẳng "vẽ hình minh họa cho câu này" vẫn KHÔNG
  // được vẽ và cũng không được báo gì — ngược đúng nguyên tắc USER_REQUESTED (yêu cầu tường minh
  // của người dùng luôn ở ưu tiên cao nhất, trên cả setting mặc định).
  const explicitRequest = GENERIC_SIGNALS.some((s) => s.explicit && s.re.test(q));

  // ---------- PHẦN 27 + A3: "Never" vẫn thắng, TRỪ khi có yêu cầu tường minh ----------
  // Override CHỈ áp dụng cho LƯỢT NÀY — không đụng tới setting global của người dùng.
  if (pref === SETTING.NEVER && !explicitRequest) return noVisual('user_preference_never');
  const overrodeNever = pref === SETTING.NEVER && explicitRequest;

  // ---------- TẦNG 1: HARD VETO (PHẦN 14) ----------
  // HARD_VETO vẫn THẮNG TUYỆT ĐỐI kể cả khi có explicit request (A3.2) — giữ nguyên dòng cũ.
  const veto = HARD_VETO.find((v) => v.re.test(q));
  // Veto hạng `absolute` (không có gì để vẽ) thắng cả yêu cầu tường minh; veto hạng thường (giá trị
  // thấp, không phải bằng không) thì người dùng được quyền override — xem chú thích ở HARD_VETO.
  if (veto && (veto.absolute || !explicitRequest)) return noVisual(veto.reason);
  if (LOW_VALUE_SUBJECTS.has(subject) && !explicitRequest) return noVisual('low_value_subject');

  // ---------- TẦNG 2: SCORING ----------
  // Tín hiệu tiếng Anh và tín hiệu bậc đại học áp dụng cho MỌI môn: một đề bài tiếng Anh không
  // thay đổi subjectId, và khái niệm đại học có thể xuất hiện ở bất kỳ môn nào (rủi ro #2).
  const signalList = (SUBJECT_SIGNALS[subject] || []).concat(GENERIC_SIGNALS, ENGLISH_SIGNALS, ADVANCED_SIGNALS);
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
  // Bộ chuẩn mở rộng (rủi ro #2) phát hiện: "Cho tôi hình trực quan…", "Vẽ lại hình này…",
  // "Generate an educational image…" đều ghi đúng 0.45 rồi bị costPenalty kéo xuống 0.39 — trượt
  // ngưỡng 0.40 trong gang tấc. Tức là một YÊU CẦU TƯỜNG MINH bị từ chối vì… chi phí render. Sai
  // về thứ tự ưu tiên: chi phí đã có cửa gác riêng và đúng chỗ hơn ở B9.15 (cost gate theo
  // imageNecessity, nơi USER_REQUESTED được miễn), còn ở tầng QUYẾT ĐỊNH thì ý muốn tường minh của
  // người dùng không nên bị một hệ số chi phí phủ quyết.
  const cost = explicitRequest ? 0 : MODIFIERS.costPenalty;

  const score = Math.max(0, Math.min(1,
    educationalValue + spatialRelationship + processVisibility + complexityBonus
    - redundancy - cost - ambiguity
  ));

  const borderline = Number.isFinite(threshold) && Math.abs(score - threshold) <= BORDERLINE_BAND;
  // A3: yêu cầu tường minh KHÔNG ép `should=true` một cách mù quáng — nó chỉ đưa lượt này vào
  // SCORING BÌNH THƯỜNG (ngưỡng AUTO) thay vì bị chặn ngay ở nhánh "never"/veto. Nhờ vậy các cơ
  // chế chống hình VÔ ÍCH vẫn còn hiệu lực: hình DƯ THỪA (câu trả lời đã có sẵn khối ```shape),
  // đề quá mơ hồ, môn low-value... Đề bài có chữ "vẽ" (vd "cho tam giác ABC, vẽ đường cao AH")
  // KHÔNG đồng nghĩa người dùng yêu cầu ảnh minh hoạ thứ hai khi hình đã có.
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
    generationPriority: explicitRequest ? 'high'
      : score >= threshold + 0.2 ? 'high' : score >= threshold ? 'medium' : 'low',
    score: Number(score.toFixed(3)),
    threshold,
    borderline,
    // B9.1: phân loại 5 mức TƯỜNG MINH, map từ score/threshold/explicitRequest ĐÃ TÍNH ở trên
    // (không tính lại từ đầu, 0 token).
    imageNecessity: classifyNecessity({ explicitRequest, score, threshold, borderline, should }),
    // A3.3: telemetry phân biệt được lượt nào là override setting "never".
    reason: overrodeNever ? 'explicit_override_never'
      : should ? (explicitRequest ? 'explicit_request' : 'above_threshold')
      : (borderline ? 'borderline' : 'below_threshold'),
    explicitRequest,
    overrodeNever,
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
    reason: shouldGenerateImage ? 'model_judgement_yes' : 'model_judgement_no',
    imageNecessity: shouldGenerateImage
      ? (decision.imageNecessity === NECESSITY.USER_REQUESTED ? NECESSITY.USER_REQUESTED : NECESSITY.HELPFUL)
      : NECESSITY.NONE
  };
}

// ============================================================================================
// MỤC 1.6 — YÊU CẦU CHỈ-LẤY-HÌNH ("Tạo cho tôi hình ảnh cấu tạo con người")
// ============================================================================================
// Đây KHÔNG phải một bài tập cần lời giải. Người dùng muốn ĐÚNG MỘT thứ: bức hình, kèm vài dòng
// giới thiệu. Chạy nó qua pipeline giải bài hai giai đoạn (Hướng giải -> Lời giải chi tiết, kèm
// completeness check + continuation) là sai từ gốc: tốn nhiều lượt gọi AI, sinh ra một bài văn dài
// mà người dùng không hỏi, và vì bài văn dài nên rất dễ chạm trần token -> "CHƯA ĐẦY ĐỦ".
//
// Nhận diện cần CẢ HAI vế, để không cướp mất những câu hỏi thật sự có nội dung học thuật:
//   (1) ĐỘNG TỪ TẠO HÌNH đứng đầu ý định: "tạo/vẽ/làm/cho tôi xem/generate/draw/create ... hình
//       ảnh|ảnh|hình|sơ đồ|image|picture|diagram".
//   (2) KHÔNG có ĐỘNG TỪ HỌC THUẬT nào trong câu ("giải", "tính", "chứng minh", "so sánh",
//       "phân tích", "vì sao", "tại sao", "trình bày", "nêu"...). Có bất kỳ từ nào trong nhóm này
//       nghĩa là người dùng muốn NỘI DUNG, hình chỉ là phần kèm theo -> đi đường bình thường.
// Câu cũng phải NGẮN (<= 160 ký tự): một đề bài dài kèm câu "vẽ hình minh hoạ" ở cuối vẫn là đề bài.
// LƯU Ý KỸ THUẬT (đã mắc phải và sửa): KHÔNG dùng `\b` quanh từ tiếng Việt. `\b` của JavaScript
// dựa trên [A-Za-z0-9_], nên "ẽ" trong "vẽ" và "ả" trong "ảnh" KHÔNG phải ký tự từ -> `\bảnh` hay
// `vẽ\b` không bao giờ khớp. Dùng lookaround theo \p{L} (cờ `u`) làm ranh giới từ Unicode.
const NOT_LETTER_BEFORE = '(?<![\\p{L}\\p{N}])';
const NOT_LETTER_AFTER = '(?![\\p{L}\\p{N}])';
const IMAGE_ONLY_VERB_RE = new RegExp(
  NOT_LETTER_BEFORE
  + '(?:tạo|vẽ|làm|thiết\\s*kế|cho\\s+(?:tôi|mình|em)\\s+(?:xem|một|1)?|generate|create|draw|show\\s+me|make)'
  + NOT_LETTER_AFTER
  + '[^.?!]{0,40}?' + NOT_LETTER_BEFORE
  + '(?:hình\\s*ảnh|hình\\s*vẽ|bức\\s*ảnh|tấm\\s*ảnh|hình|ảnh|sơ\\s*đồ|minh\\s*hoạ|minh\\s*họa'
  + '|image|picture|photo|illustration|diagram|drawing)' + NOT_LETTER_AFTER,
  'iu'
);
const CONTENT_VERB_RE = new RegExp(
  NOT_LETTER_BEFORE
  + '(?:giải|tính|chứng\\s*minh|cmr|so\\s*sánh|phân\\s*tích|giải\\s*thích|vì\\s*sao|tại\\s*sao'
  + '|trình\\s*bày|nêu|liệt\\s*kê|viết\\s*(?:đoạn|bài)|lập\\s*bảng|tìm\\s+(?:x|y|giá\\s*trị|nghiệm)'
  + '|rút\\s*gọn|khảo\\s*sát|solve|calculate|prove|explain|compare|analyz)',
  'iu'
);

/**
 * detectImageOnlyRequest() — thuần heuristic, 0 token.
 * @param {string} question
 * @returns {{imageOnly:boolean, topic:string, reason:string}} `topic` = chủ thể cần vẽ, đã bỏ phần
 *   động từ yêu cầu ("Tạo cho tôi hình ảnh cấu tạo con người" -> "cấu tạo con người").
 */
function detectImageOnlyRequest(question) {
  const q = String(question || '').trim();
  if (!q) return { imageOnly: false, topic: '', reason: 'empty' };
  if (q.length > 160) return { imageOnly: false, topic: '', reason: 'too_long_for_image_only' };
  if (!IMAGE_ONLY_VERB_RE.test(q)) return { imageOnly: false, topic: '', reason: 'no_image_verb' };
  if (CONTENT_VERB_RE.test(q)) return { imageOnly: false, topic: '', reason: 'has_content_verb' };

  // Chủ thể = phần còn lại sau khi bỏ cụm yêu cầu tạo hình ở đầu.
  const topic = q
    .replace(IMAGE_ONLY_VERB_RE, ' ')
    .replace(/^\s*(?:về|of|the|một|1|cái|bức|tấm)(?![\p{L}\p{N}])/iu, '')
    .replace(/[\s,.;:!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Không còn chủ thể nào ("vẽ cho tôi một bức ảnh") -> không đủ dữ kiện, để pipeline thường hỏi lại.
  if (topic.length < 3) return { imageOnly: false, topic: '', reason: 'no_topic' };
  return { imageOnly: true, topic, reason: 'image_only_request' };
}

/**
 * isExplicitVisualRequest() — người dùng có YÊU CẦU TƯỜNG MINH một hình không? (0 token)
 *
 * Tách ra để `visualPolicy` dùng lại ĐÚNG bộ tín hiệu mà `evaluateVisualNeed()` dùng ở nhánh
 * override setting "never" (dòng `explicitRequest` bên trên). Nếu copy regex sang file khác thì
 * policy của cache và policy của pipeline sẽ trôi khỏi nhau — đúng loại lỗi V6.17.3.D cấm.
 *
 * @param {string} question
 * @returns {boolean}
 */
function isExplicitVisualRequest(question) {
  const q = String(question || '').trim();
  if (!q) return false;
  return GENERIC_SIGNALS.some((s) => s.explicit && s.re.test(q));
}

module.exports = {
  detectImageOnlyRequest,
  isExplicitVisualRequest,
  evaluateVisualNeed,
  NECESSITY,
  classifyNecessity,
  needsModelJudgement,
  applyModelJudgement,
  estimateRedundancy,
  defaultTypeForSubject,
  SETTING,
  THRESHOLD,
  BORDERLINE_BAND,
  config: CFG
};
