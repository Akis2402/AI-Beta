'use strict';

// ============================================================================================
// aiJobStore.js — PHẦN BG/20/21/41: TRẠNG THÁI + KẾT QUẢ của một lượt giải, sống ĐỘC LẬP với
// kết nối SSE đã tạo ra nó.
// ============================================================================================
// Vấn đề gốc: kết quả của 1 lượt gọi AI trước đây CHỈ tồn tại trong chính response SSE. Tab đóng/
// reload/mất mạng giữa chừng -> phần đã sinh ra biến mất hoàn toàn, dù server đã tính xong (đã trả
// tiền token). Module này ghi lại vòng đời + kết quả cuối theo `requestId` do CLIENT sinh ra, để
// tab mở lại có thể hỏi `GET /api/chat/jobs/:requestId` và nhận lại lời giải thay vì giải lại.
//
// TRUNG THỰC VỀ ĐỘ BỀN (mục 41 — cấm tuyên bố "background job bền vững" nếu chỉ giữ trong RAM):
//   - Có KV (kvStore.isEnabled()): bền qua nhiều serverless instance. `durable: true`.
//   - Không có KV: chỉ giữ trong RAM của ĐÚNG instance đang chạy. `durable: false` được trả về
//     tường minh trong mọi response, và log rõ ràng 1 lần khi khởi động.
//
// Module này KHÔNG kéo dài vòng đời tính toán: nếu client ngắt kết nối, `chat.js` vẫn abort
// pipeline như cũ (không đốt token cho người đã rời đi). Nó chỉ bảo toàn thứ ĐÃ tính xong.

const kvStore = require('./kvStore');

const JOB_TTL_SECONDS = Number(process.env.AI_JOB_TTL_SECONDS) || 30 * 60; // 30 phút
const MAX_RESULT_CHARS = Number(process.env.AI_JOB_MAX_RESULT_CHARS) || 200000;
const RAM_MAX_JOBS = 200;
const KEY_PREFIX = 'ai:job:';
const VERSION = 1;

const STATUS = {
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
};

// Fallback RAM — LRU thô sơ theo thứ tự chèn (Map giữ thứ tự), đủ cho 1 instance chạy dài.
const ram = new Map();

let warnedNoKv = false;
function warnOnceIfNotDurable(logger) {
  if (kvStore.isEnabled() || warnedNoKv) return;
  warnedNoKv = true;
  const msg = '[aiJob] KV chưa cấu hình (KV_REST_API_URL/TOKEN) — job chỉ sống trong RAM của instance này. '
    + 'Tab mở lại có thể KHÔNG lấy được kết quả cũ. Đây là hạ cấp CÓ THÔNG BÁO, không phải durable job.';
  if (logger && typeof logger.log === 'function') logger.log({ stage: 'ai_job_store_not_durable', message: msg });
  else console.warn(msg);
}

function isDurable() { return kvStore.isEnabled(); }
function keyOf(requestId) { return KEY_PREFIX + requestId; }

function ramSet(requestId, record) {
  ram.set(requestId, record);
  if (ram.size > RAM_MAX_JOBS) {
    const oldest = ram.keys().next().value;
    ram.delete(oldest);
  }
}

function clip(s, n) {
  const str = typeof s === 'string' ? s : '';
  return str.length > n ? str.slice(0, n) : str;
}

/** Ghi xuống KV — BEST EFFORT, không await ở đường chính (mục 28: L2 chậm không được làm chậm request). */
function persist(record) {
  if (!kvStore.isEnabled()) return Promise.resolve(false);
  return kvStore.set(keyOf(record.requestId), JSON.stringify(record), JOB_TTL_SECONDS).catch(() => false);
}

/**
 * Tạo job cho 1 lượt giải. `requestId` do CLIENT sinh (conversationTaskManager) nên client biết
 * trước để hỏi lại sau khi reload. Không có requestId -> trả về null, mọi hàm khác no-op.
 */
function createJob({ requestId, conversationId, stage, query, serverRequestId, logger } = {}) {
  if (!requestId || typeof requestId !== 'string') return null;
  warnOnceIfNotDurable(logger);
  const now = Date.now();
  const record = {
    version: VERSION,
    requestId: clip(requestId, 64),
    conversationId: clip(conversationId || '', 64) || null,
    serverRequestId: serverRequestId || null,
    stage: clip(stage || '', 24) || null,
    query: clip(query || '', 300),
    status: STATUS.RUNNING,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    result: null,
    error: null,
    durable: isDurable()
  };
  ramSet(record.requestId, record);
  persist(record);
  return record;
}

function touch(job, patch) {
  if (!job) return null;
  Object.assign(job, patch || {}, { updatedAt: Date.now() });
  ramSet(job.requestId, job);
  return job;
}

/** Kết thúc job. Gọi nhiều lần là vô hại: chỉ trạng thái KẾT THÚC ĐẦU TIÊN được giữ. */
function finishJob(job, { status, result, error } = {}) {
  if (!job || job.status !== STATUS.RUNNING) return job;
  job.status = status || STATUS.COMPLETED;
  job.completedAt = Date.now();
  job.updatedAt = job.completedAt;
  job.error = error ? clip(String(error), 400) : null;
  job.result = result ? normalizeResult(result) : null;
  ramSet(job.requestId, job);
  persist(job);
  return job;
}

/** Chỉ giữ đúng những field client cần để dựng lại câu trả lời — KHÔNG lưu prompt/context/ảnh. */
function normalizeResult(data) {
  if (!data || typeof data !== 'object') return null;
  return {
    text: clip(data.text || '', MAX_RESULT_CHARS),
    truncatedForStorage: typeof data.text === 'string' && data.text.length > MAX_RESULT_CHARS,
    provider: data.provider || null,
    model: data.model || null,
    partial: !!data.partial,
    finishReason: data.finishReason || null,
    crossChecked: !!data.crossChecked,
    citationMap: Array.isArray(data.citationMap) ? data.citationMap.slice(0, 200) : null,
    subjectId: data.subjectId || null,
    subjectConfidence: Number.isFinite(data.subjectConfidence) ? data.subjectConfidence : null,
    secondarySubjectId: data.secondarySubjectId || null,
    visuals: Array.isArray(data.visuals) ? data.visuals.slice(0, 8) : null,
    visualStatus: data.visualStatus || null,
    incompleteReasons: Array.isArray(data.incompleteReasons) ? data.incompleteReasons.slice(0, 20) : null
  };
}

/**
 * Cầu nối 1 điểm duy nhất giữa SSE và job store: mọi nhánh `sseWrite(res,'done'|'error',...)` trong
 * chat.js đều đi qua đây, không cần sửa từng nhánh return rải rác (và không thể quên nhánh nào).
 */
function observeSseEvent(job, event, data) {
  if (!job) return;
  if (event === 'done') finishJob(job, { status: STATUS.COMPLETED, result: data });
  else if (event === 'error') finishJob(job, { status: STATUS.FAILED, error: (data && (data.message || data.code)) || 'error' });
  else if (event === 'status' && data && data.state) touch(job, { state: data.state });
  else if (event === 'visual:ready' && job.result) {
    // Hình tới SAU "done" (kênh sự kiện riêng) — bổ sung vào kết quả đã lưu, không đổi trạng thái.
    const visuals = Array.isArray(job.result.visuals) ? job.result.visuals : [];
    visuals.push(data);
    job.result.visuals = visuals.slice(0, 8);
    job.result.visualStatus = 'ready';
    touch(job, {});
    persist(job);
  }
}

/** Client ngắt kết nối giữa chừng (đóng tab/mất mạng) — ghi nhận đúng bản chất, không phải "xong". */
function markDisconnected(job) {
  if (!job || job.status !== STATUS.RUNNING) return job;
  return finishJob(job, { status: STATUS.CANCELLED, error: 'client_disconnected' });
}

/** Đọc job: RAM trước (cùng instance), rồi KV (instance khác/sau deploy). */
async function getJob(requestId) {
  if (!requestId) return null;
  const local = ram.get(requestId);
  if (local) return local;
  if (!kvStore.isEnabled()) return null;
  const raw = await kvStore.get(keyOf(requestId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === VERSION) { ramSet(requestId, parsed); return parsed; }
    return null;
  } catch (e) { return null; }
}

/** Bản rút gọn trả cho client (không lộ serverRequestId/state nội bộ). */
function toPublic(job) {
  if (!job) return null;
  return {
    requestId: job.requestId,
    conversationId: job.conversationId,
    stage: job.stage,
    status: job.status,
    query: job.query,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    error: job.error,
    result: job.result,
    durable: !!job.durable
  };
}

function getStats() {
  return { durable: isDurable(), ramJobs: ram.size, ttlSeconds: JOB_TTL_SECONDS };
}

/** Chỉ dùng cho test — xoá sạch RAM giữa các case. */
function __resetForTest() { ram.clear(); warnedNoKv = false; }

module.exports = {
  STATUS, createJob, touch, finishJob, observeSseEvent, markDisconnected,
  getJob, toPublic, isDurable, getStats, __resetForTest
};
