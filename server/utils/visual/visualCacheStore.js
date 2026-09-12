'use strict';

// ============================================================================================
// A5 — VISUAL CACHE STORE: cache hình phải SỐNG ĐƯỢC qua nhiều serverless instance
// ============================================================================================
// NGUYÊN NHÂN GỐC (đã xác nhận): visualCache.js dùng `new Map()` trong biến module — sống trong RAM
// của ĐÚNG 1 tiến trình. Trên Vercel (đã có vercel.json), mỗi cold start/instance là một Map RỖNG,
// nên cache-hit rate THẬT trên production gần 0% dù logic dedupe (answerStructureHash/buildKey) rất
// kỹ. Đây là lỗi ở TẦNG HẠ TẦNG, không phải tầng logic — chính lớp vấn đề mà rotationStore.js đã
// nhận ra và sửa cho rotation state, nhưng chưa áp dụng cho visual cache.
//
// Module này tái dùng ĐÚNG pattern của rotationStore.js:
//   - KHÔNG cấu hình gì -> driver in-memory, hành vi y hệt bản cũ, không log ồn, không lỗi.
//   - Có cấu hình -> driver REST tương thích Upstash Redis / Vercel KV (GET/SET + Bearer token),
//     dùng `fetch` có sẵn của Node 18+, KHÔNG thêm dependency.
//
// Cấu hình (.env) — ưu tiên biến RIÊNG, nếu không có thì DÙNG LẠI hạ tầng key-value của rotation
// (cùng một Redis, không phải dựng thêm gì):
//   VISUAL_CACHE_STORE_URL   / ROTATION_STORE_URL
//   VISUAL_CACHE_STORE_TOKEN / ROTATION_STORE_TOKEN
//   VISUAL_CACHE_STORE_PREFIX  (mặc định 'aivisual:v1')
//
// HỢP ĐỒNG BẤT BIẾN: store lỗi/timeout -> fallback in-memory hoặc cache-miss ÊM. Không bao giờ
// throw, không bao giờ làm chậm/hỏng visual pipeline, và tuyệt đối không block text answer.

const MAX_ENTRIES = Number(process.env.VISUAL_CACHE_MAX) || 200;
const TTL_MS = Number(process.env.VISUAL_CACHE_TTL_MS) || 6 * 60 * 60 * 1000;
const PREFIX = process.env.VISUAL_CACHE_STORE_PREFIX || 'aivisual:v1';
const FETCH_TIMEOUT_MS = Number(process.env.VISUAL_CACHE_STORE_TIMEOUT_MS) || 1200;

function storeUrl() {
  return String(process.env.VISUAL_CACHE_STORE_URL || process.env.ROTATION_STORE_URL || '').replace(/\/+$/, '');
}
function storeToken() {
  return process.env.VISUAL_CACHE_STORE_TOKEN || process.env.ROTATION_STORE_TOKEN || '';
}
function isEnabled() {
  return Boolean(storeUrl() && storeToken());
}

// ---------- Driver mặc định: in-memory LRU + TTL (y hệt hành vi cũ của visualCache.js) ----------
const memory = new Map(); // key -> {value, expiresAt}
const stats = { externalHits: 0, externalMisses: 0, externalWrites: 0, errors: 0, lastError: null };

function memGet(key) {
  const hit = memory.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) { memory.delete(key); return null; }
  memory.delete(key); memory.set(key, hit); // LRU touch
  return hit.value;
}

function memSet(key, value, ttlMs = TTL_MS) {
  if (memory.size >= MAX_ENTRIES) {
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }
  memory.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function memSize() { return memory.size; }
function memClear() { memory.clear(); }

// ---------- Driver ngoài: REST (Upstash/Vercel KV compatible) ----------
// `_driverForTest` cho phép test bơm 1 driver giả (mô phỏng 2 serverless instance dùng chung store)
// mà không cần mạng — đúng khuôn test/rotation-store-driver.test.js đã có cho rotation.
let injectedDriver = null;
function _setDriverForTest(driver) { injectedDriver = driver; }

async function restFetch(pathParts, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `${storeUrl()}/${pathParts.map(encodeURIComponent).join('/')}`;
    const res = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${storeToken()}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : body,
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`visual store HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function activeDriver() {
  if (injectedDriver) return injectedDriver;
  if (!isEnabled()) return null;
  return {
    async get(key) {
      const json = await restFetch(['get', `${PREFIX}:${key}`]);
      const raw = json && json.result;
      if (!raw) return null;
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    },
    async set(key, value, ttlSec) {
      await restFetch(['set', `${PREFIX}:${key}`, 'EX', String(ttlSec)], JSON.stringify(value));
    }
  };
}

/**
 * get() — in-memory TRƯỚC (0 latency), miss mới hỏi store ngoài. Store ngoài trả về thì nạp ngược
 * vào in-memory để các lượt sau trong CÙNG instance không phải đi mạng nữa.
 * @returns {Promise<object|null>}
 */
async function get(key) {
  const local = memGet(key);
  if (local) return local;
  const driver = activeDriver();
  if (!driver) return null;
  try {
    const value = await driver.get(key);
    if (!value) { stats.externalMisses++; return null; }
    stats.externalHits++;
    memSet(key, value);
    return value;
  } catch (e) {
    // Store lỗi = cache MISS êm. Không bao giờ để lỗi hạ tầng cache làm hỏng pipeline hình.
    stats.errors++; stats.lastError = e && e.message;
    return null;
  }
}

/**
 * set() — ghi in-memory NGAY (đồng bộ, không thể fail) rồi ghi store ngoài. Lỗi ghi ngoài bị nuốt.
 * @returns {Promise<boolean>} true nếu đã ghi được ít nhất vào in-memory.
 */
async function set(key, value, ttlMs = TTL_MS) {
  memSet(key, value, ttlMs);
  const driver = activeDriver();
  if (!driver) return true;
  try {
    await driver.set(key, value, Math.max(1, Math.round(ttlMs / 1000)));
    stats.externalWrites++;
  } catch (e) {
    stats.errors++; stats.lastError = e && e.message;
  }
  return true;
}

/** Đường ĐỒNG BỘ, chỉ chạm in-memory — giữ API cũ của visualCache.get/set không đổi. */
function getSync(key) { return memGet(key); }
function setSync(key, value, ttlMs = TTL_MS) { memSet(key, value, ttlMs); return true; }

function snapshot() {
  return { enabled: isEnabled() || !!injectedDriver, size: memSize(), ...stats };
}

function _resetForTest() {
  memClear();
  injectedDriver = null;
  stats.externalHits = stats.externalMisses = stats.externalWrites = stats.errors = 0;
  stats.lastError = null;
}

module.exports = {
  get, set, getSync, setSync, isEnabled, snapshot,
  _setDriverForTest, _resetForTest, MAX_ENTRIES, TTL_MS
};
