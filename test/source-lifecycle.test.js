'use strict';
/* ============================================================================================
 * TEST VÒNG ĐỜI NGUỒN (PHẦN R — TEST 1..10, 13, 15, 16)
 * ============================================================================================
 * Chạy THẬT public/js/app.js trong sandbox vm (cùng kỹ thuật source-complete-retrieval.test.js) và
 * gọi thẳng các hàm thật — không mock lại logic, để bắt regression thật nếu ai đó lỡ tay đưa
 * fire-and-forget hay top-k mù quay lại.
 *
 * ROOT CAUSE mà bộ test này canh giữ: trước bản sửa, `doc.status='ready'` được đặt ngay sau khi
 * RASTERIZE xong PDF scan, còn vision extraction chạy nền không ai chờ. Render 100% bị hiểu nhầm
 * thành "đã đọc 100%".
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
      const e = {
        id, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {},
        querySelector: () => fakeEl(id + '__q'), querySelectorAll: () => [],
        setAttribute() {}, getAttribute: () => null,
        dataset: {}, children: [], childNodes: [], value: '', innerHTML: '', textContent: '',
        disabled: false,
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
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {}, removeEventListener() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: () => Promise.reject(new Error('no network in test')),
    innerWidth: 1280, innerHeight: 900,
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    console
  };
  win.window = win;
  win.self = win;
  win.globalThis = win;
  return win;
}

function loadScript(ctx, rel) {
  const code = fs.readFileSync(path.join(publicDir, rel), 'utf8');
  vm.runInContext(code, ctx, { filename: rel });
}

// loadAll() chạy async lúc app.js được nạp và sẽ GÁN ĐÈ state.docs bằng dữ liệu docStore (rỗng
// trong sandbox). Phải chờ cổng khởi tạo đó settle rồi mới dựng dữ liệu test — đúng như
// handleFiles() thật vẫn await state.docsReadyPromise trước khi đụng vào state.docs.
async function bootApp() {
  const win = makeFakeDom();
  vm.createContext(win);
  loadScript(win, 'js/boot.js');
  loadScript(win, 'js/subjects.js');
  loadScript(win, 'js/formulas.js');
  loadScript(win, 'js/solid3d.js');
  loadScript(win, 'js/storage.js');
  loadScript(win, 'js/app.js');
  const state = vm.runInContext('state', win);
  if (state.docsReadyPromise) { try { await state.docsReadyPromise; } catch (e) { /* ignore */ } }
  return win;
}

/** Tạo 1 doc PDF scan đã rasterize xong, CHƯA đọc bằng vision. */
function makeScannedDoc(win, { id = 1, pages = 20, name = 'scan.pdf' } = {}) {
  const setSourceStatus = vm.runInContext('setSourceStatus', win);
  const doc = {
    id, name, ext: 'pdf', sourceType: 'image-pdf',
    pageImages: Array.from({ length: pages }, (_, i) => ({ page: i + 1, mediaType: 'image/jpeg', base64: 'AAAA' })),
    pageEvidence: {},
    chunks: [{ id: 1, text: '⏳ PDF scan — đang đọc bằng AI…', placeholder: true }]
  };
  setSourceStatus(doc, 'RASTERIZING', {
    extractionMethod: 'vision', totalPages: pages, renderedPages: pages,
    parsedPages: 0, extractedPages: 0, verifiedPages: 0, failedPages: []
  });
  return doc;
}

/** Thay apiPost bằng bản giả có đếm số lần gọi + điều khiển được trang nào fail. */
function stubApiPost(win, { failPages = [], failOnlyFirstAttempt = false } = {}) {
  const calls = { count: 0, pages: [] };
  const firstAttemptSeen = new Set();
  const fn = function (pathname, body) {
    calls.count++;
    const results = (body.pages || []).map((p) => {
      calls.pages.push(p.page);
      let shouldFail = failPages.indexOf(p.page) !== -1;
      if (shouldFail && failOnlyFirstAttempt) {
        if (firstAttemptSeen.has(p.page)) shouldFail = false;
        else firstAttemptSeen.add(p.page);
      }
      return shouldFail
        ? { page: p.page, ok: false, reason: 'provider_error' }
        : { page: p.page, ok: true, extractedText: `Nội dung trang ${p.page}`, equations: [], diagrams: [], confidence: 0.9 };
    });
    return Promise.resolve({ results });
  };
  win.apiPost = fn;
  vm.runInContext('apiPost = globalThis.apiPost;', win);
  return calls;
}

(async function run() {
  console.log('\n== TEST 1/2: READY chỉ khi vision đọc XONG TOÀN BỘ trang ==');
  {
    const win = await bootApp();
    const state = vm.runInContext('state', win);
    const processPdfVisionEvidence = vm.runInContext('processPdfVisionEvidence', win);
    const isSourceReady = vm.runInContext('isSourceReady', win);

    // TEST 1: 20 trang, vision chỉ xong 18 -> KHÔNG READY.
    const doc = makeScannedDoc(win, { pages: 20 });
    state.docs = [doc];
    stubApiPost(win, { failPages: [7, 13] });
    await processPdfVisionEvidence(doc);
    ok(!isSourceReady(doc), `TEST 1: vision 18/20 -> source KHÔNG READY (status=${doc.processing.status})`);
    ok(doc.processing.status === 'INCOMPLETE', 'TEST 1: trạng thái đúng là INCOMPLETE, không phải READY giả');
    ok(doc.processing.extractedPages === 18, `TEST 1: extractedPages đếm THẬT = 18 (nhận ${doc.processing.extractedPages})`);
    ok(doc.processing.renderCoverage === 100 && doc.processing.readCoverage === 90,
      `TEST 1: renderCoverage(100) và readCoverage(90) TÁCH BIỆT — render xong ≠ đọc xong (nhận ${doc.processing.renderCoverage}/${doc.processing.readCoverage})`);
    ok(doc.processing.coveragePercent !== 100, 'TEST 1: coveragePercent KHÔNG được là 100 khi mới render xong');
    ok(doc.status !== 'ready', 'TEST 1: doc.status cũ cũng KHÔNG được là "ready"');
  }
  {
    const win = await bootApp();
    const state = vm.runInContext('state', win);
    const processPdfVisionEvidence = vm.runInContext('processPdfVisionEvidence', win);
    const isSourceReady = vm.runInContext('isSourceReady', win);
    const doc = makeScannedDoc(win, { pages: 20 });
    state.docs = [doc];
    stubApiPost(win, {});
    await processPdfVisionEvidence(doc);
    ok(isSourceReady(doc), 'TEST 2: vision 20/20 -> source READY');
    ok(doc.processing.verifiedPages === 20 && doc.processing.failedPages.length === 0,
      'TEST 2: verifiedPages=20, failedPages rỗng — READY có BẰNG CHỨNG, không phải cờ tự đặt');
    ok(doc.processing.completedAt != null, 'TEST 2: có mốc completedAt');
  }

  console.log('\n== TEST 3: không được lấy context khi nguồn chưa đọc xong ==');
  {
    const win = await bootApp();
    const state = vm.runInContext('state', win);
    const retrieveContext = vm.runInContext('retrieveContext', win);
    const waitForAllSourceProcessing = vm.runInContext('waitForAllSourceProcessing', win);
    const processPdfVisionEvidence = vm.runInContext('processPdfVisionEvidence', win);

    const doc = makeScannedDoc(win, { pages: 6 });
    state.docs = [doc];
    stubApiPost(win, {});
    const p = processPdfVisionEvidence(doc);
    state.sourceProcessingPromises.push(p);

    const early = retrieveContext('trang 3 nói gì');
    ok(early.length === 0, 'TEST 3: hỏi trong lúc vision chưa xong -> retrieveContext() trả RỖNG, không gửi context một phần');

    await waitForAllSourceProcessing();
    await p;
    const after = retrieveContext('trang 3 nói gì');
    ok(after.length > 0, 'TEST 3: sau khi chờ waitForAllSourceProcessing() -> context đã có');
    ok(after.every((c) => !/⏳|Đang đọc/.test(c.text)), 'TEST 13: KHÔNG có placeholder "⏳ Đang đọc…" nào lọt vào context');
  }

  console.log('\n== TEST 4/5: retrieval phải phủ ĐỦ mọi yêu cầu ==');
  {
    const win = await bootApp();
    const state = vm.runInContext('state', win);
    const retrieveContext = vm.runInContext('retrieveContext', win);
    const chunks = [];
    for (let i = 1; i <= 20; i++) {
      chunks.push({
        id: i, chunkIndex: i, totalChunks: 20, page: i, startPage: i, endPage: i,
        text: `Nội dung trang ${i}. Phần lý thuyết và bài tập của trang này.`,
        extractionMethod: 'text', extractionStatus: 'ok', evidenceId: `9:c${i}:p${i}`
      });
    }
    state.docs = [{ id: 9, name: 'tailieu.pdf', ext: 'pdf', status: 'ready', chunks }];
    const r = retrieveContext('cho mình nội dung trang 3 và trang 19');
    const pages = r.map((c) => c.page);
    ok(pages.indexOf(3) !== -1 && pages.indexOf(19) !== -1, `TEST 4: truy hồi chứa CẢ trang 3 và trang 19 (nhận: ${pages.slice(0, 12).join(',')}…)`);
  }
  {
    const win = await bootApp();
    const state = vm.runInContext('state', win);
    const retrieveContext = vm.runInContext('retrieveContext', win);
    // 134 trang: chỉ vài trang chứa nhãn bài 1.9/1.10/1.11, các trang còn lại đều chứa chữ "bài"
    // (điểm keyword cao) — đúng kịch bản nhãn số thật bị chữ chung chung đánh bại.
    const chunks = [];
    for (let i = 1; i <= 134; i++) {
      let text = `Trang ${i}: các bài tập luyện tập trong chương.`;
      if (i === 40) text = 'Bài 1.9. Giải phương trình bậc hai đã cho.';
      if (i === 41) text = 'Bài 1.10. Tính giá trị biểu thức sau đây.';
      if (i === 42) text = 'Bài 1.11. Chứng minh đẳng thức lượng giác.';
      chunks.push({
        id: i, chunkIndex: i, totalChunks: 134, page: i, startPage: i, endPage: i, text,
        extractionMethod: 'vision', extractionStatus: 'ok', evidenceId: `5:p${i}`
      });
    }
    state.docs = [{ id: 5, name: 'toan11.pdf', ext: 'pdf', status: 'ready', chunks }];
    const r = retrieveContext('giải câu 1.9 đến 1.11 giúp mình');
    const has = (s) => r.some((c) => c.text.indexOf(s) !== -1);
    ok(has('Bài 1.9.') && has('Bài 1.10.') && has('Bài 1.11.'), 'TEST 5: CẢ 3 evidence exact (1.9, 1.10, 1.11) đều có mặt');
    const tier1Texts = r.filter((c) => c.retrievalTier === 1).map((c) => c.text).join(' ');
    ok(/1\.9/.test(tier1Texts) && /1\.10/.test(tier1Texts) && /1\.11/.test(tier1Texts),
      'TEST 5/PHẦN O: 3 nhãn số chính xác nằm ở TẦNG 1 (ưu tiên cao nhất), không bị chunk chỉ chứa chữ "bài" đánh bại');
    // Dạng số kiểu Việt Nam "1,9" phải khớp cùng một evidence với "1.9".
    const rComma = retrieveContext('giải bài 1,9');
    ok(rComma.some((c) => c.text.indexOf('Bài 1.9.') !== -1), 'PHẦN O: "1,9" được chuẩn hoá về "1.9" — không còn false negative');
  }

  console.log('\n== TEST 6/8: cache evidence + retry chỉ trang lỗi ==');
  {
    const win = await bootApp();
    const state = vm.runInContext('state', win);
    const processPdfVisionEvidence = vm.runInContext('processPdfVisionEvidence', win);
    const retrieveContext = vm.runInContext('retrieveContext', win);
    const doc = makeScannedDoc(win, { pages: 12 });
    state.docs = [doc];
    const calls = stubApiPost(win, {});
    await processPdfVisionEvidence(doc);
    const afterFirst = calls.pages.length;
    ok(afterFirst === 12, `TEST 6: lần index đầu đọc đúng 12 trang (nhận ${afterFirst})`);

    for (let i = 0; i < 10; i++) {
      retrieveContext(`câu hỏi số ${i} về tài liệu`);
      await processPdfVisionEvidence(doc); // mô phỏng mọi đường dẫn có thể chạm lại vision
    }
    ok(calls.pages.length === afterFirst, `TEST 6: hỏi 10 lần sau khi index xong -> KHÔNG gọi vision thêm lần nào (vẫn ${calls.pages.length} trang)`);
  }
  {
    const win = await bootApp();
    const state = vm.runInContext('state', win);
    const processPdfVisionEvidence = vm.runInContext('processPdfVisionEvidence', win);
    const isSourceReady = vm.runInContext('isSourceReady', win);
    const doc = makeScannedDoc(win, { pages: 10 });
    state.docs = [doc];
    const calls = stubApiPost(win, { failPages: [7], failOnlyFirstAttempt: true });
    await processPdfVisionEvidence(doc);
    const retried = calls.pages.filter((p) => p === 7).length;
    const otherRetried = calls.pages.filter((p) => p !== 7).length;
    ok(retried === 2, `TEST 8: trang 7 được retry ĐÚNG 1 lần (tổng 2 lượt, nhận ${retried})`);
    ok(otherRetried === 9, `TEST 8: 9 trang còn lại KHÔNG bị đọc lại (nhận ${otherRetried} lượt) — 1 trang lỗi không kéo cả PDF`);
    ok(isSourceReady(doc), 'TEST 8: retry thành công -> source READY');
  }
  {
    // Retry BOUNDED: trang hỏng vĩnh viễn không được retry vô hạn.
    const win = await bootApp();
    const state = vm.runInContext('state', win);
    const processPdfVisionEvidence = vm.runInContext('processPdfVisionEvidence', win);
    const doc = makeScannedDoc(win, { pages: 5 });
    state.docs = [doc];
    const calls = stubApiPost(win, { failPages: [3] });
    await processPdfVisionEvidence(doc);
    ok(calls.pages.filter((p) => p === 3).length <= 2, 'PHẦN I: trang hỏng vĩnh viễn bị chặn ở tối đa 2 lượt — không retry vô hạn');
    ok(doc.processing.failedPages.indexOf(3) !== -1 && doc.processing.status === 'INCOMPLETE',
      'PHẦN I: trang hỏng được GHI NHẬN vào failedPages và source không giả vờ READY');
  }

  console.log('\n== TEST 7: sau F5 — READY giữ nguyên, dở dang thì resume ==');
  {
    const win = await bootApp();
    const state = vm.runInContext('state', win);
    const processPdfVisionEvidence = vm.runInContext('processPdfVisionEvidence', win);
    const rehydrate = vm.runInContext('rehydrateSourceProcessing', win);
    const isSourceReady = vm.runInContext('isSourceReady', win);
    const retrieveContext = vm.runInContext('retrieveContext', win);

    const doc = makeScannedDoc(win, { pages: 8 });
    state.docs = [doc];
    const calls = stubApiPost(win, {});
    await processPdfVisionEvidence(doc);
    const beforeReload = calls.pages.length;

    // Mô phỏng F5: object doc được nạp lại nguyên vẹn từ IndexedDB (JSON round-trip).
    const win2 = await bootApp();
    const state2 = vm.runInContext('state', win2);
    const rehydrate2 = vm.runInContext('rehydrateSourceProcessing', win2);
    const isSourceReady2 = vm.runInContext('isSourceReady', win2);
    const retrieveContext2 = vm.runInContext('retrieveContext', win2);
    const calls2 = stubApiPost(win2, {});
    const restored = JSON.parse(JSON.stringify(doc));
    state2.docs = [restored];
    rehydrate2(restored);
    ok(isSourceReady2(restored), 'TEST 7: source READY vẫn READY sau F5');
    ok(calls2.pages.length === 0, 'TEST 7: KHÔNG gọi lại vision sau F5 (dùng cache evidence)');
    ok(retrieveContext2('nội dung trang 3').length > 0, 'TEST 7: evidence sống sót sau F5 — vẫn truy hồi được');
    void beforeReload; void rehydrate; void isSourceReady; void retrieveContext;
  }
  {
    // Nguồn dở dang sau F5 -> KHÔNG được giả vờ READY, và tự resume phần còn thiếu.
    const win = await bootApp();
    const state = vm.runInContext('state', win);
    const rehydrate = vm.runInContext('rehydrateSourceProcessing', win);
    const isSourceReady = vm.runInContext('isSourceReady', win);
    const waitForAllSourceProcessing = vm.runInContext('waitForAllSourceProcessing', win);
    const doc = makeScannedDoc(win, { pages: 6 });
    doc.pageEvidence = {
      1: { ok: true, page: 1, attempts: 1, extractedText: 'Nội dung trang 1', extractionMethod: 'vision', extractionVersion: 2, equations: [], diagrams: [] },
      2: { ok: true, page: 2, attempts: 1, extractedText: 'Nội dung trang 2', extractionMethod: 'vision', extractionVersion: 2, equations: [], diagrams: [] }
    };
    state.docs = [doc];
    const calls = stubApiPost(win, {});
    const resume = rehydrate(doc);
    ok(!isSourceReady(doc), 'TEST 7b: nguồn PROCESSING sau F5 KHÔNG được giả vờ READY');
    await resume;
    await waitForAllSourceProcessing();
    ok(isSourceReady(doc), 'TEST 7b: resume xong thì mới READY');
    ok(calls.pages.indexOf(1) === -1 && calls.pages.indexOf(2) === -1,
      `TEST 7b: 2 trang đã có evidence KHÔNG bị đọc lại (chỉ đọc: ${calls.pages.join(',')})`);
  }

  console.log('\n== TEST 9/16: history dài không được lấn át query/evidence hiện tại ==');
  {
    const win = await bootApp();
    const selectRelevantHistory = vm.runInContext('selectRelevantHistory', win);
    const history = [];
    for (let i = 0; i < 20; i++) {
      history.push({ role: 'user', content: `Giải bài hình học số ${i} về tam giác vuông` });
      history.push({ role: 'assistant', content: `Đáp số bài ${i} là ${i * 2} cm` });
    }
    const independent = selectRelevantHistory('Tính đạo hàm của hàm số y = sin(2x) tại điểm x = 0', history);
    ok(independent.length === 0, `TEST 9/16: query độc lập -> KHÔNG kéo theo lượt cũ nào (nhận ${independent.length})`);
    const followUp = selectRelevantHistory('giải chi tiết phần vừa rồi giúp mình', history);
    ok(followUp.length > 0 && followUp.length <= 8, `TEST 9: query nối tiếp -> giữ lượt gần nhất, có trần (nhận ${followUp.length})`);
    ok(followUp.length < history.length, 'PHẦN L: không nhồi cả 20 lượt vào mọi request');
  }

  console.log('\n== TEST 10: evidence nguồn MỚI thắng kết luận cũ trong history ==');
  {
    const win = await bootApp();
    const state = vm.runInContext('state', win);
    const retrieveContext = vm.runInContext('retrieveContext', win);
    const selectRelevantHistory = vm.runInContext('selectRelevantHistory', win);
    state.docs = [{
      id: 3, name: 'dinhly.pdf', ext: 'pdf', status: 'ready',
      chunks: [{
        id: 1, chunkIndex: 1, totalChunks: 1, page: 12, startPage: 12, endPage: 12,
        text: 'Định lý 4.2: diện tích hình thang bằng trung bình cộng hai đáy nhân chiều cao.',
        extractionMethod: 'text', extractionStatus: 'ok', evidenceId: '3:c1:p12'
      }]
    }];
    const history = [
      { role: 'user', content: 'công thức diện tích hình thang' },
      { role: 'assistant', content: 'Diện tích hình thang bằng tích hai đáy (kết luận SAI ở lượt trước).' }
    ];
    const q = 'áp dụng định lý 4.2 ở trang 12 để tính diện tích';
    const ctx = retrieveContext(q);
    ok(ctx.length > 0 && ctx[0].page === 12 && ctx[0].retrievalTier === 1,
      'TEST 10: evidence nguồn cho trang 12 nằm ở TẦNG 1 — ưu tiên hơn mọi thứ khác trong request');
    ok(selectRelevantHistory(q, history).length === 0,
      'TEST 10: kết luận SAI ở lượt trước KHÔNG được mang sang làm tiền đề khi query mới độc lập');
  }

  console.log('\n== TEST 15: tài liệu 500+ chunk — không top-4, cũng không nổ prompt ==');
  {
    const win = await bootApp();
    const state = vm.runInContext('state', win);
    const retrieveContext = vm.runInContext('retrieveContext', win);
    const chunks = [];
    for (let i = 1; i <= 600; i++) {
      chunks.push({
        id: i, chunkIndex: i, totalChunks: 600, page: Math.ceil(i / 2), startPage: Math.ceil(i / 2), endPage: Math.ceil(i / 2),
        text: `Đoạn ${i}: nội dung bài tập chương ${Math.ceil(i / 50)} với nhiều chi tiết. `.repeat(6),
        extractionMethod: 'text', extractionStatus: 'ok', evidenceId: `7:c${i}`
      });
    }
    state.docs = [{ id: 7, name: 'giaotrinh.pdf', ext: 'pdf', status: 'ready', chunks }];
    const r = retrieveContext('nội dung bài tập chương 3 gồm những gì');
    ok(r.length > 4, `TEST 15: KHÔNG còn top-4 (nhận ${r.length} evidence)`);
    ok(r.length <= 400, `TEST 15: có trần an toàn, không trả về cả 600 đoạn (nhận ${r.length})`);
    const totalChars = r.reduce((a, c) => a + c.text.length, 0);
    ok(totalChars <= 70000, `TEST 15/PHẦN H: tổng ký tự context bị chặn theo ngân sách (nhận ${totalChars})`);
    const full = retrieveContext('tóm tắt toàn bộ tài liệu này');
    const fullChars = full.reduce((a, c) => a + c.text.length, 0);
    ok(fullChars <= 130000, `PHẦN P: chế độ "toàn bộ tài liệu" vẫn có ngân sách riêng, không nổ prompt (nhận ${fullChars})`);
    ok(full.some((c) => c.truncated), 'PHẦN P: khi vượt ngân sách thì RÚT GỌN nội dung (đánh dấu truncated), KHÔNG bỏ sót evidence');
  }

  console.log('\n== PHẦN E: SOURCE MANIFEST phải trung thực ==');
  {
    const win = await bootApp();
    const state = vm.runInContext('state', win);
    const buildSourceManifest = vm.runInContext('buildSourceManifest', win);
    const setSourceStatus = vm.runInContext('setSourceStatus', win);
    const doc = makeScannedDoc(win, { pages: 134, name: 'Toan11-scan.pdf' });
    setSourceStatus(doc, 'EXTRACTING', { extractedPages: 120, verifiedPages: 120 });
    state.docs = [doc];
    const manifest = buildSourceManifest();
    ok(manifest.indexOf('visionExtracted: 120/134') !== -1, 'PHẦN E: manifest in SỐ THẬT visionExtracted 120/134');
    ok(manifest.indexOf('coverage 100%') === -1, 'PHẦN E: KHÔNG còn chuỗi "coverage 100%" hardcode');
    ok(/status: (EXTRACTING|INCOMPLETE|PROCESSING)/.test(manifest) && manifest.indexOf('status: READY') === -1,
      'PHẦN E: 120/134 -> status KHÔNG phải READY');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
