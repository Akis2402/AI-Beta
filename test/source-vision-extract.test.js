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
  const tinyPngBase64 = Buffer.alloc(200, 1).toString('base64'); // đủ dài để qua check độ dài, không cần là PNG thật cho test validate
  const pages = Array.from({ length: 15 }, (_, i) => ({ page: i + 1, mediaType: 'image/png', base64: tinyPngBase64 }));
  const result = validateSourceVisionBody({ pages });
  ok(result.pages.length === 8, `nhận 15 trang trong 1 request nhưng bị CẮT còn đúng 8 (MAX_VISION_BATCH_PAGES, mục A6 "không nổ token 1 request") — nhận được ${result.pages.length}`);
  ok(result.pages[0].page === 1 && result.pages[7].page === 8, 'giữ đúng 8 trang ĐẦU tiên theo thứ tự gửi lên');
}

{
  const result = validateSourceVisionBody({ pages: [{ page: 3, mediaType: 'image/png', base64: 'AAAA' }, { page: 4, mediaType: 'application/x-evil', base64: 'AAAA' }] });
  ok(result.pages.length === 1 && result.pages[0].page === 3, 'trang có mediaType không hợp lệ bị loại âm thầm, KHÔNG chặn cả batch (giữ đúng các trang hợp lệ còn lại)');
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
