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
function appendContinuationTurn(messages, priorText, completeness) {
  return [
    ...messages,
    { role: 'assistant', content: priorText },
    { role: 'user', content: buildContinuationPrompt({ priorText, ...completeness }) }
  ];
}

module.exports = { MAX_CONTINUATIONS, computeRecoveryBudget, buildContinuationPrompt, appendContinuationTurn };
