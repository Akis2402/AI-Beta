'use strict';

// ---------- REGRESSION: DRAW_SCHEMA / hướng dẫn vẽ hình KHÔNG còn gửi vô điều kiện (mục PHẦN 5) ----------
// TRƯỚC ĐÂY buildDrawInstructions() (kèm toàn bộ DRAW_SCHEMA cho shape/solid3d/plot, rất dài) được
// nối vào MỌI system prompt bất kể đề bài có liên quan gì tới hình vẽ hay không. Test dưới đây
// khẳng định: (1) bài đại số thường không chứa DRAW_SCHEMA -> prompt nhỏ hơn đáng kể; (2) bài hình
// học 2D/3D vẫn có đầy đủ DRAW_SCHEMA; (3) có ảnh luôn giữ DRAW_SCHEMA (an toàn, không đoán mò nội
// dung ảnh); (4) approach cũ đã có sẵn shape/solid3d thì detail vẫn giữ hướng dẫn vẽ (đồng nhất).

const assert = require('assert');
const { buildChatSystemPrompt } = require('../server/utils/promptBuilder');

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, error: e.message }); }
}

const settings = { lang: 'Tiếng Việt', detail: 'normal', school: 'THPT', grade: '10' };

function build(opts) {
  return buildChatSystemPrompt({
    deepThinking: false, image: null, rules: [], contexts: [], settings,
    stage: 'detail', approachText: '', problemText: '',
    ...opts
  });
}

// 1. Bài đại số thường -> KHÔNG chứa schema vẽ hình.
test('1. Non-geometry (algebra) prompt does not contain DRAW_SCHEMA / shape-drawing rules', () => {
  const prompt = build({ problemText: 'Giải phương trình bậc hai: 2x^2 - 3x + 1 = 0, tìm x.' });
  assert.ok(!prompt.includes('QUY TẮC MINH HỌA HÌNH VẼ'), 'không được chứa khối hướng dẫn vẽ hình đầy đủ');
  assert.ok(!/"type":"pyramid"|"type":"cuboid"/i.test(prompt), 'không được chứa mẫu JSON solid3d');
  assert.ok(prompt.includes('không liên quan tới hình vẽ'), 'phải có ghi chú gọn thay thế');
});

// 2. Bài hình học 2D -> CÓ đầy đủ DRAW_SCHEMA.
test('2. Geometry 2D prompt includes full drawing schema', () => {
  const prompt = build({ problemText: 'Cho tam giác ABC vuông tại A, đường cao AH. Tính diện tích tam giác.' });
  assert.ok(prompt.includes('QUY TẮC MINH HỌA HÌNH VẼ'), 'phải có khối hướng dẫn vẽ hình');
});

// 3. Bài 3D -> CÓ đầy đủ schema (bao gồm solid3d).
test('3. Geometry 3D (solid) prompt includes drawing schema', () => {
  const prompt = build({ problemText: 'Cho hình chóp S.ABCD có đáy là hình vuông cạnh a, tính thể tích khối chóp.' });
  assert.ok(prompt.includes('QUY TẮC MINH HỌA HÌNH VẼ'), 'phải có khối hướng dẫn vẽ hình cho bài 3D');
});

// 4. Có ảnh -> LUÔN giữ DRAW_SCHEMA (an toàn, không đoán mò nội dung ảnh từ text rỗng).
test('4. Image-attached prompt always keeps drawing schema even with empty problemText', () => {
  const prompt = build({ problemText: '', image: { mediaType: 'image/png' } });
  assert.ok(prompt.includes('QUY TẮC MINH HỌA HÌNH VẼ'), 'ảnh phải luôn giữ hướng dẫn vẽ hình (ưu tiên correctness)');
});

// 5. approachText cũ đã có shape -> detail giữ hướng dẫn vẽ dù problemText hiện tại không có tín hiệu rõ.
test('5. approachText with existing shape block forces drawing instructions to stay', () => {
  const prompt = build({
    problemText: 'Tiếp tục giải chi tiết như đã nêu.',
    approachText: 'Hướng giải:\n```shape\n{"points":[]}\n```'
  });
  assert.ok(prompt.includes('QUY TẮC MINH HỌA HÌNH VẼ'), 'phải giữ hướng dẫn vẽ hình khi approach cũ đã có shape');
});

// 6. Đo kích thước: prompt non-geometry phải nhỏ hơn đáng kể so với prompt geometry.
test('6. Non-geometry prompt is meaningfully smaller than geometry prompt (prompt compression PHẦN 5)', () => {
  const algebra = build({ problemText: 'Tính đạo hàm của hàm số f(x) = x^3 - 3x + 2.' });
  const geometry = build({ problemText: 'Cho hình chóp S.ABCD đáy hình vuông, tính thể tích.' });
  assert.ok(algebra.length < geometry.length * 0.8, `algebra=${algebra.length} chars phải nhỏ hơn đáng kể geometry=${geometry.length} chars`);
});

// 7. Approach stage cũng áp dụng cùng logic gating (không chỉ detail).
test('7. Approach stage also gates drawing schema for non-geometry problems', () => {
  const prompt = buildChatSystemPrompt({
    deepThinking: false, image: null, rules: [], contexts: [], settings,
    stage: 'approach', approachText: '', problemText: 'Rút gọn biểu thức: (x+1)^2 - x^2.'
  });
  assert.ok(!prompt.includes('QUY TẮC MINH HỌA HÌNH VẼ'), 'approach stage cũng không được gửi schema vẽ hình cho bài không liên quan');
});

let passed = 0, failed = 0;
console.log('\n== Regression: DRAW_SCHEMA không còn gửi vô điều kiện (mục PHẦN 5) ==');
for (const r of results) {
  if (r.pass) { passed++; console.log('  ok  - ' + r.name); }
  else { failed++; console.log('  FAIL - ' + r.name + ' :: ' + r.error); }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
