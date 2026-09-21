'use strict';

// ============================================================================================
// MỤC 26/27 — CACHE NỘI DUNG NGUỒN NGOÀI (WEB + YOUTUBE), BỀN QUA NHIỀU REQUEST
// ============================================================================================
// `singleFlight` chống được hai lượt fetch ĐỒNG THỜI cùng một URL, nhưng nó KHÔNG phải cache: hai
// request cách nhau 5 giây vẫn tải lại toàn bộ trang, phân tích lại HTML, rồi gửi lại y nguyên từng
// ấy token cho model. Một bài có nguồn web đi qua Approach -> Detail -> continuation -> cross-check
// là bốn lần tải cùng một trang.
//
// Module này là cache NỘI DUNG ĐÃ TRÍCH (không phải HTML thô):
//
//   key = normalized URL | extractorVersion | contentPolicyVersion
//
// Hai tầng, dùng lại CacheAdapter có sẵn: L1 RAM (luôn có) + L2 KV (nếu môi trường cấu hình).
// L2 là best-effort tuyệt đối — hỏng/chậm thì coi như miss, không bao giờ làm request chính timeout.
//
// TTL theo BẢN CHẤT nội dung, không phải một hằng số:
//   - Trang tĩnh (bài giảng, tài liệu, wiki, PDF-like)  -> TTL dài.
//   - Trang tin/động (có dấu hiệu thời sự, query param thời gian) -> TTL ngắn.
// Kèm `etag`/`lastModified` để lượt sau REVALIDATE bằng request có điều kiện (304 = giữ nguyên bản
// đã có, không tải lại body) thay vì tải lại mù.

const { CacheAdapter } = require('../cache/cacheAdapter');
const kvStore = require('../kvStore');

/** Đổi số này khi luật lọc/chunk đổi — mọi bản cache cũ tự vô hiệu, không cần xoá tay. */
const CONTENT_POLICY_VERSION = 'content-policy-v1';

const TTL_STATIC_MS = Number(process.env.SOURCE_CACHE_STATIC_TTL_MS) || 6 * 3600 * 1000;
const TTL_DYNAMIC_MS = Number(process.env.SOURCE_CACHE_DYNAMIC_TTL_MS) || 10 * 60 * 1000;

/** Dấu hiệu trang có nội dung thay đổi theo thời gian -> cache ngắn. */
const DYNAMIC_HINT_RE = /(\/news\/|\/tin-tuc\/|\/live\/|\/breaking|\?.*\b(date|time|t|ts)=|\/\d{4}\/\d{2}\/\d{2}\/)/i;

/**
 * L2 adapter mỏng bọc kvStore: CacheAdapter chỉ cần {get,set,delete} trả Promise.
 * Trả null khi KV không bật -> CacheAdapter chạy thuần L1 y như trước.
 */
function makeKvL2(namespace) {
  if (!kvStore.isEnabled()) return null;
  return {
    async get(key) {
      const raw = await kvStore.get(`${namespace}:${key}`);
      if (raw == null) return null;
      try { return JSON.parse(raw); } catch (e) { return null; }
    },
    async set(key, value, ttlMs) {
      await kvStore.set(`${namespace}:${key}`, JSON.stringify(value), Math.max(1, Math.round((ttlMs || TTL_STATIC_MS) / 1000)));
    },
    async delete(key) { await kvStore.del(`${namespace}:${key}`); }
  };
}

const adapter = new CacheAdapter({ maxEntries: 300, defaultTtlMs: TTL_STATIC_MS });
adapter.setL2(makeKvL2('srccache'));

/** @returns {boolean} L2 có thật sự được nối hay không — KHÔNG tuyên bố suông (mục 28). */
function hasPersistentLayer() { return adapter.hasL2(); }

function keyOf({ url, extractorVersion, extra }) {
  return [String(url || ''), String(extractorVersion || ''), CONTENT_POLICY_VERSION, String(extra || '')].join('|');
}

/** @returns {number} TTL hợp lý cho chính URL này. */
function ttlFor(url) {
  return DYNAMIC_HINT_RE.test(String(url || '')) ? TTL_DYNAMIC_MS : TTL_STATIC_MS;
}

/**
 * @returns {Promise<object|null>} bản ghi đã cache {value, etag, lastModified, storedAt} hoặc null.
 */
async function get(parts) {
  try { return await adapter.getAsync(keyOf(parts)); } catch (e) { return null; }
}

/**
 * @param {object} parts {url, extractorVersion, extra}
 * @param {object} value nội dung đã trích (KHÔNG phải HTML thô)
 * @param {{etag?:string, lastModified?:string}} [validators]
 */
async function set(parts, value, validators = {}) {
  const record = {
    value,
    etag: validators.etag || null,
    lastModified: validators.lastModified || null,
    storedAt: Date.now()
  };
  try { await adapter.setAsync(keyOf(parts), record, ttlFor(parts.url)); } catch (e) { /* best-effort */ }
  return record;
}

/** Header revalidate cho lượt fetch tiếp theo — rỗng nếu chưa có validator nào. */
function conditionalHeaders(record) {
  if (!record) return {};
  const headers = {};
  if (record.etag) headers['If-None-Match'] = record.etag;
  if (record.lastModified) headers['If-Modified-Since'] = record.lastModified;
  return headers;
}

function stats() {
  return { ...adapter.stats(), contentPolicyVersion: CONTENT_POLICY_VERSION, persistent: hasPersistentLayer() };
}

function _resetForTest() { adapter.clear(); }

module.exports = {
  get, set, conditionalHeaders, hasPersistentLayer, stats, ttlFor, keyOf,
  CONTENT_POLICY_VERSION, TTL_STATIC_MS, TTL_DYNAMIC_MS, _resetForTest
};
