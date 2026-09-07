'use strict';

// ---------- COMPLETENESS CHECK (mục V) ----------
// Trước đây hệ thống coi "AI trả lời xong stream / trả về HTTP 200" == "câu trả lời hoàn chỉnh".
// Sai — provider có thể chết giữa chừng sau khi đã stream một phần hợp lệ, hoặc trả lời "đầy đủ"
// theo nghĩa HTTP nhưng bỏ sót ý (c.ii), thiếu đáp số, hoặc dừng giữa 1 khối ```shape chưa đóng.
//
// validateSolutionCompleteness() KHÔNG chỉ nhìn ký tự cuối cùng — nó kiểm tra cấu trúc (fence/LaTeX/
// khối vẽ đã đóng chưa) VÀ đối chiếu với danh sách ý bắt buộc rút ra từ chính đề bài (Problem
// Coverage). Trả về đúng 1 trong 3 trạng thái mà nơi gọi cần: COMPLETE / INCOMPLETE / INVALID
// (FAILED là lỗi transport/provider, được rotationManager/errorClassifier xử lý riêng — không phải
// việc của module này).

const { validateCitations } = require('./citationValidator');

const MIN_MEANINGFUL_LENGTH = 8;

// ---------- Trích "Problem Coverage" từ đề bài ----------
// Cùng họ pattern với adaptiveBudget.countSubQuestions nhưng ở đây cần GIỮ LẠI nhãn gốc (để so khớp
// ngược lại trong response), không chỉ đếm số lượng.
const COVERAGE_PATTERNS = [
  { re: /(^|[\n]|[.]\s)\s*([a-jA-J])\s*[).]\s*\S/g, group: 2, normalize: (s) => s.toLowerCase() },
  { re: /(^|\n)\s*câu\s*(\d+)/gi, group: 2, normalize: (s) => `câu ${s}` },
  { re: /(^|\n)\s*(\d+)\s*[).]\s*\S/g, group: 2, normalize: (s) => s },
  { re: /(^|\n)\s*([a-jA-J])\s*\.\s*(i{1,3}v?|iv)\b/gi, group: 0, normalize: (m) => m.trim().toLowerCase().replace(/\s+/g, '') }
];

/**
 * @param {string} problemText Đề bài gốc (câu hỏi người dùng gửi, KHÔNG phải lời giải).
 * @returns {string[]} Danh sách nhãn ý bắt buộc, ví dụ ['a','b','c.i','c.ii','d']. Rỗng nếu đề
 *   không có cấu trúc nhiều ý rõ ràng (đề tự do 1 câu hỏi duy nhất) — khi đó coverage check bị bỏ
 *   qua (không thể áp đặt cấu trúc không tồn tại).
 */
function extractCoverageList(problemText) {
  if (!problemText || problemText.length > 6000) return []; // đề quá dài bất thường: bỏ qua, tránh false-positive tốn kém
  const labels = [];
  const seen = new Set();
  COVERAGE_PATTERNS.forEach(({ re, group, normalize }) => {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(problemText))) {
      const raw = group === 0 ? m[0] : m[group];
      const label = normalize(raw);
      if (label && !seen.has(label)) { seen.add(label); labels.push(label); }
      if (labels.length > 30) break; // pathological guard
    }
  });
  // Chỉ coi là "đề nhiều ý thật sự" nếu có từ 2 nhãn trở lên — 1 nhãn đơn lẻ thường là trùng khớp
  // ngẫu nhiên (vd "1)" ở giữa 1 phép tính) chứ không phải cấu trúc câu hỏi nhiều phần.
  return labels.length >= 2 ? labels : [];
}

/**
 * Đối chiếu response với coverage list — tìm nhãn xuất hiện dạng tiêu đề/mở đầu dòng trong response
 * (không đếm nhãn xuất hiện lẫn trong văn xuôi để tránh false-positive).
 */
function checkCoverage(text, coverageList) {
  if (!coverageList.length) return { missing: [], found: [] };
  const missing = [];
  const found = [];
  coverageList.forEach((label) => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|\\n)\\s*(ý\\s*)?${escaped}\\s*[).:]`, 'i');
    if (re.test(text)) found.push(label); else missing.push(label);
  });
  return { missing, found };
}

// ---------- Kiểm tra cấu trúc chưa đóng ----------
function countOccurrences(text, re) {
  const m = text.match(re);
  return m ? m.length : 0;
}

function hasUnclosedCodeFence(text) {
  const fenceCount = countOccurrences(text, /```/g);
  return fenceCount % 2 !== 0;
}

function hasUnclosedDrawBlock(text) {
  // Đếm riêng số lần MỞ khối shape/solid3d/plot so với số dấu ``` còn lại phía sau nó — nếu có 1
  // khối mở (```shape) mà không tìm thấy ``` đóng theo sau trong phần còn lại của text → chưa đóng.
  const opens = [...text.matchAll(/```(shape|solid3d|plot)\b/g)];
  if (!opens.length) return false;
  const last = opens[opens.length - 1];
  const after = text.slice(last.index + last[0].length);
  return !after.includes('```');
}

function hasUnclosedLatex(text) {
  // $$...$$ hiển thị khối — đếm số lần "$$" phải chẵn.
  const dollarBlock = countOccurrences(text, /\$\$/g);
  if (dollarBlock % 2 !== 0) return true;
  // \[ ... \] khối
  const openBracket = countOccurrences(text, /\\\[/g);
  const closeBracket = countOccurrences(text, /\\\]/g);
  if (openBracket !== closeBracket) return true;
  // \( ... \) inline
  const openParen = countOccurrences(text, /\\\(/g);
  const closeParen = countOccurrences(text, /\\\)/g);
  if (openParen !== closeParen) return true;
  return false;
}

// ---------- Dấu hiệu dừng giữa chừng (mid-sentence / mid-bullet / mid-"Bước X") ----------
const TRUNCATION_TAIL_SIGNS = [
  /[,:;–—-]\s*$/, // kết thúc bằng dấu phẩy/hai chấm/gạch nối — câu chưa trọn
  /\b(và|hoặc|là|có|khi|nếu|vì|do|nên|để|với|của|từ|theo|bằng|thì)\s*$/i, // từ nối tiếng Việt cụt cuối
  /\bBước\s*\d+\s*[:.]?\s*$/i,
  /^\s*[-*+]\s*\S{0,3}$/ // dòng cuối là bullet vừa mới mở, gần như chưa có nội dung
];

function ensClosedProperly(text) {
  const trimmed = text.trimEnd();
  if (!trimmed) return false;
  const lastChar = trimmed[trimmed.length - 1];
  // Kết thúc hợp lệ: dấu câu kết, đóng ngoặc/backtick, hoặc kết thúc bằng khối code/draw đã đóng.
  if (/[.?!)\]}"'”』…]/.test(lastChar)) return true;
  if (trimmed.endsWith('```')) return true;
  if (/[=0-9%]$/.test(lastChar)) return true; // kết thúc bằng số/kết quả phép tính/% — coi là hợp lệ
  return false;
}

function looksTruncated(text) {
  const trimmed = text.trimEnd();
  const lastLine = trimmed.split('\n').pop() || '';
  if (TRUNCATION_TAIL_SIGNS.some((re) => re.test(lastLine) || re.test(trimmed))) return true;
  if (!ensClosedProperly(trimmed)) return true;
  return false;
}

/**
 * @param {string} text Toàn bộ văn bản response (đã strip <thinking>).
 * @param {{stage?:'approach'|'detail', problemText?:string, coverageList?:string[], contexts?:Array}} [opts]
 *   contexts (mục 7/15): nếu có, đối chiếu MỌI citation [n] trong response với contexts.length —
 *   citation ngoài phạm vi -> reason 'invalid_citation' -> INCOMPLETE (không được coi là COMPLETE
 *   chỉ vì response "đẹp"/kết thúc đúng câu — mục 15).
 * @returns {{status:'COMPLETE'|'INCOMPLETE'|'INVALID', reasons:string[], missingCoverage:string[], citationValidation:object|null}}
 */
function validateSolutionCompleteness(text, opts = {}) {
  const { stage = 'detail', problemText = '', coverageList, contexts } = opts;
  const clean = (text || '').trim();
  const reasons = [];

  if (clean.length < MIN_MEANINGFUL_LENGTH) {
    return { status: 'INVALID', reasons: ['response_empty_or_too_short'], missingCoverage: [], citationValidation: null };
  }

  if (hasUnclosedCodeFence(clean)) reasons.push('unclosed_code_fence');
  if (hasUnclosedDrawBlock(clean)) reasons.push('unclosed_draw_block');
  if (hasUnclosedLatex(clean)) reasons.push('unclosed_latex');
  if (looksTruncated(clean)) reasons.push('truncated_tail');

  // mục 7/15: citation [n] phải nằm trong 1..contexts.length — KHÔNG để frontend âm thầm bỏ qua.
  let citationValidation = null;
  if (Array.isArray(contexts) && contexts.length) {
    citationValidation = validateCitations(clean, contexts);
    if (!citationValidation.valid) reasons.push('invalid_citation');
  }

  const list = Array.isArray(coverageList) ? coverageList : extractCoverageList(problemText);
  const { missing } = checkCoverage(clean, list);
  if (missing.length) reasons.push('missing_coverage');

  // "Bước X" cụt ở CUỐI văn bản (không phải trong thân bài — "Bước 1: ..." giữa bài là bình thường).
  if (/Bước\s*\d+\s*[:.]?\s*$/i.test(clean)) reasons.push('cut_mid_step');

  // Thiếu kết luận/đáp số ở stage 'detail' — heuristic MỀM: chỉ thêm vào reasons (ảnh hưởng status)
  // khi kết hợp với ít nhất 1 dấu hiệu cấu trúc khác ở trên, để tránh false-positive với những bài
  // giải hợp lệ nhưng không dùng đúng các từ khoá kết luận quen thuộc.
  const hasConclusionMarker = /(vậy|kết luận|đáp số|đáp án|do đó,?\s*$)/i.test(clean.slice(-400));
  if (stage === 'detail' && !hasConclusionMarker && reasons.length > 0) {
    reasons.push('missing_conclusion');
  }

  const status = reasons.length ? 'INCOMPLETE' : 'COMPLETE';
  return { status, reasons, missingCoverage: missing, citationValidation };
}

module.exports = {
  extractCoverageList,
  checkCoverage,
  validateSolutionCompleteness,
  hasUnclosedCodeFence,
  hasUnclosedDrawBlock,
  hasUnclosedLatex,
  looksTruncated
};
