'use strict';

// ============================================================================================
// FIDELITY — ĐỀ CẦN HÌNH THẬT (lát cắt/giải phẫu/tiêu bản/bản đồ) ĐƯỢC NHẬN RA VÀ NÓI THẬT
// ============================================================================================
// Kiến trúc AI image-first: mọi hình 2D tĩnh đều là ảnh AI, nên `realismRequired` không còn để
// chọn renderer nữa mà để SIẾT PROMPT (yêu cầu hình tả thực thay vì sơ đồ khối). Ba việc kiểm:
//   1. Nhận ra đề nào thực sự cần hình THẬT.
//   2. Cờ đó đi vào route + prompt ảnh.
//   3. Không có image provider -> KHÔNG có hình (blocked) + gợi ý cấu hình; TUYỆT ĐỐI không dựng
//      sơ đồ SVG thay thế.

const assert = require('assert');
const specBuilder = require('../server/utils/visual/visualSpecBuilder');
const router = require('../server/utils/visual/visualRendererRouter');
const pipeline = require('../server/utils/visual/visualPipeline');
const cache = require('../server/utils/visual/visualCache');
const { loadVisualModules, withFetch, geminiImageResponse } = require('./_imageMock');

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, error: e.message }); }
}

const REALISM_CASES = [
  ['biology', 'Quan sát tiêu bản lá cắt ngang và nhận dạng các lớp mô của lá.'],
  ['biology', 'Mô tả cấu tạo giải phẫu của tim người.'],
  ['biology', 'Describe the cross-section anatomy of a leaf under the microscope.'],
  ['geography', 'Đọc bản đồ địa hình vùng Tây Bắc và xác định hướng sườn dốc.'],
  ['geography', 'Dựa vào ảnh vệ tinh, nhận xét sự thay đổi diện tích rừng.']
];
const SCHEMATIC_CASES = [
  ['biology', 'Kể tên các bào quan trong tế bào nhân thực và chức năng của chúng.'],
  ['biology', 'Trình bày chu trình quang hợp ở thực vật C3.'],
  ['geography', 'Mô tả chu trình nước trong tự nhiên.']
];

(async () => {
  await test('R3-1. Nhận ra đề CẦN HÌNH THẬT (lát cắt/giải phẫu/tiêu bản/bản đồ/ảnh vệ tinh)', () => {
    REALISM_CASES.forEach(([subject, q]) => {
      assert.strictEqual(specBuilder.needsRealism(q, subject), true, 'phải nhận ra: ' + q);
    });
  });

  await test('R3-2. KHÔNG gắn nhãn nhầm cho đề chỉ cần sơ đồ khái niệm', () => {
    SCHEMATIC_CASES.forEach(([subject, q]) => {
      assert.strictEqual(specBuilder.needsRealism(q, subject), false, 'không được đòi hình thật: ' + q);
    });
    // Môn mà 'lát cắt' mang nghĩa hình học thuần tuý (toán/lý) thì không rơi vào nhánh này.
    assert.strictEqual(specBuilder.needsRealism('Vẽ lát cắt của hình chóp theo mặt phẳng (P)', 'math'), false);
  });

  await test('R3-3. CÓ image provider -> ảnh AI, không còn khái niệm "sơ đồ SVG"', () => {
    const spec = { type: 'biology_diagram', realismRequired: true, style: 'educational_scientific' };
    const route = router.chooseVisualRenderer(spec, { imageProviderAvailable: true });
    assert.strictEqual(route.renderer, 'generated_image');
    assert.strictEqual(route.primary, 'image_generation');
    assert.strictEqual(route.fidelity, 'ai_generated');
    assert.strictEqual(route.realismRequired, true);
    assert.strictEqual(route.upgradeHint, null, 'đã có provider thì không còn gì để gợi ý nâng cấp');
  });

  await test('R3-4. KHÔNG có provider -> blocked + gợi ý đúng hướng, KHÔNG dựng hình thay thế', () => {
    const spec = { type: 'biology_diagram', realismRequired: true, style: 'educational_scientific' };
    const route = router.chooseVisualRenderer(spec, { imageProviderAvailable: false });
    assert.strictEqual(route.renderer, 'generated_image', 'renderer không đổi theo cấu hình hạ tầng');
    assert.strictEqual(route.primary, 'image_generation');
    assert.strictEqual(route.blocked, 'no_image_provider');
    assert.strictEqual(route.reason, 'no_image_provider');
    assert.ok(/IMAGE_API_KEY/.test(route.upgradeHint), 'gợi ý phải chỉ đúng đường nâng cấp');
    assert.ok(/KHÔNG dựng hình thay thế bằng SVG/.test(route.upgradeHint),
      'phải nói rõ hệ thống không còn dựng SVG thay thế');
  });

  await test('R3-5. realismRequired đi THẲNG vào prompt ảnh (yêu cầu hình tả thực)', () => {
    const spec = specBuilder.buildVisualSpec({
      decision: { visualType: 'biology_diagram', visualPurpose: 'cấu tạo lá' },
      question: 'Quan sát tiêu bản lá cắt ngang và nhận dạng các lớp mô của lá.',
      finalAnswer: 'Lá gồm biểu bì trên, mô giậu, mô xốp và biểu bì dưới.',
      subject: 'biology'
    });
    assert.strictEqual(spec.realismRequired, true);
    const prompt = specBuilder.buildImagePrompt(spec);
    assert.ok(/tả thực/.test(prompt), 'prompt phải yêu cầu hình tả thực, không phải sơ đồ khối');
    assert.ok(!/<svg/i.test(prompt));
  });

  await test('R3-6. Loại đòi độ chính xác cao vẫn đi ảnh AI, chỉ khác ở cờ + chỉ thị siết', () => {
    const spec = { type: 'geometry_diagram', realismRequired: true, style: 'educational_scientific', language: 'vi', labels: ['A'], objects: [], data: {} };
    const route = router.chooseVisualRenderer(spec, { imageProviderAvailable: true });
    assert.strictEqual(route.renderer, 'generated_image');
    assert.strictEqual(route.highPrecisionRequired, true);
    const prompt = specBuilder.buildImagePrompt({ ...spec, title: 'Hình', purpose: 'p', aspectRatio: '1:1' });
    assert.ok(prompt.includes(specBuilder.GEOMETRY_STRICT_DIRECTIVES),
      'hình học phải kèm chỉ thị exact topology/preserve measurements');
  });

  await test('R3-7. Pipeline: có provider -> ẢNH AI thật; telemetry ghi nhận realism', async () => {
    const { pipeline: pl, restore } = loadVisualModules({ GEMINI_IMAGE_API_KEY: 'k' });
    try {
      const r = await withFetch(async () => geminiImageResponse(), () => pl.runVisualPipeline({
        question: 'Quan sát tiêu bản lá cắt ngang, mô tả và vẽ hình cấu tạo các lớp mô của lá.',
        finalAnswer: 'Lá gồm biểu bì trên, mô giậu, mô xốp và biểu bì dưới. Lục lạp tập trung ở mô giậu.',
        answerComplete: true, subject: 'biology', language: 'vi'
      }));
      assert.strictEqual(r.telemetry.visualRealismRequired, true);
      assert.strictEqual(r.status, 'ready', JSON.stringify(r.telemetry));
      assert.strictEqual(r.visuals[0].renderer, 'generated_image');
      assert.strictEqual(r.visuals[0].fidelity, 'ai_generated');
      assert.notStrictEqual(r.visuals[0].format, 'svg');
    } finally { restore(); }
  });

  await test('R3-7b. Pipeline: KHÔNG có provider -> failed + hint, KHÔNG có visual nội dung', async () => {
    const { pipeline: pl, restore } = loadVisualModules({});
    try {
      const r = await pl.runVisualPipeline({
        question: 'Quan sát tiêu bản lá cắt ngang, mô tả và vẽ hình cấu tạo các lớp mô của lá.',
        finalAnswer: 'Lá gồm biểu bì trên, mô giậu, mô xốp và biểu bì dưới.',
        answerComplete: true, subject: 'biology', language: 'vi'
      });
      assert.strictEqual(r.status, 'failed');
      assert.strictEqual(r.visuals[0].renderFailed, true);
      assert.ok(r.telemetry.visualUpgradeHint, 'telemetry phải mang gợi ý nâng cấp cho người vận hành');
    } finally { restore(); }
  });

  await test('R3-8. Cache key phủ aspect ratio/style — ảnh khác tham số KHÔNG dùng chung bản cũ', () => {
    const base = {
      promptVersion: 'v8', specFingerprint: 'sp', answerStructureHash: 'a', subject: 'biology',
      language: 'vi', renderer: 'generated_image', model: 'gemini', sourceFingerprint: '',
      imageFingerprint: '', userPreference: 'auto'
    };
    const a = cache.buildKey({ ...base, style: 'biology_anatomical#3:4' });
    const b = cache.buildKey({ ...base, style: 'biology_anatomical#1:1' });
    assert.notStrictEqual(a, b, 'style+aspectRatio phải nằm trong cache key');
  });

  let p = 0, f = 0;
  console.log('\n== FIDELITY: đề cần hình thật + không còn đường SVG thay thế ==');
  results.forEach((r) => {
    if (r.pass) { p++; console.log('  ok  - ' + r.name); }
    else { f++; console.log(' FAIL - ' + r.name + '\n        ' + r.error); }
  });
  console.log(`\n${p} passed, ${f} failed`);
  if (f) process.exitCode = 1;
})();
