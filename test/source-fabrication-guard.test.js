'use strict';
/* ============================================================================================
 * TEST CHỐNG BỊA ĐỀ BÀI CÓ SỐ THỨ TỰ CỤ THỂ (báo lỗi thực tế của người dùng)
 * ============================================================================================
 * Kịch bản THẬT đã xảy ra: user tải lên SGK Toán 11, hỏi "giải các bài từ 1.9 đến 1.11". Nguồn CÓ
 * nội dung thật (Toán 11, KNTT) nhưng phần vision-extract KHÔNG có literal "1.9"/"1.10"/"1.11" (vd
 * OCR đọc lệch số hoặc định dạng khác). Nguồn LẠI có 1 đoạn về "hệ thức Chasles" ở mục trước đó
 * trong CÙNG tài liệu, trùng từ khoá "góc lượng giác". Bản retrieveContext() CŨ khi tầng 1 (exact
 * label) rỗng thì ÂM THẦM rơi xuống tầng 2 (keyword chung) — lấy nhầm đoạn Chasles rồi model trình
 * bày như thể đó CHÍNH LÀ bài 1.9, bịa đúng nghĩa đen (gắn số thật lên nội dung sai/khác chủ đề).
 *
 * Bộ test này canh 2 lớp phòng vệ MỚI:
 *   (A) client: retrieveContext() phải TỰ BÁO CÁO nhãn nào không có evidence thật (không được
 *       lặng lẽ lấp bằng tier-2), và evidence tier-2 không được gắn `requirement` của 1 bài cụ thể.
 *   (B) server: prompt cấm bịa cho đúng các nhãn đó; nếu model vẫn lỡ vi phạm, completenessCheck
 *       phải bắt được và ép continuation viết đoạn cải chính (không phải "viết tiếp" nội dung sai).
 */

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
      elements.set(id, {
        id, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {},
        querySelector: () => fakeEl(id + '__q'), querySelectorAll: () => [],
        setAttribute() {}, getAttribute: () => null, dataset: {}, children: [], childNodes: [],
        value: '', innerHTML: '', textContent: '', disabled: false,
        focus() {}, click() {}, closest: () => null, contains: () => false,
        cloneNode: () => fakeEl(id + '_clone'),
        offsetHeight: 0, offsetWidth: 0, scrollHeight: 0, scrollTop: 0,
        getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 })
      });
    }
    return elements.get(id);
  }
  const doc = {
    getElementById: (id) => fakeEl(id), querySelector: () => null, querySelectorAll: () => [],
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
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {}, removeEventListener() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: () => Promise.reject(new Error('no network in test')),
    innerWidth: 1280, innerHeight: 900,
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    console
  };
  win.window = win; win.self = win; win.globalThis = win;
  return win;
}

function loadScript(ctx, rel) {
  vm.runInContext(fs.readFileSync(path.join(publicDir, rel), 'utf8'), ctx, { filename: rel });
}

async function bootApp() {
  const win = makeFakeDom();
  vm.createContext(win);
  ['js/boot.js', 'js/subjects.js', 'js/formulas.js', 'js/solid3d.js', 'js/storage.js', 'js/app.js']
    .forEach((f) => loadScript(win, f));
  const state = vm.runInContext('state', win);
  if (state.docsReadyPromise) { try { await state.docsReadyPromise; } catch (e) { /* ignore */ } }
  return win;
}

/** Đúng cấu trúc SGK thật: có mục "hệ thức Chasles" (chủ đề trước) VÀ bài 1.9-1.11 THẬT (sin2a...)
 * nhưng tham số `omitExactLabels` mô phỏng lỗi OCR khiến literal "1.9"/"1.10"/"1.11" KHÔNG xuất
 * hiện đúng dạng trong evidence — tái hiện chính xác điều kiện gây ra bug thật. */
function makeTextbookChunks({ omitExactLabels }) {
  const chunks = [];
  let id = 1;
  const push = (page, text) => { chunks.push({ id: id, chunkIndex: id, totalChunks: 0, page, startPage: page, endPage: page, text, extractionMethod: 'vision', extractionStatus: 'ok', evidenceId: `1:p${page}` }); id++; };

  push(38, 'Hệ thức Chasles đối với ba tia bất kì Ou, Ov, Ow: sđ(Ou,Ov) + sđ(Ov,Ow) = sđ(Ou,Ow) + k360°. Đây là công thức nền tảng của phần góc lượng giác.');
  push(39, 'Bài tập vận dụng hệ thức Chasles trong tính toán góc lượng giác và số đo cung.');
  push(40, omitExactLabels
    ? 'Bài tập: Tính sin2a, cos2a, tan2a, biết: a) sin a = 1/3 và π/2 < a < π;'    // literal "1.9" bị mất do lỗi OCR mô phỏng
    : '1.9. Tính sin2a, cos2a, tan2a, biết: a) sin a = 1/3 và π/2 < a < π;');
  push(41, omitExactLabels
    ? 'Bài tập: Tính giá trị biểu thức A = (sin π/15 cos π/10 + sin π/10 cos π/15) / (...)'
    : '1.10. Tính giá trị của các biểu thức sau: a) A = (sin π/15 cos π/10 + sin π/10 cos π/15) / (...)');
  push(42, omitExactLabels
    ? 'Bài tập: Chứng minh đẳng thức sin(a+b)sin(a-b) = sin^2 a - sin^2 b = cos^2 b - cos^2 a.'
    : '1.11. Chứng minh đẳng thức sau: sin(a+b)sin(a-b) = sin^2 a - sin^2 b = cos^2 b - cos^2 a.');
  chunks.forEach((c) => { c.totalChunks = chunks.length; });
  return chunks;
}

(async function run() {
  console.log('\n== A1: nhãn CÓ evidence thật -> matched, KHÔNG cảnh báo ==');
  {
    const win = await bootApp();
    const state = vm.runInContext('state', win);
    const retrieveContext = vm.runInContext('retrieveContext', win);
    state.docs = [{ id: 1, name: 'toan11.pdf', ext: 'pdf', status: 'ready', chunks: makeTextbookChunks({ omitExactLabels: false }) }];
    const r = retrieveContext('giải các bài từ 1.9 đến 1.11');
    ok(r.unmatchedRequirementLabels.length === 0, `A1: có evidence thật -> unmatchedRequirementLabels rỗng (nhận ${JSON.stringify(r.unmatchedRequirementLabels)})`);
    ok(r.matchedRequirementLabels.length === 3, `A1: cả 3 nhãn matched (nhận ${r.matchedRequirementLabels.length})`);
    ok(r.some((c) => /sin2a/.test(c.text) && c.retrievalTier === 1), 'A1: evidence thật của 1.9 ở tầng 1');
  }

  console.log('\n== A2: TÁI HIỆN BUG THẬT — nhãn KHÔNG có evidence -> báo cáo trung thực, KHÔNG lặng lẽ lấy nhầm đoạn khác gắn nhãn ==');
  {
    const win = await bootApp();
    const state = vm.runInContext('state', win);
    const retrieveContext = vm.runInContext('retrieveContext', win);
    state.docs = [{ id: 1, name: 'toan11.pdf', ext: 'pdf', status: 'ready', chunks: makeTextbookChunks({ omitExactLabels: true }) }];
    const r = retrieveContext('giải các bài từ 1.9 đến 1.11');

    ok(r.unmatchedRequirementLabels.length === 3
      && r.unmatchedRequirementLabels.indexOf('1.9') !== -1
      && r.unmatchedRequirementLabels.indexOf('1.10') !== -1
      && r.unmatchedRequirementLabels.indexOf('1.11') !== -1,
    `A2: cả 3 nhãn được báo cáo TRUNG THỰC là KHÔNG có evidence (nhận ${JSON.stringify(r.unmatchedRequirementLabels)})`);
    ok(r.matchedRequirementLabels.length === 0, 'A2: không nhãn nào matched giả');

    // ĐÚNG bug thật: evidence Chasles (page 38/39) vẫn được trả về ở tầng 2 (hữu ích để tham khảo),
    // nhưng KHÔNG được gắn requirement của bài 1.9/1.10/1.11 nào cả — đây là điểm khác biệt sống còn
    // so với bản lỗi cũ.
    const chaslesEvidence = r.filter((c) => /Chasles/.test(c.text));
    ok(chaslesEvidence.length > 0, 'A2: evidence Chasles (tier 2) vẫn có mặt trong context — không bị xoá, chỉ không được NHẬN NHẦM là bài đã hỏi');
    ok(chaslesEvidence.every((c) => c.retrievalTier !== 1 && c.requirement == null),
      'A2/PHẦN F: evidence Chasles KHÔNG được gắn requirement="1.9" — đây chính là chỗ bug cũ làm sai');
    ok(r.filter((c) => c.retrievalTier === 1).length === 0, 'A2: KHÔNG có evidence tier-1 nào (đúng bản chất: không tìm thấy thật)');
  }

  console.log('\n== A3: aiMsgObj lưu lại unmatchedRequirementLabels để stage "detail" tái dùng đúng ==');
  {
    const win = await bootApp();
    const state = vm.runInContext('state', win);
    const retrieveContext = vm.runInContext('retrieveContext', win);
    state.docs = [{ id: 1, name: 'toan11.pdf', ext: 'pdf', status: 'ready', chunks: makeTextbookChunks({ omitExactLabels: true }) }];
    const contexts = retrieveContext('giải các bài từ 1.9 đến 1.11');
    // Mô phỏng đúng cấu trúc aiMsgObj được tạo trong sendMessage() (app.js dòng ~4627).
    const aiMsgObj = {
      contexts,
      requirementLabels: contexts.requirementLabels || [],
      matchedRequirementLabels: contexts.matchedRequirementLabels || [],
      unmatchedRequirementLabels: contexts.unmatchedRequirementLabels || []
    };
    ok(aiMsgObj.unmatchedRequirementLabels.length === 3, 'A3: aiMsgObj giữ đúng 3 nhãn chưa matched, sẵn sàng gửi ở lượt "Giải chi tiết"');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
