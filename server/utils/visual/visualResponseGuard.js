'use strict';

// ============================================================================================
// PHẦN B (P0) — CỔNG DUY NHẤT ĐỂ HÌNH ẢNH ĐI RA RESPONSE
// ============================================================================================
// Mọi nơi trả `visuals[]` (JSON của /api/chat, event SSE `done`, /api/visual/retry, /api/visual/hq)
// PHẢI đi qua đây. Hai việc:
//   1. Ảnh data-URL lớn -> đẩy sang visualAssetStore, response chỉ mang `/api/visual/asset/<id>`.
//   2. Sau bước 1, ĐO LẠI kích thước serialize THẬT của payload; còn vượt trần thì bỏ bớt hình và
//      NÓI RÕ trong payload (`visualNotes`) — không bao giờ để nền tảng cắt response giữa chừng
//      (thất bại im lặng, client treo ở trạng thái "đang tạo hình").

const budget = require('../payloadBudget');
const assetStore = require('./visualAssetStore');

/** Ảnh nhỏ hơn ngưỡng này vẫn nhúng thẳng: 1 request ít hơn, không đáng để đi vòng qua store. */
const INLINE_DATA_URL_MAX_BYTES = Number(process.env.VISUAL_INLINE_MAX_BYTES) || 200 * 1024;

/** true khi đang chạy môi trường nhiều instance (Vercel) — nơi memory-only store KHÔNG dùng được. */
function isMultiInstanceRuntime() {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

function parseDataUrl(url) {
  const m = /^data:([^;,]+);base64,(.+)$/i.exec(String(url || ''));
  if (!m) return null;
  return { mime: m[1], base64: m[2] };
}

/**
 * @param {Array} visuals
 * @returns {Promise<{visuals:Array, notes:Array<{visualId:string, action:string, reason:string}>}>}
 */
async function externalizeVisuals(visuals) {
  const notes = [];
  const out = [];
  for (const v of Array.isArray(visuals) ? visuals : []) {
    if (!v || typeof v.url !== 'string') { out.push(v); continue; }
    const data = parseDataUrl(v.url);
    if (!data) { out.push(v); continue; } // https:// của provider: đã đi qua /api/visual/download, không chiếm chỗ ở đây

    const wireBytes = data.base64.length;
    if (wireBytes <= INLINE_DATA_URL_MAX_BYTES) { out.push(v); continue; }

    const stored = await assetStore.put({ mime: data.mime, base64: data.base64 });
    if (stored.ok && (stored.durable || !isMultiInstanceRuntime())) {
      out.push({ ...v, format: 'asset_url', url: stored.url, assetId: stored.id, mediaType: data.mime, assetBytes: stored.bytes });
      notes.push({ visualId: v.visualId || '', action: 'externalized', reason: 'image_exceeds_inline_budget' });
      continue;
    }
    // Không có store bền vững trên môi trường nhiều instance: link sẽ 404 ở instance khác. Nói thẳng
    // với client (card hiện nút "Thử tạo lại"), KHÔNG trả link giả vờ hoạt động và cũng KHÔNG nhồi
    // base64 vào response để rồi bị nền tảng cắt.
    out.push({
      ...v, url: null, format: 'unavailable',
      error: stored.ok ? 'image_store_not_durable' : (stored.reason || 'image_store_failed')
    });
    notes.push({
      visualId: v.visualId || '', action: 'dropped',
      reason: stored.ok ? 'image_store_not_durable' : (stored.reason || 'image_store_failed')
    });
  }
  return { visuals: out, notes };
}

/**
 * Chuẩn bị payload cuối cùng: externalize -> đo -> bỏ bớt hình nếu vẫn vượt.
 * @param {object} payload payload sẽ được JSON.stringify và gửi đi
 * @param {{limitBytes?:number}} [opts]
 * @returns {Promise<{payload:object, bytes:number, limit:number, notes:Array, truncatedVisuals:number}>}
 */
async function prepareResponsePayload(payload, opts = {}) {
  const limit = opts.limitBytes || budget.SAFE_RESPONSE_BYTES;
  const next = { ...(payload || {}) };
  let notes = [];

  if (Array.isArray(next.visuals) && next.visuals.length) {
    const res = await externalizeVisuals(next.visuals);
    next.visuals = res.visuals;
    notes = res.notes;
  }

  let check = budget.checkResponseBudget(next, limit);
  let truncated = 0;
  // Trường hợp còn lại: text answer + visuals nhỏ cộng dồn vẫn vượt. Bỏ hình từ CUỐI (hình bổ trợ)
  // trước, giữ nguyên lời giải — người dùng mất minh hoạ chứ không mất câu trả lời.
  while (!check.ok && Array.isArray(next.visuals) && next.visuals.length) {
    next.visuals = next.visuals.slice(0, next.visuals.length - 1);
    truncated += 1;
    check = budget.checkResponseBudget(next, limit);
  }
  if (truncated) {
    notes = notes.concat([{ visualId: '', action: 'dropped', reason: 'response_budget_exceeded' }]);
  }
  if (notes.length) next.visualNotes = notes;
  return { payload: next, bytes: check.bytes, limit, notes, truncatedVisuals: truncated };
}

module.exports = {
  prepareResponsePayload,
  externalizeVisuals,
  isMultiInstanceRuntime,
  parseDataUrl,
  INLINE_DATA_URL_MAX_BYTES
};
