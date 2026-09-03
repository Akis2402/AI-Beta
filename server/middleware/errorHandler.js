'use strict';

const { log, classifyErrorForLog } = require('../utils/logger');

function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Không tìm thấy endpoint.' });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  // Observability (mục LVIII): 1 dòng log JSON có cấu trúc cho MỌI lỗi lọt tới đây (route/status/
  // errorClass) — không log message thô của provider (có thể chứa chi tiết billing) ở field chính,
  // chỉ log classifyErrorForLog() (ngắn gọn, an toàn để log). Message đầy đủ vẫn đi qua console.error
  // truyền thống bên dưới cho lỗi 5xx (dev debug), KHÔNG gộp secret vào JSON log.
  log({
    level: status >= 500 ? 'error' : 'warn',
    route: req && req.originalUrl,
    method: req && req.method,
    stage: 'request_error',
    status,
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
  const payload = { error: err.message || 'Đã có lỗi xảy ra ở máy chủ.' };
  // Chỉ lộ chi tiết kỹ thuật thô (body lỗi gốc từ nhà cung cấp) ngoài production, để tránh vô tình
  // lộ thông tin nội bộ khi deploy công khai — nhưng LUÔN trả kèm providerErrors (chỉ gồm tên
  // provider + câu lỗi đã được rút gọn, không chứa khóa API) vì đây là thông tin cốt yếu để tự
  // chẩn đoán ngay trên giao diện (không cần vào xem log server) khi TẤT CẢ provider cùng lỗi.
  if (process.env.NODE_ENV !== 'production' && err.detail) {
    payload.detail = err.detail;
  }
  if (Array.isArray(err.triedProviders) && err.triedProviders.length) {
    payload.providerErrors = err.triedProviders;
  }
  res.status(status).json(payload);
}

module.exports = { notFoundHandler, errorHandler };
