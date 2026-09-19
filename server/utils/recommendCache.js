'use strict';

// ---------- PHẦN I: PHÂN LOẠI TRẠNG THÁI (bắt buộc theo nguyên tắc #14) ----------
// L1 (Map trong process) = PROCESS-LOCAL, BEST-EFFORT. Đây là tối ưu chi phí, KHÔNG phải nguồn sự
// thật: cache miss chỉ tốn thêm 1 lượt gọi AI, không làm sai kết quả. Trên Vercel nhiều instance,
// hit-rate của riêng L1 thấp — đó là điều BÌNH THƯỜNG, không phải bug, và comment cũ KHÔNG được
// tuyên bố đây là "production cache".
// L2 (KV, tuỳ chọn) = DISTRIBUTED. Bật bằng KV_REST_API_URL/KV_REST_API_TOKEN -> hit-rate cross-
// instance thật. L2 lỗi/chậm -> im lặng bỏ qua, request vẫn chạy (không bao giờ chặn vì cache).
//
// ---------- PHẦN 17/20: CACHE cho /api/recommend — tách riêng khỏi recommend.js (không phụ thuộc
// express) để có thể unit-test trực tiếp bằng require() thuần, không cần cài node_modules. ----------
// "CACHE BEFORE CALL" (nguyên tắc #1): cache hit trả thẳng, KHÔNG gọi AI. Cache key gồm mọi field
// ảnh hưởng output (mục 20) — hiện tại route chỉ nhận `query` nên key = normalized query + prompt
// version (đổi prompt tự invalidate cache cũ, không trả nhầm kết quả của prompt phiên bản khác).

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 phút — nội dung gợi ý ôn tập ít thay đổi theo giờ
const MAX_CACHE_ENTRIES = 500; // chặn trần đơn giản, tránh Map phình vô hạn (tần suất gọi thấp)

function createRecommendCache({ ttlMs = DEFAULT_TTL_MS, promptVersion = 'recommend-v1', maxEntries = MAX_CACHE_ENTRIES, l2 = null } = {}) {
  const store = new Map();
  // L2 mặc định là kvStore nếu được cấu hình; truyền l2:false để tắt hẳn (dùng trong test).
  const level2 = l2 === false ? null : (l2 || require('./kvStore'));

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

  /** L1 -> L2 (read-through). Chỉ dùng ở call-site đã async; API đồng bộ giữ nguyên cho nơi khác. */
  async function getAsync(query) {
    const local = get(query);
    if (local) return local;
    if (!level2 || !level2.isEnabled || !level2.isEnabled()) return null;
    try {
      const raw = await level2.get('recommend:' + keyFor(query));
      if (!raw) return null;
      const value = JSON.parse(raw);
      store.set(keyFor(query), { value, expiresAt: Date.now() + ttlMs }); // nạp ngược lên L1
      return value;
    } catch (e) { return null; }
  }

  async function setAsync(query, value) {
    set(query, value);
    if (!level2 || !level2.isEnabled || !level2.isEnabled()) return false;
    try { return await level2.set('recommend:' + keyFor(query), JSON.stringify(value), Math.ceil(ttlMs / 1000)); }
    catch (e) { return false; }
  }

  function size() { return store.size; }
  function clear() { store.clear(); }
  /** @returns {'L1'|'L1+L2'} tầng cache ĐANG thật sự hoạt động — dùng cho log/health, không đoán. */
  function tiers() { return (level2 && level2.isEnabled && level2.isEnabled()) ? 'L1+L2' : 'L1'; }

  return { get, set, getAsync, setAsync, size, clear, normalize, keyFor, tiers };
}

module.exports = { createRecommendCache };
