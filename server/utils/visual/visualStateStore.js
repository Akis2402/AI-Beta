'use strict';

// ============================================================================================
// MỤC 31/33 — VISUAL STATE CANONICAL PHÍA SERVER
// ============================================================================================
// Nguyên nhân gốc của \"Detail sinh lại ảnh\": không có nơi nào ghi lại \"request này ĐÃ có vòng đời
// hình minh hoạ rồi\". Stage detail đi tới runVisualPipeline() với một tờ giấy trắng, decision engine
// lại đánh giá từ đầu, rồi lại gọi image provider — người dùng trả tiền hai lần cho cùng một hình.
//
// Module này giữ CANONICAL VISUAL STATE: khoá theo `visualKey` (fingerprint ổn định của câu hỏi +
// hướng giải + phiên bản prompt), giá trị là bản ghi đã externalize (chỉ tham chiếu asset, KHÔNG
// base64 — mục 56).
//
// Trung thực về độ bền (đúng như aiJobStore):
//   - Có KV  -> bền qua nhiều serverless instance (`durable: true`).
//   - Không KV -> chỉ RAM của MỘT instance (`durable: false`). Khi đó Detail có thể KHÔNG tìm thấy
//     state của Approach; hợp đồng vẫn giữ nguyên: Detail TUYỆT ĐỐI không sinh ảnh, chỉ trả về
//     `visualStatus:'unavailable'` để UI giữ nguyên hình đang hiển thị phía client.
//
// KHÔNG lưu: prompt gốc (đã có visualHqStore lo cho nút \"Thử tạo lại\"), lời giải, ảnh base64, khoá.

const kv = require('../kvStore');

const TTL_SECONDS = Number(process.env.VISUAL_STATE_TTL_SECONDS) || 24 * 3600;
const MEM_MAX = 400;

/** RAM fallback — Map giữ thứ tự chèn nên cắt phần tử cũ nhất là đủ cho một tiến trình. */
const mem = new Map();

function keyOf(visualKey) { return `visualstate:${visualKey}`; }

function memSet(visualKey, record) {
  if (mem.has(visualKey)) mem.delete(visualKey);
  else if (mem.size >= MEM_MAX) {
    const oldest = mem.keys().next().value;
    if (oldest !== undefined) mem.delete(oldest);
  }
  mem.set(visualKey, { record, expiresAt: Date.now() + TTL_SECONDS * 1000 });
}

function memGet(visualKey) {
  const entry = mem.get(visualKey);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { mem.delete(visualKey); return null; }
  return entry.record;
}

function isDurable() { return kv.isEnabled(); }

/**
 * Bản ghi canonical cho MỘT vòng đời hình của MỘT request.
 * @param {string} visualKey
 * @param {{visuals:Array, status:string, specFingerprint?:string, decision?:object,
 *   lifecycleCount?:number, stage?:string}} state
 * @returns {Promise<{ok:boolean, durable:boolean}>} không bao giờ throw.
 */
async function saveVisualState(visualKey, state) {
  if (!visualKey) return { ok: false, durable: isDurable() };
  const visuals = Array.isArray(state && state.visuals) ? state.visuals : [];
  const record = {
    visualKey,
    savedAt: Date.now(),
    status: (state && state.status) || 'skipped',
    stage: (state && state.stage) || 'approach',
    // Chỉ giữ tham chiếu + metadata hiển thị. `url` ở đây đã là asset URL do responseGuard sinh ra
    // (mục 56) — nếu vì lý do nào đó vẫn là data URL thì loại bỏ hẳn thay vì nhét vào KV.
    visuals: visuals.map((v) => {
      const out = { ...v };
      if (typeof out.url === 'string' && out.url.startsWith('data:')) delete out.url;
      // Thẻ "cần Auth Puter" mang kèm job để chạy tiếp; prompt gốc KHÔNG được lưu ở đây (đã có visualHqStore).
      if (out.job && typeof out.job === 'object') { out.job = { ...out.job }; delete out.job.prompt; delete out.job.overlay; }
      return out;
    }),
    visualIds: visuals.map((v) => v && v.visualId).filter(Boolean),
    specFingerprint: (state && state.specFingerprint) || null,
    lifecycleCount: Number.isFinite(state && state.lifecycleCount) ? state.lifecycleCount : visuals.length ? 1 : 0
  };
  memSet(visualKey, record);
  if (!kv.isEnabled()) return { ok: true, durable: false };
  try {
    await kv.set(keyOf(visualKey), JSON.stringify(record), TTL_SECONDS);
    return { ok: true, durable: true };
  } catch (e) {
    return { ok: true, durable: false };
  }
}

/**
 * @param {string} visualKey
 * @returns {Promise<object|null>} bản ghi canonical, null nếu chưa từng có vòng đời hình nào.
 */
async function loadVisualState(visualKey) {
  if (!visualKey) return null;
  const hot = memGet(visualKey);
  if (hot) return hot;
  if (!kv.isEnabled()) return null;
  try {
    const raw = await kv.get(keyOf(visualKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.visualKey) memSet(visualKey, parsed);
    return parsed;
  } catch (e) {
    return null;
  }
}

/** Tìm 1 visual theo visualId trong bản ghi đã lưu (mục 33 — Detail chỉ gửi visualId). */
function findVisualById(record, visualId) {
  if (!record || !visualId) return null;
  return (record.visuals || []).find((v) => v && v.visualId === visualId) || null;
}

function _resetForTest() { mem.clear(); }

module.exports = { saveVisualState, loadVisualState, findVisualById, isDurable, TTL_SECONDS, _resetForTest };
