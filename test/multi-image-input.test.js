'use strict';

// PROMPT V5 — PHẦN Y/AC/V/X: MULTI-IMAGE INPUT, NỐI THẬT VÀO SERVER.
// Trước bản vá này, server chỉ biết `body.image` số ít — "hỗ trợ nhiều ảnh" chỉ tồn tại trong
// module imageBudgetPlanner.js nhưng chưa có đường vào (đúng như AUDIT-REPORT-V5-TOKEN-ECONOMY.md
// mục 5 đã nói thẳng). Bộ test này khoá đúng phần vừa nối: validators gộp `image` + `images[]`
// thành MỘT danh sách có thứ tự, không throw cả request vì 1 ảnh lẻ hỏng, và imageBudgetPlanner
// dedupe/giữ thứ tự đúng như PHẦN V/X.

const assert = require('assert');
const { validateChatBody } = require('../server/utils/validators');
const { planImages, imageMarker } = require('../server/utils/imageBudgetPlanner');
const { makePng, makeJpeg } = require('./_imageFixtures');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ok  - ' + name); passed++; }
  catch (e) { console.log(' FAIL - ' + name + '\n        ' + e.stack); failed++; }
}

console.log('\n== PHẦN AC: validators gộp `image` + `images[]` thành MỘT danh sách, không trùng ==');

test('1. chỉ `image` số ít (client cũ) -> images = [image], vẫn tương thích ngược', () => {
  const png = makePng(256);
  const out = validateChatBody({ query: 'giải giúp', image: { mediaType: 'image/png', base64: png } });
  assert.strictEqual(out.images.length, 1);
  assert.strictEqual(out.image.base64, png);
  assert.strictEqual(out.images[0].base64, png);
});

test('2. `image` + `images[]` -> gộp thành 1 danh sách, `image` là phần tử ĐẦU (PHẦN AC)', () => {
  const first = makePng(256);
  const second = makeJpeg(300);
  const third = makeJpeg(400);
  const out = validateChatBody({
    query: 'giải giúp',
    image: { mediaType: 'image/png', base64: first },
    images: [
      { mediaType: 'image/jpeg', base64: second },
      { mediaType: 'image/jpeg', base64: third }
    ]
  });
  assert.strictEqual(out.images.length, 3);
  assert.strictEqual(out.images[0].base64, first, 'ảnh đề bài (image) phải đứng đầu, giữ đúng thứ tự PHẦN X');
  assert.strictEqual(out.images[1].base64, second);
  assert.strictEqual(out.images[2].base64, third);
});

test('3. chỉ `images[]` (không có `image` số ít) vẫn hợp lệ', () => {
  const a = makePng(200);
  const out = validateChatBody({ query: 'giải giúp', images: [{ mediaType: 'image/png', base64: a }] });
  assert.strictEqual(out.images.length, 1);
  assert.strictEqual(out.image.base64, a, 'khi chỉ có images[], phần tử đầu vẫn gán vào `image` cho code cũ đọc');
});

test('4. một ảnh lẻ trong `images[]` hỏng -> CHỈ ảnh đó bị loại có lý do, KHÔNG throw cả request (PHẦN CX)', () => {
  const good = makePng(200);
  const out = validateChatBody({
    query: 'giải giúp',
    images: [
      { mediaType: 'image/png', base64: good },
      { mediaType: 'image/svg+xml', base64: 'not-really-svg' } // bị từ chối theo MIME
    ]
  });
  assert.strictEqual(out.images.length, 1, 'ảnh hỏng bị loại, ảnh tốt vẫn còn');
  assert.strictEqual(out.imagesRejected.length, 1);
  assert.strictEqual(out.imagesRejected[0].reason, 'image_type_rejected');
});

test('5. vượt MAX_USER_IMAGES (8) -> ảnh dư bị từ chối CÓ KHAI BÁO, không âm thầm cắt', () => {
  const imgs = [];
  for (let i = 0; i < 10; i += 1) imgs.push({ mediaType: 'image/png', base64: makePng(64 + i) });
  const out = validateChatBody({ query: 'giải giúp', images: imgs });
  assert.strictEqual(out.images.length, 8, 'PHẦN Y: MAX_USER_IMAGES = 8');
  assert.ok(out.imagesRejected.some((r) => r.reason === 'too_many_images'));
});

test('6. không query, không image, images[] rỗng -> vẫn báo lỗi như trước (không đổi hành vi)', () => {
  assert.throws(() => validateChatBody({}), /câu hỏi hoặc đính kèm ảnh/);
});

console.log('\n== PHẦN V/X: imageBudgetPlanner dedupe + giữ thứ tự khi wiring vào chat.js ==');

test('7. 2 ảnh GIỐNG HỆT (cùng fingerprint) -> chỉ gửi 1 lần, cái còn lại vào `duplicates` (PHẦN V/FC-8)', () => {
  const same = makePng(300);
  const plan = planImages([
    { id: 'img1', base64: same, mediaType: 'image/png' },
    { id: 'img2', base64: same, mediaType: 'image/png' }
  ], { tokenBudget: Number.MAX_SAFE_INTEGER });
  assert.strictEqual(plan.selected.length, 1, 'ảnh trùng không được gửi 2 lần cho model');
  assert.strictEqual(plan.duplicates.length, 1);
  assert.strictEqual(plan.duplicates[0].sameAs, 'img1');
});

test('8. giữ đúng thứ tự người dùng đính kèm (PHẦN X), kể cả sau khi dedupe', () => {
  const plan = planImages([
    { id: 'img1', base64: makePng(100), mediaType: 'image/png' },
    { id: 'img2', base64: makePng(200), mediaType: 'image/png' },
    { id: 'img3', base64: makePng(300), mediaType: 'image/png' }
  ], { tokenBudget: Number.MAX_SAFE_INTEGER });
  assert.deepStrictEqual(plan.selected.map((c) => c.id), ['img1', 'img2', 'img3']);
  assert.deepStrictEqual(plan.selected.map((c) => c.order), [1, 2, 3]);
});

test('9. marker cực ngắn [IMG1]/[IMG2] — PHẦN X cấm mô tả dài dòng', () => {
  assert.strictEqual(imageMarker(1), '[IMG1]');
  assert.strictEqual(imageMarker(2), '[IMG2]');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
