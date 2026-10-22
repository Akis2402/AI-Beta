'use strict';
// Cloudflare Turnstile — xác minh token PHÍA SERVER qua siteverify.
// Site key (công khai) nằm ở public/auth.html (data-sitekey). SECRET KEY chỉ nằm ở biến môi trường TURNSTILE_SECRET_KEY,
// KHÔNG bao giờ vào repo/frontend. Chưa đặt secret => bỏ qua xác minh (môi trường dev/CI không bị khoá); ĐÃ đặt secret => bắt buộc,
// fail-closed (không có token hợp lệ thì từ chối; Cloudflare không phản hồi cũng từ chối với mã riêng để UI báo "thử lại sau").
// Test không cần mạng: dùng secret thử của Cloudflare (1x0000000000000000000000000000000AA luôn đạt, 2x...AA luôn trượt).

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TOKEN_RE = /^[\w.-]{1,2048}$/; // token Turnstile tối đa 2048 ký tự, ký tự URL-safe
const TIMEOUT_MS = 5000;
const EXPECTED_ACTION = 'auth'; // khớp data-action ở auth.html: token tạo cho form khác bị từ chối

function secret() { return String(process.env.TURNSTILE_SECRET_KEY || '').trim(); }
function enabled() { return secret().length > 0; }

/**
 * @returns {Promise<{ok:boolean, skipped?:boolean, unavailable?:boolean, code?:string}>}
 *   unavailable=true: lỗi phía Cloudflare/mạng (không phải lỗi của người dùng).
 */
async function verify(token) {
  if (!enabled()) return { ok: true, skipped: true };
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return { ok: false, code: 'missing-input-response' };

  const body = new URLSearchParams({ secret: secret(), response: token });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(VERIFY_URL, { method: 'POST', body, signal: ctrl.signal });
    if (!res.ok) return { ok: false, unavailable: true, code: `http_${res.status}` };
    const data = await res.json();
    if (data && data.success === true) {
      if (data.action && data.action !== EXPECTED_ACTION) return { ok: false, code: 'action_mismatch' };
      return { ok: true };
    }
    const codes = data && Array.isArray(data['error-codes']) ? data['error-codes'] : [];
    // internal-error = lỗi phía Cloudflare, không phải token xấu.
    return { ok: false, unavailable: codes.includes('internal-error'), code: codes.join(',') || 'failed' };
  } catch (_) {
    return { ok: false, unavailable: true, code: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { verify, enabled, EXPECTED_ACTION };
