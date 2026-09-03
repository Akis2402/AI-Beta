'use strict';

// ---------- REQUEST DEADLINE DUY NHẤT (mục 4/5/6) ----------
// TRƯỚC ĐÂY: chat.js có globalDeadline riêng (createGlobalDeadline nội bộ), còn aiProviders.js lại
// tự tạo createDeadline() RIÊNG cho gatherCrossCheckCandidates/callWithFailover — 2+ đồng hồ độc lập
// chạy song song, mỗi bước co giãn timeout theo đồng hồ CỦA RIÊNG NÓ. Hậu quả: candidate có thể dùng
// hết ngân sách riêng của nó, reconcile lại có ngân sách riêng KHÔNG BIẾT candidate đã ăn bao nhiêu
// thời gian thật của request → tổng cộng dồn vượt quá thời gian tối đa nền tảng hosting cho phép.
//
// NAY: 1 request = 1 createRequestDeadline(totalMs) DUY NHẤT, tạo ra ở chat.js, rồi được truyền
// (không tạo lại) xuyên suốt: chat -> gatherCrossCheckCandidates -> candidate retries -> reconcile ->
// continuation -> final validation. Mọi module nhận `deadline` từ caller PHẢI dùng deadline đó, KHÔNG
// được tự gọi createDeadline()/createRequestDeadline() ở bên trong nếu đã có deadline truyền vào.

function createRequestDeadline(totalMs) {
  const start = Date.now();
  const budgetMs = Number.isFinite(Number(totalMs)) && Number(totalMs) > 0 ? Number(totalMs) : 55000;
  return {
    budgetMs,
    startedAt: start,
    /** Số ms còn lại (không bao giờ âm). */
    remaining: () => Math.max(0, budgetMs - (Date.now() - start)),
    /** true nếu đã hết ngân sách. */
    expired: () => Date.now() - start >= budgetMs,
    elapsed: () => Date.now() - start
  };
}

// ---------- Sàn thời gian tối thiểu để 1 lệnh gọi provider còn có ý nghĩa (mục 5) ----------
// KHÔNG được dùng Math.max(MIN_CALL_TIMEOUT_MS, remaining) rồi lấy kết quả đó làm timeout — nếu
// remaining < MIN thì Math.max sẽ trả về MIN (> remaining), tức là CHO PHÉP operation chạy LÂU HƠN
// deadline thật còn lại. Quy tắc đúng: nếu remaining < MIN_CALL_TIMEOUT_MS, KHÔNG gọi provider nữa
// (coi như hết ngân sách cho 1 lệnh gọi an toàn) — dùng safeCallTimeout() bên dưới, không tự bịa
// Math.max ở từng nơi gọi.
const MIN_CALL_TIMEOUT_MS = 4000;

/**
 * Tính timeout AN TOÀN cho 1 lệnh gọi cụ thể, không bao giờ vượt quá thời gian còn lại của deadline.
 * @param {number} preferredMs Timeout mong muốn cho lệnh gọi này nếu không bị deadline giới hạn.
 * @param {{remaining:Function}} deadline
 * @returns {number|null} Timeout (ms) nên dùng, hoặc null nếu không còn đủ ngân sách để gọi an toàn
 *   (caller PHẢI bỏ qua lệnh gọi này, chuyển sang recovery/failure — KHÔNG được tự ý nới timeout lên).
 */
function safeCallTimeout(preferredMs, deadline) {
  const remaining = deadline.remaining();
  if (remaining < MIN_CALL_TIMEOUT_MS) return null;
  return Math.max(MIN_CALL_TIMEOUT_MS, Math.min(preferredMs, remaining));
}

module.exports = { createRequestDeadline, safeCallTimeout, MIN_CALL_TIMEOUT_MS };
