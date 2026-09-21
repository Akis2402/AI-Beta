'use strict';

// ============================================================================================
// HARNESS route /api/chat THẬT (server/routes/chat.js) trên http server của Node, KHÔNG cần express.
// ⚠ TRUNG THỰC: đây là "express-shim" (chỉ Router + res.status/json) để CHẠY LOGIC THẬT của chat.js; nó KHÔNG thay thế
//   test dựng server/app.js với express/helmet/rate-limit thật (các test đó vẫn SKIPPED khi thiếu node_modules).
//   Upstream AI (Anthropic) được stub bằng global.fetch; image API bị đếm để chứng minh SVG không gọi ảnh.
// ============================================================================================
const assert = require('assert');
const http = require('http');
const path = require('path');
const Module = require('module');
const root = path.join(__dirname, '..');

process.env.ANTHROPIC_API_KEY = 'sk-test-harness'; process.env.ANTHROPIC_MODEL = 'claude-test-model';
delete process.env.PUTER_VISUAL_MODE; // production default: client_primary

// ---- express-shim: chỉ đủ cho routes/chat.js
const routes = [];
const shim = { Router: () => ({ post: (p, ...h) => routes.push({ m: 'POST', p, h }), get: (p, ...h) => routes.push({ m: 'GET', p, h }), use() {} }), json: () => (q, s, n) => n && n() };
const origLoad = Module._load;
Module._load = function (request, parent, isMain) { if (request === 'express') return shim; return origLoad.apply(this, arguments); };
require(path.join(root, 'server/routes/chat.js'));
Module._load = origLoad;
const chatPost = routes.find((r) => r.m === 'POST' && r.p === '/');
assert.ok(chatPost, 'không bắt được route POST /');

const ANSWER = ['## Tóm tắt đề bài', 'Đề bài yêu cầu minh hoạ.', '## Hướng giải', '- Bước 1: phân tích dữ kiện của đề bài một cách cẩn thận và đầy đủ.', '- Bước 2: áp dụng công thức phù hợp để tính toán kết quả.', '- Bước 3: kiểm tra lại đơn vị và ý nghĩa vật lí/toán học của kết quả.', '## Kết luận', 'Hoàn tất các bước giải theo hướng đã nêu ở trên.'].join('\n');
const counts = { messages: 0, image: 0, other: 0 };
global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/v1/models')) return { ok: true, status: 200, json: async () => ({ data: [{ id: process.env.ANTHROPIC_MODEL, type: 'model' }] }), text: async () => '' };
  if (/image|imagen|generateContent|images\/generations/i.test(u)) { counts.image++; return { ok: false, status: 500, text: async () => '', json: async () => ({}) }; }
  if (!u.includes('/v1/messages')) { counts.other++; return { ok: false, status: 404, text: async () => 'nf', json: async () => ({}) }; }
  counts.messages++;
  const ev = `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: ANSWER } })}\n\nevent: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 200 } })}\n\n`;
  const bytes = Buffer.from(ev, 'utf8');
  return { ok: true, status: 200, body: { getReader() { let s = false; return { read: async () => (s ? { done: true } : (s = true, { done: false, value: bytes })), releaseLock() {} }; }, [Symbol.asyncIterator]: async function* () { yield bytes; } }, text: async () => ev, json: async () => ({ content: [{ type: 'text', text: ANSWER }], stop_reason: 'end_turn', usage: { input_tokens: 50, output_tokens: 200 } }) };
};

const server = http.createServer((req, res) => {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { if (!res.headersSent) res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', async () => { try { req.body = b ? JSON.parse(b) : {}; } catch (e) { req.body = {}; } try { await chatPost.h[chatPost.h.length - 1](req, res, (e) => { res.statusCode = 500; res.end(String(e && e.stack)); }); } catch (e) { if (!res.writableEnded) { res.statusCode = 500; res.end(String(e && e.stack)); } } });
});
const post = (port, body) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body);
  const r = http.request({ host: '127.0.0.1', port, path: '/api/chat', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => { let t = ''; res.setEncoding('utf8'); res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, text: t })); });
  r.on('error', reject); r.write(data); r.end();
});
function sse(text) { const out = []; text.split('\n\n').forEach((blk) => { const ev = /^event: (.+)$/m.exec(blk); const dt = /^data: (.+)$/m.exec(blk); if (ev && dt) { let d = null; try { d = JSON.parse(dt[1]); } catch (e) { d = null; } out.push({ event: ev[1].trim(), data: d }); } }); return out; }
const results = [];
const seq = (name, fn) => { chain = chain.then(() => fn().then(() => results.push({ name, pass: true }), (e) => results.push({ name, pass: false, error: e && (e.stack || e.message) }))); };
let chain = Promise.resolve();

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const ask = (query, caps, extra = {}) => post(port, { query, stream: true, stage: 'approach', settings: { detail: 'tiêu chuẩn', lang: 'Tiếng Việt', school: 'thpt', grade: '10', subject: 'auto', visual: 'auto' }, clientCaps: caps ? { puterAuth: caps } : undefined, history: [], ...extra });
  const ev = (r) => sse(r.text);
  const names = (r) => ev(r).map((e) => e.event);

  seq('H1. SVG (hoá học) qua route thật: visual:ready format=svg, KHÔNG visual:request, KHÔNG gọi image API, done không kèm visualJob — dù client báo unauthenticated', async () => {
    counts.image = 0; const r = await ask('Vẽ cấu hình electron của nguyên tử Natri Na', 'unauthenticated');
    assert.strictEqual(r.status, 200, r.text.slice(0, 300)); const es = ev(r); const n = es.map((e) => e.event);
    assert.ok(n.includes('done'), n.join(',')); const vr = es.find((e) => e.event === 'visual:ready'); assert.ok(vr, n.join(','));
    assert.strictEqual(vr.data.format, 'svg'); assert.strictEqual(vr.data.renderer, 'deterministic_svg'); assert.ok(/^<svg/.test(vr.data.svg)); assert.ok(!n.includes('visual:request')); assert.strictEqual(counts.image, 0);
    const done = es.find((e) => e.event === 'done').data; assert.ok(!done.visualJob, 'SVG không cần job Puter');
  });
  seq('H2. cùng câu hỏi lần 2 (text-cache hit): SVG vẫn được giao, vẫn 0 lệnh gọi ảnh, không gọi lại model text', async () => {
    counts.image = 0; const before = counts.messages; const r = await ask('Vẽ cấu hình electron của nguyên tử Natri Na', 'unauthenticated'); const es = ev(r);
    const done = es.find((e) => e.event === 'done'); assert.ok(done, names(r).join(','));
    const vis = es.find((e) => e.event === 'visual:ready') || (done.data.visuals && done.data.visuals[0] && { data: done.data.visuals[0] });
    assert.ok(vis && vis.data.format === 'svg', 'cache hit làm MẤT SVG: ' + JSON.stringify(names(r))); assert.strictEqual(counts.image, 0); assert.strictEqual(counts.messages, before, 'cache hit không được gọi lại AI text');
  });
  const EXPLAIN_Q = 'Giải thích chi tiết cấu tạo và chức năng của tế bào thực vật rồi vẽ hình minh hoạ các bào quan chính';
  seq('H3. ảnh AI + Puter CHƯA Auth (luồng giải thích + hình): visual:error stub PUTER_AUTH_REQUIRED kèm job, KHÔNG visual:request', async () => {
    const r = await ask(EXPLAIN_Q, 'unauthenticated'); const es = ev(r); const n = es.map((e) => e.event);
    const er = es.find((e) => e.event === 'visual:error'); assert.ok(er, n.join(',')); assert.strictEqual(er.data.errorCode, 'PUTER_AUTH_REQUIRED'); assert.strictEqual(er.data.authRequired, true); assert.strictEqual(er.data.job.renderer, 'puter_image');
    assert.ok(!n.includes('visual:request')); const done = es.find((e) => e.event === 'done').data; assert.ok(!done.visualJob);
  });
  seq('H4. cache dùng chung KHÔNG bị nhiễm: cùng câu hỏi nhưng client ĐÃ Auth -> nhận job Puter bình thường (visual:request), không nhận stub', async () => {
    const before = counts.messages; const r = await ask(EXPLAIN_Q, 'authenticated'); const es = ev(r); const n = es.map((e) => e.event);
    assert.ok(n.includes('visual:request'), 'người đã Auth phải nhận job (cache bị nhiễm?): ' + n.join(',')); assert.ok(!n.includes('visual:error')); assert.ok(counts.messages > before, 'không được phục vụ từ cache đã nhiễm trạng thái Auth');
  });
  seq('H3b. image-only ("Vẽ hình tế bào thực vật") + chưa Auth: stub PUTER_AUTH_REQUIRED (không còn bị bỏ vì dưới ngưỡng), 0 lệnh gọi text model', async () => {
    const before = counts.messages; const r = await ask('Vẽ hình tế bào thực vật', 'unauthenticated'); const es = ev(r); const n = es.map((e) => e.event);
    const er = es.find((e) => e.event === 'visual:error'); assert.ok(er, n.join(',')); assert.strictEqual(er.data.errorCode, 'PUTER_AUTH_REQUIRED'); assert.strictEqual(counts.messages, before, 'image-only không gọi model text');
    const ok = ev(await ask('Vẽ hình tế bào thực vật', 'authenticated')).map((e) => e.event); assert.ok(ok.includes('visual:request'), ok.join(','));
  });
  seq('H5. client báo unknown -> job Puter (client tự kiểm tra), hành vi cũ giữ nguyên', async () => {
    const r = await ask('Vẽ sơ đồ cấu tạo ti thể minh hoạ', 'unknown'); const n = names(r); assert.ok(n.includes('visual:request') || n.includes('visual:pending'), n.join(','));
  });
  seq('H6. thiếu clientCaps (client cũ): không lỗi, coi là unknown', async () => {
    const r = await ask('Vẽ sơ đồ cấu tạo lục lạp minh hoạ', undefined); assert.strictEqual(r.status, 200); assert.ok(names(r).includes('done'));
  });
  seq('H7. dữ kiện mâu thuẫn: visual:ready format=notice, không gọi image API, không job Puter', async () => {
    counts.image = 0; const r = await ask('Vẽ tam giác ABC vuông tại A, AB = 3, AC = 4, BC = 6', 'authenticated'); const es = ev(r); const n = es.map((e) => e.event);
    const vr = es.find((e) => e.event === 'visual:ready'); assert.ok(vr, n.join(',')); assert.strictEqual(vr.data.format, 'notice'); assert.ok(/mâu thuẫn/.test(vr.data.message)); assert.ok(!n.includes('visual:request')); assert.strictEqual(counts.image, 0);
  });
  seq('H8. non-stream (JSON): SVG nằm trong visuals + visualStatus=ready, không có visualJob', async () => {
    const r = await post(port, { query: 'Vẽ tam giác ABC vuông tại A, AB = 6 cm, AC = 8 cm', stream: false, stage: 'approach', settings: { visual: 'auto', detail: 'tiêu chuẩn', lang: 'Tiếng Việt', school: 'thpt', grade: '10', subject: 'auto' }, clientCaps: { puterAuth: 'unauthenticated' }, history: [] });
    assert.strictEqual(r.status, 200, r.text.slice(0, 300)); const j = JSON.parse(r.text); assert.ok(Array.isArray(j.visuals) && j.visuals[0] && j.visuals[0].format === 'svg', JSON.stringify(Object.keys(j))); assert.strictEqual(j.visualStatus, 'ready'); assert.ok(!j.visualJob);
  });
  seq('H9. stage "detail" ngay sau Approach: KHÔNG dựng lại/gọi ảnh; trả về hình đã có hoặc unavailable (không sinh ảnh mới)', async () => {
    counts.image = 0; const first = await ask('Vẽ tam giác ABC vuông tại A, AB = 5 cm, AC = 12 cm', 'unauthenticated'); const fes = ev(first); const vis = fes.find((e) => e.event === 'visual:ready').data;
    const d = await post(port, { query: 'Vẽ tam giác ABC vuông tại A, AB = 5 cm, AC = 12 cm', stream: false, stage: 'detail', approachText: ANSWER, visualId: vis.visualId, settings: { visual: 'auto', detail: 'tiêu chuẩn', lang: 'Tiếng Việt', school: 'thpt', grade: '10', subject: 'auto' }, clientCaps: { puterAuth: 'unauthenticated' }, history: [] });
    assert.strictEqual(d.status, 200, d.text.slice(0, 300)); const j = JSON.parse(d.text); assert.strictEqual(counts.image, 0); assert.ok(!j.visualJob); if (j.visuals && j.visuals.length) assert.strictEqual(j.visuals[0].format, 'svg');
  });

  chain.then(() => { server.close(); let p = 0, f = 0; console.log('\n== Route /api/chat THẬT (express-shim) — Hybrid Visual ==');
    results.forEach((r) => { if (r.pass) { p++; console.log('  ok  - ' + r.name); } else { f++; console.log(' FAIL - ' + r.name + '\n        ' + r.error); } });
    console.log(`\n${p} passed, ${f} failed`); if (f) process.exitCode = 1; setTimeout(() => process.exit(process.exitCode || 0), 50); });
});
