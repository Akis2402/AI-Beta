'use strict';

// ---------- SEMANTIC COMPRESSION (mục IV / mục 8) ----------
// validators.js đã áp trần CỨNG theo từng field (MAX_HISTORY, MAX_HISTORY_ITEM...) — đó là ranh
// giới AN NINH (chống lạm dụng payload), không phải chiến lược nén. Trần đó áp dụng đều cho mọi
// request, kể cả request nhỏ, và không có thứ tự ưu tiên giữa các phần.
//
// compressForBudget() là lớp nén THEO NGỮ NGHĨA nằm sau lớp validate: khi tổng input vẫn còn vượt
// ngân sách hợp lý (estimateInputTokenLoad), loại bỏ theo đúng thứ tự ưu tiên của mục IV/mục 8 —
// CHỈ được phép cắt "lịch sử hội thoại không liên quan" (loại bỏ NGUYÊN 1 lượt hỏi-đáp cũ, không cắt
// giữa chuỗi của bất kỳ lượt nào) — đề bài/dữ kiện/công thức/nguồn/ràng buộc người dùng/approachText
// KHÔNG bao giờ bị đụng tới ở đây (giữ nguyên xuyên suốt pipeline, không đi qua module này).
//
// NÂNG CẤP LẦN NÀY (mục 8 — "KHÔNG chỉ drop history theo nguyên lượt"):
//   1. dedupeHistory(): loại các lượt TRÙNG LẶP/gần trùng (vd người dùng lỡ dán lại đúng đề, hoặc 1
//      continuation lỗi ở phiên trước để lại 2 câu trả lời gần như giống hệt nhau) — đây chính là
//      "duplicate context/repeated passages" bị liệt vào danh sách PHẢI loại bỏ, khác với việc chỉ
//      cắt theo tuổi (recency).
//   2. Khi vẫn phải cắt bớt do vượt ngân sách, KHÔNG cắt mù theo "cũ nhất trước" — chấm điểm mức độ
//      LIÊN QUAN của từng lượt cũ với đề bài HIỆN TẠI (relevanceScore), ưu tiên giữ lại lượt liên
//      quan dù cũ hơn, loại bỏ lượt "filler hội thoại" không liên quan dù có thể mới hơn 1 chút (vẫn
//      luôn giữ nguyên MIN_KEPT_TURNS lượt gần nhất để không đứt mạch hội thoại đang diễn ra).
//   3. Không bao giờ dùng string.slice()/clip() ở đây — đơn vị nhỏ nhất bị loại luôn là 1 LƯỢT
//      hỏi-đáp trọn vẹn, nên không thể cắt giữa LaTeX/JSON/câu/đối tượng hình học nằm trong 1 lượt.

const { estimateTokens } = require('./adaptiveBudget');

const DEFAULT_HISTORY_BUDGET_TOKENS = 3000; // ngân sách token dành cho phần history khi ngữ cảnh khác đã nặng
const MIN_KEPT_TURNS = 2; // luôn giữ tối thiểu 2 lượt gần nhất (round hỏi-đáp gần nhất) để không mất mạch hội thoại hiện tại

function normalizeForDedup(str) {
  return String(str || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Loại các lượt TRÙNG LẶP/gần như trùng lặp trong history — giữ lại đúng lượt xuất hiện SAU CÙNG
 * trong mỗi nhóm trùng để không làm rối mốc thời gian hội thoại. So khớp bằng nội dung đã chuẩn hoá
 * khoảng trắng, không cắt/rút gọn nội dung — mỗi lượt bị loại là loại NGUYÊN VẸN hoặc giữ NGUYÊN VẸN.
 * @param {Array<{role:string, content:string}>} list
 * @returns {Array} danh sách đã loại trùng, giữ nguyên thứ tự thời gian ban đầu.
 */
function dedupeHistory(list) {
  if (!Array.isArray(list) || list.length < 2) return list || [];
  const lastIndexOfContent = new Map();
  list.forEach((h, i) => {
    const key = h.role + '\u0000' + normalizeForDedup(h.content);
    lastIndexOfContent.set(key, i); // ghi đè -> cuối cùng luôn là lần xuất hiện MỚI NHẤT của nội dung đó
  });
  return list.filter((h, i) => lastIndexOfContent.get(h.role + '\u0000' + normalizeForDedup(h.content)) === i);
}

function keywordsOf(str) {
  return new Set(
    String(str || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3)
  );
}

// Lượt có chứa số/LaTeX/khối JSON dựng hình thường mang "numeric facts"/"formulas"/"drawing state"
// còn giá trị tham chiếu dù đã cũ — cho thêm 1 chút điểm ưu tiên giữ lại thay vì chỉ tính overlap từ
// khoá thuần tuý, đúng tinh thần thứ tự ưu tiên bảo toàn của mục 8 (numeric facts/formulas/drawing IDs).
const NUMERIC_OR_FORMULA_HINT_RE = /\$[^$]+\$|```(shape|solid3d|plot)|\b\d+([.,]\d+)?\b/;

/**
 * @param {string} turnContent
 * @param {Set<string>} problemKeywords Từ khoá của đề bài/câu hỏi HIỆN TẠI (ưu tiên giữ lượt liên quan tới nó).
 * @returns {number} điểm liên quan, cao hơn = nên giữ lại hơn khi phải cắt bớt.
 */
function relevanceScore(turnContent, problemKeywords) {
  const tk = keywordsOf(turnContent);
  let score = 0;
  if (tk.size && problemKeywords.size) {
    let hit = 0;
    tk.forEach((w) => { if (problemKeywords.has(w)) hit++; });
    score = hit / tk.size;
  }
  if (NUMERIC_OR_FORMULA_HINT_RE.test(turnContent)) score += 0.15;
  return score;
}

/**
 * @param {Array<{role:string, content:string}>} history Lịch sử đã qua validateChatBody (mới nhất ở cuối).
 * @param {{contextsTokenLoad?:number, approachTokenLoad?:number, problemTokenLoad?:number,
 *   budgetTokens?:number, currentProblemText?:string}} [opts] `currentProblemText` (mục 8): dùng để
 *   chấm điểm liên quan — nếu không truyền, hàm vẫn hoạt động đúng như trước (cắt theo cũ nhất trước).
 * @returns {{history:Array, droppedCount:number, dedupedCount:number, keptTokens:number}}
 */
function compressHistoryForBudget(history, opts = {}) {
  const rawList = Array.isArray(history) ? history : [];

  // ---------- Bước 1 (mục 8): loại trùng lặp TRƯỚC, độc lập với ngân sách token ----------
  const list = dedupeHistory(rawList);
  const dedupedCount = rawList.length - list.length;

  if (list.length <= MIN_KEPT_TURNS) {
    return { history: list, droppedCount: 0, dedupedCount, keptTokens: estimateHistoryTokens(list) };
  }

  // Ngân sách còn lại cho history co giãn theo mức độ nặng của phần contexts/approach/problem đã
  // biết trước — càng nhiều nguồn/đề bài dài thì càng ít chỗ dành cho history cũ (đúng thứ tự ưu
  // tiên: problem facts > constraints > formulas > source excerpts > previous solution context >
  // irrelevant conversational history).
  const heavyOthers = (opts.contextsTokenLoad || 0) + (opts.approachTokenLoad || 0) + (opts.problemTokenLoad || 0);
  const budget = Math.max(500, (opts.budgetTokens || DEFAULT_HISTORY_BUDGET_TOKENS) - Math.round(heavyOthers * 0.3));

  const mandatoryCount = Math.min(MIN_KEPT_TURNS, list.length);
  const mandatory = list.slice(list.length - mandatoryCount); // luôn giữ — mạch hội thoại đang diễn ra
  const candidates = list.slice(0, list.length - mandatoryCount); // phần có thể bị cắt, theo thứ tự cũ->mới

  let used = mandatory.reduce((s, h) => s + estimateTokens(h.content), 0);

  // ---------- Bước 2 (mục 8): trong phần "có thể cắt", ưu tiên giữ theo MỨC LIÊN QUAN tới đề bài ----------
  // hiện tại, không phải chỉ theo tuổi — "irrelevant history" bị loại trước dù có thể mới hơn 1 chút
  // so với 1 lượt cũ nhưng vẫn còn liên quan (vd cùng nhắc tới 1 công thức/biến đang dùng lại).
  const problemKeywords = keywordsOf(opts.currentProblemText || '');
  const scored = candidates.map((h, idx) => ({
    turn: h,
    idx, // vị trí gốc trong `candidates`, dùng để khôi phục đúng thứ tự thời gian sau khi chọn xong
    tokens: estimateTokens(h.content),
    // Không có currentProblemText truyền vào -> điểm liên quan = 0 cho tất cả -> sort ổn định giữ
    // đúng hành vi CŨ (ưu tiên giữ theo thứ tự gần đây nhất trước, tương đương bản trước khi nâng cấp).
    score: problemKeywords.size ? relevanceScore(h.content, problemKeywords) : 0
  }));

  // Sắp theo: điểm liên quan giảm dần, rồi tới độ mới (idx lớn hơn = gần đây hơn) giảm dần — đảm bảo
  // khi không phân biệt được bằng nội dung thì vẫn ưu tiên giữ lượt GẦN ĐÂY hơn (không đảo lộn hoàn
  // toàn theo hướng chỉ dựa nội dung, tránh giữ 1 lượt rất cũ chỉ vì trùng vài từ khoá ngẫu nhiên).
  scored.sort((a, b) => (b.score - a.score) || (b.idx - a.idx));

  const keptCandidateIdx = new Set();
  for (const c of scored) {
    if (used + c.tokens > budget) continue; // không đủ ngân sách cho lượt này -> loại, nhưng vẫn thử các lượt khác (có thể nhẹ hơn)
    keptCandidateIdx.add(c.idx);
    used += c.tokens;
  }

  // Khôi phục đúng thứ tự thời gian ban đầu cho các lượt được giữ lại.
  const keptCandidates = candidates.filter((_, idx) => keptCandidateIdx.has(idx));
  const kept = [...keptCandidates, ...mandatory];

  return { history: kept, droppedCount: list.length - kept.length, dedupedCount, keptTokens: used };
}

function estimateHistoryTokens(history) {
  return (history || []).reduce((sum, h) => sum + estimateTokens(h.content), 0);
}

module.exports = {
  compressHistoryForBudget, estimateHistoryTokens, dedupeHistory, relevanceScore,
  DEFAULT_HISTORY_BUDGET_TOKENS, MIN_KEPT_TURNS
};
