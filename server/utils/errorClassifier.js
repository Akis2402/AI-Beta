'use strict';

// ---------- Phân loại lỗi từ provider thành SCOPE ảnh hưởng + thời gian cooldown ----------
// Trước đây (aiProviders.js cũ) mọi lỗi đều được coi như nhau: cooldown 60s mặc định cho "provider"
// (thực chất là 1 cặp key+model gộp), chỉ đọc số giây "try again in Ns" khi có. Không phân biệt:
//   - lỗi do KHÓA API (sai/hết hạn/hết quota) → phải ảnh hưởng MỌI model dùng khóa đó
//   - lỗi do MODEL (quá tải/không khả dụng ở phía hãng) → phải ảnh hưởng MỌI khóa dùng model đó
//   - lỗi CHỈ RIÊNG 1 cặp khóa+model cụ thể → chỉ cooldown đúng target đó
//   - lỗi tạm thời (timeout/mạng/5xx) → cooldown ngắn, retry được
//   - lỗi request không hợp lệ (400 do payload sai) → KHÔNG nên cooldown/xoay vô hạn, đây là bug ở
//     phía hệ thống gửi request chứ không phải lỗi của khóa/model
//   - lỗi billing/quota → phải bị CHẶN không lộ nguyên văn ra người dùng (xem sanitizeForUser)
//
// classify(err) trả về {scope, cooldownMs, invalid, sanitizedMessage}. `scope` quyết định
// rotationManager.markFailure() áp cooldown ở tầng nào (key / model / target / none).

const BILLING_PATTERNS = [
  /check your plan/i,
  /billing/i,
  /payment required/i,
  /quota exceeded/i,
  /insufficient[_ ]quota/i,
  /exceeded your current quota/i
];

const INVALID_KEY_PATTERNS = [
  /invalid[_ ]api[_ ]key/i,
  /incorrect api key/i,
  /api key not valid/i,
  /unauthorized/i,
  /authentication/i,
  /revoked/i,
  /permission denied/i
];

const MODEL_UNAVAILABLE_PATTERNS = [
  /model[_ ]not[_ ]found/i,
  /does not exist/i,
  /unsupported model/i,
  /model is overloaded/i,
  /model_overloaded/i,
  /currently overloaded/i
];

const INVALID_REQUEST_STATUS = new Set([400, 404, 422]);

/**
 * @param {Error & {status?:number, detail?:string}} err
 * @returns {{scope:'key'|'model'|'target'|'transient'|'invalid_request'|'unknown',
 *   cooldownMs:number, invalid:boolean, isBilling:boolean, sanitizedMessage:string}}
 */
function classify(err) {
  const status = err && err.status;
  const rawText = String((err && (err.detail || err.message)) || '');

  const isBilling = BILLING_PATTERNS.some((re) => re.test(rawText));
  if (isBilling) {
    // Billing/quota: ảnh hưởng KHÓA API đó (quota gắn với khóa), cooldown dài — không expose chi
    // tiết hãng cho người dùng cuối (xem mục 11 trong yêu cầu gốc).
    return {
      scope: 'key',
      cooldownMs: 10 * 60 * 1000, // 10 phút — quota thường không tự hồi phục nhanh
      invalid: false,
      isBilling: true,
      sanitizedMessage: 'Nhà cung cấp AI này tạm thời không khả dụng (hạn mức sử dụng).'
    };
  }

  if (status === 429) {
    const m = /try again in\s*([\d.]+)\s*s/i.exec(rawText);
    const retryMs = m ? Math.min(120000, Math.max(1000, Math.round(parseFloat(m[1]) * 1000))) : 60000;
    // Rate limit thường gắn theo KHÓA API (mỗi khóa có hạn mức/phút riêng của hãng).
    return { scope: 'key', cooldownMs: retryMs, invalid: false, isBilling: false, sanitizedMessage: 'Nhà cung cấp AI đang bị giới hạn tốc độ, đang thử lại bằng cấu hình khác.' };
  }

  if (INVALID_KEY_PATTERNS.some((re) => re.test(rawText)) || status === 401 || status === 403) {
    // Khóa sai/hết hạn/bị thu hồi — không tự retry cho tới khi credential được cập nhật (mục 20).
    return { scope: 'key', cooldownMs: 6 * 60 * 60 * 1000, invalid: true, isBilling: false, sanitizedMessage: 'Cấu hình khóa API không hợp lệ.' };
  }

  if (MODEL_UNAVAILABLE_PATTERNS.some((re) => re.test(rawText))) {
    // Model quá tải/không tồn tại ở phía hãng — ảnh hưởng MỌI khóa đang dùng model đó.
    return { scope: 'model', cooldownMs: 45000, invalid: false, isBilling: false, sanitizedMessage: 'Model này tạm thời không khả dụng.' };
  }

  if (INVALID_REQUEST_STATUS.has(status)) {
    // Lỗi request không hợp lệ (payload/schema sai) — KHÔNG cooldown, không nên xoay vô hạn để
    // "né" lỗi này vì nó sẽ lặp lại y hệt ở target khác (đây là lỗi ở phía request, không phải
    // ở phía key/model). Đánh dấu invalid_request để nơi gọi có thể dừng sớm thay vì thử hết pool.
    return { scope: 'invalid_request', cooldownMs: 0, invalid: false, isBilling: false, sanitizedMessage: 'Yêu cầu không hợp lệ.' };
  }

  if (status === 504 || status === 503 || status === 502 || !status) {
    // Timeout/mạng/5xx — lỗi TẠM THỜI, chỉ ảnh hưởng đúng cặp khóa+model đang thử (target-specific,
    // mục 9/10) — không kết luận cả khóa hay cả model đều hỏng chỉ vì 1 lượt timeout.
    return { scope: 'target', cooldownMs: 20000, invalid: false, isBilling: false, sanitizedMessage: 'Nhà cung cấp AI phản hồi chậm/lỗi tạm thời.' };
  }

  // Không xác định rõ nguyên nhân — coi như lỗi target-specific, cooldown ngắn, an toàn nhất.
  return { scope: 'target', cooldownMs: 20000, invalid: false, isBilling: false, sanitizedMessage: 'Có lỗi khi gọi nhà cung cấp AI.' };
}

module.exports = { classify };
