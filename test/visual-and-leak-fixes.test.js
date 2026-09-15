'use strict';

// ============================================================================================
// TEST cho 3 lỗi quan sát được trên ảnh chụp màn hình người dùng gửi
// ============================================================================================
//   (A) Nháp lập kế hoạch tiếng Anh ("We need to continue from that point...") stream thẳng ra
//       làm câu trả lời ở lượt tiếp nối.
//   (B) Sơ đồ Sinh học cũ (deterministic SVG) vẽ elip rỗng + chấm đánh số ở vị trí BỊA, nhãn cắt
//       cụt. Cơ chế đó ĐÃ BỊ XOÁ: nay dữ kiện sinh học đi vào prompt ảnh AI, đầy đủ, không bịa.
//   (C) "Tạo cho tôi hình ảnh cấu tạo con người" bị ép qua pipeline giải bài hai giai đoạn.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const meta = require('../server/utils/metaPlanningFilter');
const { stripThinkingTags } = require('../server/utils/thinkingFilter');
const specBuilder = require('../server/utils/visual/visualSpecBuilder');
const decisionEngine = require('../server/utils/visual/visualDecisionEngine');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); passed += 1; }
  catch (e) { console.log(` FAIL - ${name}\n        ${e.message}`); failed += 1; }
}

// ============================================================================================
console.log('\n== (A) Nháp lập kế hoạch KHÔNG được lọt ra câu trả lời ==');

// Trích NGUYÊN VĂN từ ảnh người dùng gửi.
const LEAKED = [
  'We need to continue from that point, not repeat anything before. Keep same numbering: we were at step 6 (Hệ tiêu hóa).',
  'Then after finishing step 6, continue with step 7 maybe? The previous steps enumerated: 1. Hệ thần kinh trung ương, 2. Hệ cơ.',
  'So after finishing 6, we may conclude the explanation of the example, then move to Kết luận section, etc.',
  'We must not repeat previous content, but we can continue the sentence: "Dạ dày...".',
  'After that, we need to provide Kết luận section (with...'
];

// Câu trả lời HỢP LỆ bằng tiếng Anh — tuyệt đối KHÔNG được đụng tới.
const LEGIT = [
  'We need to find the derivative of f(x) = x^2 + 3x.',
  'We must apply the chain rule here because the outer function is squared.',
  "Let's substitute u = 2x + 1 into the integral.",
  'The user of this protocol sends a SYN packet first.',
  'I need 3 moles of oxygen to balance this equation.',
  'Dạ dày co bóp nhào trộn thức ăn với dịch vị, tạo thành nhũ trấp.',
  '## Bước 3: Tính vận tốc',
  '| Hệ cơ quan | Chức năng |'
];

test('A1. mọi dòng nháp trong ảnh chụp màn hình đều bị nhận diện', () => {
  LEAKED.forEach((l) => assert.ok(meta.isMetaPlanningLine(l), `KHÔNG bắt được: "${l.slice(0, 60)}…"`));
});

test('A2. KHÔNG có dương tính giả trên câu trả lời thật (kể cả tiếng Anh)', () => {
  LEGIT.forEach((l) => assert.ok(!meta.isMetaPlanningLine(l), `bắt NHẦM câu trả lời thật: "${l}"`));
});

test('A3. stripMetaPlanning giữ nguyên nội dung thật, bỏ nháp + dải "---" ngay sau nháp', () => {
  const input = [
    LEAKED[0], '', LEAKED[3], '---',
    'Dạ dày co bóp nhào trộn thức ăn với dịch vị.',
    '', '## Kết luận', 'Hệ tiêu hóa cung cấp glucose cho cơ bắp.'
  ].join('\n');
  const out = meta.stripMetaPlanning(input);
  assert.ok(!/We need to|We must not/.test(out), 'vẫn còn nháp');
  assert.ok(out.startsWith('Dạ dày co bóp'), `mất nội dung thật ở đầu: "${out.slice(0, 40)}"`);
  assert.ok(/## Kết luận/.test(out) && /glucose/.test(out), 'mất phần Kết luận');
  assert.ok(!/^---$/m.test(out), 'dải phân cách mồ côi còn sót lại');
});

test('A4. dải "---" HỢP LỆ trong câu trả lời thật KHÔNG bị bỏ', () => {
  const input = 'Phần một của lời giải.\n\n---\n\nPhần hai của lời giải.';
  assert.ok(/---/.test(meta.stripMetaPlanning(input)), 'xoá nhầm dải phân cách markdown thật');
});

test('A5. nội dung trong khối ``` KHÔNG BAO GIỜ bị đụng tới', () => {
  const input = '```js\n// We need to continue the previous step here\nconst x = 1;\n```\nSau khối mã.';
  const out = meta.stripMetaPlanning(input);
  assert.ok(/We need to continue the previous step/.test(out), 'đã sửa nội dung bên trong khối mã');
});

test('A6. response CHỈ CÓ nháp -> coi như rỗng để kích hoạt failover', () => {
  assert.strictEqual(meta.isOnlyMetaPlanning(LEAKED.join('\n')), true);
  assert.strictEqual(meta.isOnlyMetaPlanning(LEAKED[0] + '\nDạ dày co bóp.'), false);
  assert.strictEqual(meta.isOnlyMetaPlanning('Lời giải bình thường.'), false);
});

test('A7. stripThinkingTags (điểm chặn DUY NHẤT) đã bao gồm cả lớp lọc này', () => {
  const out = stripThinkingTags(`<think>nháp</think>\n${LEAKED[0]}\nDạ dày co bóp.`);
  assert.strictEqual(out, 'Dạ dày co bóp.');
});

test('A8. bộ lọc STREAMING cho cùng kết quả với bản không-streaming', () => {
  const input = `${LEAKED[0]}\n---\nDạ dày co bóp nhào trộn thức ăn.\nHệ tiêu hóa hấp thụ glucose.\n`;
  let out = '';
  const f = meta.createMetaPlanningFilter((v) => { out += v; });
  // Cắt thành các chunk nhỏ, kể cả giữa từ — mô phỏng đúng cách delta SSE tới nơi.
  for (let i = 0; i < input.length; i += 7) f.feed(input.slice(i, i + 7));
  f.flush();
  assert.ok(!/We need to/.test(out), 'nháp lọt qua đường streaming');
  assert.ok(/Dạ dày co bóp nhào trộn thức ăn/.test(out) && /glucose/.test(out), 'mất nội dung thật');
});

test('A9. aiProviders mắc bộ lọc vào ĐÚNG chuỗi stream (trước safetyFilter)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'utils', 'aiProviders.js'), 'utf8');
  assert.ok(/createMetaPlanningFilter/.test(src), 'chưa mắc vào đường streaming');
  assert.ok(src.indexOf('const metaFilter') < src.indexOf('const filter = createStreamingThinkingFilter'),
    'thứ tự chuỗi lọc sai');
  assert.ok(/metaFilter\.flush\(\)/.test(src), 'thiếu flush -> mất dòng cuối cùng');
});

// ============================================================================================
console.log('\n== (B) Sơ đồ Sinh học: dữ kiện đi vào PROMPT ẢNH đầy đủ, không bịa, không cắt cụt ==');

// Đúng nội dung trong ảnh chụp màn hình.
const BIO_ANSWER = [
  '- **Phân loại**: Cơ thể người có 4 nhóm mô chính: biểu mô, mô liên kết, mô cơ và mô thần kinh.',
  '- **Hệ vận động**: Gồm hệ xương và hệ cơ, giúp cơ thể di chuyển và giữ hình dạng.',
  '- **Hệ sinh dục**: Thực hiện chức năng sinh sản, duy trì nòi giống.',
  '- **Hệ bì (da)**: Bảo vệ cơ thể, điều hòa thân nhiệt và cảm nhận xúc giác.'
].join('\n');

function bioSpec() {
  return specBuilder.buildVisualSpec({
    decision: { visualType: 'biology_diagram', visualPurpose: 'cấu tạo cơ thể người' },
    question: 'Trình bày cấu tạo cơ thể người',
    finalAnswer: BIO_ANSWER,
    subject: 'biology'
  });
}

test('B1. KHÔNG còn renderer SVG nào trong hệ thống hình (module đã bị xoá hẳn)', () => {
  assert.throws(
    () => require('../server/utils/visual/deterministicRenderer'),
    /Cannot find module/,
    'deterministicRenderer.js phải bị xoá, không được để lại dead code'
  );
  const visualDir = path.join(__dirname, '..', 'server', 'utils', 'visual');
  const files = fs.readdirSync(visualDir);
  assert.ok(!files.includes('deterministicRenderer.js'));
});

test('B2. mọi tên thành phần trong lời giải đều vào spec, KHÔNG cắt cụt', () => {
  const spec = bioSpec();
  const names = spec.data.parts.map((p) => p.name);
  ['Phân loại', 'Hệ vận động', 'Hệ sinh dục', 'Hệ bì (da)'].forEach((n) => {
    assert.ok(names.includes(n), 'thiếu thành phần: ' + n);
  });
});

test('B3. prompt ảnh liệt kê ĐỦ thành phần bắt buộc (Required objects)', () => {
  const prompt = specBuilder.buildImagePrompt(bioSpec());
  assert.ok(/Required objects:/.test(prompt));
  ['Phân loại', 'Hệ vận động', 'Hệ sinh dục'].forEach((n) => {
    assert.ok(prompt.includes(n), 'prompt thiếu thành phần: ' + n);
  });
});

test('B4. prompt CẤM bịa dữ kiện — nguồn gốc lỗi "chấm đánh số ở vị trí bịa"', () => {
  const prompt = specBuilder.buildImagePrompt(bioSpec());
  assert.ok(/No invented data/.test(prompt));
  assert.ok(/Do not replace or omit required labels/.test(prompt));
});

test('B5. prompt ảnh KHÔNG BAO GIỜ chứa markup SVG', () => {
  const prompt = specBuilder.buildImagePrompt(bioSpec());
  assert.ok(!/<svg|<ellipse|<circle/i.test(prompt));
});

test('B6. lời giải không có thành phần nào -> spec không bịa ra parts', () => {
  const spec = specBuilder.buildVisualSpec({
    decision: { visualType: 'biology_diagram', visualPurpose: 'khái niệm' },
    question: 'Minh họa khái niệm sự sống',
    finalAnswer: 'Sự sống là một khái niệm rộng.',
    subject: 'biology'
  });
  assert.deepStrictEqual(spec.data.parts, [], 'không được tự sinh thành phần không có trong lời giải');
});

// ============================================================================================
console.log('\n== (C) Yêu cầu CHỈ LẤY HÌNH đi đường riêng, không qua pipeline giải bài ==');

test('C1. nhận diện đúng yêu cầu tạo hình (tiếng Việt và tiếng Anh)', () => {
  [
    ['Tạo cho tôi hình ảnh cấu tạo con người', 'cấu tạo con người'],
    ['Cho tôi xem ảnh tế bào thực vật', 'tế bào thực vật'],
    ['Vẽ sơ đồ mạch điện RLC', 'mạch điện RLC'],
    ['create an image of the solar system', 'the solar system']
  ].forEach(([q, topic]) => {
    const r = decisionEngine.detectImageOnlyRequest(q);
    assert.ok(r.imageOnly, `bỏ sót: "${q}"`);
    assert.strictEqual(r.topic, topic, `chủ thể sai cho "${q}": "${r.topic}"`);
  });
});

test('C2. KHÔNG cướp mất câu hỏi có nội dung học thuật thật', () => {
  [
    'Giải phương trình x^2-5x+6=0 và vẽ hình minh hoạ',
    'Tính diện tích tam giác ABC',
    'Trình bày cấu tạo tế bào',
    'Chứng minh tam giác ABC vuông, vẽ hình',
    'So sánh ảnh của vật qua thấu kính hội tụ và phân kì'
  ].forEach((q) => {
    assert.ok(!decisionEngine.detectImageOnlyRequest(q).imageOnly, `cướp nhầm: "${q}"`);
  });
});

test('C3. thiếu chủ thể hoặc câu quá dài -> KHÔNG vào đường tắt', () => {
  assert.ok(!decisionEngine.detectImageOnlyRequest('vẽ cho tôi một bức ảnh').imageOnly);
  assert.ok(!decisionEngine.detectImageOnlyRequest('Tạo hình ảnh ' + 'mô tả rất dài '.repeat(20)).imageOnly);
  assert.ok(!decisionEngine.detectImageOnlyRequest('').imageOnly);
});

test('C4. ranh giới từ Unicode — "vẽ"/"ảnh" phải khớp (\\b của JS không làm được)', () => {
  // Bảo vệ chống hồi quy: nếu ai đó thay lookaround \p{L} bằng \b, các case này sẽ chết im lặng.
  assert.ok(decisionEngine.detectImageOnlyRequest('Vẽ hình ảnh núi lửa').imageOnly);
  assert.ok(decisionEngine.detectImageOnlyRequest('Cho tôi xem ảnh não bộ').imageOnly);
});

test('C5. chat.js: nhánh image-only nằm TRƯỚC mọi nhánh giải bài và dùng đúng 1 lượt text', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'chat.js'), 'utf8');
  const iDetect = src.indexOf('detectImageOnlyRequest');
  const iStream = src.indexOf('if (wantsStream) {\n      sseHeaders(res);');
  assert.ok(iDetect > 0, 'chưa nối detectImageOnlyRequest vào route');
  assert.ok(iDetect < iStream, 'nhánh image-only phải chạy TRƯỚC pipeline giải bài');
  assert.ok(/generateImageCaption/.test(src), 'thiếu hàm sinh chú thích');
  assert.ok(/reasoningBudget: 0/.test(src), 'chú thích không cần native reasoning');
  assert.ok(/state: STATES\.COMPLETED,\s*\n\s*partial: false,\s*\n\s*text: captionText/.test(src),
    'yêu cầu tạo hình phải LUÔN COMPLETED — không được hiện "CHƯA ĐẦY ĐỦ"');
});

test('C6. nhánh image-only KHÔNG chạy completeness/continuation (nguồn của cảnh báo CHƯA ĐẦY ĐỦ)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'chat.js'), 'utf8');
  const start = src.indexOf('if (imageOnly.imageOnly) {');
  const end = src.indexOf('if (wantsStream) {\n      sseHeaders(res);');
  assert.ok(start > 0 && end > start);
  const branch = src.slice(start, end);
  assert.ok(!/runResumableStream|validateSolutionCompleteness|makeRecoveryResolver/.test(branch),
    'nhánh tạo hình không được đi qua vòng completeness/recovery của lời giải');
  assert.ok(/userPreference: 'always'/.test(branch), 'yêu cầu tường minh phải ghi đè setting hình');
});

test('C7. không tạo được hình -> nói rõ, không để người dùng nhìn khoảng trống', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'chat.js'), 'utf8');
  const start = src.indexOf('if (imageOnly.imageOnly) {');
  const branch = src.slice(start, start + 4000);
  assert.ok(/Chưa tạo được hình cho yêu cầu này/.test(branch), 'thiếu thông báo khi không có hình');
});

// ============================================================================================
console.log('\n== (D) Checklist tự-kiểm về định dạng lọt ra câu trả lời + card khái niệm không lặp title ==');

// Đúng nội dung trong ảnh chụp màn hình mới nhất.
const SELF_CHECK_LEAKED = [
  '* No titles/headers? Yes.',
  '* No extra text?',
  '- Any markdown headings? No.'
];
const SELF_CHECK_LEGIT = [
  '* Bước 1: Tính đạo hàm của hàm số.',
  '- Có bao nhiêu proton trong hạt nhân?',
  '* Tại sao phản ứng này toả nhiệt?',
  '- No, glucose is not stored directly in muscle as fat.'
];

test('D1. mọi dòng checklist tự-kiểm trong ảnh chụp đều bị nhận diện', () => {
  SELF_CHECK_LEAKED.forEach((l) => assert.ok(meta.isMetaPlanningLine(l), `KHÔNG bắt được: "${l}"`));
});

test('D2. KHÔNG bắt nhầm câu hỏi ôn tập / nội dung thật có dấu "?"', () => {
  SELF_CHECK_LEGIT.forEach((l) => assert.ok(!meta.isMetaPlanningLine(l), `bắt NHẦM: "${l}"`));
});

test('D3. stripMetaPlanning loại sạch checklist, giữ nguyên "Lời giải chi tiết" thật', () => {
  const input = [
    'Sự sống là một khái niệm rộng.', '',
    SELF_CHECK_LEAKED[0], SELF_CHECK_LEAKED[1]
  ].join('\n');
  const out = meta.stripMetaPlanning(input);
  assert.ok(!/No titles\/headers|No extra text/.test(out), 'checklist vẫn còn lọt ra');
  assert.ok(/Sự sống là một khái niệm rộng/.test(out), 'mất nội dung thật');
});

test('D4. prompt ảnh KHÔNG lặp lại title khi thiếu purpose (nguồn của card lặp chữ)', () => {
  const prompt = specBuilder.buildImagePrompt({
    type: 'concept_illustration', title: 'Sơ đồ cấu trúc sinh học', purpose: '',
    labels: [], objects: [], relationships: [], requiredEquations: [], data: {},
    language: 'vi', subject: 'biology', aspectRatio: '1:1'
  });
  const hits = (prompt.match(/Sơ đồ cấu trúc sinh học/g) || []).length;
  assert.strictEqual(hits, 1, `title chỉ được xuất hiện 1 lần, thực tế ${hits}`);
});

test('D5. visualPipeline không gửi caption trùng y hệt title xuống client', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'utils', 'visual', 'visualPipeline.js'), 'utf8');
  assert.ok(/spec\.purpose \|\| ''\)\.trim\(\) === \(spec\.title \|\| ''\)\.trim\(\)/.test(src),
    'thiếu guard chặn caption trùng title');
});

// ============================================================================================
console.log('\n== (E) Checklist tự-kiểm ĐỢT 2 — nguyên văn ảnh "tạo hình ảnh cấu tạo cơ thể người" ==');
// LỚP 5/6/7 mới: "Checked." đứng riêng, "5. **Final Output Generation (", mảnh câu hỏi bị ngắt dòng
// giữa chừng không còn bullet/opener. Trích NGUYÊN VĂN từ ảnh chụp màn hình mới nhất người dùng gửi.
const SELF_CHECK_LEAKED_2 = [
  'Checked.',
  '* No extra text? Checked.',
  '5. **Final Output Generation ('
];
// Mảnh CHỈ được coi là nháp khi đứng NGAY SAU 1 dòng đã bị loại — kiểm bằng stripMetaPlanning, không
// phải isMetaPlanningLine đơn lẻ (đúng thiết kế cascading LỚP 7).
const CONTINUATION_FRAGMENT = ', no steps, no headers? Yes (ensure no "Giới thiệu:" or "Thành phần:" headers).';

const SELF_CHECK_LEGIT_2 = [
  'Checked the derivative and it equals 2x.',           // "Checked" là ĐỘNG TỪ có tân ngữ thật -> giữ
  '5. **Bước cuối: Kết luận và đáp số**',                // tiêu đề bước giải bài thật -> giữ
  '- Output của mạch là 5V khi đóng công tắc.'           // "Output" là nội dung kỹ thuật thật -> giữ
];

test('E1. mọi dòng nháp mới (Checked. / numbered header) đều bị nhận diện', () => {
  SELF_CHECK_LEAKED_2.forEach((l) => assert.ok(meta.isMetaPlanningLine(l), `KHÔNG bắt được: "${l}"`));
});

test('E2. KHÔNG bắt nhầm câu trả lời thật dùng chung từ khoá (Checked/Output/numbered header)', () => {
  SELF_CHECK_LEGIT_2.forEach((l) => assert.ok(!meta.isMetaPlanningLine(l), `bắt NHẦM: "${l}"`));
});

test('E3. mảnh câu hỏi bị ngắt dòng CHỈ bị loại khi cascading ngay sau dòng nháp', () => {
  assert.strictEqual(meta.isMetaPlanningLine(CONTINUATION_FRAGMENT), false,
    'đứng ĐƠN LẺ không được coi là nháp (tránh dương tính giả trên câu văn thật bắt đầu bằng thường)');
  const cascaded = meta.stripMetaPlanning([SELF_CHECK_LEAKED_2[1], CONTINUATION_FRAGMENT, 'Nội dung thật.'].join('\n'));
  assert.ok(!cascaded.includes('no steps, no headers'), 'mảnh vỡ vẫn lọt ra khi cascading sau dòng nháp');
  assert.ok(cascaded.includes('Nội dung thật.'), 'mất nội dung thật phía sau');
});

test('E4. stripMetaPlanning trên NGUYÊN VĂN toàn bộ ảnh chụp -> chỉ còn nội dung thật', () => {
  const input = [
    SELF_CHECK_LEAKED_2[0],
    '* No titles/headers? Yes.',
    SELF_CHECK_LEAKED_2[1],
    SELF_CHECK_LEAKED_2[2],
    CONTINUATION_FRAGMENT,
    'Cơ thể người gồm nhiều hệ cơ quan phối hợp hoạt động.'
  ].join('\n');
  const out = meta.stripMetaPlanning(input);
  assert.strictEqual(out, 'Cơ thể người gồm nhiều hệ cơ quan phối hợp hoạt động.',
    `còn sót nháp: "${out}"`);
});

test('E5. response CHỈ CÓ nháp mới (không mảnh cascading) -> coi như rỗng để kích hoạt failover', () => {
  assert.strictEqual(meta.isOnlyMetaPlanning(SELF_CHECK_LEAKED_2.join('\n')), true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
