'use strict';
// ---------- A16 (test bắt buộc quan trọng nhất theo yêu cầu audit): ----------
// "PDF có 50 chunk. Query cần thông tin ở chunk 3, chunk 27, chunk 49. Kết quả retrieval cuối cùng
// phải chứng minh cả 3 chunk/evidence đều được đưa vào pipeline. Không được chỉ lấy top 4."
//
// Test này CHẠY THẬT public/js/app.js trong 1 vm sandbox (cùng kỹ thuật với boot-resilience.test.js)
// rồi gọi thẳng retrieveContext() thật — không mock lại logic, để bắt được regression thật nếu ai
// đó sau này lỡ tay đưa limit cứng trở lại.
//
// Kịch bản tái hiện ĐÚNG root cause mô tả trong yêu cầu: 50 chunk đều chứa chung từ "bài" (nên với
// scoring theo từ khóa đơn giản, chúng có ĐIỂM BẰNG NHAU) — nếu code cũ dùng `matched.slice(0, 4)`,
// V8 sort ổn định (stable sort) sẽ giữ nguyên THỨ TỰ CHÈN MẢNG cho các phần tử điểm bằng nhau, nên
// kết quả sẽ luôn là 4 chunk ĐẦU TIÊN (chunk 1-4) — bỏ sót hoàn toàn chunk 27 và 49. Test khẳng định
// hành vi ĐÚNG: cả chunk 3, 27, 49 đều có mặt trong kết quả.

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
  const elements = new Map();
  function fakeEl(id) {
    if (!elements.has(id)) {
      const e = {
        id, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {},
        querySelector: () => fakeEl(id + '__q'), querySelectorAll: () => [],
        setAttribute() {}, getAttribute: () => null,
        dataset: {}, children: [], childNodes: [], value: '', innerHTML: '', textContent: '',
        focus() {}, click() {}, closest: () => null, contains: () => false, cloneNode: () => fakeEl(id + '_clone'),
        offsetHeight: 0, offsetWidth: 0, scrollHeight: 0, scrollTop: 0,
        getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 })
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
    addEventListener() {}, removeEventListener() {},
    body: fakeEl('body'), documentElement: fakeEl('documentElement'),
    currentScript: null, readyState: 'complete', hidden: false
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
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    console,
    requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: (id) => clearTimeout(id),
    innerWidth: 1024, innerHeight: 768
  };
  win.window = win; win.self = win; win.globalThis = win; win.document.defaultView = win;
  return win;
}

function loadScript(ctx, rel) {
  const code = fs.readFileSync(path.join(publicDir, rel), 'utf8');
  vm.runInContext(code, ctx, { filename: rel });
}

console.log('\n== A16: retrieveContext() PHỦ HẾT yêu cầu trong PDF 50 chunk, không cắt cứng top-4 ==');

const win = makeFakeDom();
vm.createContext(win);
loadScript(win, 'js/boot.js');
loadScript(win, 'js/subjects.js');
loadScript(win, 'js/formulas.js');
loadScript(win, 'js/geo2d-engine.js');
loadScript(win, 'js/solid3d.js');
loadScript(win, 'js/storage.js');
loadScript(win, 'js/app.js');

ok(win.__appBooted === true, 'setup: app.js load xong trong sandbox (không throw)');

// state là `const` top-level trong app.js -> không lộ ra thành own-property của global object, nhưng
// vẫn truy được qua vm.runInContext trong CÙNG context (global lexical environment dùng chung).
const state = vm.runInContext('state', win);
const retrieveContext = vm.runInContext('retrieveContext', win);

ok(typeof retrieveContext === 'function', 'setup: retrieveContext được expose (function declaration top-level -> global)');

// 50 chunk, MỌI chunk đều chứa chung từ "bài" (điểm khớp từ khóa BẰNG NHAU cho tất cả) — đúng kịch
// bản khiến limit cứng kiểu cũ chỉ lấy 4 chunk ĐẦU MẢNG (1,2,3,4), bỏ sót chunk 27/49.
const chunks = [];
for (let i = 1; i <= 50; i++) {
  chunks.push({
    id: i, chunkIndex: i, totalChunks: 50, page: i, startPage: i, endPage: i,
    text: `Bài ${i}: đây là nội dung bài tập số ${i} trong tài liệu, thuộc chương liên quan.`,
    garbled: false
  });
}
state.docs = [{ id: 1, name: 'toan11-50bai.pdf', status: 'ready', sourceType: 'pdf', chunks }];

// Query liệt kê rời rạc 3 bài nằm ở 3 vị trí xa nhau (đầu/giữa/cuối) trong tài liệu — kích hoạt
// Requirement Coverage mode (mục A4) thay vì chỉ dựa vào điểm khớp từ khóa chung chung.
const query = 'Giải giúp mình bài 3, bài 27 và bài 49 trong tài liệu này';
const result = retrieveContext(query);

ok(Array.isArray(result) && result.length > 0, 'retrieveContext() trả về mảng khác rỗng');
ok(result.length > 4, `KHÔNG còn bị cắt cứng ở 4 — nhận được ${result.length} đoạn (chứng minh không còn hard-limit kiểu cũ)`);

const hasChunk = (n) => result.some((c) => c.text.includes(`Bài ${n}:`));
ok(hasChunk(3), 'chunk 3 (đầu tài liệu) CÓ trong kết quả');
ok(hasChunk(27), 'chunk 27 (giữa tài liệu) CÓ trong kết quả — đây là điểm code CŨ sẽ FAIL (top-4 theo thứ tự chèn mảng sẽ chỉ có chunk 1-4)');
ok(hasChunk(49), 'chunk 49 (cuối tài liệu) CÓ trong kết quả — đây là điểm code CŨ sẽ FAIL');

// Mọi chunk trong kết quả PHẢI giữ metadata trang/chunk (mục A2) — không được thoái hoá về {id,text}.
const metaOk = result.every((c) =>
  Object.prototype.hasOwnProperty.call(c, 'page') &&
  Object.prototype.hasOwnProperty.call(c, 'sourceId') &&
  Object.prototype.hasOwnProperty.call(c, 'chunkIndex') &&
  Object.prototype.hasOwnProperty.call(c, 'totalChunks')
);
ok(metaOk, 'mỗi context trả về giữ ĐỦ metadata {page, sourceId, chunkIndex, totalChunks} (mục A2), không chỉ {id, text}');

console.log('\n== Mô phỏng RÕ hành vi code CŨ (retrieveContext(query, 4)) để đối chứng ==');
// Mô phỏng thủ công đúng logic CŨ (sort theo điểm, slice(0, 4)) để CHỨNG MINH nó sẽ fail — không
// import lại code cũ (đã bị xoá), chỉ tái hiện công thức `matched.slice(0, limit)` mà audit mô tả.
const qWords = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
const scored = chunks.map((c) => {
  const lower = c.text.toLowerCase();
  let score = 0;
  qWords.forEach((w) => { if (w.length > 2 && lower.includes(w)) score++; });
  return { ...c, score };
});
scored.sort((a, b) => b.score - a.score);
const oldStyleTop4 = scored.slice(0, 4);
const oldHas27 = oldStyleTop4.some((c) => c.text.includes('Bài 27:'));
const oldHas49 = oldStyleTop4.some((c) => c.text.includes('Bài 49:'));
ok(!oldHas27 && !oldHas49, `xác nhận công thức limit=4 kiểu CŨ THẬT SỰ sẽ bỏ sót (top-4 cũ = [${oldStyleTop4.map((c) => c.id).join(',')}]) — chứng minh fix ở retrieveContext() là fix THẬT, không phải placebo`);

// ---------- Chế độ SOURCE-COMPLETE (yêu cầu "toàn bộ tài liệu") ----------
console.log('\n== SOURCE-COMPLETE mode: "toàn bộ tài liệu" trả về TẤT CẢ chunk ==');
const fullResult = retrieveContext('Tóm tắt toàn bộ tài liệu này giúp mình');
ok(fullResult.length === 50, `yêu cầu "toàn bộ tài liệu" trả về ĐỦ 50/50 chunk (nhận được ${fullResult.length})`);

// ---------- collectSourceImages: chọn trang theo gợi ý trong câu hỏi ----------
console.log('\n== collectSourceImages(): PDF scan chọn đúng trang được hỏi ==');
const collectSourceImages = vm.runInContext('collectSourceImages', win);
state.docs = [{
  id: 2, name: 'scan.pdf', status: 'ready', sourceType: 'image-pdf',
  pageImages: Array.from({ length: 40 }, (_, i) => ({ page: i + 1, mediaType: 'image/png', base64: 'AA' })),
  pageCoverage: { totalPages: 40, renderedPages: 40, failedPages: [], coveragePercent: 100 }
}];
const imgs = collectSourceImages('cho mình xem trang 37 của tài liệu');
ok(imgs.some((im) => im.page === 37), 'câu hỏi nhắc "trang 37" -> ảnh trang 37 CÓ trong kết quả gửi đi');

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
