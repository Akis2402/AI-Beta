'use strict';
/* ============================================================================================
 * E2E PIPELINE NGUỒN (offline) — upload → parse → rasterize → vision → verify → READY → retrieve
 * ============================================================================================
 * Các test khác gọi thẳng từng hàm rời. Test này đi ĐÚNG đường mà người dùng đi: thả file vào
 * handleFiles() và không can thiệp gì thêm, để bắt được lỗi ở CHỖ NỐI giữa các bước — nơi root
 * cause thật sự nằm (parse xong đã vội gọi source là 'ready' trong khi vision chưa chạy).
 *
 * pdf.js và API vision được thay bằng bản giả ở RANH GIỚI NGOÀI (thư viện + mạng), còn toàn bộ
 * logic của app.js chạy thật — không mock hàm nội bộ nào.
 *
 * Giới hạn đã biết: không dùng PDF scan thật với model thật. Phần đó thuộc về
 * scripts/live-source-check.js (cần API key + mạng), không thể chạy trong unit test.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

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
        // Canvas giả: rasterizePdfPage() chỉ cần getContext + toDataURL trả về data URL hợp lệ.
        getContext: () => ({ drawImage() {}, fillRect() {}, clearRect() {} }),
        toDataURL: function () { return 'data:image/jpeg;base64,' + Buffer.from('page-' + (this.__page || 0)).toString('base64'); },
        offsetHeight: 0, offsetWidth: 0, scrollHeight: 0, scrollTop: 0,
        getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 })
      });
    }
    return elements.get(id);
  }
  const doc = {
    getElementById: (id) => fakeEl(id),
    querySelector: () => null, querySelectorAll: () => [],
    createElement: (tag) => fakeEl('__created_' + tag + '_' + Math.random()),
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
    crypto: {
      subtle: {
        digest: async (algo, buf) => {
          const h = crypto.createHash('sha256').update(Buffer.from(buf)).digest();
          return h.buffer.slice(h.byteOffset, h.byteOffset + h.byteLength);
        }
      }
    },
    Uint8Array, console
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

/** File giả tối thiểu đủ cho handleFiles(): name + arrayBuffer() + size. */
function fakeFile(name, bytes) {
  const buf = Buffer.from(bytes || name);
  return {
    name, size: buf.length, lastModified: 1,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    text: async () => buf.toString('utf8')
  };
}

/** pdf.js giả: `textPerPage` null nghĩa là PDF chỉ-ảnh (không có text layer). */
function installFakePdfJs(win, { numPages, textPerPage }) {
  win.pdfjsLib = {
    getDocument: () => ({
      promise: Promise.resolve({
        numPages,
        getPage: async (p) => ({
          getTextContent: async () => ({
            items: textPerPage ? [{ str: textPerPage(p) }] : []
          }),
          getViewport: () => ({ width: 800, height: 1100 }),
          render: () => ({ promise: Promise.resolve() })
        })
      })
    })
  };
  vm.runInContext('window.pdfjsLib = globalThis.pdfjsLib; pdfjsLib = globalThis.pdfjsLib;', win);
  // ensurePdfJs() nạp script từ CDN — vô hiệu hoá vì pdfjsLib đã có sẵn.
  win.__loadVendorScript = () => Promise.resolve();
  vm.runInContext('window.__loadVendorScript = globalThis.__loadVendorScript;', win);
}

function installFakeVisionApi(win, { failPages = [], confidenceFor = () => 0.9 } = {}) {
  const calls = { pages: [] };
  win.apiPost = (pathname, body) => {
    const results = (body.pages || []).map((p) => {
      calls.pages.push(p.page);
      if (failPages.indexOf(p.page) !== -1) return { page: p.page, ok: false, reason: 'provider_error' };
      return {
        page: p.page, ok: true,
        extractedText: `Trang ${p.page}: Bài 1.${p.page} — nội dung trích xuất được từ ảnh scan.`,
        equations: [], diagrams: [], confidence: confidenceFor(p.page)
      };
    });
    return Promise.resolve({ results });
  };
  vm.runInContext('apiPost = globalThis.apiPost;', win);
  return calls;
}

(async function run() {
  console.log('\n== E2E 1: PDF có text layer — upload xong là READY, manifest trung thực ==');
  {
    const win = await bootApp();
    const state = vm.runInContext('state', win);
    const handleFiles = vm.runInContext('handleFiles', win);
    const waitForAllSourceProcessing = vm.runInContext('waitForAllSourceProcessing', win);
    const isSourceReady = vm.runInContext('isSourceReady', win);
    const retrieveContext = vm.runInContext('retrieveContext', win);
    const buildSourceManifest = vm.runInContext('buildSourceManifest', win);

    installFakePdfJs(win, { numPages: 12, textPerPage: (p) => `Trang ${p}. Bài 2.${p} yêu cầu tính diện tích hình thang.` });
    installFakeVisionApi(win, {});

    await handleFiles([fakeFile('giaotrinh.pdf')]);
    await waitForAllSourceProcessing();

    ok(state.docs.length === 1, 'upload tạo đúng 1 source');
    const doc = state.docs[0];
    ok(isSourceReady(doc), `PDF text-layer -> READY sau khi xử lý xong (status=${doc.processing.status})`);
    ok(doc.processing.extractionMethod === 'text', 'nhận diện đúng là nguồn text, không đi đường vision');
    ok(doc.processing.parsedPages === 12 && doc.processing.verifiedPages === 12,
      `parsed 12/12 và verified 12/12 (nhận ${doc.processing.parsedPages}/${doc.processing.verifiedPages})`);

    const manifest = buildSourceManifest();
    ok(manifest.indexOf('parsed: 12/12') !== -1 && manifest.indexOf('status: READY') !== -1,
      'manifest in số thật parsed 12/12 + status READY');
    ok(manifest.indexOf('coverage 100%') === -1, 'manifest KHÔNG còn chuỗi "coverage 100%" hardcode');

    const r = retrieveContext('giải bài 2.7 giúp mình');
    ok(r.some((c) => c.text.indexOf('Bài 2.7') !== -1), 'truy hồi lấy đúng evidence của bài 2.7');
    ok(r.every((c) => c.sourceId != null && c.evidenceId), 'mọi evidence mang sourceId + evidenceId');
  }

  console.log('\n== E2E 2: PDF scan — KHÔNG được READY trước khi vision đọc xong ==');
  {
    const win = await bootApp();
    const state = vm.runInContext('state', win);
    const handleFiles = vm.runInContext('handleFiles', win);
    const waitForAllSourceProcessing = vm.runInContext('waitForAllSourceProcessing', win);
    const isSourceReady = vm.runInContext('isSourceReady', win);
    const retrieveContext = vm.runInContext('retrieveContext', win);
    const collectSourceImages = vm.runInContext('collectSourceImages', win);

    installFakePdfJs(win, { numPages: 10, textPerPage: null }); // không có text layer
    const calls = installFakeVisionApi(win, {});

    const uploadPromise = handleFiles([fakeFile('scan.pdf')]);
    // Trong lúc đang xử lý: tuyệt đối không được có context nào rò ra.
    const during = retrieveContext('bài 1.3 nói gì');
    ok(during.length === 0, 'ĐANG xử lý -> retrieveContext() rỗng, không rò context một phần');
    ok(collectSourceImages('bài 1.3').length === 0, 'ĐANG xử lý -> không gửi kèm ảnh trang của nguồn chưa xong');

    await uploadPromise;
    await waitForAllSourceProcessing();

    const doc = state.docs[0];
    ok(doc.sourceType === 'image-pdf' && doc.processing.extractionMethod === 'vision',
      'nhận diện đúng PDF chỉ-ảnh -> đi đường vision');
    ok(calls.pages.length === 10, `vision đọc đủ 10 trang trong pha index (nhận ${calls.pages.length})`);
    ok(isSourceReady(doc), 'đọc + verify đủ 10/10 -> READY');
    ok(doc.processing.renderCoverage === 100 && doc.processing.readCoverage === 100 && doc.processing.verifiedCoverage === 100,
      'cả 3 coverage đều 100 khi thật sự xong');

    const r = retrieveContext('giải bài 1.7');
    ok(r.some((c) => c.page === 7), 'evidence vision truy hồi được theo đúng trang');
    ok(r.every((c) => !/⏳/.test(c.text)), 'không placeholder nào lọt vào context');
    ok(r.every((c) => c.extractionMethod === 'vision'), 'evidence khai đúng phương pháp trích xuất');

    const before = calls.pages.length;
    for (let i = 0; i < 5; i++) retrieveContext(`câu hỏi ${i}`);
    ok(calls.pages.length === before, 'hỏi thêm 5 lượt -> KHÔNG gọi lại vision (token indexing chỉ trả 1 lần)');
  }

  console.log('\n== E2E 3: PDF scan có trang đọc hỏng -> INCOMPLETE, chặn gửi request ==');
  {
    const win = await bootApp();
    const state = vm.runInContext('state', win);
    const handleFiles = vm.runInContext('handleFiles', win);
    const waitForAllSourceProcessing = vm.runInContext('waitForAllSourceProcessing', win);
    const isSourceReady = vm.runInContext('isSourceReady', win);
    const retrieveContext = vm.runInContext('retrieveContext', win);
    const buildSourceStatusPayload = vm.runInContext('buildSourceStatusPayload', win);
    const el = vm.runInContext('el', win);

    installFakePdfJs(win, { numPages: 8, textPerPage: null });
    installFakeVisionApi(win, { failPages: [4] });

    await handleFiles([fakeFile('scan-loi.pdf')]);
    await waitForAllSourceProcessing();

    const doc = state.docs[0];
    ok(!isSourceReady(doc) && doc.processing.status === 'INCOMPLETE',
      `1 trang không đọc được -> INCOMPLETE, không READY giả (nhận ${doc.processing.status})`);
    ok(doc.processing.failedPages.indexOf(4) !== -1, 'ghi đúng trang lỗi vào failedPages');
    ok(retrieveContext('bài 1.2 nói gì').length === 0,
      'nguồn INCOMPLETE -> KHÔNG được dùng làm nguồn cho câu hỏi');

    const payload = buildSourceStatusPayload();
    ok(payload.length === 1 && payload[0].status === 'INCOMPLETE' && payload[0].verifiedPages === 7,
      'payload gửi server khai đúng trạng thái thật (7/8 trang, INCOMPLETE)');
    void el;
  }

  console.log('\n== E2E 4: trang trắng thật vs "không đọc được" — phân biệt bằng confidence ==');
  {
    const win = await bootApp();
    const state = vm.runInContext('state', win);
    const processPdfVisionEvidence = vm.runInContext('processPdfVisionEvidence', win);
    const setSourceStatus = vm.runInContext('setSourceStatus', win);
    const isSourceReady = vm.runInContext('isSourceReady', win);

    // Dựng doc scan 4 trang: trang 2 trắng nhưng model TỰ TIN (trang trắng thật),
    // trang 3 trắng và model KHÔNG tin tưởng (thực chất là đọc hỏng).
    const doc = {
      id: 1, name: 'mix.pdf', ext: 'pdf', sourceType: 'image-pdf',
      pageImages: [1, 2, 3, 4].map((p) => ({ page: p, mediaType: 'image/jpeg', base64: 'AAAA' })),
      pageEvidence: {}, chunks: [{ id: 1, text: '⏳ đang đọc', placeholder: true }]
    };
    setSourceStatus(doc, 'RASTERIZING', {
      extractionMethod: 'vision', totalPages: 4, renderedPages: 4,
      parsedPages: 0, extractedPages: 0, verifiedPages: 0, failedPages: []
    });
    state.docs = [doc];
    win.apiPost = (p, body) => Promise.resolve({
      results: body.pages.map((pg) => {
        if (pg.page === 2) return { page: 2, ok: true, extractedText: '', equations: [], diagrams: [], confidence: 0.95 };
        if (pg.page === 3) return { page: 3, ok: true, extractedText: '', equations: [], diagrams: [], confidence: 0.03 };
        return { page: pg.page, ok: true, extractedText: `Trang ${pg.page}: nội dung.`, equations: [], diagrams: [], confidence: 0.9 };
      })
    });
    vm.runInContext('apiPost = globalThis.apiPost;', win);

    await processPdfVisionEvidence(doc);
    ok(doc.processing.failedPages.indexOf(3) !== -1,
      'trang rỗng + confidence 0.03 bị coi là ĐỌC HỎNG (vào failedPages), không phải trang trắng');
    ok(doc.processing.failedPages.indexOf(2) === -1,
      'trang rỗng + confidence 0.95 được chấp nhận là TRANG TRẮNG THẬT — không đánh trượt oan');
    ok(!isSourceReady(doc), 'còn 1 trang đọc hỏng -> source chưa READY');
  }

  console.log('\n== E2E 5: nguồn lỗi hoàn toàn -> ERROR, không placeholder nào vào context ==');
  {
    const win = await bootApp();
    const state = vm.runInContext('state', win);
    const handleFiles = vm.runInContext('handleFiles', win);
    const waitForAllSourceProcessing = vm.runInContext('waitForAllSourceProcessing', win);
    const retrieveContext = vm.runInContext('retrieveContext', win);

    win.pdfjsLib = null;
    vm.runInContext('window.pdfjsLib = null; pdfjsLib = null;', win);
    win.__loadVendorScript = () => Promise.reject(new Error('offline'));
    vm.runInContext('window.__loadVendorScript = globalThis.__loadVendorScript;', win);

    await handleFiles([fakeFile('hong.pdf')]);
    await waitForAllSourceProcessing();

    const doc = state.docs[0];
    ok(doc.processing.status === 'ERROR', `không đọc được file -> ERROR (nhận ${doc.processing.status})`);
    ok(doc.processing.lastError, 'có ghi lastError để debug, không nuốt lỗi');
    ok(retrieveContext('bất kỳ câu hỏi nào').length === 0, 'nguồn ERROR không đóng góp context nào');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
