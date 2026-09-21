'use strict';

// ============================================================================================
// PHẦN BG/20/21/41 — TEST SERVER-SIDE JOB STORE + PHỤC HỒI SAU KHI ĐÓNG TAB
// ============================================================================================
// (a) UNIT — server/utils/aiJobStore.js: vòng đời job, idempotent, không lưu dữ liệu thừa,
//     durable=false khi chưa cấu hình KV (KHÔNG được giả vờ bền vững).
// (b) WIRING — chat.js ghi job qua ĐÚNG MỘT điểm (sseWrite) + có route GET /jobs/:requestId,
//     client gửi clientRequestId, task manager nhận lại kết quả mà không tự bịa trạng thái.
// Chạy: node test/ai-job-store.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); passed += 1; }
  catch (e) { console.log(` FAIL - ${name}\n        ${e.message}`); failed += 1; }
}
const asyncTests = [];
function testAsync(name, fn) { asyncTests.push({ name, fn }); }

const root = path.join(__dirname, '..');
const store = require(path.join(root, 'server', 'utils', 'aiJobStore.js'));
const chatSrc = fs.readFileSync(path.join(root, 'server', 'routes', 'chat.js'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
const ctmSrc = fs.readFileSync(path.join(root, 'public', 'js', 'tasks', 'conversationTaskManager.js'), 'utf8');
const uiSrc = fs.readFileSync(path.join(root, 'public', 'js', 'tasks', 'backgroundTaskUI.js'), 'utf8');

console.log('\n== (a) UNIT: vòng đời job ==');

test('J1. createJob: không có requestId -> null (client cũ vẫn chạy bình thường)', () => {
  store.__resetForTest();
  assert.strictEqual(store.createJob({}), null);
  assert.strictEqual(store.createJob({ requestId: '' }), null);
});

testAsync('J2. done qua sseWrite -> job COMPLETED kèm kết quả đọc lại được', async () => {
  store.__resetForTest();
  const job = store.createJob({ requestId: 'task_1', conversationId: 'convA', stage: 'detail', query: 'giải bài' });
  store.observeSseEvent(job, 'status', { state: 'GENERATING', message: '...' });
  store.observeSseEvent(job, 'done', { text: 'LỜI GIẢI', provider: 'gemini', partial: false, subjectId: 'toan' });
  const read = await store.getJob('task_1');
  assert.strictEqual(read.status, store.STATUS.COMPLETED);
  assert.strictEqual(read.result.text, 'LỜI GIẢI');
  assert.strictEqual(read.result.provider, 'gemini');
  assert.strictEqual(store.toPublic(read).conversationId, 'convA');
});

test('J3. finishJob idempotent — trạng thái kết thúc ĐẦU TIÊN được giữ', () => {
  store.__resetForTest();
  const job = store.createJob({ requestId: 'task_2', query: 'q' });
  store.observeSseEvent(job, 'done', { text: 'A' });
  store.observeSseEvent(job, 'error', { message: 'lỗi muộn' });
  assert.strictEqual(job.status, store.STATUS.COMPLETED);
  assert.strictEqual(job.result.text, 'A');
  assert.strictEqual(job.error, null);
});

test('J4. client ngắt kết nối -> CANCELLED, KHÔNG phải completed', () => {
  store.__resetForTest();
  const job = store.createJob({ requestId: 'task_3', query: 'q' });
  store.markDisconnected(job);
  assert.strictEqual(job.status, store.STATUS.CANCELLED);
  assert.strictEqual(job.error, 'client_disconnected');
  assert.notStrictEqual(job.status, store.STATUS.COMPLETED);
});

test('J5. ngắt kết nối SAU khi done -> giữ nguyên kết quả đã có (không đè)', () => {
  store.__resetForTest();
  const job = store.createJob({ requestId: 'task_4', query: 'q' });
  store.observeSseEvent(job, 'done', { text: 'đã xong' });
  store.markDisconnected(job);
  assert.strictEqual(job.status, store.STATUS.COMPLETED);
  assert.strictEqual(job.result.text, 'đã xong');
});

test('J6. error -> FAILED kèm lý do, không có result giả', () => {
  store.__resetForTest();
  const job = store.createJob({ requestId: 'task_5', query: 'q' });
  store.observeSseEvent(job, 'error', { message: 'provider quá tải', code: 'PROVIDER_UNAVAILABLE' });
  assert.strictEqual(job.status, store.STATUS.FAILED);
  assert.ok(job.error);
  assert.strictEqual(job.result, null);
});

test('J7. visual:ready đến SAU done -> gộp vào kết quả, không đổi trạng thái', () => {
  store.__resetForTest();
  const job = store.createJob({ requestId: 'task_6', query: 'q' });
  store.observeSseEvent(job, 'done', { text: 'x', visualStatus: null });
  store.observeSseEvent(job, 'visual:ready', { id: 'img1' });
  assert.strictEqual(job.status, store.STATUS.COMPLETED);
  assert.strictEqual(job.result.visuals.length, 1);
  assert.strictEqual(job.result.visualStatus, 'ready');
});

test('J8. KHÔNG lưu prompt/context/ảnh — chỉ field cần để dựng lại câu trả lời', () => {
  store.__resetForTest();
  const job = store.createJob({ requestId: 'task_7', query: 'q' });
  store.observeSseEvent(job, 'done', {
    text: 'x', provider: 'p',
    systemPrompt: 'BÍ MẬT', contexts: [{ text: 'nguồn dài' }], image: { base64: 'AAAA' }, apiKey: 'sk-xxx'
  });
  const keys = Object.keys(job.result);
  ['systemPrompt', 'contexts', 'image', 'apiKey'].forEach((k) => {
    assert.ok(!keys.includes(k), `job lưu nhầm field nhạy cảm/nặng: ${k}`);
  });
});

test('J9. text quá dài bị cắt có KHAI BÁO (truncatedForStorage), không cắt im lặng', () => {
  store.__resetForTest();
  const job = store.createJob({ requestId: 'task_8', query: 'q' });
  store.observeSseEvent(job, 'done', { text: 'x'.repeat(400000) });
  assert.strictEqual(job.result.truncatedForStorage, true);
  assert.ok(job.result.text.length <= 200000);
});

testAsync('J10. chưa cấu hình KV -> durable=false và getJob của instance khác không có gì', async () => {
  store.__resetForTest();
  assert.strictEqual(store.isDurable(), false, 'sandbox không có KV env -> phải là false');
  const job = store.createJob({ requestId: 'task_9', query: 'q' });
  assert.strictEqual(job.durable, false, 'không được đánh dấu durable khi chỉ có RAM');
  assert.strictEqual(store.toPublic(job).durable, false);
  assert.ok((await store.getJob('task_9')), 'cùng instance thì vẫn đọc được (RAM)');
  assert.strictEqual(await store.getJob('không-tồn-tại'), null);
});

test('J11. getStats báo đúng tình trạng lưu trữ', () => {
  store.__resetForTest();
  const st = store.getStats();
  assert.strictEqual(st.durable, false);
  assert.strictEqual(st.ramJobs, 0);
  assert.ok(st.ttlSeconds > 0, 'phải có TTL để KV không phình vô hạn (mục 20)');
});

console.log('\n== (b) WIRING: chat.js, client, task manager ==');

test('J12. chat.js ghi job qua ĐÚNG MỘT điểm sseWrite (không sót nhánh done nào)', () => {
  const sse = chatSrc.slice(chatSrc.indexOf('function sseWrite'), chatSrc.indexOf('function sseHeaders'));
  assert.ok(/res\.__aiJob/.test(sse) && /observeSseEvent/.test(sse),
    'sseWrite phải là nơi ghi nhận job — nếu ghi rải rác sẽ sót nhánh cache-hit/direct/visual');
  const doneBranches = (chatSrc.match(/sseWrite\(res, 'done'/g) || []).length;
  assert.ok(doneBranches >= 3, `phải có nhiều nhánh done (${doneBranches}) — càng chứng minh cần hook 1 chỗ`);
});

test('J13. chat.js: nhánh KHÔNG streaming (res.json) cũng ghi job', () => {
  assert.ok(/res\.json = \(payload\)/.test(chatSrc), 'thiếu hook res.json -> non-stream không có job');
  assert.ok(/finishJob\(res\.__aiJob, \{ status: aiJobStore\.STATUS\.FAILED/.test(chatSrc),
    'lỗi HTTP >=400 phải ghi FAILED, không ghi COMPLETED');
});

test('J14. có route GET /api/chat/jobs/:requestId, trả durable tường minh', () => {
  assert.ok(/router\.get\('\/jobs\/:requestId'/.test(chatSrc), 'thiếu route đọc job');
  const route = chatSrc.slice(chatSrc.indexOf("router.get('/jobs/:requestId'"));
  assert.ok(/durable: aiJobStore\.isDurable\(\)/.test(route), '404 phải kèm trạng thái durable');
  assert.ok(/status\(400\)/.test(route), 'requestId rác phải bị từ chối');
  assert.ok(/status\(404\)/.test(route), 'không tìm thấy phải là 404, không phải 500');
});

test('J15. client ngắt kết nối được ghi nhận trong res.on(close)', () => {
  const closeHandler = chatSrc.slice(chatSrc.indexOf("res.on('close', () => {\n    if (res.writableEnded)"), chatSrc.indexOf('const signal = abortController.signal;'));
  assert.ok(/markDisconnected/.test(closeHandler), 'đóng kết nối phải ghi CANCELLED vào job');
});

test('J16. client gửi clientRequestId ở CẢ hướng giải lẫn giải chi tiết', () => {
  const hits = (appJs.match(/clientRequestId: taskHandle \? taskHandle\.task\.requestId : undefined/g) || []).length;
  assert.strictEqual(hits, 2, 'thiếu ở 1 trong 2 giai đoạn -> giai đoạn đó không phục hồi được');
  assert.ok(/recoverJob\(requestId\)/.test(appJs), 'appTaskBridge phải có recoverJob()');
  assert.ok(/'\/api\/chat\/jobs\/' \+ encodeURIComponent\(requestId\)/.test(appJs), 'phải gọi đúng endpoint job');
});

test('J17. phục hồi = UPDATE message theo requestId, KHÔNG insert message mới (mục 29)', () => {
  const rec = appJs.slice(appJs.indexOf('async recoverJob('), appJs.indexOf('loadAll();'));
  assert.ok(/m\.requestId === requestId \|\| m\.detailRequestId === requestId/.test(rec),
    'phải tìm message theo requestId');
  assert.ok(!/messages\.push\(/.test(rec), 'phục hồi mà push message mới -> duplicate câu trả lời');
  assert.ok(/if \(!msg\.approach\)/.test(rec) && /if \(!msg\.detail\)/.test(rec),
    'chỉ ghi khi phần đó còn trống — không đè lên nội dung đã có');
});

test('J18. UI có nút "Lấy lại kết quả" CHỈ cho task INTERRUPTED', () => {
  assert.ok(/STATUS\.INTERRUPTED/.test(uiSrc), 'thiếu nhánh riêng cho task bị gián đoạn');
  assert.ok(/background\.recover/.test(uiSrc));
  assert.ok(/b\.recoverJob\(task\.requestId\)/.test(uiSrc));
});

test('J19. popup kéo được bằng thanh tiêu đề, bỏ qua trên mobile', () => {
  assert.ok(/function enableDrag\(/.test(uiSrc), 'thiếu kéo–thả');
  const drag = uiSrc.slice(uiSrc.indexOf('function enableDrag('), uiSrc.indexOf('/* ---------------- khởi tạo'));
  assert.ok(/pointerdown/.test(drag) && /pointermove/.test(drag) && /pointerup/.test(drag));
  assert.ok(/innerWidth \|\| 1024\) <= 760/.test(drag), 'mobile (bottom sheet) không được kéo');
  assert.ok(/rec-close/.test(drag), 'bấm nút Đóng không được bị hiểu là bắt đầu kéo');
  assert.ok(/Math\.min\(Math\.max\(0,/.test(drag), 'phải kẹp trong khung nhìn, tránh kéo panel ra ngoài màn hình');
});

console.log('\n== (c) RUNTIME: task manager nhận lại kết quả ==');

function loadCtm() {
  const ls = (() => {
    const s = {};
    return { getItem: (k) => (k in s ? s[k] : null), setItem: (k, v) => { s[k] = String(v); }, removeItem: (k) => { delete s[k]; }, __s: s };
  })();
  const win = {
    localStorage: ls, addEventListener: () => {},
    crypto: { randomUUID: () => 'o' + Math.random().toString(36).slice(2) }
  };
  const sandbox = {
    window: win, localStorage: ls, console: { info() {}, error() {}, warn() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Promise,
    AbortController, Math, JSON, RegExp, Number, String, Object, Array, Error
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(ctmSrc, sandbox);
  return { ctm: win.conversationTaskManager, ls };
}
/** Dựng 1 task INTERRUPTED y như sau khi reload trang. */
function makeInterrupted() {
  const a = loadCtm();
  const h = a.ctm.beginTask('convA', { query: 'bài dài' });
  a.ctm.appendDelta(h.task.requestId, 'abc');
  a.ctm.flushSnapshot();
  const b = loadCtm();
  b.ls.__s['trogiai.tasks.v2'] = a.ls.__s['trogiai.tasks.v2'];
  const c = loadCtm();
  // nạp lại với đúng snapshot (loadCtm đọc storage lúc khởi tạo -> phải bơm trước khi chạy)
  const ls = a.ls;
  const win = { localStorage: ls, addEventListener: () => {}, crypto: { randomUUID: () => 'o1' } };
  const sandbox = {
    window: win, localStorage: ls, console: { info() {}, error() {}, warn() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Promise,
    AbortController, Math, JSON, RegExp, Number, String, Object, Array, Error
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(ctmSrc, sandbox);
  void b; void c;
  return { ctm: win.conversationTaskManager, requestId: h.task.requestId };
}

test('J20. adoptRecoveredResult: completed -> COMPLETED, chưa xem, không notify lại', () => {
  const { ctm, requestId } = makeInterrupted();
  assert.strictEqual(ctm.getTask(requestId).status, ctm.STATUS.INTERRUPTED);
  const out = ctm.adoptRecoveredResult(requestId, { status: 'completed', text: 'LỜI GIẢI ĐẦY ĐỦ', provider: 'gemini' });
  assert.ok(out);
  const t = ctm.getTask(requestId);
  assert.strictEqual(t.status, ctm.STATUS.COMPLETED);
  assert.strictEqual(t.text, 'LỜI GIẢI ĐẦY ĐỦ');
  assert.strictEqual(t.seen, false, 'phải hiện badge "có câu trả lời mới"');
  assert.strictEqual(t.notified, true, 'không được bắn notification muộn sau reload');
  assert.strictEqual(ctm.getUnseenCount(), 1);
});

test('J21. job vẫn đang chạy ở server -> KHÔNG đoán, giữ nguyên INTERRUPTED', () => {
  const { ctm, requestId } = makeInterrupted();
  const out = ctm.adoptRecoveredResult(requestId, { status: 'running' });
  assert.strictEqual(out, null);
  assert.strictEqual(ctm.getTask(requestId).status, ctm.STATUS.INTERRUPTED);
});

test('J22. không được "hồi sinh" task đang chạy bằng kết quả cũ', () => {
  const { ctm } = loadCtm();
  const h = ctm.beginTask('convA', { query: 'q' });
  const out = ctm.adoptRecoveredResult(h.task.requestId, { status: 'completed', text: 'cũ' });
  assert.strictEqual(out, null);
  assert.strictEqual(ctm.getTask(h.task.requestId).status, ctm.STATUS.RUNNING);
  assert.strictEqual(ctm.getTask(h.task.requestId).text, '');
});

test('J23. job failed/cancelled cũng được phản ánh đúng, không thành "đã xong"', () => {
  const a = makeInterrupted();
  a.ctm.adoptRecoveredResult(a.requestId, { status: 'failed', error: 'provider lỗi' });
  assert.strictEqual(a.ctm.getTask(a.requestId).status, a.ctm.STATUS.FAILED);
  const b = makeInterrupted();
  b.ctm.adoptRecoveredResult(b.requestId, { status: 'cancelled', error: 'client_disconnected' });
  assert.strictEqual(b.ctm.getTask(b.requestId).status, b.ctm.STATUS.CANCELLED);
});

test('J24. getInterruptedTasks liệt kê đúng ứng viên cần hỏi lại server', () => {
  const { ctm, requestId } = makeInterrupted();
  const list = ctm.getInterruptedTasks();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].requestId, requestId);
  ctm.adoptRecoveredResult(requestId, { status: 'completed', text: 'x' });
  assert.strictEqual(ctm.getInterruptedTasks().length, 0);
});

(async () => {
  for (const { name, fn } of asyncTests) {
    try { await fn(); console.log(`  ok  - ${name}`); passed += 1; }
    catch (e) { console.log(` FAIL - ${name}\n        ${e.message}`); failed += 1; }
  }
  console.log(`\n== KẾT QUẢ: ${passed} ok, ${failed} fail ==`);
  if (failed > 0) process.exit(1);
})();
