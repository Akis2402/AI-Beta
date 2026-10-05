'use strict';

// ============================================================================================
// PHIÊN ĐĂNG NHẬP (cookie httpOnly) + XÁC MINH NGƯỜI DÙNG PHÍA SERVER
// ============================================================================================
// Thiết kế:
//   - Token KHÔNG bao giờ nằm trong localStorage / JS của trang: `tg_at` (access, ~1h) và `tg_rt`
//     (refresh) là cookie HttpOnly + SameSite=Lax (+ Secure trên HTTPS). XSS không đọc được chúng.
//   - Mỗi request AI: đọc `tg_at`, hỏi GoTrue `/auth/v1/user` (nguồn sự thật — token bị thu hồi hoặc
//     user bị xoá sẽ bị từ chối ngay). Kết quả dương được cache ngắn (<= 20s, không quá `exp` của token)
//     để không thêm 1 RTT mạng vào MỌI request.
//   - Access hết hạn -> tự refresh bằng `tg_rt`, ghi lại cookie mới ngay trong response hiện tại.
//   - "Ghi nhớ đăng nhập": cookie refresh có Max-Age 30 ngày; không tick -> cookie phiên (mất khi đóng trình duyệt).
//   - Vai trò admin KHÔNG lấy từ JWT/user_metadata (user tự sửa được) mà tra bảng profiles bằng service role.

const crypto = require('crypto');
const sb = require('../supabase/client');

const AT = 'tg_at';
const RT = 'tg_rt';
const RM = 'tg_rm';
const REFRESH_MAX_AGE = 30 * 24 * 3600;
const VERIFY_CACHE_TTL_MS = 20000;
const PROFILE_CACHE_TTL_MS = 30000;

// ---------- cookie ----------
function parseCookies(header) {
  const out = Object.create(null);
  if (!header) return out;
  String(header).split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    if (!k || k in out) return;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch (_) { /* cookie hỏng -> bỏ qua */ }
  });
  return out;
}

function isSecureRequest(req) {
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') return true;
  if (req && req.secure) return true;
  const proto = req && req.headers && req.headers['x-forwarded-proto'];
  return typeof proto === 'string' && proto.split(',')[0].trim() === 'https';
}

function serializeCookie(name, value, { maxAge, secure } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
  if (maxAge !== undefined) c += `; Max-Age=${Math.max(0, Math.floor(maxAge))}`;
  if (secure) c += '; Secure';
  return c;
}

function appendSetCookie(res, cookies) {
  const prev = res.getHeader && res.getHeader('Set-Cookie');
  const list = Array.isArray(prev) ? prev.slice() : (prev ? [String(prev)] : []);
  res.setHeader('Set-Cookie', list.concat(cookies));
}

function setSessionCookies(req, res, session, { remember } = {}) {
  const secure = isSecureRequest(req);
  const persistent = remember === undefined ? (parseCookies(req.headers.cookie)[RM] === '1') : !!remember;
  const atAge = Math.max(60, Number(session.expires_in) || 3600);
  const cookies = [
    serializeCookie(AT, session.access_token, { maxAge: atAge, secure }),
    serializeCookie(RT, session.refresh_token, { maxAge: persistent ? REFRESH_MAX_AGE : undefined, secure }),
    serializeCookie(RM, persistent ? '1' : '0', { maxAge: persistent ? REFRESH_MAX_AGE : undefined, secure })
  ];
  appendSetCookie(res, cookies);
}

function clearSessionCookies(req, res) {
  const secure = isSecureRequest(req);
  appendSetCookie(res, [AT, RT, RM].map((n) => serializeCookie(n, '', { maxAge: 0, secure })));
}

// ---------- JWT (chỉ đọc exp để tránh gọi mạng vô ích — KHÔNG dùng để tin cậy danh tính) ----------
function decodeJwtExp(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return Number(payload.exp) || 0;
  } catch (_) { return 0; }
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const verifyCache = new Map();
function cacheGet(key) {
  const hit = verifyCache.get(key);
  if (!hit) return null;
  if (hit.until < Date.now()) { verifyCache.delete(key); return null; }
  return hit.user;
}
function cacheSet(key, user, token) {
  const expMs = decodeJwtExp(token) * 1000;
  const until = Math.min(Date.now() + VERIFY_CACHE_TTL_MS, expMs || 0);
  if (until <= Date.now()) return;
  if (verifyCache.size >= 500) verifyCache.delete(verifyCache.keys().next().value);
  verifyCache.set(key, { user, until });
}
function forgetToken(token) { if (token) verifyCache.delete(sha(token)); }

const refreshInflight = new Map();

function toUser(u) {
  return { id: u.id, email: u.email || null, emailConfirmed: Boolean(u.email_confirmed_at || u.confirmed_at) };
}

/**
 * resolveSession() — xác định người dùng của request, tự refresh nếu cần.
 * @returns {Promise<{status:'authenticated'|'unauthenticated'|'expired'|'unavailable', user:object|null}>}
 *   'unavailable': dịch vụ Supabase lỗi/quá chậm — KHÔNG được coi như "chưa đăng nhập" (UI không được tự đăng xuất).
 */
async function resolveSession(req, res) {
  if (req.__authResolved) return req.__authResolved;
  const run = async () => {
    const cookies = parseCookies(req.headers && req.headers.cookie);
    const at = cookies[AT];
    const rt = cookies[RT];
    if (!at && !rt) return { status: 'unauthenticated', user: null };

    try {
      if (at && decodeJwtExp(at) * 1000 > Date.now() + 5000) {
        const key = sha(at);
        const cached = cacheGet(key);
        if (cached) return { status: 'authenticated', user: cached };
        const r = await sb.auth.getUser(at);
        if (r.ok && r.data && r.data.id) {
          const user = toUser(r.data);
          cacheSet(key, user, at);
          return { status: 'authenticated', user };
        }
        if (r.status >= 500) return { status: 'unavailable', user: null };
        // 401/403: token bị thu hồi/không hợp lệ -> thử refresh bên dưới.
      }

      if (!rt) { clearSessionCookies(req, res); return { status: 'expired', user: null }; }

      const rtKey = sha(rt);
      let p = refreshInflight.get(rtKey);
      if (!p) {
        p = sb.auth.refresh(rt).finally(() => setTimeout(() => refreshInflight.delete(rtKey), 10000));
        refreshInflight.set(rtKey, p);
      }
      const rr = await p;
      if (rr.ok && rr.data && rr.data.access_token && rr.data.user) {
        setSessionCookies(req, res, rr.data);
        const user = toUser(rr.data.user);
        cacheSet(sha(rr.data.access_token), user, rr.data.access_token);
        return { status: 'authenticated', user };
      }
      if (rr.status >= 500) return { status: 'unavailable', user: null };
      clearSessionCookies(req, res);
      return { status: 'expired', user: null };
    } catch (e) {
      return { status: 'unavailable', user: null };
    }
  };
  req.__authResolved = await run();
  return req.__authResolved;
}

// ---------- profile / role (service role; không tin JWT claims) ----------
const profileCache = new Map();
async function getProfile(userId) {
  const hit = profileCache.get(userId);
  if (hit && hit.until > Date.now()) return hit.profile;
  const rows = await sb.select('profiles', `id=eq.${encodeURIComponent(userId)}&select=id,email,display_name,avatar_url,role&limit=1`);
  const profile = rows[0] || null;
  if (profileCache.size >= 500) profileCache.delete(profileCache.keys().next().value);
  profileCache.set(userId, { profile, until: Date.now() + PROFILE_CACHE_TTL_MS });
  return profile;
}
function forgetProfile(userId) { profileCache.delete(userId); }

// ---------- validate đầu vào ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function validateEmail(raw) {
  const email = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return { ok: false, message: 'Email không hợp lệ.' };
  return { ok: true, value: email };
}
function validatePassword(raw, email) {
  const pw = String(raw == null ? '' : raw);
  if (pw.length < 8) return { ok: false, message: 'Mật khẩu cần ít nhất 8 ký tự.' };
  if (Buffer.byteLength(pw, 'utf8') > 72) return { ok: false, message: 'Mật khẩu quá dài (tối đa 72 byte).' };
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return { ok: false, message: 'Mật khẩu cần có cả chữ và số.' };
  if (email && pw.toLowerCase() === String(email).toLowerCase()) return { ok: false, message: 'Mật khẩu không được trùng email.' };
  return { ok: true, value: pw };
}

module.exports = {
  AT, RT, RM,
  parseCookies, serializeCookie, appendSetCookie, setSessionCookies, clearSessionCookies, isSecureRequest,
  resolveSession, forgetToken, getProfile, forgetProfile, validateEmail, validatePassword, decodeJwtExp,
  _clearCachesForTest() { verifyCache.clear(); profileCache.clear(); refreshInflight.clear(); }
};
