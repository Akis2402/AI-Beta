'use strict';

// MỤC 1.2 (backlog v6.22) — client xử lý 409 duplicate_request_in_progress bằng cách POLL
// GET /api/chat/jobs/:id (đúng kênh resume sẵn có) thay vì báo lỗi cứng, và KHÔNG tạo request AI thứ 2.
// app.js có quá nhiều phụ thuộc DOM để nạp nguyên file -> trích ĐÚNG các hàm thật bằng brace-matching
// từ mã nguồn rồi chạy trong vm với fetch giả (không viết lại logic trong test).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

function extract(startMarker) {
  const start = src.indexOf(startMarker);
  assert.ok(start !== -1, 'không tìm thấy ' + startMarker);
  let i = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { i = src.indexOf('\n', i); continue; }
    if (c === '/' && n === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; else if (q === '`' && src[i] === '$' && src[i + 1] === '{') { let d = 1; i += 2; while (d) { if (src[i] === '{') d++; else if (src[i] === '}') d--; i++; } i--; } i++; }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('không đóng được ngoặc cho ' + startMarker);
}

const code = [
  'const DUPLICATE_POLL_INTERVAL_MS = 1500;', 'const DUPLICATE_POLL_MAX_MS = 150000;',
  extract('function isDuplicateInProgress('), extract('async function pollDuplicateJob('),
  extract('async function apiPost('), extract('async function apiPostStream(')
].join('\n');

function makeEnv(fetchImpl) {
  const calls = { posts: 0, gets: 0, statuses: [], deltas: [] };
  const win = { ReadableStream: function () {}, TextDecoder };
  const sandbox = {
    window: win, TextDecoder, setTimeout: (fn) => setTimeout(fn, 1), Date, encodeURIComponent, JSON, Promise, Error,
    t: (k) => k, apiHeaders: () => ({}), enforceRequestBudget: (b) => ({ body: b }), withClientCaps: (p, b) => b,
    dispatchVisualJob: () => {}, console,
    fetch: (url, opts) => { if (opts && opts.method === 'POST') calls.posts++; else calls.gets++; return fetchImpl(url, opts, calls); }
  };
  vm.createContext(sandbox);
  vm.runInContext(code + '\nthis.__api = { apiPost, apiPostStream, pollDuplicateJob };', sandbox);
  return { api: sandbox.__api, calls };
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, body: null });
const DUP = { error: 'duplicate_request_in_progress', message: 'x', requestId: 'req-1' };

const results = [];
const test = (name, fn) => results.push({ name, fn });

test('C1. apiPostStream nhận 409 -> poll job tới khi completed, trả về result (shape done), gọi onDelta 1 lần, KHÔNG POST lần 2', async () => {
  let polls = 0;
  const { api, calls } = makeEnv(async (url, opts) => {
    if (opts && opts.method === 'POST') return json(409, DUP);
    polls++;
    if (polls < 3) return json(200, { found: true, job: { status: 'running' } });
    return json(200, { found: true, job: { status: 'completed', result: { text: 'KẾT QUẢ', provider: 'p' } } });
  });
  const deltas = []; const statuses = [];
  const r = await api.apiPostStream('/api/chat', { clientRequestId: 'req-1' }, { onDelta: (d) => deltas.push(d), onStatus: (m, s) => statuses.push([m, s]) });
  assert.strictEqual(r.text, 'KẾT QUẢ'); assert.deepStrictEqual(deltas, ['KẾT QUẢ']);
  assert.strictEqual(calls.posts, 1, 'không được gửi request AI thứ 2'); assert.strictEqual(polls, 3);
  assert.strictEqual(statuses[0][1], 'RECOVERING'); assert.strictEqual(statuses[0][0], 'chat.duplicateWaiting');
});
test('C2. apiPost (không stream) nhận 409 -> cũng poll, không ném lỗi', async () => {
  const { api, calls } = makeEnv(async (url, opts) => (opts && opts.method === 'POST') ? json(409, DUP)
    : json(200, { found: true, job: { status: 'completed', result: { text: 'ok' } } }));
  const r = await api.apiPost('/api/chat', { clientRequestId: 'req-1' });
  assert.strictEqual(r.text, 'ok'); assert.strictEqual(calls.posts, 1);
});
test('C3. 409 nhưng thiếu requestId trong body -> dùng clientRequestId của request', async () => {
  let url0 = '';
  const { api } = makeEnv(async (url, opts) => { if (opts && opts.method === 'POST') return json(409, { error: 'duplicate_request_in_progress' }); url0 = url; return json(200, { found: true, job: { status: 'completed', result: { text: 'x' } } }); });
  await api.apiPost('/api/chat', { clientRequestId: 'abc def' });
  assert.strictEqual(url0, '/api/chat/jobs/abc%20def');
});
test('C4. job failed -> ném lỗi có code; 404/lỗi mạng khi poll -> thử lại, không bỏ cuộc', async () => {
  let n = 0;
  const { api } = makeEnv(async (url, opts) => {
    if (opts && opts.method === 'POST') return json(409, DUP);
    n++;
    if (n === 1) return json(404, { found: false });
    if (n === 2) throw new Error('network');
    return json(200, { found: true, job: { status: 'failed', error: 'PROVIDER_ERROR' } });
  });
  await assert.rejects(() => api.apiPost('/api/chat', { clientRequestId: 'req-1' }), (e) => e.code === 'PROVIDER_ERROR');
  assert.strictEqual(n, 3);
});
test('C5. hết maxMs mà job vẫn running -> lỗi DUPLICATE_TIMEOUT (không treo vô hạn)', async () => {
  const { api } = makeEnv(async () => json(200, { found: true, job: { status: 'running' } }));
  await assert.rejects(() => api.pollDuplicateJob('req-1', { intervalMs: 1, maxMs: 30 }), (e) => e.code === 'DUPLICATE_TIMEOUT' && e.status === 409);
});
test('C6. AbortSignal -> dừng poll, ném AbortError', async () => {
  const { api } = makeEnv(async () => json(200, { found: true, job: { status: 'running' } }));
  const signal = { aborted: false };
  setTimeout(() => { signal.aborted = true; }, 10);
  await assert.rejects(() => api.pollDuplicateJob('req-1', { signal, intervalMs: 2, maxMs: 5000 }), (e) => e.name === 'AbortError' && e.cancelled === true);
});
test('C7. 409 với error KHÁC (không phải duplicate) vẫn là lỗi cứng như cũ', async () => {
  const { api, calls } = makeEnv(async () => json(409, { error: 'conflict_khac' }));
  await assert.rejects(() => api.apiPost('/api/chat', { clientRequestId: 'r' }));
  assert.strictEqual(calls.gets, 0);
});
test('C8. lỗi 500 thường không bị nuốt vào nhánh poll', async () => {
  const { api, calls } = makeEnv(async () => json(500, { error: 'boom' }));
  await assert.rejects(() => api.apiPostStream('/api/chat', { clientRequestId: 'r' }), (e) => e.status === 500);
  assert.strictEqual(calls.gets, 0);
});

(async () => {
  let failed = 0;
  for (const t of results) { try { await t.fn(); console.log('  ok  -', t.name); } catch (e) { failed++; console.log(' FAIL -', t.name, '\n       ', e && (e.stack || e.message)); } }
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
