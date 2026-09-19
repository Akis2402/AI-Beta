'use strict';

// ---------- APPROACH COMPACTNESS VALIDATOR (mục II master spec) ----------
// APPROACH = ĐỊNH HƯỚNG, DETAIL = LỜI GIẢI. Stage "approach" phải độc lập hoàn toàn với "detail":
// tối đa 5 bullet, mỗi bullet 1 câu ngắn, không tính toán dài, không đáp số cuối, không giải thích
// dài. Validator này KHÔNG dùng AI — thuần heuristic, rẻ, chạy sau mỗi lượt approach để phát hiện vi
// phạm rồi kích hoạt 1 lượt REPAIR NGẮN (không regenerate toàn bộ, không retry vô hạn — mục II).

const MAX_BULLETS = 5;
const MAX_LINES_SOFT = 14; // approach có thể có heading + bullet + hình vẽ JSON -> nới hơn số bullet thuần
const MAX_CHARS = 1400; // bullet 4-5 câu ngắn hiếm khi vượt mốc này trừ khi đã lẫn sang lời giải
// ---------- MỤC 7: HARD CONTRACT CỦA APPROACH ----------
// Approach KHÔNG phải một Detail thu nhỏ, nên nó cũng không được hưởng chính sách recovery của
// Detail. Một approach bị cắt cần thêm vài dòng để đóng ý, không cần vài nghìn token để "giải tiếp".
const MAX_CONTINUATION_TOKENS = Number(process.env.APPROACH_MAX_CONTINUATION_TOKENS) || 400;
const MAX_REPAIR_CALLS = 1;

// Dấu hiệu approach đã "leak" sang lời giải chi tiết: chuỗi biến đổi nhiều dòng liên tiếp có dấu "="
// hoặc phép tính cụ thể, hoặc đáp số cuối được đóng khung/in đậm.
const FINAL_ANSWER_RE = /(đáp số|kết luận\s*:|vậy[^=\n]{0,15}=\s*-?\d|\b[a-z]\s*=\s*-?\d+(\.\d+)?)/i;
const LONG_CALC_CHAIN_RE = /(=[^\n=]{1,40}){3,}/; // >=3 dấu "=" liên tiếp trong cùng vùng hẹp -> chuỗi biến đổi dài
const DETAILED_STEP_RE = /^\s*(bước|step)\s*\d+\s*[:.]/im; // approach không dùng "Bước 1:" đánh số như detail

function countBullets(text) {
  const lines = String(text || '').split('\n');
  return lines.filter((l) => /^\s*[-*•]\s+\S/.test(l) || /^\s*\d+[.)]\s+\S/.test(l)).length;
}

function stripDrawingBlocks(text) {
  // Khối vẽ hình (```shape/solid3d/scene3d/plot ... ```) là dữ liệu hình học hợp lệ ở approach, không
  // tính vào mật độ phép toán/độ dài văn bản khi kiểm tra compactness.
  return String(text || '').replace(/```(shape|solid3d|scene3d|plot)[\s\S]*?```/g, '');
}

/**
 * @param {string} approachText - toàn bộ output của stage 'approach' (đã bỏ phần "## Tóm tắt đề bài")
 * @returns {{ok:boolean, violations:string[], bulletCount:number}}
 */
function validateApproachCompactness(approachText) {
  const violations = [];
  const body = stripDrawingBlocks(approachText);
  const bulletCount = countBullets(body);
  const lineCount = body.split('\n').filter((l) => l.trim()).length;

  if (bulletCount > MAX_BULLETS) violations.push(`too_many_bullets:${bulletCount}`);
  if (lineCount > MAX_LINES_SOFT) violations.push(`too_many_lines:${lineCount}`);
  if (body.length > MAX_CHARS) violations.push(`too_long:${body.length}`);
  if (FINAL_ANSWER_RE.test(body)) violations.push('contains_final_answer');
  if (LONG_CALC_CHAIN_RE.test(body)) violations.push('long_calculation_chain');
  if (DETAILED_STEP_RE.test(body)) violations.push('detailed_step_numbering');

  return { ok: violations.length === 0, violations, bulletCount };
}

/**
 * Sinh 1 prompt REPAIR NGẮN — chỉ yêu cầu rút gọn lại approach đã có, KHÔNG regenerate toàn bộ
 * conversation, KHÔNG đổi nội dung khoa học (giữ nguyên công thức/điều kiện), chỉ nén CÂU CHỮ.
 * @param {string} approachText
 * @param {string[]} violations
 * @returns {string}
 */
function buildApproachRepairPrompt(approachText, violations) {
  const reasons = violations.join(', ');
  return `Hướng giải bạn vừa viết vi phạm định dạng bắt buộc (lỗi phát hiện được: ${reasons}). Đây là hướng giải cũ:
---
${approachText}
---
Hãy viết LẠI CHỈ phần "## Hướng giải" (giữ nguyên "## Tóm tắt đề bài" và hình vẽ nếu có), rút gọn còn TỐI ĐA 5 gạch đầu dòng, mỗi gạch đầu dòng CHỈ 1 CÂU NGẮN nêu phương pháp/công thức/thứ tự bước/điều kiện quan trọng. TUYỆT ĐỐI KHÔNG tính toán chi tiết, KHÔNG đưa đáp số cuối cùng, KHÔNG đánh số "Bước 1/Bước 2" như lời giải chi tiết. Không được bỏ sót điều kiện/công thức quan trọng đã có — chỉ nén câu chữ, không nén nội dung khoa học. Trả lời đầy đủ lại toàn bộ nội dung theo đúng định dạng "## " ban đầu.`;
}

// Trích riêng phần "## Hướng giải"/"## Approach" ra khỏi toàn bộ output approach (còn có
// "## Tóm tắt đề bài" phía trước) để validator không đếm nhầm câu văn xuôi tóm tắt đề vào bullet/độ
// dài của chính phần định hướng. Khớp cả 2 ngôn ngữ hiện có (xem getHeaders() trong promptBuilder.js).
const APPROACH_HEADING_RE = /^##\s*(Hướng giải|Approach)\s*$/im;

function extractApproachSection(fullText) {
  const text = String(fullText || '');
  const m = APPROACH_HEADING_RE.exec(text);
  if (!m) return text; // không tìm thấy heading -> validate cả đoạn (an toàn hơn bỏ qua)
  const rest = text.slice(m.index + m[0].length);
  const nextHeading = rest.search(/^##\s+/m);
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

/**
 * MỤC 7 — PHÁT HIỆN APPROACH ĐÃ "RƠI" THÀNH DETAIL.
 *
 * Bất biến sản phẩm: approach lỗi thì giữ BẢN APPROACH TỐT NHẤT, TUYỆT ĐỐI không được lặng lẽ trả
 * về một lời giải chi tiết thay thế — người dùng bấm "Hướng giải" mà nhận nguyên lời giải thì hai
 * giai đoạn của sản phẩm sụp thành một, và lượt Detail sau đó là token trả cho nội dung đã có.
 *
 * @param {string} text output của stage 'approach'
 * @returns {{fellBack:boolean, signals:string[]}}
 */
function detectDetailFallback(text) {
  const body = stripDrawingBlocks(text || '');
  const signals = [];
  if (FINAL_ANSWER_RE.test(body)) signals.push('final_answer_present');
  if (LONG_CALC_CHAIN_RE.test(body)) signals.push('long_calculation_chain');
  if (DETAILED_STEP_RE.test(body)) signals.push('detail_step_numbering');
  if (body.length > MAX_CHARS * 2) signals.push('detail_length');
  // Cần ít nhất HAI dấu hiệu độc lập: một mình "có đáp số" có thể chỉ là approach lỡ nêu kết quả
  // trung gian, chưa đủ để kết luận đã thành lời giải chi tiết (tránh dương tính giả).
  return { fellBack: signals.length >= 2, signals };
}

module.exports = {
  validateApproachCompactness, buildApproachRepairPrompt, extractApproachSection,
  detectDetailFallback, MAX_BULLETS, MAX_CHARS, MAX_CONTINUATION_TOKENS, MAX_REPAIR_CALLS
};
