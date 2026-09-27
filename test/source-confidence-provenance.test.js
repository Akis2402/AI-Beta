'use strict';

// ============================================================================================
// MỤC XXX (rework notebook) — SOURCE CONFIDENCE cho transcript YouTube
// ============================================================================================
// Bug đã sửa: comment cũ trong youtubeSource.js khẳng định field `asrGenerated` "dùng cho phần
// trích nguồn ở promptBuilder", nhưng field đó KHÔNG hề được đọc lại ở bất kỳ đâu (promptBuilder.js,
// validators.js, app.js đều không có `asrGenerated`) — mọi chunk URL source, dù là phụ đề thật hay
// transcript Gemini tự nhận dạng (ASR), đều bị app.js hard-code `extractionMethod: 'text'` khi build
// evidence, nên citation hiển thị y hệt nhau dù độ tin cậy khác hẳn. Test dưới đây khoá lại: chunk
// PHẢI tự mang provenance đúng ('text' | 'asr'), và app.js/validators.js PHẢI tôn trọng nó thay vì
// hardcode hay vứt bỏ.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chunkTranscript } = require('../server/utils/source/youtubeSource');
const { validateChatBody } = require('../server/utils/validators');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  -', name); }
  catch (e) { failed++; console.log(' FAIL -', name, '\n       ', e.stack || e.message); }
}

function sampleCues() {
  return [
    { start: 0, duration: 4, text: 'Hôm nay ta học về dao động điều hòa.' },
    { start: 4, duration: 4, text: 'Chu kỳ là thời gian thực hiện một dao động toàn phần.' }
  ];
}

console.log('\n== chunkTranscript() stamp đúng extractionMethod theo nguồn ==');

test('1. mặc định (không truyền method) -> mọi chunk là \'text\' (phụ đề thật)', () => {
  const chunks = chunkTranscript(sampleCues());
  assert.ok(chunks.length > 0);
  chunks.forEach((c) => assert.strictEqual(c.extractionMethod, 'text'));
});

test('2. method:\'asr\' -> mọi chunk là \'asr\' (Gemini nghe audio, không phải phụ đề có sẵn)', () => {
  const chunks = chunkTranscript(sampleCues(), { method: 'asr' });
  assert.ok(chunks.length > 0);
  chunks.forEach((c) => assert.strictEqual(c.extractionMethod, 'asr'));
});

test('3. youtubeSource.js: nhánh ASR fallback thực sự truyền method:\'asr\' (không chỉ hàm hỗ trợ có khả năng)', () => {
  const src = read('server/utils/source/youtubeSource.js');
  assert.ok(/chunkTranscript\(mergedCues,\s*\{\s*\.\.\.opts,\s*method:\s*'asr'\s*\}\)/.test(src),
    'nhánh ASR (sau youtubeAsr.transcribeYouTubeWithGemini) phải gọi chunkTranscript với method:\'asr\'');
});

console.log('\n== validators.js — \'asr\' là extractionMethod hợp lệ, đi qua allow-list nguyên vẹn ==');

test('4. context với extractionMethod:\'asr\' -> giữ nguyên (không bị rơi về \'unknown\')', () => {
  const out = validateChatBody({
    query: 'chu kỳ dao động là gì',
    contexts: [{
      doc: 'Video bài giảng', id: 1, text: 'nội dung transcript ASR',
      kind: 'youtube', sourceUrl: 'https://www.youtube.com/watch?v=abc123',
      timeStart: 10, timeEnd: 20, extractionMethod: 'asr', extractionStatus: 'ok'
    }]
  });
  assert.strictEqual(out.contexts[0].extractionMethod, 'asr');
});

test('5. extractionMethod rác (không nằm trong allow-list) -> rơi về \'unknown\', không giữ giá trị lạ', () => {
  const out = validateChatBody({
    query: 'test', contexts: [{ doc: 'D', id: 1, text: 'x', extractionMethod: 'gpt-said-so' }]
  });
  assert.strictEqual(out.contexts[0].extractionMethod, 'unknown');
});

console.log('\n== app.js — client tôn trọng provenance thật, không hardcode \'text\' cho mọi chunk URL ==');

test('6. collectAvailableEvidence() đọc extractionMethod TỪ CHUNK, không hardcode \'text\'', () => {
  const app = read('public/js/app.js');
  assert.ok(app.includes("extractionMethod: ch.extractionMethod || 'text'"),
    'phải là ch.extractionMethod || \'text\' (tôn trọng provenance thật của chunk), không phải hardcode "text"');
  assert.ok(!/out\.push\(\{[^}]*extractionMethod: 'text',\s*\n\s*extractionStatus: 'ok',\s*\n\s*\/\/ V6/.test(app),
    'không được còn hardcode extractionMethod:\'text\' ngay trước comment "V6 — metadata locator"');
});

test('7. renderCitations() cảnh báo rõ khi citation YouTube đến từ ASR', () => {
  const app = read('public/js/app.js');
  const i = app.indexOf("c.kind === 'youtube'");
  assert.ok(i > 0);
  const block = app.slice(i, i + 700);
  assert.ok(/extractionMethod === 'asr'/.test(block), 'renderCitations phải kiểm tra extractionMethod asr cho nhánh youtube');
  assert.ok(/phụ đề tự nhận dạng/.test(block), 'phải có ghi chú tiếng Việt cảnh báo transcript tự nhận dạng');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
