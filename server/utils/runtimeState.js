'use strict';

// ---------- RUNTIME STATE MACHINE cho 1 lượt trả lời hiển thị cho người dùng (mục 1/2) ----------
// TRƯỚC ĐÂY: chat.js gửi sự kiện "done" kèm completeness.status mà KHÔNG kiểm tra status đó có thực
// sự là COMPLETE hay không — cho phép đường đi INCOMPLETE -> done (client vẫn coi là thành công).
//
// FIX ROOT CAUSE (audit "completion-first"): completenessCheck.js giờ phân biệt severity 'HARD' (cấu
// trúc chắc chắn hỏng/cắt, hoặc provider xác nhận truncation) vs 'SOFT' (chỉ nghi ngờ hình thức —
// thiếu từ khoá kết luận quen thuộc/thiếu vài label a/b/c, nội dung RẤT CÓ THỂ đã đầy đủ). Trước đây
// MỌI completeness.status === 'INCOMPLETE' (bất kể lý do gì) đều bị coi là thất bại cuối cùng, khiến
// người dùng thấy "Câu trả lời chưa đầy đủ..." ngay cả khi model đã trả lời hợp lệ và chỉ lệch 1
// heuristic hình thức. Nay: status==='INCOMPLETE' + severity==='SOFT' vẫn được coi là THÀNH CÔNG
// (isFinalSuccess() trả true) — chỉ severity==='HARD' hoặc status==='INVALID' mới thực sự chặn.
//
// State hợp lệ:
//   IDLE -> GENERATING -> COMPLETED   (provider hoàn tất + final validation pass, kể cả SOFT warning)
//   GENERATING -> RECOVERING -> COMPLETED   (continuation thành công + validate lại pass)
//   GENERATING -> RECOVERING -> FAILED      (continuation thất bại / vẫn HARD_INCOMPLETE hết lượt)
//   GENERATING -> FAILED                    (INVALID, hoặc provider lỗi không phục hồi được)
//
// KHÔNG có đường: HARD INCOMPLETE -> done, INVALID -> done, provider_error -> done. SOFT INCOMPLETE
// -> done LÀ HỢP LỆ (mục 2/9 audit continuation — SOFT không được tự động làm request FAILED).
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
 * @param {string} [severity] 'HARD' | 'SOFT' | undefined — CHỈ có ý nghĩa khi completenessStatus
 *   === 'INCOMPLETE' (xem completenessCheck.js). Không truyền = coi như HARD (an toàn, giữ hành vi
 *   cũ cho bất kỳ nơi gọi nào chưa được cập nhật để truyền severity).
 * @returns {boolean} true khi COMPLETE, HOẶC khi INCOMPLETE nhưng severity CHỈ là SOFT.
 */
function isFinalSuccess(completenessStatus, severity) {
  if (completenessStatus === 'COMPLETE') return true;
  if (completenessStatus === 'INCOMPLETE' && severity === 'SOFT') return true;
  return false;
}

/**
 * Cổng bắt buộc trước khi coi 1 response là thành công cuối cùng (trước khi gửi "done"/trả 200 kèm
 * kết quả). Ném lỗi nếu chưa COMPLETE (hoặc SOFT_INCOMPLETE) — nơi gọi PHẢI bắt lỗi này và chuyển
 * sang FAILED/error, không được lặng lẽ bỏ qua.
 *
 * @param {{status:string, severity?:string, reasons?:string[], missingCoverage?:string[]}} completeness
 * @throws {Error} code = 'FINAL_RESPONSE_INCOMPLETE', kèm .completeness để nơi gọi build thông báo.
 */
function assertFinalResponseComplete(completeness) {
  if (!isFinalSuccess(completeness && completeness.status, completeness && completeness.severity)) {
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

// ============================================================================================
// PARTIAL — trạng thái THẬT THỨ BA (bổ sung ở bản fix PHẦN B/C)
// ============================================================================================
// VẤN ĐỀ CỦA MÔ HÌNH 2 TRẠNG THÁI CŨ: chỉ có COMPLETED hoặc FAILED. Khi mọi đường recovery đã dùng
// hết (deadline cạn / reserve cạn / provider tiếp nối cũng lỗi) mà câu trả lời vẫn còn HARD, chat.js
// phát sự kiện "error" — và client (public/js/app.js) coi "error" là NÉM LỖI, XOÁ toàn bộ preview,
// KHÔNG lưu gì vào lịch sử. Nghĩa là 90% một lời giải dài, đúng, đã hiển thị trên màn hình bị XOÁ
// SẠCH và thay bằng đúng 1 dòng "Câu trả lời chưa đầy đủ sau khi đã thử khôi phục…". Đó là hành vi
// tệ nhất có thể: vi phạm trực tiếp nguyên tắc "Không mất phần câu trả lời đã sinh".
//
// Mô hình 3 trạng thái giữ được CẢ HAI cam kết:
//   COMPLETED — đã COMPLETE thật (hoặc chỉ còn SOFT warning). KHÔNG BAO GIỜ gắn nhãn này cho 1
//               response còn HARD (không nói dối về completeness — cam kết cũ giữ nguyên 100%).
//   PARTIAL   — còn HARD nhưng ĐÃ CÓ nội dung dùng được và KHÔNG còn đường recovery nào. Vẫn giao
//               phần đã sinh cho người dùng, gắn nhãn rõ ràng là chưa đầy đủ + lý do.
//   FAILED    — không có gì dùng được (INVALID/rỗng/quá ngắn), hoặc lỗi provider ngay từ đầu.
//
// Ngưỡng "có nội dung dùng được": đủ dài để chắc chắn là lời giải thật chứ không phải 1 câu mở đầu
// bị cắt. Dưới ngưỡng này thì giao ra chỉ gây nhầm lẫn -> FAILED như cũ.
const MIN_DELIVERABLE_PARTIAL_CHARS = Number(process.env.MIN_DELIVERABLE_PARTIAL_CHARS) || 400;

/**
 * classifyFinalOutcome() — NƠI DUY NHẤT quyết định trạng thái cuối của 1 response hiển thị.
 * @param {{status:string, severity?:string}} completeness
 * @param {{textLength?:number}} [ctx]
 * @returns {{state:string, deliverable:boolean, partial:boolean}}
 */
function classifyFinalOutcome(completeness, ctx = {}) {
  const status = completeness && completeness.status;
  const severity = completeness && completeness.severity;
  if (isFinalSuccess(status, severity)) {
    return { state: STATES.COMPLETED, deliverable: true, partial: false };
  }
  const len = ctx.textLength || 0;
  // INVALID = rỗng/quá ngắn -> không có gì để giao, dù dài bao nhiêu ký tự cũng không đáng tin.
  if (status !== 'INVALID' && len >= MIN_DELIVERABLE_PARTIAL_CHARS) {
    return { state: STATES.PARTIAL, deliverable: true, partial: true };
  }
  return { state: STATES.FAILED, deliverable: false, partial: false };
}

module.exports = {
  STATES, isFinalSuccess, assertFinalResponseComplete, classifyFinalOutcome,
  MIN_DELIVERABLE_PARTIAL_CHARS
};
