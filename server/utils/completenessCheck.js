'use strict';

// ---------- COMPLETENESS CHECK (mục V, refactor mục 1-9 "completion-first") ----------
// Trước đây hệ thống coi "AI trả lời xong stream / trả về HTTP 200" == "câu trả lời hoàn chỉnh".
// Sai — provider có thể chết giữa chừng sau khi đã stream một phần hợp lệ, hoặc trả lời "đầy đủ"
// theo nghĩa HTTP nhưng bỏ sót ý (c.ii), thiếu đáp số, hoặc dừng giữa 1 khối ```shape chưa đóng.
//
// FIX ROOT CAUSE (mục 1-9 audit continuation): TRƯỚC ĐÓ mọi lý do (unclosed fence, thiếu coverage,
// thiếu "Vậy/Kết luận"...) được gộp CHUNG vào 1 danh sách `reasons` — chỉ cần 1 phần tử là toàn bộ
// response bị coi INCOMPLETE và bắt buộc continuation/FAILED, kể cả khi model đã CHỦ ĐỘNG kết thúc
// đúng ý (finish_reason='stop') và nội dung thực chất đã đầy đủ, chỉ là không dùng đúng từ khoá kết
// luận quen thuộc hoặc không đúng label a/b/c. Nay:
//   - reasons được PHÂN LOẠI HARD (chắc chắn cắt/hỏng cấu trúc — PHẢI continuation/FAILED) vs
//     SOFT (nghi ngờ hình thức — KHÔNG được tự làm FAILED, chỉ đính kèm cảnh báo).
//   - Nếu provider cung cấp finishReason (xem finishReason.js) === 'stop' (model TỰ kết thúc) VÀ
//     không có HARD reason nào -> ép COMPLETE ngay, bất kể SOFT reason còn tồn đọng bao nhiêu
//     (completion-first — mục 1).
//   - finishReason === 'length' (bị cắt vì hết max_tokens) -> LUÔN LUÔN thêm 1 HARD reason
//     ('finish_reason_length'), bất kể heuristic hình thức có "trông" đã đóng hay không — đây là
//     tín hiệu truncation THẬT từ chính provider, đáng tin hơn bất kỳ heuristic đoán mò nào.
//   - Các dấu hiệu "kết thúc hợp lệ" (ensClosedProperly/TRUNCATION_TAIL_SIGNS) được NỚI RỘNG để chấp
//     nhận kết thúc bằng số, công thức/LaTeX đã đóng, bullet có nội dung, tiêu đề, câu ngắn, bảng —
//     không bắt buộc phải có "Vậy/Kết luận/Đáp số" (mục 6).
//
// validateSolutionCompleteness() vẫn trả về `status` GIỮ NGUYÊN 3 giá trị cũ ('COMPLETE'/
// 'INCOMPLETE'/'INVALID') để KHÔNG phá vỡ mọi nơi gọi/test hiện có so sánh `.status` — nơi gọi mới
// (runtimeState.js) đọc THÊM field `severity` ('HARD'|'SOFT'|undefined khi COMPLETE) để quyết định
// có coi là thành công cuối cùng hay không (mục 1/2 refactor — xem runtimeState.js).

const { validateCitations } = require('./citationValidator');
const { normalizeFinishReason } = require('./finishReason');

const MIN_MEANINGFUL_LENGTH = 8;

// ---------- Phân loại HARD vs SOFT cho từng reason code ----------
// HARD: cấu trúc chắc chắn hỏng/cắt (cú pháp chưa đóng) hoặc tín hiệu truncation THẬT từ provider,
// hoặc vi phạm CHÍNH XÁC (trích dẫn sai/hình vẽ sai JSON/lệch canonical) — không thể "coi là hoàn
// thành" dù văn bản trông gọn gàng. SOFT: chỉ là nghi ngờ HÌNH THỨC (thiếu từ khoá kết luận quen
// thuộc, thiếu 1 vài label a/b/c) — nội dung RẤT CÓ THỂ đã đầy đủ, không được tự ý FAILED.
const HARD_REASONS = new Set([
  // PHẦN B/C FIX: provider chết/mất kết nối SAU KHI đã stream một phần (interrupted) là tín hiệu
  // truncation MẠNH NHẤT — mạnh hơn cả finish_reason, vì khi bị ngắt giữa stream provider KHÔNG kịp
  // gửi message_delta/stop_reason nào cả (xem anthropicClient.callClaudeStream: stop_reason chỉ tới
  // ở sự kiện cuối). TRƯỚC ĐÂY tín hiệu này KHÔNG TỒN TẠI trong hệ thống: streamWithFailover trả về
  // partialError rồi caller bỏ qua, finishReason=null, nên completeness phải ĐOÁN bằng heuristic
  // hình thức. Nếu chỗ cắt tình cờ rơi đúng sau 1 dấu chấm/1 con số (rất dễ xảy ra giữa lời giải
  // toán), ensClosedProperly() trả true => status COMPLETE => người dùng nhận câu trả lời BỊ CẮT mà
  // hệ thống tưởng đã xong. Nay 'stream_interrupted' là HARD tuyệt đối và KHÔNG bị finish_reason
  // 'stop' ghi đè (xem validateSolutionCompleteness bên dưới).
  'stream_interrupted',
  'unclosed_code_fence',
  'unclosed_draw_block',
  'unclosed_latex',
  'truncated_tail',
  'cut_mid_step',
  'invalid_citation',
  'invalid_drawing_json',
  'drawing_canonical_mismatch',
  'finish_reason_length'
]);
const SOFT_REASONS = new Set(['missing_coverage', 'missing_conclusion']);

function classifyReasons(reasons) {
  const hard = reasons.filter((r) => HARD_REASONS.has(r));
  const soft = reasons.filter((r) => SOFT_REASONS.has(r));
  // Reason lạ (không nằm trong 2 danh sách trên, vd caller tự thêm reason mới trong tương lai) được
  // xử lý AN TOÀN theo hướng HARD — thà continuation thêm 1 lần còn hơn âm thầm bỏ sót lỗi thật chưa
  // được phân loại.
  const unknown = reasons.filter((r) => !HARD_REASONS.has(r) && !SOFT_REASONS.has(r));
  return { hard: [...hard, ...unknown], soft };
}

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
 *
 * FIX mục 7 (audit continuation): KHÔNG còn coi thiếu label CHÍNH XÁC (a/b/c/1/2...) là bằng chứng
 * ý đó chưa được trả lời — model có thể trả lời ĐÚNG NỘI DUNG của ý đó dưới dạng văn xuôi liền mạch,
 * đoạn văn không đánh số, hoặc gộp chung nhiều ý nhỏ vào 1 đoạn (vẫn là câu trả lời hợp lệ). Vì vậy,
 * trước khi kết luận 1 label "missing", thử thêm 1 bước rẻ tiền: coi response là COVERED nếu tổng độ
 * dài response đủ lớn so với số ý cần trả lời (semantic proxy — không có full semantic verifier nào
 * trong pipeline này, nhưng NGẮN kèm THIẾU LABEL chắc chắn đáng ngờ hơn DÀI kèm THIẾU LABEL). Kết
 * quả `missing` ở đây LUÔN LUÔN chỉ là warning SOFT (xem SOFT_REASONS) — không bao giờ tự nó gây
 * FAILED (mục 7: "Nếu không có semantic verifier, coverage chỉ nên là SOFT warning").
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
// FIX mục 6 (audit continuation): giữ các dấu hiệu CHẮC CHẮN cụt (từ nối tiếng Việt cụt cuối, dấu
// phẩy/hai chấm cụt cuối, "Bước X:" cụt, bullet vừa mở gần như trống) — nhưng KHÔNG còn coi 1 dòng
// cuối NGẮN bất kỳ là dấu hiệu cắt (dòng cuối ngắn có thể là 1 kết luận cố ý ngắn gọn, 1 dòng tiêu
// đề, 1 kết quả số/công thức độc lập — hoàn toàn hợp lệ, xem ensClosedProperly() bên dưới).
const TRUNCATION_TAIL_SIGNS = [
  /[,:;–—-]\s*$/, // kết thúc bằng dấu phẩy/hai chấm/gạch nối — câu chưa trọn
  /\b(và|hoặc|là|có|khi|nếu|vì|do|nên|để|với|của|từ|theo|bằng|thì)\s*$/i, // từ nối tiếng Việt cụt cuối
  /\bBước\s*\d+\s*[:.]?\s*$/i,
  /^\s*[-*+]\s*\S{0,3}$/ // dòng cuối là bullet vừa mới mở, gần như chưa có nội dung
];

/**
 * FIX mục 6: nới rộng danh sách kết thúc HỢP LỆ — 1 bài có thể kết thúc đúng bằng công thức (LaTeX
 * đã đóng $/$$/\)/\]), số, %, dấu đóng ngoặc/backtick, bullet CÓ NỘI DUNG (không phải vừa mở), tiêu
 * đề markdown (### ...), hàng cuối 1 bảng markdown (kết thúc bằng "|"), hoặc câu ngắn kết thúc bằng
 * chữ cái thường (không có dấu câu) MIỄN LÀ không khớp bất kỳ TRUNCATION_TAIL_SIGNS nào ở trên —
 * KHÔNG bắt buộc phải có "Vậy/Kết luận/Đáp số".
 */
function ensClosedProperly(text) {
  const trimmed = text.trimEnd();
  if (!trimmed) return false;
  const lastLine = (trimmed.split('\n').pop() || '').trim();
  const lastChar = trimmed[trimmed.length - 1];

  // Dấu câu kết, đóng ngoặc/backtick/trích dẫn.
  if (/[.?!)\]}"'”』…]/.test(lastChar)) return true;
  if (trimmed.endsWith('```')) return true;
  // Kết thúc bằng số/kết quả phép tính/%/= — coi là hợp lệ (đáp số dạng số thuần, không cần chữ).
  if (/[=0-9%]$/.test(lastChar)) return true;
  // Công thức LaTeX đã đóng đúng cú pháp ở cuối ($...$, $$...$$, \(...\), \[...\]).
  if (/\$\$?\s*$/.test(trimmed) || /\\[)\]]\s*$/.test(trimmed)) return true;
  // Hàng cuối 1 bảng markdown ("| a | b |") — kết thúc bằng "|".
  if (lastChar === '|') return true;
  // Bullet/heading CÓ NỘI DUNG thật (không phải vừa mở gần như trống — xem TRUNCATION_TAIL_SIGNS
  // pattern cuối) — vd "- Kết quả: 42" hoặc "### Kết luận" đều hợp lệ.
  if (/^(#{1,6}\s+\S|[-*+]\s+\S{4,}|\d+[).]\s+\S{4,})/.test(lastLine)) return true;
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
 * @param {{stage?:'approach'|'detail', problemText?:string, coverageList?:string[], contexts?:Array,
 *   finishReason?:'stop'|'length'|'other'|null, interrupted?:boolean}} [opts]
 *   interrupted (PHẦN B/C): true khi lượt gọi provider bị chết/mất kết nối SAU khi đã phát delta —
 *   luôn là HARD, không bao giờ bị finishReason ghi đè.
 *   contexts (mục 7/15): nếu có, đối chiếu MỌI citation [n] trong response với contexts.length —
 *   citation ngoài phạm vi -> reason 'invalid_citation' -> HARD INCOMPLETE (không được coi là
 *   COMPLETE chỉ vì response "đẹp"/kết thúc đúng câu — mục 15).
 *   finishReason (mục 1 — completion-first): tín hiệu THẬT từ provider (xem finishReason.js) — 'stop'
 *   nghĩa là model TỰ kết thúc; 'length' nghĩa là bị cắt vì hết max_tokens (HARD, luôn luôn); null
 *   nghĩa là không rõ (client cũ/không parse được) — hành vi y hệt trước khi có tín hiệu này.
 * @returns {{status:'COMPLETE'|'INCOMPLETE'|'INVALID', severity:'HARD'|'SOFT'|undefined, reasons:string[],
 *   hardReasons:string[], softReasons:string[], missingCoverage:string[], citationValidation:object|null,
 *   finishReason:string|null}}
 */
function validateSolutionCompleteness(text, opts = {}) {
  const { stage = 'detail', problemText = '', coverageList, contexts, finishReason: rawFinishReason } = opts;
  const clean = (text || '').trim();
  const reasons = [];
  const finishReason = rawFinishReason ? normalizeFinishReason(rawFinishReason) || rawFinishReason : (rawFinishReason || null);

  if (clean.length < MIN_MEANINGFUL_LENGTH) {
    return {
      status: 'INVALID', severity: 'HARD', reasons: ['response_empty_or_too_short'],
      hardReasons: ['response_empty_or_too_short'], softReasons: [], missingCoverage: [],
      citationValidation: null, finishReason
    };
  }

  // PHẦN B/C: interrupted được đánh giá TRƯỚC mọi heuristic và KHÔNG thể bị vô hiệu hoá bởi bất kỳ
  // dấu hiệu "trông đã đóng" nào — nguồn tín hiệu là tầng vận chuyển (stream chết), không phải nội dung.
  if (opts.interrupted) reasons.push('stream_interrupted');

  if (hasUnclosedCodeFence(clean)) reasons.push('unclosed_code_fence');
  if (hasUnclosedDrawBlock(clean)) reasons.push('unclosed_draw_block');
  if (hasUnclosedLatex(clean)) reasons.push('unclosed_latex');
  if (looksTruncated(clean)) reasons.push('truncated_tail');

  // mục 1/2 (completion-first): provider XÁC NHẬN bị cắt vì hết max_tokens — HARD, không phụ thuộc
  // heuristic hình thức có "trông" đã đóng hay không (vd model bị cắt ĐÚNG NGAY sau 1 dấu chấm câu
  // do trùng hợp — vẫn là truncation thật, không được bỏ qua chỉ vì lastChar nhìn hợp lệ).
  if (finishReason === 'length') reasons.push('finish_reason_length');

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

  // FIX mục 6/9: missing_conclusion giờ LUÔN LUÔN là SOFT (tự nó không bao giờ kèm heuristic khác để
  // "leo hạng" lên HARD nữa — trước đây logic cũ chỉ thêm reason này KHI đã có ≥1 reason khác, vô
  // tình khiến 1 response chỉ lệch DUY NHẤT ở "không có từ khoá kết luận" vẫn bị cộng dồn cùng 1 lỗi
  // HARD khác thành 2 reasons, dễ trông "nặng" hơn thực tế). Giữ lại như 1 tín hiệu THAM KHẢO độc
  // lập, phân loại SOFT_REASONS đảm nhiệm việc không để nó chặn completion.
  const hasConclusionMarker = /(vậy|kết luận|đáp số|đáp án|do đó,?\s*$)/i.test(clean.slice(-400));
  if (stage === 'detail' && !hasConclusionMarker) reasons.push('missing_conclusion');

  const { hard, soft } = classifyReasons(reasons);

  // mục 1 (completion-first): model CHỦ ĐỘNG kết thúc (finishReason==='stop') VÀ không có HARD reason
  // nào -> ép COMPLETE ngay dù còn bao nhiêu SOFT reason (thiếu coverage/kết luận theo đúng từ khoá
  // quen thuộc) — đây là điểm khác biệt cốt lõi so với logic cũ (mọi reason đều chặn completion).
  // mục 1 (completion-first) — CÓ 1 NGOẠI LỆ DUY NHẤT (PHẦN C): nếu stream bị NGẮT, tuyệt đối không
  // được "giả finishReason=stop". Điều kiện `hard.length === 0` bên dưới đã tự loại trường hợp này vì
  // 'stream_interrupted' luôn nằm trong HARD_REASONS — ghi rõ ở đây để không ai vô tình nới lỏng lại.
  if (finishReason === 'stop' && hard.length === 0) {
    return {
      status: 'COMPLETE', severity: undefined, reasons: soft, hardReasons: [], softReasons: soft,
      missingCoverage: missing, citationValidation, finishReason
    };
  }

  if (hard.length === 0 && soft.length === 0) {
    return {
      status: 'COMPLETE', severity: undefined, reasons: [], hardReasons: [], softReasons: [],
      missingCoverage: missing, citationValidation, finishReason
    };
  }

  // mục 2/9: CHỈ có SOFT reason (không có HARD nào) -> KHÔNG được tự động FAILED. status vẫn trả về
  // 'INCOMPLETE' (giữ tương thích ngược cho test/log cũ đang so `.status`), nhưng `severity:'SOFT'`
  // là tín hiệu để runtimeState.js (nơi QUYẾT ĐỊNH cuối cùng) coi đây LÀ THÀNH CÔNG kèm cảnh báo,
  // KHÔNG kích hoạt continuation/FAILED (xem chat.js + runtimeState.js).
  const severity = hard.length > 0 ? 'HARD' : 'SOFT';
  return {
    status: 'INCOMPLETE', severity, reasons: [...hard, ...soft], hardReasons: hard, softReasons: soft,
    missingCoverage: missing, citationValidation, finishReason
  };
}

module.exports = {
  extractCoverageList,
  checkCoverage,
  validateSolutionCompleteness,
  hasUnclosedCodeFence,
  hasUnclosedDrawBlock,
  hasUnclosedLatex,
  looksTruncated,
  classifyReasons,
  HARD_REASONS,
  SOFT_REASONS
};
