'use strict';

// ============================================================================================
// V6.21.0-13 — PHÂN LOẠI CÂU HỎI: KIẾN THỨC vs BÀI TOÁN (fix "OUTPUT GRANULARITY BUG")
// ============================================================================================
// NGUYÊN NHÂN GỐC (xem __MASTER_PROMPT_V6_19.md, mục V6.21.0): buildChatDynamicPart() trong
// promptBuilder.js trước đây LUÔN ép mọi câu hỏi qua đúng 1 khuôn giải bài tập — "## Tóm tắt đề
// bài" + "## Hướng giải" (tối đa 5 gạch đầu dòng) khi stage='approach', hoặc "## Lời giải chi
// tiết" + "## Kết luận" + "## Lỗi sai thường gặp" khi stage='detail' — bất kể câu hỏi thực chất là
// "Tóm tắt lý thuyết về Dao động cơ" (một câu hỏi LÝ THUYẾT, không có gì để "giải") hay "Giải
// phương trình x²-5x+6=0" (một BÀI TOÁN thực sự). `stage` chỉ phản ánh CLIENT đang ở màn hình nào
// (nút "Hướng giải" hay "Xem chi tiết"), không phản ánh BẢN CHẤT câu hỏi — nên câu hỏi lý thuyết bị
// nhồi vào khuôn "Hướng giải" và biến thành một "bài giảng" 9 phần thay vì 4 gạch đầu dòng gọn.
//
// Module này KHÔNG gọi AI để phân loại (V6.21.63 "COMPLEXITY MUST BE DETERMINISTIC FIRST",
// V6.21.64 "NO CLASSIFIER LATENCY TAX") — thuần hàm, 0 token, 0 I/O, cùng triết lý với
// intentRouter.js (định tuyến bằng luật trước khi chạm model). Kết quả của nó chỉ QUYẾT ĐỊNH
// khuôn mẫu (promptBuilder.js) và ngân sách output (adaptiveBudget.js/BASE_TARGET.knowledge) —
// KHÔNG đụng vào intentRouter/source/visual/worker-pool đã có (giữ đúng phạm vi sửa lỗi đã báo cáo,
// không rewrite kiến trúc đang hoạt động tốt).
//
// GIỚI HẠN ĐÃ BIẾT: đây là heuristic regex/từ khóa tiếng Việt — không thể hoàn hảo 100% với văn bản
// tự nhiên mở. Khi mơ hồ, cố tình lệch về phía "KIẾN THỨC/gọn" (đúng hướng sửa lỗi đã báo cáo — lỗi
// gốc là suy diễn "bài giảng" quá đà, không phải ngược lại) — nếu suy đoán sai theo hướng này, người
// dùng vẫn luôn có thể gõ "giải chi tiết hơn" để override (xem EXPAND_INTENT_RE bên dưới).

const { estimateProblemComplexity } = require('./adaptiveBudget');

// ---------- Tín hiệu KIẾN THỨC (hỏi lý thuyết/định nghĩa/công thức/so sánh khái niệm) ----------
const KNOWLEDGE_CUES = [
  /\blà\s+gì\s*\??\s*$/i,
  /định nghĩa/i,
  /khái niệm/i,
  /phát biểu\s+(định luật|định lý|nguyên lý)/i,
  /tóm tắt\s+(lý thuyết|kiến thức|nội dung|chương)/i,
  /nêu\s+(khái niệm|định nghĩa|nội dung|đặc điểm|tính chất)/i,
  /trình bày\s+(lý thuyết|khái niệm|nội dung)/i,
  /phân biệt\s+.+\s+(và|với)\s+/i,
  /so sánh\s+.+\s+(và|với)\s+/i,
  /\bwhat\s+is\b/i,
  /\bdefine\b/i,
  /\bsummar(y|ize)\b/i
];
// Hỏi CÔNG THỨC nhưng KHÔNG kèm dữ kiện số cụ thể để tính ("Công thức chu kỳ con lắc lò xo?") vẫn
// là hỏi kiến thức — khác với "Dùng công thức T=..., m=1kg tính T" (có số liệu -> là bài toán).
const FORMULA_ASK_RE = /công thức/i;

// ---------- Tín hiệu BÀI TOÁN (động từ yêu cầu XỬ LÝ một đối tượng cụ thể) ----------
// Loại trừ rõ 2 cặp dễ nhầm trong tiếng Việt: "giải thích" (explain, KHÔNG phải "giải" = solve) và
// "tìm hiểu" (learn about, KHÔNG phải "tìm" = find/solve-for) — nếu không loại trừ, mọi câu hỏi lý
// thuyết kiểu "giải thích ngắn gọn về..."/"tìm hiểu về..." sẽ bị nhận nhầm thành bài toán.
const SOLVE_VERB_RE = /\bgiải(?!\s*thích)\b|\btính\b|\bchứng\s*minh\b|\brút\s*gọn\b|\btìm(?!\s*hiểu)\b|\bxác\s*định\b|\bbiện\s*luận\b|\bkhảo\s*sát\b/i;
const EQUATION_RE = /[=<>≤≥].*\d|\d.*[=<>≤≥]/; // có dấu bằng/bất đẳng thức CÙNG với số liệu

// Nâng độ khó dù văn bản ngắn.
const HARD_SIGNAL_RE = /\b(biện luận|tham số|tổng quát|mọi giá trị|với mọi)\b/i;
const EXPERT_SIGNAL_RE = /\b(học sinh giỏi|hsg|olympic|chuyên đề nâng cao|đề thi hsg|nhiều hướng giải|nhiều cách giải|kiểm chứng)\b/i;
const SOLVE_EQUATION_RE = /giải\s+(hệ\s+)?(phương trình|bất phương trình)/i;

// ---------- Ý định người dùng override RÕ RÀNG (V6.21.3/V6.21.66) — luôn thắng suy luận mặc định ----------
// KHÔNG gồm "tóm tắt" — "tóm tắt lý thuyết X" đã là tín hiệu KNOWLEDGE_CUES tự nó, đã mặc định gọn
// (SIMPLE/D1); coi nó thêm là "compress" nữa sẽ ép xuống D0, sai với hợp đồng hồi quy V6.21.7 (case
// "Tóm tắt lý thuyết về Dao động cơ" phải là đúng D1, không phải D0).
const EXPAND_INTENT_RE = /\b(chi tiết|từng bước|phân tích sâu|phân tích kỹ|kỹ càng|kỹ lưỡng|đầy đủ|toàn diện)\b/i;
const COMPRESS_INTENT_RE = /\b(ngắn gọn|giải thích ngắn|nói ngắn gọn|súc tích|vắn tắt|sơ lược)\b/i;

const COMPLEXITY_ORDER = ['TRIVIAL', 'SIMPLE', 'MODERATE', 'COMPLEX', 'EXPERT'];
const DEPTH_OF = { TRIVIAL: 'D0', SIMPLE: 'D1', MODERATE: 'D2', COMPLEX: 'D3', EXPERT: 'D4' };

function bump(level, delta) {
  const i = COMPLEXITY_ORDER.indexOf(level);
  const j = Math.max(0, Math.min(COMPLEXITY_ORDER.length - 1, i + delta));
  return COMPLEXITY_ORDER[j];
}

/** Độ phức tạp của một BÀI TOÁN (kind=PROBLEM) — dựa trên PHƯƠNG PHÁP cần dùng, không phải độ dài
 * văn bản (một phương trình bậc 2 viết rất ngắn vẫn cần discriminant/phân tích, nên KHÔNG được xếp
 * cùng mức "SIMPLE" như 1 câu thay số trực tiếp — đây là lý do KHÔNG dùng thẳng
 * estimateProblemComplexity().level, vốn đo tải OUTPUT, không đo độ khó PHƯƠNG PHÁP). */
function classifyProblemComplexity(text) {
  if (EXPERT_SIGNAL_RE.test(text)) return 'EXPERT';
  if (SOLVE_EQUATION_RE.test(text)) return HARD_SIGNAL_RE.test(text) ? 'COMPLEX' : 'MODERATE';
  if (/chứng\s*minh/i.test(text)) return 'MODERATE';
  if (HARD_SIGNAL_RE.test(text)) return 'COMPLEX';
  const size = estimateProblemComplexity({ problemText: text });
  if (size.subQuestionCount >= 3 || size.level === 'very_large') return 'COMPLEX';
  if (size.subQuestionCount >= 1 || size.level === 'large' || size.level === 'medium') return 'MODERATE';
  return 'SIMPLE'; // thay số vào công thức có sẵn / tính trực tiếp 1 bước
}

/**
 * classifyQuestion() — thuần hàm, 0 token, 0 I/O.
 * @param {{problemText:string, hasImage?:boolean}} input
 * @returns {{kind:('KNOWLEDGE'|'PROBLEM'), complexity:string, responseDepth:string,
 *   explicitOverride:('expand'|'compress'|null), subQuestionCount:number, reason:string}}
 */
function classifyQuestion({ problemText = '', hasImage = false } = {}) {
  const text = String(problemText || '').trim();
  const size = estimateProblemComplexity({ problemText: text, hasImage });

  const hasSolveVerb = SOLVE_VERB_RE.test(text);
  const hasEquation = EQUATION_RE.test(text);
  // Ảnh đính kèm (đề chụp từ sách/vở) hầu như luôn là bài tập cần giải, không phải hỏi lý thuyết
  // suông — ưu tiên PROBLEM khi có ảnh trừ khi có tín hiệu KNOWLEDGE rất rõ đi kèm (câu hỏi + ảnh
  // minh họa cho khái niệm vẫn hiếm, giữ đơn giản: có ảnh -> PROBLEM).
  const isProblem = hasEquation || hasSolveVerb || hasImage;
  const isFormulaAsk = FORMULA_ASK_RE.test(text) && !hasEquation;
  const isKnowledgeCue = KNOWLEDGE_CUES.some((re) => re.test(text)) || isFormulaAsk;

  const kind = isProblem ? 'PROBLEM' : 'KNOWLEDGE'; // mặc định an toàn khi mơ hồ: KNOWLEDGE (gọn)

  let complexity;
  if (kind === 'PROBLEM') {
    complexity = classifyProblemComplexity(text);
  } else {
    // Kiến thức: mặc định SIMPLE (D1, đúng hợp đồng hồi quy V6.21.7) — chỉ nâng bậc khi câu hỏi rõ
    // ràng gộp NHIỀU khái niệm/yêu cầu so sánh nhiều nhánh (subQuestionCount cao).
    complexity = size.subQuestionCount >= 3 ? 'MODERATE' : 'SIMPLE';
  }
  if (HARD_SIGNAL_RE.test(text) && kind === 'PROBLEM') complexity = bump(complexity, 0); // đã tính trong classifyProblemComplexity, tránh cộng dồn 2 lần
  if (EXPERT_SIGNAL_RE.test(text)) complexity = 'EXPERT';

  let explicitOverride = null;
  if (EXPAND_INTENT_RE.test(text)) { explicitOverride = 'expand'; complexity = bump(complexity, 1); }
  else if (COMPRESS_INTENT_RE.test(text)) { explicitOverride = 'compress'; complexity = bump(complexity, -1); }

  return {
    kind,
    complexity,
    responseDepth: DEPTH_OF[complexity],
    explicitOverride,
    subQuestionCount: size.subQuestionCount,
    reason: `${kind}:${complexity}${explicitOverride ? `+${explicitOverride}` : ''}${isKnowledgeCue && kind === 'KNOWLEDGE' ? ':cue' : ''}`
  };
}

module.exports = { classifyQuestion, DEPTH_OF, COMPLEXITY_ORDER };
