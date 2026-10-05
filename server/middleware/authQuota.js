'use strict';

// ============================================================================================
// CỔNG XÁC THỰC + QUOTA CHO MỌI ROUTE GỌI AI
// ============================================================================================
// Hai middleware, đặt đúng thứ tự trong server/app.js:
//
//   limiter -> requireUser -> bodyParser -> reserveQuota(kind) -> router
//
//   requireUser     : TRƯỚC body-parser. Người chưa đăng nhập bị chặn trước khi server phải parse
//                     tới 4MB JSON. Kiểm tra Origin cho request ghi (chống CSRF bổ sung ngoài SameSite=Lax).
//   reserveQuota    : SAU body-parser. (1) đặt chỗ token NGUYÊN TỬ trong Postgres (ai_reserve) trước khi
//                     gọi model; (2) mở AsyncLocalStorage context để aiProviders ghi usage thật;
//                     (3) khi response kết thúc -> settle theo usage thật, hoặc release nếu provider không tính phí.
//
// Nguyên tắc FAIL-CLOSED: không xác định được user, hoặc không liên lạc được kho quota => KHÔNG gọi model.
// Thời gian cooldown/hết hạn do database quyết định (now() của Postgres), client chỉ hiển thị.

const crypto = require('crypto');
const { getConfig } = require('../utils/quota/config');
const usage = require('../utils/quota/usageContext');
const quota = require('../utils/quota/quotaService');
const session = require('../utils/auth/session');

const ABORT_SETTLE_GRACE_MS = Number(process.env.AI_ABORT_SETTLE_GRACE_MS) || 5000;
const SETTLE_RETRIES = 3;

function logSafe(event, fields) {
  // Không bao giờ log token/cookie/email đầy đủ — chỉ id nội bộ và mã sự kiện.
  try { console.warn(`[quota] ${event} ${JSON.stringify(fields)}`); } catch (_) { /* ignore */ }
}

const configuredOrigins = () => String(process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // cùng-origin không gửi Origin cho một số request; SameSite=Lax vẫn bảo vệ
  if (configuredOrigins().includes(origin)) return true;
  try {
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    return new URL(origin).host === host;
  } catch (_) { return false; }
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function fmtMmSs(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function deny(res, status, body, retryAfter) {
  if (retryAfter) res.setHeader('Retry-After', String(Math.max(1, Math.round(retryAfter))));
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json({ retryable: false, ...body });
}

// ------------------------------------------------------------------------------------------
async function requireUser(req, res, next) {
  const cfg = getConfig();
  if (!cfg.enforcement) return next();
  if (req.method === 'OPTIONS') return next();
  if (!cfg.supabase.configured) {
    return deny(res, 503, { error: 'Máy chủ chưa cấu hình đăng nhập (Supabase). Vui lòng liên hệ quản trị viên.', code: 'auth_not_configured' });
  }
  if (WRITE_METHODS.has(req.method) && !originAllowed(req)) {
    return deny(res, 403, { error: 'Yêu cầu bị từ chối do nguồn gốc không hợp lệ.', code: 'bad_origin' });
  }
  const s = await session.resolveSession(req, res);
  if (s.status === 'authenticated') { req.user = s.user; return next(); }
  if (s.status === 'unavailable') {
    return deny(res, 503, { error: 'Dịch vụ đăng nhập tạm thời không khả dụng. Vui lòng thử lại sau.', code: 'auth_unavailable' }, 5);
  }
  return deny(res, 401, {
    error: s.status === 'expired' ? 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.' : 'Bạn cần đăng nhập để dùng tính năng AI.',
    code: s.status === 'expired' ? 'session_expired' : 'auth_required'
  });
}

// ------------------------------------------------------------------------------------------
function reserveQuota(kind) {
  return async function reserveQuotaMiddleware(req, res, next) {
    const cfg = getConfig();
    if (!cfg.enforcement) return next();
    if (!WRITE_METHODS.has(req.method)) return next(); // GET/HEAD/OPTIONS không gọi model
    if (!req.user) {
      // Lập trình sai thứ tự middleware -> chặn thay vì để lọt (fail-closed).
      return deny(res, 500, { error: 'Cấu hình máy chủ không hợp lệ (thiếu xác thực).', code: 'auth_misordered' });
    }

    const q = cfg.quota;
    let estimate = q.reserve[kind] || q.reserve.chat;
    if (req.body && (req.body.deep === true || req.body.deepThinking === true)) estimate = Math.min(estimate * 2, 200000);
    const requestId = crypto.randomUUID();

    let r;
    try {
      r = await quota.reserve({ userId: req.user.id, requestId, kind, estimate });
    } catch (e) {
      logSafe('reserve_failed', { code: e && e.code, status: e && e.status });
      return deny(res, 503, { error: 'Không kiểm tra được hạn mức sử dụng. Vui lòng thử lại sau.', code: 'quota_unavailable' }, 5);
    }

    if (!r || r.ok !== true) {
      const code = (r && r.code) || 'quota_denied';
      const retry = Number(r && r.retry_after_seconds) || 0;
      if (code === 'cooldown_active') {
        return deny(res, 429, {
          error: `Bạn đã đạt giới hạn sử dụng AI. Vui lòng chờ ${fmtMmSs(retry)} trước khi tiếp tục.`,
          code: 'quota_cooldown', retryAfterSeconds: retry, cooldownUntil: r.cooldown_until || null,
          tokensUsed: r.tokens_used, tokenLimit: r.token_limit
        }, retry);
      }
      if (code === 'too_many_concurrent') {
        return deny(res, 429, { error: 'Bạn đang có quá nhiều yêu cầu AI chạy cùng lúc. Hãy đợi một yêu cầu xong rồi gửi tiếp.', code: 'ai_concurrency_limit', retryAfterSeconds: retry || 3 }, retry || 3);
      }
      if (code === 'quota_busy') {
        return deny(res, 429, { error: 'Hạn mức sắp hết và đang có yêu cầu khác xử lý. Vui lòng thử lại sau vài giây.', code: 'quota_busy', retryAfterSeconds: retry || 5 }, retry || 5);
      }
      return deny(res, 429, { error: 'Yêu cầu bị từ chối do hạn mức sử dụng.', code }, retry);
    }

    if (r.duplicate) {
      return deny(res, 409, { error: 'Yêu cầu trùng lặp.', code: 'duplicate_request' });
    }

    const ctx = usage.createContext({ userId: req.user.id, requestId, kind, granted: Number(r.granted) || estimate });
    req.aiRequestId = requestId;

    let finished = false;
    // Giữ function serverless SỐNG tới khi settle xong (Vercel có thể freeze ngay sau khi response kết thúc). Đăng ký
    // NGAY lúc đặt chỗ (còn trong phạm vi request) thay vì lúc settle (có thể đã ngoài phạm vi). Bridge hiện thực
    // req.waitUntil qua after() của Next; chạy thuần Express (test/dev) thì không có -> bỏ qua.
    let markDone = () => {};
    if (typeof req.waitUntil === 'function') {
      req.waitUntil(new Promise((resolve) => { markDone = resolve; }));
    }
    const finalize = (aborted) => {
      if (finished) return;
      finished = true;
      finalizeRequest(ctx, res, aborted)
        .catch((e) => logSafe('finalize_error', { requestId, msg: e && e.message }))
        .finally(() => markDone());
    };
    res.once('finish', () => finalize(false));
    res.once('close', () => {
      if (finished) return;
      if (res.writableEnded || res.finished) return finalize(false);
      // Client ngắt giữa chừng: đợi một nhịp ngắn cho các lượt provider còn đang bay ghi nốt usage.
      setTimeout(() => finalize(true), ABORT_SETTLE_GRACE_MS).unref();
    });

    return usage.run(ctx, () => next());
  };
}

async function withRetry(fn) {
  let lastErr;
  for (let i = 0; i < SETTLE_RETRIES; i += 1) {
    try { return await fn(); } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 250 * (i + 1))); }
  }
  throw lastErr;
}

async function finalizeRequest(ctx, res, aborted) {
  ctx.settled = true; // chặn ghi usage muộn vào ctx đã chốt
  const metered = ctx.meteredAttempts > 0;
  const errorLike = aborted || (res.statusCode || 200) >= 400;

  let release = false;
  let total = 0;
  if (metered) {
    total = usage.chargeableTokens(ctx); // provider ĐÃ tính phí => luôn ghi theo usage thực, kể cả khi response lỗi
  } else if (errorLike) {
    release = true;
  } else if (ctx.attempts === 0) {
    release = true; // không gọi provider nào (cache hit, hoặc route không dùng AI như /source/web) => không tốn token
  } else if (ctx.estimatedOutput === 0) {
    release = true; // có gọi provider nhưng mọi lượt đều lỗi/rỗng => không tính phí
  } else {
    total = ctx.granted; // route/provider không báo usage: tính bảo thủ theo mức đã đặt chỗ
  }

  if (release) {
    await withRetry(() => quota.release({ userId: ctx.userId, requestId: ctx.requestId }));
    return;
  }
  await withRetry(() => quota.settle({
    userId: ctx.userId, requestId: ctx.requestId,
    input: ctx.input, output: ctx.output + ctx.reasoning, cached: ctx.cached,
    total, provider: ctx.provider, model: ctx.model
  }));
}

module.exports = { requireUser, reserveQuota, originAllowed, fmtMmSs, finalizeRequest };
