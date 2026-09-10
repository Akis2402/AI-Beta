'use strict';

// ---------- CONTINUATION / RECOVERY (mục VI, refactor mục 3/10 audit continuation) ----------
// Khi validateSolutionCompleteness() trả về INCOMPLETE với severity HARD (provider không phải do
// heuristic hình thức mà THẬT SỰ cắt/hỏng cấu trúc — xem completenessCheck.js), KHÔNG được gọi lại
// toàn bộ lời giải từ đầu (tốn gấp đôi token + có nguy cơ mâu thuẫn với phần đã đúng). Thay vào đó,
// ghép 1 message "tiếp tục" vào cuối hội thoại, giữ nguyên phần đã hoàn thành làm ngữ cảnh, chỉ yêu
// cầu AI viết tiếp phần thiếu.
//
// FIX ROOT CAUSE (mục 3 audit continuation): TRƯỚC ĐÂY MAX_CONTINUATIONS=2 là hằng số CỐ ĐỊNH DUY
// NHẤT quyết định số lượt continuation — bài dài thật sự cần >2 lượt (vd 5-6 ý phức tạp, mỗi lượt bị
// cắt vì max_tokens của model) sẽ LUÔN bị FAILED ở lượt thứ 3 dù vẫn còn RẤT NHIỀU ngân sách thời
// gian (deadline) và ngân sách token (reserve) để tiếp tục. Nay: MAX_CONTINUATIONS chỉ còn là TRẦN AN
// TOÀN TUYỆT ĐỐI (safety cap chống vòng lặp vô hạn khi provider cứ lặp lại lỗi y hệt — xem test
// runtime.test.js mục 7), không phải "số lượt lý tưởng". computeRecoveryBudget() mới là nguồn quyết
// định THỰC TẾ số lượt continuation còn được phép ở MỖI thời điểm, dựa trên:
//   - deadline.remaining(): còn đủ thời gian cho ít nhất 1 lượt gọi provider nữa không (mục VII).
//   - reserve còn lại (token budget): còn đủ token để lượt tiếp theo không "chết yểu" ngay lập tức.
//   - safety cap: dù thời gian/token còn rất nhiều, KHÔNG BAO GIỜ vượt SAFETY_CAP_CONTINUATIONS —
//     chặn kịch bản provider cứ lặp lại y hệt 1 lỗi cấu trúc (test 7 mô phỏng đúng trường hợp này).

// FIX mục 3: nâng trần an toàn từ 2 lên 6 — đủ cho bài rất dài (5-6 ý phức tạp, mỗi ý cần 1 lượt
// continuation riêng) trong khi vẫn chặn được vòng lặp vô hạn thực sự (provider lặp lại lỗi y hệt sẽ
// dừng ở lượt thứ 6, không phải thứ 2). Tên `MAX_CONTINUATIONS` được GIỮ NGUYÊN (không đổi tên) để
// tương thích ngược với mọi nơi đang import hằng số này làm "trần tuyệt đối" (test/runtime.test.js
// mục 7, chat.js) — ý nghĩa ngữ nghĩa của nó chuyển từ "số lượt mặc định" sang "trần an toàn tối đa".
const MAX_CONTINUATIONS = Number(process.env.MAX_CONTINUATIONS_SAFETY_CAP) || 6;

// Ước lượng thô số token 1 lượt continuation "lành mạnh" cần tối thiểu để không tự cắt ngay lập tức
// — dùng để suy ra deadline còn đủ THỜI GIAN gọi thêm 1 lượt hay không (kết hợp với adaptiveBudget's
// THROUGHPUT_TOKENS_PER_SEC giả định ở nơi khác, ở đây chỉ cần 1 sàn AN TOÀN tối thiểu, không cần
// chính xác tuyệt đối — quyết định "có đáng gọi thêm 1 lượt hay không", không phải maxTokens thật).
const MIN_MS_PER_CONTINUATION = 8000;

/**
 * Tính số lượt continuation THỰC TẾ còn được phép tại 1 thời điểm — thay thế hoàn toàn việc so sánh
 * cứng `continuations < MAX_CONTINUATIONS` (mục 3). Trả về đúng 1 con số duy nhất `allowed` (không
 * phải danh sách) — nơi gọi (chat.js) dùng làm điều kiện dừng vòng lặp `while` continuation.
 *
 * @param {{remainingMs:number, reserveRemaining:number, continuationsSoFar:number}} opts
 *   remainingMs: globalDeadline.remaining() TẠI THỜI ĐIỂM gọi (mục VII — không có time budget thì
 *     không giới hạn theo thời gian, coi remainingMs=Infinity).
 *   reserveRemaining: token còn lại trong reserve CỦA REQUEST NÀY (mục 4 — allocateCoreReserve đã mở
 *     rộng thêm ở tokenEconomy.js khi thực sự cần, xem extendReserveIfTruncated()).
 *   continuationsSoFar: số lượt đã thực hiện — dùng để tính phần "còn lại" so với safety cap.
 * @returns {{allowed:boolean, reason:string}} allowed=false kèm reason giải thích tại sao dừng
 *   (hết safety cap / hết thời gian / hết reserve) — dùng cho log/telemetry, KHÔNG hiển thị cho
 *   người dùng (message hiển thị vẫn do chat.js tự quyết theo severity, xem mục 9).
 */
function computeRecoveryBudget({ remainingMs = Infinity, reserveRemaining = Infinity, continuationsSoFar = 0 } = {}) {
  if (continuationsSoFar >= MAX_CONTINUATIONS) {
    return { allowed: false, reason: 'safety_cap_reached' };
  }
  if (Number.isFinite(remainingMs) && remainingMs < MIN_MS_PER_CONTINUATION) {
    return { allowed: false, reason: 'deadline_exhausted' };
  }
  if (Number.isFinite(reserveRemaining) && reserveRemaining <= 0) {
    return { allowed: false, reason: 'reserve_exhausted' };
  }
  return { allowed: true, reason: 'ok' };
}

/**
 * @param {{priorText:string, reasons:string[], missingCoverage:string[]}} args
 * @returns {string} Nội dung message user bổ sung, nối tiếp vào cuối mảng `messages` gửi cho provider.
 */
function buildContinuationPrompt({ priorText, reasons = [], missingCoverage = [], drawingCanonicalErrors = [], citationValidation = null }) {
  const missingPart = missingCoverage.length
    ? `Các ý CHƯA được trả lời trong đề bài: ${missingCoverage.join(', ')}.`
    : '';

  const structuralHint = [];
  if (reasons.includes('unclosed_code_fence')) structuralHint.push('có khối mã (```) chưa được đóng lại');
  if (reasons.includes('unclosed_draw_block')) structuralHint.push('có khối hình vẽ (shape/solid3d/plot) chưa đóng lại');
  if (reasons.includes('unclosed_latex')) structuralHint.push('có công thức LaTeX chưa đóng lại (thiếu $$/\\]/\\) tương ứng)');
  if (reasons.includes('truncated_tail')) structuralHint.push('câu trả lời bị dừng đột ngột giữa câu/giữa ý');
  if (reasons.includes('missing_conclusion')) structuralHint.push('chưa có kết luận/đáp số cuối cùng');
  if (reasons.includes('drawing_canonical_mismatch')) structuralHint.push('hình vẽ không khớp với hình đã dựng ở Hướng giải (canonical drawing state)');
  if (reasons.includes('invalid_citation')) structuralHint.push('có trích dẫn [n] không hợp lệ (không tương ứng với bất kỳ nguồn nào đã cung cấp)');

  // mục 7/13/21.13: citation sai chỉ cần SỬA ĐÚNG số trích dẫn — KHÔNG regenerate toàn bộ câu trả
  // lời (delta continuation), và KHÔNG được tự bịa thêm citation mới ngoài phạm vi hợp lệ.
  const citationPart = (citationValidation && !citationValidation.valid)
    ? `TRÍCH DẪN SAI: [${citationValidation.invalidCitations.join('], [')}] không tương ứng nguồn nào đã cung cấp (chỉ có ${citationValidation.usedContextIds.length ? 'nguồn hợp lệ đã dùng: [' + citationValidation.usedContextIds.join('], [') + ']' : 'không có nguồn hợp lệ nào được cấp'}). CHỈ sửa lại đúng những số trích dẫn sai đó thành số nguồn đúng (hoặc bỏ trích dẫn nếu không chắc), KHÔNG viết lại toàn bộ câu trả lời, KHÔNG tự bịa thêm nguồn/tên tài liệu/URL nào không có trong danh sách nguồn đã cấp.`
    : '';

  // mục 15: khi phát hiện sai lệch canonical (model tự vẽ lại/đổi toạ độ thay vì copy nguyên văn),
  // nêu CHÍNH XÁC từng lỗi để model sửa đúng chỗ, không phải đoán lại từ đầu.
  const canonicalPart = drawingCanonicalErrors.length
    ? 'LỖI HÌNH VẼ SO VỚI HƯỚNG GIẢI (canonical drawing state) — PHẢI SỬA LẠI ĐÚNG NHƯ SAU:\n' +
      drawingCanonicalErrors.map((e) => '- ' + e).join('\n') +
      '\nHãy in lại NGUYÊN VĂN khối vẽ, khôi phục đúng mọi điểm/phần tử đã có ở Hướng giải (giữ nguyên id/toạ độ/op), chỉ được bổ sung thêm phần tử MỚI nếu thực sự cần — KHÔNG được tự nghĩ ra toạ độ khác.'
    : '';

  return [
    'Câu trả lời phía trên của bạn CHƯA HOÀN CHỈNH' + (structuralHint.length ? ` (${structuralHint.join('; ')})` : '') + '.',
    'Phần bạn đã viết được giữ nguyên, KHÔNG được lặp lại nội dung đã hoàn thành, KHÔNG được viết lại từ đầu.',
    missingPart,
    citationPart,
    canonicalPart,
    'Hãy viết TIẾP NGAY từ chỗ bị dừng (tiếp tục đúng câu/ý đang dở, hoặc bắt đầu ý còn thiếu tiếp theo), giữ nguyên cách đặt tên điểm/ẩn số/ký hiệu và các kết quả trung gian đã có ở phần trên, không tạo ra lời giải mâu thuẫn với phần đã viết. Nếu có khối hình vẽ (shape/solid3d/plot) đang dở, hãy đóng lại đúng cú pháp JSON đã dùng, KHÔNG đổi tên điểm/toạ độ đã có.',
    'Nếu phần trước đã đủ nội dung và chỉ thiếu kết luận/đáp số, chỉ cần viết thêm phần kết luận/đáp số, không viết lại lời giải.'
  ].filter(Boolean).join('\n');
}

/**
 * Nối message continuation vào cuối mảng messages hiện có, đúng role assistant (phần đã sinh ra) +
 * user (yêu cầu tiếp tục) — để provider hiểu đây là hội thoại tiếp diễn chứ không phải câu hỏi mới.
 *
 * @param {Array} messages Mảng messages gốc đã gửi cho lượt gọi bị INCOMPLETE.
 * @param {string} priorText Toàn bộ text đã nhận được (kể cả phần cụt).
 * @param {{reasons:string[], missingCoverage:string[]}} completeness
 * @returns {Array} Mảng messages mới, sẵn sàng cho lượt gọi continuation.
 */
/**
 * @deprecated (từ bản fix PHẦN B/G) — GỬI LẠI NGUYÊN VĂN toàn bộ `priorText`, tức chính nguồn lãng
 * phí input token lớn nhất của pipeline cũ (đo được: 4527 -> 2434 token khi thay bằng bản tối thiểu).
 * KHÔNG dùng cho code mới. Đường chạy thật đã chuyển hết sang buildMinimalContinuationContext().
 * Giữ lại CHỈ để: (1) tương thích ngược với test hiện có, (2) làm baseline "before" cho
 * scripts/measure-tokens.js so sánh trung thực.
 */
function appendContinuationTurn(messages, priorText, completeness) {
  return [
    ...messages,
    { role: 'assistant', content: priorText },
    { role: 'user', content: buildContinuationPrompt({ priorText, ...completeness }) }
  ];
}

// ============================================================================================
// PHẦN G — COMPACT CONTINUATION CONTEXT
// ============================================================================================
// NGUYÊN NHÂN GỐC (bản trước): appendContinuationTurn() nối NGUYÊN VĂN toàn bộ `priorText` vào
// messages ở MỌI lượt continuation. Với 1 bài dài cần 3 lượt, phần text đã sinh (đang lớn dần) bị
// gửi lại 3 lần — input token của các lượt sau tăng gần như tuyến tính theo độ dài câu trả lời, đúng
// loại "token lãng phí" mà PHẦN D nhắm tới. Tệ hơn: đó cũng là lý do các lượt continuation dễ chạm
// giới hạn context/độ trễ và bị cắt tiếp.
//
// buildMinimalContinuationContext() gửi ĐỦ mà không gửi THỪA:
//   LUÔN GIỮ  : đề bài gốc + yêu cầu (nằm trong `messages` — không đụng tới), sườn đánh số/heading,
//               MỌI dòng chứa dữ liệu (số/công thức/biến/đơn vị/citation), MỌI khối vẽ (canonical
//               drawing state) nguyên vẹn, và TAIL nguyên văn quanh điểm cắt.
//   CHỈ GỬI KHI CẦN: kết quả trung gian (đi kèm dòng dữ liệu), citation state.
//   KHÔNG GỬI LẠI  : prose diễn giải đã hoàn thành, metadata trùng lặp.
// Không bao giờ cắt GIỮA: LaTeX, code fence, JSON, bảng, drawing state (xem findSafeCutIndex()).

// Số ký tự nguyên văn quanh điểm cắt luôn được gửi lại — model cần đọc chính xác chỗ đang dở để
// viết tiếp liền mạch (không phải "đoán" nó đã viết gì).
const CONTINUATION_TAIL_CHARS = Number(process.env.CONTINUATION_TAIL_CHARS) || 1200;
// Dưới ngưỡng này thì nén không đáng: gửi nguyên văn còn rẻ hơn cả phần marker chèn thêm.
const CONTINUATION_COMPACT_MIN_CHARS = 1600;

const DATA_LINE_RE = [
  /\d/, /[=<>≤≥≠±∈∩∪→⇒⇔]/, /\$/, /\\\(|\\\[|\\frac|\\sqrt|\\int|\\sum/, /```/, /\[\d+\]/,
  /^\s*(#{1,6}\s|[-*+]\s|\d+[).]\s|[a-jA-J][).]\s|\*\*)/,
  // "bước" bị CỐ Ý loại khỏi danh sách này: nó xuất hiện rất thường xuyên trong prose bình thường
  // ("ta thực hiện các bước sau…") nên giữ nó lại làm mọi dòng diễn giải bị coi là dòng dữ liệu và
  // compaction không có hiệu lực. Tiêu đề "Bước 5" luôn chứa CHỮ SỐ nên đã được /\d/ ở trên giữ lại.
  // ĐO THẬT (scripts/measure-tokens.js) phát hiện: dùng /\b(vậy|...)\b/ khớp NHẦM prose tiếng Việt
  // thông thường — "như vậy", "vì vậy", "vậy nên" xuất hiện dày đặc trong văn diễn giải, khiến GẦN
  // NHƯ MỌI dòng prose bị coi là dòng dữ liệu và compaction không tiết kiệm được gì (đo được 0%).
  // Các từ này chỉ mang nghĩa "dòng kết luận/đáp số" khi đứng ĐẦU DÒNG; còn "Vậy S = 6" thì đã có
  // chữ số + dấu "=" nên luôn được giữ bởi các mẫu phía trên rồi.
  /^\s*(vậy|kết luận|đáp số|đáp án|điều kiện|giả thiết|yêu cầu)\b/i,
  /(điều kiện|giả thiết|ràng buộc)\s*:/i
];
function isStructuralOrDataLine(line) {
  return DATA_LINE_RE.some((re) => re.test(line));
}

/**
 * findSafeCutIndex(): tìm vị trí bắt đầu TAIL sao cho KHÔNG rơi vào giữa 1 khối ```...```, giữa 1
 * công thức LaTeX khối ($$...$$ / \[...\]), hay giữa 1 hàng bảng markdown. Luôn lùi về ĐẦU DÒNG.
 * @param {string} text
 * @param {number} desiredTailChars
 * @returns {number} index an toàn để slice tail.
 */
function findSafeCutIndex(text, desiredTailChars) {
  if (text.length <= desiredTailChars) return 0;
  let idx = text.length - desiredTailChars;
  // Lùi về đầu dòng gần nhất.
  const nl = text.lastIndexOf('\n', idx);
  if (nl >= 0) {
    idx = nl + 1;
  } else {
    // KHÔNG có dòng mới nào phía trước (model trả về 1 khối văn bản dài liền mạch — hiếm nhưng có
    // thật). Trước đây trường hợp này rơi về idx=0, tức KHÔNG nén được gì cả và toàn bộ answer cũ
    // vẫn bị gửi lại. Lùi về ranh giới CÂU gần nhất thay vì đầu văn bản; nếu vẫn không có, lùi về
    // khoảng trắng gần nhất để không bao giờ cắt giữa 1 từ/1 con số.
    const sentence = Math.max(
      text.lastIndexOf('. ', idx), text.lastIndexOf('? ', idx), text.lastIndexOf('! ', idx)
    );
    if (sentence > 0) idx = sentence + 2;
    else {
      const space = text.lastIndexOf(' ', idx);
      idx = space > 0 ? space + 1 : 0;
    }
  }

  // Nếu phần TRƯỚC idx có số dấu ``` LẺ, nghĩa là idx đang nằm BÊN TRONG 1 khối code/vẽ -> lùi tiếp
  // về đúng dòng mở khối đó, để tail chứa cả khối (drawing canonical state không bao giờ bị xẻ đôi).
  const before = text.slice(0, idx);
  const fenceCount = (before.match(/```/g) || []).length;
  if (fenceCount % 2 !== 0) {
    const openIdx = before.lastIndexOf('```');
    const lineStart = text.lastIndexOf('\n', openIdx);
    return lineStart >= 0 ? lineStart + 1 : 0;
  }
  // Tương tự với $$ (LaTeX khối) — số $$ lẻ ở phần trước = đang ở giữa 1 công thức khối.
  const dollarCount = (before.match(/\$\$/g) || []).length;
  if (dollarCount % 2 !== 0) {
    const openIdx = before.lastIndexOf('$$');
    const lineStart = text.lastIndexOf('\n', openIdx);
    return lineStart >= 0 ? lineStart + 1 : 0;
  }
  return idx;
}

/**
 * compactPriorText(): tạo bản GỌN của phần đã sinh để làm ngữ cảnh cho lượt tiếp theo.
 * @param {string} priorText
 * @param {{tailChars?:number}} [opts]
 * @returns {{text:string, rawChars:number, compactChars:number, compacted:boolean}}
 */
function compactPriorText(priorText, opts = {}) {
  const raw = String(priorText || '');
  const tailChars = opts.tailChars || CONTINUATION_TAIL_CHARS;
  if (raw.length <= Math.max(CONTINUATION_COMPACT_MIN_CHARS, tailChars)) {
    return { text: raw, rawChars: raw.length, compactChars: raw.length, compacted: false };
  }

  const cut = findSafeCutIndex(raw, tailChars);
  const head = raw.slice(0, cut);
  const tail = raw.slice(cut); // NGUYÊN VĂN, không bao giờ bị nén — đây là mốc để viết tiếp

  // Từ phần HEAD: giữ sườn + mọi dòng dữ liệu; bỏ prose đã hoàn thành. Khối ```...``` giữ nguyên vẹn.
  const lines = head.split('\n');
  const kept = [];
  let insideFence = false;
  let droppedRun = 0;
  for (const line of lines) {
    if (/^\s*```/.test(line)) { insideFence = !insideFence; kept.push(line); droppedRun = 0; continue; }
    if (insideFence) { kept.push(line); continue; }
    const t = line.trim();
    if (!t) continue;
    if (isStructuralOrDataLine(line) || t.length < 60) {
      droppedRun = 0;
      kept.push(line);
      continue;
    }
    droppedRun += 1;
    if (droppedRun === 1) kept.push('[…đoạn diễn giải đã viết xong, không cần lặp lại…]');
  }

  const text = `${kept.join('\n')}\n${tail}`;
  return { text, rawChars: raw.length, compactChars: text.length, compacted: true };
}

/**
 * PHẦN H — SMART RESUME PROMPT.
 * Khác buildContinuationPrompt() (dành cho lỗi CẤU TRÚC) ở chỗ: nói rõ đây là phần TIẾP NỐI của 1
 * câu trả lời bị NGẮT giữa dòng do sự cố kỹ thuật ở phía nhà cung cấp trước — model mới không hề
 * "biết" nó đã viết gì, nên phải được chỉ dẫn tuyệt đối rõ ràng là KHÔNG viết lại từ đầu.
 *
 * @param {{priorTail:string, reasons?:string[], missingCoverage?:string[], interrupted?:boolean,
 *   coverageList?:string[], citationValidation?:object, drawingCanonicalErrors?:string[]}} args
 * @returns {string}
 */
function buildResumePrompt({
  priorTail = '', reasons = [], missingCoverage = [], interrupted = false,
  citationValidation = null, drawingCanonicalErrors = []
} = {}) {
  const lastChars = String(priorTail).slice(-160).replace(/\s+/g, ' ').trim();

  // ĐO THẬT rồi mới chốt độ dài (scripts/measure-tokens.js): bản nháp đầu tiên của prompt này dài
  // ~200 token, khiến 1 lượt continuation của câu trả lời NGẮN tốn NHIỀU input token hơn cả bản cũ
  // (-25%, tức tăng 25%) — phần tiết kiệm từ nén priorText không bù được chi phí prompt cố định.
  // Bản dưới đây giữ ĐỦ 6 chỉ thị bắt buộc của PHẦN H nhưng viết cô đặc, mỗi chỉ thị 1 dòng ngắn.
  const lines = [
    interrupted
      ? 'Phần trả lời trên BỊ NGẮT giữa chừng do lỗi kết nối, KHÔNG phải đã xong. Bạn đang VIẾT TIẾP chính câu trả lời đó.'
      : 'Câu trả lời trên CHƯA HOÀN CHỈNH. Bạn đang VIẾT TIẾP chính câu trả lời đó.',
    lastChars ? `Ký tự cuối đã hiển thị: "…${lastChars}"` : '',
    'KHÔNG viết lại từ đầu. KHÔNG lặp lại nội dung đã có (kể cả tiêu đề/lời dẫn).',
    'Viết tiếp ĐÚNG từ chỗ đang thiếu; nếu đang dở giữa câu/bước thì hoàn tất chính câu/bước đó trước, không thêm lời dẫn.',
    'GIỮ NGUYÊN ký hiệu/ẩn số/tên điểm, mọi kết quả trung gian và số liệu đã có; không tính lại theo cách khác.',
    'GIỮ NGUYÊN cách đánh số đang dùng và tiếp tục đúng số kế tiếp.',
    'Đóng đúng cú pháp mọi khối LaTeX/code/hình vẽ còn mở, không đổi toạ độ/tên điểm đã có.',
    'Chỉ kết thúc khi đã trình bày đủ mọi yêu cầu của đề. Không thêm nội dung ngoài yêu cầu, không ghi chú về việc bị ngắt.'
  ];

  if (missingCoverage.length) {
    lines.push(`7. Các ý CÒN THIẾU cần trình bày (chỉ những ý này): ${missingCoverage.join(', ')}.`);
  }
  if (reasons.includes('unclosed_code_fence')) lines.push('- Lưu ý: có khối mã (```) chưa đóng — đóng lại.');
  if (reasons.includes('unclosed_draw_block')) lines.push('- Lưu ý: có khối hình vẽ chưa đóng — đóng lại đúng JSON đã dùng.');
  if (reasons.includes('unclosed_latex')) lines.push('- Lưu ý: có công thức LaTeX chưa đóng — đóng lại đúng cặp $$/\\]/\\).');
  if (reasons.includes('missing_conclusion')) lines.push('- Lưu ý: chưa có kết luận/đáp số cuối cùng — bổ sung.');
  if (citationValidation && !citationValidation.valid) {
    lines.push(`- Lưu ý: trích dẫn [${citationValidation.invalidCitations.join('], [')}] không hợp lệ — sửa đúng số nguồn hoặc bỏ, KHÔNG bịa nguồn mới.`);
  }
  if (drawingCanonicalErrors.length) {
    lines.push('- Lưu ý hình vẽ phải khớp canonical state: ' + drawingCanonicalErrors.join('; '));
  }

  return lines.filter(Boolean).join('\n');
}

/**
 * buildMinimalContinuationContext() — điểm vào chính của PHẦN G.
 * @param {{messages:Array, priorText:string, completeness:object, interrupted?:boolean,
 *   tailChars?:number, compact?:boolean}} args `compact=false` để tắt nén (giữ hành vi cũ khi cần).
 * @returns {{messages:Array, priorTokensBefore:number, priorTokensAfter:number, ratio:number,
 *   compacted:boolean}}
 */
function buildMinimalContinuationContext({
  messages, priorText, completeness = {}, interrupted = false, tailChars, compact = true
}) {
  const raw = String(priorText || '');
  const packed = compact
    ? compactPriorText(raw, { tailChars })
    : { text: raw, rawChars: raw.length, compactChars: raw.length, compacted: false };

  const prompt = buildResumePrompt({
    priorTail: raw.slice(-400),
    reasons: completeness.reasons || [],
    missingCoverage: completeness.missingCoverage || [],
    interrupted,
    citationValidation: completeness.citationValidation || null,
    drawingCanonicalErrors: completeness.drawingCanonicalErrors || []
  });

  const before = Math.ceil(raw.length / 3.2);
  const after = Math.ceil(packed.text.length / 3.2);
  return {
    messages: [
      ...messages,
      { role: 'assistant', content: packed.text },
      { role: 'user', content: prompt }
    ],
    priorTokensBefore: before,
    priorTokensAfter: after,
    ratio: before > 0 ? 1 - after / before : 0,
    compacted: packed.compacted
  };
}

// ============================================================================================
// CHỐNG LẶP TEXT Ở ĐIỂM NỐI (PHẦN B: "Không duplicate text")
// ============================================================================================
// Dù prompt đã yêu cầu rõ, model tiếp nối vẫn thường lặp lại vài từ/1 câu cuối của phần trước
// ("…nửa tích hai cạnh" -> lượt sau mở đầu bằng "hai cạnh góc vuông, do đó…"). Với streaming, phần
// lặp đó ĐÃ BAY tới người dùng trước khi ta kịp biết -> câu trả lời có đoạn trùng ngay giữa màn hình.
// createSeamDedupe() giữ lại 1 lượng nhỏ ký tự đầu của lượt tiếp nối (invisible delay ~vài chục ms),
// đối chiếu với đuôi phần đã có, cắt đúng phần chồng lặp rồi mới phát ra.

const SEAM_BUFFER_CHARS = 240;

/**
 * @param {string} priorText Toàn bộ text đã sinh trước lượt tiếp nối.
 * @param {Function} emit Hàm phát ra text đã được làm sạch (thường là sseWrite delta).
 * @returns {{feed:Function, flush:Function, removedChars:number}}
 */
function createSeamDedupe(priorText, emit) {
  const tail = String(priorText || '').slice(-600);
  let buffer = '';
  let done = false;
  const state = { removedChars: 0 };

  function resolve() {
    let text = buffer;
    if (tail && text) {
      // Tìm k LỚN NHẤT sao cho đuôi của `tail` trùng khớp với k ký tự đầu của `text`.
      const max = Math.min(tail.length, text.length);
      let overlap = 0;
      for (let k = max; k >= 8; k--) {
        if (tail.endsWith(text.slice(0, k))) { overlap = k; break; }
      }
      if (overlap) { text = text.slice(overlap); state.removedChars += overlap; }
      else {
        // Không chồng ở mức ký tự: thử mức DÒNG — model lặp lại nguyên 1 dòng đã có.
        const firstLine = text.split('\n')[0].trim();
        if (firstLine.length >= 16 && tail.includes(firstLine)) {
          const cutAt = text.indexOf('\n');
          const removed = cutAt >= 0 ? cutAt + 1 : text.length;
          state.removedChars += removed;
          text = cutAt >= 0 ? text.slice(cutAt + 1) : '';
        }
      }
    }
    done = true;
    buffer = '';
    if (text) emit(text);
  }

  return {
    feed(piece) {
      if (done) { if (piece) emit(piece); return; }
      buffer += piece || '';
      if (buffer.length >= SEAM_BUFFER_CHARS) resolve();
    },
    flush() { if (!done) resolve(); },
    get removedChars() { return state.removedChars; }
  };
}

/**
 * joinContinuation(): nối 2 đoạn mà KHÔNG chèn '\n' bừa. Bản trước luôn dùng `text + '\n' + next`,
 * làm đứt đôi từ/công thức khi điểm cắt nằm giữa từ ("nửa tích hai cạ" + "\n" + "nh góc vuông").
 */
function joinContinuation(prior, next) {
  const a = String(prior || '');
  const b = String(next || '');
  if (!a) return b;
  if (!b) return a;
  if (/\s$/.test(a) || /^\s/.test(b)) return a + b;
  // Cắt giữa từ/số/công thức -> nối liền, không thêm ký tự nào.
  if (/[\p{L}\p{N}\\$]$/u.test(a) && /^[\p{L}\p{N}\\$]/u.test(b)) return a + b;
  return `${a}\n${b}`;
}

module.exports = {
  MAX_CONTINUATIONS, computeRecoveryBudget, buildContinuationPrompt, appendContinuationTurn,
  buildMinimalContinuationContext, buildResumePrompt, compactPriorText, findSafeCutIndex,
  createSeamDedupe, joinContinuation, isStructuralOrDataLine,
  CONTINUATION_TAIL_CHARS
};
