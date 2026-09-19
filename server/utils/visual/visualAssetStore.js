'use strict';

// ============================================================================================
// PHẦN B (P0) — KHÔNG NHỒI ẢNH BASE64 VÀO RESPONSE JSON/SSE
// ============================================================================================
// ROOT CAUSE: pipeline hình ảnh trả `format:'data_url'` với `data:image/png;base64,...` NGUYÊN VĂN
// trong response JSON (và trong event SSE `done`). Một ảnh PNG 1024x1024 thực tế 1–3MB -> base64
// ~1.33x -> chỉ cần 2 hình là response vượt trần 4.5MB của Vercel. Khi vượt, nền tảng cắt response;
// người dùng thấy "đang tạo hình..." rồi không bao giờ có gì hiện ra — thất bại IM LẶNG.
//
// CÁCH SỬA: response chỉ mang THAM CHIẾU (`/api/visual/asset/<id>`), byte ảnh nằm ở store; client
// tải ảnh bằng 1 request riêng, KHÔNG tính vào trần response của /api/chat.
//
// Store bền vững = KV (cross-instance THẬT). Không cấu hình KV -> vẫn có L1 trong process cho môi
// trường 1 tiến trình (local/VPS), nhưng `durable:false` được trả về cho caller và caller PHẢI xử lý
// tường minh: trên nhiều instance, ảnh lớn bị TỪ CHỐI kèm lý do rõ ràng thay vì trả một link chắc
// chắn 404 ở instance khác.

const kv = require('../kvStore');

const TTL_SEC = Number(process.env.VISUAL_ASSET_TTL_SEC) || 900; // 15 phút: đủ để xem/tải, không phải lưu trữ
const MAX_ASSET_BYTES = Number(process.env.VISUAL_ASSET_MAX_BYTES) || 12 * 1024 * 1024;
const MAX_MEMORY_ENTRIES = Number(process.env.VISUAL_ASSET_MEMORY_MAX) || 20;
const KEY_PREFIX = 'visualasset:v1:';

const memory = new Map(); // id -> {mime, base64, expiresAt}

function pruneMemory(now) {
  for (const [k, v] of memory) if (v.expiresAt <= now) memory.delete(k);
  while (memory.size > MAX_MEMORY_ENTRIES) memory.delete(memory.keys().next().value);
}

/** ID ngẫu nhiên, KHÔNG đoán được, KHÔNG chứa thông tin nào về câu hỏi/lời giải. */
function newId() {
  return require('crypto').randomBytes(16).toString('hex');
}

/**
 * Lưu ảnh, trả về tham chiếu.
 * @param {{mime:string, base64:string}} img
 * @returns {Promise<{ok:boolean, id?:string, url?:string, durable?:boolean, bytes?:number, reason?:string}>}
 */
async function put(img) {
  const mime = String((img && img.mime) || '');
  const base64 = String((img && img.base64) || '');
  if (!mime || !base64) return { ok: false, reason: 'empty_asset' };
  const bytes = Math.floor((base64.replace(/=+$/, '').length * 3) / 4);
  if (bytes > MAX_ASSET_BYTES) return { ok: false, reason: 'asset_too_large' };

  const id = newId();
  const payload = JSON.stringify({ mime, base64 });
  const wrote = await kv.set(KEY_PREFIX + id, payload, TTL_SEC);
  if (!wrote) {
    const now = Date.now();
    pruneMemory(now);
    memory.set(id, { mime, base64, expiresAt: now + TTL_SEC * 1000 });
  }
  return {
    ok: true,
    id,
    url: `/api/visual/asset/${id}`,
    // durable=false nghĩa là: CHỈ instance này đọc lại được. Caller không được coi đây là "đã lưu".
    durable: wrote,
    bytes
  };
}

/** @returns {Promise<{mime:string, buffer:Buffer}|null>} */
async function get(id) {
  const key = String(id || '');
  if (!/^[a-f0-9]{32}$/.test(key)) return null; // id luôn do chính server sinh -> hình dạng cố định
  const raw = await kv.get(KEY_PREFIX + key);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.mime && parsed.base64) {
        return { mime: String(parsed.mime), buffer: Buffer.from(parsed.base64, 'base64') };
      }
    } catch (e) { /* dữ liệu hỏng -> coi như không có */ }
  }
  const hit = memory.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) { memory.delete(key); return null; }
  return { mime: hit.mime, buffer: Buffer.from(hit.base64, 'base64') };
}

/** @returns {boolean} store có bền vững qua nhiều instance hay không (dùng để quyết định hạ cấp). */
function isDurable() { return kv.isEnabled(); }

function _resetForTest() { memory.clear(); }

module.exports = { put, get, isDurable, _resetForTest, TTL_SEC, MAX_ASSET_BYTES, KEY_PREFIX };
