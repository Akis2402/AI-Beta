'use strict';

// MỤC IV/XIX/XXIV/LV (rework notebook) — server/utils/source/notebookGuide.js
// Khoá đúng các bất biến bắt buộc: 1 lệnh gọi AI/guide (không 5 lệnh cho 5 phần), nén synopsis
// DETERMINISTIC trước khi gọi AI (không AI phụ để nén), cache theo fingerprint (không sourceId) +
// extractionVersion + language, singleFlight chống 2 request đồng thời sinh trùng 1 guide, và
// guide rỗng/parse lỗi KHÔNG được cache/trả như thành công (mục XXIX "không bao giờ giả mạo source").

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  GUIDE_VERSION, LIMITS, BRIEF_KEYS,
  computeSourceStats, buildSynopsis, parseGuideJson, isEmptyGuide, generateNotebookGuide
} = require('../server/utils/source/notebookGuide');
const { validateNotebookGuideBody, ValidationError } = require('../server/utils/validators');
const sourceContentCache = require('../server/utils/source/sourceContentCache');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ok  - ' + name); passed++; }
  catch (e) { console.log(' FAIL - ' + name + '\n        ' + e.stack); failed++; }
}
async function testAsync(name, fn) {
  try { await fn(); console.log('  ok  - ' + name); passed++; }
  catch (e) { console.log(' FAIL - ' + name + '\n        ' + e.stack); failed++; }
}

console.log('\n== computeSourceStats() — thuần, không AI ==');

test('1. đếm đúng totalChunks/totalChars/avgChunkChars', () => {
  const stats = computeSourceStats([{ text: 'aaaa' }, { text: 'bb' }]);
  assert.strictEqual(stats.totalChunks, 2);
  assert.strictEqual(stats.totalChars, 6);
  assert.strictEqual(stats.avgChunkChars, 3);
});

test('2. mảng rỗng -> 0, không throw', () => {
  assert.deepStrictEqual(computeSourceStats([]), { totalChunks: 0, totalChars: 0, avgChunkChars: 0 });
});

console.log('\n== buildSynopsis() — nén DETERMINISTIC, không AI ==');

test('3. vừa ngân sách -> ghép nguyên văn, sampled=false, coverageRatio=1', () => {
  const chunks = [{ text: 'một', locator: 'p1' }, { text: 'hai', locator: 'p2' }];
  const { synopsis, sampled, coverageRatio } = buildSynopsis(chunks, 1000);
  assert.strictEqual(sampled, false);
  assert.strictEqual(coverageRatio, 1);
  assert.ok(synopsis.includes('một') && synopsis.includes('hai'));
  assert.ok(synopsis.includes('[p1]') && synopsis.includes('[p2]'));
});

test('4. vượt ngân sách -> lấy mẫu (sampled=true), LUÔN giữ chunk đầu và chunk cuối', () => {
  const chunks = Array.from({ length: 50 }, (_, i) => ({ text: `chunk-${i}-`.repeat(30), chunkIndex: i + 1 }));
  const budget = 2000;
  const { synopsis, sampled, coverageRatio, includedChunks } = buildSynopsis(chunks, budget);
  assert.strictEqual(sampled, true);
  assert.ok(coverageRatio > 0 && coverageRatio < 1, `coverageRatio phải trong (0,1), nhận ${coverageRatio}`);
  assert.ok(includedChunks < chunks.length, 'phải lấy ít chunk hơn tổng số khi over-budget');
  assert.ok(synopsis.includes('chunk-0-'), 'phải giữ chunk ĐẦU tiên');
  assert.ok(synopsis.includes('chunk-49-'), 'phải giữ chunk CUỐI cùng');
});

test('5. deterministic — cùng input cho cùng output (không phụ thuộc Math.random/thời gian)', () => {
  const chunks = Array.from({ length: 30 }, (_, i) => ({ text: `nội dung đoạn ${i} `.repeat(20), chunkIndex: i + 1 }));
  const a = buildSynopsis(chunks, 1500);
  const b = buildSynopsis(chunks, 1500);
  assert.strictEqual(a.synopsis, b.synopsis);
  assert.strictEqual(a.coverageRatio, b.coverageRatio);
});

test('6. không có chunk hợp lệ -> synopsis rỗng, không throw', () => {
  const out = buildSynopsis([{ text: '' }, { text: '   ' }], 1000);
  assert.strictEqual(out.synopsis, '');
  assert.strictEqual(out.coverageRatio, 0);
});

console.log('\n== parseGuideJson() — chịu được model lỡ bọc code fence, KHÔNG bịa field thiếu ==');

test('7. JSON hợp lệ đầy đủ field -> parse đúng + clip theo LIMITS', () => {
  const longStr = 'x'.repeat(LIMITS.SUMMARY_CHARS + 500);
  const raw = JSON.stringify({
    summary: longStr,
    faq: [{ question: 'Q1?', answer: 'A1.' }],
    deepQuestions: ['Vì sao...?'],
    brief: { coreIdeas: ['ý 1'], formulas: [], definitions: [], misconceptions: [], keyData: [], conclusions: [] },
    topics: ['chủ đề A']
  });
  const guide = parseGuideJson(raw);
  assert.ok(guide);
  assert.strictEqual(guide.summary.length, LIMITS.SUMMARY_CHARS);
  assert.strictEqual(guide.faq.length, 1);
  assert.strictEqual(guide.faq[0].question, 'Q1?');
  assert.deepStrictEqual(guide.topics, ['chủ đề A']);
  BRIEF_KEYS.forEach((k) => assert.ok(Array.isArray(guide.brief[k]), `brief.${k} phải là mảng`));
});

test('8. model bọc ```json ... ``` dù đã dặn không dùng -> vẫn parse được', () => {
  const raw = '```json\n' + JSON.stringify({ summary: 'tóm tắt', faq: [], deepQuestions: [], brief: {}, topics: [] }) + '\n```';
  const guide = parseGuideJson(raw);
  assert.ok(guide);
  assert.strictEqual(guide.summary, 'tóm tắt');
});

test('9. JSON hỏng/không phải object -> null (KHÔNG trả object rỗng giả vờ hợp lệ)', () => {
  assert.strictEqual(parseGuideJson('không phải JSON'), null);
  assert.strictEqual(parseGuideJson('"chỉ là 1 chuỗi"'), null);
  assert.strictEqual(parseGuideJson(''), null);
  assert.strictEqual(parseGuideJson(null), null);
});

test('10. faq item thiếu question/answer -> bị loại, không giữ record hỏng', () => {
  const raw = JSON.stringify({ faq: [{ question: 'Q?' }, { answer: 'chỉ có answer' }, { question: 'Q2?', answer: 'A2' }] });
  const guide = parseGuideJson(raw);
  assert.strictEqual(guide.faq.length, 1);
  assert.strictEqual(guide.faq[0].question, 'Q2?');
});

console.log('\n== isEmptyGuide() ==');

test('11. mọi phần rỗng -> true (không cache/trả như thành công)', () => {
  const guide = parseGuideJson(JSON.stringify({ summary: '', faq: [], deepQuestions: [], brief: {}, topics: [] }));
  assert.strictEqual(isEmptyGuide(guide), true);
});

test('12. có ít nhất 1 phần có nội dung -> false', () => {
  const guide = parseGuideJson(JSON.stringify({ summary: 'có nội dung', faq: [], deepQuestions: [], brief: {}, topics: [] }));
  assert.strictEqual(isEmptyGuide(guide), false);
});

console.log('\n== validateNotebookGuideBody() — thuần, không I/O ==');

test('13. thiếu fingerprint -> ValidationError', () => {
  assert.throws(() => validateNotebookGuideBody({ chunks: [{ text: 'a' }] }), ValidationError);
});

test('14. thiếu chunks có nội dung -> ValidationError (không âm thầm sinh guide rỗng)', () => {
  assert.throws(() => validateNotebookGuideBody({ fingerprint: 'fp1', chunks: [] }), ValidationError);
  assert.throws(() => validateNotebookGuideBody({ fingerprint: 'fp1', chunks: [{ text: '   ' }] }), ValidationError);
});

test('15. input hợp lệ -> trim/clip đúng, giữ nguyên chunkIndex/locator', () => {
  const out = validateNotebookGuideBody({
    fingerprint: 'fp1', name: '  Tài liệu A  ', extractionVersion: 3, language: 'vi',
    chunks: [{ text: 'nội dung', locator: 'p1', chunkIndex: 1 }]
  });
  assert.strictEqual(out.fingerprint, 'fp1');
  assert.strictEqual(out.name, 'Tài liệu A');
  assert.strictEqual(out.chunks[0].locator, 'p1');
  assert.strictEqual(out.chunks[0].chunkIndex, 1);
});

console.log('\n== generateNotebookGuide() — cache + singleFlight, KHÔNG gọi AI thật (fake callWithFailover) ==');

function fakeInput(fp) {
  return {
    fingerprint: fp, name: 'Nguồn test', extractionVersion: 'v1', language: 'vi',
    chunks: [{ text: 'Định luật bảo toàn năng lượng phát biểu rằng năng lượng không tự sinh ra hoặc mất đi.', locator: 'p1' }]
  };
}
const FAKE_GUIDE_JSON = JSON.stringify({
  summary: 'Tóm tắt test.', faq: [{ question: 'Q?', answer: 'A.' }],
  deepQuestions: ['Vì sao?'], brief: { coreIdeas: ['ý chính'] }, topics: ['vật lý']
});

// PHẦN O (test harness trung thực, xem test/run-all.js): các test dưới đây là ASYNC — phải await
// TUẦN TỰ trong 1 IIFE rồi mới in tổng kết ở cuối file. Gọi testAsync() rời rạc không await (như một
// bản nháp trước đó của file này) khiến dòng tổng kết in ra TRƯỚC KHI các test async thật sự chạy
// xong — "N passed" khi đó là con số của các test ĐỒNG BỘ, không phải toàn bộ file, và vì Node vẫn
// giữ tiến trình sống nhờ timer/promise treo, các dòng "ok" async tiếp tục in SAU dòng tổng kết,
// trông như file "chạy xong rồi lại chạy tiếp" — chính triệu chứng harness không trung thực mà
// test/run-all.js đã ghi rõ ở đầu file đó.
(async () => {

await testAsync('16. gọi lần đầu -> ok:true, gọi callWithFailover ĐÚNG 1 lần, và có cache', async () => {
  sourceContentCache._resetForTest();
  let calls = 0;
  const fakeCall = async () => { calls += 1; return { text: FAKE_GUIDE_JSON }; };
  const result = await generateNotebookGuide(fakeInput('fp-cache-1'), [{ id: 'p1' }], { callWithFailover: fakeCall });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.guideVersion, GUIDE_VERSION);
  assert.strictEqual(calls, 1);
  assert.strictEqual(result.summary, 'Tóm tắt test.');
});

await testAsync('17. gọi lần 2 cùng fingerprint -> HIT CACHE, KHÔNG gọi lại AI (mục "read once, index once")', async () => {
  sourceContentCache._resetForTest();
  let calls = 0;
  const fakeCall = async () => { calls += 1; return { text: FAKE_GUIDE_JSON }; };
  const deps = { callWithFailover: fakeCall };
  const first = await generateNotebookGuide(fakeInput('fp-cache-2'), [{ id: 'p1' }], deps);
  const second = await generateNotebookGuide(fakeInput('fp-cache-2'), [{ id: 'p1' }], deps);
  assert.strictEqual(calls, 1, 'lần gọi thứ 2 phải hit cache, không gọi AI lại');
  assert.strictEqual(first.ok, true);
  assert.strictEqual(second.fromCache, true);
});

await testAsync('18. noCache:true (Regenerate) -> bỏ qua cache, gọi lại AI (mục LIX: regenerate = explicit action)', async () => {
  sourceContentCache._resetForTest();
  let calls = 0;
  const fakeCall = async () => { calls += 1; return { text: FAKE_GUIDE_JSON }; };
  const deps = { callWithFailover: fakeCall };
  await generateNotebookGuide(fakeInput('fp-cache-3'), [{ id: 'p1' }], deps);
  await generateNotebookGuide(fakeInput('fp-cache-3'), [{ id: 'p1' }], { ...deps, noCache: true });
  assert.strictEqual(calls, 2);
});

await testAsync('19. 2 request đồng thời cùng fingerprint -> singleFlight, chỉ 1 lệnh gọi AI thật sự', async () => {
  sourceContentCache._resetForTest();
  let calls = 0;
  const fakeCall = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 20));
    return { text: FAKE_GUIDE_JSON };
  };
  const deps = { callWithFailover: fakeCall };
  const input = fakeInput('fp-concurrent-1');
  const [a, b] = await Promise.all([
    generateNotebookGuide(input, [{ id: 'p1' }], deps),
    generateNotebookGuide(input, [{ id: 'p1' }], deps)
  ]);
  assert.strictEqual(calls, 1, 'singleFlight phải gộp 2 request đồng thời thành 1 lệnh gọi AI');
  assert.strictEqual(a.ok, true);
  assert.strictEqual(b.ok, true);
});

await testAsync('20. model trả JSON hỏng -> ok:false reason invalid_response_shape, KHÔNG cache (mục XXIX)', async () => {
  sourceContentCache._resetForTest();
  let calls = 0;
  const fakeCall = async () => { calls += 1; return { text: 'không phải JSON' }; };
  const deps = { callWithFailover: fakeCall };
  const input = fakeInput('fp-bad-1');
  const first = await generateNotebookGuide(input, [{ id: 'p1' }], deps);
  assert.strictEqual(first.ok, false);
  assert.strictEqual(first.reason, 'invalid_response_shape');
  const second = await generateNotebookGuide(input, [{ id: 'p1' }], deps);
  assert.strictEqual(calls, 2, 'kết quả lỗi không được cache — lần sau phải thử lại AI, không trả lỗi cache mãi mãi');
});

await testAsync('21. thiếu fingerprint/chunks/provider -> trả reason rõ ràng, không throw, không gọi AI', async () => {
  let calls = 0;
  const fakeCall = async () => { calls += 1; return { text: FAKE_GUIDE_JSON }; };
  const r1 = await generateNotebookGuide({ chunks: [{ text: 'a' }] }, [{ id: 'p1' }], { callWithFailover: fakeCall });
  assert.strictEqual(r1.reason, 'missing_fingerprint');
  const r2 = await generateNotebookGuide({ fingerprint: 'fp', chunks: [] }, [{ id: 'p1' }], { callWithFailover: fakeCall });
  assert.strictEqual(r2.reason, 'no_content');
  const r3 = await generateNotebookGuide(fakeInput('fp-x'), [], { callWithFailover: fakeCall });
  assert.strictEqual(r3.reason, 'no_provider');
  assert.strictEqual(calls, 0);
});

console.log('\n== Route /api/source/guide — kiểm tra TĨNH đã nối đúng module (cùng kiểu test route hiện có) ==');

const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'sourceVision.js'), 'utf8');

test('22. route file require notebookGuide.js', () => {
  assert.ok(/require\(['"]\.\.\/utils\/source\/notebookGuide['"]\)/.test(routeSrc));
});

// Greedy (không lazy `?`) CỐ Ý: handler gọi generateNotebookGuide({...}) có `});` RIÊNG của nó ở
// giữa thân hàm — match lazy sẽ dừng ở đó thay vì ở `});` đóng router.post thật sự. /guide là route
// CUỐI trong file (theo sau là module.exports, không còn `});` nào khác) nên greedy trong 1 cửa sổ
// đủ lớn vẫn dừng đúng chỗ, không "ăn" sang route khác.
test('23. POST /guide tồn tại, validate input + gọi generateNotebookGuide(), next(err) khi lỗi', () => {
  const m = /router\.post\(['"]\/guide['"][\s\S]{0,1200}\}\);/.exec(routeSrc);
  assert.ok(m, 'không tìm thấy handler POST /guide');
  assert.ok(/validateNotebookGuideBody\(req\.body\)/.test(m[0]));
  assert.ok(/generateNotebookGuide\(/.test(m[0]));
  assert.ok(/catch \(err\) \{\s*next\(err\);/.test(m[0]));
});

test('24. POST /guide qua acquireBackgroundSlot (background priority — không cạnh tranh CPU với /api/chat)', () => {
  const m = /router\.post\(['"]\/guide['"][\s\S]{0,1200}\}\);/.exec(routeSrc);
  assert.ok(/acquireBackgroundSlot\(/.test(m[0]));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
})();
