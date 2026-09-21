'use strict';

// Cần server Express thật -> bỏ qua có thông báo nếu chưa npm install (xem test/_depGuard.js).
require('./_depGuard').requireDeps(['express', 'dotenv'], 'visual-upgrade.test.js');


// ============================================================================================
// TEST cho 5 lỗ hổng được vá ở đợt nâng cấp hệ thống hình minh hoạ (mục 1.1 -> 1.5)
// ============================================================================================
//   (a) router: mọi hình 2D tĩnh -> generated_image; needsPreciseGeometry chỉ còn siết prompt
//   (b) buildImagePrompt() theo cấu trúc 16 mục: CÓ dữ kiện chính xác + style theo môn + cắt hạn mức
//   (c) overlay render đúng verifiedNumbers
//   (d) nút tải tạo đúng blob + filename
//   (e) lightbox mở/đóng (Esc, click nền, nút Đóng)
//
// (c)(d)(e) chạy THẬT: trích đúng khối hàm hình minh hoạ trong public/js/app.js rồi thực thi trong
// một DOM stub tối giản — không phải kiểm tra tĩnh bằng regex, nên test sẽ gãy nếu hành vi đổi.
// Chạy: node test/visual-upgrade.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sb = require('../server/utils/visual/visualSpecBuilder');
const router = require('../server/utils/visual/visualRendererRouter');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  -', name); }
  catch (e) { failed++; console.log(' FAIL -', name, '\n       ', e.stack || e.message); }
}

// ============================================================================================
// (a) ROUTER — mục 1.1 (CASE 1 vs CASE 3 của PHẦN 24)
// ============================================================================================
async function routerTests() {
  console.log('\n== (a) Router: mọi hình 2D tĩnh đi ảnh AI, needsPreciseGeometry chỉ siết prompt ==');

  await test('physics_diagram định tính + có provider ảnh -> generated_image', () => {
    const route = router.chooseVisualRenderer(
      { type: 'physics_diagram', needsPreciseGeometry: false },
      { imageProviderAvailable: true }
    );
    assert.strictEqual(route.renderer, 'generated_image');
    assert.strictEqual(route.primary, 'image_generation');
    assert.strictEqual(route.highPrecisionRequired, false);
    assert.deepStrictEqual(route.fallbacks, [], 'không còn renderer thay thế');
  });

  await test('optics_diagram định tính -> generated_image', () => {
    const route = router.chooseVisualRenderer(
      { type: 'optics_diagram', needsPreciseGeometry: false },
      { imageProviderAvailable: true }
    );
    assert.strictEqual(route.primary, 'image_generation');
  });

  await test('physics_diagram CÓ số đo -> vẫn ảnh AI nhưng highPrecisionRequired=true', () => {
    const route = router.chooseVisualRenderer(
      { type: 'physics_diagram', needsPreciseGeometry: true },
      { imageProviderAvailable: true }
    );
    assert.strictEqual(route.renderer, 'generated_image');
    assert.strictEqual(route.highPrecisionRequired, true);
  });

  await test('spec CŨ (không có cờ) -> vẫn ảnh AI, không rơi về renderer nào khác', () => {
    const route = router.chooseVisualRenderer({ type: 'physics_diagram' }, { imageProviderAvailable: true });
    assert.strictEqual(route.renderer, 'generated_image');
    assert.strictEqual(route.primary, 'image_generation');
  });

  await test('không có provider ảnh -> blocked, KHÔNG có hình thay thế', () => {
    const route = router.chooseVisualRenderer(
      { type: 'physics_diagram', needsPreciseGeometry: false },
      { imageProviderAvailable: false }
    );
    assert.strictEqual(route.blocked, 'no_image_provider');
    assert.deepStrictEqual(route.fallbacks, []);
  });

  await test('loại độ chính xác cao: renderer vẫn là ảnh AI, chỉ khác cờ', () => {
    ['mathematical_plot', 'geometry_diagram', 'circuit_diagram', 'chart'].forEach((type) => {
      const route = router.chooseVisualRenderer({ type, needsPreciseGeometry: false }, { imageProviderAvailable: true });
      assert.strictEqual(route.renderer, 'generated_image', type);
      assert.strictEqual(route.highPrecisionRequired, true, type);
    });
  });

  await test('needsPreciseGeometry tính ĐÚNG: đề có góc/toạ độ/đồ thị -> true', () => {
    assert.strictEqual(sb.computeNeedsPreciseGeometry({}, 'Vẽ đúng góc nghiêng θ = 30° của mặt phẳng'), true);
    assert.strictEqual(sb.computeNeedsPreciseGeometry({}, 'Điểm A(2; 3) trên hệ trục toạ độ'), true);
    assert.strictEqual(sb.computeNeedsPreciseGeometry({ data: { plotExpr: 'x^2-1' } }, 'y = x^2 - 1'), true);
    assert.strictEqual(sb.computeNeedsPreciseGeometry({ relationships: ['perpendicular'] }, 'AB vuông góc BC'), true);
  });

  await test('needsPreciseGeometry tính ĐÚNG: đề định tính -> false', () => {
    assert.strictEqual(
      sb.computeNeedsPreciseGeometry({ relationships: [], objects: [], data: {} },
        'Một vật đang nằm yên trên mặt phẳng nghiêng, hãy mô tả các lực tác dụng lên vật.'),
      false
    );
  });

  await test('buildVisualSpec gắn cờ vào spec (router không phải tự đoán)', () => {
    const qualitative = sb.buildVisualSpec({
      decision: { visualType: 'physics_diagram', visualPurpose: 'mô tả lực' },
      question: 'Một vật nằm trên mặt phẳng nghiêng, kể tên các lực tác dụng.',
      finalAnswer: 'Vật chịu trọng lực, phản lực và lực ma sát.',
      subject: 'physics'
    });
    assert.strictEqual(qualitative.needsPreciseGeometry, false);

    const precise = sb.buildVisualSpec({
      decision: { visualType: 'physics_diagram', visualPurpose: 'vẽ lực' },
      question: 'Mặt phẳng nghiêng góc = 30°, vẽ đúng các lực.',
      finalAnswer: 'Ta có g = 10 m/s².',
      subject: 'physics'
    });
    assert.strictEqual(precise.needsPreciseGeometry, true);
  });
}

// ============================================================================================
// (b) buildImagePrompt — mục 1.2 + 1.5 + 2.1
// ============================================================================================
function physicsSpec() {
  return sb.buildVisualSpec({
    decision: { visualType: 'physics_diagram', visualPurpose: 'minh hoạ vật trên mặt phẳng nghiêng' },
    question: 'Vật trượt trên mặt phẳng nghiêng với v0 = 20 m/s',
    finalAnswer: 'Ta có v0 = 20 m/s và g = 10 m/s². $$F = ma$$',
    subject: 'physics'
  });
}

async function promptTests() {
  console.log('\n== (b) buildImagePrompt: cấu trúc 16 mục, CÓ dữ kiện chính xác, cắt đúng hạn mức ==');

  await test('prompt có đủ khung 16 mục (Purpose -> Do not replace or omit required labels)', () => {
    const spec = physicsSpec();
    const prompt = sb.buildImagePrompt(spec);
    ['Purpose:', 'Subject:', 'Exact facts:', 'Style:', 'Aspect ratio:', 'Language:'].forEach((k) => {
      assert.ok(prompt.includes(k), 'thiếu mục ' + k);
    });
    assert.ok(/No invented data/.test(prompt));
    assert.ok(/Educational clarity/.test(prompt));
    assert.ok(/High quality/.test(prompt));
    assert.ok(/No watermark/.test(prompt));
    assert.ok(/No UI screenshot/.test(prompt));
    assert.ok(/Do not replace or omit required labels/.test(prompt));
  });

  await test('kiến trúc mới: dữ kiện CHÍNH XÁC PHẢI có trong prompt (không còn renderer nào lo số đo)', () => {
    const spec = physicsSpec();
    assert.ok(spec.objects.length > 0, 'spec phải trích được đại lượng (nếu không thì test vô nghĩa)');
    const prompt = sb.buildImagePrompt(spec);
    spec.objects.forEach((o) => {
      assert.ok(prompt.includes(`${o.symbol} = ${o.value}`), `prompt phải mang dữ kiện ${o.symbol}`);
    });
  });

  await test('hình học/sơ đồ khoa học kèm chỉ thị siết topology/measurement', () => {
    const geo = sb.buildVisualSpec({
      decision: { visualType: 'geometry_diagram', visualPurpose: 'tam giác' },
      question: 'Cho tam giác ABC vuông tại A, AB = 3 cm',
      finalAnswer: 'Tam giác ABC vuông tại A, AB = 3 cm, AC = 4 cm.', subject: 'math'
    });
    const prompt = sb.buildImagePrompt(geo);
    assert.ok(prompt.includes(sb.GEOMETRY_STRICT_DIRECTIVES));
    assert.ok(/Required labels:/.test(prompt), 'hình học phải liệt kê nhãn bắt buộc');
  });

  await test('đồ thị hàm số: biểu thức đi vào Math/measurement constraints, không tự bịa', () => {
    const plot = sb.buildVisualSpec({
      decision: { visualType: 'mathematical_plot', visualPurpose: 'đồ thị' },
      question: 'Vẽ đồ thị hàm số y = x^2-2x-3',
      finalAnswer: 'Ta có y = x^2-2x-3, đỉnh I(1;-4).', subject: 'math'
    });
    const prompt = sb.buildImagePrompt(plot);
    assert.ok(/Math\/measurement constraints:/.test(prompt));
    assert.ok(prompt.includes('x^2-2x-3'), 'phải mô tả đúng biểu thức');
    assert.ok(/hệ trục Oxy/.test(prompt));
  });

  await test('prompt KHÔNG chứa chain-of-thought / cả lời giải', () => {
    const spec = sb.buildVisualSpec({
      decision: { visualType: 'physics_diagram', visualPurpose: 'lực' },
      question: 'Vật trượt',
      finalAnswer: 'Bước 1: phân tích lực. '.repeat(200), subject: 'physics'
    });
    const prompt = sb.buildImagePrompt(spec);
    assert.ok(!/Bước 1: phân tích lực. Bước 1/.test(prompt));
    assert.ok(prompt.length <= sb.DEFAULT_PROMPT_CHAR_LIMIT);
  });

  await test('prompt luôn giữ khối ràng buộc cuối (không bị cắt)', () => {
    const prompt = sb.buildImagePrompt(physicsSpec());
    assert.ok(prompt.endsWith(sb.IMAGE_SAFETY_CONSTRAINT), 'ràng buộc phải nằm cuối, không bị cắt');
  });

  await test('style khác nhau theo môn (PHẦN 6), không còn 1 chuỗi dùng chung', () => {
    const subjects = ['physics', 'biology', 'chemistry', 'geography', 'general'];
    const ids = subjects.map((s) => sb.styleProfileFor(s).id);
    assert.strictEqual(new Set(ids).size, 5, 'mỗi môn phải có style riêng: ' + ids.join(','));
    const bio = sb.buildVisualSpec({
      decision: { visualType: 'biology_diagram', visualPurpose: 'cấu tạo tế bào' },
      question: 'Vẽ cấu tạo tế bào thực vật', finalAnswer: 'Gồm nhân, lục lạp, ti thể.', subject: 'biology'
    });
    const phy = physicsSpec();
    assert.notStrictEqual(bio.style, phy.style);
    assert.ok(sb.buildImagePrompt(bio).includes(sb.STYLE_PROFILES.biology.prompt));
    assert.ok(sb.buildImagePrompt(phy).includes(sb.STYLE_PROFILES.physics.prompt));
  });

  await test('mục 2.1: prompt bị CẮT về dưới hạn mức ký tự của provider', () => {
    const spec = physicsSpec();
    spec.purpose = 'mô tả cảnh '.repeat(600); // ép vượt ngưỡng
    const gemini = sb.buildImagePrompt(spec, { maxChars: 2000 });
    const openai = sb.buildImagePrompt(spec, { maxChars: 4000 });
    assert.ok(gemini.length <= 2000, 'Gemini: thấy ' + gemini.length);
    assert.ok(openai.length <= 4000, 'OpenAI: thấy ' + openai.length);
    assert.ok(gemini.endsWith(sb.IMAGE_SAFETY_CONSTRAINT), 'cắt phần mô tả cảnh, KHÔNG cắt ràng buộc an toàn');
  });

  await test('VISUAL_PROMPT_VERSION đã bump lên v4 (cache ảnh của prompt cũ không được trả lại)', () => {
    assert.ok(/^visual-prompt-v[4-9]/.test(sb.VISUAL_PROMPT_VERSION), sb.VISUAL_PROMPT_VERSION);
  });

  await test('spec vẫn giữ verifiedNumbers/Equations cho overlay (mục 1.3)', () => {
    const spec = physicsSpec();
    assert.ok(spec.verifiedNumbers.some((n) => n.symbol === 'v0' && n.value === 20));
    const overlay = sb.buildVisualOverlay(spec);
    assert.ok(overlay && overlay.numbers.length, 'overlay phải có số liệu đã verify');
  });
}

// ============================================================================================
// DOM STUB tối giản để chạy THẬT khối hàm hình minh hoạ trong public/js/app.js
// ============================================================================================
function createDom() {
  class ClassList {
    constructor(el) { this.el = el; this.set = new Set(); }
    add(...c) { c.forEach((x) => this.set.add(x)); this.sync(); }
    remove(...c) { c.forEach((x) => this.set.delete(x)); this.sync(); }
    contains(c) { return this.set.has(c); }
    toggle(c) { const has = this.set.has(c); if (has) this.set.delete(c); else this.set.add(c); this.sync(); return !has; }
    sync() { this.el._className = [...this.set].join(' '); }
  }
  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.attributes = {};
      this.listeners = {};
      this._className = '';
      this.classList = new ClassList(this);
      this.textContent = '';
      this.innerHTML = '';
      this.disabled = false;
      this.style = {};
    }
    get className() { return this._className; }
    set className(v) {
      this._className = String(v || '');
      this.classList.set = new Set(this._className.split(/\s+/).filter(Boolean));
    }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
    dispatch(type, ev) { (this.listeners[type] || []).slice().forEach((fn) => fn(ev || { target: this })); }
    click() { this.dispatch('click', { target: this }); }
    focus() { this._focused = true; }
    all() { return this.children.reduce((acc, c) => acc.concat([c], c.all()), []); }
    querySelectorAll(sel) {
      const raw = String(sel);
      if (raw.startsWith('.')) return this.all().filter((e) => e.classList.contains(raw.slice(1)));
      return this.all().filter((e) => e.tagName === raw.toUpperCase());
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    findText(txt) { return this.all().filter((e) => e.textContent === txt); }
  }
  const doc = new El('document');
  doc.body = new El('body');
  doc.appendChild(doc.body);
  doc.createElement = (tag) => new El(tag);
  doc.querySelector = (sel) => doc.body.querySelector(sel);
  doc.querySelectorAll = (sel) => doc.body.querySelectorAll(sel);
  return { doc, El };
}

function loadVisualModule(fetchImpl) {
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const start = appJs.indexOf('// === VISUAL_DOWNLOAD_BLOCK_START ===');
  const end = appJs.indexOf('function renderAnswerBlock(container, rawText) {');
  assert.ok(start !== -1 && end !== -1 && end > start, 'không trích được khối hàm hình minh hoạ trong app.js');
  const src = appJs.slice(start, end);

  const { doc } = createDom();
  const created = [];
  const revoked = [];
  const sandbox = {
    document: doc,
    t: (k) => k,
    fetch: fetchImpl,
    URL: {
      createObjectURL: (blob) => { created.push(blob); return 'blob:mock/' + created.length; },
      revokeObjectURL: (u) => revoked.push(u)
    },
    setTimeout, clearTimeout, console
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + '\n;({ renderVisuals, renderVisualCard, renderVisualImage, renderVisualCaption,'
    + ' renderVisualActions, renderVisualOverlay, openVisualLightbox, downloadVisualPNG,'
    + ' visualDownloadName, isGeneratedImageVisual, visualProxySrc });', sandbox);
  const api = vm.runInContext('({ renderVisuals, renderVisualCard, renderVisualActions, renderVisualOverlay,'
    + ' openVisualLightbox, downloadVisualPNG, visualDownloadName, isGeneratedImageVisual,'
    + ' visualProxySrc, renderVisualImage })', sandbox);
  return { api, doc, created, revoked };
}

const imageVisual = {
  visualId: 'vz_abc_1', subject: 'physics', type: 'physics_diagram', renderer: 'generated_image',
  format: 'data_url', url: 'data:image/png;base64,iVBORw0KGgo=', title: 'Sơ đồ lực',
  caption: 'vật trên mặt phẳng nghiêng', necessity: 'NECESSARY',
  overlay: { numbers: [{ symbol: 'v0', value: 20, unit: 'm/s' }, { symbol: 'g', value: 10, unit: 'm/s²' }], labels: ['A', 'B'], equations: ['F = ma'] }
};

// ============================================================================================
// (c) OVERLAY
// ============================================================================================
async function overlayTests() {
  console.log('\n== (c) Overlay số liệu đã verify: render đúng + toggle được ==');
  const { api, doc } = loadVisualModule(async () => ({ ok: true, blob: async () => ({ size: 8 }) }));

  await test('overlay liệt kê ĐÚNG verifiedNumbers (kèm đơn vị) + công thức + nhãn', () => {
    const el = api.renderVisualOverlay(imageVisual);
    assert.ok(el, 'phải có overlay');
    const items = el.querySelectorAll('.visual-overlay-list').reduce((a, l) => a.concat(l.children), []);
    const texts = items.map((li) => li.textContent);
    assert.ok(texts.includes('v0 = 20 m/s'), texts.join(' | '));
    assert.ok(texts.includes('g = 10 m/s²'), texts.join(' | '));
    assert.ok(texts.includes('F = ma'), 'công thức đã verify phải hiển thị ở overlay');
    assert.ok(el.querySelector('.visual-overlay-labels').textContent.includes('A, B'));
  });

  await test('overlay có nút ẩn/hiện và toggle THẬT (PHẦN 14)', () => {
    const el = api.renderVisualOverlay(imageVisual);
    const btn = el.querySelector('.visual-overlay-toggle');
    assert.ok(btn, 'thiếu nút toggle');
    assert.strictEqual(el.classList.contains('is-collapsed'), false);
    btn.click();
    assert.strictEqual(el.classList.contains('is-collapsed'), true);
    assert.strictEqual(btn.getAttribute('aria-expanded'), 'false');
    btn.click();
    assert.strictEqual(el.classList.contains('is-collapsed'), false);
  });

  await test('không có overlay data -> không dựng khối rỗng', () => {
    assert.strictEqual(api.renderVisualOverlay({ ...imageVisual, overlay: null }), null);
  });

  await test('card ảnh AI có overlay; renderVisuals gắn được vào container', () => {
    const container = doc.createElement('div');
    api.renderVisuals(container, [imageVisual], 'ready');
    const card = container.querySelector('.visual-card');
    assert.ok(card, 'thiếu card');
    assert.ok(card.querySelector('.visual-overlay'), 'card ảnh AI phải có overlay số liệu');
    assert.ok(card.querySelector('.visual-img'), 'thiếu ảnh');
  });

  await test('status pending -> hiện dòng "đang tạo hình", KHÔNG để trống (PHẦN 16)', () => {
    const container = doc.createElement('div');
    api.renderVisuals(container, [], 'pending');
    const note = container.querySelector('.visual-loading');
    assert.ok(note && note.textContent === 'chat.visualGenerating');
    api.renderVisuals(container, [imageVisual], 'ready');
    assert.strictEqual(container.querySelectorAll('.visual-loading').length, 0, 'phải dọn placeholder khi có hình thật');
  });

  await test('CÓ toạ độ thật -> nhãn NEO theo % lên ảnh (không đoán vị trí)', () => {
    const anchored = { ...imageVisual, overlay: { ...imageVisual.overlay, anchors: [
      { label: 'A', xPct: 10, yPct: 90 }, { label: 'B', xPct: 90, yPct: 90 }
    ] } };
    const wrap = api.renderVisualImage(anchored);
    const tags = wrap.querySelectorAll('.visual-anchor');
    assert.strictEqual(tags.length, 2);
    assert.strictEqual(tags[0].textContent, 'A');
    assert.strictEqual(tags[0].style.left, '10%');
    assert.strictEqual(tags[0].style.top, '90%');
  });

  await test('KHÔNG có toạ độ -> không có lớp neo nào (lùi về bảng chú thích)', () => {
    const wrap = api.renderVisualImage(imageVisual);
    assert.strictEqual(wrap.querySelectorAll('.visual-anchor-layer').length, 0);
  });

  await test('anchorsFromPoints quy toạ độ thật về % (y lật, biên 10..90)', () => {
    const anchors = sb.anchorsFromPoints(sb.extractPointCoordinates('Cho A(0;0), B(4;0), C(0;3).'));
    assert.deepStrictEqual(anchors, [
      { label: 'A', xPct: 10, yPct: 90 },
      { label: 'B', xPct: 90, yPct: 90 },
      { label: 'C', xPct: 10, yPct: 10 }
    ]);
    assert.deepStrictEqual(sb.anchorsFromPoints([{ label: 'A', x: 1, y: 1 }]), [], 'thiếu dữ liệu -> KHÔNG bịa vị trí');
  });

  await test('ảnh https hiển thị QUA proxy inline (CSP img-src không mở cho domain ngoài)', () => {
    const remote = { ...imageVisual, format: 'image_url', url: 'https://cdn.openai.com/x/y.png' };
    const wrap = api.renderVisualImage(remote);
    const src = wrap.querySelector('.visual-img').attributes.src || wrap.querySelector('.visual-img').src;
    assert.ok(String(src).startsWith('/api/visual/download?url='), String(src));
    assert.ok(String(src).endsWith('&inline=1'), 'hiển thị phải là inline, không phải attachment');
    assert.strictEqual(api.visualProxySrc(imageVisual, 'inline'), imageVisual.url, 'data: URI dùng thẳng');
  });
}

// ============================================================================================
// (d) NÚT TẢI
// ============================================================================================
async function downloadTests() {
  console.log('\n== (d) Nút tải: blob + filename đúng, https đi qua proxy backend ==');

  await test('filename = <subject>-<visualId>.png, không chứa câu hỏi', () => {
    const { api } = loadVisualModule(async () => ({ ok: true, blob: async () => ({}) }));
    assert.strictEqual(api.visualDownloadName(imageVisual), 'physics-vz-abc-1.png');
  });

  await test('data: URI -> fetch chính URL đó -> blob -> createObjectURL -> <a download>', async () => {
    const calls = [];
    const { api, doc, created } = loadVisualModule(async (u) => {
      calls.push(u);
      return { ok: true, blob: async () => ({ type: 'image/png' }) };
    });
    const card = api.renderVisualCard ? null : null; // card không cần cho test này
    const bar = api.renderVisualActions(imageVisual);
    const dl = bar.children[1];
    assert.strictEqual(dl.textContent, 'chat.visualDownload');
    await api.downloadVisualPNG(imageVisual, dl);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0], imageVisual.url, 'data: URI phải fetch thẳng, không qua proxy');
    assert.strictEqual(created.length, 1, 'phải tạo object URL từ blob');
    void card; void doc;
  });

  await test('https:// -> đi qua /api/visual/download (CSP/CORS chặn fetch thẳng)', async () => {
    const calls = [];
    const { api } = loadVisualModule(async (u) => { calls.push(u); return { ok: true, blob: async () => ({}) }; });
    const remote = { ...imageVisual, format: 'image_url', url: 'https://cdn.openai.com/x/y.png' };
    await api.downloadVisualPNG(remote, null);
    assert.ok(calls[0].startsWith('/api/visual/download?url='), calls[0]);
    assert.ok(calls[0].includes(encodeURIComponent(remote.url)));
    assert.ok(calls[0].includes('visualId=vz_abc_1'));
  });

  await test('tải lỗi -> báo trên nút, KHÔNG throw ra ngoài', async () => {
    const { api } = loadVisualModule(async () => ({ ok: false, status: 500 }));
    const bar = api.renderVisualActions(imageVisual);
    const dl = bar.children[1];
    await api.downloadVisualPNG(imageVisual, dl);
    assert.strictEqual(dl.textContent, 'chat.visualDownloadFailed');
  });

  await test('payload SVG kiểu cũ: KHÔNG dựng card, KHÔNG có nút nào (SVG đã bị loại bỏ)', () => {
    const { api } = loadVisualModule(async () => ({ ok: true, blob: async () => ({}) }));
    const svgVisual = { visualId: 'v1', format: 'svg', content: '<svg><rect/></svg>', title: 'Đồ thị' };
    assert.strictEqual(api.isGeneratedImageVisual(svgVisual), false);
    assert.strictEqual(api.renderVisualActions(svgVisual), null, 'SVG không còn được cấp nút nào');
    assert.strictEqual(api.renderVisualCard(svgVisual), null, 'SVG không bao giờ được dựng thành card');
  });

}

// ============================================================================================
// (e) LIGHTBOX
// ============================================================================================
async function lightboxTests() {
  console.log('\n== (e) Lightbox: mở/đóng bằng nút, Esc, click nền ==');

  function open() {
    const ctx = loadVisualModule(async () => ({ ok: true, blob: async () => ({}) }));
    const box = ctx.api.openVisualLightbox(imageVisual);
    return { ...ctx, box };
  }

  await test('nút "Mở ảnh" mở lightbox có ảnh + nút tải bên trong', () => {
    const { api, doc } = loadVisualModule(async () => ({ ok: true, blob: async () => ({}) }));
    api.renderVisualActions(imageVisual).children[0].click();
    const box = doc.querySelector('.visual-lightbox');
    assert.ok(box, 'lightbox chưa mở');
    assert.ok(box.querySelector('.visual-lightbox-img'), 'thiếu ảnh trong lightbox');
    assert.strictEqual(box.getAttribute('aria-modal'), 'true');
    const btns = box.querySelectorAll('.visual-btn').map((b) => b.textContent);
    assert.ok(btns.includes('chat.visualDownload'), 'lightbox phải có nút tải PNG');
  });

  await test('nút Đóng gỡ lightbox khỏi DOM', () => {
    const { doc, box } = open();
    box.querySelector('.visual-btn-close').click();
    assert.strictEqual(doc.querySelector('.visual-lightbox'), null);
  });

  await test('Esc đóng lightbox', () => {
    const { doc, box } = open();
    void box;
    doc.dispatch('keydown', { key: 'Escape' });
    assert.strictEqual(doc.querySelector('.visual-lightbox'), null);
  });

  await test('click NỀN đóng, click vào ảnh KHÔNG đóng', () => {
    const { doc, box } = open();
    box.dispatch('click', { target: box.querySelector('.visual-lightbox-img') });
    assert.ok(doc.querySelector('.visual-lightbox'), 'click vào ảnh không được đóng');
    box.dispatch('click', { target: box });
    assert.strictEqual(doc.querySelector('.visual-lightbox'), null);
  });

  await test('mở lần 2 không để lại lightbox cũ chồng lên', () => {
    const { api, doc } = loadVisualModule(async () => ({ ok: true, blob: async () => ({}) }));
    api.openVisualLightbox(imageVisual);
    api.openVisualLightbox(imageVisual);
    assert.strictEqual(doc.querySelectorAll('.visual-lightbox').length, 1);
  });

  await test('payload SVG không mở được lightbox (không phải ảnh thật)', () => {
    const { api } = loadVisualModule(async () => ({ ok: true, blob: async () => ({}) }));
    assert.strictEqual(api.openVisualLightbox({ format: 'svg', content: '<svg/>' }), null);
  });
}

// ============================================================================================
// Proxy tải hộ — chống SSRF (đi kèm mục 1.4)
// ============================================================================================
async function proxyTests() {
  console.log('\n== Proxy /api/visual/download: whitelist domain cứng, chống SSRF ==');
  const visualRoute = require('../server/routes/visual');

  await test('chỉ chấp nhận https + domain trong whitelist', () => {
    assert.ok(visualRoute.parseAllowedUrl('https://cdn.openai.com/a.png'));
    assert.strictEqual(visualRoute.parseAllowedUrl('http://cdn.openai.com/a.png'), null, 'http bị chặn');
    assert.strictEqual(visualRoute.parseAllowedUrl('https://evil.example.com/a.png'), null);
    assert.strictEqual(visualRoute.parseAllowedUrl('https://cdn.openai.com.evil.com/a.png'), null, 'suffix giả mạo');
    assert.strictEqual(visualRoute.parseAllowedUrl('https://169.254.169.254/latest/meta-data'), null, 'metadata nội bộ');
    assert.strictEqual(visualRoute.parseAllowedUrl('file:///etc/passwd'), null);
  });

  await test('tên file sinh ở server cũng theo <subject>-<visualId>.png', () => {
    assert.strictEqual(visualRoute.safeFilename('Vật lý', 'vz_abc_1'), 'vat-ly-vz-abc-1.png');
  });

  // PHẦN H: store nay là KV cross-instance (I/O) nên API bất đồng bộ — assertion GIỮ NGUYÊN,
  // chỉ await. Không nới lỏng điều kiện nào.
  await test('MỤC 2.2/17: store giữ prompt/necessity/subject/title/type, KHÔNG giữ câu hỏi hay lời giải', async () => {
    const hq = require('../server/utils/visual/visualHqStore');
    hq._resetForTest();
    await hq.remember('vz_1', { prompt: 'cảnh vật lý', necessity: 'NECESSARY', subject: 'physics', question: 'đề bài' });
    const got = await hq.get('vz_1');
    assert.deepStrictEqual(Object.keys(got).sort(), ['necessity', 'prompt', 'subject', 'title', 'type']);
    assert.strictEqual(got.title, '', 'không truyền title -> chuỗi rỗng, không phải undefined/lỗi');
    assert.ok(!('question' in got), 'KHÔNG được lưu câu hỏi gốc');
    assert.strictEqual(await hq.get('khong-co'), null, 'không có ngữ cảnh -> null, KHÔNG đoán prompt');
  });

  await test('MỤC 2.2: mặc định vẫn 1024x1024, 2048 chỉ tồn tại ở endpoint /hq', () => {
    const pipelineSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'utils', 'visual', 'visualPipeline.js'), 'utf8');
    // MỤC 2.4a: kích thước mặc định vẫn là 1024x1024, nhưng ở mức degrade 'low' với hình
    // NECESSARY/USER_REQUESTED pipeline được phép hạ xuống 512x512 để vẫn kịp tạo ảnh thật thay vì
    // bỏ hẳn ảnh. Vì vậy assertion kiểm tra MỐC 1024x1024 có mặt, không ép đúng một cách viết.
    const imgClient = require('../server/utils/visual/imageGenerationClient');
    assert.strictEqual(imgClient.sizeForRequest({ aspectRatio: '1:1', quality: 'standard' }).size, '1024x1024',
      'pipeline phải giữ mốc 1024x1024 mặc định (aspect 1:1, quality standard)');
    assert.ok(/sizeForRequest\(\{ aspectRatio: spec\.aspectRatio, quality: 'standard', degrade \}\)/.test(pipelineSrc),
      'chỉ được hạ kích thước ở mức degrade low (qua quality mode fast), mặc định vẫn standard/1024x1024');
    const codeOnly = pipelineSrc.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.ok(!/2048/.test(codeOnly), 'luồng mặc định KHÔNG được đụng tới 2048');
    const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'visual.js'), 'utf8');
    assert.ok(/HQ_SIZE = '2048x2048'/.test(routeSrc));
    assert.ok(/cost_gate_low_benefit/.test(routeSrc), 'endpoint HQ phải đi lại cost-gate, không bypass');
  });

  await test('lightbox có nút "Tải PNG chất lượng cao"', () => {
    const { api, doc } = loadVisualModule(async () => ({ ok: true, blob: async () => ({}) }));
    api.openVisualLightbox(imageVisual);
    const btns = doc.querySelector('.visual-lightbox').querySelectorAll('.visual-btn').map((b) => b.textContent);
    assert.ok(btns.includes('chat.visualDownloadHq'), btns.join(' | '));
  });
}

(async () => {
  await routerTests();
  await promptTests();
  await overlayTests();
  await downloadTests();
  await lightboxTests();
  await proxyTests();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
