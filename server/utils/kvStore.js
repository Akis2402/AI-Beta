'use strict';

// ============================================================================================
// PHẦN H/I/J — KV DÙNG CHUNG CHO TRẠNG THÁI PHẢI SỐNG QUA NHIỀU SERVERLESS INSTANCE
// ============================================================================================
// Vấn đề gốc: `new Map()` trong process là đúng cho 1 server chạy dài, SAI trên Vercel — mỗi
// request có thể rơi vào instance khác, nên "lưu rồi đọc lại" thất bại ngẫu nhiên. Nguy hiểm nhất
// là khi code vẫn CHẠY được (fallback im lặng) và người dùng chỉ thấy tính năng "thỉnh thoảng hỏng".
//
// Module này là driver REST tương thích Upstash Redis / Vercel KV (cùng giao thức REST + Bearer),
// dùng `fetch` có sẵn của Node — KHÔNG thêm dependency.
//
// Bật bằng env (theo đúng tên chuẩn Vercel KV, có fallback về tên cũ của rotationStore):
//   KV_REST_API_URL / KV_REST_API_TOKEN
//   (hoặc) ROTATION_STORE_URL / ROTATION_STORE_TOKEN
//
// KHÔNG cấu hình -> isEnabled() = false. Mọi caller PHẢI xử lý trường hợp này TƯỜNG MINH (báo cho
// người dùng / hạ cấp có thông báo), TUYỆT ĐỐI không được giả vờ là mình bền vững.

const STORE_URL = (process.env.KV_REST_API_URL || process.env.ROTATION_STORE_URL || '').replace(/\/+$/, '');
const STORE_TOKEN = process.env.KV_REST_API_TOKEN || process.env.ROTATION_STORE_TOKEN || '';
const FETCH_TIMEOUT_MS = Number(process.env.KV_TIMEOUT_MS) || 2000;

const stats = { gets: 0, sets: 0, dels: 0, incrs: 0, errors: 0, lastError: null };

function isEnabled() {
  return Boolean(STORE_URL && STORE_TOKEN);
}

async function restCall(pathParts, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `${STORE_URL}/${pathParts.map(encodeURIComponent).join('/')}`;
    const res = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${STORE_TOKEN}`, 'Content-Type': 'application/json' },
      body,
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`kv HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** @returns {Promise<string|null>} giá trị chuỗi, null khi không có/không bật/lỗi. */
async function get(key) {
  if (!isEnabled()) return null;
  try {
    const json = await restCall(['get', String(key)]);
    stats.gets += 1;
    const raw = json && json.result;
    return raw == null ? null : String(raw);
  } catch (e) {
    stats.errors += 1; stats.lastError = e && e.message;
    return null;
  }
}

/** @returns {Promise<boolean>} true khi CHẮC CHẮN đã ghi được (caller dùng để quyết định fallback). */
async function set(key, value, ttlSeconds) {
  if (!isEnabled()) return false;
  try {
    const parts = ['set', String(key)];
    if (ttlSeconds) parts.push('EX', String(Math.max(1, Math.floor(ttlSeconds))));
    await restCall(parts, String(value));
    stats.sets += 1;
    return true;
  } catch (e) {
    stats.errors += 1; stats.lastError = e && e.message;
    return false;
  }
}

async function del(key) {
  if (!isEnabled()) return false;
  try {
    await restCall(['del', String(key)]);
    stats.dels += 1;
    return true;
  } catch (e) {
    stats.errors += 1; stats.lastError = e && e.message;
    return false;
  }
}

/**
 * Bộ đếm NGUYÊN TỬ phía store — nền tảng cho rate limit toàn cục (PHẦN J) và fairness rotation.
 * @returns {Promise<number|null>} null khi store tắt/lỗi (caller tự hạ cấp về per-instance).
 */
async function incr(key, ttlSeconds) {
  if (!isEnabled()) return null;
  try {
    const json = await restCall(['incr', String(key)]);
    const n = json && Number(json.result);
    if (!Number.isFinite(n)) return null;
    stats.incrs += 1;
    // Chỉ đặt TTL ở lượt tăng ĐẦU TIÊN — nếu đặt mỗi lượt, cửa sổ rate limit bị kéo dài vô hạn khi
    // có traffic liên tục (bug kinh điển của sliding window làm bằng INCR+EXPIRE).
    if (ttlSeconds && n === 1) {
      await restCall(['expire', String(key), String(Math.max(1, Math.floor(ttlSeconds)))]);
    }
    return n;
  } catch (e) {
    stats.errors += 1; stats.lastError = e && e.message;
    return null;
  }
}

function getStats() {
  return { enabled: isEnabled(), ...stats };
}

module.exports = { isEnabled, get, set, del, incr, getStats };
