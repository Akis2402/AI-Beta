'use strict';

// ============================================================================================
// PROOF-OF-WORK CHO ĐĂNG KÝ — làm tăng chi phí tạo hàng loạt tài khoản để "nhân" hạn mức
// ============================================================================================
// Vì sao PoW tự host thay vì CAPTCHA (Turnstile/hCaptcha): widget bên thứ ba cần nới CSP script-src/frame-src
// cho MỌI người dùng (vercel.json là header tĩnh, không bật/tắt theo biến môi trường) và không thể gắn SRI —
// phá chính sách CSP/SRI của dự án (test cdn-sri, vercel-header-parity). PoW chạy bằng Web Crypto sẵn có.
//
// Cách hoạt động (stateless, không cần DB):
//   1. GET /api/auth/challenge  -> { token, salt, bits }.  token = base64url(JSON{s:salt, e:hết hạn, b:bits}) + '.' + HMAC
//   2. Trình duyệt tìm nonce sao cho SHA-256(`${salt}:${nonce}`) có >= bits bit 0 đầu (≈ 2^bits lần băm, ~1s ở 16 bit).
//   3. POST /api/auth/signup kèm { challenge: token, nonce }. Server kiểm HMAC, hạn dùng, độ khó, lời giải, và
//      CHỐNG DÙNG LẠI (mỗi challenge chỉ dùng 1 lần; kvStore.incr nguyên tử nếu có Upstash, không thì bộ nhớ instance).
//
// THẬT THÀ về sức mạnh: PoW KHÔNG chặn kẻ tấn công có tài nguyên (GPU/máy chủ nhiều nhân) — nó chặn script ngây thơ
// và nâng chi phí mỗi tài khoản. Lớp bảo vệ thật là: (a) bật Confirm email ở Supabase, (b) giới hạn đăng ký/IP,
// (c) hạn mức theo tài khoản. Ba lớp này kết hợp mới có ý nghĩa; riêng PoW thì yếu.

const crypto = require('crypto');
const kv = require('../kvStore');
const { getConfig } = require('../quota/config');

const TTL_MS = 5 * 60 * 1000;
const REPLAY_TTL_SECONDS = 10 * 60;
const memReplay = new Map(); // fallback khi không có kvStore: sha(token) -> hết hạn

function secret() {
  const c = getConfig();
  if (c.auth.powSecret) return c.auth.powSecret;
  // Dẫn xuất từ service key (bí mật sẵn có phía server) để không bắt người dùng đặt thêm biến.
  return crypto.createHmac('sha256', 'tg-pow-v1').update(c.supabase.serviceKey || 'no-key').digest('hex');
}
const hmac = (payload) => crypto.createHmac('sha256', secret()).update(payload).digest('base64url');

function leadingZeroBits(buf) {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) { bits += 8; continue; }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

function isEnabled() { return getConfig().auth.powBits > 0; }

/** @returns {{enabled:false}|{enabled:true, token:string, salt:string, bits:number}} */
function createChallenge(now = Date.now()) {
  const bits = getConfig().auth.powBits;
  if (bits <= 0) return { enabled: false };
  const salt = crypto.randomBytes(12).toString('hex');
  const body = Buffer.from(JSON.stringify({ s: salt, e: now + TTL_MS, b: bits })).toString('base64url');
  return { enabled: true, token: `${body}.${hmac(body)}`, salt, bits };
}

function pruneMem(now) {
  if (memReplay.size < 2000) return;
  for (const [k, exp] of memReplay) if (exp < now) memReplay.delete(k);
  while (memReplay.size >= 5000) memReplay.delete(memReplay.keys().next().value);
}

async function consumeOnce(token, now) {
  const key = `tg:pow:${crypto.createHash('sha256').update(token).digest('hex').slice(0, 32)}`;
  const n = await kv.incr(key, REPLAY_TTL_SECONDS); // null khi store tắt/lỗi -> hạ cấp về bộ nhớ instance
  if (n !== null) return n === 1;
  pruneMem(now);
  if (memReplay.has(key) && memReplay.get(key) > now) return false;
  memReplay.set(key, now + REPLAY_TTL_SECONDS * 1000);
  return true;
}

/**
 * @returns {Promise<{ok:true}|{ok:false, code:'pow_missing'|'pow_invalid'|'pow_expired'|'pow_weak'|'pow_replay'}>}
 */
async function verify(token, nonce, now = Date.now()) {
  const required = getConfig().auth.powBits;
  if (required <= 0) return { ok: true };
  if (typeof token !== 'string' || nonce === undefined || nonce === null || token.length > 400) return { ok: false, code: 'pow_missing' };
  const dot = token.indexOf('.');
  if (dot < 1) return { ok: false, code: 'pow_invalid' };
  const body = token.slice(0, dot); const sig = token.slice(dot + 1);
  const expected = hmac(body);
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, code: 'pow_invalid' };
  let p;
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (_) { return { ok: false, code: 'pow_invalid' }; }
  if (!p || typeof p.s !== 'string' || !Number.isFinite(p.e) || !Number.isFinite(p.b)) return { ok: false, code: 'pow_invalid' };
  if (p.e < now) return { ok: false, code: 'pow_expired' };
  if (p.b < required) return { ok: false, code: 'pow_weak' }; // challenge cấp khi độ khó còn thấp: không chấp nhận sau khi tăng
  const nonceStr = String(nonce);
  if (!/^\d{1,12}$/.test(nonceStr)) return { ok: false, code: 'pow_invalid' };
  const h = crypto.createHash('sha256').update(`${p.s}:${nonceStr}`).digest();
  if (leadingZeroBits(h) < p.b) return { ok: false, code: 'pow_invalid' };
  if (!(await consumeOnce(token, now))) return { ok: false, code: 'pow_replay' };
  return { ok: true };
}

module.exports = { createChallenge, verify, isEnabled, leadingZeroBits, _clearForTest() { memReplay.clear(); } };
