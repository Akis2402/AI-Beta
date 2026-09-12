'use strict';

// ============================================================================================
// PHẦN 22/23 — VISUAL CACHE
// ============================================================================================
// Cache key PHẢI phủ đủ mọi thứ ảnh hưởng tới hình, nếu không sẽ trả nhầm hình của bài khác:
//   prompt version · visual spec hash · answer structure hash · subject · language · style ·
//   renderer · model · source/image fingerprint · user preference (PHẦN 27)
//
// KHÔNG cache khi: spec chưa ổn định / answer còn incomplete / spec chưa validate / render fail.
// CHỈ cache khi: VALIDATED + COMPLETED.

const crypto = require('crypto');
// A5: tầng LƯU TRỮ tách hẳn ra visualCacheStore.js (in-memory mặc định, external store khi có cấu
// hình) — TOÀN BỘ logic buildKey/answerStructureHash/TTL/LRU/quality gate ở file này giữ NGUYÊN.
const store = require('./visualCacheStore');

const MAX_ENTRIES = store.MAX_ENTRIES;
const TTL_MS = store.TTL_MS;

const stats = { hits: 0, misses: 0, writes: 0, rejected: 0 };

function hash(obj) {
  return crypto.createHash('sha256').update(typeof obj === 'string' ? obj : JSON.stringify(obj)).digest('hex').slice(0, 32);
}

/**
 * Băm CẤU TRÚC câu trả lời (không phải nội dung thô) — 2 lần giải cùng 1 bài có thể khác câu chữ
 * nhưng cùng cấu trúc/số liệu thì dùng lại được cùng 1 hình.
 */
function answerStructureHash(finalAnswer) {
  const t = String(finalAnswer || '');
  const numbers = (t.match(/-?\d+(?:[.,]\d+)?/g) || []).slice(0, 40).join(',');
  const headings = (t.match(/^#{1,6}\s*.+$/gm) || []).map((h) => h.replace(/\s+/g, ' ').slice(0, 40)).join('|');
  return hash(numbers + '\u0001' + headings);
}

function buildKey(parts) {
  return hash({
    pv: parts.promptVersion || '',
    spec: parts.specFingerprint || '',
    ans: parts.answerStructureHash || '',
    sub: parts.subject || '',
    lang: parts.language || '',
    style: parts.style || '',
    rnd: parts.renderer || '',
    model: parts.model || '',
    src: parts.sourceFingerprint || '',
    img: parts.imageFingerprint || '',
    pref: parts.userPreference || ''
  });
}

/**
 * get() — ĐỒNG BỘ, chỉ tra in-memory. Giữ nguyên chữ ký cũ cho mọi caller/test hiện có.
 */
function get(parts) {
  const value = store.getSync(buildKey(parts));
  if (!value) { stats.misses++; return null; }
  stats.hits++;
  return value;
}

/**
 * getAsync() — A5: tra in-memory TRƯỚC, miss mới hỏi store dùng chung (sống qua nhiều serverless
 * instance). Dùng ở visualPipeline.js (đã async sẵn). Store lỗi -> cache-miss êm, không throw.
 * @returns {Promise<object|null>}
 */
async function getAsync(parts) {
  const value = await store.get(buildKey(parts));
  if (!value) { stats.misses++; return null; }
  stats.hits++;
  return value;
}

/**
 * set() — CHỈ ghi khi hình đã VALIDATED và câu trả lời đã COMPLETED (PHẦN 22).
 * @returns {boolean} true nếu thực sự được ghi.
 */
function acceptable(value, { validated, answerComplete }) {
  if (!validated || !answerComplete) return false;
  if (!value || (!value.content && !value.url)) return false;
  return true;
}

function set(parts, value, opts = {}) {
  if (!acceptable(value, opts)) { stats.rejected++; return false; }
  store.setSync(buildKey(parts), value, TTL_MS);
  stats.writes++;
  return true;
}

/**
 * setAsync() — A5: ghi in-memory NGAY + ghi store dùng chung. Cùng quality gate với set()
 * (VALIDATED + COMPLETED), chỉ khác tầng lưu trữ.
 * @returns {Promise<boolean>}
 */
async function setAsync(parts, value, opts = {}) {
  if (!acceptable(value, opts)) { stats.rejected++; return false; }
  await store.set(buildKey(parts), value, TTL_MS);
  stats.writes++;
  return true;
}

function snapshot() {
  const total = stats.hits + stats.misses;
  const st = store.snapshot();
  return {
    ...stats, size: st.size, storeEnabled: st.enabled,
    storeExternalHits: st.externalHits, storeErrors: st.errors,
    hitRate: total ? Number((stats.hits / total).toFixed(3)) : 0
  };
}
function _resetForTest() {
  store._resetForTest();
  stats.hits = stats.misses = stats.writes = stats.rejected = 0;
}

module.exports = {
  get, getAsync, set, setAsync, buildKey, answerStructureHash, hash, snapshot,
  _resetForTest, MAX_ENTRIES, TTL_MS, store
};
