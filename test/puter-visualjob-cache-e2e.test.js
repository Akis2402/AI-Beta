'use strict';

// ============================================================================================
// REGRESSION — Puter PHASE FINAL HARDENING: visualJob KHÔNG ĐƯỢC MẤT qua text cache / non-stream
// ============================================================================================
// Bug đã tìm thấy trong audit này (server/routes/chat.js):
//   - donePayload/jsonDonePayload/finalJsonPayload/directDonePayload chưa bao giờ set `.visualJob`
//     (chỉ có `.visuals`/`.visualStatus`) -> giá trị bị cache vào tokenEconomy L1/L2 KHÔNG mang
//     visualJob -> 1 cache-hit sau đó (kể cả JSON non-stream) mất hoàn toàn khả năng tạo ảnh Puter.
//   - Nhánh cache-hit SSE chỉ gửi "done", không gửi lại sự kiện "visual:request" -> ngay cả khi
//     donePayload có visualJob, client (chỉ lắng nghe đúng 1 event "visual:request") cũng không
//     làm gì với nó.
// Test này dựng server thật (server/app.js), stub `global.fetch` để trả lời AI giả lập, rồi:
//   1. Gửi request stream:true, stage:'approach', settings.visual:'always' với câu hỏi CHẮC CHẮN
//      cần hình ("Vẽ đồ thị...") -> phải có event "visual:request" (renderer:'puter_image').
//   2. Gửi Y HỆT request đó lần 2 -> "done" phải là cache hit (fromCache:true) NHƯNG event
//      "visual:request" vẫn phải xuất hiện lần nữa (đây chính là bug §3 mô tả).
//   3. Gửi 1 request khác với stream:false (JSON non-stream) -> response JSON phải có
//      `visualJob.renderer === 'puter_image'` (bug §4).
// ============================================================================================

require('./_depGuard').requireDeps(['express', 'dotenv'], 'puter-visualjob-cache-e2e.test.js');

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-test-visualjob-e2e';
process.env.ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-test-model';
// Không set PUTER_VISUAL_MODE -> mặc định 'client_primary' (đúng cấu hình production).
delete process.env.PUTER_VISUAL_MODE;

const assert = require('assert');
const http = require('http');

const results = [];
function record(name, pass, error) { results.push({ name, pass, error }); }

// Câu trả lời cố định, đủ dài để qua completeness check, có nội dung hình học rõ ràng để
// decisionEngine (userPreference:'always' + query có "vẽ đồ thị") chắc chắn shouldGenerateImage=true.
const ANSWER_TEXT = [
  '## Tóm tắt đề bài',
  'Vẽ đồ thị hàm số y = x^2 và nêu các điểm đặc biệt.',
  '## Hướng giải',
  '- Hàm số y = x^2 là parabol đỉnh tại gốc toạ độ O(0,0), bề lõm quay lên trên.',
  '- Trục đối xứng là trục Oy (x = 0).',
  '- Khi x tăng từ 0, y tăng theo x^2; hàm số đồng biến trên (0; +∞) và nghịch biến trên (-∞; 0).',
  '- Một vài điểm đặc biệt: (0,0), (1,1), (-1,1), (2,4), (-2,4).',
  '## Kết luận',
  'Đồ thị là một parabol đối xứng qua trục Oy, đỉnh tại gốc toạ độ.'
].join('\n');

function stubFetch() {
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/v1/models')) {
      return {
        ok: true, status: 200,
        json: async () => ({ data: [{ id: process.env.ANTHROPIC_MODEL, type: 'model' }] }),
        text: async () => ''
      };
    }
    if (!u.includes('/v1/messages')) {
      return { ok: false, status: 404, text: async () => 'not found', json: async () => ({}) };
    }
    const events = [
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: ANSWER_TEXT } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 200 } })}\n\n`
    ].join('');
    const bytes = Buffer.from(events, 'utf8');
    return {
      ok: true, status: 200,
      body: {
        getReader() {
          let sent = false;
          return {
            read: async () => (sent ? { done: true } : (sent = true, { done: false, value: bytes })),
            releaseLock() {}
          };
        },
        [Symbol.asyncIterator]: async function* () { yield bytes; }
      },
      text: async () => events,
      json: async () => ({ content: [{ type: 'text', text: ANSWER_TEXT }], stop_reason: 'end_turn', usage: { input_tokens: 50, output_tokens: 200 } })
    };
  };
}

function postChat(port, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function parseSse(raw) {
  const out = [];
  raw.split('\n\n').forEach((block) => {
    const ev = (block.match(/^event:\s*(.+)$/m) || [])[1];
    const dt = (block.match(/^data:\s*(.+)$/m) || [])[1];
    if (!ev) return;
    let parsed = null;
    try { parsed = dt ? JSON.parse(dt) : null; } catch (e) { parsed = null; }
    out.push({ event: ev.trim(), data: parsed });
  });
  return out;
}

(async function main() {
  stubFetch();
  const app = require('../server/app');
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // TEST DRIFT ĐÃ SỬA (V6.17.5 — fixture, KHÔNG phải production):
  // Fixture cũ dùng 'Vẽ đồ thị hàm số y = x^2 ...'. Câu đó nằm ĐÚNG trong tập mà Hybrid Visual
  // Engine dựng được bằng SVG TẤT ĐỊNH (0 token, 0 lệnh gọi image model) nên
  // visualDeterminationEngine trả visualType:'svg', renderer:'deterministic_svg' — KHÔNG BAO GIỜ
  // là 'puter_image'. Hành vi đó là CHỦ ĐÍCH và đang được khoá bởi hai test khác đang PASS:
  //   test/visual-system.test.js       : ['Vẽ đồ thị hàm số y = x^2 - 2x - 3', 'math'] -> 'svg'
  //   test/hybrid-svg-engine.test.js   : '... bằng AI' -> nhánh ảnh AI (WANT_AI_RE)
  // Vì vậy fixture cũ fail ở TẦNG QUYẾT ĐỊNH RENDERER, chưa bao giờ chạm tới thứ test này muốn
  // kiểm (cache/visualJob). Thêm "bằng AI" để request thực sự đi nhánh Puter client-primary —
  // KHÔNG hạ chuẩn production, không ép SVG thành ảnh AI.
  const visualBody = {
    query: 'Vẽ bằng AI hình minh hoạ đồ thị hàm số y = x^2 và trình bày các điểm đặc biệt của parabol này.',
    stage: 'approach', stream: true, deepThinking: false, crossCheck: false,
    settings: { lang: 'Tiếng Việt', detail: 'tiêu chuẩn', school: 'thpt', grade: '10', visual: 'always' }
  };

  let firstVisualId = null;

  // ---------- 1. Lần đầu (không cache): phải có sự kiện visual:request, renderer puter_image ----------
  try {
    const res = await postChat(port, visualBody);
    const events = parseSse(res.raw);
    const err = events.find((e) => e.event === 'error');
    assert.ok(!err, 'không được lỗi: ' + JSON.stringify(err && err.data));
    const done = events.find((e) => e.event === 'done');
    assert.ok(done, 'phải có sự kiện done');
    assert.ok(!done.data.fromCache, 'lần đầu KHÔNG được là cache hit');
    const visReq = events.find((e) => e.event === 'visual:request');
    assert.ok(visReq, 'phải có sự kiện visual:request (client-primary Puter job)');
    assert.strictEqual(visReq.data.renderer, 'puter_image', 'renderer phải là puter_image');
    assert.ok(visReq.data.visualId, 'job phải có visualId');
    assert.ok(visReq.data.prompt && visReq.data.prompt.length > 0, 'job phải có prompt để client gọi puter.ai.txt2img()');
    firstVisualId = visReq.data.visualId;
    record('1. Request đầu: SSE có visual:request (puter_image)', true);
  } catch (e) { record('1. Request đầu: SSE có visual:request (puter_image)', false, e.message); }

  // ---------- 2. Y HỆT request đó lần 2: phải là cache hit, NHƯNG vẫn phải có visual:request ----------
  try {
    const res = await postChat(port, visualBody);
    const events = parseSse(res.raw);
    const done = events.find((e) => e.event === 'done');
    assert.ok(done, 'phải có done ở lần lặp lại');
    assert.ok(done.data.fromCache, 'lần 2 (y hệt lần 1) PHẢI là cache hit — nếu test này tự fail nghĩa là cache đang bị bypass, không phải bug đang kiểm');
    const visReq = events.find((e) => e.event === 'visual:request');
    assert.ok(visReq, 'BUG §3: text cache hit KHÔNG ĐƯỢC làm mất visual — phải vẫn có visual:request');
    assert.strictEqual(visReq.data.renderer, 'puter_image');
    assert.strictEqual(visReq.data.visualId, firstVisualId, 'cache hit phải trả lại ĐÚNG job đã cache (cùng visualId/fingerprint) để client tự dedupe qua IndexedDB');
    record('2. Text cache hit VẪN phát visual:request (không mất hình vì cache) — BUG §3 đã vá', true);
  } catch (e) { record('2. Text cache hit VẪN phát visual:request (không mất hình vì cache) — BUG §3 đã vá', false, e.message); }

  // ---------- 3. JSON non-stream (stream:false) phải mang visualJob trực tiếp trong response ----------
  try {
    const jsonBody = {
      ...visualBody, stream: false,
      query: 'Vẽ bằng AI hình minh hoạ đồ thị hàm số y = 2x^2 - 1 và trình bày các điểm đặc biệt của parabol này.'
    };
    const res = await postChat(port, jsonBody);
    assert.strictEqual(res.status, 200, 'JSON non-stream phải trả 200: ' + res.raw.slice(0, 300));
    const data = JSON.parse(res.raw);
    assert.ok(data.visualJob, 'BUG §4: JSON non-stream phải mang visualJob (trước đây chỉ có visuals:[] rỗng)');
    assert.strictEqual(data.visualJob.renderer, 'puter_image');
    assert.ok(data.visualJob.prompt, 'visualJob JSON phải có prompt');
    record('3. JSON non-stream (stream:false) mang visualJob — BUG §4 đã vá', true);
  } catch (e) { record('3. JSON non-stream (stream:false) mang visualJob — BUG §4 đã vá', false, e.message); }

  server.close();

  console.log('\n== Puter visualJob / text-cache / non-stream regression ==');
  results.forEach((r) => console.log(`  ${r.pass ? 'ok  ' : 'FAIL'} - ${r.name}${r.error ? '\n        ' + r.error : ''}`));
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
