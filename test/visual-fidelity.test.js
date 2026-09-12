'use strict';

// ============================================================================================
// RỦI RO #3 — RENDERER SINH HỌC/ĐỊA LÝ CHỈ Ở MỨC SƠ ĐỒ: định tuyến đúng + nói thật
// ============================================================================================
// Cách xử lý ĐÚNG không phải là làm renderer đoán hình giải phẫu (hình sai còn tệ hơn không hình).
// Ba việc kiểm ở đây:
//   1. Nhận ra đề nào thực sự cần hình THẬT (lát cắt, giải phẫu, tiêu bản, bản đồ địa hình).
//   2. Có image provider -> đi đường image generation, không phải sơ đồ SVG.
//   3. Không có provider -> vẫn có hình sơ đồ (tốt hơn không có gì) NHƯNG caption nói thẳng đó là
//      sơ đồ khái niệm, telemetry ghi 'schematic_only', và có gợi ý nâng cấp đúng hướng.

const assert = require('assert');
const specBuilder = require('../server/utils/visual/visualSpecBuilder');
const router = require('../server/utils/visual/visualRendererRouter');
const pipeline = require('../server/utils/visual/visualPipeline');
const cache = require('../server/utils/visual/visualCache');

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
    // Môn mà deterministic vốn đã chính xác (toán/lý) thì không bao giờ rơi vào nhánh này.
    assert.strictEqual(specBuilder.needsRealism('Vẽ lát cắt của hình chóp theo mặt phẳng (P)', 'math'), false);
  });

  await test('R3-3. CÓ image provider -> đi đường image generation, không dùng sơ đồ SVG', () => {
    const spec = { type: 'biology_diagram', realismRequired: true, style: 'educational_scientific' };
    const route = router.chooseVisualRenderer(spec, { imageProviderAvailable: true });
    assert.strictEqual(route.primary, 'image_generation');
    assert.strictEqual(route.fidelity, 'illustrative');
    assert.strictEqual(route.upgradeHint, null, 'đã có provider thì không còn gì để gợi ý nâng cấp');
  });

  await test('R3-4. KHÔNG có provider -> vẫn có sơ đồ, nhưng đánh dấu schematic_only + gợi ý đúng hướng', () => {
    const spec = { type: 'biology_diagram', realismRequired: true, style: 'educational_scientific' };
    const route = router.chooseVisualRenderer(spec, { imageProviderAvailable: false });
    assert.strictEqual(route.primary, 'deterministic', 'vẫn phải có hình, không bỏ trắng');
    assert.strictEqual(route.fidelity, 'schematic_only');
    assert.strictEqual(route.reason, 'conceptual_realism_needed_no_provider');
    assert.ok(/IMAGE_API_KEY/.test(route.upgradeHint), 'gợi ý phải chỉ đúng đường nâng cấp');
    assert.ok(/KHÔNG khắc phục bằng cách để renderer tự đoán hình/.test(route.upgradeHint),
      'phải nói rõ hướng SAI để không ai đi làm renderer đoán hình');
  });

  await test('R3-5. Đề chỉ cần sơ đồ -> fidelity "schematic", KHÔNG có cảnh báo thừa', () => {
    const spec = { type: 'biology_diagram', realismRequired: false, style: 'educational_scientific' };
    const route = router.chooseVisualRenderer(spec, { imageProviderAvailable: false });
    assert.strictEqual(route.fidelity, 'schematic');
    assert.strictEqual(route.upgradeHint, null, 'không dọa người dùng khi sơ đồ vốn đã là đáp án đúng');
  });

  await test('R3-6. Loại accuracy-critical KHÔNG bị nhánh realism kéo sang image generation', () => {
    const spec = { type: 'geometry_diagram', realismRequired: true, style: 'educational_scientific' };
    const route = router.chooseVisualRenderer(spec, { imageProviderAvailable: true });
    assert.strictEqual(route.primary, 'deterministic');
    assert.strictEqual(route.accuracyCritical, true);
    assert.ok(!route.fallbacks.includes('image_generation'), 'hình học chính xác không bao giờ giao cho image model');
  });

  await test('R3-7. Pipeline: caption NÓI THẲNG đây là sơ đồ khái niệm + telemetry schematic_only', async () => {
    cache._resetForTest();
    const r = await pipeline.runVisualPipeline({
      question: 'Quan sát tiêu bản lá cắt ngang, mô tả và vẽ hình cấu tạo các lớp mô của lá.',
      finalAnswer: 'Lá gồm biểu bì trên, mô giậu, mô xốp và biểu bì dưới. Lục lạp tập trung ở mô giậu.',
      answerComplete: true, subject: 'biology', language: 'vi'
    });
    assert.strictEqual(r.telemetry.visualRealismRequired, true);
    if (r.status === 'ready') {
      assert.strictEqual(r.telemetry.visualFidelity, 'schematic_only');
      assert.ok(/sơ đồ khái niệm/.test(r.visuals[0].caption),
        'caption phải nói rõ mức trung thực, không để người học tưởng đây là hình giải phẫu thật');
      assert.strictEqual(r.visuals[0].fidelity, 'schematic_only');
    }
    assert.ok(r.telemetry.visualUpgradeHint, 'telemetry phải mang gợi ý nâng cấp cho người vận hành');
  });

  await test('R3-8. Cache: bản "schematic_only" KHÔNG được trả lại sau khi đã có image provider', () => {
    const base = {
      promptVersion: 'v8', specFingerprint: 'sp', answerStructureHash: 'a', subject: 'biology',
      language: 'vi', renderer: 'svg_diagram', model: 'deterministic', sourceFingerprint: '',
      imageFingerprint: '', userPreference: 'auto'
    };
    const before = cache.buildKey({ ...base, style: 'educational_scientific#schematic_only' });
    const after = cache.buildKey({ ...base, style: 'educational_scientific#illustrative' });
    assert.notStrictEqual(before, after, 'fidelity phải nằm trong cache key');
  });

  let p = 0, f = 0;
  console.log('\n== RỦI RO #3: mức trung thực của hình sinh học/địa lý ==');
  results.forEach((r) => {
    if (r.pass) { p++; console.log('  ok  - ' + r.name); }
    else { f++; console.log(' FAIL - ' + r.name + '\n        ' + r.error); }
  });
  console.log(`\n${p} passed, ${f} failed`);
  if (f) process.exitCode = 1;
})();
