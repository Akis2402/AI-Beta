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

const MAX_ENTRIES = Number(process.env.VISUAL_CACHE_MAX) || 200;
const TTL_MS = Number(process.env.VISUAL_CACHE_TTL_MS) || 6 * 60 * 60 * 1000;

const store = new Map(); // key -> {value, expiresAt}
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

function get(parts) {
  const key = buildKey(parts);
  const hit = store.get(key);
  if (!hit) { stats.misses++; return null; }
  if (hit.expiresAt < Date.now()) { store.delete(key); stats.misses++; return null; }
  stats.hits++;
  // LRU: chạm lại để đẩy xuống cuối.
  store.delete(key); store.set(key, hit);
  return hit.value;
}

/**
 * set() — CHỈ ghi khi hình đã VALIDATED và câu trả lời đã COMPLETED (PHẦN 22).
 * @returns {boolean} true nếu thực sự được ghi.
 */
function set(parts, value, { validated, answerComplete } = {}) {
  if (!validated || !answerComplete) { stats.rejected++; return false; }
  if (!value || (!value.content && !value.url)) { stats.rejected++; return false; }
  const key = buildKey(parts);
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, { value, expiresAt: Date.now() + TTL_MS });
  stats.writes++;
  return true;
}

function snapshot() {
  const total = stats.hits + stats.misses;
  return { ...stats, size: store.size, hitRate: total ? Number((stats.hits / total).toFixed(3)) : 0 };
}
function _resetForTest() { store.clear(); stats.hits = stats.misses = stats.writes = stats.rejected = 0; }

module.exports = { get, set, buildKey, answerStructureHash, hash, snapshot, _resetForTest, MAX_ENTRIES, TTL_MS };
