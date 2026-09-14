'use strict';

// ============================================================================================
// LỚP PHÒNG VỆ THỨ 3 — NHÁP LẬP KẾ HOẠCH KHÔNG CÓ THẺ BỊ LỘ RA CÂU TRẢ LỜI
// ============================================================================================
// NGUYÊN NHÂN GỐC (quan sát được trên ảnh người dùng gửi, lượt CONTINUATION của một lời giải Sinh
// học tiếng Việt):
//
//     "We need to continue from that point, not repeat anything before. Keep same numbering: we
//      were at step 6 (Hệ tiêu hóa). Then after finishing step 6, continue with step 7 maybe? ..."
//     "We must not repeat previous content, but we can continue the sentence: "Dạ dày...". ..."
//     "After that, we need to provide Kết luận section (with..."
//
// Đây KHÔNG phải khối <thinking> (đã có thinkingFilter.js) và KHÔNG phải nhãn phân loại an toàn
// (đã có safetyLeakFilter.js). Nó là model ĐỌC TO LẠI chỉ dẫn của prompt tiếp nối
// (continuation.js#buildResumePrompt: "viết tiếp từ đúng chỗ", "không lặp lại phần đã viết", "giữ
// nguyên cách đánh số") dưới dạng văn xuôi tiếng Anh ngôi thứ nhất số nhiều, rồi stream thẳng ra
// như thể đó là lời giải. Người dùng nhìn thấy nội bộ hệ thống nói chuyện với chính nó.
//
// VÌ SAO CHẶN BẰNG BỘ LỌC CHỨ KHÔNG CHỈ SỬA PROMPT: prompt tiếp nối buộc phải mô tả ràng buộc
// "viết tiếp, đừng lặp lại" — đó chính là thứ model có xu hướng nhại lại. Sửa prompt làm giảm tần
// suất nhưng không loại trừ được, và lỗi này thì người dùng thấy ngay. Bộ lọc là lớp chắc chắn.
//
// NGUYÊN TẮC CHỐNG DƯƠNG TÍNH GIẢ (quan trọng hơn việc bắt được nhiều):
// Một dòng CHỈ bị loại khi hội đủ CẢ HAI điều kiện:
//   (1) MỞ ĐẦU bằng một khuôn lập kế hoạch ngôi thứ nhất ("We need to", "We must", "Let's",
//       "I should", "The user wants", "Then after finishing", ...), VÀ
//   (2) CHỨA một danh từ META nói về CHÍNH CÂU TRẢ LỜI ĐANG VIẾT (continue, repeat, step,
//       numbering, section, conclusion, answer, response, example, previous, output, format...).
// Một câu trả lời tiếng Anh thật về nội dung học thuật gần như không bao giờ khớp đồng thời cả hai
// — vd "We need to find the derivative of f(x)" có (1) nhưng không có (2) nên được GIỮ LẠI.
//
// Dòng nằm trong khối mã ``` KHÔNG BAO GIỜ bị đụng tới (mã có thể chứa bất kỳ văn bản nào).
// ============================================================================================

// (1) Khuôn mở đầu lập kế hoạch. Neo vào ĐẦU DÒNG (cho phép bullet/đậm markdown phía trước).
const PLANNING_OPENER_RE = new RegExp(
  '^\\s*(?:[-*>]\\s*)?\\**\\s*(?:'
  + 'we\\s+(?:need|must|should|can|will|have|are|were|may)\\b'
  + '|let(?:\'|\u2019)?s\\b'
  + '|i\\s+(?:need|must|should|will|am)\\b'
  + '|the\\s+user\\s+(?:wants?|asked|is)\\b'
  + '|the\\s+previous\\s+(?:steps?|content|answer|part)\\b'
  + '|(?:so|then|now|next|after\\s+that)[, ]+\\s*(?:we|i|let)\\b'
  + '|continuing\\s+from\\b'
  + '|(?:so|then|now|next)\\s+(?:after\\s+)?finish(?:ing|ed)?\\b'
  + '|(?:so|then|now|next)\\s+(?:we|i)\\b'
  + '|keep\\s+(?:the\\s+)?same\\b'
  + '|(?:maybe|perhaps)\\s+(?:we|i)\\b'
  + ')',
  'i'
);

// (2) Danh từ META — nói về chính câu trả lời/định dạng, không phải về nội dung môn học.
const META_OBJECT_RE = new RegExp(
  '\\b(?:'
  + 'continue|continuation|repeat|repeating|rephrase|reword'
  + '|same\\s+numbering|numbering|enumerated|bullet|heading|section|format|formatting'
  + '|conclusion|k\u1ebft\\s+lu\u1eadn'
  + '|previous\\s+(?:steps?|content|part|answer|response|message)'
  + '|the\\s+(?:answer|response|explanation|example|output)'
  + '|step\\s*\\d+'
  + '|finish(?:ing)?\\s+(?:the\\s+)?(?:example|answer|section|step)'
  + '|move\\s+to|proceed\\s+to|wrap\\s+up'
  + '|word\\s+count|token'
  + ')\\b',
  'i'
);

// Dải phân cách mà model hay in ra ngay sau khối nháp ("---", "***"). Chỉ bị bỏ khi nó đứng NGAY
// SAU một dòng nháp đã bị loại (xử lý ở stripMetaPlanning/bộ lọc stream), không bao giờ bỏ vô điều
// kiện — "---" là cú pháp markdown hợp lệ trong câu trả lời thật.
const SEPARATOR_ONLY_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
// Dòng chỉ có đúng 1 dấu chấm/gạch đầu dòng rỗng — mảnh vỡ hay gặp NGAY TRƯỚC/SAU 1 checklist bị
// cắt (bullet marker in ra trước khi có nội dung, hoặc câu bị cắt chỉ còn dấu câu). Áp dụng CÙNG
// điều kiện với SEPARATOR_ONLY_RE: chỉ bỏ khi đứng cạnh 1 dòng vừa bị loại, không bao giờ vô điều
// kiện — "." một mình có thể là nội dung thật (rất hiếm nhưng không loại trừ).
const STRAY_PUNCT_ONLY_RE = /^\s*[-*]?\s*[.]\s*$/;

// ============================================================================================
// LỚP PHÒNG VỆ THỨ 4 — CHECKLIST TỰ-KIỂM (self-check) VỀ ĐỊNH DẠNG BỊ LỘ RA CÂU TRẢ LỜI
// ============================================================================================
// NGUYÊN NHÂN GỐC (quan sát được trên ảnh người dùng gửi): ngay dưới "Lời giải chi tiết" xuất hiện
//     "* No titles/headers? Yes."
//     "* No extra text?"
// Đây là model tự trả lời lại CHÍNH RÀNG BUỘC ĐỊNH DẠNG trong system prompt (dạng "không tiêu đề?
// không có chữ thừa?") như một checklist tự kiểm tra ngôi thứ ba dạng câu hỏi/trả lời ngắn — khác
// với LỚP 3 ở trên (vốn bắt câu văn xuôi ngôi thứ nhất kiểu "We need to..."). Không có thẻ bao
// quanh nên thinkingFilter/safetyLeakFilter không bắt được; PLANNING_OPENER_RE cũng không khớp vì
// không mở đầu bằng "We/I/Let's...".
//
// Một dòng CHỈ bị loại khi hội đủ CẢ HAI điều kiện (đúng nguyên tắc chống dương tính giả như LỚP 3):
//   (1) ĐÚNG HÌNH DẠNG một mục checklist ngắn: bullet + cụm ngắn kết thúc bằng dấu "?" (có thể kèm
//       Yes/No/Có/Không ngay sau), KHÔNG phải một câu hỏi học thuật dài có ngữ cảnh.
//   (2) CHỨA danh từ META nói về ĐỊNH DẠNG ĐẦU RA (tiêu đề, chữ thừa, markdown, footer...), không
//       phải nội dung môn học — một câu hỏi ôn tập thật như "Có bao nhiêu proton?" không khớp (2).
// Cụm xác nhận cuối câu hỏi — BAN ĐẦU chỉ có yes/no/đúng/không/có/chưa. Ảnh lỗi mới (đợt audit
// "tạo hình ảnh cấu tạo cơ thể người") cho thấy model cũng tự xác nhận bằng "Checked."/"Done."/
// "Confirmed." — những từ này CHỈ có nghĩa "đã tự kiểm tra xong", không bao giờ xuất hiện tự nhiên
// làm từ xác nhận cuối 1 câu hỏi ngắn dạng checklist trong một câu trả lời học thuật thật.
const SELF_CHECK_LINE_RE = /^\s*[-*]\s*(?:no|not|have|has|is|are|include[sd]?|avoid|ensure|did|does|any)\b[^?\n]{0,80}\?\s*(?:yes|no|đúng|không|có|chưa|checked|confirmed|done|ok(?:ay)?|complete[d]?|verified)?\.?\s*$/i;
const SELF_CHECK_META_RE = /\b(?:titles?|headers?|heading|extra\s+text|extra\s+content|markdown|footer|disclaimer|placeholder|format(?:ting)?|word\s+count)\b/i;

function isSelfCheckLine(line) {
  const t = String(line == null ? '' : line).trim();
  if (!t || t.length > 120) return false;
  if (!SELF_CHECK_LINE_RE.test(t)) return false;
  return SELF_CHECK_META_RE.test(t);
}

// ============================================================================================
// LỚP PHÒNG VỆ THỨ 5 — XÁC NHẬN TRẦN TRỤI ("Checked.") ĐỨNG RIÊNG 1 DÒNG
// ============================================================================================
// NGUYÊN NHÂN GỐC (ảnh người dùng gửi, yêu cầu "tạo hình ảnh cấu tạo cơ thể người"): dòng ĐẦU TIÊN
// của phản hồi chỉ là "Checked." — mảnh còn lại của một mục checklist tự-kiểm sau khi phần câu hỏi
// (vd "No titles/headers?") đã bị cắt mất ở đầu stream, hoặc model chỉ in ra đúng từ xác nhận. Danh
// sách từ CỐ Ý đóng kín (không nhận diện theo khuôn mẫu mở) để tối thiểu hoá dương tính giả: một
// dòng chỉ có "Checked." hay "Done." đứng riêng biệt gần như không bao giờ là nội dung học thuật
// thật (không mang thông tin gì để dạy).
const BARE_CONFIRMATION_RE = /^\s*(?:[-*]\s*|\d+[.)]\s*)?(?:checked|confirmed|verified|done|ok(?:ay)?|complete[d]?)\.?\s*$/i;

function isBareConfirmationLine(line) {
  return BARE_CONFIRMATION_RE.test(String(line == null ? '' : line));
}

// ============================================================================================
// LỚP PHÒNG VỆ THỨ 6 — TIÊU ĐỀ BƯỚC XỬ LÝ NỘI BỘ ĐÁNH SỐ + IN ĐẬM
// ============================================================================================
// NGUYÊN NHÂN GỐC (cùng ảnh trên): "5. **Final Output Generation (" — model liệt kê các bước quy
// trình SINH RA CHÍNH CÂU TRẢ LỜI của nó (không phải các bước giải bài) rồi lộ ra ngoài. Chỉ khớp
// khi có CẢ đánh số + in đậm + cụm từ nói thẳng về việc sinh output cuối cùng — một tiêu đề bước
// giải bài thật ("5. **Bước cuối: Kết luận**") không chứa các cụm này nên không bị đụng tới.
const NUMBERED_PROCESS_HEADER_RE = /^\s*\d+[.)]\s*\*{1,2}\s*(?:final\s+(?:output|answer|response|check|step)|output\s+generation)\b/i;

function isNumberedProcessHeader(line) {
  return NUMBERED_PROCESS_HEADER_RE.test(String(line == null ? '' : line));
}

// ============================================================================================
// LỚP PHÒNG VỆ THỨ 7 — MẢNH CÂU-HỎI-TỰ-KIỂM BỊ NGẮT DÒNG GIỮA CHỪNG
// ============================================================================================
// NGUYÊN NHÂN GỐC (cùng ảnh trên): ', no steps, no headers? Yes (ensure no "Giới thiệu:" or
// "Thành phần:" headers).' — phần ĐẦU câu hỏi tự-kiểm nằm ở dòng TRƯỚC (đã bị loại), phần ĐUÔI trôi
// sang dòng sau, không còn bullet/opener nào để LỚP 3/4 nhận ra. CHỈ được loại khi đứng NGAY SAU một
// dòng vừa bị loại (cascading — cùng nguyên tắc với SEPARATOR_ONLY_RE/STRAY_PUNCT_ONLY_RE), và phải
// vừa (a) không mở đầu bằng chữ hoa (không phải câu văn mới) vừa (b) chứa dấu "?" vừa (c) chứa danh
// từ META về định dạng đầu ra — ba điều kiện cộng dồn với "cascading" giữ dương tính giả gần như 0.
const CONTINUATION_FRAGMENT_START_RE = /^\s*[a-z,;:)\]-]/;

function isMetaContinuationFragment(line) {
  const raw = String(line == null ? '' : line);
  const t = raw.trim();
  if (!t || t.length > 200) return false;
  if (!/\?/.test(t)) return false;
  if (!CONTINUATION_FRAGMENT_START_RE.test(raw)) return false;
  return SELF_CHECK_META_RE.test(t);
}

/**
 * @param {string} line Một dòng văn bản.
 * @returns {boolean} true nếu dòng này là nháp lập kế hoạch nội bộ, không phải nội dung trả lời.
 */
function isMetaPlanningLine(line) {
  const t = String(line == null ? '' : line).trim();
  if (!t) return false;
  if (t.length > 600) return false;               // đoạn rất dài gần như chắc chắn là nội dung thật
  if (/^\s*(?:#{1,6}\s|\|)/.test(t)) return false; // tiêu đề markdown / hàng bảng: nội dung thật
  if (isSelfCheckLine(t)) return true;             // LỚP 4: checklist tự-kiểm về định dạng
  if (isBareConfirmationLine(t)) return true;       // LỚP 5: "Checked."/"Done." đứng riêng
  if (isNumberedProcessHeader(t)) return true;      // LỚP 6: tiêu đề bước sinh output đánh số+đậm
  if (!PLANNING_OPENER_RE.test(t)) return false;
  return META_OBJECT_RE.test(t);
}

/**
 * Bản KHÔNG streaming. Bỏ các dòng nháp lập kế hoạch, BỎ QUA mọi thứ nằm trong khối mã ```.
 * Dải phân cách ("---") chỉ bị bỏ khi nó đứng ngay sau một dòng vừa bị loại.
 * @param {string} text
 * @returns {string}
 */
function stripMetaPlanning(text) {
  const raw = String(text || '');
  if (!raw) return '';
  const lines = raw.split('\n');
  const kept = [];
  let insideFence = false;
  let lastWasDropped = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) { insideFence = !insideFence; kept.push(line); lastWasDropped = false; continue; }
    if (insideFence) { kept.push(line); lastWasDropped = false; continue; }
    if (isMetaPlanningLine(line)) { lastWasDropped = true; continue; }
    if (lastWasDropped && (SEPARATOR_ONLY_RE.test(line) || STRAY_PUNCT_ONLY_RE.test(line) || isMetaContinuationFragment(line))) { continue; } // LỚP 7
    if (lastWasDropped && !line.trim()) { continue; } // không để lại khoảng trống lạ ở chỗ vừa cắt
    lastWasDropped = false;
    kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * true khi TOÀN BỘ nội dung chỉ là nháp lập kế hoạch — tức lượt gọi này không sinh ra câu trả lời
 * nào cả. Nơi gọi (aiProviders) coi như "phản hồi rỗng" để kích hoạt failover sang target khác,
 * thay vì giao cho người dùng một khoảng trắng.
 * @param {string} text
 * @returns {boolean}
 */
function isOnlyMetaPlanning(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  const hadPlanning = raw.split('\n').some((l) => isMetaPlanningLine(l));
  return hadPlanning && !stripMetaPlanning(raw);
}

/**
 * Bản STREAMING — cùng hợp đồng với createSafetyLineFilter: giữ lại đúng một dòng chưa hoàn chỉnh
 * trong buffer, chỉ quyết định khi đã thấy '\n'. Độ trễ thêm tối đa một dòng.
 * @param {Function} onVisible
 */
function createMetaPlanningFilter(onVisible) {
  let buf = '';
  let insideFence = false;
  let lastWasDropped = false;

  function handle(line) {
    if (/^\s*```/.test(line)) { insideFence = !insideFence; lastWasDropped = false; onVisible(line); return; }
    if (insideFence) { lastWasDropped = false; onVisible(line); return; }
    if (isMetaPlanningLine(line)) { lastWasDropped = true; return; }
    if (lastWasDropped && (SEPARATOR_ONLY_RE.test(line) || STRAY_PUNCT_ONLY_RE.test(line) || isMetaContinuationFragment(line) || !line.trim())) return; // LỚP 7
    lastWasDropped = false;
    onVisible(line);
  }

  return {
    feed(piece) {
      buf += piece;
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx + 1);
        buf = buf.slice(idx + 1);
        handle(line);
      }
    },
    flush() {
      if (buf) { handle(buf); buf = ''; }
    }
  };
}

module.exports = {
  isMetaPlanningLine,
  stripMetaPlanning,
  isOnlyMetaPlanning,
  createMetaPlanningFilter,
  PLANNING_OPENER_RE,
  META_OBJECT_RE,
  isSelfCheckLine,
  SELF_CHECK_LINE_RE,
  SELF_CHECK_META_RE,
  isBareConfirmationLine,
  BARE_CONFIRMATION_RE,
  isNumberedProcessHeader,
  NUMBERED_PROCESS_HEADER_RE,
  isMetaContinuationFragment,
  CONTINUATION_FRAGMENT_START_RE
};
