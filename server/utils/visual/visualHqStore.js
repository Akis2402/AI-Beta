'use strict';

// ============================================================================================
// MỤC 2.2 / PHẦN H — NGỮ CẢNH CHO "TẢI CHẤT LƯỢNG CAO" VÀ "THỬ TẠO LẠI"
// ============================================================================================
// Lưu tối thiểu: KHÔNG lưu câu hỏi, KHÔNG lưu lời giải, KHÔNG lưu số liệu — chỉ prompt ảnh (vốn đã
// không còn số), necessity, subject, title, type.
//
// PHẦN H (sửa lỗi P1): bản cũ dùng `new Map()` trong process làm NGUỒN SỰ THẬT. Trên Vercel, nút
// "Thử tạo lại"/"Tải chất lượng cao" gần như luôn rơi vào instance KHÁC với instance đã sinh hình,
// nên tính năng hỏng ngẫu nhiên và người dùng chỉ thấy "hình đã hết hạn" vô cớ.
//
// NAY: KV dùng chung (cross-instance THẬT) khi được cấu hình; process memory chỉ còn là tầng đệm
// L1/fallback cho môi trường 1 tiến trình. `isDurable()` nói thật về việc đó — không nơi nào trong
// code được phép tuyên bố "reliable" khi KV tắt.
//
// API chuyển sang BẤT ĐỒNG BỘ (remember/get trả Promise) vì KV là I/O; mọi call-site đã await.

const kv = require('../kvStore');

const MAX_ENTRIES = Number(process.env.VISUAL_HQ_MAX) || 50;
const TTL_MS = Number(process.env.VISUAL_HQ_TTL_MS) || 15 * 60 * 1000;
const KEY_PREFIX = 'visualhq:v1:';

const store = new Map();

function prune(now) {
  for (const [k, v] of store) if (v.expiresAt <= now) store.delete(k);
  while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value);
}

function shape(ctx) {
  return {
    prompt: String(ctx.prompt),
    necessity: String(ctx.necessity || 'NONE'),
    subject: String(ctx.subject || ''),
    title: String(ctx.title || ''),
    type: String(ctx.type || '')
  };
}

/**
 * remember() — ghi ngữ cảnh của 1 hình vừa sinh (thành công HOẶC thất bại — nút "Thử tạo lại" cần
 * đúng prompt đó mà không phải dựng lại lời giải).
 * @returns {Promise<{stored:boolean, durable:boolean}>}
 */
async function remember(visualId, ctx) {
  if (!visualId || !ctx || !ctx.prompt) return { stored: false, durable: false };
  const now = Date.now();
  prune(now);
  const value = shape(ctx);
  store.set(String(visualId), { ...value, expiresAt: now + TTL_MS });
  const durable = await kv.set(KEY_PREFIX + String(visualId), JSON.stringify(value), Math.ceil(TTL_MS / 1000));
  return { stored: true, durable };
}

/** @returns {Promise<{prompt:string, necessity:string, subject:string, title:string, type:string}|null>} */
async function get(visualId) {
  const id = String(visualId || '');
  if (!id) return null;
  const hit = store.get(id);
  if (hit && hit.expiresAt > Date.now()) {
    return { prompt: hit.prompt, necessity: hit.necessity, subject: hit.subject, title: hit.title || '', type: hit.type || '' };
  }
  if (hit) store.delete(id);
  const raw = await kv.get(KEY_PREFIX + id);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.prompt) return null;
    // Nạp ngược lên L1 để các lượt sau trong cùng instance không phải đi mạng.
    store.set(id, { ...shape(parsed), expiresAt: Date.now() + TTL_MS });
    return shape(parsed);
  } catch (e) {
    return null;
  }
}

/** Trạng thái THẬT của store — dùng cho /api/visual/status và thông báo hạ cấp tường minh. */
function isDurable() { return kv.isEnabled(); }

function _resetForTest() { store.clear(); }

module.exports = { remember, get, isDurable, _resetForTest, MAX_ENTRIES, TTL_MS, KEY_PREFIX };
