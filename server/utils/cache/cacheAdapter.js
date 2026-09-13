'use strict';

// ============================================================================================
// PHẦN C (mục 13) — CACHE ADAPTER: L1 RAM bắt buộc, L2 bền vững TÙY CHỌN
// ============================================================================================
// Hiện trạng trước đây: `globalCache` trong tokenEconomy.js là một `Map` nằm trong process. Điều đó
// hoàn toàn ĐÚNG cho một tiến trình server chạy dài, nhưng SAI trên môi trường serverless (Vercel):
// mỗi lambda instance có Map riêng, nên hit-rate thực tế gần như bằng 0 giữa các request khác
// instance, và không có cách nào cắm một KV store vào mà không phải sửa mọi call-site.
//
// Module này tách CƠ CHẾ LƯU TRỮ khỏi CHÍNH SÁCH CACHE:
//
//   CacheAdapter
//   ├── MemoryL1        (luôn có — đồng bộ, TTL, LRU-ish eviction theo thứ tự chèn)
//   └── Optional L2     (bền vững — bất đồng bộ, cắm vào qua setL2(), best-effort)
//
// Nguyên tắc:
//   - API ĐỒNG BỘ (get/set/delete) được GIỮ NGUYÊN 100% cho mọi call-site cũ; chúng chỉ chạm L1.
//   - L2 chỉ được dùng qua getAsync/setAsync và LUÔN best-effort: L2 lỗi/chậm KHÔNG BAO GIỜ làm hỏng
//     request (bắt mọi lỗi, trả null).
//   - KHÔNG thêm database nặng nào. Nếu dự án không cấu hình L2 thì hệ thống chạy y hệt như trước.
//   - get() sau khi hit L2 sẽ ghi ngược lên L1 (read-through) để lượt sau khỏi phải đi vòng.

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 500;

/** L1: Map trong process. Đồng bộ, có TTL và trần số entry. */
class MemoryL1 {
  constructor({ maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    this.map = new Map();
    this.maxEntries = maxEntries;
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) { this.misses += 1; return null; }
    if (Date.now() > entry.expiresAt) { this.map.delete(key); this.misses += 1; return null; }
    // Refresh vị trí để eviction theo thứ tự chèn hoạt động như LRU thay vì FIFO thuần.
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  set(key, value, ttlMs) {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: Date.now() + (ttlMs || DEFAULT_TTL_MS) });
  }

  delete(key) { return this.map.delete(key); }
  clear() { this.map.clear(); }
  get size() { return this.map.size; }
}

/**
 * CacheAdapter — mặt tiền duy nhất mà phần còn lại của hệ thống nhìn thấy.
 */
class CacheAdapter {
  /**
   * @param {{maxEntries?:number, defaultTtlMs?:number, l2?:object}} [opts]
   *   l2: {get(key):Promise<any|null>, set(key,value,ttlMs):Promise<void>, delete?(key):Promise<void>}
   */
  constructor({ maxEntries = DEFAULT_MAX_ENTRIES, defaultTtlMs = DEFAULT_TTL_MS, l2 = null } = {}) {
    this.l1 = new MemoryL1({ maxEntries });
    this.defaultTtlMs = defaultTtlMs;
    this.l2 = l2;
    this.l2Hits = 0;
    this.l2Errors = 0;
  }

  /** Cắm/gỡ tầng bền vững. Truyền null để tắt (mặc định đã tắt). */
  setL2(adapter) { this.l2 = adapter || null; }
  hasL2() { return !!this.l2; }

  /** Đồng bộ — CHỈ L1. Giữ nguyên hợp đồng cho mọi call-site cũ. */
  get(key) { return this.l1.get(key); }

  /** Đồng bộ — ghi L1; nếu có L2 thì ghi thêm best-effort (fire-and-forget, không await). */
  set(key, value, ttlMs) {
    const ttl = ttlMs || this.defaultTtlMs;
    this.l1.set(key, value, ttl);
    if (this.l2) {
      Promise.resolve()
        .then(() => this.l2.set(key, value, ttl))
        .catch(() => { this.l2Errors += 1; });
    }
  }

  /** L1 trước, rồi L2 (read-through: hit L2 sẽ được ghi ngược lên L1). */
  async getAsync(key) {
    const hot = this.l1.get(key);
    if (hot != null) return hot;
    if (!this.l2) return null;
    try {
      const cold = await this.l2.get(key);
      if (cold != null) {
        this.l2Hits += 1;
        this.l1.set(key, cold, this.defaultTtlMs);
        return cold;
      }
    } catch (e) {
      this.l2Errors += 1; // L2 hỏng KHÔNG BAO GIỜ làm hỏng request — coi như cache miss
    }
    return null;
  }

  /** Ghi cả hai tầng, có await L2 (dùng khi caller thực sự cần biết đã bền vững hay chưa). */
  async setAsync(key, value, ttlMs) {
    const ttl = ttlMs || this.defaultTtlMs;
    this.l1.set(key, value, ttl);
    if (!this.l2) return;
    try { await this.l2.set(key, value, ttl); } catch (e) { this.l2Errors += 1; }
  }

  delete(key) {
    const removed = this.l1.delete(key);
    if (this.l2 && this.l2.delete) {
      Promise.resolve().then(() => this.l2.delete(key)).catch(() => { this.l2Errors += 1; });
    }
    return removed;
  }

  clear() { this.l1.clear(); }

  stats() {
    return {
      size: this.l1.size,
      l1Hits: this.l1.hits,
      l1Misses: this.l1.misses,
      l2Enabled: !!this.l2,
      l2Hits: this.l2Hits,
      l2Errors: this.l2Errors
    };
  }
}

module.exports = { CacheAdapter, MemoryL1, DEFAULT_TTL_MS, DEFAULT_MAX_ENTRIES };
