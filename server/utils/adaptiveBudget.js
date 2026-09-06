'use strict';

// ---------- ADAPTIVE TOKEN BUDGET (mục III) ----------
// Trước đây maxTokens là hằng số cố định theo stage/deepThinking (xem chat.js cũ: ternary
// 2100/3300/3000/6000). Điều đó KHÔNG tính tới độ dài đề bài thực tế, số sub-question, độ dài
// nguồn/context, hay history — nên bài nhiều ý vẫn bị cắt ngang dù deepThinking=false, còn bài
// ngắn thì tốn ngân sách y hệt bài dài (lãng phí, tăng latency + chi phí không cần thiết).
//
// Thay bằng 1 pipeline ước lượng 3 bước rồi mới tính budget cuối — KHÔNG dùng công thức phẳng
// kiểu maxTokens = input.length * N (bị cấm ở mục III), vì độ dài input không tỉ lệ thuận với độ
// dài output cần thiết (1 đề bài 20 chữ "Tính đạo hàm hàm số ..." có thể cần output dài hơn 1 đề
// 500 chữ chỉ để copy lại 1 bảng số liệu).

const HARD_CEILING = 8000; // trần tuyệt đối, không vượt giới hạn output của bất kỳ provider nào đang hỗ trợ

/**
 * Bước 1: đo TẢI INPUT thực sự (không phải để trừ vào output, mà để biết ngữ cảnh nặng hay nhẹ —
 * ngữ cảnh nặng (nhiều context/source, history dài) cần output có chỗ để trích dẫn/đối chiếu nhiều
 * nguồn hơn). Ước lượng token bằng ký tự/3.2 — xấp xỉ hợp lý cho văn bản có dấu tiếng Việt (dấu
 * thanh/nguyên âm ghép khiến tỉ lệ ký tự/token thấp hơn tiếng Anh thuần).
 */
function estimateTokens(str) {
  if (!str) return 0;
  return Math.ceil(String(str).length / 3.2);
}

function estimateInputTokenLoad({ problemText = '', historyText = '', contextsText = '', approachText = '' } = {}) {
  const problem = estimateTokens(problemText);
  const history = estimateTokens(historyText);
  const contexts = estimateTokens(contextsText);
  const approach = estimateTokens(approachText);
  return { problem, history, contexts, approach, total: problem + history + contexts + approach };
}

// ---------- Bước 2: độ phức tạp đề bài ----------
// Đếm dấu hiệu sub-question (a), b), c.i), câu 1, ý a, 1), 2)...) — đây là tín hiệu tốt hơn nhiều
// so với đếm ký tự thô, vì 1 đề hình học ngắn nhưng có 4 ý (a,b,c,d) thực sự cần output dài hơn
// nhiều so với 1 đề tính toán đơn giản dài dòng nhưng chỉ có 1 yêu cầu.
const SUBQ_PATTERNS = [
  /(^|[\n]|[.]\s)\s*[a-jA-J]\s*[).]\s*\S/g,
  /(^|\n)\s*câu\s*\d+/gi,
  /(^|\n)\s*ý\s*[a-jA-J0-9]/gi,
  /(^|\n)\s*\d+\s*[).]\s*\S/g,
  /(^|\n)\s*[a-jA-J]\s*\.\s*(i|ii|iii|iv)\b/gi
];

function countSubQuestions(problemText) {
  if (!problemText) return 0;
  const seen = new Set();
  SUBQ_PATTERNS.forEach((re) => {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(problemText))) {
      seen.add(m[0].trim().toLowerCase());
      if (seen.size > 50) break; // chặn pathological input, không cần đếm chính xác quá 50 ý
    }
  });
  return seen.size;
}

/**
 * @returns {{level:'short'|'medium'|'large'|'very_large', subQuestionCount:number, charLength:number}}
 */
function estimateProblemComplexity({ problemText = '', hasImage = false } = {}) {
  const charLength = problemText.length;
  const subQuestionCount = countSubQuestions(problemText);

  // Ảnh (đề chụp từ sách/vở) thường chứa nhiều ý hơn những gì OCR/mô tả text thể hiện — nâng 1 bậc
  // độ phức tạp tối thiểu để tránh cắt ngang khi AI tự đọc ra nhiều ý hơn dự kiến từ text query.
  const imageBias = hasImage ? 1 : 0;

  let score = imageBias;
  if (charLength > 1200 || subQuestionCount >= 5) score += 3;
  else if (charLength > 400 || subQuestionCount >= 3) score += 2;
  else if (charLength > 150 || subQuestionCount >= 1) score += 1;

  const level = score >= 4 ? 'very_large' : score >= 3 ? 'large' : score >= 2 ? 'medium' : 'short';
  return { level, subQuestionCount, charLength };
}

// ---------- Bước 3: ngân sách output kỳ vọng theo độ phức tạp + stage ----------
// Bảng base theo (level x stage) — "approach" luôn cần ít hơn "detail" (chỉ liệt kê hướng đi, không
// trình bày lời giải đầy đủ). candidate (thu thập cross-check) cần ít hơn detail thường vì không
// phải bản cuối cùng người dùng đọc; reconcile (tổng hợp) cần NHIỀU HƠN detail thường vì phải gộp
// nhiều nguồn + giữ đủ ý của tất cả candidate.
const BASE_TARGET = {
  approach: { short: 900, medium: 1500, large: 2400, very_large: 3300 },
  detail: { short: 1400, medium: 2600, large: 4200, very_large: 5600 },
  candidate: { short: 1200, medium: 2000, large: 3000, very_large: 4000 },
  reconcile: { short: 1800, medium: 3000, large: 4600, very_large: 6200 },
  // Mục 5A: khi 2 candidate đã ĐỒNG THUẬN (cùng đáp số cuối) và hợp lệ, reconcile chỉ cần TRÌNH BÀY
  // LẠI GỌN + polish nhỏ, không cần sinh lại từ đầu như khi phải thật sự đối chiếu xung đột — budget
  // thấp hơn hẳn "reconcile" đầy đủ (xấp xỉ mức "detail" thường, không phải mức tổng hợp nhiều nguồn).
  reconcileLight: { short: 1400, medium: 2400, large: 3600, very_large: 4800 },
  // ---------- Mục 3D/8: budget RIÊNG cho tác vụ nhỏ, KHÔNG dùng chung bảng "detail" ----------
  // self-check/similar không bao giờ cần sinh lại cả 1 lời giải đầy đủ (xem studyTasks.js) — trần
  // thấp hơn NHIỀU so với detail để không lỡ tay cấp ngân sách của 1 bài giải đầy đủ cho 1 tác vụ
  // chỉ cần vài câu JSON/structured output ngắn.
  selfCheck: { short: 300, medium: 500, large: 800, very_large: 1200 },
  similar: { short: 250, medium: 400, large: 600, very_large: 900 }
};

function estimateExpectedOutputBudget({ complexity, stage, deepThinking = false, crossCheck = false }) {
  const table = BASE_TARGET[stage] || BASE_TARGET.detail;
  let target = table[complexity.level] || table.medium;

  // deepThinking yêu cầu AI tự phản biện nội bộ (khối <thinking> trước khi trả lời) — cần thêm chỗ
  // cho phần suy luận đó dù nó bị lọc khỏi output cuối (thinkingFilter), nếu không model dễ "cắt
  // ngắn" phần trả lời thật để kịp trong ngân sách khi vừa phải suy luận vừa phải trả lời.
  if (deepThinking) target = Math.round(target * 1.35);

  // crossCheck ở stage 'detail' tự nó đã tách thành candidate/reconcile riêng (xem
  // calculateAdaptiveBudget) — cờ này ở đây chỉ dùng khi gọi trực tiếp cho mục đích ước lượng
  // tổng quát (ví dụ hiển thị debug), không nhân đôi logic.
  if (crossCheck && stage !== 'candidate' && stage !== 'reconcile') target = Math.round(target * 1.15);

  return target;
}

// ---------- Bước 4 (mục VII): token budget PHẢI kết hợp thời gian còn lại của deadline ----------
// TRƯỚC ĐÂY maxTokens chỉ phụ thuộc độ phức tạp đề bài — nếu request chỉ còn 2-3s trước khi hết
// deadline (mục XIII), việc vẫn yêu cầu model sinh 4000-6000 token là vô nghĩa: provider chắc chắn bị
// cắt ngang giữa chừng bởi timeoutMs (đã bị co lại theo deadline — xem requestDeadline.js), sinh ra
// response INCOMPLETE gần như chắc chắn. Ước lượng thô: model sinh được khoảng THROUGHPUT_TOKENS_PER_SEC
// token/giây khi streaming — trừ đi 1 khoảng dự phòng cho độ trễ mạng/khởi động trước khi ước lượng.
const THROUGHPUT_TOKENS_PER_SEC = 60;
const NETWORK_OVERHEAD_MS = 2000;

/**
 * @param {number} remainingMs Thời gian còn lại (ms) của request deadline tại thời điểm tính budget.
 *   Nếu không hữu hạn (undefined/không phải số) → không giới hạn theo thời gian (Infinity), giữ đúng
 *   hành vi cũ cho các lời gọi chưa truyền deadline.
 * @returns {number}
 */
function timeRemainingBudget(remainingMs) {
  if (!Number.isFinite(remainingMs)) return Infinity;
  // Sàn tối thiểu 200 token dù remaining <= 0 — quyết định "có nên gọi provider hay không nữa" khi
  // hết ngân sách thời gian là việc của safeCallTimeout()/requestDeadline.js (mục 5), KHÔNG phải của
  // hàm này; ở đây chỉ đảm bảo maxTokens không bao giờ về 0/âm (giá trị vô nghĩa cho API provider).
  if (remainingMs <= 0) return 200;
  const usableMs = Math.max(0, remainingMs - NETWORK_OVERHEAD_MS);
  return Math.max(200, Math.round((usableMs / 1000) * THROUGHPUT_TOKENS_PER_SEC));
}

/**
 * Hàm chính: gộp cả 4 bước trên thành {min, target, max} cho 1 lượt gọi cụ thể.
 *
 * @param {{stage:'approach'|'detail'|'candidate'|'reconcile', problemText:string, historyText?:string,
 *   contextsText?:string, approachText?:string, hasImage?:boolean, deepThinking?:boolean,
 *   crossCheck?:boolean, remainingMs?:number}} opts `remainingMs` (mục VII) = deadline.remaining()
 *   TẠI THỜI ĐIỂM gọi — không truyền thì không bị giới hạn theo thời gian.
 * @returns {{min:number, target:number, max:number, complexity:object, inputLoad:object, timeBudget:number}}
 */
function calculateAdaptiveBudget(opts) {
  const {
    stage, problemText = '', historyText = '', contextsText = '', approachText = '',
    hasImage = false, deepThinking = false, crossCheck = false, remainingMs
  } = opts;

  const complexity = estimateProblemComplexity({ problemText, hasImage });
  const inputLoad = estimateInputTokenLoad({ problemText, historyText, contextsText, approachText });
  const complexityTarget = estimateExpectedOutputBudget({ complexity, stage, deepThinking, crossCheck });

  // Ngữ cảnh nặng (nhiều nguồn/history) → nới thêm 1 chút để có chỗ trích dẫn [n]/đối chiếu, nhưng
  // KHÔNG tỉ lệ thuận tuyến tính với input (đây chính là công thức "maxTokens = input*N" bị cấm) —
  // chỉ là 1 hệ số điều chỉnh nhỏ, có trần riêng.
  const contextBonus = Math.min(600, Math.round(inputLoad.contexts * 0.08));
  const complexityTarget2 = complexityTarget + contextBonus;

  // budget = min(complexityBudget, timeRemainingBudget, providerLimit) — mục VII.
  const timeBudget = timeRemainingBudget(remainingMs);
  const target = Math.min(HARD_CEILING, complexityTarget2, timeBudget);

  const min = Math.max(200, Math.min(Math.round(complexityTarget2 * 0.35), target));
  const max = Math.min(HARD_CEILING, Math.round(complexityTarget2 * 1.25), Math.max(target, timeBudget));

  return { min, target, max, complexity, inputLoad, timeBudget };
}

module.exports = {
  estimateTokens,
  estimateInputTokenLoad,
  estimateProblemComplexity,
  estimateExpectedOutputBudget,
  timeRemainingBudget,
  calculateAdaptiveBudget,
  HARD_CEILING
};
