'use strict';

// ---------- B9.1 / A3 (test N, O, Y, P): PHÂN LOẠI NHU CẦU HÌNH 5 MỨC + ĐỘ ƯU TIÊN ----------
// NONE | OPTIONAL | HELPFUL | NECESSARY | USER_REQUESTED — map từ score/threshold/explicitRequest
// đã tính sẵn (0 token, không gọi model).

const assert = require('assert');
const de = require('../server/utils/visual/visualDecisionEngine');
const pipeline = require('../server/utils/visual/visualPipeline');

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, error: e.message }); }
}

const decide = (question, over = {}) => de.evaluateVisualNeed({ question, subject: 'math', ...over });

(async () => {
  await test('N. Bài đại số thuần -> NONE, không tạo hình', () => {
    const d = decide('Giải phương trình x^2 - 5x + 6 = 0');
    assert.strictEqual(d.shouldGenerateImage, false);
    assert.strictEqual(d.imageNecessity, 'NONE');
  });

  await test('Y/O. Yêu cầu tường minh -> USER_REQUESTED, override cả setting "never"', () => {
    ['auto', 'always', 'never'].forEach((pref) => {
      const d = decide('Vẽ hình minh họa cho bài toán tam giác ABC vuông tại A này', { userPreference: pref });
      assert.strictEqual(d.imageNecessity, 'USER_REQUESTED', `[${pref}] phải là USER_REQUESTED`);
      assert.strictEqual(d.shouldGenerateImage, true, `[${pref}] phải tạo hình`);
      assert.strictEqual(d.generationPriority, 'high', 'yêu cầu tường minh luôn ở ưu tiên cao nhất');
    });
  });

  await test('Y. USER_REQUESTED chấm điểm theo ngưỡng MẶC ĐỊNH (auto), không theo ngưỡng "never" vô cực', () => {
    const d = decide('Vẽ sơ đồ minh hoạ quá trình này cho tôi', { userPreference: 'never' });
    assert.ok(Number.isFinite(d.threshold), 'ngưỡng phải hữu hạn thì scoring mới có nghĩa');
    assert.strictEqual(d.threshold, de.THRESHOLD.auto);
  });

  await test('P. Bài có visual benefit mạnh (hình không gian) -> HELPFUL hoặc NECESSARY', () => {
    const d = decide('Cho hình chóp S.ABCD có đáy là hình vuông cạnh a, SA vuông góc với mặt phẳng đáy, tính khoảng cách từ A đến mặt phẳng (SBD)');
    assert.strictEqual(d.shouldGenerateImage, true);
    assert.ok(['HELPFUL', 'NECESSARY'].includes(d.imageNecessity), 'thực tế: ' + d.imageNecessity);
  });

  await test('A3.2. HARD_VETO vẫn thắng tuyệt đối -> NONE dù có chữ "vẽ hình"', () => {
    const d = decide('2+2 bằng mấy, vẽ hình minh hoạ luôn nhé');
    assert.strictEqual(d.shouldGenerateImage, false, 'veto không bao giờ bị explicit request phá');
    assert.notStrictEqual(d.imageNecessity, 'USER_REQUESTED',
      'không được gán ưu tiên cao nhất cho một hình sẽ KHÔNG được tạo');
  });

  await test('A3. Đề bài chứa chữ "vẽ" nhưng câu trả lời ĐÃ CÓ hình -> không vẽ thêm hình dư thừa', () => {
    const d = de.evaluateVisualNeed({
      question: 'Cho tam giác ABC, vẽ đường cao AH', subject: 'math',
      answerPlan: '```shape\n{"type":"polygon","points":[[0,0],[4,0],[2,3]]}\n```'
    });
    assert.strictEqual(d.shouldGenerateImage, false, 'explicit request KHÔNG được phá cơ chế chống hình dư thừa');
  });

  await test('B9.3. Mức degrade theo thời gian còn lại: high/medium/low/emergency', () => {
    assert.strictEqual(pipeline.resolveVisualDegradeLevel(Infinity), 'high');
    assert.strictEqual(pipeline.resolveVisualDegradeLevel(30000), 'high');
    assert.strictEqual(pipeline.resolveVisualDegradeLevel(6000), 'medium');
    assert.strictEqual(pipeline.resolveVisualDegradeLevel(4000), 'low');
    assert.strictEqual(pipeline.resolveVisualDegradeLevel(1000), 'emergency');
  });

  await test('R. Deadline hết -> BỎ hình, giữ text, KHÔNG làm fail cả response', async () => {
    const r = await pipeline.runVisualPipeline({
      question: 'Vẽ đồ thị hàm số y = x^2', finalAnswer: 'y = x^2', answerComplete: true,
      subject: 'math', deadline: { remaining: () => 500 }
    });
    assert.strictEqual(r.status, 'skipped');
    assert.strictEqual(r.telemetry.visualError, 'deferred_deadline');
    assert.strictEqual(r.telemetry.visualDegradeLevel, 'emergency');
  });

  await test('B10. Telemetry hình có đủ field mới: degrade level, necessity, providersTried, costClass', async () => {
    const r = await pipeline.runVisualPipeline({
      question: 'Vẽ đồ thị hàm số y = x^2 - 4', finalAnswer: 'Parabol đỉnh (0,-4), cắt Ox tại x = -2 và x = 2',
      answerComplete: true, subject: 'math'
    });
    ['visualDegradeLevel', 'visualNecessity', 'visualProvidersTried', 'visualCostClass']
      .forEach((f) => assert.ok(f in r.telemetry, 'thiếu field telemetry: ' + f));
    assert.strictEqual(r.telemetry.visualNecessity, 'USER_REQUESTED');
  });

  let p = 0, f = 0;
  console.log('\n== B9.1/A3: imageNecessity + degrade + telemetry ==');
  results.forEach((r) => {
    if (r.pass) { p++; console.log('  ok  - ' + r.name); }
    else { f++; console.log(' FAIL - ' + r.name + '\n        ' + r.error); }
  });
  console.log(`\n${p} passed, ${f} failed`);
  if (f) process.exitCode = 1;
})();
