'use strict';

// ============================================================================================
// TEST cho 3 lỗi quan sát được trên ảnh chụp màn hình người dùng gửi
// ============================================================================================
//   (A) Nháp lập kế hoạch tiếng Anh ("We need to continue from that point...") stream thẳng ra
//       làm câu trả lời ở lượt tiếp nối.
//   (B) Sơ đồ Sinh học là một hình elip rỗng với các chấm đánh số đặt ở vị trí BỊA, nhãn bị cắt
//       cụt ở 22/28 ký tự.
//   (C) "Tạo cho tôi hình ảnh cấu tạo con người" bị ép qua pipeline giải bài hai giai đoạn.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const meta = require('../server/utils/metaPlanningFilter');
const { stripThinkingTags } = require('../server/utils/thinkingFilter');
const renderer = require('../server/utils/visual/deterministicRenderer');
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
console.log('\n== (B) Sơ đồ Sinh học: KHÔNG vẽ hình giả, KHÔNG cắt cụt nhãn ==');

// Đúng nội dung trong ảnh chụp màn hình.
const BIO_SPEC = {
  type: 'biology_diagram',
  title: 'Sơ đồ cấu trúc sinh học',
  data: {
    parts: [
      { name: 'Phân loại', note: 'Cơ thể người có 4 nhóm mô chính: biểu mô, mô liên kết, mô cơ và mô thần kinh.' },
      { name: 'Hệ vận động', note: 'Gồm hệ xương và hệ cơ, giúp cơ thể di chuyển và giữ hình dạng.' },
      { name: 'Hệ sinh dục', note: 'Thực hiện chức năng sinh sản, duy trì nòi giống.' },
      { name: 'Hệ bì (da)', note: 'Bảo vệ cơ thể, điều hòa thân nhiệt và cảm nhận xúc giác.' }
    ]
  }
};

function svgText(svg) {
  return String(svg).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

test('B1. KHÔNG có toạ độ thật -> KHÔNG vẽ elip/chấm đánh số ở vị trí bịa', () => {
  const out = renderer.renderDeterministic(BIO_SPEC);
  assert.ok(out.ok, 'renderer phải trả về được thứ gì đó');
  assert.ok(!/<ellipse/.test(out.content),
    'vẫn vẽ hình elip rỗng — hình này không đại diện cho bất cứ thứ gì và ngụ ý vị trí giải phẫu giả');
});

test('B2. mô tả dài KHÔNG bị cắt cụt — phải XUỐNG DÒNG', () => {
  const text = svgText(renderer.renderDeterministic(BIO_SPEC).content);
  assert.ok(/Cơ thể người có 4 nhóm mô chính/.test(text),
    `mô tả vẫn bị cắt: "${text.slice(0, 160)}"`);
  assert.ok(/biểu mô/.test(text), 'phần đuôi của mô tả bị mất');
});

test('B3. mọi tên thành phần đều xuất hiện đầy đủ', () => {
  const text = svgText(renderer.renderDeterministic(BIO_SPEC).content);
  ['Phân loại', 'Hệ vận động', 'Hệ sinh dục', 'Hệ bì (da)']
    .forEach((n) => assert.ok(text.includes(n), `thiếu "${n}"`));
});

test('B4. CÓ toạ độ giải phẫu thật -> VẪN dựng sơ đồ định vị (không mất tính năng)', () => {
  const positioned = {
    ...BIO_SPEC,
    data: {
      parts: BIO_SPEC.data.parts.map((p, i) => ({ ...p, pos: { x: 0.3 + i * 0.1, y: 0.2 + i * 0.15 } }))
    }
  };
  assert.strictEqual(renderer.hasAnatomicalPositions(positioned.data.parts), true);
  const out = renderer.renderDeterministic(positioned);
  assert.ok(/<circle/.test(out.content) && /<line/.test(out.content), 'mất sơ đồ định vị hợp lệ');
});

test('B5. toạ độ thiếu/sai miền -> KHÔNG được coi là toạ độ thật', () => {
  const parts = BIO_SPEC.data.parts.map((p) => ({ ...p }));
  assert.strictEqual(renderer.hasAnatomicalPositions(parts), false, 'thiếu pos mà vẫn nhận');
  parts.forEach((p, i) => { p.pos = { x: i === 0 ? 5 : 0.4, y: 0.4 }; });
  assert.strictEqual(renderer.hasAnatomicalPositions(parts), false, 'pos ngoài miền 0..1 mà vẫn nhận');
});

test('B6. wrapText cắt ở RANH GIỚI TỪ, không cắt giữa chữ', () => {
  const lines = renderer.wrapText('Bảo vệ cơ thể, điều hòa thân nhiệt và cảm nhận xúc giác.', 20, 3);
  assert.ok(lines.length > 1, 'phải xuống dòng');
  lines.forEach((l) => assert.ok(l.length <= 21, `dòng quá dài: "${l}"`));
  assert.ok(!/\S…\S/.test(lines.join(' ')), 'cắt giữa từ');
});

test('B7. dưới 2 thành phần -> không dựng gì (không bịa hình từ 1 dữ kiện)', () => {
  const out = renderer.renderBiology({ type: 'biology_diagram', data: { parts: [{ name: 'Hệ cơ' }] } });
  assert.strictEqual(out, null);
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
