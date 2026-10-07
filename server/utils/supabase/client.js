'use strict';

// ============================================================================================
// SUPABASE REST CLIENT TỐI GIẢN (server-side, không thêm dependency)
// ============================================================================================
// Vì sao REST thay vì @supabase/supabase-js / @supabase/ssr:
//   - UI của app là HTML/JS tĩnh (public/) phục vụ qua Express-bridge; không có bundler phía client
//     để nhúng SDK, và đưa anon key + SDK xuống trình duyệt sẽ buộc mở CSP connect-src tới Supabase.
//   - Mô hình đang dùng: trình duyệt CHỈ nói chuyện với server này; server giữ phiên trong cookie
//     httpOnly (tương đương pattern "SSR/cookie" của Supabase) và gọi GoTrue/PostgREST/Storage.
//   - Service-role key CHỈ tồn tại ở đây (server), không bao giờ xuống client, không bao giờ vào log.
//
// Lưu ý header: khoá kiểu mới (sb_publishable_/sb_secret_) KHÔNG phải JWT nên chỉ gửi qua `apikey`;
// chỉ thêm `Authorization: Bearer` khi giá trị trông như JWT (legacy anon/service_role keys).

const { getConfig } = require('../quota/config');

const DEFAULT_TIMEOUT_MS = Number(process.env.SUPABASE_TIMEOUT_MS) || 8000;
let fetchImpl = (...a) => fetch(...a);
function _setFetchForTest(fn) { fetchImpl = fn || ((...a) => fetch(...a)); }

class SupabaseError extends Error {
  constructor(message, { status = 502, code = 'supabase_error', detail } = {}) {
    super(message);
    this.name = 'SupabaseError';
    this.status = status;
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

function looksLikeJwt(k) { return /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/.test(String(k || '')); }

function baseHeaders(apiKey, bearer) {
  const h = { apikey: apiKey };
  const auth = bearer || (looksLikeJwt(apiKey) ? apiKey : null);
  if (auth) h.Authorization = `Bearer ${auth}`;
  return h;
}

async function call(method, path, { apiKey, bearer, body, headers, rawBody, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const cfg = getConfig().supabase;
  if (!cfg.configured) throw new SupabaseError('Supabase chưa được cấu hình.', { status: 503, code: 'supabase_not_configured' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const h = { ...baseHeaders(apiKey, bearer), ...(headers || {}) };
    let payload;
    if (rawBody !== undefined) payload = rawBody;
    else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetchImpl(`${cfg.url}${path}`, { method, headers: h, body: payload, signal: controller.signal });
    return res;
  } catch (e) {
    const aborted = e && e.name === 'AbortError';
    throw new SupabaseError(aborted ? 'Supabase phản hồi quá chậm.' : 'Không kết nối được Supabase.', {
      status: aborted ? 504 : 503, code: aborted ? 'supabase_timeout' : 'supabase_unreachable'
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(res) {
  const text = await res.text().catch(() => '');
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { return { _raw: text.slice(0, 300) }; }
}

// ---------------- Auth (GoTrue) ----------------
const auth = {
  /** @returns {Promise<{ok:boolean,status:number,data:any}>} — không ném với lỗi nghiệp vụ (4xx). */
  async signUp(email, password) {
    const cfg = getConfig().supabase;
    const res = await call('POST', '/auth/v1/signup', { apiKey: cfg.anonKey, body: { email, password } });
    return { ok: res.ok, status: res.status, data: await readJson(res) };
  },
  async signInWithPassword(email, password) {
    const cfg = getConfig().supabase;
    const res = await call('POST', '/auth/v1/token?grant_type=password', { apiKey: cfg.anonKey, body: { email, password } });
    return { ok: res.ok, status: res.status, data: await readJson(res) };
  },
  async refresh(refreshToken) {
    const cfg = getConfig().supabase;
    const res = await call('POST', '/auth/v1/token?grant_type=refresh_token', { apiKey: cfg.anonKey, body: { refresh_token: refreshToken } });
    return { ok: res.ok, status: res.status, data: await readJson(res) };
  },
  /** Xác minh access token với GoTrue (nguồn sự thật: token bị thu hồi/đăng xuất sẽ bị từ chối). */
  async getUser(accessToken) {
    const cfg = getConfig().supabase;
    const res = await call('GET', '/auth/v1/user', { apiKey: cfg.anonKey, bearer: accessToken });
    return { ok: res.ok, status: res.status, data: await readJson(res) };
  },
  async signOut(accessToken) {
    const cfg = getConfig().supabase;
    const res = await call('POST', '/auth/v1/logout?scope=local', { apiKey: cfg.anonKey, bearer: accessToken });
    return { ok: res.ok, status: res.status };
  },
  /** Gửi email đặt lại mật khẩu. GoTrue trả 200 cả khi email không tồn tại (không lộ tài khoản). */
  async recover(email, redirectTo) {
    const cfg = getConfig().supabase;
    const q = redirectTo ? `?redirect_to=${encodeURIComponent(redirectTo)}` : '';
    const res = await call('POST', `/auth/v1/recover${q}`, { apiKey: cfg.anonKey, body: { email } });
    return { ok: res.ok, status: res.status, data: await readJson(res) };
  },
  /** Đổi mật khẩu bằng access token (token khôi phục trong link email). GoTrue xác minh token. */
  async updatePassword(accessToken, password) {
    const cfg = getConfig().supabase;
    const res = await call('PUT', '/auth/v1/user', { apiKey: cfg.anonKey, bearer: accessToken, body: { password } });
    return { ok: res.ok, status: res.status, data: await readJson(res) };
  }
};

// ---------------- Dữ liệu (PostgREST, service role) ----------------
async function rpc(fn, args) {
  const cfg = getConfig().supabase;
  const res = await call('POST', `/rest/v1/rpc/${encodeURIComponent(fn)}`, { apiKey: cfg.serviceKey, body: args || {} });
  const data = await readJson(res);
  if (!res.ok) {
    throw new SupabaseError(`RPC ${fn} thất bại (HTTP ${res.status}).`, { status: 502, code: 'supabase_rpc_failed', detail: data && (data.message || data.hint || data._raw) });
  }
  return data;
}

async function select(table, query) {
  const cfg = getConfig().supabase;
  const res = await call('GET', `/rest/v1/${encodeURIComponent(table)}?${query}`, { apiKey: cfg.serviceKey });
  const data = await readJson(res);
  if (!res.ok) throw new SupabaseError(`Đọc ${table} thất bại (HTTP ${res.status}).`, { code: 'supabase_select_failed', detail: data && (data.message || data._raw) });
  return Array.isArray(data) ? data : [];
}

async function upsert(table, row, onConflict) {
  const cfg = getConfig().supabase;
  const res = await call('POST', `/rest/v1/${encodeURIComponent(table)}?on_conflict=${encodeURIComponent(onConflict)}`, {
    apiKey: cfg.serviceKey, body: row, headers: { Prefer: 'resolution=merge-duplicates,return=representation' }
  });
  const data = await readJson(res);
  if (!res.ok) throw new SupabaseError(`Ghi ${table} thất bại (HTTP ${res.status}).`, { code: 'supabase_upsert_failed', detail: data && (data.message || data._raw) });
  return Array.isArray(data) ? data[0] : data;
}

/** Cập nhật dòng theo bộ lọc PostgREST (service role). Trả dòng đã cập nhật hoặc null. */
async function patch(table, query, body) {
  const cfg = getConfig().supabase;
  const res = await call('PATCH', `/rest/v1/${encodeURIComponent(table)}?${query}`, { apiKey: cfg.serviceKey, body, headers: { Prefer: 'return=representation' } });
  const data = await readJson(res);
  if (!res.ok) throw new SupabaseError(`Cập nhật ${table} thất bại (HTTP ${res.status}).`, { code: 'supabase_patch_failed', detail: data && (data.message || data._raw) });
  return Array.isArray(data) ? (data[0] || null) : data;
}

async function remove(table, query) {
  const cfg = getConfig().supabase;
  const res = await call('DELETE', `/rest/v1/${encodeURIComponent(table)}?${query}`, { apiKey: cfg.serviceKey });
  if (!res.ok) throw new SupabaseError(`Xoá ${table} thất bại (HTTP ${res.status}).`, { code: 'supabase_delete_failed' });
}

// ---------------- Storage (service role) ----------------
const storage = {
  async upload(bucket, objectPath, buffer, contentType) {
    const cfg = getConfig().supabase;
    const res = await call('POST', `/storage/v1/object/${encodeURIComponent(bucket)}/${objectPath.split('/').map(encodeURIComponent).join('/')}`, {
      apiKey: cfg.serviceKey, rawBody: buffer, headers: { 'Content-Type': contentType, 'x-upsert': 'true', 'Cache-Control': 'max-age=31536000' }, timeoutMs: 15000
    });
    if (!res.ok) {
      const d = await readJson(res);
      throw new SupabaseError(`Upload Storage thất bại (HTTP ${res.status}).`, { code: 'supabase_storage_upload_failed', detail: d && (d.message || d.error) });
    }
  },
  /** @returns {Promise<{buffer:Buffer, contentType:string}|null>} null nếu không có. */
  async download(bucket, objectPath) {
    const cfg = getConfig().supabase;
    const res = await call('GET', `/storage/v1/object/${encodeURIComponent(bucket)}/${objectPath.split('/').map(encodeURIComponent).join('/')}`, { apiKey: cfg.serviceKey, timeoutMs: 15000 });
    if (res.status === 404 || res.status === 400) return null;
    if (!res.ok) throw new SupabaseError(`Tải Storage thất bại (HTTP ${res.status}).`, { code: 'supabase_storage_download_failed' });
    const ab = await res.arrayBuffer();
    return { buffer: Buffer.from(ab), contentType: res.headers.get('content-type') || 'application/octet-stream' };
  },
  async remove(bucket, objectPath) {
    const cfg = getConfig().supabase;
    const res = await call('DELETE', `/storage/v1/object/${encodeURIComponent(bucket)}/${objectPath.split('/').map(encodeURIComponent).join('/')}`, { apiKey: cfg.serviceKey });
    if (!res.ok && res.status !== 404) throw new SupabaseError(`Xoá Storage thất bại (HTTP ${res.status}).`, { code: 'supabase_storage_delete_failed' });
  }
};

function isConfigured() { return getConfig().supabase.configured; }

module.exports = { auth, rpc, select, upsert, patch, remove, storage, isConfigured, SupabaseError, _setFetchForTest };
