'use strict';

/* =====================================================================================
   conversationTaskManager.js — PHẦN E..I (multi-conversation background execution)
   + PHẦN BG (background task panel / notification / unseen badge).

   NGUYÊN TẮC TỐI CAO (áp dụng trực tiếp ở module này):
     "UI lifecycle KHÔNG quyết định AI lifecycle."
     "Chuyển tab / chuyển conversation / đóng popup KHÔNG phải Stop."
     "Mỗi conversation/request phải isolated."

   Mỗi task (1 lượt gọi AI streaming cho 1 conversation) có object trạng thái ĐỘC LẬP với UI:
     { conversationId, requestId, status, stage, query, title, provider, model, text, partial,
       startedAt, updatedAt, completedAt, error, usage, statusMessage, statusState,
       backgrounded, backgroundMs, seen, notified, ownerToken, restored,
       requestLanguage, uiLanguageAtStart, answerLanguage, explanationLanguage }

   KHÔNG dùng 1 biến `isGenerating` toàn cục khoá cả app (PHẦN F) — trạng thái generating luôn
   tra theo `conversationId`. Concurrency limit (PHẦN F): vượt giới hạn -> queue.

   UI (app.js / backgroundTaskUI.js) ATTACH/SUBSCRIBE vào task — tách biệt hẳn khỏi việc task có
   tiếp tục chạy hay không (task vẫn chạy dù không ai đang lắng nghe, dù tab đang ẩn).

   GIỚI HẠN TRUNG THỰC (mục 40/41 của yêu cầu): module này chạy TRONG TAB. Nếu tab bị ĐÓNG hẳn
   (không phải ẩn), fetch() bị trình duyệt huỷ -> server nhận `res.on('close')` và dừng pipeline.
   Đây KHÔNG phải server-side job bền vững; không được tuyên bố ngược lại. Những gì module này bảo
   đảm: tab ẩn / mất focus / chuyển conversation / đóng popup KHÔNG huỷ task, và trạng thái task
   sống sót qua reload dưới dạng snapshot (task đang chạy dở của phiên trước -> INTERRUPTED, KHÔNG
   bao giờ tự đánh dấu COMPLETED giả).
   ===================================================================================== */

const CTM_MAX_CONCURRENT = Number(window.CTM_MAX_CONCURRENT) || 3;
const CTM_STORAGE_KEY = 'trogiai.tasks.v2'; // snapshot metadata (KHÔNG lưu AbortController/text đầy đủ)
const CTM_LEGACY_STORAGE_KEY = 'trogiai.tasks.v1';
const CTM_CHANNEL_NAME = 'trogiai-ai-task-sync';
const CTM_FINISHED_KEEP = 40;          // số task đã kết thúc giữ lại tối đa trong registry
const CTM_SEEN_TTL_MS = 5 * 60 * 1000; // task ĐÃ XEM giữ thêm 5 phút rồi dọn (chưa xem thì giữ)
const CTM_PERSIST_THROTTLE_MS = 800;
const CTM_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  RECOVERING: 'recovering',   // server báo state=RECOVERING — CHƯA xong, không được hiện "đã xong"
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  INTERRUPTED: 'interrupted'  // task của phiên trước (tab đóng/reload giữa chừng) — KHÔNG phải completed
};
const ACTIVE_STATUSES = [STATUS.QUEUED, STATUS.RUNNING, STATUS.RECOVERING];
const FINISHED_STATUSES = [STATUS.COMPLETED, STATUS.FAILED, STATUS.CANCELLED, STATUS.INTERRUPTED];

// PHẦN I: ownership token — phân biệt tab hiện tại với các tab khác cùng origin, tránh 2 tab cùng
// nhận là "chủ" của 1 task rồi cả 2 cùng tiếp tục continuation (duplicate).
// 1 job = 1 execution owner; N tab = N UI observer.
const OWNER_TOKEN = (window.crypto && window.crypto.randomUUID)
  ? window.crypto.randomUUID()
  : ('tab_' + Date.now() + '_' + Math.random().toString(36).slice(2));

const tasks = new Map();          // requestId -> task (đang chạy + vừa kết thúc, giữ cho panel/badge)
const byConversation = new Map(); // conversationId -> requestId đang active mới nhất
const listeners = new Map();      // conversationId -> Set(listener)   (PHẦN E: attach theo conversation)
const globalListeners = new Set();// listener toàn cục (panel/badge/toast — subscribeAll)
const queue = [];                 // requestId chờ tới lượt khi vượt CTM_MAX_CONCURRENT
let runningCount = 0;
let uiHidden = false;             // UI có đang ẩn không (CHỈ để hiển thị, không ảnh hưởng lifecycle)

let bc = null;
try { bc = ('BroadcastChannel' in window) ? new BroadcastChannel(CTM_CHANNEL_NAME) : null; } catch (e) { bc = null; }

function uidTask() { return 'task_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9); }
function jobLog(phase, t, extra) {
  // PHẦN 42: log vòng đời rõ ràng, KHÔNG log API key/token/nội dung nhạy cảm — chỉ id + trạng thái.
  try {
    console.info('[job] ' + phase, {
      requestId: t && t.requestId, conversationId: t && t.conversationId,
      status: t && t.status, stage: t && t.stage, ...(extra || {})
    });
  } catch (e) { /* ignore */ }
}

/* ---------- Bản "sạch" của task để phát ra ngoài: không kèm controller/closure ---------- */
function publicTask(t) {
  if (!t) return null;
  return {
    conversationId: t.conversationId, requestId: t.requestId, status: t.status, stage: t.stage,
    query: t.query, title: t.title, provider: t.provider, model: t.model,
    text: t.text, textLength: (t.text || '').length, partial: t.partial,
    startedAt: t.startedAt, updatedAt: t.updatedAt, completedAt: t.completedAt,
    error: t.error, usage: t.usage, finishReason: t.finishReason,
    statusMessage: t.statusMessage, statusState: t.statusState,
    backgrounded: t.backgrounded, backgroundMs: backgroundMsOf(t),
    seen: t.seen, notified: t.notified, restored: !!t.restored,
    remote: !!t.remote, ownerToken: t.ownerToken
  };
}

function backgroundMsOf(t) {
  const base = t.backgroundMs || 0;
  if (t.backgrounded && t.backgroundStartedAt) return base + (Date.now() - t.backgroundStartedAt);
  return base;
}

/* ---------- Phát sự kiện: MỌI event luôn kèm conversationId + requestId (PHẦN 10) ---------- */
function notify(conversationId, event) {
  const task = event.task || null;
  const payload = {
    ...event,
    conversationId,
    requestId: (task && task.requestId) || event.requestId || null,
    task: publicTask(task)
  };
  const set = listeners.get(conversationId);
  if (set) set.forEach((cb) => { try { cb(payload); } catch (e) { console.error('[conversationTaskManager] listener lỗi:', e); } });
  globalListeners.forEach((cb) => { try { cb(payload); } catch (e) { console.error('[conversationTaskManager] global listener lỗi:', e); } });
  // PHẦN 43: KHÔNG broadcast từng delta sang tab khác (spam BroadcastChannel) — chỉ mốc vòng đời.
  if (bc && event.type !== 'delta') {
    try {
      bc.postMessage({
        owner: OWNER_TOKEN, conversationId, type: event.type,
        requestId: payload.requestId, task: publicTask(task)
      });
    } catch (e) { /* ignore */ }
  }
}

/* ---------- Persist snapshot (throttle — PHẦN 43: không ghi localStorage mỗi delta) ---------- */
let persistTimer = null;
let persistPending = false;
function persistSnapshot() {
  persistPending = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (!persistPending) return;
    persistPending = false;
    writeSnapshotNow();
  }, CTM_PERSIST_THROTTLE_MS);
}
function writeSnapshotNow() {
  try {
    const snap = [...tasks.values()].filter((t) => !t.remote).map((t) => ({
      conversationId: t.conversationId, requestId: t.requestId, status: t.status, stage: t.stage,
      query: (t.query || '').slice(0, 180), title: (t.title || '').slice(0, 120),
      provider: t.provider, model: t.model, error: t.error,
      textLength: (t.text || '').length,
      startedAt: t.startedAt, updatedAt: t.updatedAt, completedAt: t.completedAt,
      seen: !!t.seen, notified: !!t.notified, ownerToken: t.ownerToken
    }));
    localStorage.setItem(CTM_STORAGE_KEY, JSON.stringify({ v: 2, savedAt: Date.now(), tasks: snap }));
  } catch (e) { /* ignore (quota) */ }
}
function flushSnapshot() {
  persistPending = true;
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  persistPending = false;
  writeSnapshotNow();
}

/**
 * Khôi phục snapshot sau reload. QUY TẮC (mục 10/20): KHÔNG BAO GIỜ tự đánh dấu COMPLETED giả.
 * Task đang RUNNING/QUEUED/RECOVERING ở phiên trước -> INTERRUPTED (fetch của phiên đó đã chết theo
 * tab). Task đã kết thúc & CHƯA XEM -> giữ lại để badge "có câu trả lời mới" không biến mất sau F5.
 */
function restoreSnapshot() {
  let raw = null;
  try { raw = localStorage.getItem(CTM_STORAGE_KEY); } catch (e) { return; }
  if (!raw) { try { localStorage.removeItem(CTM_LEGACY_STORAGE_KEY); } catch (e) { /* ignore */ } return; }
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) { return; }
  const list = (parsed && Array.isArray(parsed.tasks)) ? parsed.tasks : [];
  const now = Date.now();
  list.forEach((s) => {
    if (!s || !s.requestId || !s.conversationId) return;
    if (now - (s.updatedAt || s.startedAt || 0) > CTM_SNAPSHOT_MAX_AGE_MS) return;
    const wasActive = ACTIVE_STATUSES.indexOf(s.status) >= 0;
    if (!wasActive && s.seen) return; // đã kết thúc và đã xem -> không cần giữ
    const t = {
      conversationId: s.conversationId, requestId: s.requestId,
      status: wasActive ? STATUS.INTERRUPTED : s.status,
      stage: s.stage || null, query: s.query || '', title: s.title || '',
      provider: s.provider || null, model: s.model || null,
      text: '', partial: true, startedAt: s.startedAt || now, updatedAt: s.updatedAt || now,
      completedAt: s.completedAt || (wasActive ? now : null),
      error: wasActive ? null : (s.error || null), usage: null, finishReason: null,
      statusMessage: null, statusState: null,
      backgrounded: false, backgroundStartedAt: null, backgroundMs: 0,
      seen: !!s.seen, notified: true, // KHÔNG notify lại sau reload (mục 14)
      controller: null, ownerToken: s.ownerToken || null, restored: true, remote: false, _counted: false
    };
    tasks.set(t.requestId, t);
  });
  flushSnapshot();
}

/* ---------- Queue / concurrency ---------- */
function runNextQueued() {
  while (runningCount < CTM_MAX_CONCURRENT && queue.length) {
    const requestId = queue.shift();
    const t = tasks.get(requestId);
    if (!t || t.status !== STATUS.QUEUED) continue;
    t.status = STATUS.RUNNING;
    t.updatedAt = Date.now();
    t._counted = true;
    runningCount++;
    if (uiHidden) markBackgrounded(t, true);
    jobLog('running', t);
    notify(t.conversationId, { type: 'running', task: t });
    notify(t.conversationId, { type: 'status', task: t });
    if (t._resolveStart) t._resolveStart();
  }
  persistSnapshot();
}
function resolveNextTick(fn) { Promise.resolve().then(fn); }

/**
 * Đăng ký 1 task mới cho `conversationId`. Trả về task + Promise `whenReady` (resolve khi tới lượt
 * chạy — nếu vượt concurrency limit, task ở trạng thái QUEUED cho tới khi có slot trống).
 * `langLock` (PHẦN AK/AJ): { requestLanguage, uiLanguageAtStart, answerLanguage, explanationLanguage }
 * — chốt NGAY tại thời điểm bắt đầu, KHÔNG đọc lại state ngôn ngữ hiện tại về sau.
 * `query`/`title`/`stage` (PHẦN BG): dữ liệu HIỂN THỊ cho background panel — không ảnh hưởng lifecycle.
 */
function beginTask(conversationId, { provider, model, langLock, query, title, stage } = {}) {
  const requestId = uidTask();
  const controller = new AbortController();
  const task = {
    conversationId, requestId, status: STATUS.QUEUED,
    stage: stage || null, query: query || '', title: title || '',
    provider: provider || null, model: model || null,
    text: '', partial: true, startedAt: Date.now(), updatedAt: Date.now(), completedAt: null,
    error: null, usage: null, finishReason: null,
    statusMessage: null, statusState: null,
    backgrounded: false, backgroundStartedAt: null, backgroundMs: 0,
    seen: true,        // task đang chạy do CHÍNH người dùng vừa tạo -> chưa có gì "chưa xem"
    notified: false,   // mục 14: mỗi task chỉ được notify hoàn tất ĐÚNG 1 LẦN
    controller, ownerToken: OWNER_TOKEN, restored: false, remote: false, _counted: false,
    requestLanguage: langLock && langLock.requestLanguage,
    uiLanguageAtStart: langLock && langLock.uiLanguageAtStart,
    answerLanguage: langLock && langLock.answerLanguage,
    explanationLanguage: langLock && langLock.explanationLanguage,
    _resolveStart: null
  };
  tasks.set(requestId, task);
  byConversation.set(conversationId, requestId);
  jobLog('created', task);

  const whenReady = new Promise((resolve) => { task._resolveStart = resolve; });
  if (runningCount < CTM_MAX_CONCURRENT) {
    task.status = STATUS.RUNNING;
    task._counted = true;
    runningCount++;
    if (uiHidden) markBackgrounded(task, true);
    resolveNextTick(() => task._resolveStart && task._resolveStart());
  } else {
    queue.push(requestId);
    jobLog('queued', task);
  }
  pruneFinished();
  persistSnapshot();
  notify(conversationId, { type: 'start', task });
  if (task.status === STATUS.QUEUED) notify(conversationId, { type: 'queued', task });
  else { jobLog('running', task); notify(conversationId, { type: 'running', task }); }
  return { task, whenReady, signal: controller.signal };
}

/** Gắn/cập nhật metadata hiển thị (query/title/stage/provider/model) — KHÔNG đụng lifecycle. */
function updateTaskMeta(requestId, meta) {
  const t = tasks.get(requestId);
  if (!t || !meta) return null;
  ['query', 'title', 'stage', 'provider', 'model'].forEach((k) => {
    if (meta[k] != null && meta[k] !== '') t[k] = meta[k];
  });
  t.updatedAt = Date.now();
  persistSnapshot();
  notify(t.conversationId, { type: 'meta', task: t });
  return publicTask(t);
}

/** PHẦN G: gọi khi nhận delta — mọi event phải kèm conversationId/requestId (đã có trong task). */
function appendDelta(requestId, chunk) {
  const t = tasks.get(requestId);
  if (!t || t.status === STATUS.CANCELLED) return; // response cũ bị hủy không được "chui" vào state nữa
  // Mục 30: text tích luỹ SỐNG TRONG TASK — UI mất focus/detach không bao giờ reset về rỗng.
  t.text += chunk;
  t.updatedAt = Date.now();
  if (t.status === STATUS.RECOVERING) t.status = STATUS.RUNNING;
  notify(t.conversationId, { type: 'delta', task: t, chunk });
}

/**
 * Status từ server (`event: status` của SSE). `state` có thể là GENERATING/RECOVERING/... —
 * RECOVERING (mục 18) phải đổi status task để popup hiện "đang hoàn thiện", TUYỆT ĐỐI không hiện
 * "đã xong" cho tới khi nhận đúng completeTask().
 */
function setStatus(requestId, message, state) {
  const t = tasks.get(requestId);
  if (!t) return;
  t.statusMessage = message || null;
  t.statusState = state || null;
  t.updatedAt = Date.now();
  if (state === 'RECOVERING' && ACTIVE_STATUSES.indexOf(t.status) >= 0) t.status = STATUS.RECOVERING;
  notify(t.conversationId, { type: 'statusMsg', task: t, message, state });
}

/**
 * PHẦN H + mục 19: THỨ TỰ BẮT BUỘC là "lưu kết quả -> mark COMPLETED -> phát event done -> toast ->
 * notification". Hàm này chỉ chịu trách nhiệm 2 bước giữa; nơi gọi (app.js) đã ghi message vào
 * conversation TRƯỚC khi gọi, còn toast/notification do listener của event `done` thực hiện SAU.
 */
function completeTask(requestId, result) {
  const t = tasks.get(requestId);
  if (!t) return;
  if (FINISHED_STATUSES.indexOf(t.status) >= 0) return; // idempotent: done chỉ xử lý đúng 1 lần (mục 23)
  t.status = STATUS.COMPLETED;
  t.partial = !!(result && result.partial);
  t.completedAt = Date.now();
  t.updatedAt = t.completedAt;
  t.provider = (result && result.provider) || t.provider;
  t.model = (result && result.model) || t.model;
  t.usage = (result && result.usage) || null;
  t.finishReason = (result && result.finishReason) || null;
  if (result && typeof result.text === 'string' && result.text.length > (t.text || '').length) t.text = result.text;
  t.statusMessage = null;
  t.statusState = null;
  finalizeTask(t);
}
function failTask(requestId, error) {
  const t = tasks.get(requestId);
  if (!t) return;
  if (FINISHED_STATUSES.indexOf(t.status) >= 0) return;
  // mục 23: phân biệt CHÍNH XÁC "người dùng bấm Dừng" (cancelled) với lỗi thật (failed).
  t.status = (error && (error.cancelled || error.name === 'AbortError')) ? STATUS.CANCELLED : STATUS.FAILED;
  t.error = error ? (error.message || String(error)) : 'unknown error';
  t.completedAt = Date.now();
  t.updatedAt = t.completedAt;
  t.statusMessage = null;
  t.statusState = null;
  finalizeTask(t);
}
function finalizeTask(t) {
  if (t.backgrounded) markBackgrounded(t, false);
  // mục 16: hoàn tất khi người dùng KHÔNG ở đúng conversation đó (hoặc tab đang ẩn) -> "chưa xem".
  const viewing = typeof window.appTaskBridge !== 'undefined' && window.appTaskBridge
    && typeof window.appTaskBridge.isViewing === 'function' && window.appTaskBridge.isViewing(t.conversationId);
  t.seen = !!viewing && !uiHidden;
  const eventType = t.status === STATUS.COMPLETED ? 'done' : (t.status === STATUS.CANCELLED ? 'cancelled' : 'error');
  jobLog(t.status === STATUS.COMPLETED ? 'completed' : (t.status === STATUS.CANCELLED ? 'cancelled' : 'failed'), t,
    { ms: t.completedAt - t.startedAt });
  notify(t.conversationId, { type: eventType, task: t });
  if (byConversation.get(t.conversationId) === t.requestId) byConversation.delete(t.conversationId);
  if (t._counted) { t._counted = false; runningCount = Math.max(0, runningCount - 1); }
  t.controller = null; // gỡ tham chiếu AbortController (GC) nhưng GIỮ task cho panel/badge
  runNextQueued();
  pruneFinished();
  flushSnapshot();
}

/**
 * Dọn registry: task ĐÃ XEM giữ thêm CTM_SEEN_TTL_MS; task CHƯA XEM luôn được giữ (badge "có câu
 * trả lời mới" không được biến mất trước khi người dùng thực sự mở xem). Trần cứng CTM_FINISHED_KEEP
 * để RAM/localStorage không phình vô hạn.
 */
function pruneFinished() {
  const now = Date.now();
  const finished = [...tasks.values()].filter((t) => FINISHED_STATUSES.indexOf(t.status) >= 0 && !t.remote);
  finished.forEach((t) => {
    if (t.seen && (now - (t.completedAt || t.updatedAt || now)) > CTM_SEEN_TTL_MS) tasks.delete(t.requestId);
  });
  const rest = [...tasks.values()].filter((t) => FINISHED_STATUSES.indexOf(t.status) >= 0);
  if (rest.length > CTM_FINISHED_KEEP) {
    rest.sort((a, b) => (a.completedAt || a.updatedAt || 0) - (b.completedAt || b.updatedAt || 0));
    rest.slice(0, rest.length - CTM_FINISHED_KEEP).forEach((t) => tasks.delete(t.requestId));
  }
}

/**
 * PHẦN BG/21 — nhận lại kết quả của 1 task BỊ GIÁN ĐOẠN từ server job store
 * (GET /api/chat/jobs/:requestId). Chỉ áp dụng cho task đang ở INTERRUPTED: không được "hồi sinh"
 * task đang chạy (tránh ghi đè state thật) và không được đụng task đã kết thúc bình thường.
 * Kết quả nhận về mặc định là CHƯA XEM -> badge "có câu trả lời mới" hiện lên đúng như khi task
 * hoàn tất lúc người dùng ở nơi khác.
 */
function adoptRecoveredResult(requestId, payload) {
  const t = tasks.get(requestId);
  if (!t || t.status !== STATUS.INTERRUPTED) return null;
  const status = payload && payload.status;
  if (status === 'completed') {
    t.status = STATUS.COMPLETED;
    t.text = (payload.text != null) ? String(payload.text) : t.text;
    t.partial = !!payload.partial;
    t.provider = payload.provider || t.provider;
    t.model = payload.model || t.model;
    t.error = null;
  } else if (status === 'failed') {
    t.status = STATUS.FAILED;
    t.error = payload.error || 'failed';
  } else if (status === 'cancelled') {
    t.status = STATUS.CANCELLED;
    t.error = payload.error || null;
  } else {
    return null; // job vẫn đang chạy ở server: giữ nguyên INTERRUPTED, KHÔNG đoán
  }
  t.completedAt = payload.completedAt || Date.now();
  t.updatedAt = Date.now();
  t.restored = true;
  t.seen = false;
  t.notified = true; // đã qua 1 phiên rồi — không bắn notification muộn
  jobLog('recovered', t, { from: 'server-job-store' });
  notify(t.conversationId, { type: t.status === STATUS.COMPLETED ? 'done' : 'error', task: t, recovered: true });
  flushSnapshot();
  return publicTask(t);
}

/** PHẦN D: Stop CHỈ abort task của ĐÚNG conversation được chỉ định — không đụng conversation khác. */
function abortActiveTask(conversationId) {
  const requestId = byConversation.get(conversationId);
  const t = requestId && tasks.get(requestId);
  if (t && t.controller && !t.controller.signal.aborted) {
    jobLog('cancel-requested', t);
    t.controller.abort();
  }
}
/** Dừng theo requestId (nút Dừng trong background panel) — vẫn là hành động CHỦ ĐỘNG của người dùng. */
function abortTask(requestId) {
  const t = tasks.get(requestId);
  if (t && t.controller && !t.controller.signal.aborted) {
    jobLog('cancel-requested', t);
    t.controller.abort();
    return true;
  }
  return false;
}

function isGenerating(conversationId) {
  const requestId = byConversation.get(conversationId);
  const t = requestId && tasks.get(requestId);
  return !!t && ACTIVE_STATUSES.indexOf(t.status) >= 0;
}
function getActiveTask(conversationId) {
  const requestId = byConversation.get(conversationId);
  return requestId ? tasks.get(requestId) : null;
}

/* =====================================================================================
   PHẦN BG — API cho background panel / badge / notification.
   Tất cả đều CHỈ ĐỌC trạng thái (trừ markAsSeen/removeCompletedTask), không đụng lifecycle.
   ===================================================================================== */
function getAllTasks() {
  return [...tasks.values()].map(publicTask).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
function getRunningTasks() {
  return [...tasks.values()].filter((t) => ACTIVE_STATUSES.indexOf(t.status) >= 0).map(publicTask)
    .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
}
function getCompletedTasks() {
  return [...tasks.values()].filter((t) => t.status === STATUS.COMPLETED).map(publicTask)
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
}
function getFinishedTasks() {
  return [...tasks.values()].filter((t) => FINISHED_STATUSES.indexOf(t.status) >= 0).map(publicTask)
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
}
function getTask(requestId) { return publicTask(tasks.get(requestId)); }
/** Task của phiên trước bị cắt giữa chừng — ứng viên để hỏi lại server job store. */
function getInterruptedTasks() {
  return [...tasks.values()].filter((t) => t.status === STATUS.INTERRUPTED).map(publicTask);
}
function getTasksForConversation(conversationId) {
  return [...tasks.values()].filter((t) => t.conversationId === conversationId).map(publicTask);
}
/** Số task đang chạy/chờ — dùng cho badge "AI đang chạy • N". */
function getBackgroundTaskCount() { return getRunningTasks().length; }
/** Số kết quả đã xong nhưng NGƯỜI DÙNG CHƯA XEM — badge "có câu trả lời mới". */
function getUnseenCount() {
  return [...tasks.values()].filter((t) => FINISHED_STATUSES.indexOf(t.status) >= 0 && !t.seen).length;
}
function hasUnseen(conversationId) {
  return [...tasks.values()].some((t) => t.conversationId === conversationId
    && FINISHED_STATUSES.indexOf(t.status) >= 0 && !t.seen);
}
function markAsSeen(requestId) {
  const t = tasks.get(requestId);
  if (!t || t.seen) return false;
  t.seen = true;
  t.updatedAt = Date.now();
  persistSnapshot();
  notify(t.conversationId, { type: 'seen', task: t });
  return true;
}
/** Người dùng mở 1 conversation -> mọi kết quả của conversation đó coi như đã xem (mục 16). */
function markConversationSeen(conversationId) {
  let changed = false;
  tasks.forEach((t) => {
    if (t.conversationId === conversationId && FINISHED_STATUSES.indexOf(t.status) >= 0 && !t.seen) {
      t.seen = true; t.updatedAt = Date.now(); changed = true;
      notify(t.conversationId, { type: 'seen', task: t });
    }
  });
  if (changed) persistSnapshot();
  return changed;
}
/** Đánh dấu "đã gửi notification" — mục 14: một task chỉ notify hoàn tất ĐÚNG 1 lần. */
function markNotified(requestId) {
  const t = tasks.get(requestId);
  if (!t || t.notified) return false;
  t.notified = true;
  persistSnapshot();
  return true;
}
/** Gỡ 1 task đã kết thúc khỏi panel (KHÔNG áp dụng cho task đang chạy — không được "xoá" AI job). */
function removeCompletedTask(requestId) {
  const t = tasks.get(requestId);
  if (!t) return false;
  if (ACTIVE_STATUSES.indexOf(t.status) >= 0) return false;
  tasks.delete(requestId);
  persistSnapshot();
  notify(t.conversationId, { type: 'removed', task: t });
  return true;
}
function clearFinishedTasks() {
  let n = 0;
  [...tasks.values()].forEach((t) => {
    if (FINISHED_STATUSES.indexOf(t.status) >= 0) { tasks.delete(t.requestId); n++; }
  });
  if (n) { persistSnapshot(); notify(null, { type: 'sync' }); }
  return n;
}

/**
 * PHẦN E: UI đăng ký lắng nghe 1 conversation cụ thể — KHÔNG ảnh hưởng việc task có chạy tiếp hay
 * không (detach UI chỉ ngưng NHẬN sự kiện, task vẫn chạy nền). Trả về hàm huỷ đăng ký (detach).
 */
function attach(conversationId, cb) {
  if (!listeners.has(conversationId)) listeners.set(conversationId, new Set());
  listeners.get(conversationId).add(cb);
  return () => { const s = listeners.get(conversationId); if (s) s.delete(cb); };
}
function detachAll(conversationId) { listeners.delete(conversationId); }
/** Lắng nghe MỌI conversation (background panel/badge/toast). Trả về hàm huỷ đăng ký. */
function subscribeAll(cb) {
  globalListeners.add(cb);
  return () => globalListeners.delete(cb);
}

/* ---------- Background/foreground: CHỈ là nhãn hiển thị, KHÔNG đụng AbortController ---------- */
function markBackgrounded(t, flag) {
  if (flag && !t.backgrounded) { t.backgrounded = true; t.backgroundStartedAt = Date.now(); }
  else if (!flag && t.backgrounded) {
    t.backgroundMs = backgroundMsOf(t);
    t.backgrounded = false;
    t.backgroundStartedAt = null;
  }
}
/**
 * Gọi từ visibilitychange/blur. TUYỆT ĐỐI KHÔNG abort/huỷ/reset/mark-failed gì ở đây (mục 6/24/39/40)
 * — chỉ gắn nhãn "đang chạy nền" để UI hiển thị đúng và đo được "đã chạy nền bao lâu" (mục 31).
 */
function setUiHidden(hidden) {
  const next = !!hidden;
  if (next === uiHidden) return;
  uiHidden = next;
  tasks.forEach((t) => {
    if (ACTIVE_STATUSES.indexOf(t.status) < 0) return;
    markBackgrounded(t, uiHidden);
    jobLog(uiHidden ? 'background' : 'resumed', t);
    notify(t.conversationId, { type: uiHidden ? 'background' : 'foreground', task: t });
  });
  notify(null, { type: 'sync', hidden: uiHidden });
}
function isUiHidden() { return uiHidden; }

/* ---------- PHẦN I / mục 28: đồng bộ multi-tab (observer, KHÔNG chạy hộ task của tab khác) ---------- */
const remoteTasks = new Map(); // requestId -> task snapshot của tab khác (CHỈ để hiển thị)
if (bc) {
  bc.onmessage = (ev) => {
    const data = ev.data;
    if (!data || data.owner === OWNER_TOKEN) return; // bỏ qua message do chính tab này gửi
    // Tab này KHÔNG sở hữu task đó -> không tạo controller, không continuation, không ghi message.
    if (data.task && data.requestId && !tasks.has(data.requestId)) {
      const snapshot = { ...data.task, remote: true, controller: null, _counted: false };
      if (FINISHED_STATUSES.indexOf(snapshot.status) >= 0) remoteTasks.delete(data.requestId);
      else remoteTasks.set(data.requestId, snapshot);
    }
    const payload = { type: 'remoteTabEvent', remote: true, conversationId: data.conversationId, requestId: data.requestId, task: data.task || null, sourceType: data.type };
    const set = listeners.get(data.conversationId);
    if (set) set.forEach((cb) => { try { cb(payload); } catch (e) { /* ignore */ } });
    globalListeners.forEach((cb) => { try { cb(payload); } catch (e) { /* ignore */ } });
  };
}
function getRemoteTasks() { return [...remoteTasks.values()]; }

// Ghi snapshot cuối trước khi trang biến mất. KHÔNG abort gì ở đây (mục 40) — chỉ lưu trạng thái.
window.addEventListener('pagehide', flushSnapshot);
window.addEventListener('beforeunload', flushSnapshot);

restoreSnapshot();

window.conversationTaskManager = {
  STATUS, ACTIVE_STATUSES, FINISHED_STATUSES, OWNER_TOKEN, CTM_MAX_CONCURRENT,
  // API cũ (giữ nguyên chữ ký — backward compatibility, mục 9/37)
  beginTask, appendDelta, setStatus, completeTask, failTask,
  abortActiveTask, isGenerating, getActiveTask, attach, detachAll,
  // API mới (PHẦN BG)
  abortTask, updateTaskMeta, subscribeAll, adoptRecoveredResult,
  getAllTasks, getRunningTasks, getCompletedTasks, getFinishedTasks, getTask, getTasksForConversation, getInterruptedTasks,
  getBackgroundTaskCount, getUnseenCount, hasUnseen,
  markAsSeen, markConversationSeen, markNotified, removeCompletedTask, clearFinishedTasks,
  setUiHidden, isUiHidden, getRemoteTasks, flushSnapshot
};
