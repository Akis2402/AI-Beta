'use strict';

// ============================================================================================
// TEST — HỆ THỐNG HÌNH MINH HỌA (PHẦN 12 → 32)
// ============================================================================================
// Bất biến quan trọng nhất được khoá ở đây:
//   (a) KHÔNG tạo hình cho câu hỏi mà hình không giúp gì.
//   (b) MỌI hình 2D tĩnh đều là ẢNH AI — không còn renderer SVG/deterministic nào trong pipeline.
//   (c) Ảnh lỗi KHÔNG BAO GIỜ làm hỏng/chặn câu trả lời (text giữ nguyên + stub retry).
//   (d) Hình chỉ được dựng từ FINAL VERIFIED FACTS, sau reconciliation.
//   (e) Chỉ cache hình đã VALIDATED + câu trả lời đã COMPLETED, và chỉ cache ẢNH AI THẬT.

const assert = require('assert');
const de = require('../server/utils/visual/visualDecisionEngine');
const sb = require('../server/utils/visual/visualSpecBuilder');
const router = require('../server/utils/visual/visualRendererRouter');
const validator = require('../server/utils/visual/visualValidator');
const cache = require('../server/utils/visual/visualCache');
const pipeline = require('../server/utils/visual/visualPipeline');
const {
  PNG_DATA_URL, loadVisualModules, withFetch, geminiImageResponse, geminiTextResponse,
  httpErrorResponse, validImageOutput
} = require('./_imageMock');

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

// ĐỔI CÓ CHỦ ĐÍCH (A3): setting "never" vẫn chặn mặc định, NHƯNG một YÊU CẦU TƯỜNG MINH của người
// dùng ở chính lượt này phải được ưu tiên cao hơn setting (nguyên tắc USER_REQUESTED). Bản cũ tính
// nhánh `never` TRƯỚC khi tính explicitRequest nên người dùng gõ thẳng "vẽ hình minh họa cho câu
// này" vẫn không được vẽ và cũng không được báo gì. Test dưới đây khẳng định CẢ HAI chiều.
test('7. PHẦN 27 + A3: setting "never" chặn mặc định, nhưng yêu cầu tường minh thì override', () => {
  const blocked = de.evaluateVisualNeed({ question: 'Tính thể tích khối chóp S.ABCD cạnh a', subject: 'math', userPreference: 'never' });
  assert.strictEqual(blocked.shouldGenerateImage, false);
  assert.strictEqual(blocked.reason, 'user_preference_never');

  const overridden = de.evaluateVisualNeed({ question: 'Vẽ đồ thị hàm số y = x^2', subject: 'math', userPreference: 'never' });
  assert.strictEqual(overridden.shouldGenerateImage, true, 'yêu cầu tường minh phải override setting never');
  assert.strictEqual(overridden.reason, 'explicit_override_never', 'telemetry phải phân biệt được lượt override');
  assert.strictEqual(overridden.imageNecessity, 'USER_REQUESTED');
  assert.strictEqual(overridden.overrodeNever, true);
});

test('7b. A3.2: HARD_VETO vẫn thắng TUYỆT ĐỐI, kể cả có yêu cầu tường minh', () => {
  const d = de.evaluateVisualNeed({ question: '2+2 bằng mấy, vẽ hình minh họa giúp tôi', subject: 'math', userPreference: 'never' });
  assert.strictEqual(d.shouldGenerateImage, false, 'veto không bao giờ bị explicit request phá');
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

// ================= ROUTING: chỉ còn generated_image | interactive_3d | no_visual =================
test('14. loại đòi độ chính xác cao VẪN đi ảnh AI, chỉ được đánh cờ highPrecisionRequired', () => {
  ['mathematical_plot', 'geometry_diagram', 'circuit_diagram', 'chart', 'flowchart'].forEach((type) => {
    const r = router.chooseVisualRenderer({ type }, { imageProviderAvailable: true });
    assert.strictEqual(r.renderer, 'generated_image', type + ' phải đi ảnh AI');
    assert.strictEqual(r.primary, 'image_generation', type);
    assert.strictEqual(r.highPrecisionRequired, true, type + ' phải được đánh cờ độ chính xác cao');
    assert.deepStrictEqual(r.fallbacks, [], type + ': KHÔNG còn renderer thay thế nào');
  });
});

test('15. loại conceptual cũng đi ảnh AI; không có provider -> blocked, KHÔNG dựng SVG', () => {
  const withProvider = router.chooseVisualRenderer({ type: 'biology_diagram' }, { imageProviderAvailable: true });
  assert.strictEqual(withProvider.renderer, 'generated_image');
  assert.strictEqual(withProvider.primary, 'image_generation');
  assert.strictEqual(withProvider.blocked, null);

  const without = router.chooseVisualRenderer({ type: 'biology_diagram' }, { imageProviderAvailable: false });
  assert.strictEqual(without.renderer, 'generated_image', 'renderer không đổi theo cấu hình');
  assert.strictEqual(without.blocked, 'no_image_provider', 'không có provider = không có hình');
  assert.ok(without.upgradeHint, 'phải nói rõ cần cấu hình gì');
});

test('16. router KHÔNG BAO GIỜ trả renderer SVG/deterministic/concept_card', () => {
  const types = ['mathematical_plot', 'geometry_diagram', 'physics_diagram', 'optics_diagram',
    'circuit_diagram', 'chart', 'flowchart', 'biology_diagram', 'chemistry_structure',
    'map_diagram', 'concept_illustration', 'network_diagram', 'apparatus_diagram'];
  types.forEach((type) => {
    [true, false].forEach((imageProviderAvailable) => {
      const r = router.chooseVisualRenderer({ type }, { imageProviderAvailable });
      assert.ok(['generated_image', 'interactive_3d', 'no_visual'].includes(r.renderer), type + ': ' + r.renderer);
      assert.notStrictEqual(r.primary, 'deterministic', type);
      assert.ok(!r.fallbacks.includes('deterministic'), type);
      assert.ok(!r.fallbacks.includes('concept_card'), type);
    });
  });
});

test('17. 3D có schema interactive -> interactive_3d (Three.js), KHÔNG đổi thành ảnh', () => {
  const r = router.chooseVisualRenderer(
    { type: 'geometry_3d', data: { scene3d: { objects: [{ kind: 'sphere' }] } } },
    { imageProviderAvailable: true }
  );
  assert.strictEqual(r.renderer, 'interactive_3d');
  assert.strictEqual(r.primary, 'interactive_3d');
});

test('18. 3D KHÔNG có schema interactive -> ảnh minh hoạ tĩnh bình thường', () => {
  const r = router.chooseVisualRenderer({ type: 'geometry_3d', data: {} }, { imageProviderAvailable: true });
  assert.strictEqual(r.renderer, 'generated_image');
});

test('19. no_visual -> no_visual', () => {
  const r = router.chooseVisualRenderer({ type: 'no_visual' }, { imageProviderAvailable: true });
  assert.strictEqual(r.renderer, 'no_visual');
  assert.strictEqual(r.primary, 'no_visual');
});

// ================= QUALITY GATE: ảnh phải là ẢNH THẬT =================
test('20. validator TỪ CHỐI chuỗi SVG giả dạng hình minh hoạ', () => {
  const v = validator.validateVisual({
    spec: { type: 'x', labels: ['A'], objects: [], requiredEquations: [], language: 'vi', data: {} },
    output: { format: 'svg', content: '<svg><g></g></svg>', renderer: 'generated_image', origin: 'ai_generated' },
    finalAnswer: 'Điểm A nằm trên đường thẳng.'
  });
  assert.strictEqual(v.valid, false);
  assert.ok(v.issues.includes('svg_format_rejected'));
});

test('21. validator TỪ CHỐI text/HTML gắn nhãn image/png (không có magic bytes)', () => {
  const fakePng = 'data:image/png;base64,' + Buffer.from('<html>lỗi rồi</html>').toString('base64');
  const v = validator.validateVisual({
    spec: { type: 'x', labels: ['A'], objects: [], requiredEquations: [], language: 'vi', data: {} },
    output: { format: 'data_url', url: fakePng, renderer: 'generated_image', origin: 'ai_generated', model: 'm' },
    finalAnswer: 'Điểm A nằm trên đường thẳng.'
  });
  assert.strictEqual(v.valid, false);
  assert.ok(v.issues.some((i) => i.startsWith('invalid_image_binary')), JSON.stringify(v.issues));
});

test('22. validator BẮT số bịa (không có trong lời giải)', () => {
  const v = validator.validateVisual({
    spec: { type: 'x', labels: [], objects: [{ symbol: 'v', value: 999, unit: '' }], requiredEquations: [], language: 'vi', data: {} },
    output: validImageOutput(),
    finalAnswer: 'Vận tốc v = 20 m/s.'
  });
  assert.strictEqual(v.valid, false);
  assert.ok(v.issues.some((i) => i.startsWith('ungrounded_numbers')));
});

test('23. validator BẮT công thức không khớp lời giải', () => {
  const v = validator.validateVisual({
    spec: { type: 'x', labels: [], objects: [], requiredEquations: ['E = mc^3'], language: 'vi', data: {} },
    output: validImageOutput(),
    finalAnswer: 'Theo công thức E = mc^2 ta có...'
  });
  assert.strictEqual(v.valid, false);
  assert.ok(v.issues.includes('ungrounded_equations'));
});

test('24. validator BẮT nhãn "ảnh AI" gắn sai (origin không phải ai_generated)', () => {
  const v = validator.validateVisual({
    spec: { type: 'x', labels: ['A'], objects: [], requiredEquations: [], language: 'vi', data: {} },
    output: { format: 'data_url', url: PNG_DATA_URL, renderer: 'generated_image', origin: 'somewhere_else', model: 'm' },
    finalAnswer: 'Điểm A nằm trên đường thẳng.'
  });
  assert.strictEqual(v.valid, false);
  assert.ok(v.issues.includes('renderer_origin_mismatch'));
});

test('25. validator PASS khi ảnh thật + mọi dữ kiện đều có trong lời giải', () => {
  const v = validator.validateVisual({
    spec: { type: 'x', labels: ['A'], objects: [{ symbol: 'v', value: 20, unit: 'm/s' }], requiredEquations: [], language: 'vi', data: {} },
    output: validImageOutput(),
    finalAnswer: 'Tại điểm A vận tốc v = 20 m/s.'
  });
  assert.strictEqual(v.valid, true, JSON.stringify(v.issues));
});

// ================= CACHE =================
test('26. cache: KHÔNG ghi khi chưa validate hoặc answer chưa COMPLETED', () => {
  cache._resetForTest();
  const parts = { promptVersion: 'v1', specFingerprint: 'abc', answerStructureHash: 'h', subject: 'math', language: 'vi', style: 's', renderer: 'generated_image', model: 'm', userPreference: 'auto' };
  const value = { url: PNG_DATA_URL, format: 'data_url', renderer: 'generated_image', origin: 'ai_generated' };
  assert.strictEqual(cache.set(parts, value, { validated: false, answerComplete: true }), false);
  assert.strictEqual(cache.set(parts, value, { validated: true, answerComplete: false }), false);
  assert.strictEqual(cache.get(parts), null, 'không được cache hình chưa validate / answer partial');
});

test('27. cache TỪ CHỐI payload SVG/deterministic, chỉ nhận ảnh AI thật', () => {
  cache._resetForTest();
  const parts = { promptVersion: 'v1', specFingerprint: 'abc', answerStructureHash: 'h', subject: 'math', language: 'vi', style: 's', renderer: 'generated_image', model: 'm', userPreference: 'auto' };
  const opts = { validated: true, answerComplete: true };
  assert.strictEqual(cache.set(parts, { content: '<svg/>', format: 'svg', renderer: 'deterministic' }, opts), false);
  assert.strictEqual(cache.set(parts, { url: PNG_DATA_URL, format: 'data_url', renderer: 'generated_image', origin: 'deterministic' }, opts), false);
  assert.strictEqual(cache.set(parts, { url: PNG_DATA_URL, format: 'data_url', renderer: 'generated_image', origin: 'ai_generated' }, opts), true);
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

  // HYBRID (Master prompt Puter Auth): đồ thị/hình học/sơ đồ Lý-Hoá dựng được chính xác đi SVG tất định.
  // Các test 31–37 kiểm NHÁNH ẢNH AI nên ép nhánh đó bằng yêu cầu tường minh "bằng AI" (người dùng có
  // quyền chọn) — nhánh SVG có test riêng (31c, 32b, 33b, và test/hybrid-visual-engine.test.js).
  await atest('31. pipeline: tạo được ẢNH AI (người dùng yêu cầu bằng AI) + phát đủ sự kiện', async () => {
    const { pipeline: pl, restore } = loadVisualModules({ GEMINI_IMAGE_API_KEY: 'k' });
    try {
      const events = [];
      const r = await withFetch(async () => geminiImageResponse(), () => pl.runVisualPipeline({
        question: 'Vẽ đồ thị hàm số y = x^2 - 2x - 3 bằng AI',
        finalAnswer: 'Ta có y = x^2-2x-3, đỉnh I(1;-4), giao Ox tại x = -1 và x = 3.',
        subject: 'math', answerComplete: true, onEvent: (e) => events.push(e.type)
      }));
      assert.strictEqual(r.status, 'ready', JSON.stringify(r.telemetry));
      assert.strictEqual(r.visuals.length, 1);
      assert.strictEqual(r.visuals[0].renderer, 'generated_image');
      assert.strictEqual(r.visuals[0].origin, 'ai_generated');
      assert.strictEqual(r.visuals[0].format, 'data_url');
      assert.notStrictEqual(r.visuals[0].format, 'svg');
      assert.deepStrictEqual(events, ['visual:pending', 'visual:ready'], 'sự kiện riêng, đúng thứ tự');
    } finally { restore(); }
  });

  await atest('31b. AI được yêu cầu nhưng KHÔNG có provider ảnh -> failed + stub retry, không dựng SVG thay thế', async () => {
    const { pipeline: pl, restore } = loadVisualModules({});
    try {
      let apiCalls = 0;
      const r = await withFetch(async () => { apiCalls++; return geminiImageResponse(); }, () => pl.runVisualPipeline({
        question: 'Vẽ đồ thị hàm số y = x^2 - 2x - 3 bằng AI',
        finalAnswer: 'Ta có y = x^2-2x-3, đỉnh I(1;-4).', subject: 'math', answerComplete: true
      }));
      assert.strictEqual(apiCalls, 0, 'không có khóa thì không gọi API');
      assert.strictEqual(r.status, 'failed');
      assert.strictEqual(r.visuals.length, 1, 'phải có stub để UI hiện nút Thử tạo lại');
      assert.strictEqual(r.visuals[0].renderFailed, true);
      assert.strictEqual(r.visuals[0].reason, 'no_image_provider');
      assert.strictEqual(r.visuals[0].format, undefined, 'stub KHÔNG mang nội dung hình nào');
    } finally { restore(); }
  });

  await atest('32. cache hit ở lần chạy thứ 2 (không sinh lại ảnh giống hệt nhau)', async () => {
    const { pipeline: pl, restore } = loadVisualModules({ GEMINI_IMAGE_API_KEY: 'k' });
    try {
      const args = {
        question: 'Vẽ đồ thị hàm số y = x^2 - 2x - 3 bằng AI',
        finalAnswer: 'Ta có y = x^2-2x-3, đỉnh I(1;-4), giao Ox tại x = -1 và x = 3.',
        subject: 'math', answerComplete: true
      };
      let apiCalls = 0;
      const stub = async () => { apiCalls++; return geminiImageResponse(); };
      const first = await withFetch(stub, () => pl.runVisualPipeline(args));
      const second = await withFetch(stub, () => pl.runVisualPipeline(args));
      assert.strictEqual(first.telemetry.visualCacheHit, false);
      assert.strictEqual(second.telemetry.visualCacheHit, true, 'không regenerate ảnh giống hệt nhau');
      assert.strictEqual(apiCalls, 1, 'lần 2 KHÔNG được gọi lại image API');
    } finally { restore(); }
  });

  await atest('33. PHẦN 30: deadline gần hết -> BỎ hình AI, KHÔNG làm hỏng request', async () => {
    const r = await pipeline.runVisualPipeline({
      question: 'Vẽ đồ thị hàm số y = x^2 bằng AI',
      finalAnswer: 'y = x^2', subject: 'math', answerComplete: true,
      deadline: { remaining: () => 500 }
    });
    assert.strictEqual(r.status, 'skipped');
    assert.strictEqual(r.telemetry.visualError, 'deferred_deadline');
  });

  // ---------- HYBRID: nhánh SVG tất định (không phụ thuộc provider ảnh / Puter) ----------
  await atest('31c. SVG tất định: KHÔNG có provider ảnh vẫn dựng được hình, 0 lệnh gọi image API', async () => {
    const { pipeline: pl, restore } = loadVisualModules({});
    try {
      let apiCalls = 0;
      const events = [];
      const r = await withFetch(async () => { apiCalls++; return geminiImageResponse(); }, () => pl.runVisualPipeline({
        question: 'Vẽ đồ thị hàm số y = x^2 - 2x - 3',
        finalAnswer: 'Ta có y = x^2-2x-3, đỉnh I(1;-4).', subject: 'math', answerComplete: true, onEvent: (e) => events.push(e.type)
      }));
      assert.strictEqual(apiCalls, 0, 'SVG tất định không được gọi image API');
      assert.strictEqual(r.status, 'ready', JSON.stringify(r.telemetry));
      assert.strictEqual(r.visuals[0].format, 'svg');
      assert.strictEqual(r.visuals[0].renderer, 'deterministic_svg');
      assert.strictEqual(r.visuals[0].origin, 'deterministic');
      assert.strictEqual(r.telemetry.visualProviderAttempts, 0);
      assert.strictEqual(r.telemetry.visualJudgeCalls, 0);
      assert.deepStrictEqual(events, ['visual:ready']);
    } finally { restore(); }
  });

  await atest('32b. SVG tất định: cùng dữ kiện -> cùng specHash, lần 2 là cache hit', async () => {
    const { pipeline: pl, restore } = loadVisualModules({});
    try {
      const args = { question: 'Vẽ tam giác ABC vuông tại A, AB = 3 cm, AC = 4 cm', finalAnswer: 'BC = 5 cm', subject: 'math', answerComplete: true };
      const a = await pl.runVisualPipeline(args);
      const b = await pl.runVisualPipeline(args);
      assert.strictEqual(a.status, 'ready');
      assert.strictEqual(a.visuals[0].specHash, b.visuals[0].specHash);
      assert.strictEqual(b.telemetry.visualSvgCacheHit, true);
    } finally { restore(); }
  });

  await atest('33b. deadline gần hết: SVG tất định (0 chi phí mạng) VẪN được giao, chỉ ảnh AI mới bị hoãn', async () => {
    const r = await pipeline.runVisualPipeline({
      question: 'Vẽ đồ thị hàm số y = x^2', finalAnswer: 'y = x^2', subject: 'math', answerComplete: true,
      deadline: { remaining: () => 500 }
    });
    assert.strictEqual(r.status, 'ready');
    assert.strictEqual(r.visuals[0].format, 'svg');
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

  await atest('36. PHẦN 27 + A3: userPreference=never đi xuyên suốt pipeline (và override khi có yêu cầu tường minh)', async () => {
    const r = await pipeline.runVisualPipeline({
      question: 'Tính thể tích khối chóp S.ABCD cạnh a', finalAnswer: 'V = a^3/3',
      subject: 'math', answerComplete: true, userPreference: 'never'
    });
    assert.strictEqual(r.status, 'skipped');
    assert.strictEqual(r.decision.reason, 'user_preference_never');

    const overridden = await pipeline.runVisualPipeline({
      question: 'Vẽ đồ thị hàm số y = x^2', finalAnswer: 'y = x^2 là parabol, đỉnh O(0,0)',
      subject: 'math', answerComplete: true, userPreference: 'never'
    });
    assert.notStrictEqual(overridden.status, 'skipped', 'yêu cầu tường minh phải đi tiếp vào pipeline dù setting đang tắt hình');
    assert.strictEqual(overridden.decision.reason, 'explicit_override_never');
  });

  await atest('37. PHẦN 24: hình chỉ dùng số của FINAL ANSWER, loại số của candidate bị bác bỏ', async () => {
    const r = await pipeline.runVisualPipeline({
      question: 'Vật ném xiên với v0 = 20 m/s ở góc 30°, tính tầm xa và minh họa quỹ đạo bằng AI',
      finalAnswer: 'Ta có v0 = 20 m/s, góc 30°, g = 10 m/s². Tầm xa L = 34.6 m.',
      subject: 'physics', answerComplete: true,
      candidates: [{ label: 'A', text: 'v0 = 20 m/s' }, { label: 'B', text: 'v0 = 45 m/s' }]
    });
    if (r.status === 'ready') {
      const overlayNumbers = JSON.stringify((r.visuals[0].overlay || {}).numbers || []);
      assert.ok(!/45/.test(overlayNumbers), 'số của candidate bị bác bỏ KHÔNG được xuất hiện trong chú thích');
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
