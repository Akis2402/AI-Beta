'use strict';

/* =====================================================================================
   conversationTaskManager.js — PHẦN E..I (Multi-conversation background execution).

   NGUYÊN TẮC TỐI CAO #1/#2/#3 (áp dụng trực tiếp ở module này):
     "UI lifecycle KHÔNG quyết định AI lifecycle."
     "Chuyển chat KHÔNG phải Stop."
     "Mỗi conversation/request phải isolated."

   Mỗi task (1 lượt gọi AI streaming cho 1 conversation) có object trạng thái ĐỘC LẬP với UI:
     { conversationId, requestId, status, provider, model, text, partial, startedAt, updatedAt,
       completedAt, error, usage, requestLanguage, uiLanguageAtStart, answerLanguage,
       explanationLanguage }  (PHẦN AK — language khoá theo task, không đổi giữa chừng)

   KHÔNG dùng 1 biến `isGenerating` toàn cục khoá cả app (PHẦN F) — trạng thái generating luôn
   tra theo `conversationId`. Concurrency limit (PHẦN F): vượt giới hạn -> queue.

   UI (app.js) ATTACH/DETACH vào 1 task qua subscribe(conversationId, listener) — tách biệt hẳn
   khỏi việc task có tiếp tục chạy hay không (task vẫn chạy dù không ai đang lắng nghe).
   ===================================================================================== */

const CTM_MAX_CONCURRENT = Number(window.CTM_MAX_CONCURRENT) || 3;
const CTM_STORAGE_KEY = 'trogiai.tasks.v1'; // chỉ lưu SNAPSHOT nhẹ (không lưu AbortController) để phục hồi UI sau reload
const CTM_LOCK_KEY = 'trogiai.tab.ownerToken';
const CTM_CHANNEL_NAME = 'trogiai-ai-task-sync';

const STATUS = { QUEUED: 'queued', RUNNING: 'running', COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled' };

// PHẦN I: ownership token — phân biệt tab hiện tại với các tab khác cùng origin, tránh 2 tab cùng
// nhận là "chủ" của 1 task rồi cả 2 cùng tiếp tục continuation (duplicate).
const OWNER_TOKEN = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('tab_' + Date.now() + '_' + Math.random().toString(36).slice(2));

const tasks = new Map(); // requestId -> task object (RAM — nguồn sự thật khi tab này đang chạy task đó)
const byConversation = new Map(); // conversationId -> requestId đang active (running/queued) mới nhất
const listeners = new Map(); // conversationId -> Set(listener)
const queue = []; // requestId chờ tới lượt khi vượt CTM_MAX_CONCURRENT
let runningCount = 0;

let bc = null;
try { bc = ('BroadcastChannel' in window) ? new BroadcastChannel(CTM_CHANNEL_NAME) : null; } catch (e) { bc = null; }

function uidTask() { return 'task_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9); }

function notify(conversationId, event) {
  const set = listeners.get(conversationId);
  if (set) set.forEach((cb) => { try { cb(event); } catch (e) { console.error('[conversationTaskManager] listener lỗi:', e); } });
  if (bc) { try { bc.postMessage({ owner: OWNER_TOKEN, conversationId, type: event.type, requestId: event.task && event.task.requestId }); } catch (e) { /* ignore */ } }
}

function persistSnapshot() {
  // Chỉ lưu metadata NHẸ (không lưu buffer text đầy đủ/controller) — đủ để sau reload biết "task
  // này còn coi là đang chạy hay không" (không tự resume network — mục 3 KHÔNG bắt buộc auto-resume
  // qua reload, chỉ cần KHÔNG đánh mất/markCompleted sai nếu tab bị đóng giữa chừng).
  try {
    const snap = [...tasks.values()].map((t) => ({
      conversationId: t.conversationId, requestId: t.requestId, status: t.status,
      startedAt: t.startedAt, updatedAt: t.updatedAt
    }));
    localStorage.setItem(CTM_STORAGE_KEY, JSON.stringify(snap));
  } catch (e) { /* ignore (quota) */ }
}

function runNextQueued() {
  while (runningCount < CTM_MAX_CONCURRENT && queue.length) {
    const requestId = queue.shift();
    const t = tasks.get(requestId);
    if (!t || t.status !== STATUS.QUEUED) continue;
    t.status = STATUS.RUNNING;
    t.updatedAt = Date.now();
    runningCount++;
    notify(t.conversationId, { type: 'status', task: t });
    if (t._resolveStart) t._resolveStart();
  }
}

/**
 * Đăng ký 1 task mới cho `conversationId`. Trả về task + Promise `whenReady` (resolve khi tới lượt
 * chạy — nếu vượt concurrency limit, task ở trạng thái QUEUED cho tới khi có slot trống).
 * `langLock` (PHẦN AK/AJ): { requestLanguage, uiLanguageAtStart, answerLanguage, explanationLanguage }
 * — chốt NGAY tại thời điểm bắt đầu, KHÔNG đọc lại state ngôn ngữ hiện tại về sau.
 */
function beginTask(conversationId, { provider, model, langLock } = {}) {
  const requestId = uidTask();
  const controller = new AbortController();
  const task = {
    conversationId, requestId, status: STATUS.QUEUED, provider: provider || null, model: model || null,
    text: '', partial: true, startedAt: Date.now(), updatedAt: Date.now(), completedAt: null,
    error: null, usage: null, controller,
    requestLanguage: langLock && langLock.requestLanguage,
    uiLanguageAtStart: langLock && langLock.uiLanguageAtStart,
    answerLanguage: langLock && langLock.answerLanguage,
    explanationLanguage: langLock && langLock.explanationLanguage,
    _resolveStart: null
  };
  tasks.set(requestId, task);
  byConversation.set(conversationId, requestId);

  const whenReady = new Promise((resolve) => { task._resolveStart = resolve; });
  if (runningCount < CTM_MAX_CONCURRENT) {
    task.status = STATUS.RUNNING;
    runningCount++;
    resolveNextTick(() => task._resolveStart && task._resolveStart());
  } else {
    queue.push(requestId);
  }
  persistSnapshot();
  notify(conversationId, { type: 'start', task });
  return { task, whenReady, signal: controller.signal };
}
function resolveNextTick(fn) { Promise.resolve().then(fn); }

/** PHẦN G: gọi khi nhận delta — mọi event phải kèm conversationId/requestId (đã có trong task). */
function appendDelta(requestId, chunk) {
  const t = tasks.get(requestId);
  if (!t || t.status === STATUS.CANCELLED) return; // response cũ bị hủy không được "chui" vào state nữa
  t.text += chunk;
  t.updatedAt = Date.now();
  notify(t.conversationId, { type: 'delta', task: t, chunk });
}
function setStatus(requestId, message, state) {
  const t = tasks.get(requestId);
  if (!t) return;
  notify(t.conversationId, { type: 'statusMsg', task: t, message, state });
}

/** PHẦN H: hoàn thành — persist kết quả cuối, dọn task khỏi registry "đang active" nhưng vẫn phát
 * event completed 1 lần cho listener hiện có (nếu conversation đang mở) trước khi gỡ. */
function completeTask(requestId, result) {
  const t = tasks.get(requestId);
  if (!t) return;
  t.status = STATUS.COMPLETED;
  t.partial = false;
  t.completedAt = Date.now();
  t.updatedAt = t.completedAt;
  t.provider = (result && result.provider) || t.provider;
  t.model = (result && result.model) || t.model;
  t.usage = (result && result.usage) || null;
  t.finishReason = (result && result.finishReason) || null;
  finalizeTask(t);
}
function failTask(requestId, error) {
  const t = tasks.get(requestId);
  if (!t) return;
  t.status = (error && (error.cancelled || error.name === 'AbortError')) ? STATUS.CANCELLED : STATUS.FAILED;
  t.error = error ? (error.message || String(error)) : 'unknown error';
  t.completedAt = Date.now();
  t.updatedAt = t.completedAt;
  finalizeTask(t);
}
function finalizeTask(t) {
  notify(t.conversationId, { type: t.status === STATUS.COMPLETED ? 'done' : (t.status === STATUS.CANCELLED ? 'cancelled' : 'error'), task: t });
  if (byConversation.get(t.conversationId) === t.requestId) byConversation.delete(t.conversationId);
  runningCount = Math.max(0, runningCount - 1);
  // PHẦN AZ: cleanup — bỏ khỏi registry active sau 1 nhịp (đủ thời gian cho listener hiện tại đọc
  // state cuối) thay vì giữ vô hạn; controller/abort listener cũng được GC theo vì không còn tham
  // chiếu nào giữ task lại ngoài closure ngắn hạn này.
  setTimeout(() => { tasks.delete(t.requestId); persistSnapshot(); }, 30000);
  runNextQueued();
  persistSnapshot();
}

/** PHẦN D: Stop CHỈ abort task của ĐÚNG conversation được chỉ định — không đụng conversation khác. */
function abortActiveTask(conversationId) {
  const requestId = byConversation.get(conversationId);
  const t = requestId && tasks.get(requestId);
  if (t && t.controller && !t.controller.signal.aborted) t.controller.abort();
}

function isGenerating(conversationId) {
  const requestId = byConversation.get(conversationId);
  const t = requestId && tasks.get(requestId);
  return !!t && (t.status === STATUS.RUNNING || t.status === STATUS.QUEUED);
}
function getActiveTask(conversationId) {
  const requestId = byConversation.get(conversationId);
  return requestId ? tasks.get(requestId) : null;
}

/** PHẦN E: UI đăng ký lắng nghe 1 conversation cụ thể — KHÔNG ảnh hưởng việc task có chạy tiếp hay
 * không (detach UI chỉ ngưng NHẬN sự kiện, task vẫn chạy nền). Trả về hàm huỷ đăng ký (detach). */
function attach(conversationId, cb) {
  if (!listeners.has(conversationId)) listeners.set(conversationId, new Set());
  listeners.get(conversationId).add(cb);
  return () => { const s = listeners.get(conversationId); if (s) s.delete(cb); };
}
function detachAll(conversationId) { listeners.delete(conversationId); }

// PHẦN I: nhận sync từ tab khác — CHỈ dùng để hiển thị badge "đang chạy ở tab khác" một cách an
// toàn (KHÔNG tự ý chạy tiếp continuation hộ tab kia — mỗi tab chỉ điều khiển task DO CHÍNH NÓ tạo,
// tránh duplicate). Nếu cần điều phối chặt hơn (single-writer thật sự), CTM_LOCK_KEY (localStorage)
// dùng làm khoá tranh chấp đơn giản giữa các tab khi cần mở rộng về sau.
if (bc) {
  bc.onmessage = (ev) => {
    const data = ev.data;
    if (!data || data.owner === OWNER_TOKEN) return; // bỏ qua message do chính tab này gửi
    const set = listeners.get(data.conversationId);
    if (set) set.forEach((cb) => { try { cb({ type: 'remoteTabEvent', remote: true, ...data }); } catch (e) { /* ignore */ } });
  };
}

window.conversationTaskManager = {
  STATUS, OWNER_TOKEN,
  beginTask, appendDelta, setStatus, completeTask, failTask,
  abortActiveTask, isGenerating, getActiveTask, attach, detachAll
};
