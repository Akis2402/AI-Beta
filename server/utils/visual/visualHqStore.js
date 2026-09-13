'use strict';

// ============================================================================================
// MỤC 2.2 — NGỮ CẢNH CHO LƯỢT TẢI "CHẤT LƯỢNG CAO" (CHỈ KHI NGƯỜI DÙNG BẤM TƯỜNG MINH)
// ============================================================================================
// Độ phân giải MẶC ĐỊNH giữ nguyên 1024x1024 — không đổi một chỗ nào. Chỉ khi người dùng bấm
// "Tải PNG chất lượng cao" thì server mới dựng lại ảnh ở 2048x2048, và lượt đó PHẢI đi lại
// cost-gate theo `imageNecessity` y như luồng chính (không bypass).
//
// Để làm được việc đó, endpoint cần biết prompt + mức cần thiết của đúng hình đó. Lưu tối thiểu:
// KHÔNG lưu câu hỏi, KHÔNG lưu lời giải, KHÔNG lưu số liệu — chỉ prompt ảnh (vốn đã không còn số,
// mục 1.2), necessity và subject.
//
// Store CỐ Ý ở bộ nhớ tiến trình, TTL ngắn: đây là tiện ích cho thao tác vừa xảy ra, không phải
// dữ liệu phải bền. Trên môi trường serverless nhiều instance, tra không thấy -> endpoint trả 404
// và client báo "hãy tạo lại hình", KHÔNG tự ý sinh ảnh mới bằng dữ liệu đoán.

const MAX_ENTRIES = Number(process.env.VISUAL_HQ_MAX) || 50;
const TTL_MS = Number(process.env.VISUAL_HQ_TTL_MS) || 15 * 60 * 1000;

const store = new Map();

function prune(now) {
  for (const [k, v] of store) if (v.expiresAt <= now) store.delete(k);
  while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value);
}

/**
 * remember() — ghi ngữ cảnh của 1 hình ảnh AI vừa sinh.
 * @param {string} visualId
 * @param {{prompt:string, necessity:string, subject:string}} ctx
 */
function remember(visualId, ctx) {
  if (!visualId || !ctx || !ctx.prompt) return;
  const now = Date.now();
  prune(now);
  store.set(String(visualId), {
    prompt: String(ctx.prompt),
    necessity: String(ctx.necessity || 'NONE'),
    subject: String(ctx.subject || ''),
    expiresAt: now + TTL_MS
  });
}

/** @returns {{prompt:string, necessity:string, subject:string}|null} */
function get(visualId) {
  const hit = store.get(String(visualId || ''));
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) { store.delete(String(visualId)); return null; }
  return { prompt: hit.prompt, necessity: hit.necessity, subject: hit.subject };
}

function _resetForTest() { store.clear(); }

module.exports = { remember, get, _resetForTest, MAX_ENTRIES, TTL_MS };
