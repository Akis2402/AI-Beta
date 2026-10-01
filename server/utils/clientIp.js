'use strict';

// P7 — Lấy IP client cho rate limit một cách KHÔNG tin header do client tự gửi.
//
// Vấn đề: server dùng `app.set('trust proxy', 1)` rồi đọc `req.ip`, tức là tin phần tử cuối của x-forwarded-for.
//   - Vercel trực tiếp: nền tảng ghi đè x-forwarded-for bằng IP thật -> `req.ip` đúng.
//   - Tự host KHÔNG proxy tin cậy: client tự gửi `x-forwarded-for: <IP tuỳ ý>` -> `req.ip` bị giả mạo,
//     đổi header mỗi request là né sạch rate limit.
//   - Cloudflare/proxy khác đứng trước Vercel: Vercel thấy IP của proxy -> mọi người dùng dồn vào MỘT bucket.
//
// Cách xử lý (thứ tự ưu tiên, mọi giá trị đều phải là IP hợp lệ, nếu không thì bỏ qua):
//   1. CLIENT_IP_HEADER (env, opt-in): tên header do một proxy TIN CẬY của bạn đặt (vd `cf-connecting-ip` khi
//      Cloudflare đứng trước). Chỉ bật khi chắc chắn mọi request đều đi qua proxy đó, vì header này tự nó giả mạo được.
//   2. Chạy trên Vercel (env VERCEL): `x-vercel-forwarded-for` do nền tảng đặt, client không ghi đè được.
//   3. `req.ip` (hành vi cũ) rồi tới phần tử đầu x-forwarded-for, cuối cùng 'unknown'.

const net = require('net');

function firstValue(headers, name) {
  const raw = headers && headers[name];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === 'string' ? v.split(',')[0].trim() : '';
}

function validIp(v) {
  return v && net.isIP(v) ? v : '';
}

function getClientIp(req, env = process.env) {
  const headers = (req && req.headers) || {};
  const custom = String(env.CLIENT_IP_HEADER || '').trim().toLowerCase();
  if (custom) {
    const ip = validIp(firstValue(headers, custom));
    if (ip) return ip;
  }
  if (env.VERCEL) {
    const ip = validIp(firstValue(headers, 'x-vercel-forwarded-for'));
    if (ip) return ip;
  }
  return (req && req.ip) || validIp(firstValue(headers, 'x-forwarded-for')) || 'unknown';
}

module.exports = { getClientIp };
