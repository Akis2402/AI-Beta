'use strict';

// ---------- Observability logger (mục LVIII) ----------
// Log dạng JSON có cấu trúc — mỗi dòng log 1 sự kiện, dễ ingest bởi bất kỳ log pipeline nào
// (CloudWatch/Vercel logs/Datadog...). KHÔNG bao giờ log API key, Authorization header, hay
// bất kỳ secret nào — mọi field đi qua redact() trước khi ghi ra, kể cả khi caller quên tự lọc.
//
// Field chuẩn theo yêu cầu master prompt: requestId, provider, model, targetId, stage, latency,
// status, error class. Có thể log thêm field khác (route, method...) miễn không phải secret.

const SECRET_KEY_PATTERN = /(api[-_]?key|authorization|token|secret|password|cookie|bearer)/i;
// Giá trị trông như 1 API key thật (chuỗi dài, không khoảng trắng, nhiều ký tự alnum liên tiếp) —
// chặn cả trường hợp secret bị nhét vào field có tên "vô hại" (vd message chứa nguyên văn header).
const SECRET_VALUE_PATTERN = /\b(sk-[a-zA-Z0-9_-]{10,}|AIza[a-zA-Z0-9_-]{20,}|Bearer\s+[a-zA-Z0-9._-]{10,})\b/g;

function redactString(str) {
  if (typeof str !== 'string') return str;
  return str.replace(SECRET_VALUE_PATTERN, '[REDACTED]');
}

/** Xoá đệ quy mọi field có tên gợi ý là secret, và mask giá trị trông giống secret trong string. */
function redact(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(k)) { out[k] = '[REDACTED]'; continue; }
      out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

let seq = 0;
function genRequestId() {
  seq = (seq + 1) % 1e9;
  return `req_${Date.now().toString(36)}_${seq.toString(36)}`;
}

/**
 * Ghi 1 dòng log JSON. `entry.level` mặc định 'info'. KHÔNG throw nếu JSON.stringify lỗi (vd
 * circular reference) — fallback ghi 1 dòng lỗi log tối giản thay vì làm crash request đang xử lý.
 */
function log(entry) {
  const safe = redact({ ts: new Date().toISOString(), level: 'info', ...entry });
  try {
    const line = JSON.stringify(safe);
    if (safe.level === 'error') console.error(line);
    else if (safe.level === 'warn') console.warn(line);
    else console.log(line);
  } catch (e) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', event: 'log_serialize_failed', message: String(e && e.message) }));
  }
}

/**
 * Logger gắn theo 1 request cụ thể — mọi log tự động kèm requestId, route, method, không phải
 * truyền lại thủ công mỗi lần gọi. `child()` trả về hàm log đã bind sẵn requestId cho từng module
 * con (aiProviders/rotationManager...) muốn log việc lựa chọn/gọi target mà không cần biết requestId.
 */
function createRequestLogger({ requestId, route, method } = {}) {
  const id = requestId || genRequestId();
  const startedAt = Date.now();
  function child(fields) {
    return (extra = {}) => log({ requestId: id, route, method, ...fields, ...extra });
  }
  return {
    requestId: id,
    log: (fields) => log({ requestId: id, route, method, ...fields }),
    child,
    elapsed: () => Date.now() - startedAt,
    end: (fields = {}) => log({ requestId: id, route, method, stage: 'request_end', latency: Date.now() - startedAt, ...fields })
  };
}

/** Lấy "error class" ngắn gọn (không phải message đầy đủ, tránh lộ chi tiết billing/secret) để log status/error class riêng biệt. */
function classifyErrorForLog(err) {
  if (!err) return 'unknown';
  if (err.status === 429) return 'rate_limited';
  if (err.status === 401 || err.status === 403) return 'auth_error';
  if (err.status >= 500) return 'upstream_error';
  if (err.code === 'ETIMEDOUT' || err.name === 'AbortError') return 'timeout';
  if (err.code === 'ENOTFOUND' || err.code === 'ECONNRESET') return 'network_error';
  return err.name || 'error';
}

module.exports = { log, redact, createRequestLogger, genRequestId, classifyErrorForLog };
