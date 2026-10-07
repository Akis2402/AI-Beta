'use strict';

// ============================================================================================
// /api/auth/*  — đăng ký / đăng nhập / đăng xuất / trạng thái phiên (Supabase Auth qua server)
// ============================================================================================
// Trình duyệt không bao giờ thấy token hay anon key: server gọi GoTrue và đặt cookie HttpOnly.
// Lỗi trả về KHÔNG làm lộ việc email đã tồn tại hay chưa (chống dò tài khoản): đăng ký luôn trả cùng
// một thông điệp trung tính; đăng nhập sai luôn là "Email hoặc mật khẩu không đúng".

const express = require('express');
const { createLimiter } = require('../middleware/rateLimit');
const { originAllowed, requireUser } = require('../middleware/authQuota');
const { getConfig } = require('../utils/quota/config');
const session = require('../utils/auth/session');
const sb = require('../utils/supabase/client');
const quota = require('../utils/quota/quotaService');
const pow = require('../utils/auth/pow');

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
    user: { id: s.user.id, email: s.user.email, displayName: (profile && profile.display_name) || null, avatarUrl: (profile && profile.avatar_url) || null, role: (profile && profile.role) || 'user' }
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
  // PoW SAU các kiểm tra rẻ: gõ sai email/mật khẩu không đốt challenge của người dùng thật.
  const powResult = await pow.verify(body.challenge, body.nonce);
  if (!powResult.ok) {
    const msg = powResult.code === 'pow_expired' ? 'Phiên xác minh đã hết hạn. Vui lòng thử lại.' : 'Xác minh chống lạm dụng không hợp lệ. Vui lòng thử lại.';
    return bad(res, 400, msg, powResult.code);
  }
  try {
    const r = await sb.auth.signUp(e.value, p.value);
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
router.patch('/profile', requireUser, async (req, res) => {
  noStore(res);
  if (!req.user) return bad(res, 400, 'Xác thực đang tắt.', 'auth_disabled');
  const raw = req.body && req.body.displayName;
  const name = typeof raw === 'string' ? raw.normalize('NFC').trim().replace(/\s+/g, ' ') : '';
  if (!name || name.length > 60) return bad(res, 400, 'Tên hiển thị cần từ 1 đến 60 ký tự.', 'invalid_display_name');
  if (BAD_NAME_CHARS.test(name)) return bad(res, 400, 'Tên hiển thị chứa ký tự không hợp lệ.', 'invalid_display_name');
  try {
    const row = await sb.patch('profiles', `id=eq.${encodeURIComponent(req.user.id)}`, { display_name: name, updated_at: new Date().toISOString() });
    session.forgetProfile(req.user.id);
    return res.json({ ok: true, displayName: (row && row.display_name) || name });
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

module.exports = router;
