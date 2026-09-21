'use strict';

// Ảnh THẬT tối thiểu cho test: từ khi validator kiểm magic bytes (PHẦN G — chống nhãn MIME giả),
// chuỗi base64 bịa ('AAAA') không còn là dữ liệu hợp lệ. Dùng đúng chữ ký chuẩn thay vì nới validator.

function makePng(payloadBytes = 128) {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(Math.max(8, payloadBytes), 0x11)
  ]).toString('base64');
}

function makeJpeg(payloadBytes = 128) {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(Math.max(8, payloadBytes), 0x22)
  ]).toString('base64');
}

function makeGif(payloadBytes = 128) {
  return Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(Math.max(8, payloadBytes), 0x33)]).toString('base64');
}

function makeWebp(payloadBytes = 128) {
  return Buffer.concat([
    Buffer.from('RIFF', 'latin1'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP', 'latin1'),
    Buffer.alloc(Math.max(8, payloadBytes), 0x44)
  ]).toString('base64');
}

module.exports = { makePng, makeJpeg, makeGif, makeWebp };
