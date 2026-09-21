'use strict';

const { log, classifyErrorForLog } = require('../utils/logger');
const { normalizeError } = require('../utils/errorNormalize');

function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Không tìm thấy endpoint.' });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // PHẦN A8/AE: lỗi 413 do CHÍNH body-parser ném ra mang message thô của thư viện ("request entity
  // too large") và stack chứa đường dẫn nội bộ. Chuẩn hoá tại đây thành đúng một hình dạng với lỗi
  // payload do validator sinh ra — cùng code, cùng userMessage, cùng actualSize/safeLimit — để client
  // xử lý một cách duy nhất, và KHÔNG lộ đường dẫn/stack.
  if (err && (err.type === 'entity.too.large' || err.status === 413) && !err.payloadInfo) {
    const budget = require('../utils/payloadBudget');
    err.code = 'PAYLOAD_TOO_LARGE';
    err.userMessage = 'Yêu cầu quá nặng so với giới hạn của máy chủ. Hãy giảm số trang/ảnh nguồn gửi kèm rồi thử lại.';
    err.debugMessage = undefined;
    err.stack = '';
    err.payloadInfo = {
      scope: 'request',
      actualSize: Number(err.length) || 0, // 0 khi parser chặn trước lúc đọc xong — không đoán số
      safeLimit: budget.SAFE_REQUEST_BYTES,
      suggestedAction: 'reduce_source_images_or_contexts'
    };
  }
  const normalized = normalizeError(err);
  const status = normalized.status;
  // Observability (mục LVIII/6): 1 dòng log JSON có cấu trúc cho MỌI lỗi lọt tới đây (route/status/
  // code/errorClass) — KHÔNG log message thô của provider (có thể chứa chi tiết billing) ở field
  // chính, chỉ log classifyErrorForLog() (ngắn gọn, an toàn để log) + code đã chuẩn hóa. Message đầy
  // đủ vẫn đi qua console.error truyền thống bên dưới cho lỗi 5xx (dev debug), KHÔNG gộp secret vào
  // JSON log — provider/model trong `normalized` chỉ là TÊN (vd "anthropic"/"claude-sonnet-9"),
  // không bao giờ chứa API key (xem cách provider/model được gán ở nơi throw — luôn từ target.label/
  // target.providerKey/target.modelName, không phải từ request headers/body).
  log({
    level: status >= 500 ? 'error' : 'warn',
    route: req && req.originalUrl,
    method: req && req.method,
    stage: 'request_error',
    status,
    code: normalized.code,
    provider: normalized.provider,
    model: normalized.model,
    retryable: normalized.retryable,
    errorClass: classifyErrorForLog(err),
    triedProviderCount: Array.isArray(err.triedProviders) ? err.triedProviders.length : undefined
  });
  if (status >= 500) {
    console.error('[LỖI SERVER]', err.message);
    // Log riêng từng dòng lý do lỗi của mỗi nhà cung cấp AI (nếu có) — tránh bị cắt cụt thành
    // "[Object]"/"…" trên Vercel/console khi log cả object err lồng mảng, để luôn chẩn đoán được
    // NGUYÊN NHÂN THẬT SỰ (API key sai, model không hợp lệ, hết hạn mức, timeout...) của TỪNG
    // provider đã thử, thay vì chỉ thấy thông báo chung chung "tất cả đều lỗi".
    if (Array.isArray(err.triedProviders) && err.triedProviders.length) {
      err.triedProviders.forEach((t) => console.error(`  ↳ [${t.label}] ${t.error}`));
    }
  }
  // ---------- mục 3/6: response chỉ chứa dữ liệu AN TOÀN cho client ----------
  // `error` (giữ tên field cũ để KHÔNG phá public/js/app.js hiện có đang đọc `data.error`) LUÔN LÀ
  // userMessage đã chuẩn hóa — KHÔNG BAO GIỜ là message thô của provider/stack trace/URL nội bộ.
  // `code`/`retryable` là field MỚI, bổ sung thêm (không thay thế) để client về sau có thể switch
  // theo mã lỗi ổn định thay vì match chuỗi tiếng Việt dễ vỡ khi đổi wording.
  const payload = {
    error: normalized.userMessage,
    code: normalized.code,
    retryable: normalized.retryable
  };
  // PHẦN A8: lỗi payload quá lớn đi kèm thông tin ĐỦ để client tự giảm tải (kích thước thật, trần an
  // toàn, hành động gợi ý) — và KHÔNG có gì hơn thế (không path nội bộ, không cấu hình, không stack).
  if (err && err.payloadInfo) {
    payload.actualSize = err.payloadInfo.actualSize;
    payload.safeLimit = err.payloadInfo.safeLimit;
    payload.suggestedAction = err.payloadInfo.suggestedAction;
    payload.scope = err.payloadInfo.scope;
  }
  // PHẦN E: danh sách trang nguồn bị TỪ CHỐI (kèm lý do) luôn đi cùng lỗi, để client đánh dấu đúng
  // trang đó thay vì coi như đã đọc thành công.
  if (err && Array.isArray(err.rejected) && err.rejected.length) payload.rejectedPages = err.rejected;
  // debugMessage CHỈ lộ ngoài production (giữ tên field cũ `detail` cho tương thích ngược).
  if (normalized.debugMessage) payload.detail = normalized.debugMessage;
  // providerErrors: chỉ gồm tên provider + câu lỗi đã được rút gọn/sanitize (KHÔNG chứa khóa API) —
  // đây là thông tin cốt yếu để tự chẩn đoán ngay trên giao diện khi TẤT CẢ provider cùng lỗi.
  if (Array.isArray(err.triedProviders) && err.triedProviders.length) {
    payload.providerErrors = err.triedProviders;
  }
  res.status(status).json(payload);
}

module.exports = { notFoundHandler, errorHandler };
