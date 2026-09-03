'use strict';

// ---------- CONTINUATION / RECOVERY (mục VI) ----------
// Khi validateSolutionCompleteness() trả về INCOMPLETE (và lỗi không phải do provider — provider
// vẫn trả lời được, chỉ là trả lời chưa xong), KHÔNG được gọi lại toàn bộ lời giải từ đầu (tốn gấp
// đôi token + có nguy cơ mâu thuẫn với phần đã đúng). Thay vào đó, ghép 1 message "tiếp tục" vào
// cuối hội thoại, giữ nguyên phần đã hoàn thành làm ngữ cảnh, chỉ yêu cầu AI viết tiếp phần thiếu.

const MAX_CONTINUATIONS = 2; // giới hạn số lần recovery cho 1 lượt giải — chặn vòng lặp vô hạn nếu AI cứ lặp lại lỗi

/**
 * @param {{priorText:string, reasons:string[], missingCoverage:string[]}} args
 * @returns {string} Nội dung message user bổ sung, nối tiếp vào cuối mảng `messages` gửi cho provider.
 */
function buildContinuationPrompt({ priorText, reasons = [], missingCoverage = [], drawingCanonicalErrors = [] }) {
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

module.exports = { MAX_CONTINUATIONS, buildContinuationPrompt, appendContinuationTurn };
