'use strict';

// ============================================================================================
// TEST — HỆ THỐNG HÌNH MINH HỌA (PHẦN 12 → 32)
// ============================================================================================
// Bất biến quan trọng nhất được khoá ở đây:
//   (a) KHÔNG tạo hình cho câu hỏi mà hình không giúp gì (PHẦN 14).
//   (b) Hình accuracy-critical KHÔNG BAO GIỜ đi qua image generation (PHẦN 18/19).
//   (c) Ảnh lỗi KHÔNG BAO GIỜ làm hỏng/chặn câu trả lời (PHẦN 20/32).
//   (d) Hình chỉ được dựng từ FINAL VERIFIED FACTS, sau reconciliation (PHẦN 24).
//   (e) Chỉ cache hình đã VALIDATED + câu trả lời đã COMPLETED (PHẦN 22).

const assert = require('assert');
const de = require('../server/utils/visual/visualDecisionEngine');
const sb = require('../server/utils/visual/visualSpecBuilder');
const router = require('../server/utils/visual/visualRendererRouter');
const dr = require('../server/utils/visual/deterministicRenderer');
const validator = require('../server/utils/visual/visualValidator');
const cache = require('../server/utils/visual/visualCache');
const pipeline = require('../server/utils/visual/visualPipeline');

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, error: e.message }); }
}
async function atest(name, fn) {
  try { await fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, error: e.message }); }
}

// ================= PHẦN 13/14: quyết định ĐÚNG/SAI =================
test('1. visual decision TRUE: hình học phẳng', () => {
  const d = de.evaluateVisualNeed({ question: 'Cho tam giác ABC vuông tại A, đường tròn nội tiếp...', subject: 'math' });
  assert.strictEqual(d.shouldGenerateImage, true);
  assert.strictEqual(d.visualType, 'geometry_diagram');
});

test('2. visual decision TRUE: ném xiên (PHẦN 14 ví dụ "nên tạo")', () => {
  const d = de.evaluateVisualNeed({ question: 'Giải thích chuyển động ném xiên và minh họa quỹ đạo', subject: 'physics' });
  assert.strictEqual(d.shouldGenerateImage, true);
  assert.strictEqual(d.visualType, 'physics_diagram');
});

test('3. visual decision FALSE: "2 + 3 bằng bao nhiêu?" (PHẦN 14 ví dụ)', () => {
  const d = de.evaluateVisualNeed({ question: '2 + 3 bằng bao nhiêu?', subject: 'math' });
  assert.strictEqual(d.shouldGenerateImage, false);
  assert.strictEqual(d.reason, 'pure_arithmetic');
});

test('4. visual decision FALSE: định nghĩa thuần lý thuyết', () => {
  const d = de.evaluateVisualNeed({ question: 'Định nghĩa đạo hàm là gì?', subject: 'math' });
  assert.strictEqual(d.shouldGenerateImage, false);
  assert.strictEqual(d.reason, 'definition_only');
});

test('5. visual decision FALSE: môn giá trị hình thấp (Ngữ văn)', () => {
  const d = de.evaluateVisualNeed({ question: 'Phân tích khổ thơ đầu bài Tây Tiến', subject: 'literature' });
  assert.strictEqual(d.shouldGenerateImage, false);
});

test('6. PHẦN 14: hình DƯ THỪA khi câu trả lời đã có khối vẽ sẵn -> không tạo thêm', () => {
  const q = 'Cho tam giác ABC, vẽ đường cao AH';
  const withDraw = de.evaluateVisualNeed({ question: q, subject: 'math', answerPlan: '```shape\n{"ops":[]}\n```' });
  assert.strictEqual(withDraw.shouldGenerateImage, false, 'đã có hình rồi, hình thứ hai chỉ lặp lại');
});

test('7. PHẦN 27: setting "never" -> KHÔNG BAO GIỜ tạo hình', () => {
  const d = de.evaluateVisualNeed({ question: 'Vẽ đồ thị hàm số y = x^2', subject: 'math', userPreference: 'never' });
  assert.strictEqual(d.shouldGenerateImage, false);
  assert.strictEqual(d.reason, 'user_preference_never');
});

test('8. PHẦN 27: setting "always" hạ ngưỡng NHƯNG không phá veto PHẦN 14', () => {
  const auto = de.evaluateVisualNeed({ question: 'Vẽ đồ thị hàm số y = x^2', subject: 'math', userPreference: 'auto' });
  const always = de.evaluateVisualNeed({ question: 'Vẽ đồ thị hàm số y = x^2', subject: 'math', userPreference: 'always' });
  assert.ok(always.threshold < auto.threshold, '"always" phải có ngưỡng thấp hơn');
  const veto = de.evaluateVisualNeed({ question: '12 + 7', subject: 'math', userPreference: 'always' });
  assert.strictEqual(veto.shouldGenerateImage, false, 'PHẦN 14 là tuyệt đối ở MỌI chế độ');
});

test('9. PHẦN 25: borderline mới cần model judge (không đốt token cho case hiển nhiên)', () => {
  const obvious = de.evaluateVisualNeed({ question: 'Định nghĩa số nguyên tố', subject: 'math' });
  assert.strictEqual(de.needsModelJudgement(obvious), false);
});

test('10. PHẦN 23.9: nhiều ví dụ tương tự KHÔNG mặc định sinh nhiều hình', () => {
  const d = de.evaluateVisualNeed({ question: 'Cho tam giác ABC vuông tại A', subject: 'math' });
  assert.ok(d.suggestedCount <= 2, 'không bao giờ đề xuất quá 2 hình');
});

// ================= PHẦN 16/17: spec có cấu trúc + prompt tối thiểu =================
test('11. buildVisualSpec trích đúng nhãn/đại lượng/công thức từ lời giải', () => {
  const d = de.evaluateVisualNeed({ question: 'Vật ném xiên với v0 = 20 m/s, góc 30°', subject: 'physics' });
  const spec = sb.buildVisualSpec({ decision: d, question: 'Vật ném xiên với v0 = 20 m/s, góc 30°', finalAnswer: 'Ta có v0 = 20 m/s và g = 10 m/s².' });
  assert.ok(spec.objects.some((o) => o.symbol === 'v0' && o.value === 20), 'phải trích được v0 = 20');
  assert.ok(spec.type && spec.title && spec.style && spec.language, 'spec phải đủ field bắt buộc');
  assert.ok(Array.isArray(spec.visualConstraints) && spec.visualConstraints.length);
});

test('12. PHẦN 17: image prompt là DELTA MINIMUM — không chứa cả lời giải', () => {
  const longAnswer = 'Bước 1: ta phân tích lực. '.repeat(200) + ' v0 = 20 m/s';
  const d = de.evaluateVisualNeed({ question: 'Minh họa cấu trúc tế bào thực vật', subject: 'biology' });
  const spec = sb.buildVisualSpec({ decision: d, question: 'Minh họa cấu trúc tế bào thực vật', finalAnswer: longAnswer });
  const prompt = sb.buildImagePrompt(spec);
  assert.ok(prompt.length < 900, `prompt ảnh phải ngắn (thấy ${prompt.length} ký tự)`);
  assert.ok(!prompt.includes('Bước 1: ta phân tích lực. Bước 1'), 'không được nhét cả lời giải vào prompt ảnh');
});

test('13. specFingerprint ổn định và phân biệt được spec khác nhau', () => {
  const base = { type: 'a', labels: ['A'], objects: [], relationships: [], requiredEquations: [], style: 's', language: 'vi', data: {} };
  assert.strictEqual(sb.specFingerprint(base), sb.specFingerprint({ ...base }));
  assert.notStrictEqual(sb.specFingerprint(base), sb.specFingerprint({ ...base, labels: ['B'] }));
});

// ================= PHẦN 18/19: routing =================
test('14. PHẦN 18/19: loại accuracy-critical KHÔNG BAO GIỜ dùng image generation', () => {
  ['mathematical_plot', 'geometry_diagram', 'circuit_diagram', 'chart', 'flowchart'].forEach((type) => {
    const r = router.chooseVisualRenderer({ type }, { imageProviderAvailable: true });
    assert.strictEqual(r.accuracyCritical, true, type);
    assert.strictEqual(r.primary, 'deterministic', type + ' phải đi đường deterministic');
    assert.ok(!r.fallbacks.includes('image_generation'), type + ': hình sai còn tệ hơn không có hình');
  });
});

test('15. PHẦN 19: loại conceptual mới được dùng image generation (khi có provider)', () => {
  const withProvider = router.chooseVisualRenderer({ type: 'biology_diagram' }, { imageProviderAvailable: true });
  assert.strictEqual(withProvider.primary, 'image_generation');
  const without = router.chooseVisualRenderer({ type: 'biology_diagram' }, { imageProviderAvailable: false });
  assert.strictEqual(without.primary, 'deterministic', 'không có provider ảnh -> fallback deterministic, KHÔNG phải lỗi');
});

// ================= Deterministic renderer =================
test('16. đồ thị hàm số: dựng SVG hợp lệ từ biểu thức', () => {
  const out = dr.renderDeterministic({
    type: 'mathematical_plot', title: 'Đồ thị', labels: [], objects: [],
    relationships: [], requiredEquations: [], data: { plotExpr: 'x^2-2x-3' }
  });
  assert.strictEqual(out.ok, true);
  assert.ok(out.content.startsWith('<svg'));
  assert.ok(out.content.includes('</svg>'));
});

test('17. parser biểu thức AN TOÀN — không eval, không chạy được code chèn vào', () => {
  assert.strictEqual(dr.evalExpression('2*x+1', 3), 7);
  assert.strictEqual(dr.evalExpression(dr.normalizeImplicitMultiplication('x^2-2x-3'), 3), 0);
  // Chuỗi độc hại chỉ ra NaN, KHÔNG BAO GIỜ được thực thi.
  assert.ok(Number.isNaN(dr.evalExpression('process.exit(1)', 1)));
});

test('18. hình hình học: dựng được từ nhãn điểm', () => {
  const out = dr.renderDeterministic({
    type: 'geometry_diagram', title: 'ABC', labels: ['A', 'B', 'C'], objects: [],
    relationships: ['perpendicular'], requiredEquations: [], data: {}
  });
  assert.strictEqual(out.ok, true);
  assert.ok(out.content.includes('polygon'));
});

test('19. flowchart từ các bước', () => {
  const out = dr.renderDeterministic({
    type: 'flowchart', title: 'Quy trình', labels: [], objects: [], relationships: [],
    requiredEquations: [], data: { steps: ['Đun nóng hỗn hợp', 'Lọc kết tủa', 'Cô cạn dung dịch'] }
  });
  assert.strictEqual(out.ok, true);
  assert.ok(out.content.includes('Lọc kết tủa'));
});

test('20. thiếu dữ kiện -> fallback concept card, KHÔNG "vẽ đại"', () => {
  const out = dr.renderDeterministic({
    type: 'mathematical_plot', title: 'x', labels: [], objects: [{ symbol: 'a', value: 5, unit: '' }],
    relationships: [], requiredEquations: [], data: {}
  });
  assert.strictEqual(out.renderer, 'concept_card', 'không đủ dữ kiện vẽ đồ thị -> trình bày có cấu trúc, không bịa hình');
});

test('21. SVG output không bao giờ chứa script/handler (ranh giới XSS)', () => {
  const out = dr.renderDeterministic({
    type: 'flowchart', title: '<script>alert(1)</script>', labels: [], objects: [], relationships: [],
    requiredEquations: [], data: { steps: ['<img onerror=alert(1)>', 'ok'] }
  });
  assert.ok(!/<script|<img/.test(out.content), 'mọi ký tự < trong text phải được escape thành &lt;');
  assert.ok(out.content.includes('&lt;script&gt;'));
});

// ================= PHẦN 26: quality gate =================
test('22. validator BẮT số bịa (không có trong lời giải)', () => {
  const v = validator.validateVisual({
    spec: { type: 'x', labels: [], objects: [{ symbol: 'v', value: 999, unit: '' }], requiredEquations: [], language: 'vi', data: {} },
    output: { format: 'svg', content: '<svg></svg>', renderer: 'x' },
    finalAnswer: 'Vận tốc v = 20 m/s.'
  });
  assert.strictEqual(v.valid, false);
  assert.ok(v.issues.some((i) => i.startsWith('ungrounded_numbers')));
});

test('23. validator BẮT công thức không khớp lời giải', () => {
  const v = validator.validateVisual({
    spec: { type: 'x', labels: [], objects: [], requiredEquations: ['E = mc^3'], language: 'vi', data: {} },
    output: { format: 'svg', content: '<svg></svg>', renderer: 'x' },
    finalAnswer: 'Theo công thức E = mc^2 ta có...'
  });
  assert.strictEqual(v.valid, false);
  assert.ok(v.issues.includes('ungrounded_equations'));
});

test('24. validator BẮT SVG chứa script', () => {
  const v = validator.validateVisual({
    spec: { type: 'x', labels: ['A'], objects: [], requiredEquations: [], language: 'vi', data: {} },
    output: { format: 'svg', content: '<svg><script>alert(1)</script></svg>', renderer: 'x' },
    finalAnswer: 'Điểm A nằm trên đường thẳng.'
  });
  assert.strictEqual(v.valid, false);
  assert.ok(v.issues.includes('svg_unsafe_content'));
});

test('25. validator PASS khi mọi dữ kiện đều có trong lời giải', () => {
  const v = validator.validateVisual({
    spec: { type: 'x', labels: ['A'], objects: [{ symbol: 'v', value: 20, unit: 'm/s' }], requiredEquations: [], language: 'vi', data: {} },
    output: { format: 'svg', content: '<svg><g></g></svg>', renderer: 'x' },
    finalAnswer: 'Tại điểm A vận tốc v = 20 m/s.'
  });
  assert.strictEqual(v.valid, true, JSON.stringify(v.issues));
});

// ================= PHẦN 22: cache =================
test('26. cache: KHÔNG ghi khi chưa validate hoặc answer chưa COMPLETED', () => {
  cache._resetForTest();
  const parts = { promptVersion: 'v1', specFingerprint: 'abc', answerStructureHash: 'h', subject: 'math', language: 'vi', style: 's', renderer: 'r', model: 'm', userPreference: 'auto' };
  assert.strictEqual(cache.set(parts, { content: '<svg/>' }, { validated: false, answerComplete: true }), false);
  assert.strictEqual(cache.set(parts, { content: '<svg/>' }, { validated: true, answerComplete: false }), false);
  assert.strictEqual(cache.get(parts), null, 'không được cache hình chưa validate / answer partial');
});

test('27. cache hit/miss + key phủ user preference (PHẦN 27)', () => {
  cache._resetForTest();
  const parts = { promptVersion: 'v1', specFingerprint: 'abc', answerStructureHash: 'h', subject: 'math', language: 'vi', style: 's', renderer: 'r', model: 'm', userPreference: 'auto' };
  assert.strictEqual(cache.set(parts, { content: '<svg/>' }, { validated: true, answerComplete: true }), true);
  assert.ok(cache.get(parts), 'phải hit');
  assert.strictEqual(cache.get({ ...parts, userPreference: 'always' }), null, 'setting khác -> key khác');
  assert.strictEqual(cache.get({ ...parts, specFingerprint: 'zzz' }), null, 'spec khác -> key khác');
});

// ================= PHẦN 24: cross-check =================
test('28. PHẦN 24: phát hiện mâu thuẫn visual fact giữa các candidate', () => {
  const c = pipeline.detectVisualFactConflicts(
    [{ label: 'A', text: 'v = 20 m/s' }, { label: 'B', text: 'v = 35 m/s' }],
    'Kết luận: v = 20 m/s'
  );
  assert.strictEqual(c.checked, true);
  assert.ok(c.conflicts.includes('v'), 'candidate B mâu thuẫn với final answer -> phải bị phát hiện');
});

test('29. PHẦN 24: candidate đồng thuận -> không có conflict', () => {
  const c = pipeline.detectVisualFactConflicts(
    [{ label: 'A', text: 'v = 20 m/s' }, { label: 'B', text: 'v = 20 m/s' }],
    'Kết luận: v = 20 m/s'
  );
  assert.strictEqual(c.agreed, true);
});

// ================= PHẦN 20/30/32: pipeline không bao giờ giết text =================
(async function main() {
  await atest('30. pipeline: quyết định KHÔNG -> status skipped, không lỗi', async () => {
    const r = await pipeline.runVisualPipeline({ question: '2+3 bằng bao nhiêu?', finalAnswer: 'Bằng 5.', subject: 'math', answerComplete: true });
    assert.strictEqual(r.status, 'skipped');
    assert.deepStrictEqual(r.visuals, []);
  });

  await atest('31. pipeline: tạo được hình cho bài đồ thị + phát đủ sự kiện', async () => {
    cache._resetForTest();
    const events = [];
    const r = await pipeline.runVisualPipeline({
      question: 'Vẽ đồ thị hàm số y = x^2 - 2x - 3',
      finalAnswer: 'Ta có y = x^2-2x-3, đỉnh I(1;-4), giao Ox tại x = -1 và x = 3.',
      subject: 'math', answerComplete: true, onEvent: (e) => events.push(e.type)
    });
    assert.strictEqual(r.status, 'ready');
    assert.strictEqual(r.visuals.length, 1);
    assert.strictEqual(r.visuals[0].format, 'svg');
    assert.deepStrictEqual(events, ['visual:pending', 'visual:ready'], 'PHẦN 21: sự kiện riêng, đúng thứ tự');
  });

  await atest('32. PHẦN 22: cache hit ở lần chạy thứ 2 (không sinh lại hình giống nhau)', async () => {
    cache._resetForTest();
    const args = {
      question: 'Vẽ đồ thị hàm số y = x^2 - 2x - 3',
      finalAnswer: 'Ta có y = x^2-2x-3, đỉnh I(1;-4), giao Ox tại x = -1 và x = 3.',
      subject: 'math', answerComplete: true
    };
    const first = await pipeline.runVisualPipeline(args);
    const second = await pipeline.runVisualPipeline(args);
    assert.strictEqual(first.telemetry.visualCacheHit, false);
    assert.strictEqual(second.telemetry.visualCacheHit, true, 'PHẦN 23.5: không regenerate ảnh giống hệt nhau');
  });

  await atest('33. PHẦN 30: deadline gần hết -> BỎ hình, KHÔNG làm hỏng request', async () => {
    const r = await pipeline.runVisualPipeline({
      question: 'Vẽ đồ thị hàm số y = x^2',
      finalAnswer: 'y = x^2', subject: 'math', answerComplete: true,
      deadline: { remaining: () => 500 }
    });
    assert.strictEqual(r.status, 'skipped');
    assert.strictEqual(r.telemetry.visualError, 'deferred_deadline');
  });

  await atest('34. PHẦN 20/32: pipeline KHÔNG BAO GIỜ throw, kể cả input rác', async () => {
    const r = await pipeline.runVisualPipeline({ question: null, finalAnswer: null, subject: null, onEvent: null });
    assert.ok(['skipped', 'failed'].includes(r.status));
    assert.deepStrictEqual(r.visuals, []);
  });

  await atest('35. PHẦN 31: telemetry đầy đủ các field observability', async () => {
    const r = await pipeline.runVisualPipeline({
      question: 'Cho tam giác ABC vuông tại A', finalAnswer: 'Tam giác ABC vuông tại A nên BC là cạnh huyền.',
      subject: 'math', answerComplete: true
    });
    ['visualDecision', 'visualConfidence', 'visualType', 'visualRenderer', 'visualGenerated',
      'visualCacheHit', 'visualGenerationLatency', 'visualValidation', 'visualRepairCount', 'visualError']
      .forEach((k) => assert.ok(k in r.telemetry, 'thiếu telemetry field: ' + k));
  });

  await atest('36. PHẦN 27: userPreference=never đi xuyên suốt pipeline', async () => {
    const r = await pipeline.runVisualPipeline({
      question: 'Vẽ đồ thị hàm số y = x^2', finalAnswer: 'y = x^2',
      subject: 'math', answerComplete: true, userPreference: 'never'
    });
    assert.strictEqual(r.status, 'skipped');
    assert.strictEqual(r.decision.reason, 'user_preference_never');
  });

  await atest('37. PHẦN 24: hình chỉ dùng số của FINAL ANSWER, loại số của candidate bị bác bỏ', async () => {
    const r = await pipeline.runVisualPipeline({
      question: 'Vật ném xiên với v0 = 20 m/s ở góc 30°, tính tầm xa và minh họa quỹ đạo',
      finalAnswer: 'Ta có v0 = 20 m/s, góc 30°, g = 10 m/s². Tầm xa L = 34.6 m.',
      subject: 'physics', answerComplete: true,
      candidates: [{ label: 'A', text: 'v0 = 20 m/s' }, { label: 'B', text: 'v0 = 45 m/s' }]
    });
    if (r.status === 'ready') {
      assert.ok(!/45/.test(r.visuals[0].content || ''), 'số của candidate bị bác bỏ KHÔNG được xuất hiện trong hình');
    }
    assert.ok(r.telemetry.visualConflicts.includes('v0'), 'phải ghi nhận mâu thuẫn đã phát hiện');
  });

  let passed = 0, failed = 0;
  console.log('\n== Hệ thống hình minh họa (PHẦN 12 → 32) ==');
  results.forEach((r) => {
    if (r.pass) { passed++; console.log('  ok  - ' + r.name); }
    else { failed++; console.log(' FAIL - ' + r.name + '\n        ' + r.error); }
  });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
