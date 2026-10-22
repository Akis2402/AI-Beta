'use strict';

// ============================================================================================
// /api/auth/*  — đăng ký / đăng nhập / đăng xuất / trạng thái phiên (Supabase Auth qua server)
// ============================================================================================
// Trình duyệt không bao giờ thấy token hay anon key: server gọi GoTrue và đặt cookie HttpOnly.
// Lỗi trả về KHÔNG làm lộ việc email đã tồn tại hay chưa (chống dò tài khoản): đăng ký luôn trả cùng
// một thông điệp trung tính; đăng nhập sai luôn là "Email hoặc mật khẩu không đúng".

const express = require('express');
const crypto = require('crypto');
const { createLimiter } = require('../middleware/rateLimit');
const { originAllowed, requireUser } = require('../middleware/authQuota');
const { getConfig } = require('../utils/quota/config');
const session = require('../utils/auth/session');
const sb = require('../utils/supabase/client');
const quota = require('../utils/quota/quotaService');
const pow = require('../utils/auth/pow');
const turnstile = require('../utils/auth/turnstile');

const router = express.Router();
router.use(express.json({ limit: '4kb' }));

const authLimiter = createLimiter({
  name: 'auth', windowMs: 15 * 60 * 1000, max: Number(process.env.RATE_LIMIT_AUTH || 20),
  message: { error: 'Bạn thử đăng nhập/đăng ký quá nhiều lần. Vui lòng thử lại sau ít phút.' }
});
// Đăng ký chặt hơn đăng nhập nhiều: mỗi tài khoản mới = thêm một hạn mức token miễn phí, nên là điểm bị lạm dụng nhất.
const signupLimiter = createLimiter({
  name: 'signup', windowMs: 60 * 60 * 1000, max: getConfig().auth.signupPerHour,
  message: { error: 'Bạn đăng ký quá nhiều tài khoản từ mạng này. Vui lòng thử lại sau ít giờ.', code: 'signup_rate_limited' }
});

function noStore(res) { res.setHeader('Cache-Control', 'no-store'); }
function bad(res, status, error, code) { noStore(res); return res.status(status).json({ error, code }); }

function ensureConfigured(req, res, next) {
  if (!getConfig().supabase.configured) {
    return bad(res, 503, 'Máy chủ chưa cấu hình đăng nhập (Supabase).', 'auth_not_configured');
  }
  return next();
}
function ensureOrigin(req, res, next) {
  if (!originAllowed(req)) return bad(res, 403, 'Yêu cầu bị từ chối do nguồn gốc không hợp lệ.', 'bad_origin');
  return next();
}

const NEUTRAL_SIGNUP = 'Nếu email hợp lệ, bạn sẽ nhận được thư xác nhận (nếu dự án bật xác nhận email). Hãy kiểm tra hộp thư rồi đăng nhập.';

// Cloudflare Turnstile (captcha). Chỉ bắt buộc khi đã đặt TURNSTILE_SECRET_KEY (xem utils/auth/turnstile.js).
// Token dùng 1 lần: client luôn reset widget sau mỗi request. Trả false (đã gửi lỗi) nếu không đạt.
async function captchaGate(res, token) {
  const r = await turnstile.verify(token);
  if (r.ok) return true;
  console.warn(`[auth] captcha_rejected ${r.code || ''}${r.unavailable ? ' (unavailable)' : ''}`);
  if (r.unavailable) bad(res, 503, 'Không xác minh được bảo mật lúc này. Vui lòng thử lại sau.', 'captcha_unavailable');
  else bad(res, 400, 'Xác minh bảo mật không hợp lệ hoặc đã hết hạn. Vui lòng thử lại.', 'captcha_failed');
  return false;
}

// Họ tên tùy chọn lúc đăng ký -> options.data.full_name -> trigger public.handle_new_user() -> profiles.display_name.
// Chuẩn hóa giống PATCH /profile (1–60 ký tự, không ký tự điều khiển/zero-width). Rỗng = không gửi.
function cleanFullName(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false };
  const name = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (!name) return { ok: true, value: null };
  if (name.length > 60 || BAD_NAME_CHARS.test(name)) return { ok: false };
  return { ok: true, value: name };
}

// ---- GET /api/auth/session  (UI hỏi sau mỗi lần F5) ----
router.get('/session', async (req, res) => {
  noStore(res);
  const cfg = getConfig();
  if (!cfg.enforcement) return res.json({ status: 'disabled', enforcement: false });
  if (!cfg.supabase.configured) return res.json({ status: 'unconfigured', enforcement: true });
  const s = await session.resolveSession(req, res);
  if (s.status !== 'authenticated') return res.json({ status: s.status, enforcement: true, user: null });
  let profile = null;
  try { profile = await session.getProfile(s.user.id); } catch (_) { /* profile lỗi không làm hỏng trạng thái đăng nhập */ }
  return res.json({
    status: 'authenticated', enforcement: true,
    user: { id: s.user.id, email: s.user.email, displayName: (profile && profile.display_name) || null, avatarUrl: (profile && profile.avatar_url) || null, bio: (profile && profile.bio) || null, phone: (profile && profile.phone) || null, providers: Array.isArray(s.user.providers) ? s.user.providers : null, role: (profile && profile.role) || 'user' }
  });
});

// ---- GET /api/auth/challenge  (proof-of-work cho đăng ký; xem utils/auth/pow.js) ----
router.get('/challenge', ensureConfigured, authLimiter, (req, res) => {
  noStore(res);
  return res.json(pow.createChallenge());
});

// ---- POST /api/auth/signup ----
router.post('/signup', ensureConfigured, ensureOrigin, signupLimiter, authLimiter, async (req, res) => {
  noStore(res);
  const body = req.body || {};
  const e = session.validateEmail(body.email);
  if (!e.ok) return bad(res, 400, e.message, 'invalid_email');
  const p = session.validatePassword(body.password, e.value);
  if (!p.ok) return bad(res, 400, p.message, 'weak_password');
  if (body.confirmPassword !== undefined && String(body.confirmPassword) !== String(body.password)) {
    return bad(res, 400, 'Mật khẩu xác nhận không khớp.', 'password_mismatch');
  }
  const fullName = cleanFullName(body.fullName);
  if (!fullName.ok) return bad(res, 400, 'Họ tên không hợp lệ (tối đa 60 ký tự).', 'invalid_display_name');
  if (!(await captchaGate(res, body.turnstileToken))) return;
  // PoW SAU các kiểm tra rẻ: gõ sai email/mật khẩu không đốt challenge của người dùng thật.
  const powResult = await pow.verify(body.challenge, body.nonce);
  if (!powResult.ok) {
    const msg = powResult.code === 'pow_expired' ? 'Phiên xác minh đã hết hạn. Vui lòng thử lại.' : 'Xác minh chống lạm dụng không hợp lệ. Vui lòng thử lại.';
    return bad(res, 400, msg, powResult.code);
  }
  try {
    const r = await sb.auth.signUp(e.value, p.value, fullName.value ? { full_name: fullName.value } : undefined);
    if (r.status >= 500) return bad(res, 503, 'Dịch vụ đăng ký tạm thời không khả dụng. Vui lòng thử lại sau.', 'auth_unavailable');
    if (r.status === 429) return bad(res, 429, 'Quá nhiều yêu cầu đăng ký. Vui lòng thử lại sau.', 'auth_rate_limited');
    // Nếu dự án tắt xác nhận email, GoTrue trả luôn session -> đăng nhập ngay.
    if (r.ok && r.data && r.data.access_token && r.data.refresh_token) {
      session.setSessionCookies(req, res, r.data, { remember: body.remember === true });
      return res.json({ ok: true, status: 'authenticated', message: 'Đăng ký thành công.' });
    }
    // Email đã tồn tại / cần xác nhận / lỗi nghiệp vụ khác: cùng một câu trả lời trung tính.
    return res.json({ ok: true, status: 'confirmation_pending', message: NEUTRAL_SIGNUP });
  } catch (err) {
    return bad(res, 503, 'Dịch vụ đăng ký tạm thời không khả dụng. Vui lòng thử lại sau.', 'auth_unavailable');
  }
});

// ---- POST /api/auth/login ----
router.post('/login', ensureConfigured, ensureOrigin, authLimiter, async (req, res) => {
  noStore(res);
  const body = req.body || {};
  const e = session.validateEmail(body.email);
  const pw = String(body.password == null ? '' : body.password);
  if (!e.ok || !pw) return bad(res, 400, 'Vui lòng nhập email và mật khẩu hợp lệ.', 'invalid_credentials_format');
  if (!(await captchaGate(res, body.turnstileToken))) return;
  try {
    const r = await sb.auth.signInWithPassword(e.value, pw);
    if (r.status >= 500) return bad(res, 503, 'Dịch vụ đăng nhập tạm thời không khả dụng. Vui lòng thử lại sau.', 'auth_unavailable');
    if (r.status === 429) return bad(res, 429, 'Quá nhiều lần thử. Vui lòng thử lại sau.', 'auth_rate_limited');
    if (!r.ok || !r.data || !r.data.access_token) {
      const code = r.data && (r.data.error_code || r.data.code);
      if (code === 'email_not_confirmed') return bad(res, 401, 'Email chưa được xác nhận. Hãy mở thư xác nhận rồi đăng nhập lại.', 'email_not_confirmed');
      return bad(res, 401, 'Email hoặc mật khẩu không đúng.', 'invalid_credentials');
    }
    session.setSessionCookies(req, res, r.data, { remember: body.remember === true });
    return res.json({ ok: true, status: 'authenticated' });
  } catch (err) {
    return bad(res, 503, 'Dịch vụ đăng nhập tạm thời không khả dụng. Vui lòng thử lại sau.', 'auth_unavailable');
  }
});

// ---- POST /api/auth/logout ----
router.post('/logout', ensureOrigin, async (req, res) => {
  noStore(res);
  const cookies = session.parseCookies(req.headers.cookie);
  const at = cookies[session.AT];
  session.clearSessionCookies(req, res); // xoá cookie TRƯỚC: dù GoTrue lỗi, trình duyệt này đã đăng xuất
  if (at && getConfig().supabase.configured) {
    session.forgetToken(at);
    try { await sb.auth.signOut(at); } catch (_) { /* thu hồi phía Supabase là best-effort; cookie đã xoá */ }
  }
  return res.json({ ok: true, status: 'unauthenticated' });
});

// =====================================================================================
// ĐĂNG NHẬP BẰNG GOOGLE (provider Google có sẵn của Supabase; PKCE chạy phía server)
// =====================================================================================
// Luồng: GET /google (tạo code_verifier, lưu cookie HttpOnly tg_pkce, 302 sang Supabase /auth/v1/authorize)
//        -> Google -> Supabase -> GET /callback?code=... (đổi code + verifier lấy phiên, đặt cookie phiên, 302 vào app).
// PKCE gắn code với trình duyệt đã khởi tạo (verifier chỉ nằm trong cookie HttpOnly) => chống login-CSRF/code injection.
// KHÔNG tự gọi API Google, KHÔNG giữ Client Secret: secret chỉ nằm trong Supabase Dashboard.
// Tham số `next` KHÔNG đi qua redirect_to (Supabase đối chiếu allow-list cả query string) mà nằm trong cookie; mọi
// đích đến đều qua safeNext() (chỉ /index.html) nên không có open redirect.
const PKCE_COOKIE = 'tg_pkce';
const PKCE_COOKIE_MAX_AGE = 600;
const b64url = (buf) => Buffer.from(buf).toString('base64url');

function safeNext(raw) {
  const fallback = '/index.html';
  try {
    if (typeof raw !== 'string' || !raw || raw.length > 300) return fallback;
    if (raw.charAt(0) !== '/' || raw.charAt(1) === '/' || raw.charAt(1) === '\\' || /[\u0000-\u001f\\]/.test(raw)) return fallback;
    const u = new URL(raw, 'http://x.invalid');
    if (u.origin !== 'http://x.invalid' || u.pathname !== '/index.html') return fallback;
    return u.pathname + u.search;
  } catch (_) { return fallback; }
}

/** Điều hướng trình duyệt (không trả JSON: đây là route điều hướng của người dùng). */
function navigate(res, location) {
  noStore(res);
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.end();
}
const OAUTH_ERR = { failed: 'failed', cancelled: 'cancelled' };
function navigateError(res, kind) { return navigate(res, `/auth?oauth_error=${OAUTH_ERR[kind] || 'failed'}`); }

/** URL callback gửi cho Supabase: phải nằm trong Authentication -> URL Configuration -> Redirect URLs. */
function oauthCallbackUrl(req) {
  const configured = getConfig().auth.redirectUrl;
  if (configured) return new URL('/api/auth/callback', configured).toString();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(host)) return null;
  const proto = session.isSecureRequest(req) ? 'https' : 'http';
  return `${proto}://${host}/api/auth/callback`;
}

function ensureConfiguredNav(req, res, next) {
  if (!getConfig().supabase.configured) return navigateError(res, 'failed');
  return next();
}

router.get('/google', ensureConfiguredNav, authLimiter, (req, res) => {
  const cb = oauthCallbackUrl(req);
  if (!cb) return navigateError(res, 'failed');
  const q = req.query || {};
  const verifier = b64url(crypto.randomBytes(32)); // 43 ký tự base64url, trong khoảng 43–128 của RFC 7636
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const meta = b64url(JSON.stringify({ n: safeNext(typeof q.next === 'string' ? q.next : ''), r: q.remember === '1' }));
  session.appendSetCookie(res, [
    session.serializeCookie(PKCE_COOKIE, `${verifier}.${meta}`, { maxAge: PKCE_COOKIE_MAX_AGE, secure: session.isSecureRequest(req) })
  ]);
  return navigate(res, sb.auth.oauthAuthorizeUrl('google', cb, challenge));
});

router.get('/callback', ensureConfiguredNav, authLimiter, async (req, res) => {
  const secure = session.isSecureRequest(req);
  const raw = session.parseCookies(req.headers.cookie)[PKCE_COOKIE];
  // Cookie PKCE dùng 1 lần: xóa ngay dù thành công hay lỗi.
  session.appendSetCookie(res, [session.serializeCookie(PKCE_COOKIE, '', { maxAge: 0, secure })]);

  const q = req.query || {};
  if (q.error) return navigateError(res, q.error === 'access_denied' ? 'cancelled' : 'failed');
  const code = typeof q.code === 'string' ? q.code : '';
  if (!/^[\w.~-]{8,512}$/.test(code) || typeof raw !== 'string') return navigateError(res, 'failed');

  const dot = raw.indexOf('.');
  const verifier = dot > 0 ? raw.slice(0, dot) : '';
  let meta = {};
  try { meta = JSON.parse(Buffer.from(raw.slice(dot + 1), 'base64url').toString('utf8')) || {}; } catch (_) { meta = {}; }
  if (!/^[A-Za-z0-9_-]{43}$/.test(verifier)) return navigateError(res, 'failed');

  try {
    const r = await sb.auth.exchangePkce(code, verifier);
    if (!r.ok || !r.data || !r.data.access_token || !r.data.refresh_token) return navigateError(res, 'failed');
    session.setSessionCookies(req, res, r.data, { remember: meta.r === true });
    return navigate(res, safeNext(meta.n));
  } catch (err) {
    return navigateError(res, 'failed');
  }
});

// =====================================================================================
// QUÊN MẬT KHẨU + HỒ SƠ
// =====================================================================================
// Luồng: /forgot (gửi email) -> người dùng bấm link trong email, Supabase đưa về Site URL kèm token trong PHẦN FRAGMENT (#...)
// -> giao diện đọc token, XÓA khỏi URL ngay (không rò qua Referer/lịch sử) -> /reset (token + mật khẩu mới).
// /forgot luôn trả cùng một thông điệp (không dò được email nào có tài khoản), có PoW + giới hạn/IP để không bị dùng làm cổng spam email.
const forgotLimiter = createLimiter({
  name: 'forgot', windowMs: 60 * 60 * 1000, max: getConfig().auth.signupPerHour,
  message: { error: 'Bạn yêu cầu đặt lại mật khẩu quá nhiều lần. Vui lòng thử lại sau ít giờ.', code: 'forgot_rate_limited' }
});
const resetLimiter = createLimiter({
  name: 'reset', windowMs: 15 * 60 * 1000, max: 10,
  message: { error: 'Bạn thử đặt lại mật khẩu quá nhiều lần. Vui lòng thử lại sau ít phút.', code: 'auth_rate_limited' }
});
const NEUTRAL_FORGOT = 'Nếu email có tài khoản, một liên kết đặt lại mật khẩu đã được gửi. Hãy kiểm tra hộp thư (kể cả thư rác).';
const JWT_SHAPE = /^[\w-]{8,2048}\.[\w-]{8,2048}\.[\w-]{0,2048}$/;

router.post('/forgot', ensureConfigured, ensureOrigin, forgotLimiter, authLimiter, async (req, res) => {
  noStore(res);
  const body = req.body || {};
  const e = session.validateEmail(body.email);
  if (!e.ok) return bad(res, 400, e.message, 'invalid_email');
  if (!(await captchaGate(res, body.turnstileToken))) return;
  const powResult = await pow.verify(body.challenge, body.nonce);
  if (!powResult.ok) return bad(res, 400, 'Xác minh chống lạm dụng không hợp lệ. Vui lòng thử lại.', powResult.code);
  try {
    const r = await sb.auth.recover(e.value, getConfig().auth.redirectUrl || undefined);
    if (r.status >= 500) return bad(res, 503, 'Dịch vụ tạm thời không khả dụng. Vui lòng thử lại sau.', 'auth_unavailable');
    if (r.status === 429) return bad(res, 429, 'Quá nhiều yêu cầu. Vui lòng thử lại sau.', 'auth_rate_limited');
    // Mọi kết quả khác (kể cả email không tồn tại / lỗi nghiệp vụ): cùng một câu trả lời.
    return res.json({ ok: true, status: 'recovery_pending', message: NEUTRAL_FORGOT });
  } catch (err) {
    return bad(res, 503, 'Dịch vụ tạm thời không khả dụng. Vui lòng thử lại sau.', 'auth_unavailable');
  }
});

router.post('/reset', ensureConfigured, ensureOrigin, resetLimiter, async (req, res) => {
  noStore(res);
  const body = req.body || {};
  const token = typeof body.accessToken === 'string' ? body.accessToken.trim() : '';
  if (!JWT_SHAPE.test(token)) return bad(res, 400, 'Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn. Hãy yêu cầu liên kết mới.', 'reset_token_invalid');
  const p = session.validatePassword(body.password);
  if (!p.ok) return bad(res, 400, p.message, 'weak_password');
  if (body.confirmPassword !== undefined && String(body.confirmPassword) !== String(body.password)) {
    return bad(res, 400, 'Mật khẩu xác nhận không khớp.', 'password_mismatch');
  }
  try {
    const r = await sb.auth.updatePassword(token, p.value);
    if (r.status >= 500) return bad(res, 503, 'Dịch vụ tạm thời không khả dụng. Vui lòng thử lại sau.', 'auth_unavailable');
    if (r.status === 401 || r.status === 403) return bad(res, 400, 'Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn. Hãy yêu cầu liên kết mới.', 'reset_token_invalid');
    if (!r.ok) {
      const code = r.data && (r.data.error_code || r.data.code);
      if (code === 'same_password') return bad(res, 400, 'Mật khẩu mới phải khác mật khẩu cũ.', 'same_password');
      if (code === 'weak_password') return bad(res, 400, 'Mật khẩu quá yếu.', 'weak_password');
      return bad(res, 400, 'Không đặt lại được mật khẩu. Vui lòng thử lại.', 'reset_failed');
    }
    session.forgetToken(token);
    return res.json({ ok: true, status: 'password_updated' }); // không tự đăng nhập: người dùng đăng nhập lại bằng mật khẩu mới
  } catch (err) {
    return bad(res, 503, 'Dịch vụ tạm thời không khả dụng. Vui lòng thử lại sau.', 'auth_unavailable');
  }
});

// ---- PATCH /api/auth/profile  (đổi tên hiển thị; chỉ cột display_name, KHÔNG bao giờ role/email) ----
const BAD_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;
const BAD_BIO_CHARS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/; // cho phép xuống dòng (\n)
const PHONE_RE = /^\+?[0-9 ().-]{6,20}$/;                                                                      // khớp CHECK profiles_phone_fmt
router.patch('/profile', requireUser, async (req, res) => {
  noStore(res);
  if (!req.user) return bad(res, 400, 'Xác thực đang tắt.', 'auth_disabled');
  const body = req.body || {};
  const update = {};
  if (body.displayName !== undefined) {
    const raw = body.displayName;
    const name = typeof raw === 'string' ? raw.normalize('NFC').trim().replace(/\s+/g, ' ') : '';
    if (!name || name.length > 60) return bad(res, 400, 'Tên hiển thị cần từ 1 đến 60 ký tự.', 'invalid_display_name');
    if (BAD_NAME_CHARS.test(name)) return bad(res, 400, 'Tên hiển thị chứa ký tự không hợp lệ.', 'invalid_display_name');
    update.display_name = name;
  }
  if (body.bio !== undefined) {
    if (body.bio !== null && typeof body.bio !== 'string') return bad(res, 400, 'Giới thiệu không hợp lệ.', 'invalid_bio');
    const bio = String(body.bio || '').normalize('NFC').replace(/\r\n?/g, '\n').trim();
    if (bio.length > 280 || BAD_BIO_CHARS.test(bio)) return bad(res, 400, 'Giới thiệu tối đa 280 ký tự, không chứa ký tự lạ.', 'invalid_bio');
    update.bio = bio || null;
  }
  if (body.phone !== undefined) {
    if (body.phone !== null && typeof body.phone !== 'string') return bad(res, 400, 'Số điện thoại không hợp lệ.', 'invalid_phone');
    const phone = String(body.phone || '').trim();
    if (phone && !PHONE_RE.test(phone)) return bad(res, 400, 'Số điện thoại không hợp lệ.', 'invalid_phone');
    update.phone = phone || null;
  }
  if (!Object.keys(update).length) return bad(res, 400, 'Không có thông tin nào để lưu.', 'nothing_to_update');
  try {
    const row = await sb.patch('profiles', `id=eq.${encodeURIComponent(req.user.id)}`, Object.assign({}, update, { updated_at: new Date().toISOString() }));
    session.forgetProfile(req.user.id);
    return res.json({ ok: true, displayName: (row && row.display_name) || update.display_name || null, bio: row ? row.bio : (update.bio || null), phone: row ? row.phone : (update.phone || null) });
  } catch (err) {
    return bad(res, 502, 'Không lưu được tên hiển thị. Vui lòng thử lại.', 'profile_save_failed');
  }
});

// ---- GET /api/auth/quota  (số liệu cho UI; SERVER là nguồn sự thật) ----
router.get('/quota', requireUser, async (req, res) => {
  noStore(res);
  if (!req.user) return res.json({ status: 'disabled' }); // AUTH_ENFORCEMENT=off (dev)
  try {
    const s = await quota.status(req.user.id);
    return res.json({
      tokensUsed: s.tokens_used, tokensReserved: s.tokens_reserved, tokenLimit: s.token_limit, remaining: s.remaining,
      status: s.status, cooldownUntil: s.cooldown_until, retryAfterSeconds: s.retry_after_seconds, serverTime: s.server_time
    });
  } catch (err) {
    return bad(res, 503, 'Không đọc được hạn mức sử dụng. Vui lòng thử lại sau.', 'quota_unavailable');
  }
});

// ---- GET /api/auth/usage  (lịch sử token của CHÍNH user, hiển thị trong Hồ sơ -> Sử dụng) ----
const USAGE_HISTORY_LIMIT = 100;
router.get('/usage', requireUser, async (req, res) => {
  noStore(res);
  if (!req.user) return res.json({ status: 'disabled', items: [] });
  try {
    const rows = await sb.select('ai_usage',
      `user_id=eq.${encodeURIComponent(req.user.id)}&status=eq.settled&select=created_at,kind,provider,model,input_tokens,output_tokens,cached_tokens,total_tokens&order=created_at.desc&limit=${USAGE_HISTORY_LIMIT}`);
    return res.json({
      items: rows.map((r) => ({ at: r.created_at, kind: r.kind, provider: r.provider, model: r.model, input: r.input_tokens, output: r.output_tokens, cached: r.cached_tokens, total: r.total_tokens }))
    });
  } catch (err) {
    return bad(res, 503, 'Không đọc được lịch sử sử dụng. Vui lòng thử lại sau.', 'usage_unavailable');
  }
});

// ---- POST /api/auth/password  (đổi mật khẩu khi đang đăng nhập; PHẢI nhập đúng mật khẩu hiện tại) ----
// Lỗi "mật khẩu hiện tại sai" trả 400 (KHÔNG 401) để giao diện không nhầm là phiên hết hạn.
router.post('/password', ensureConfigured, ensureOrigin, authLimiter, requireUser, async (req, res) => {
  noStore(res);
  if (!req.user) return bad(res, 400, 'Xác thực đang tắt.', 'auth_disabled');
  const body = req.body || {};
  const providers = Array.isArray(req.user.providers) ? req.user.providers : null;
  if (providers && !providers.includes('email')) {
    return bad(res, 400, 'Tài khoản này đăng nhập bằng Google và chưa có mật khẩu. Dùng "Quên mật khẩu" để đặt mật khẩu.', 'no_password_account');
  }
  const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  if (!current || !req.user.email) return bad(res, 400, 'Vui lòng nhập mật khẩu hiện tại.', 'invalid_current_password');
  const p = session.validatePassword(body.newPassword, req.user.email);
  if (!p.ok) return bad(res, 400, p.message, 'weak_password');
  if (body.confirmPassword !== undefined && String(body.confirmPassword) !== String(body.newPassword)) {
    return bad(res, 400, 'Mật khẩu xác nhận không khớp.', 'password_mismatch');
  }
  if (current === p.value) return bad(res, 400, 'Mật khẩu mới phải khác mật khẩu hiện tại.', 'same_password');
  const at = session.parseCookies(req.headers.cookie)[session.AT];
  if (!at) return bad(res, 401, 'Phiên đăng nhập đã hết hạn.', 'unauthenticated');
  try {
    const check = await sb.auth.signInWithPassword(req.user.email, current);
    if (!check.ok) return bad(res, 400, 'Mật khẩu hiện tại không đúng.', 'invalid_current_password');
    const r = await sb.auth.updatePassword(at, p.value);
    if (!r.ok) {
      const msg = String((r.data && (r.data.msg || r.data.message || r.data.error_description)) || '');
      if (/same|different from the old/i.test(msg)) return bad(res, 400, 'Mật khẩu mới phải khác mật khẩu hiện tại.', 'same_password');
      if (r.status === 422) return bad(res, 400, 'Mật khẩu mới chưa đủ mạnh hoặc bị từ chối.', 'weak_password');
      return bad(res, 502, 'Không đổi được mật khẩu. Vui lòng thử lại.', 'password_change_failed');
    }
    return res.json({ ok: true });
  } catch (err) {
    return bad(res, 503, 'Dịch vụ tạm thời không khả dụng. Vui lòng thử lại sau.', 'auth_unavailable');
  }
});

// ---- POST /api/auth/logout-all  (đăng xuất mọi thiết bị; thu hồi phía Supabase là best-effort) ----
router.post('/logout-all', ensureOrigin, requireUser, async (req, res) => {
  noStore(res);
  const at = session.parseCookies(req.headers.cookie)[session.AT];
  session.clearSessionCookies(req, res); // xoá cookie trước: dù GoTrue lỗi, trình duyệt này đã đăng xuất
  let revoked = false;
  if (at && getConfig().supabase.configured) {
    session.forgetToken(at);
    try { revoked = (await sb.auth.signOutAll(at)).ok === true; } catch (_) { revoked = false; }
  }
  return res.json({ ok: true, status: 'unauthenticated', revoked });
});

module.exports = router;
