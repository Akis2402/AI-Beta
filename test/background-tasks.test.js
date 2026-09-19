'use strict';

// ============================================================================================
// PHẦN BG — TEST TÁC VỤ AI CHẠY NỀN (background task panel / badge / notification)
// ============================================================================================
// Hai nhóm:
//   (a) STATIC — đọc chính file nguồn thật: DOM id, thứ tự <script>, i18n vi/en, CSS, build asset,
//       và các BẤT BIẾN nguy hiểm trong app.js (không abort khi ẩn tab/đổi conversation/unload,
//       thứ tự "lưu kết quả -> completeTask").
//   (b) RUNTIME — nạp public/js/tasks/conversationTaskManager.js trong 1 window giả rồi diễn lại
//       đủ vòng đời: queue/concurrency, ẩn tab, Dừng đúng 1 conversation, unseen badge, notify 1
//       lần, khôi phục snapshot sau reload (KHÔNG completed giả), RECOVERING.
// Chạy: node test/background-tasks.test.js

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
// Test cần chờ debounce/timer thật — chạy tuần tự ở cuối file (đợi xong mới in kết quả).
const asyncTests = [];
function testAsync(name, fn) { asyncTests.push({ name, fn }); }

const root = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
const ctmSrc = fs.readFileSync(path.join(root, 'public', 'js', 'tasks', 'conversationTaskManager.js'), 'utf8');
const uiSrc = fs.readFileSync(path.join(root, 'public', 'js', 'tasks', 'backgroundTaskUI.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(root, 'public', 'css', 'styles.css'), 'utf8');
const buildSrc = fs.readFileSync(path.join(root, 'scripts', 'build.js'), 'utf8');
const { scriptSrcs } = require('./_htmlAssets');

console.log('\n== (a) STATIC: DOM, asset, i18n, CSS, bất biến trong app.js ==');

test('BG1. index.html có đủ id cho badge + popup + toast', () => {
  ['bgTaskBtn', 'bgTaskBadge', 'bgTaskPanel', 'bgTaskList', 'bgTaskEmpty',
    'bgTaskCloseBtn', 'bgTaskNotifyToggle', 'bgTaskNotifyHint', 'toastHost'].forEach((id) => {
    assert.ok(new RegExp(`id="${id}"`).test(indexHtml), `thiếu id="${id}"`);
  });
});

test('BG2. popup có role="dialog" + nhãn i18n (accessibility, mục 34)', () => {
  const panel = indexHtml.match(/<aside id="bgTaskPanel"[\s\S]*?>/)[0];
  assert.ok(/role="dialog"/.test(panel), 'thiếu role="dialog"');
  assert.ok(/aria-label=/.test(panel) && /data-i18n-aria-label=/.test(panel), 'thiếu aria-label qua i18n');
  const btn = indexHtml.match(/<button id="bgTaskBtn"[\s\S]*?<\/button>/)[0];
  assert.ok(/aria-expanded=/.test(btn) && /aria-controls="bgTaskPanel"/.test(btn));
  assert.ok(/bgtask-sr/.test(btn), 'badge phải kèm nhãn chữ cho screen reader, không chỉ dựa vào màu');
});

test('BG3. thứ tự script: conversationTaskManager -> backgroundTaskUI -> app.js', () => {
  const srcs = scriptSrcs(indexHtml);
  const iCtm = srcs.indexOf('/js/tasks/conversationTaskManager.js');
  const iUi = srcs.indexOf('/js/tasks/backgroundTaskUI.js');
  const iApp = srcs.indexOf('/js/app.js');
  assert.ok(iCtm >= 0 && iUi >= 0 && iApp >= 0, 'thiếu 1 trong 3 thẻ script');
  assert.ok(iCtm < iUi, 'backgroundTaskUI đọc window.conversationTaskManager -> phải nạp sau');
  assert.ok(iUi < iApp, 'app.js gắn window.appTaskBridge, UI đọc lazily -> UI nạp trước vẫn đúng thứ tự dự kiến');
});

test('BG4. backgroundTaskUI.js được fingerprint trong scripts/build.js', () => {
  assert.ok(/'backgroundTaskUI\.js'/.test(buildSrc),
    'asset mới phải nằm trong TASK_JS, nếu không deploy sẽ cache sai giữa 2 bản');
  assert.ok(fs.existsSync(path.join(root, 'public', 'js', 'tasks', 'backgroundTaskUI.js')));
});

test('BG5. i18n có đủ key background.* ở CẢ vi và en (mục 33)', () => {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'js', 'i18n', 'translations.js'), 'utf8'), sandbox);
  const T = sandbox.window.TRANSLATIONS;
  const need = [
    'background.title', 'background.running', 'background.queued', 'background.completed',
    'background.failed', 'background.open', 'background.close', 'background.newAnswer',
    'background.notificationTitle', 'background.notificationBody', 'background.viewAnswer',
    'background.runningInBackground', 'background.recovering', 'background.interrupted',
    'background.notifyLabel', 'background.toastDone', 'background.toastFailed'
  ];
  need.forEach((k) => {
    assert.ok(T.vi[k], `thiếu key vi "${k}"`);
    assert.ok(T.en[k], `thiếu key en "${k}"`);
  });
});

/** Bỏ comment (// và /* *\/) để chỉ soi phần MÃ THỰC THI, không soi phần giải thích tiếng Việt. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('BG6. UI module KHÔNG hard-code chuỗi giao diện (mọi text đi qua t())', () => {
  const code = stripComments(uiSrc);
  // Chuỗi literal 1 dòng (không cho match nhảy qua xuống dòng để dính phải comment cuối dòng).
  const vietnamese = code.match(/'[^'\n]*[àáảãạăâđêôơưÀÁẢÃẠĂÂĐÊÔƠƯ][^'\n]*'/g) || [];
  assert.strictEqual(vietnamese.length, 0, `còn chuỗi tiếng Việt hard-code: ${vietnamese.slice(0, 3).join(', ')}`);
  assert.ok(/tr\('background\./.test(code), 'phải dùng t()/tr() cho text');
});

test('BG7. CSS có style panel/badge/toast/unseen + tôn trọng prefers-reduced-motion (mục 35)', () => {
  ['#bgTaskPanel', '.bgtask-badge', '.bgtask-item', '.app-toast', '.hist-unseen-badge', '.sr-only']
    .forEach((sel) => assert.ok(cssSrc.includes(sel), `thiếu style ${sel}`));
  assert.ok(/#bgTaskPanel\.open/.test(cssSrc), 'thiếu trạng thái mở');
  const reduced = cssSrc.slice(cssSrc.lastIndexOf('@media (prefers-reduced-motion:reduce)'));
  assert.ok(/#bgTaskPanel/.test(reduced) && /app-toast/.test(reduced),
    'panel/toast phải nằm trong khối prefers-reduced-motion');
  assert.ok(/max-width:760px/.test(cssSrc.slice(cssSrc.indexOf('#bgTaskPanel'))),
    'mobile phải có dạng bottom sheet');
});

test('BG8. KHÔNG có đường nào abort task khi ẩn tab / unload / mất focus (mục 6/24/39/40)', () => {
  const sources = { 'app.js': appJs, 'backgroundTaskUI.js': uiSrc, 'conversationTaskManager.js': ctmSrc };
  Object.entries(sources).forEach(([name, src]) => {
    const code = stripComments(src);
    // Chỉ tính là LỆNH GỌI thật (có dấu mở ngoặc) — danh sách export `abortTask, ...` không phải gọi.
    const risky = /(visibilitychange|beforeunload|pagehide|'blur')[\s\S]{0,200}?(abortActiveTask\(|abortTask\(|\.abort\(\))/;
    assert.ok(!risky.test(code),
      `${name}: có vẻ abort task trong handler ẩn tab/unload/blur — UI lifecycle KHÔNG được quyết định AI lifecycle`);
  });
});

test('BG9. app.js: mở conversation -> markConversationSeen; có window.appTaskBridge đủ 4 hàm', () => {
  assert.ok(/markConversationSeen\(id\)/.test(appJs), 'loadConversation phải xoá badge "chưa xem"');
  assert.ok(/window\.appTaskBridge\s*=/.test(appJs), 'thiếu cầu nối appTaskBridge');
  ['isViewing', 'openConversation', 'getConversationTitle', 'syncActiveConversation']
    .forEach((fn) => assert.ok(new RegExp(`${fn}\\s*\\(`).test(appJs), `appTaskBridge thiếu ${fn}()`));
  assert.ok(/hasUnseen\(conv\.id\)/.test(appJs), 'danh sách lịch sử phải có badge "có câu trả lời mới"');
});

test('BG10. mục 19 — lưu kết quả TRƯỚC, completeTask (=> toast/notification) SAU', () => {
  // Trong CẢ sendMessage lẫn fetchDetail: touchConversation(...) phải đứng TRƯỚC completeTask().
  const occurrences = [...appJs.matchAll(/ctm\.completeTask\(/g)].map((m) => m.index);
  assert.strictEqual(occurrences.length, 2, 'phải có đúng 2 điểm completeTask (approach + detail)');
  occurrences.forEach((idx) => {
    const before = appJs.slice(Math.max(0, idx - 1600), idx);
    assert.ok(/touchConversation\(/.test(before),
      'completeTask() chạy trước khi lưu conversation -> người dùng có thể bấm thông báo mà chưa có kết quả');
  });
});

test('BG11. task mang theo query/title/stage để panel hiển thị đúng bài đang giải', () => {
  assert.ok(/beginTask\([\s\S]{0,200}stage: 'approach'/.test(appJs), 'thiếu stage approach');
  assert.ok(/beginTask\([\s\S]{0,200}stage: 'detail'/.test(appJs), 'thiếu stage detail');
  assert.ok(/aiMsgObj\.requestId = taskHandle\.task\.requestId/.test(appJs),
    'mục 29: message phải correlate requestId để không insert trùng');
});

console.log('\n== (b) RUNTIME: vòng đời task trong window giả ==');

/** localStorage giả, chia sẻ được giữa 2 lần "reload". */
function makeStorage(initial) {
  const store = Object.assign({}, initial || {});
  return {
    store,
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };
}

/** Nạp conversationTaskManager.js vào 1 window giả (không BroadcastChannel, không DOM). */
function loadCtm({ storage, viewing } = {}) {
  const ls = storage || makeStorage();
  const win = {
    localStorage: ls,
    addEventListener: () => {},
    crypto: { randomUUID: () => 'owner-' + Math.random().toString(36).slice(2) },
    appTaskBridge: { isViewing: (id) => (viewing ? viewing() === id : false) }
  };
  const sandbox = {
    window: win, localStorage: ls, console: { info() {}, error() {}, warn() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Promise,
    AbortController, Math, JSON, RegExp, Number, String, Object, Array, Error
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(ctmSrc, sandbox);
  return { ctm: win.conversationTaskManager, win, ls };
}

test('BG12. ẩn tab KHÔNG abort, KHÔNG đổi trạng thái task — chỉ gắn nhãn chạy nền (Case 1)', () => {
  const { ctm } = loadCtm();
  const h = ctm.beginTask('convA', { query: 'giải phương trình', stage: 'approach' });
  ctm.setUiHidden(true);
  assert.strictEqual(h.signal.aborted, false, 'tab ẩn mà signal bị abort');
  assert.strictEqual(ctm.getTask(h.task.requestId).status, ctm.STATUS.RUNNING);
  assert.strictEqual(ctm.getTask(h.task.requestId).backgrounded, true, 'phải được đánh dấu chạy nền');
  ctm.appendDelta(h.task.requestId, 'ABC'); // vẫn nhận delta bình thường khi tab ẩn
  assert.strictEqual(ctm.getTask(h.task.requestId).text, 'ABC');
  ctm.setUiHidden(false);
  const t = ctm.getTask(h.task.requestId);
  assert.strictEqual(t.backgrounded, false);
  assert.ok(t.backgroundMs >= 0, 'phải đo được thời gian đã chạy nền (mục 31)');
});

test('BG13. Dừng CHỈ huỷ đúng conversation được chỉ định (Case 7)', () => {
  const { ctm } = loadCtm();
  const a = ctm.beginTask('convA', { query: 'A' });
  const b = ctm.beginTask('convB', { query: 'B' });
  ctm.abortActiveTask('convA');
  assert.strictEqual(a.signal.aborted, true);
  assert.strictEqual(b.signal.aborted, false, 'task của conversation khác bị huỷ lây');
  ctm.failTask(a.task.requestId, { name: 'AbortError' });
  assert.strictEqual(ctm.getTask(a.task.requestId).status, ctm.STATUS.CANCELLED);
  assert.strictEqual(ctm.isGenerating('convB'), true, 'convB vẫn phải đang chạy');
});

test('BG14. concurrency: quá giới hạn -> QUEUED, xong 1 task thì task chờ được chạy (Case 8)', () => {
  const { ctm } = loadCtm();
  const max = ctm.CTM_MAX_CONCURRENT;
  const handles = [];
  for (let i = 0; i < max + 1; i++) handles.push(ctm.beginTask('conv' + i, { query: 'q' + i }));
  const last = handles[handles.length - 1].task.requestId;
  assert.strictEqual(ctm.getTask(last).status, ctm.STATUS.QUEUED, 'task thứ N+1 phải vào hàng chờ');
  assert.strictEqual(ctm.getRunningTasks().filter((t) => t.status === ctm.STATUS.RUNNING).length, max);
  ctm.completeTask(handles[0].task.requestId, { text: 'xong' });
  assert.strictEqual(ctm.getTask(last).status, ctm.STATUS.RUNNING, 'task chờ phải được chạy tiếp');
});

test('BG15. hoàn tất khi đang xem conversation KHÁC -> chưa xem; mở lại -> hết badge (Case 5/6)', () => {
  let current = 'convB';
  const { ctm } = loadCtm({ viewing: () => current });
  const h = ctm.beginTask('convA', { query: 'bài toán', title: 'Toán' });
  ctm.completeTask(h.task.requestId, { text: 'lời giải', provider: 'x' });
  assert.strictEqual(ctm.getUnseenCount(), 1);
  assert.strictEqual(ctm.hasUnseen('convA'), true);
  assert.strictEqual(ctm.hasUnseen('convB'), false);
  ctm.markConversationSeen('convA');
  assert.strictEqual(ctm.getUnseenCount(), 0);
  assert.strictEqual(ctm.hasUnseen('convA'), false);
});

test('BG16. hoàn tất khi ĐANG xem đúng conversation và tab hiện -> không tính "chưa xem"', () => {
  const { ctm } = loadCtm({ viewing: () => 'convA' });
  const h = ctm.beginTask('convA', { query: 'x' });
  ctm.completeTask(h.task.requestId, { text: 'y' });
  assert.strictEqual(ctm.getUnseenCount(), 0, 'người dùng đang nhìn thẳng vào kết quả -> không cần badge');
});

test('BG17. notification chỉ 1 lần/1 task; done xử lý đúng 1 lần (mục 14/23/32)', () => {
  const { ctm } = loadCtm();
  const events = [];
  ctm.subscribeAll((ev) => { if (ev.type === 'done') events.push(ev.requestId); });
  const h = ctm.beginTask('convA', { query: 'q' });
  ctm.completeTask(h.task.requestId, { text: 'a' });
  ctm.completeTask(h.task.requestId, { text: 'a' }); // gọi lại (SSE reconnect/render lại)
  assert.strictEqual(events.length, 1, 'done bị phát 2 lần -> notification/toast nhân đôi');
  assert.strictEqual(ctm.markNotified(h.task.requestId), true);
  assert.strictEqual(ctm.markNotified(h.task.requestId), false, 'task đã notify không được notify lại');
});

test('BG18. mọi event đều kèm conversationId + requestId (mục 10)', () => {
  const { ctm } = loadCtm();
  const seen = [];
  ctm.subscribeAll((ev) => seen.push(ev));
  const h = ctm.beginTask('convA', { query: 'q' });
  ctm.appendDelta(h.task.requestId, 'x');
  ctm.setStatus(h.task.requestId, 'đang giải', 'GENERATING');
  ctm.completeTask(h.task.requestId, { text: 'x' });
  assert.ok(seen.length >= 4);
  seen.forEach((ev) => {
    assert.strictEqual(ev.conversationId, 'convA', `event ${ev.type} thiếu conversationId`);
    assert.ok(ev.requestId, `event ${ev.type} thiếu requestId`);
  });
});

test('BG19. RECOVERING không bao giờ bị hiểu là đã xong (mục 18/12)', () => {
  const { ctm } = loadCtm();
  const h = ctm.beginTask('convA', { query: 'q' });
  ctm.setStatus(h.task.requestId, 'đang khôi phục', 'RECOVERING');
  const t = ctm.getTask(h.task.requestId);
  assert.strictEqual(t.status, ctm.STATUS.RECOVERING);
  assert.notStrictEqual(t.status, ctm.STATUS.COMPLETED);
  assert.strictEqual(ctm.isGenerating('convA'), true, 'RECOVERING vẫn phải tính là đang chạy');
  ctm.appendDelta(h.task.requestId, 'tiếp'); // nhận được text tiếp -> quay lại RUNNING
  assert.strictEqual(ctm.getTask(h.task.requestId).status, ctm.STATUS.RUNNING);
});

test('BG20. reload: task đang chạy của phiên trước -> INTERRUPTED, KHÔNG completed giả (Case 10)', () => {
  const ls = makeStorage();
  const first = loadCtm({ storage: ls });
  const h = first.ctm.beginTask('convA', { query: 'bài dài', title: 'Toán' });
  first.ctm.appendDelta(h.task.requestId, '123');
  first.ctm.flushSnapshot();

  const second = loadCtm({ storage: ls }); // "reload trang"
  const restored = second.ctm.getTask(h.task.requestId);
  assert.ok(restored, 'mất hẳn task sau reload -> người dùng không biết chuyện gì đã xảy ra');
  assert.strictEqual(restored.status, second.ctm.STATUS.INTERRUPTED);
  assert.notStrictEqual(restored.status, second.ctm.STATUS.COMPLETED);
  assert.strictEqual(restored.restored, true);
  assert.strictEqual(restored.notified, true, 'không được bắn lại notification sau reload');
  assert.strictEqual(second.ctm.isGenerating('convA'), false);
});

test('BG21. reload: kết quả xong-nhưng-chưa-xem vẫn còn badge; đã xem thì không giữ lại', () => {
  const ls = makeStorage();
  const first = loadCtm({ storage: ls, viewing: () => 'convOther' });
  const unseen = first.ctm.beginTask('convA', { query: 'a' });
  const seen = first.ctm.beginTask('convB', { query: 'b' });
  first.ctm.completeTask(unseen.task.requestId, { text: 'x' });
  first.ctm.completeTask(seen.task.requestId, { text: 'y' });
  first.ctm.markConversationSeen('convB');
  first.ctm.flushSnapshot();

  const second = loadCtm({ storage: ls });
  assert.strictEqual(second.ctm.getUnseenCount(), 1);
  assert.strictEqual(second.ctm.hasUnseen('convA'), true);
  assert.strictEqual(second.ctm.getTask(seen.task.requestId), null, 'task đã xem không cần giữ qua reload');
});

test('BG22. không được "xoá" task đang chạy khỏi panel; task đã kết thúc thì được', () => {
  const { ctm } = loadCtm();
  const h = ctm.beginTask('convA', { query: 'q' });
  assert.strictEqual(ctm.removeCompletedTask(h.task.requestId), false, 'task đang chạy không được xoá');
  ctm.completeTask(h.task.requestId, { text: 'x' });
  assert.strictEqual(ctm.removeCompletedTask(h.task.requestId), true);
  assert.strictEqual(ctm.getTask(h.task.requestId), null);
});

test('BG23. API cũ vẫn còn nguyên (backward compatibility, mục 9/37)', () => {
  const { ctm } = loadCtm();
  ['STATUS', 'OWNER_TOKEN', 'beginTask', 'appendDelta', 'setStatus', 'completeTask', 'failTask',
    'abortActiveTask', 'isGenerating', 'getActiveTask', 'attach', 'detachAll'].forEach((k) => {
    assert.ok(ctm[k] !== undefined, `mất API cũ: ${k}`);
  });
  ['getAllTasks', 'getRunningTasks', 'getCompletedTasks', 'getTask', 'getBackgroundTaskCount',
    'subscribeAll', 'markAsSeen', 'removeCompletedTask'].forEach((k) => {
    assert.strictEqual(typeof ctm[k], 'function', `thiếu API mới: ${k}`);
  });
});

test('BG24. detach UI KHÔNG dừng task; attach lại thấy đủ text đã tích luỹ (mục 30)', () => {
  const { ctm } = loadCtm();
  const h = ctm.beginTask('convA', { query: 'q' });
  const got = [];
  const detach = ctm.attach('convA', (ev) => { if (ev.type === 'delta') got.push(ev.chunk); });
  ctm.appendDelta(h.task.requestId, 'A');
  detach();                                   // người dùng chuyển sang conversation khác
  ctm.appendDelta(h.task.requestId, 'B');     // task vẫn chạy, vẫn tích luỹ
  ctm.appendDelta(h.task.requestId, 'C');
  assert.deepStrictEqual(got, ['A'], 'listener đã gỡ vẫn nhận event');
  assert.strictEqual(h.signal.aborted, false, 'detach UI làm abort task');
  assert.strictEqual(ctm.getTask(h.task.requestId).text, 'ABC', 'mất text đã stream khi UI detach');
});

test('BG25. badge đếm đúng: đang chạy + chưa xem (Case 4/27)', () => {
  const { ctm } = loadCtm({ viewing: () => 'convZ' });
  const a = ctm.beginTask('convA', { query: 'a' });
  ctm.beginTask('convB', { query: 'b' });
  assert.strictEqual(ctm.getBackgroundTaskCount(), 2);
  ctm.completeTask(a.task.requestId, { text: 'x' });
  assert.strictEqual(ctm.getBackgroundTaskCount(), 1, 'còn đúng 1 task đang chạy');
  assert.strictEqual(ctm.getUnseenCount(), 1, 'và 1 câu trả lời mới chưa xem');
  assert.strictEqual(ctm.getCompletedTasks().length, 1);
});

console.log('\n== (c) UI: panel/badge/toast trong DOM giả ==');

/* DOM giả tối thiểu — đủ cho backgroundTaskUI.js (không cần jsdom, không cần cài thêm gói). */
function makeNode(id) {
  const node = {
    id, children: [], listeners: {}, style: {}, attrs: {}, dataset: {}, textContent: '', _html: '',
    checked: false, disabled: false, isConnected: true, title: '',
    classes: new Set(),
    classList: {
      add: (c) => node.classes.add(c),
      remove: (c) => node.classes.delete(c),
      contains: (c) => node.classes.has(c),
      toggle: (c, on) => { if (on) node.classes.add(c); else node.classes.delete(c); }
    },
    set innerHTML(v) { node._html = v; node.children = []; },
    get innerHTML() { return node._html; },
    setAttribute: (k, v) => { node.attrs[k] = v; },
    getAttribute: (k) => node.attrs[k],
    addEventListener: (ev, fn) => { (node.listeners[ev] = node.listeners[ev] || []).push(fn); },
    appendChild: (c) => { node.children.push(c); return c; },
    removeChild: (c) => { node.children = node.children.filter((x) => x !== c); },
    remove: () => { node.isConnected = false; },
    contains: (other) => other === node,
    focus: () => { domState.focused = node; },
    querySelector: (sel) => {
      // Các phần tử con dựng bằng innerHTML trong UI module: trả về node giả theo selector.
      if (!node._sub) node._sub = {};
      if (!node._sub[sel]) node._sub[sel] = makeNode(sel);
      return node._sub[sel];
    },
    querySelectorAll: () => []
  };
  return node;
}
const domState = { focused: null };

function mountUi({ withDom = true } = {}) {
  const ids = ['bgTaskPanel', 'bgTaskBtn', 'bgTaskBadge', 'bgTaskList', 'bgTaskEmpty',
    'bgTaskNotifyToggle', 'bgTaskNotifyHint', 'bgTaskCloseBtn', 'toastHost'];
  const nodes = {};
  if (withDom) ids.forEach((id) => { nodes[id] = makeNode(id); });

  const docListeners = {};
  const winListeners = {};
  const ls = makeStorage();
  const win = {
    localStorage: ls,
    addEventListener: (ev, fn) => { (winListeners[ev] = winListeners[ev] || []).push(fn); },
    crypto: { randomUUID: () => 'owner-' + Math.random().toString(36).slice(2) },
    t: (k, vars) => (vars ? k + ':' + JSON.stringify(vars) : k),
    focus: () => {}
  };
  const doc = {
    readyState: 'complete',
    hidden: false,
    activeElement: null,
    hasFocus: () => true,
    getElementById: (id) => nodes[id] || null,
    createElement: () => makeNode('created'),
    addEventListener: (ev, fn) => { (docListeners[ev] = docListeners[ev] || []).push(fn); }
  };
  win.document = doc;

  // Task manager thật chạy trong CÙNG window giả -> UI đọc đúng state thật, không mock nửa vời.
  const sandbox = {
    window: win, document: doc, localStorage: ls,
    console: { info() {}, error() {}, warn() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Promise,
    AbortController, Math, JSON, RegExp, Number, String, Object, Array, Error
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(ctmSrc, sandbox);
  vm.runInNewContext(uiSrc, sandbox);
  return { ui: win.backgroundTaskUI, ctm: win.conversationTaskManager, nodes, doc, docListeners, winListeners, ls };
}

test('BG26. thiếu DOM (HTML cũ) -> module không crash, app vẫn chạy', () => {
  assert.doesNotThrow(() => mountUi({ withDom: false }));
});

test('BG27. badge hiện số task đang chạy, ẩn khi không còn gì (mục 7/27)', () => {
  const { ctm, nodes } = mountUi();
  assert.strictEqual(nodes.bgTaskBtn.style.display, 'none', 'chưa có task thì không chiếm chỗ trên topbar');
  const a = ctm.beginTask('convA', { query: 'a' });
  ctm.beginTask('convB', { query: 'b' });
  assert.strictEqual(nodes.bgTaskBadge.textContent, '2');
  assert.strictEqual(nodes.bgTaskBtn.style.display, '');
  assert.ok(nodes.bgTaskBtn.classes.has('has-running'));
  assert.ok(nodes.bgTaskBtn.attrs['aria-label'], 'badge phải có nhãn chữ (mục 34)');
  ctm.completeTask(a.task.requestId, { text: 'x' });
  // 1 đang chạy + 1 kết quả chưa xem = 2
  assert.strictEqual(nodes.bgTaskBadge.textContent, '2');
  assert.ok(nodes.bgTaskBtn.classes.has('has-unseen'));
});

test('BG28. mở/đóng popup KHÔNG dừng task nào (Case 3, mục 25)', () => {
  const { ui, ctm, nodes } = mountUi();
  const h = ctm.beginTask('convA', { query: 'a' });
  ui.open();
  assert.ok(nodes.bgTaskPanel.classes.has('open'));
  assert.strictEqual(nodes.bgTaskPanel.attrs['aria-hidden'], 'false');
  ui.close();
  assert.ok(!nodes.bgTaskPanel.classes.has('open'));
  assert.strictEqual(h.signal.aborted, false, 'đóng popup mà task bị huỷ');
  assert.strictEqual(ctm.isGenerating('convA'), true);
});

testAsync('BG29. visibilitychange chỉ gắn nhãn chạy nền, KHÔNG huỷ task (Case 1, mục 6)', async () => {
  const { ctm, doc, docListeners } = mountUi();
  const h = ctm.beginTask('convA', { query: 'a' });
  doc.hidden = true;
  assert.ok((docListeners.visibilitychange || []).length, 'module phải lắng nghe visibilitychange');
  docListeners.visibilitychange.forEach((fn) => fn());
  await new Promise((r) => setTimeout(r, 600)); // qua khỏi debounce 400ms
  assert.strictEqual(h.signal.aborted, false, 'ẩn tab mà task bị huỷ');
  assert.strictEqual(ctm.isUiHidden(), true);
  assert.strictEqual(ctm.getTask(h.task.requestId).backgrounded, true);
});

test('BG30. không có Notification API -> chỉ toast, không crash (Case 9, mục 13)', () => {
  const { ctm, nodes } = mountUi(); // window giả KHÔNG có Notification
  const h = ctm.beginTask('convA', { query: 'giải bài' });
  assert.doesNotThrow(() => ctm.completeTask(h.task.requestId, { text: 'xong' }));
  assert.strictEqual(nodes.toastHost.children.length, 1, 'phải có toast thay cho browser notification');
});

test('BG31. task bị Dừng KHÔNG sinh toast/notification (mục 32)', () => {
  const { ctm, nodes } = mountUi();
  const h = ctm.beginTask('convA', { query: 'a' });
  ctm.abortActiveTask('convA');
  ctm.failTask(h.task.requestId, { name: 'AbortError' });
  assert.strictEqual(nodes.toastHost.children.length, 0, 'người dùng tự bấm Dừng thì không cần báo lại');
});

(async () => {
  for (const { name, fn } of asyncTests) {
    try { await fn(); console.log(`  ok  - ${name}`); passed += 1; }
    catch (e) { console.log(` FAIL - ${name}\n        ${e.message}`); failed += 1; }
  }
  console.log(`\n== KẾT QUẢ: ${passed} ok, ${failed} fail ==`);
  if (failed > 0) process.exit(1);
})();
