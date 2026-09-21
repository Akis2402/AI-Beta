'use strict';

// ============================================================================================
// historyImportance.js — MỤC 16 + 17 của yêu cầu audit: MỘT nguồn sự thật duy nhất cho câu hỏi
// "đoạn nội dung này quan trọng tới mức nào".
// ============================================================================================
// BUG GỐC được sửa ở đây (mục 16): cả `tokenEconomy.classifyHistoryImportance()` lẫn
// `contextCompressor.scoreImportance()` đều chạy heuristic ĐỘ DÀI trước:
//     if (content.trim().length < 4) return OPTIONAL;      // tokenEconomy
//     if (trimmed.length < 8) return REDUNDANT;            // contextCompressor
// Hệ quả: những dữ kiện NGẮN NHƯNG SỐNG CÒN bị vứt trước khi ai kịp nhìn tới nội dung:
//     "x=2" (3 ký tự) · "y=-3" (4) · "AB=6" (4) · "(2,3)" (5) · "R = 5 cm" (8)
// Mất 1 dòng như vậy là mất hẳn dữ kiện của đề bài — lời giải sau đó sai hoặc phải hỏi lại.
//
// THỨ TỰ ĐÚNG (mục 16) và module này thực thi đúng thứ tự đó:
//   1. bảo vệ trạng thái toán học/dữ liệu   (số, phép gán, công thức, toạ độ, đơn vị, hệ thức)
//   2. bảo vệ trạng thái đang hoạt động      (hình vẽ/đồ thị/khối 3D, lựa chọn đang chọn, đáp án trước)
//   3. phát hiện phụ thuộc/liên quan         (do caller cung cấp: từ khoá đề bài, trùng lặp)
//   4. CHỈ SAU CÙNG mới tới heuristic độ dài
//
// MỤC 17: cả hai module tiêu dùng cùng hàm này — không còn chuyện module A coi 1 dữ kiện là
// CRITICAL trong khi module B đã vứt nó đi.

const LEVEL = {
  CRITICAL: 'CRITICAL',   // mất là hỏng lời giải: dữ kiện, công thức, trạng thái hình vẽ
  HIGH: 'HIGH',           // rất nên giữ: liên quan trực tiếp đề bài
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
  REDUNDANT: 'REDUNDANT'  // bỏ được: chào hỏi, trùng lặp, rác ngắn KHÔNG chứa dữ kiện
};

// 3 mức dùng cho history (tokenEconomy) — ánh xạ từ LEVEL 5 mức để 2 nơi không lệch nhau.
const HISTORY_IMPORTANCE = { CRITICAL: 'CRITICAL', IMPORTANT: 'IMPORTANT', OPTIONAL: 'OPTIONAL' };

// ---------- Các mẫu nhận diện "dữ kiện thật" ----------
// Phép gán/hệ thức: x=2, y = -3, AB=6, R = 5, a≥0, S = 1/2·a·h, f(x)=..., v_0 = 20
const ASSIGNMENT_RE = /(^|[\s(,;])[A-Za-zΑ-Ωα-ω][A-Za-z0-9_'’]{0,6}(\([^)]{0,12}\))?\s*(=|≈|≤|≥|<|>|:=)\s*-?[\d.,/√πe(]/u;
// Số kèm đơn vị đo: 5 cm, 3.5 kg, 60°, 90 độ, 2 m/s, 12%, 1,5 lít
const NUMBER_UNIT_RE = /-?\d+([.,]\d+)?\s*(%|°|º|mm|cm|dm|m|km|mg|g|kg|ml|l|lít|s|giây|phút|giờ|h|N|J|W|V|A|Ω|Pa|atm|mol|độ|m\/s|km\/h|m2|m3|cm2|cm3)\b/i;
// Toạ độ/điểm/vector: (2,3), (-1; 4), A(0,0), M(1,2,3)
const COORDINATE_RE = /[A-Za-z]?\s*\(\s*-?\d+([.,]\d+)?\s*[,;]\s*-?\d+([.,]\d+)?(\s*[,;]\s*-?\d+([.,]\d+)?)?\s*\)/;
// Công thức LaTeX (inline hoặc block) — $...$, \(...\), \[...\]
const LATEX_RE = /\$[^$\n]+\$|\\\([^)]+\\\)|\\\[[^\]]+\\\]/;
// Ký hiệu toán học đứng một mình vẫn là dữ kiện: ∠ABC, √2, π, ∫, Σ, ≠, ⊥, //
const MATH_SYMBOL_RE = /[∠√π∫∑∏≠≈≤≥⊥∈∉⊂∪∩∆°]|\bsin\b|\bcos\b|\btan\b|\blog\b|\bln\b/i;
// Trạng thái đang hoạt động: khối vẽ hình/đồ thị/3D do chính hệ thống sinh ra
const ACTIVE_STATE_RE = /```(shape|solid3d|plot|mermaid)/;
// Người dùng chọn đáp án/phương án: "chọn B", "đáp án: C", "câu 3: A"
const SELECTION_RE = /\b(chọn|đáp án|answer|option)\b\s*[:\-]?\s*[A-Da-d1-9]\b/i;
// Nhãn yêu cầu nhiều phần: (a) (b) (c), 1) 2), i) ii) — giữ để không mất cấu trúc đề nhiều ý
const REQUIREMENT_LABEL_RE = /(^|\s)[(\[]?([a-h]|[ivx]{1,4}|\d{1,2})[)\].]\s/i;

const GREETING_RE = /^(chào|hi|hello|xin chào|cảm ơn|cám ơn|thanks|thank you|ok(ay)?|dạ|vâng|ừ|uh|yes|no|không)[\s!.,…]*$/i;

/**
 * Nội dung này có mang TRẠNG THÁI TOÁN HỌC/DỮ LIỆU cần bảo toàn không?
 * Đây là hàng rào chạy TRƯỚC mọi heuristic độ dài. Ngắn không có nghĩa là không quan trọng.
 * @returns {{protected:boolean, reasons:string[]}}
 */
function detectDataState(text) {
  const s = String(text || '');
  const reasons = [];
  if (ACTIVE_STATE_RE.test(s)) reasons.push('drawing_state');
  if (LATEX_RE.test(s)) reasons.push('formula');
  if (ASSIGNMENT_RE.test(s)) reasons.push('assignment');
  if (COORDINATE_RE.test(s)) reasons.push('coordinate');
  if (NUMBER_UNIT_RE.test(s)) reasons.push('number_with_unit');
  if (MATH_SYMBOL_RE.test(s)) reasons.push('math_symbol');
  if (SELECTION_RE.test(s)) reasons.push('selected_option');
  if (REQUIREMENT_LABEL_RE.test(s)) reasons.push('requirement_label');
  // Số trần trụi (vd "6" hoặc "12 24 36") chỉ được coi là dữ kiện khi đoạn RẤT ngắn — đúng kiểu
  // người dùng gửi thêm dữ kiện rời; trong văn xuôi dài thì số là chuyện bình thường, không đặc biệt.
  if (!reasons.length && s.trim().length <= 24 && /-?\d/.test(s)) reasons.push('bare_number');
  return { protected: reasons.length > 0, reasons };
}

/**
 * Phân loại 5 mức dùng chung. Caller truyền vào những gì CHỈ caller biết:
 *   isCore      — đề bài/yêu cầu/luật an toàn (luôn CRITICAL)
 *   isDuplicate — đã thấy nội dung y hệt trước đó
 *   relevance   — 'high' | 'medium' | 'low' (độ trùng từ khoá với đề bài, do caller tính)
 * @returns {{level:string, reasons:string[]}}
 */
function classifyContent(text, { isCore = false, isDuplicate = false, relevance = null } = {}) {
  const s = String(text || '');
  const trimmed = s.trim();
  if (isCore) return { level: LEVEL.CRITICAL, reasons: ['core'] };
  if (!trimmed) return { level: LEVEL.REDUNDANT, reasons: ['empty'] };

  // 1 + 2: trạng thái dữ liệu/hình vẽ — TRƯỚC cả kiểm tra trùng lặp và độ dài.
  const data = detectDataState(trimmed);
  if (data.protected) {
    if (isDuplicate) return { level: LEVEL.HIGH, reasons: data.reasons.concat('duplicate_but_data') };
    return { level: LEVEL.CRITICAL, reasons: data.reasons };
  }

  if (isDuplicate) return { level: LEVEL.REDUNDANT, reasons: ['duplicate'] };

  // 3: chào hỏi/xác nhận thuần tuý — đã chắc chắn KHÔNG chứa dữ kiện nào ở bước trên.
  if (GREETING_RE.test(trimmed)) return { level: LEVEL.REDUNDANT, reasons: ['greeting'] };

  // 4: CHỈ TỚI ĐÂY mới được dùng độ dài.
  if (trimmed.length < 8) return { level: LEVEL.REDUNDANT, reasons: ['too_short_no_data'] };

  if (relevance === 'high') return { level: LEVEL.HIGH, reasons: ['relevant'] };
  if (relevance === 'medium') return { level: LEVEL.MEDIUM, reasons: ['somewhat_relevant'] };
  if (relevance === 'low') return { level: LEVEL.LOW, reasons: ['not_relevant'] };
  return { level: trimmed.length > 40 ? LEVEL.HIGH : LEVEL.MEDIUM, reasons: ['length_only'] };
}

/** Bản 3 mức cho history (tokenEconomy) — dựng TỪ cùng một classifier, không có luật riêng. */
function classifyHistoryTurn(turn) {
  const content = (turn && typeof turn === 'object') ? turn.content : turn;
  const { level } = classifyContent(content);
  if (level === LEVEL.CRITICAL) return HISTORY_IMPORTANCE.CRITICAL;
  if (level === LEVEL.HIGH) return HISTORY_IMPORTANCE.IMPORTANT;
  if (level === LEVEL.MEDIUM) {
    return String((content == null ? '' : content)).trim().length > 40
      ? HISTORY_IMPORTANCE.IMPORTANT : HISTORY_IMPORTANCE.OPTIONAL;
  }
  return HISTORY_IMPORTANCE.OPTIONAL;
}

module.exports = {
  LEVEL, HISTORY_IMPORTANCE,
  detectDataState, classifyContent, classifyHistoryTurn,
  // Xuất regex để test/tài liệu soi được đúng luật đang chạy, không phải bản chép tay khác.
  PATTERNS: { ASSIGNMENT_RE, NUMBER_UNIT_RE, COORDINATE_RE, LATEX_RE, MATH_SYMBOL_RE, ACTIVE_STATE_RE, SELECTION_RE, REQUIREMENT_LABEL_RE, GREETING_RE }
};
