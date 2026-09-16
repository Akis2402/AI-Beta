'use strict';

// PROMPT V5 — REGRESSION cho các bất biến token economy (PHẦN FC).
// Mỗi test khoá một con đường cụ thể mà token từng bị đốt, không phải kiểm "đã tối ưu" chung chung.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { routeIntent, extractUrls, INTENT } = require('../server/utils/intentRouter');
const { normalizeQuery, buildQueryFingerprint, normalizeUrl } = require('../server/utils/queryFingerprint');
const aiBudget = require('../server/utils/aiCallBudget');
const singleFlight = require('../server/utils/singleFlight');
const planner = require('../server/utils/imageBudgetPlanner');
const ws = require('../server/utils/source/sourceWorkingSet');
const web = require('../server/utils/source/webSource');
const yt = require('../server/utils/source/youtubeSource');
const caption = require('../server/utils/visual/deterministicCaption');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok  - ' + name); passed++; }
  catch (e) { console.log(' FAIL - ' + name + '\n        ' + e.message); failed++; }
}

(async function main() {
  console.log('\n== INVARIANT 1-3: image-only không kéo theo nguồn, không kéo theo lệnh gọi phụ ==');

  await test('INV1: "tạo hình X" + PDF 134 trang đang mở -> source calls = 0', () => {
    const r = routeIntent({ query: 'Tạo cho tôi hình ảnh cấu tạo cơ thể con người', activeSources: [{ id: 'pdf134' }] });
    assert.strictEqual(r.intent, INTENT.IMAGE_ONLY);
    assert.strictEqual(r.usesSource, false, 'nguồn đang active KHÔNG phải lý do để đọc nguồn');
    assert.strictEqual(r.needs.sourceRetrieval, false);
    assert.strictEqual(r.needs.sourceVision, false);
    assert.strictEqual(r.needs.citation, false);
  });

  await test('INV2: image-only -> academic answer/completeness/continuation = 0', () => {
    const r = routeIntent({ query: 'Vẽ hình ảnh núi lửa' });
    assert.strictEqual(r.needs.academicAnswer, false);
    assert.strictEqual(r.needs.completeness, false);
    assert.strictEqual(r.needs.continuation, false);
  });

  await test('INV3: chú thích mặc định deterministic (0 token), model chỉ khi bật cờ', () => {
    delete process.env.IMAGE_CAPTION_MODEL;
    assert.strictEqual(caption.captionModelEnabled(), false);
    const c = caption.buildDeterministicCaption({ topic: 'cấu tạo tế bào', language: 'Tiếng Việt', subjectId: 'biology' });
    assert.ok(c.text.includes('cấu tạo tế bào') && c.deterministic === true);
    process.env.IMAGE_CAPTION_MODEL = '1';
    assert.strictEqual(caption.captionModelEnabled(), true);
    delete process.env.IMAGE_CAPTION_MODEL;
  });

  await test('image-only CÓ trỏ tài liệu ("theo trang 21") thì vẫn dùng nguồn — không cắt nhầm', () => {
    const r = routeIntent({ query: 'Vẽ lại hình ở trang 21 của tài liệu', activeSources: [{ id: 'pdf' }] });
    assert.strictEqual(r.imageOnly, true);
    assert.strictEqual(r.usesSource, true, 'cắt nguồn ở đây sẽ làm hỏng chính yêu cầu của người dùng');
  });

  await test('chat.js cắt contexts/sourceImages/history NGAY tại gốc cho image-only, và GHI LẠI đã cắt gì', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'chat.js'), 'utf8');
    assert.ok(/earlyExitTelemetry/.test(src) && /droppedContexts/.test(src),
      'PHẦN CX: bỏ dữ liệu phải có telemetry lý do, không im lặng');
    const iEarly = src.indexOf('input.contexts = [];');
    const iRetrieve = src.indexOf('buildCitationIndex(input.contexts)');
    assert.ok(iEarly > 0 && iEarly < iRetrieve, 'cắt phải xảy ra TRƯỚC khi công việc chuẩn bị nguồn chạy');
  });

  console.log('\n== PHẦN D/DY: ngân sách lệnh gọi AI ==');

  await test('baseline image-only = 1; lệnh gọi caption thêm bị đánh dấu vượt baseline', () => {
    const b = aiBudget.createCallBudget({ intent: 'IMAGE_ONLY' });
    b.record(aiBudget.PURPOSE.IMAGE_GENERATION);
    const snap1 = b.snapshot();
    assert.strictEqual(snap1.aiCallCount, 1);
    assert.strictEqual(snap1.aiCallsOverBaseline, 0);
    b.record(aiBudget.PURPOSE.CAPTION);
    assert.strictEqual(b.snapshot().aiCallsOverBaseline, 1);
  });

  await test('lệnh gọi có điều kiện mà KHÔNG nêu lý do -> bị đánh dấu unjustified', () => {
    const b = aiBudget.createCallBudget({ intent: 'SOURCE_QUERY' });
    b.record(aiBudget.PURPOSE.ANSWER);
    b.record(aiBudget.PURPOSE.JUDGE);
    b.record(aiBudget.PURPOSE.CONTINUATION, { reason: 'hard_incomplete: thiếu mục Kết luận' });
    const s = b.snapshot();
    assert.strictEqual(s.aiCallsUnjustified, 1, 'judge không lý do phải lộ ra trong telemetry');
    assert.strictEqual(s.aiCallCount, 3);
  });

  console.log('\n== PHẦN H/I: normalize + fingerprint ==');

  await test('các biến thể cách viết tương đương -> CÙNG fingerprint', () => {
    const variants = ['Giải bài 1.9', 'giải  Bài 1.9 ', 'Giải bài1.9.', 'GIẢI BÀI 1 . 9'];
    const fps = variants.map((q) => buildQueryFingerprint({ query: q, subject: 'math' }));
    assert.strictEqual(new Set(fps).size, 1, 'cùng câu hỏi mà khác khoá = cache không bao giờ hit');
  });

  await test('câu hỏi KHÁC NGHĨA -> KHÁC fingerprint (không được gộp nhầm)', () => {
    const a = buildQueryFingerprint({ query: 'Giải bài 1.9', subject: 'math' });
    const b = buildQueryFingerprint({ query: 'Giải bài 1.10', subject: 'math' });
    const c = buildQueryFingerprint({ query: 'Giải bài 1.9', subject: 'physics' });
    assert.strictEqual(new Set([a, b, c]).size, 3);
  });

  await test('fingerprint đổi khi phiên bản nguồn đổi (PHẦN DK: không dùng lại câu trả lời cũ)', () => {
    const a = buildQueryFingerprint({ query: 'x', sourceVersion: 'v1' });
    const b = buildQueryFingerprint({ query: 'x', sourceVersion: 'v2' });
    assert.notStrictEqual(a, b);
  });

  await test('URL chuẩn hoá: bỏ tracking/fragment/www, giữ tham số mang nghĩa', () => {
    assert.strictEqual(normalizeUrl('https://www.abc.com/a/?utm_source=x&id=7#top'), 'https://abc.com/a?id=7');
    assert.strictEqual(normalizeQuery('xem https://www.abc.com/a/?utm_source=x'), 'xem https://abc.com/a');
  });

  console.log('\n== PHẦN CB/CC/CD: single-flight ==');

  await test('3 caller cùng khoá -> đúng 1 lần thực thi', async () => {
    singleFlight._resetForTest();
    let runs = 0;
    const job = () => new Promise((r) => setTimeout(() => { runs += 1; r(runs); }, 10));
    const out = await Promise.all([singleFlight.run('k', job), singleFlight.run('k', job), singleFlight.run('k', job)]);
    assert.strictEqual(runs, 1, 'cache stampede: 3 lệnh gọi ngoài cho 1 kết quả');
    assert.deepStrictEqual(out, [1, 1, 1]);
  });

  await test('khoá khác nhau vẫn chạy riêng (không gộp nhầm dữ liệu)', async () => {
    singleFlight._resetForTest();
    let runs = 0;
    const job = () => Promise.resolve(++runs);
    await Promise.all([singleFlight.run('a', job), singleFlight.run('b', job)]);
    assert.strictEqual(runs, 2);
  });

  console.log('\n== PHẦN T/U/V: ngân sách ảnh ==');

  await test('INV8: ảnh trùng fingerprint -> KHÔNG gửi hai lần', () => {
    const b64 = Buffer.alloc(64, 1).toString('base64');
    const r = planner.planImages([
      { id: 'a', base64: b64, width: 800, height: 900 },
      { id: 'b', base64: b64, width: 800, height: 900 }
    ]);
    assert.strictEqual(r.selected.length, 1);
    assert.deepStrictEqual(r.duplicates, [{ id: 'b', sameAs: 'a' }]);
  });

  await test('ảnh nhiều chữ giữ độ phân giải cao, ảnh trang trí bị hạ (không giảm đều tay)', () => {
    const r = planner.planImages([
      { id: 'page', base64: 'x', width: 1200, height: 1600, role: 'source_page' },
      { id: 'deco', base64: 'y', width: 1200, height: 1600, role: 'decorative' }
    ]);
    const byId = Object.fromEntries(r.plan.map((p) => [p.id, p]));
    assert.strictEqual(byId.page.tier, 'A');
    assert.ok(byId.page.maxEdge > byId.deco.maxEdge, 'hạ độ phân giải ảnh đề bài = model đọc sai đề');
  });

  await test('vượt ngân sách: HẠ ĐỘ PHÂN GIẢI trước, chỉ bỏ ảnh khi không còn cách nào', () => {
    const imgs = Array.from({ length: 4 }, (_, i) => ({ id: 'i' + i, base64: String(i), width: 2000, height: 2000, role: i === 0 ? 'source_page' : 'decorative' }));
    const soft = planner.planImages(imgs, { tokenBudget: 3000 });
    assert.strictEqual(soft.selected.length, 4, 'còn hạ được độ phân giải thì KHÔNG được bỏ ảnh của người dùng');
    // Ảnh tier D vốn đã ở mức thấp nhất nên không có gì để hạ; điều phải đúng là ảnh NẶNG bị hạ và
    // không ảnh nào còn giữ mức cao nhất khi ngân sách đang căng.
    assert.ok(soft.selected.some((s2) => s2.downscaled), 'ảnh nặng phải được hạ độ phân giải');
    assert.ok(soft.selected.every((s2) => s2.maxEdge <= 1024));
    assert.ok(soft.estimatedTokens <= 3000);

    const hard = planner.planImages(imgs, { tokenBudget: 800 });
    assert.ok(hard.dropped.length > 0 && hard.dropped.every((d) => d.reason), 'bỏ ảnh phải luôn kèm lý do');
    assert.ok(hard.selected.some((s2) => s2.id === 'i0'), 'ảnh quan trọng nhất phải được giữ lại sau cùng');
    assert.ok(hard.selected.every((s2) => s2.tier !== 'D') || hard.selected.length === 1,
      'ảnh trang trí phải bị bỏ trước ảnh nội dung');
  });

  await test('thứ tự ảnh của người dùng được giữ nguyên (PHẦN X)', () => {
    const r = planner.planImages([{ id: 'a', base64: '1' }, { id: 'b', base64: '2' }, { id: 'c', base64: '3' }]);
    assert.deepStrictEqual(r.selected.map((s) => s.id), ['a', 'b', 'c']);
    assert.strictEqual(planner.imageMarker(2), '[IMG2]');
  });

  console.log('\n== PHẦN M/DV: source working set ==');

  const evidence = [
    { sourceId: 'pdf1', page: 9, evidenceId: 'e1', text: 'Bài 1.9 — nội dung thật' },
    { sourceId: 'pdf1', page: 10, evidenceId: 'e2', text: 'Bài 1.10 — nội dung thật' }
  ];

  await test('working set bị FREEZE thật (không phải quy ước)', () => {
    const set = ws.createWorkingSet({ requestId: 'r', query: 'Giải bài 1.9', evidence, requirementLabels: ['1.9', '1.10'] });
    assert.ok(Object.isFrozen(set) && Object.isFrozen(set.selectedEvidence));
    assert.throws(() => { set.selectedEvidence.push({}); });
  });

  await test('INV5: continuation dùng lại working set -> retrieval calls vẫn = 1', () => {
    const set = ws.createWorkingSet({ requestId: 'r', query: 'q', evidence });
    const tracker = ws.createReuseTracker(set);
    tracker.use('answer'); tracker.use('continuation'); tracker.use('failover');
    const snap = tracker.snapshot();
    assert.strictEqual(snap.sourceRetrievalCalls, 1);
    assert.strictEqual(snap.workingSetReused, true);
    assert.strictEqual(snap.workingSetUses, 3);
  });

  await test('PHẦN Q: coverage matrix biết nhãn nào CHƯA có bằng chứng', () => {
    const m = ws.coverageMatrix(evidence, ['1.9', '1.10', '1.11']);
    assert.strictEqual(m.covered, 2);
    assert.strictEqual(m.rows.find((r) => r.label === '1.11').covered, false);
  });

  await test('PHẦN DW: mở rộng tạo VERSION MỚI, bản cũ không bị mutate', () => {
    const v1 = ws.createWorkingSet({ requestId: 'r', query: 'q', evidence, requirementLabels: ['1.9', '1.10', '1.11'] });
    assert.strictEqual(v1.completeForQuery, false);
    const v2 = ws.expandWorkingSet(v1, [{ sourceId: 'pdf1', page: 11, evidenceId: 'e3', text: 'Bài 1.11 — nội dung' }], 'missing_requirement');
    assert.strictEqual(v2.version, 2);
    assert.strictEqual(v2.selectedEvidence.length, 3);
    assert.strictEqual(v1.selectedEvidence.length, 2, 'luồng đang chạy trên v1 phải thấy dữ liệu bất biến');
    assert.strictEqual(v2.completeForQuery, true);
  });

  await test('INV7: cùng evidence -> cùng evidenceFingerprint (không reindex)', () => {
    const a = ws.createWorkingSet({ requestId: 'r1', query: 'q', evidence });
    const b = ws.createWorkingSet({ requestId: 'r2', query: 'q', evidence });
    assert.strictEqual(a.evidenceFingerprint, b.evidenceFingerprint);
  });

  console.log('\n== PHẦN AK/AM/CN: web ==');

  await test('HTML -> text sạch: bỏ script/nav/footer, giữ nội dung', () => {
    const { title, text } = web.extractReadableText(
      '<html><head><title>T</title></head><body><nav>menu</nav><script>evil()</script><article><p>Nội dung thật sự của bài viết.</p></article><footer>©</footer></body></html>'
    );
    assert.strictEqual(title, 'T');
    assert.ok(text.includes('Nội dung thật'));
    ['menu', 'evil', '©'].forEach((junk) => assert.ok(!text.includes(junk), `rác "${junk}" không được vào prompt`));
    assert.ok(!/</.test(text), 'HTML thô không bao giờ được gửi cho model');
  });

  await test('chunk theo đoạn, deterministic (chạy 2 lần ra kết quả giống hệt)', () => {
    const text = Array.from({ length: 12 }, (_, i) => `Đoạn ${i} `.repeat(30)).join('\n\n');
    const a = web.chunkText(text);
    const b = web.chunkText(text);
    assert.deepStrictEqual(a, b);
    assert.ok(a.length > 1 && a.every((c) => c.text.length <= 2000));
  });

  await test('web: chặn non-https và URL hỏng trước khi chạm mạng', async () => {
    assert.strictEqual((await web.fetchWebSource('http://abc.com')).reason, 'https_required');
    assert.strictEqual((await web.fetchWebSource('not a url')).reason, 'invalid_url');
  });

  console.log('\n== PHẦN AO/AP/FC-11: youtube ==');

  await test('parse videoId từ mọi dạng URL; URL sai -> null (không đoán)', () => {
    ['https://youtu.be/dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=9',
      'https://m.youtube.com/shorts/dQw4w9WgXcQ', 'https://music.youtube.com/watch?v=dQw4w9WgXcQ']
      .forEach((u) => assert.strictEqual(yt.parseVideoId(u), 'dQw4w9WgXcQ', u));
    ['https://youtube.com/watch?v=short', 'https://vimeo.com/123', ''].forEach((u) => assert.strictEqual(yt.parseVideoId(u), null, u));
  });

  await test('transcript -> chunk theo MỐC THỜI GIAN có locator (citation trỏ được tới phút)', () => {
    const cues = yt.parseTranscriptXml('<t><text start="0" dur="4">một</text><text start="200" dur="4">hai</text></t>');
    const chunks = yt.chunkTranscript(cues);
    assert.strictEqual(chunks.length, 2);
    assert.strictEqual(chunks[1].locator, '3:20–3:24');
  });

  await test('INV11: không có transcript -> INCOMPLETE + thông điệp thẳng thắn, KHÔNG bịa nội dung', async () => {
    const res = await yt.fetchYoutubeSource('https://youtu.be/dQw4w9WgXcQ', { languages: [], timeoutMs: 1 });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 'INCOMPLETE');
    assert.strictEqual(res.transcriptAvailable, false);
    assert.ok(/chưa đọc được/i.test(res.userMessage));
  });

  await test('YouTube dùng cùng lớp SSRF với web (không có đường fetch riêng không kiểm soát)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'utils', 'source', 'youtubeSource.js'), 'utf8');
    assert.ok(/safeHttp\.fetchPinned/.test(src));
    assert.ok(!/await fetch\(/.test(src), 'không được có fetch() trần bỏ qua kiểm địa chỉ nội bộ');
  });

  await test('URL lặp lại trong cùng câu hỏi chỉ tính là MỘT nguồn (PHẦN BH)', () => {
    const urls = extractUrls('xem https://a.com/x và https://a.com/x/ và https://a.com/x?utm_source=z');
    assert.strictEqual(urls.length, 1);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
