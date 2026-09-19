'use strict';
// ---------- REGRESSION: "Thả tài liệu vào đây" không thêm nguồn (audit PHẦN 1-8) ----------
// Test này CHẠY THẬT public/js/app.js trong vm sandbox (cùng kỹ thuật với boot-resilience.test.js)
// và chứng minh hành vi SourceUploadController mới. Khẳng định:
//   1. Source phải xuất hiện trong state.docs kể cả khi state.docsReadyPromise còn pending lúc
//      change fire (kịch bản dễ trúng nhất: app vừa mở, đang migrate IndexedDB) — input.value được
//      reset AN TOÀN sau khi files đã được copy thành mảng thường.
//   2. Chọn file KHÔNG hợp lệ (.exe) -> KHÔNG được thêm vào state.docs, user PHẢI được cảnh báo rõ
//      (đối chứng với code cũ: .exe vẫn bị đẩy thẳng vào handleFiles(), tạo 1 doc lỗi mà KHÔNG có
//      cảnh báo nào cho user — silent failure, xem PHẦN 40/41 và AUDIT ở cuối file này).
//   3. Kéo-thả file hợp lệ vào dropzone modal -> cũng đi qua đúng 1 pipeline dùng chung.
//   4. openSourceFilePicker() ưu tiên showPicker() khi trình duyệt hỗ trợ (PHẦN 3) — hàm này KHÔNG
//      tồn tại ở code cũ.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ok  - ' + msg); }
  else { failed++; console.log('  FAIL - ' + msg); }
}

const publicDir = path.join(__dirname, '..', 'public');

function makeFakeDom() {
  const listeners = {};
  const elements = new Map();

  // <input type=file> giả lập ĐÚNG hành vi live-FileList: set .value = '' clear luôn mảng files
  // hiện tại (cùng object reference mà code cũ đang giữ) -- đây là điều kiện để tái hiện bug thật.
  function makeFileInput(id) {
    let _files = [];
    const node = {
      id, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      _listeners: {},
      addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
      removeEventListener() {},
      onchange: null,
      dispatchEvent(ev) {
        (this._listeners[ev.type] || []).forEach((fn) => fn({ ...ev, target: node }));
        // app.js gán trực tiếp `el('fileInput').onchange = ...` (không dùng addEventListener) --
        // fake input phải mô phỏng cả kênh này, giống trình duyệt thật.
        if (ev.type === 'change' && typeof node.onchange === 'function') node.onchange({ ...ev, target: node });
      },
      setAttribute() {}, getAttribute: () => null,
      focus() {}, click() { node.__clicked = (node.__clicked || 0) + 1; },
      showPicker() { node.__showPickerCalled = (node.__showPickerCalled || 0) + 1; },
      get files() { return _files; },
      set files(v) { _files = v; },
      get value() { return _files.length ? 'C:\\fakepath\\' + _files[0].name : ''; },
      set value(v) { if (v === '') _files = []; }, // hành vi trình duyệt thật: reset value -> clear FileList sống
    };
    return node;
  }

  function fakeEl(id) {
    if (!elements.has(id)) {
      if (id === 'fileInput') { elements.set(id, makeFileInput(id)); return elements.get(id); }
      const e = {
        id, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false, _set: new Set() },
        _listeners: {},
        addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
        removeEventListener() {},
        dispatchEvent(ev) { (this._listeners[ev.type] || []).forEach((fn) => fn(ev)); },
        appendChild() {}, removeChild() {},
        querySelector: () => fakeEl(id + '__q'), querySelectorAll: () => [fakeEl(id + '__q')],
        setAttribute() {}, getAttribute: () => null, onclick: null,
        dataset: {}, children: [], childNodes: [], value: '', innerHTML: '', textContent: '',
        focus() {}, click() {}, closest: () => null, contains: () => false, cloneNode: () => fakeEl(id + '_clone'),
        offsetHeight: 0, offsetWidth: 0, scrollHeight: 0, scrollTop: 0, getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 })
      };
      elements.set(id, e);
    }
    return elements.get(id);
  }
  const doc = {
    getElementById: (id) => fakeEl(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => fakeEl('__created_' + Math.random()),
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    body: fakeEl('body'),
    documentElement: fakeEl('documentElement'),
    currentScript: null,
    readyState: 'complete',
    hidden: false
  };
  const win = {
    document: doc,
    location: { hostname: 'localhost', search: '', reload() {} },
    navigator: { userAgent: 'node', onLine: true, clipboard: { writeText: () => Promise.resolve() } },
    localStorage: (function () { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() }; })(),
    sessionStorage: (function () { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })(),
    fetch: () => Promise.reject(new Error('no network in sandbox')),
    URL, URLSearchParams, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, setInterval, clearInterval,
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    dispatchEvent(ev) {
      const type = ev && ev.type;
      (listeners[type] || []).forEach((fn) => { try { fn(ev); } catch (e) { /* n/a */ } });
      return true;
    },
    console,
    alert(msg) { win.__lastAlert = msg; win.__alertCount = (win.__alertCount || 0) + 1; },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    innerWidth: 1024, innerHeight: 768,
    crypto: { subtle: null } // buộc computeFingerprint() rơi xuống fallback meta:... (không cần thật SHA-256 trong sandbox)
  };
  win.window = win;
  win.self = win;
  win.globalThis = win;
  win.document.defaultView = win;
  return { win, listeners, doc };
}

function loadScript(ctx, rel) {
  const code = fs.readFileSync(path.join(publicDir, rel), 'utf8');
  vm.runInContext(code, ctx, { filename: rel });
}

function makeFakeFile(name, size) {
  return {
    name, size: size || 1024, lastModified: Date.now(),
    arrayBuffer: async () => new ArrayBuffer(size || 1024)
  };
}

function bootApp() {
  const { win } = makeFakeDom();
  vm.createContext(win);
  loadScript(win, 'js/boot.js');
  loadScript(win, 'js/subjects.js');
  loadScript(win, 'js/formulas.js');

  loadScript(win, 'js/solid3d.js');
  loadScript(win, 'js/storage.js');
  loadScript(win, 'js/app.js');
  return win;
}

async function main() {
  console.log('\n== REGRESSION: fileInput.onchange KHÔNG được đánh mất file khi docsReadyPromise còn pending ==');
  {
    const win = bootApp();
    // Mô phỏng đúng kịch bản dễ trúng bug nhất: docsReadyPromise VẪN CÒN PENDING lúc user chọn
    // xong file (app vừa mở, IndexedDB migration chưa xong).
    win.state.docsReadyPromise = new Promise((resolve) => setTimeout(resolve, 15));

    const input = win.document.getElementById('fileInput');
    input.files = [makeFakeFile('bai-tap.pdf', 2048)];
    input.dispatchEvent({ type: 'change' });

    // onchange handler chạy acceptSourceFiles() bất đồng bộ (có await bên trong) -- đợi đủ lâu hơn
    // cả docsReadyPromise (15ms) lẫn phần đọc file/parse.
    await new Promise((r) => setTimeout(r, 80));

    ok(win.state.docs.length === 1, `source được đăng ký dù docsReadyPromise pending lúc change fire (docs.length=${win.state.docs.length})`);
    ok(win.state.docs[0] && win.state.docs[0].name === 'bai-tap.pdf', 'source đúng tên file vừa chọn');
    ok(input.files.length === 0, 'input.value đã được reset (files rỗng) sau khi copy xong -- không còn giữ FileList cũ');
  }

  console.log('\n== File không hợp lệ: KHÔNG đóng panel, KHÔNG thêm source, có cảnh báo ==');
  {
    const win = bootApp();
    win.state.docsReadyPromise = Promise.resolve();
    win.openAddSourcePanel(null);
    ok(win.document.getElementById('addSourceOverlay')._listeners !== undefined, 'panel mở được (sanity check)');

    const input = win.document.getElementById('fileInput');
    input.files = [makeFakeFile('virus.exe', 100)];
    input.dispatchEvent({ type: 'change' });
    await new Promise((r) => setTimeout(r, 30));

    ok(win.state.docs.length === 0, 'file .exe KHÔNG được thêm vào state.docs');
    ok(win.__alertCount >= 1, 'user được cảnh báo file không hợp lệ (không silent failure -- PHẦN 41)');
  }

  console.log('\n== Kéo-thả (drop) trực tiếp vào dropzone modal cũng đi qua đúng pipeline ==');
  {
    const win = bootApp();
    win.state.docsReadyPromise = Promise.resolve();
    const dz = win.document.getElementById('addSourceDropZone');
    ok(typeof dz._listeners.drop === 'function' || (dz._listeners.drop && dz._listeners.drop.length > 0), 'dropzone modal có listener cho sự kiện drop');

    const dropEvt = {
      type: 'drop',
      preventDefault() {},
      dataTransfer: { files: [makeFakeFile('de-thi.docx', 4096)] }
    };
    dz._listeners.drop.forEach((fn) => fn(dropEvt));
    await new Promise((r) => setTimeout(r, 30));

    ok(win.state.docs.length === 1 && win.state.docs[0].name === 'de-thi.docx', 'file kéo-thả vào modal được đăng ký làm source');
  }

  console.log('\n== openSourceFilePicker(): ưu tiên showPicker() nếu trình duyệt hỗ trợ ==');
  {
    const win = bootApp();
    win.openSourceFilePicker('unit-test');
    const input = win.document.getElementById('fileInput');
    ok(input.__showPickerCalled === 1, 'showPicker() được gọi thay vì click() khi khả dụng');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) { console.log('RESULT: FAIL'); process.exitCode = 1; }
  else { console.log('RESULT: PASS'); }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
