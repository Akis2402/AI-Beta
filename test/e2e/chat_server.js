'use strict';
// Server E2E: phục vụ public/ với CSP THẬT (vercel.json) + chạy route /api/chat THẬT (server/routes/chat.js) qua express-shim,
// upstream AI (Anthropic) được stub. Dùng bởi hybrid_puter_e2e.py:  node test/e2e/chat_server.js <port>
// ⚠ express-shim: chỉ Router + res.status/json (KHÔNG phải express/helmet/rate-limit thật).
const http = require('http'); const fs = require('fs'); const path = require('path'); const Module = require('module');
const root = path.join(__dirname, '..', '..'); const PUBLIC = path.join(root, 'public');
process.env.ANTHROPIC_API_KEY = 'sk-test-e2e'; process.env.ANTHROPIC_MODEL = 'claude-test-model'; delete process.env.PUTER_VISUAL_MODE;
process.env.LOG_LEVEL = 'silent';
const routes = []; const shim = { Router: () => ({ post: (p, ...h) => routes.push({ m: 'POST', p, h }), get: (p, ...h) => routes.push({ m: 'GET', p, h }), use() {} }), json: () => (q, s, n) => n && n() };
const ol = Module._load; Module._load = function (r) { if (r === 'express') return shim; return ol.apply(this, arguments); };
const realLog = console.log; console.log = () => {}; // chat.js ghi log JSON dài — im lặng để E2E dễ đọc
require(path.join(root, 'server/routes/chat.js')); Module._load = ol;
const chatPost = routes.find((r) => r.m === 'POST' && r.p === '/').h.slice(-1)[0];
const CSP = (() => { let v = null; JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8')).headers.forEach((h) => h.headers.forEach((kv) => { if (kv.key === 'Content-Security-Policy') v = kv.value; })); return v; })();
const ANSWER = ['## Tóm tắt đề bài', 'Đề bài yêu cầu minh hoạ và giải thích.', '## Hướng giải', '- Bước 1: phân tích dữ kiện của đề bài một cách cẩn thận và đầy đủ.', '- Bước 2: áp dụng công thức phù hợp để tính toán kết quả.', '- Bước 3: kiểm tra lại đơn vị và ý nghĩa của kết quả thu được.', '## Kết luận', 'Hoàn tất các bước giải theo hướng đã nêu ở trên.'].join('\n');
const stats = { messages: 0, image: 0, last: null, all: [] };
global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/v1/models')) return { ok: true, status: 200, json: async () => ({ data: [{ id: process.env.ANTHROPIC_MODEL, type: 'model' }] }), text: async () => '' };
  if (/image|imagen|generateContent|images\/generations/i.test(u)) { stats.image++; return { ok: false, status: 500, text: async () => '', json: async () => ({}) }; }
  if (!u.includes('/v1/messages')) return { ok: false, status: 404, text: async () => 'nf', json: async () => ({}) };
  stats.messages++;
  const ev = `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: ANSWER } })}\n\nevent: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 200 } })}\n\n`; const bytes = Buffer.from(ev, 'utf8');
  return { ok: true, status: 200, body: { getReader() { let s = false; return { read: async () => (s ? { done: true } : (s = true, { done: false, value: bytes })), releaseLock() {} }; }, [Symbol.asyncIterator]: async function* () { yield bytes; } }, text: async () => ev, json: async () => ({ content: [{ type: 'text', text: ANSWER }], stop_reason: 'end_turn', usage: { input_tokens: 50, output_tokens: 200 } }) };
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const setCommon = () => { res.setHeader('Content-Security-Policy', CSP); res.setHeader('Cache-Control', 'no-store'); };
  if (req.method === 'GET' && url === '/__stats') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ messages: stats.messages, image: stats.image, last: stats.last, count: stats.all.length })); }
  if (req.method === 'POST' && url === '/api/chat') {
    res.status = (c) => { res.statusCode = c; return res; }; res.json = (o) => { if (!res.headersSent) res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', async () => { try { req.body = JSON.parse(b || '{}'); } catch (e) { req.body = {}; } stats.last = { query: req.body.query, stage: req.body.stage, clientCaps: req.body.clientCaps }; stats.all.push(stats.last); try { await chatPost(req, res, (e) => { res.statusCode = 500; res.end(String(e && e.stack)); }); } catch (e) { if (!res.writableEnded) { res.statusCode = 500; res.end(String(e && e.stack)); } } });
    return;
  }
  if (req.method !== 'GET') { res.statusCode = 404; return res.end(); }
  let f = path.join(PUBLIC, url === '/' ? 'index.html' : url); if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end('nf'); }
  setCommon(); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res);
});
server.listen(Number(process.argv[2]) || 0, '127.0.0.1', () => { realLog('READY ' + server.address().port); });
