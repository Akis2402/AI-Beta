'use strict';

// ============================================================================================
// E2E — "Suy nghĩ sâu" phải HOÀN TẤT (PHẦN 33: deep thinking completion / long answer)
// ============================================================================================
// Đây là test QUAN TRỌNG NHẤT của toàn bộ đợt sửa: nó tái hiện ĐÚNG cơ chế đã gây ra lỗi
// "Câu trả lời chưa đầy đủ sau khi đã thử khôi phục — không thể coi là hoàn thành."
//
// Provider giả lập hành xử ĐÚNG như Anthropic thật:
//   - `max_tokens` là ngân sách DÙNG CHUNG cho thinking + văn bản hiển thị
//   - thinking tiêu đúng `thinking.budget_tokens`
//   - phần còn lại mới dành cho text; nếu không đủ để viết hết -> stop_reason = 'max_tokens'
//
// Với code CŨ (budget_tokens = 0.6 × max_tokens) mô hình chỉ còn 40% ngân sách cho câu trả lời nên
// luôn bị cắt. Với code MỚI (max_tokens = answerBudget + reasoningBudget) phần hiển thị được bảo
// toàn nguyên vẹn nên lượt đầu tiên đã đủ để kết thúc tự nhiên (stop_reason='end_turn').

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-test-e2e';
process.env.ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-test-model';

const assert = require('assert');
const http = require('http');

const results = [];
function record(name, pass, error) { results.push({ name, pass, error }); }

// ---------- Provider Anthropic GIẢ LẬP (SSE) ----------
// Mỗi "token" ~ 4 ký tự. Đây là chỗ mô phỏng ràng buộc thật đã sinh ra bug.
const CHARS_PER_TOKEN = 4;
const FULL_ANSWER_TOKENS = 900; // độ dài câu trả lời model "muốn" viết

let lastBody = null;
let callCount = 0;

function buildSseStream(body) {
  const maxTokens = body.max_tokens;
  const thinkingBudget = body.thinking ? body.thinking.budget_tokens : 0;
  // Ngân sách THỰC SỰ còn lại cho văn bản hiển thị — chính là con số mà bug cũ bóp xuống 28%.
  const visibleTokens = Math.max(0, maxTokens - thinkingBudget);
  const willComplete = visibleTokens >= FULL_ANSWER_TOKENS;
  const emitTokens = willComplete ? FULL_ANSWER_TOKENS : visibleTokens;

  const sentence = 'Ta xét bài toán và tính toán từng bước rõ ràng. ';
  let text = '';
  while (text.length < emitTokens * CHARS_PER_TOKEN) text += sentence;
  text = text.slice(0, emitTokens * CHARS_PER_TOKEN);
  if (willComplete) text += '\n\nVậy kết quả cuối cùng là 42.';

  const events = [];
  const CHUNK = 400;
  for (let i = 0; i < text.length; i += CHUNK) {
    events.push(`event: content_block_delta\ndata: ${JSON.stringify({
      type: 'content_block_delta', delta: { type: 'text_delta', text: text.slice(i, i + CHUNK) }
    })}\n\n`);
  }
  events.push(`event: message_delta\ndata: ${JSON.stringify({
    type: 'message_delta',
    delta: { stop_reason: willComplete ? 'end_turn' : 'max_tokens' },
    usage: { output_tokens: emitTokens + thinkingBudget }
  })}\n\n`);
  return { payload: events.join(''), willComplete, visibleTokens };
}

function stubFetch() {
  global.fetch = async (url, opts) => {
    const u = String(url);
    // modelDiscovery gọi /v1/models — trả đúng 1 model để không phải gọi mạng thật.
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
    callCount++;
    lastBody = JSON.parse(opts.body);
    const { payload } = buildSseStream(lastBody);
    if (!lastBody.stream) {
      const isComplete = lastBody.max_tokens - (lastBody.thinking ? lastBody.thinking.budget_tokens : 0) >= FULL_ANSWER_TOKENS;
      return {
        ok: true, status: 200,
        json: async () => ({
          content: [{ type: 'text', text: 'Kết quả cuối cùng là 42.' }],
          stop_reason: isComplete ? 'end_turn' : 'max_tokens',
          usage: { input_tokens: 100, output_tokens: 100 }
        }),
        text: async () => ''
      };
    }
    const bytes = Buffer.from(payload, 'utf8');
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
      text: async () => payload,
      json: async () => ({})
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

/** Bóc các sự kiện SSE thành [{event, data}]. */
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

  const baseBody = {
    query: 'Cho tam giác ABC vuông tại A, AB = 3 cm, AC = 4 cm. a) Tính BC. b) Tính diện tích tam giác ABC.',
    stage: 'detail', stream: true, deepThinking: true, crossCheck: false,
    settings: { lang: 'Tiếng Việt', detail: 'tiêu chuẩn', school: 'thpt', grade: '10', visual: 'never' }
  };

  // ---------- 1. Deep thinking phải HOÀN TẤT ----------
  try {
    callCount = 0;
    const res = await postChat(port, baseBody);
    const events = parseSse(res.raw);
    const done = events.find((e) => e.event === 'done');
    const err = events.find((e) => e.event === 'error');

    assert.ok(!err, 'KHÔNG được có sự kiện error: ' + JSON.stringify(err && err.data));
    assert.ok(done, 'phải có sự kiện done');
    assert.notStrictEqual(done.data.state, 'FAILED');
    assert.strictEqual(done.data.completeness, 'COMPLETE', 'deep thinking phải kết thúc COMPLETE');
    assert.strictEqual(done.data.partial, false, 'không được PARTIAL');
    record('1. Deep thinking hoàn tất COMPLETE (không còn "chưa đầy đủ sau khi khôi phục")', true);
  } catch (e) { record('1. Deep thinking hoàn tất COMPLETE (không còn "chưa đầy đủ sau khi khôi phục")', false, e.message); }

  // ---------- 2. Bằng chứng root cause: request THẬT gửi lên provider ----------
  try {
    assert.ok(lastBody.thinking, 'phải bật native thinking khi deepThinking=true');
    const visible = lastBody.max_tokens - lastBody.thinking.budget_tokens;
    assert.ok(
      visible >= FULL_ANSWER_TOKENS,
      `phần dành cho văn bản hiển thị (${visible} token) phải đủ viết hết câu trả lời — code cũ chỉ để lại 40% của max_tokens`
    );
    record('2. max_tokens - budget_tokens = answerBudget nguyên vẹn (root cause đã sửa)', true);
  } catch (e) { record('2. max_tokens - budget_tokens = answerBudget nguyên vẹn (root cause đã sửa)', false, e.message); }

  // ---------- 3. Không lãng phí lượt gọi: hoàn tất ngay lượt đầu, không cần recovery ----------
  try {
    assert.strictEqual(callCount, 1, `phải xong trong 1 lượt gọi, không đốt reserve vào recovery (thấy ${callCount})`);
    record('3. Không phát sinh vòng recovery vô ích (tiết kiệm token thật)', true);
  } catch (e) { record('3. Không phát sinh vòng recovery vô ích (tiết kiệm token thật)', false, e.message); }

  // ---------- 4. Chế độ Nhanh vẫn không hề bị ảnh hưởng (regression PHẦN 33.1) ----------
  try {
    callCount = 0;
    const res = await postChat(port, { ...baseBody, deepThinking: false });
    const events = parseSse(res.raw);
    const done = events.find((e) => e.event === 'done');
    assert.ok(done, 'chế độ Nhanh phải có done');
    assert.notStrictEqual(done.data.state, 'FAILED');
    assert.ok(!lastBody.thinking, 'chế độ Nhanh KHÔNG được bật native thinking');
    record('4. Chế độ Nhanh không hồi quy (không bật thinking, vẫn hoàn tất)', true);
  } catch (e) { record('4. Chế độ Nhanh không hồi quy (không bật thinking, vẫn hoàn tất)', false, e.message); }

  // ---------- 5. Hình minh họa: "never" -> không có visual, text vẫn đủ ----------
  try {
    const res = await postChat(port, { ...baseBody, deepThinking: false });
    const events = parseSse(res.raw);
    assert.ok(!events.some((e) => e.event === 'visual:ready'), 'settings.visual=never thì không được tạo hình');
    const done = events.find((e) => e.event === 'done');
    assert.ok(done && done.data.text && done.data.text.length > 100, 'text answer vẫn đầy đủ');
    record('5. settings.visual="never" -> không hình, text vẫn nguyên vẹn', true);
  } catch (e) { record('5. settings.visual="never" -> không hình, text vẫn nguyên vẹn', false, e.message); }

  // ---------- 6. Hình minh họa bật: text KHÔNG BAO GIỜ bị hình làm hỏng ----------
  try {
    const res = await postChat(port, {
      ...baseBody, deepThinking: false,
      settings: { ...baseBody.settings, visual: 'auto' }
    });
    const events = parseSse(res.raw);
    const done = events.find((e) => e.event === 'done');
    const err = events.find((e) => e.event === 'error');
    assert.ok(!err, 'hệ thống hình KHÔNG được sinh ra sự kiện error của câu trả lời');
    assert.ok(done, 'phải có done');
    assert.notStrictEqual(done.data.state, 'FAILED');
    // "done" phải tới TRƯỚC mọi sự kiện hình (PHẦN 20/21).
    const doneIdx = events.findIndex((e) => e.event === 'done');
    const visualIdx = events.findIndex((e) => e.event.startsWith('visual:'));
    if (visualIdx >= 0) assert.ok(doneIdx < visualIdx, 'text phải xong trước, hình tới sau');
    record('6. Bật hình minh họa KHÔNG block và KHÔNG làm hỏng text answer', true);
  } catch (e) { record('6. Bật hình minh họa KHÔNG block và KHÔNG làm hỏng text answer', false, e.message); }

  server.close();

  let passed = 0, failed = 0;
  console.log('\n== E2E: Suy nghĩ sâu hoàn tất + hình minh họa không block text ==');
  results.forEach((r) => {
    if (r.pass) { passed++; console.log('  ok  - ' + r.name); }
    else { failed++; console.log(' FAIL - ' + r.name + '\n        ' + r.error); }
  });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
  process.exit(failed ? 1 : 0);
})();
