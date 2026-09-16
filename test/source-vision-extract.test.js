'use strict';
// ---------- A6/A11: /api/source/vision-extract — validate + parse (KHÔNG gọi AI thật) ----------
// Test các hàm THUẦN (không I/O): validateSourceVisionBody() (server/utils/validators.js) và
// parseVisionJson() (server/routes/sourceVision.js) — đủ để bắt regression ở tầng hợp đồng dữ liệu
// (request shape / response shape) mà không cần network/API key thật.

const assert = require('assert');
const { validateSourceVisionBody, ValidationError } = require('../server/utils/validators');
const { parseVisionJson } = require('../server/utils/visionExtract');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ok  - ' + msg); }
  else { failed++; console.log('  FAIL - ' + msg); }
}

console.log('\n== A6/A11: validateSourceVisionBody() ==');

{
  let threw = false;
  try { validateSourceVisionBody({}); } catch (e) { threw = e instanceof ValidationError; }
  ok(threw, 'body không có pages hợp lệ -> ném ValidationError (không âm thầm chạy tiếp với mảng rỗng)');
}

{
  // PHẦN D: ràng buộc THẬT không còn là "8 trang" mà là SỐ BYTE. 15 trang nhẹ nay được nhận đủ.
  const { makePng } = require('./_imageFixtures');
  const tinyPngBase64 = makePng(200);
  const pages = Array.from({ length: 15 }, (_, i) => ({ page: i + 1, mediaType: 'image/png', base64: tinyPngBase64 }));
  const result = validateSourceVisionBody({ pages });
  ok(result.pages.length === 15, `15 trang NHẸ vừa ngân sách byte -> nhận đủ, không cắt theo con số cố định (nhận ${result.pages.length})`);
  ok(result.pages[0].page === 1 && result.pages[14].page === 15, 'giữ nguyên thứ tự trang gửi lên');
}

{
  // Ràng buộc byte có hiệu lực THẬT: trang nặng vượt tổng ngân sách bị loại, và loại CÓ BÁO CÁO.
  const { makePng } = require('./_imageFixtures');
  const heavy = makePng(1.2 * 1024 * 1024);
  const pages = Array.from({ length: 6 }, (_, i) => ({ page: i + 1, mediaType: 'image/png', base64: heavy }));
  const result = validateSourceVisionBody({ pages });
  ok(result.pages.length < 6, `trang nặng: batch bị cắt theo BYTE (nhận ${result.pages.length}/6)`);
  ok(result.rejected.length > 0 && result.rejected.every((r) => r.reason), 'mọi trang bị loại đều có lý do đi kèm');
}

{
  // PHẦN E: KHÔNG còn "loại âm thầm". Trang sai MIME vẫn bị loại nhưng PHẢI xuất hiện trong rejected[].
  const { makePng } = require('./_imageFixtures');
  const good = makePng(64);
  const result = validateSourceVisionBody({ pages: [{ page: 3, mediaType: 'image/png', base64: good }, { page: 4, mediaType: 'application/x-evil', base64: good }] });
  ok(result.pages.length === 1 && result.pages[0].page === 3, 'trang hợp lệ còn lại vẫn được xử lý, KHÔNG chặn cả batch');
  ok(result.rejected.length === 1 && result.rejected[0].page === 4 && result.rejected[0].reason === 'image_type_unsupported',
    'trang bị loại được BÁO CÁO kèm lý do (không im lặng)');
}

{
  // PHẦN G: nhãn MIME nói PNG nhưng byte là JPEG -> từ chối, không đẩy binary lạ vào vision.
  const { makeJpeg } = require('./_imageFixtures');
  const result = validateSourceVisionBody({ pages: [
    { page: 1, mediaType: 'image/jpeg', base64: makeJpeg(64) },
    { page: 2, mediaType: 'image/png', base64: makeJpeg(64) }
  ] });
  ok(result.pages.length === 1 && result.pages[0].page === 1, 'nhãn MIME sai lệch so với byte thật bị loại');
  ok(result.rejected[0].reason === 'image_mime_mismatch', 'lý do phải là mime_mismatch, không phải lý do chung chung');
}

console.log('\n== A6/A11: parseVisionJson() ==');

{
  const raw = JSON.stringify({ extractedText: 'Bài 1.7: Giải phương trình...', equations: ['x^2+1=0'], diagrams: [], confidence: 0.92 });
  const parsed = parseVisionJson(raw);
  ok(parsed && parsed.extractedText === 'Bài 1.7: Giải phương trình...', 'parse đúng JSON chuẩn (không code fence)');
  ok(Array.isArray(parsed.equations) && parsed.equations[0] === 'x^2+1=0', 'giữ đúng mảng equations');
  ok(parsed.confidence === 0.92, 'giữ đúng confidence');
}

{
  const raw = '```json\n' + JSON.stringify({ extractedText: 'nội dung', equations: [], diagrams: ['hình tam giác'], confidence: 0.5 }) + '\n```';
  const parsed = parseVisionJson(raw);
  ok(parsed && parsed.extractedText === 'nội dung', 'vẫn parse được dù model lỡ bọc ```json ... ``` (dặn không dùng nhưng vẫn phòng hờ)');
  ok(parsed.diagrams[0] === 'hình tam giác', 'giữ đúng mảng diagrams');
}

{
  ok(parseVisionJson('') === null, 'chuỗi rỗng -> null (không throw, không giả vờ có dữ liệu)');
  ok(parseVisionJson('đây không phải JSON, model trả lời lung tung') === null, 'text KHÔNG phải JSON hợp lệ -> null, route sẽ trả ok:false cho trang đó (mục A10: 1 trang lỗi không giả vờ đã đọc)');
}

{
  const parsed = parseVisionJson(JSON.stringify({ extractedText: 'ok', confidence: 5 })); // confidence ngoài range
  ok(parsed.confidence === 1, 'confidence ngoài range [0,1] bị clamp về 1 (không tin mù dữ liệu model trả)');
  ok(Array.isArray(parsed.equations) && parsed.equations.length === 0, 'thiếu field equations -> mặc định mảng rỗng, không throw');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
