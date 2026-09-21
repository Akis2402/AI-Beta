'use strict';

// ============================================================================================
// PHẦN J — RATE LIMIT ĐÚNG NGỮ NGHĨA PRODUCTION
// ============================================================================================
// Hiện trạng cũ: `express-rate-limit` với memory store. Trên Vercel, mỗi instance đếm riêng — cấu
// hình `max=40` thực tế cho phép `40 × số instance` request trong cùng cửa sổ. Đó không phải "giới
// hạn chi phí AI", đó là ảo giác về giới hạn.
//
// NAY: hai tầng, và tầng nào đang có hiệu lực được nói RÕ:
//   1. TẦNG TOÀN CỤC (khi KV được cấu hình): INCR nguyên tử trên KV theo cửa sổ cố định -> giới hạn
//      THẬT trên toàn hệ thống, bất kể bao nhiêu instance.
//   2. TẦNG CỤC BỘ (luôn có): express-rate-limit per-instance, vừa là lưới an toàn khi KV lỗi/tắt,
//      vừa chặn burst ngay tại instance mà không tốn 1 lượt đi mạng.
// KV lỗi -> KHÔNG chặn request (fail-open ở tầng 1) nhưng tầng 2 vẫn chạy; header
// `X-RateLimit-Scope` nói thật: 'global' hay 'instance'.

const rateLimit = require('express-rate-limit');
const kv = require('../utils/kvStore');

/** Khoá đếm: IP + tên nhóm + số hiệu cửa sổ. KHÔNG chứa nội dung câu hỏi hay bất kỳ dữ liệu nào khác. */
function bucketKey(name, ip, windowMs) {
  const windowId = Math.floor(Date.now() / windowMs);
  return `rl:${name}:${windowId}:${ip}`;
}

/**
 * @param {{name:string, windowMs:number, max:number, message:object}} opts
 * @returns {Function[]} chuỗi middleware [toàn cục, cục bộ]
 */
function createLimiter(opts) {
  const { name, windowMs, max, message } = opts;

  const localLimiter = rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message
  });

  async function globalLimiter(req, res, next) {
    if (!kv.isEnabled()) {
      // Nói THẬT phạm vi đang áp dụng — không để ai đọc log rồi tưởng đang có giới hạn toàn cục.
      res.setHeader('X-RateLimit-Scope', 'instance');
      return next();
    }
    const ip = req.ip || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const count = await kv.incr(bucketKey(name, ip, windowMs), Math.ceil(windowMs / 1000));
    if (count == null) {
      // KV lỗi: fail-open ở tầng này (không chặn người dùng hợp lệ vì hạ tầng phụ), tầng cục bộ bên
      // dưới vẫn chặn. Ghi rõ phạm vi đã bị hạ cấp.
      res.setHeader('X-RateLimit-Scope', 'instance-degraded');
      return next();
    }
    res.setHeader('X-RateLimit-Scope', 'global');
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - count)));
    if (count > max) {
      return res.status(429).json({ ...message, code: 'RATE_LIMIT', retryable: true });
    }
    return next();
  }

  return [globalLimiter, localLimiter];
}

/** @returns {boolean} giới hạn hiện đang có hiệu lực TOÀN CỤC hay chỉ trong 1 instance. */
function isGlobalScope() { return kv.isEnabled(); }

module.exports = { createLimiter, isGlobalScope, bucketKey };
