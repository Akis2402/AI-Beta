'use strict';

// ---------- RUNTIME STATE MACHINE cho 1 lượt trả lời hiển thị cho người dùng (mục 1/2) ----------
// TRƯỚC ĐÂY: chat.js gửi sự kiện "done" kèm completeness.status mà KHÔNG kiểm tra status đó có thực
// sự là COMPLETE hay không — cho phép đường đi INCOMPLETE -> done (client vẫn coi là thành công).
//
// State hợp lệ:
//   IDLE -> GENERATING -> COMPLETED   (provider hoàn tất + final validation pass)
//   GENERATING -> RECOVERING -> COMPLETED   (continuation thành công + validate lại pass)
//   GENERATING -> RECOVERING -> FAILED      (continuation thất bại / vẫn INCOMPLETE hết lượt)
//   GENERATING -> FAILED                    (INVALID, hoặc provider lỗi không phục hồi được)
//
// KHÔNG có đường: RECOVERING -> done, INCOMPLETE -> done, INVALID -> done, provider_error -> done.
// isFinalSuccess()/assertFinalResponseComplete() là NƠI DUY NHẤT quyết định 1 response có được phép
// gắn nhãn "done"/COMPLETED hay không — chat.js không được tự suy luận lại điều kiện này ở nơi khác.

const STATES = Object.freeze({
  IDLE: 'IDLE',
  GENERATING: 'GENERATING',
  RECOVERING: 'RECOVERING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED'
});

/**
 * @param {string} completenessStatus 'COMPLETE' | 'INCOMPLETE' | 'INVALID'
 * @returns {boolean} true CHỈ KHI completenessStatus === 'COMPLETE'.
 */
function isFinalSuccess(completenessStatus) {
  return completenessStatus === 'COMPLETE';
}

/**
 * Cổng bắt buộc trước khi coi 1 response là thành công cuối cùng (trước khi gửi "done"/trả 200 kèm
 * kết quả). Ném lỗi nếu chưa COMPLETE — nơi gọi PHẢI bắt lỗi này và chuyển sang FAILED/error, không
 * được lặng lẽ bỏ qua.
 *
 * @param {{status:string, reasons?:string[], missingCoverage?:string[]}} completeness
 * @throws {Error} code = 'FINAL_RESPONSE_INCOMPLETE', kèm .completeness để nơi gọi build thông báo.
 */
function assertFinalResponseComplete(completeness) {
  if (!isFinalSuccess(completeness && completeness.status)) {
    const status = (completeness && completeness.status) || 'UNKNOWN';
    const err = new Error(
      status === 'INVALID'
        ? 'Câu trả lời của AI không hợp lệ (rỗng hoặc quá ngắn) — không thể coi là hoàn thành.'
        : 'Câu trả lời chưa đầy đủ sau khi đã thử khôi phục — không thể coi là hoàn thành.'
    );
    err.code = 'FINAL_RESPONSE_INCOMPLETE';
    err.completeness = completeness;
    err.status = 502;
    throw err;
  }
  return true;
}

module.exports = { STATES, isFinalSuccess, assertFinalResponseComplete };
