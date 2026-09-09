'use strict';

// ---------- mục 6: chuẩn hóa error object ----------
// Mapping status HTTP -> code ổn định, không phụ thuộc câu chữ message (message có thể đổi theo
// ngôn ngữ/nhà cung cấp, code thì không) — client có thể switch theo `code` mà không cần match
// chuỗi tiếng Việt dễ vỡ khi đổi wording.
const HTTP_STATUS_CODE_MAP = {
  400: 'INVALID_INPUT',
  401: 'AUTH_CONFIG',
  403: 'AUTH_CONFIG',
  404: 'MODEL_NOT_FOUND',
  408: 'TIMEOUT',
  429: 'RATE_LIMIT',
  499: 'CANCELLED', // quy ước Nginx cho "client closed request" — dùng cho abortLink.js (mục 4)
  500: 'SERVER_ERROR',
  502: 'PROVIDER_ERROR',
  503: 'PROVIDER_UNAVAILABLE',
  504: 'TIMEOUT'
};

// P0 mục 2 (defense-in-depth): thông báo chung an toàn theo CODE — dùng làm phương án cuối khi 1 nơi
// throw Error nào đó (kể cả code mới thêm sau này) LỠ QUÊN gán err.userMessage. KHÔNG bao giờ để
// err.message thô (có thể chứa chi tiết provider/billing/nội bộ) lọt ra response production chỉ vì
// thiếu userMessage — xem generic fallback trong normalizeError() bên dưới.
const GENERIC_MESSAGE_BY_CODE = {
  INVALID_INPUT: 'Yêu cầu không hợp lệ.',
  AUTH_CONFIG: 'Cấu hình xác thực không hợp lệ.',
  MODEL_NOT_FOUND: 'Không tìm thấy model phù hợp.',
  TIMEOUT: 'Yêu cầu vượt quá thời gian chờ.',
  RATE_LIMIT: 'Bạn đã gửi quá nhiều yêu cầu. Vui lòng thử lại sau ít phút.',
  CANCELLED: 'Yêu cầu đã bị hủy.',
  SERVER_ERROR: 'Đã có lỗi xảy ra ở máy chủ.',
  PROVIDER_ERROR: 'Nhà cung cấp AI gặp lỗi khi trả lời. Vui lòng thử lại.',
  PROVIDER_UNAVAILABLE: 'Nhà cung cấp AI tạm thời không khả dụng.',
  UNKNOWN_ERROR: 'Đã có lỗi xảy ra.'
};

/**
 * Chuẩn hóa MỌI lỗi lọt tới errorHandler.js (validate input, provider client, timeout, hủy
 * request...) thành 1 hình dạng cố định — mục 6:
 *   { code, status, userMessage, debugMessage, provider, model, retryable }
 * Chỉ dùng để LOG + xây response an toàn ở errorHandler.js — KHÔNG bắt buộc nơi throw Error phải
 * đổi cách viết; err.code/err.provider/err.model/err.userMessage/err.debugMessage là các field TÙY
 * CHỌN mà nơi throw có thể đính kèm thêm, thiếu thì suy luận hợp lý từ `status` HTTP sẵn có.
 * @param {Error & {status?:number, code?:string, provider?:string, model?:string, cancelled?:boolean,
 *   userMessage?:string, debugMessage?:string, detail?:string}} err
 */
function normalizeError(err) {
  const status = (err && err.status) || 500;
  const code = (err && err.code) || HTTP_STATUS_CODE_MAP[status] || (status >= 500 ? 'SERVER_ERROR' : 'UNKNOWN_ERROR');
  // retryable: đúng tinh thần rotationManager.js — lỗi tạm thời (timeout/rate-limit/lỗi provider
  // 5xx) đáng để người dùng/client thử lại ngay; lỗi cấu hình/input sai/hủy chủ động thì không.
  const retryable = !(err && err.cancelled) && [408, 429, 500, 502, 503, 504].includes(status);
  // P0 mục 2: chỉ tin err.message thô làm userMessage khi KHÔNG phải production, hoặc khi status là
  // lỗi input do chính hệ thống validate/tạo ra (4xx KHÔNG PHẢI 401/403/429 — các lỗi validators.js/
  // route handler tự throw, không chứa dữ liệu provider). Với 5xx/401/403/429 (nơi message CÓ THỂ bị
  // 1 client provider nào đó lỡ nhét chi tiết billing/nội bộ vào), production LUÔN dùng thông báo
  // chung theo `code` trừ khi nơi throw đã tường minh gán err.userMessage.
  const isSystemValidationError = status >= 400 && status < 500 && ![401, 403, 429].includes(status);
  const safeFallbackMessage = (process.env.NODE_ENV === 'production' && !isSystemValidationError)
    ? (GENERIC_MESSAGE_BY_CODE[code] || GENERIC_MESSAGE_BY_CODE.UNKNOWN_ERROR)
    : ((err && err.message) || 'Đã có lỗi xảy ra ở máy chủ.');
  return {
    code,
    status,
    userMessage: (err && err.userMessage) || safeFallbackMessage,
    // debugMessage CHỈ tồn tại ngoài production (mục 3/6) — không lộ stack trace/raw provider body
    // khi deploy công khai; production vẫn có đủ chi tiết này trong log server để debug (xem
    // errorHandler.js — log() luôn nhận bản đầy đủ bất kể NODE_ENV, chỉ response HTTP là bị giới hạn).
    debugMessage: process.env.NODE_ENV !== 'production'
      ? ((err && (err.debugMessage || err.detail)) || (err && err.stack) || undefined)
      : undefined,
    provider: (err && err.provider) || null,
    model: (err && err.model) || null,
    retryable
  };
}

module.exports = { normalizeError, HTTP_STATUS_CODE_MAP };
