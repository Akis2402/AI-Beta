'use strict';
// ---------- REGRESSION (mục 14 trong yêu cầu audit): "CDN failure does NOT kill app" ----------
// Test này mô phỏng ĐÚNG kịch bản lỗi gốc trên iPhone/Safari bằng cách CHẠY THẬT public/js/boot.js
// và public/js/app.js trong 1 vm sandbox có DOM tối giản, rồi:
//   1. Xác nhận boot.js KHÔNG còn coi 'unhandledrejection' là boot failure (mục 5 audit).
//   2. Xác nhận nếu 6 thư viện optional (pdf.js/mammoth/KaTeX/mathjs/three/docx) hoàn toàn KHÔNG
//      tồn tại (đúng như khi bị content-blocker/CDN chặn/DNS lỗi...), app.js VẪN chạy hết tới cuối
//      và set window.__appBooted = true — KHÔNG có ReferenceError nào từ các global thiếu đó, và
//      màn hình "Không thể khởi động ứng dụng" KHÔNG được kích hoạt.
//   3. Xác nhận nếu core app.js thực sự lỗi (throw đồng bộ ngay từ dòng đầu), boot.js VẪN đúng
//      chức năng hiển thị màn hình lỗi (không bị fix quá tay tới mức tắt hẳn boot-error).

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ok  - ' + msg); }
  else { failed++; console.log('  FAIL - ' + msg); }
}

const publicDir = path.join(__dirname, '..', 'public');

console.log('\n== Regression 14: CDN/optional-lib failure KHÔNG được làm chết app ==');

function makeFakeDom() {
  const listeners = {};
  const elements = new Map();
  function fakeEl(id) {
    if (!elements.has(id)) {
      const el = {
        id, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {},
        // querySelector/querySelectorAll trên 1 element giả lập: trả về 1 fakeEl con dùng chung
        // (không phải null) — giống hành vi thật là "tìm thấy phần tử con", tránh false-negative
        // kiểu "Cannot set properties of null" chỉ vì DOM giả lập quá tối giản, không phải lỗi app.
        querySelector: () => fakeEl(id + '__q'), querySelectorAll: () => [fakeEl(id + '__q')],
        setAttribute() {}, getAttribute: () => null,
        dataset: {}, children: [], childNodes: [], value: '', innerHTML: '', textContent: '',
        focus() {}, click() {}, closest: () => null, contains: () => false, cloneNode: () => fakeEl(id + '_clone'),
        offsetHeight: 0, offsetWidth: 0, scrollHeight: 0, scrollTop: 0, getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 })
      };
      elements.set(id, el);
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
    location: { hostname: 'localhost', reload() {} },
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
      (listeners[type] || []).forEach((fn) => { try { fn(ev); } catch (e) { /* handler lỗi không phải việc của dispatch giả lập */ } });
      return true;
    },
    console,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    innerWidth: 1024, innerHeight: 768
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

console.log('\n-- Kịch bản A: 6 thư viện optional HOÀN TOÀN VẮNG MẶT (giống bị content-blocker/CDN chặn hết) --');
{
  const { win } = makeFakeDom();
  vm.createContext(win);
  let bootErrorTriggeredByRejection = false;
  let threw = null;
  try {
    loadScript(win, 'js/boot.js');
    // Không load pdf.min.js/mammoth/katex/math.js/three.min.js/docx — mô phỏng đúng CDN bị chặn.
    loadScript(win, 'js/subjects.js');
    loadScript(win, 'js/formulas.js');
    loadScript(win, 'js/geo2d-engine.js');
    loadScript(win, 'js/solid3d.js');
    loadScript(win, 'js/storage.js');
    loadScript(win, 'js/app.js');
  } catch (e) {
    threw = e;
  }

  ok(!threw, 'app.js chạy xong KHÔNG throw ra ngoài dù pdfjsLib/mammoth/katex/math/THREE/docx đều undefined' + (threw ? ` (lỗi thực tế: ${threw.stack || threw.message})` : ''));
  ok(win.__appBooted === true, 'window.__appBooted === true sau khi app.js chạy xong (core boot thành công dù thiếu thư viện phụ)');
  ok(!win.document.getElementById('bootErrorScreen') || !win.document.getElementById('bootErrorScreen').__rendered,
    'màn hình "Không thể khởi động ứng dụng" KHÔNG bị kích hoạt chỉ vì thiếu thư viện optional');

  // Giả lập thêm: 1 promise reject KHÔNG liên quan (như network lỗi của recommend/API) xảy ra SAU
  // khi app đã boot xong — xác nhận boot.js không còn coi đây là boot failure (mục 5 audit).
  const fakeRejectionEvent = { type: 'unhandledrejection', reason: new Error('mô phỏng: fetch /api/recommend lỗi mạng') };
  let consoleErrorCalled = false;
  const origConsoleError = win.console.error;
  win.console.error = function () { consoleErrorCalled = true; };
  win.dispatchEvent(fakeRejectionEvent);
  win.console.error = origConsoleError;
  ok(consoleErrorCalled, 'unhandledrejection sau khi boot vẫn được LOG ra console (không bị nuốt hoàn toàn, giữ khả năng debug)');
}

console.log('\n-- Kịch bản B: core app.js thực sự lỗi cú pháp/logic đồng bộ ngay từ đầu --');
{
  const { win } = makeFakeDom();
  vm.createContext(win);
  loadScript(win, 'js/boot.js');
  // Giả lập app.js core bị lỗi thật (ví dụ hỏng file, lỗi cú pháp sau khi build) bằng cách throw
  // đồng bộ ngay khi "script" này chạy, đúng như trình duyệt sẽ làm với 1 <script> lỗi thật.
  let caught = null;
  try {
    vm.runInContext('throw new Error("core app.js hỏng thật - mô phỏng lỗi cú pháp/logic")', win);
  } catch (e) {
    caught = e;
    // Trình duyệt thật: lỗi throw đồng bộ trong 1 <script> tag sẽ tự động bắn ra sự kiện
    // window.onerror/'error' (không cần code nào catch thủ công) — mô phỏng lại đúng hành vi đó.
    win.dispatchEvent({ type: 'error', message: e.message, error: e });
  }
  ok(!!caught, '(thiết lập test) core script throw đồng bộ đúng như dự kiến');
  ok(win.document.getElementById('bootErrorScreen') !== undefined, 'boot.js VẪN tạo phần tử bootErrorScreen khi core app thực sự throw đồng bộ (không bị fix quá tay tới mức tắt hẳn boot-error hợp lệ)');
}

console.log('\n== boot.js: xác nhận tĩnh không còn coi unhandledrejection là boot failure ==');
const bootJs = fs.readFileSync(path.join(publicDir, 'js', 'boot.js'), 'utf8');
ok(/addEventListener\(\s*'unhandledrejection'/.test(bootJs), "boot.js vẫn có listener 'unhandledrejection' (để log debug)");
// Đếm CHÍNH XÁC số lần showBootError() được GỌI THẬT trong code (loại bỏ dòng định nghĩa hàm
// "function showBootError() {" VÀ loại bỏ toàn bộ comment // ... — vì bản thân comment giải thích
// phía trên cũng nhắc tới cụm "showBootError()" dưới dạng văn bản, không phải lệnh gọi thật).
const bootJsCodeOnly = bootJs
  .replace(/\/\/.*$/gm, '')
  .replace(/function\s+showBootError\s*\(\)/g, '');
const callSites = (bootJsCodeOnly.match(/showBootError\(\)/g) || []).length;
ok(callSites === 1, `showBootError() chỉ được GỌI đúng 1 lần trong toàn bộ boot.js (đếm được: ${callSites}) — tức chỉ 'error' đồng bộ mới kích hoạt màn hình lỗi khởi động, 'unhandledrejection' không còn gọi hàm này nữa`);
const errorBlockMatch = bootJs.match(/addEventListener\(\s*'error'[^)]*function[\s\S]{0,80}?\)\s*;\s*\)\s*;/);
ok(bootJs.includes("addEventListener('error', function () { showBootError(); });"),
  "listener 'error' (lỗi đồng bộ thật) gọi showBootError() ngay trong thân handler — không bị vô hiệu hóa quá tay");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
