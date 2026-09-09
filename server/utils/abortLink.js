'use strict';

// ---------- Dùng chung cho mọi provider client (Anthropic/OpenAI/Gemini/OpenAI-compatible) ----------
// Mỗi client tự tạo 1 AbortController để áp timeout nội bộ (huỷ fetch nếu provider phản hồi quá
// chậm). Hàm này "nối" thêm 1 AbortSignal BÊN NGOÀI (tuỳ chọn) — do chat.js tạo ra khi người dùng
// bấm nút "Dừng" hoặc khi client đóng kết nối SSE giữa chừng (mục 4 trong yêu cầu refactor) — vào
// CÙNG 1 controller: bên nào abort trước (timeout nội bộ hay huỷ từ bên ngoài), request tới provider
// dừng ngay lập tức. `isCancelledByCaller()` cho client biết ĐÚNG nguyên nhân abort là do bên ngoài
// huỷ (không phải do timeout) để trả về lỗi có `err.cancelled = true` thay vì lỗi timeout thông
// thường — nhờ vậy aiProviders.js phân biệt được "người dùng huỷ" (dừng pipeline ngay, không
// failover/retry) với "provider quá chậm" (vẫn failover sang target khác như bình thường).
function createLinkedAbort(timeoutMs, externalSignal) {
  const controller = new AbortController();
  let timedOut = false;
  let cancelledByCaller = false;

  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);

  function onExternalAbort() {
    cancelledByCaller = true;
    controller.abort();
  }
  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  return {
    signal: controller.signal,
    isTimeout: () => timedOut,
    isCancelledByCaller: () => cancelledByCaller,
    cleanup() {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    }
  };
}

/** Tạo 1 Error chuẩn hoá cho trường hợp bị huỷ bởi caller (không phải timeout/lỗi provider). */
function makeCancelledError() {
  const err = new Error('Yêu cầu đã bị hủy.');
  err.status = 499; // quy ước phổ biến (Nginx) cho "client closed request", không phải mã HTTP chính thức
  err.code = 'CANCELLED';
  err.cancelled = true;
  return err;
}

module.exports = { createLinkedAbort, makeCancelledError };
