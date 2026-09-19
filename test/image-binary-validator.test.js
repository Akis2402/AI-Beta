'use strict';

// ============================================================================================
// ĐỢT AUDIT 2 — MỤC 1/2: verifyImageBytes()/validateImageBuffer() PHẢI STRICT TUYỆT ĐỐI
// ============================================================================================
// Lỗ hổng cũ: unknown binary + claimedMime='image/png' -> PASS (tin nhãn provider tự khai).
// File này khoá cứng hành vi ĐÚNG: unknown binary luôn FAIL, bất kể claimedMime nói gì.

const assert = require('assert');
const { validateImageBuffer, validateImageBase64, detectSignatureFromBuffer } = require('../server/utils/visual/imageBinaryValidator');

const REAL_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// JPEG thật tối thiểu: SOI (0xFFD8FF) + SOI end tối giản đủ để qua signature check.
const REAL_JPEG_BUF = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const REAL_WEBP_BUF = Buffer.concat([
  Buffer.from('RIFF', 'ascii'), Buffer.from([0x00, 0x00, 0x00, 0x00]), Buffer.from('WEBP', 'ascii')
]);
const REAL_GIF_BUF = Buffer.from('GIF89a', 'ascii');

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, error: e.message }); }
}

test('MỤC 1: unknown binary + claimedMime="image/png" hợp lệ -> PHẢI FAIL (không còn thoát hiểm)', () => {
  const r = validateImageBuffer(Buffer.from('day khong phai anh, chi la text ngau nhien du dai'), 'image/png');
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.reason, 'invalid_magic_bytes');
});

test('MỤC 1: unknown binary KHÔNG có claimedMime -> FAIL', () => {
  const r = validateImageBuffer(Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]), '');
  assert.strictEqual(r.valid, false);
});

test('MỤC 1: buffer rỗng -> FAIL với reason riêng (empty_body), không lẫn với invalid_magic_bytes', () => {
  const r = validateImageBuffer(Buffer.alloc(0), 'image/png');
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.reason, 'empty_body');
});

test('MỤC 1: PNG thật -> PASS, detectedMime=image/png dù claimedMime khác/thiếu', () => {
  const buf = Buffer.from(REAL_PNG_B64, 'base64');
  const r = validateImageBuffer(buf, '');
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.detectedMime, 'image/png');
  assert.strictEqual(r.format, 'png');
});

test('MỤC 1: claimedMime="image/png" nhưng binary THẬT là JPEG -> PASS với detectedMime=image/jpeg, KHÔNG bao giờ báo PNG', () => {
  const r = validateImageBuffer(REAL_JPEG_BUF, 'image/png');
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.detectedMime, 'image/jpeg', 'chữ ký byte thật phải thắng tuyệt đối, không được giữ nhãn PNG sai');
  assert.strictEqual(r.mimeMismatch, true, 'phải gắn cờ mismatch để caller biết mà xử lý (normalize hoặc từ chối)');
});

test('WEBP thật (RIFF....WEBP) -> PASS đúng format webp', () => {
  const r = validateImageBuffer(REAL_WEBP_BUF, 'image/webp');
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.detectedMime, 'image/webp');
});

test('RIFF nhưng KHÔNG phải WEBP (giả lập WAV) -> FAIL, không nhận nhầm mọi RIFF là ảnh', () => {
  const wavLike = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVE', 'ascii')]);
  const r = validateImageBuffer(wavLike, 'image/webp');
  assert.strictEqual(r.valid, false);
});

test('GIF89a thật -> PASS', () => {
  const r = validateImageBuffer(REAL_GIF_BUF, '');
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.detectedMime, 'image/gif');
});

test('HTML giả mạo làm ảnh -> FAIL (đúng ca "URL trả HTML" trong yêu cầu audit)', () => {
  const html = Buffer.from('<!DOCTYPE html><html><body>Error page</body></html>', 'utf8');
  const r = validateImageBuffer(html, 'text/html');
  assert.strictEqual(r.valid, false);
});

test('JSON giả mạo làm ảnh -> FAIL', () => {
  const json = Buffer.from(JSON.stringify({ error: 'rate_limited' }), 'utf8');
  const r = validateImageBuffer(json, 'application/json');
  assert.strictEqual(r.valid, false);
});

test('validateImageBase64: chuỗi rác không phải base64 (có khoảng trắng/tiếng Việt) -> FAIL, không decode mù', () => {
  const r = validateImageBase64('Xin lỗi, tôi không thể tạo hình này được.', 'image/png');
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.reason, 'not_base64');
});

test('validateImageBase64: base64 bị cắt cụt (không đủ header) -> FAIL', () => {
  const r = validateImageBase64('iVBORw0K', 'image/png');
  assert.strictEqual(r.valid, false);
});

test('validateImageBase64: PNG thật qua base64 -> PASS', () => {
  const r = validateImageBase64(REAL_PNG_B64, 'image/png');
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.detectedMime, 'image/png');
  assert.ok(r.bytes > 0);
});

test('detectSignatureFromBuffer: null/undefined không throw, trả null', () => {
  assert.strictEqual(detectSignatureFromBuffer(null), null);
  assert.strictEqual(detectSignatureFromBuffer(undefined), null);
  assert.strictEqual(detectSignatureFromBuffer(Buffer.alloc(0)), null);
});

let p = 0, f = 0;
console.log('\n== ĐỢT AUDIT 2 MỤC 1/2: imageBinaryValidator (strict, dùng chung toàn hệ thống) ==');
results.forEach((r) => {
  if (r.pass) { p++; console.log('  ok  - ' + r.name); }
  else { f++; console.log(' FAIL - ' + r.name + '\n        ' + r.error); }
});
console.log(`\n${p} passed, ${f} failed`);
if (f) process.exitCode = 1;
