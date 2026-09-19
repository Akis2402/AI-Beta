'use strict';

// PHẦN A/D — REGRESSION: ngân sách payload là MỘT nguồn sự thật, đo bằng byte THẬT, và không có
// ngoại lệ "luôn giữ 1 ảnh". Mỗi assertion dưới đây khoá đúng một bug đã từng tồn tại.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const budget = require('../server/utils/payloadBudget');
const { makePng } = require('./_imageFixtures');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ok  - ' + name); passed++; }
  catch (e) { console.log(' FAIL - ' + name + '\n        ' + e.message); failed++; }
}

console.log('\n== PHẦN A: hằng số dùng chung client/server KHÔNG được lệch ==');

const clientSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'payloadBudget.js'), 'utf8');
function clientConst(name) {
  const m = new RegExp('var ' + name + ' = ([^;]+);').exec(clientSrc);
  assert.ok(m, 'không tìm thấy hằng số ' + name + ' ở bản client');
  // eslint-disable-next-line no-new-func
  // Server làm tròn về số nguyên byte (clampEnv) — so khớp cùng một đơn vị, không so số thực.
  return Math.round(m[1].split('*').map((x) => Number(x.trim())).reduce((a, b) => a * b, 1));
}

[
  'SAFE_REQUEST_BYTES', 'SAFE_RESPONSE_BYTES', 'MAX_DIRECT_IMAGE_BYTES',
  'MAX_SOURCE_IMAGE_BYTES', 'MAX_SOURCE_IMAGES_TOTAL_BYTES', 'MAX_SOURCE_IMAGES', 'MAX_TEXT_PAYLOAD_BYTES'
].forEach((name) => {
  test(`${name} khớp giữa server và client`, () => {
    assert.strictEqual(clientConst(name), budget[name],
      'server và client lệch hằng số -> client tưởng payload hợp lệ nhưng server từ chối (hoặc ngược lại)');
  });
});

test('trần an toàn phải THẤP HƠN trần nền tảng (chừa chỗ cho header/SSE framing)', () => {
  assert.ok(budget.SAFE_REQUEST_BYTES < budget.PLATFORM_BODY_LIMIT_BYTES);
  assert.ok(budget.SAFE_RESPONSE_BYTES < budget.PLATFORM_BODY_LIMIT_BYTES);
  assert.ok(budget.PARSER_LIMIT_BYTES <= budget.PLATFORM_BODY_LIMIT_BYTES,
    'trần body-parser KHÔNG được vượt trần nền tảng — vượt là chắc chắn 413 ở tầng ngoài');
  assert.ok(budget.PARSER_LIMIT_BYTES > budget.SAFE_REQUEST_BYTES,
    'parser phải rộng hơn ngân sách an toàn để validator kịp trả lỗi CÓ CẤU TRÚC thay vì 413 trần trụi');
});

console.log('\n== PHẦN A2: đo kích thước THẬT, không phải base64.length * 0.75 ==');

test('serializedBytes() = đúng số byte UTF-8 của chuỗi JSON', () => {
  const body = { query: 'Tính diện tích tam giác', n: 1 };
  assert.strictEqual(budget.serializedBytes(body), Buffer.byteLength(JSON.stringify(body), 'utf8'));
});

test('base64 trong JSON chiếm ĐÚNG base64.length byte (không phải 0.75 lần)', () => {
  const b64 = makePng(1024);
  const body = { image: { base64: b64 } };
  const wire = budget.serializedBytes(body);
  assert.ok(wire > b64.length, 'phải lớn hơn chính chuỗi base64 (còn phần JSON bao quanh)');
  assert.ok(wire > budget.base64Bytes(b64) * 1.3,
    'ước lượng kiểu *0.75 sẽ ĐÁNH GIÁ THẤP kích thước thật — đây chính là root cause của 413 trên Vercel');
});

test('tiếng Việt có dấu tính theo byte UTF-8, không theo số ký tự', () => {
  assert.strictEqual(budget.serializedBytes('"đ"'), Buffer.byteLength('"đ"', 'utf8'));
});

console.log('\n== PHẦN A6: KHÔNG còn ngoại lệ "luôn giữ ít nhất 1 ảnh" ==');

test('ảnh ĐẦU TIÊN tự nó vượt trần -> bị TỪ CHỐI, không lọt vào kết quả', () => {
  const huge = makePng(3 * 1024 * 1024);
  const res = budget.capImagesToByteBudget([{ base64: huge, page: 1 }, { base64: makePng(1024), page: 2 }]);
  assert.strictEqual(res.kept.length, 1, 'chỉ giữ ảnh hợp lệ');
  assert.strictEqual(res.kept[0].page, 2);
  assert.strictEqual(res.rejected[0].reason, 'image_too_large');
});

test('kết quả trả về KHÔNG BAO GIỜ vượt tổng ngân sách', () => {
  const img = () => ({ base64: makePng(1024 * 1024) });
  const res = budget.capImagesToByteBudget([img(), img(), img(), img(), img()]);
  const total = res.kept.reduce((a, i) => a + budget.base64WireBytes(i.base64), 0);
  assert.ok(total <= budget.MAX_SOURCE_IMAGES_TOTAL_BYTES, `tổng ${total} vượt ngân sách`);
  assert.ok(res.rejected.length > 0, 'phần bị bỏ phải được BÁO CÁO, không biến mất im lặng');
});

console.log('\n== PHẦN D: gom batch theo BYTE, trang quá lớn tách riêng ==');

test('mỗi batch nằm dưới ngân sách; trang quá lớn đi vào oversized', () => {
  const small = Array.from({ length: 10 }, (_, i) => ({ page: i + 1, base64: makePng(200 * 1024) }));
  const big = { page: 99, base64: makePng(4 * 1024 * 1024) };
  const plan = budget.planByteBatches(small.concat([big]));
  assert.ok(plan.batches.length >= 2, 'phải chia thành nhiều batch theo byte');
  plan.batches.forEach((b) => {
    const bytes = b.reduce((a, it) => a + budget.serializedBytes(it), 0);
    assert.ok(bytes <= budget.MAX_SOURCE_IMAGES_TOTAL_BYTES, 'batch vượt ngân sách');
  });
  assert.deepStrictEqual(plan.oversized.map((p) => p.page), [99],
    '1 trang quá lớn KHÔNG được làm hỏng cả tài liệu — tách riêng để xử lý/báo lỗi đúng trang đó');
});

test('không trang nào biến mất: tổng batch + oversized = đầu vào', () => {
  const items = Array.from({ length: 23 }, (_, i) => ({ page: i + 1, base64: makePng(100 * 1024) }));
  const plan = budget.planByteBatches(items);
  const count = plan.batches.reduce((a, b) => a + b.length, 0) + plan.oversized.length;
  assert.strictEqual(count, items.length, 'mất trang giữa chừng = mất dữ liệu nguồn im lặng');
});

console.log('\n== PHẦN A8: lỗi payload CÓ CẤU TRÚC, không leak nội bộ ==');

test('payloadTooLargeError có đủ actualSize/safeLimit/suggestedAction và KHÔNG có gì thừa', () => {
  const err = budget.payloadTooLargeError({ actualSize: 9999, safeLimit: 100 });
  assert.strictEqual(err.status, 413);
  assert.strictEqual(err.code, 'PAYLOAD_TOO_LARGE');
  assert.deepStrictEqual(Object.keys(err.payloadInfo).sort(), ['actualSize', 'safeLimit', 'scope', 'suggestedAction']);
  assert.ok(!/\/home|\/server|node_modules/.test(JSON.stringify(err.payloadInfo)), 'không được lộ đường dẫn nội bộ');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
