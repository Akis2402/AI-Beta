'use strict';

// MỤC 1.1 (backlog v6.22) — QUEUED state khi Fast lane phải xếp hàng Global Worker Pool.
// (a) unit: onQueued bắn ĐỒNG BỘ khi phải chờ, KHÔNG bắn khi admit ngay, lỗi callback không phá acquire().
// (b) route THẬT (chat.js qua express-shim, cùng kiểu chat-route-harness): pool đầy -> SSE 'queued' là
//     sự kiện ĐẦU TIÊN, có trước 'done'; log 'worker_pool_queued' có TRƯỚC 'worker_pool_admit'.
// (c) BUG tự tìm ra khi làm 1.1: timeout LÚC ĐANG xếp hàng (headers SSE đã gửi) phải kết thúc bằng SSE
//     'error' + end(), không ERR_HTTP_HEADERS_SENT / treo.
// (d) client (app.js) có nhánh 'queued' nối vào onStatus.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const Module = require('module');
const root = path.join(__dirname, '..');

process.env.ANTHROPIC_API_KEY = 'sk-test-queued'; process.env.ANTHROPIC_MODEL = 'claude-test-model';
process.env.GLOBAL_REQUEST_DEADLINE_MS = '9000';
process.env.GLOBAL_WORKER_POOL_SIZE = '2';
process.env.GLOBAL_WORKER_POOL_INTERACTIVE_RESERVE = '1';
delete process.env.PUTER_VISUAL_MODE;

const results = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const { createGlobalWorkerPool, PRIORITY } = require('../server/utils/globalWorkerPool');

// ---------------- (a) unit ----------------
test('a1. hết slot -> onQueued bắn ĐỒNG BỘ (trước khi acquire resolve), kèm snapshot queued>=1', async () => {
  const pool = createGlobalWorkerPool({ globalCapacity: 1, interactiveReserve: 0 });
  const rel = await pool.acquire({ priority: PRIORITY.INTERACTIVE });
  const order = [];
  let snap = null;
  const p = pool.acquire({ priority: PRIORITY.INTERACTIVE, onQueued: (s) => { order.push('queued'); snap = s; } }).then((r) => { order.push('admit'); return r; });
  assert.deepStrictEqual(order, ['queued'], 'onQueued phải chạy đồng bộ ngay trong acquire()');
  assert.ok(snap && snap.queued >= 1 && snap.queuedInteractive >= 1);
  rel();
  const rel2 = await p;
  assert.deepStrictEqual(order, ['queued', 'admit']);
  rel2();
});
test('a2. còn slot -> onQueued KHÔNG được gọi', async () => {
  const pool = createGlobalWorkerPool({ globalCapacity: 2, interactiveReserve: 0 });
  let called = 0;
  const rel = await pool.acquire({ onQueued: () => { called++; } });
  assert.strictEqual(called, 0); rel();
});
test('a3. callback ném lỗi -> acquire() vẫn cấp slot bình thường', async () => {
  const pool = createGlobalWorkerPool({ globalCapacity: 1, interactiveReserve: 0 });
  const rel = await pool.acquire();
  const p = pool.acquire({ onQueued: () => { throw new Error('ui boom'); } });
  rel();
  const rel2 = await p; assert.strictEqual(typeof rel2, 'function'); rel2();
});

// ---------------- (b)(c) route thật ----------------
const routes = [];
const shim = { Router: () => ({ post: (p, ...h) => routes.push({ m: 'POST', p, h }), get: (p, ...h) => routes.push({ m: 'GET', p, h }), use() {} }), json: () => (q, s, n) => n && n() };
const origLoad = Module._load;
Module._load = function (request) { if (request === 'express') return shim; return origLoad.apply(this, arguments); };
const logger = require('../server/utils/logger');
const logged = [];
const origWrite = process.stdout.write.bind(process.stdout);
require(path.join(root, 'server/routes/chat.js'));
Module._load = origLoad;
const chatPost = routes.find((r) => r.m === 'POST' && r.p === '/');
const { defaultPool } = require('../server/utils/globalWorkerPool');

const ANSWER = ['## Tóm tắt đề bài', 'Đề bài yêu cầu minh hoạ.', '## Hướng giải', '- Bước 1: phân tích dữ kiện của đề bài một cách cẩn thận và đầy đủ.', '- Bước 2: áp dụng công thức phù hợp để tính toán kết quả.', '- Bước 3: kiểm tra lại đơn vị và ý nghĩa vật lí/toán học của kết quả.', '## Kết luận', 'Hoàn tất các bước giải theo hướng đã nêu ở trên.'].join('\n');
global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/v1/models')) return { ok: true, status: 200, json: async () => ({ data: [{ id: process.env.ANTHROPIC_MODEL, type: 'model' }] }), text: async () => '' };
  if (!u.includes('/v1/messages')) return { ok: false, status: 404, text: async () => 'nf', json: async () => ({}) };
  const ev = `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: ANSWER } })}\n\nevent: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 200 } })}\n\n`;
  const bytes = Buffer.from(ev, 'utf8');
  return { ok: true, status: 200, body: { getReader() { let s = false; return { read: async () => (s ? { done: true } : (s = true, { done: false, value: bytes })), releaseLock() {} }; }, [Symbol.asyncIterator]: async function* () { yield bytes; } }, text: async () => ev, json: async () => ({}) };
};

const server = http.createServer((req, res) => {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { if (!res.headersSent) res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', async () => {
    try { req.body = b ? JSON.parse(b) : {}; } catch (e) { req.body = {}; }
    // next(err) mô phỏng errorHandler thật: res.status().json() — sẽ NÉM nếu headers đã gửi
    const next = (e) => { try { res.status(503).json({ error: String(e && e.message) }); } catch (x) { res.__nextThrew = true; try { res.end(); } catch (y) { /* */ } } };
    try { await chatPost.h[chatPost.h.length - 1](req, res, next); } catch (e) { if (!res.writableEnded) { res.statusCode = 500; res.end(String(e && e.stack)); } }
  });
});
function sse(text) { const out = []; text.split('\n\n').forEach((blk) => { const ev = /^event: (.+)$/m.exec(blk); const dt = /^data: (.+)$/m.exec(blk); if (ev && dt) { let d = null; try { d = JSON.parse(dt[1]); } catch (e) { d = null; } out.push({ event: ev[1].trim(), data: d }); } }); return out; }
const post = (port, body) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body);
  const r = http.request({ host: '127.0.0.1', port, path: '/api/chat', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => { let t = ''; res.setEncoding('utf8'); res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, ctype: res.headers['content-type'], text: t })); });
  r.on('error', reject); r.write(data); r.end();
});
const BODY = { query: 'Tính 2+3 và trình bày các bước', stream: true, stage: 'approach', settings: { detail: 'tiêu chuẩn', lang: 'Tiếng Việt', school: 'thpt', grade: '10', subject: 'auto', visual: 'off' }, history: [] };
const saturate = async () => { const rels = []; while (defaultPool.snapshot().activeTotal < 2) rels.push(await defaultPool.acquire({ priority: PRIORITY.INTERACTIVE })); return rels; };

test('b1. pool đầy rồi có slot: SSE "queued" là sự kiện ĐẦU TIÊN, có state QUEUED, trước "done"; log queued TRƯỚC admit', async () => {
  const lines = [];
  process.stdout.write = (chunk, ...a) => { lines.push(String(chunk)); return origWrite(chunk, ...a); };
  const rels = await saturate();
  const port = server.address().port;
  const pending = post(port, { ...BODY, query: 'Tính 2+3 và trình bày các bước b1' });
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(defaultPool.snapshot().queued >= 1, 'request phải đang nằm trong hàng chờ');
  rels.forEach((r) => r());
  const r = await pending;
  process.stdout.write = origWrite;
  assert.strictEqual(r.status, 200, r.text.slice(0, 300));
  const es = sse(r.text); const names = es.map((e) => e.event);
  assert.strictEqual(names[0], 'queued', 'queued phải đứng ĐẦU: ' + names.join(','));
  assert.strictEqual(es[0].data.state, 'QUEUED'); assert.ok(es[0].data.message);
  assert.ok(names.includes('done'), names.join(',') + ' | ' + r.text.slice(0, 400));
  assert.ok(names.indexOf('queued') < names.indexOf('done'));
  const all = lines.join('');
  const iq = all.indexOf('worker_pool_queued'); const ia = all.indexOf('worker_pool_admit');
  if (iq !== -1 || ia !== -1) assert.ok(iq !== -1 && iq < ia, 'log queued phải có TRƯỚC admit');
});
test('b2. pool còn slot: KHÔNG có sự kiện "queued"', async () => {
  const r = await post(server.address().port, { ...BODY, query: 'Tính 4+5 và trình bày các bước b2' });
  assert.ok(!sse(r.text).some((e) => e.event === 'queued'));
});
test('b3. BUG: timeout lúc đang xếp hàng (SSE headers đã gửi) -> SSE "error" + kết thúc sạch, KHÔNG ERR_HTTP_HEADERS_SENT', async () => {
  const rels = await saturate();
  let r;
  try { r = await post(server.address().port, { ...BODY, query: 'Tính 6+7 và trình bày các bước b3' }); } finally { rels.forEach((x) => x()); }
  assert.strictEqual(r.status, 200);
  assert.ok(/text\/event-stream/.test(r.ctype || ''), r.ctype);
  const names = sse(r.text).map((e) => e.event);
  assert.strictEqual(names[0], 'queued');
  assert.ok(names.includes('error'), 'phải có SSE error: ' + names.join(','));
  assert.ok(!names.includes('done'));
});

// ---------------- (d) client wiring ----------------
test('d1. app.js có nhánh currentEvent === "queued" nối vào onStatus (state QUEUED)', () => {
  const src = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
  assert.ok(/currentEvent === 'queued' && typeof onStatus === 'function'\) onStatus\(payload\.message \|\| '', payload\.state \|\| 'QUEUED'\)/.test(src));
});

server.listen(0, '127.0.0.1', async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log('  ok  -', t.name); }
    catch (e) { failed++; process.stdout.write === origWrite || (process.stdout.write = origWrite); console.log(' FAIL -', t.name, '\n       ', e && (e.stack || e.message)); }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  server.close(); process.exit(failed ? 1 : 0);
});
