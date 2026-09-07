'use strict';

// ---------- PHẦN 17/20: CACHE cho /api/recommend — tách riêng khỏi recommend.js (không phụ thuộc
// express) để có thể unit-test trực tiếp bằng require() thuần, không cần cài node_modules. ----------
// "CACHE BEFORE CALL" (nguyên tắc #1): cache hit trả thẳng, KHÔNG gọi AI. Cache key gồm mọi field
// ảnh hưởng output (mục 20) — hiện tại route chỉ nhận `query` nên key = normalized query + prompt
// version (đổi prompt tự invalidate cache cũ, không trả nhầm kết quả của prompt phiên bản khác).

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 phút — nội dung gợi ý ôn tập ít thay đổi theo giờ
const MAX_CACHE_ENTRIES = 500; // chặn trần đơn giản, tránh Map phình vô hạn (tần suất gọi thấp)

function createRecommendCache({ ttlMs = DEFAULT_TTL_MS, promptVersion = 'recommend-v1', maxEntries = MAX_CACHE_ENTRIES } = {}) {
  const store = new Map();

  function normalize(query) {
    return String(query || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function keyFor(query) {
    return `${promptVersion}::${normalize(query)}`;
  }

  function get(query) {
    const key = keyFor(query);
    const entry = store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) { store.delete(key); return null; }
    return entry.value;
  }

  function set(query, value) {
    const key = keyFor(query);
    store.set(key, { value, expiresAt: Date.now() + ttlMs });
    if (store.size > maxEntries) {
      const oldestKey = store.keys().next().value;
      store.delete(oldestKey);
    }
  }

  function size() { return store.size; }
  function clear() { store.clear(); }

  return { get, set, size, clear, normalize, keyFor };
}

module.exports = { createRecommendCache };
