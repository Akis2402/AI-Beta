'use strict';

// MỤC 2 (backlog v6.22) — YouTube qua proxy (Lớp A) + thư viện dự phòng (Lớp B). KHÔNG gọi mạng thật:
// proxy giả lập = 1 http.Server local chỉ ghi lại CONNECT rồi trả 502.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const root = path.join(__dirname, '..');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const safeHttp = require('../server/utils/safeHttp');
const proxyAgent = require('../server/utils/proxyAgent');
const yt = require('../server/utils/source/youtubeSource');
const libs = require('../server/utils/source/youtubeFallbackLibs');

function startFakeProxy() {
  const connects = [];
  const server = http.createServer((q, s) => { s.writeHead(502); s.end(); });
  server.on('connect', (req, socket) => { connects.push(req.url); socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, connects, url: `http://user:pw@127.0.0.1:${server.address().port}` })));
}
function closedPortUrl() {
  return new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(`http://127.0.0.1:${p}`)); }); });
}
const YT = () => new URL('https://www.youtube.com/youtubei/v1/player');

// ---------- (a) regression: env rỗng => y hệt code cũ ----------
test('a1. YOUTUBE_PROXY_URL rỗng -> fetchPinned nhận ĐÚNG đối số cũ, KHÔNG có proxyUrl', async () => {
  delete process.env.YOUTUBE_PROXY_URL;
  const orig = safeHttp.fetchPinned; const calls = [];
  safeHttp.fetchPinned = async (u, o) => { calls.push({ u, o }); return { ok: true, status: 200, body: Buffer.from('x') }; };
  try {
    const opts = { maxBytes: 10, timeoutMs: 50, headers: { A: 'b' } };
    const r = await yt.fetchYoutubeHttp(YT(), opts);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].o, opts, 'đối số y hệt code cũ');
    assert.ok(!('proxyUrl' in calls[0].o));
  } finally { safeHttp.fetchPinned = orig; }
});
test('a2. parseProxyList: đa giá trị, bỏ mục rỗng/sai giao thức/trùng; redact che user:pass', () => {
  const l = proxyAgent.parseProxyList('http://u:p@h1:8080, socks5://u:p@h2:1080,,ftp://x:1,notaurl,http://u:p@h1:8080');
  assert.deepStrictEqual(l, ['http://u:p@h1:8080', 'socks5://u:p@h2:1080']);
  assert.deepStrictEqual(proxyAgent.parseProxyList(''), []);
  assert.ok(!proxyAgent.redactProxyUrl('http://u:secret@h1:8080').includes('secret'));
});
test('a3. buildProxyAgent: http -> HttpsProxyAgent, socks5 -> SocksProxyAgent', () => {
  const { HttpsProxyAgent } = require('https-proxy-agent');
  const { SocksProxyAgent } = require('socks-proxy-agent');
  assert.ok(proxyAgent.buildProxyAgent('http://127.0.0.1:1') instanceof HttpsProxyAgent);
  assert.ok(proxyAgent.buildProxyAgent('socks5://127.0.0.1:1') instanceof SocksProxyAgent);
  assert.throws(() => proxyAgent.buildProxyAgent('ftp://127.0.0.1:1'));
});

// ---------- (b) 1 proxy: request THẬT SỰ đi qua proxy ----------
test('b1. 1 proxy -> proxy nhận CONNECT www.youtube.com:443 (đi qua proxy, không kết nối thẳng)', async () => {
  const p = await startFakeProxy();
  process.env.YOUTUBE_PROXY_URL = p.url;
  try {
    const r = await yt.fetchYoutubeHttp(YT(), { maxBytes: 1000, timeoutMs: 3000 });
    assert.deepStrictEqual(p.connects, ['www.youtube.com:443']);
    assert.ok(!r.ok || r.status === 502, 'proxy giả trả 502 -> không có video thật, đúng kỳ vọng');
  } finally { delete process.env.YOUTUBE_PROXY_URL; p.server.close(); }
});

// ---------- (c) nhiều proxy: proxy đầu lỗi -> sang proxy kế ----------
test('c1. proxy #1 chết (cổng đóng) -> tự sang proxy #2, không crash; #1 vào cooldown', async () => {
  const dead = await closedPortUrl();
  const p2 = await startFakeProxy();
  process.env.YOUTUBE_PROXY_URL = `${dead},${p2.url}`;
  try {
    const r = await yt.fetchYoutubeHttp(YT(), { maxBytes: 1000, timeoutMs: 3000 });
    assert.ok(r && typeof r.ok === 'boolean');
    assert.deepStrictEqual(p2.connects, ['www.youtube.com:443'], 'proxy #2 phải nhận request sau khi #1 lỗi');
    const rot = yt.getProxyRotator();
    assert.strictEqual(rot.size, 2);
    assert.notStrictEqual(rot.next(), dead, '#1 đang cooldown, không được chọn lại ngay');
  } finally { delete process.env.YOUTUBE_PROXY_URL; p2.server.close(); }
});
test('c2. rotator: round-robin + cooldown hết hạn thì dùng lại', () => {
  let t = 0; const rot = proxyAgent.createProxyRotator(['a', 'b'], { cooldownMs: 100, now: () => t });
  assert.strictEqual(rot.next(), 'a'); assert.strictEqual(rot.next(), 'b'); assert.strictEqual(rot.next(), 'a');
  rot.markFailed('b'); assert.strictEqual(rot.next(), 'a'); assert.strictEqual(rot.next(), 'a');
  t = 101; assert.strictEqual(rot.next(), 'b');
  const empty = proxyAgent.createProxyRotator([]); assert.strictEqual(empty.next(), null);
});

// ---------- (d) ranh giới bảo mật ----------
test('d1. webSource.js KHÔNG chứa proxy (ProxyAgent/proxyUrl/proxyAgent/YOUTUBE_PROXY)', () => {
  const src = fs.readFileSync(path.join(root, 'server/utils/source/webSource.js'), 'utf8');
  for (const bad of ['ProxyAgent', 'proxyUrl', 'proxyAgent', 'YOUTUBE_PROXY', 'youtubeFallbackLibs']) assert.ok(!src.includes(bad), `webSource.js chứa "${bad}"`);
});
test('d2. fetchPinned + proxyUrl mà host NGOÀI miền YouTube -> từ chối, không mở kết nối', async () => {
  const p = await startFakeProxy();
  try {
    const r = await safeHttp.fetchPinned(new URL('https://example.com/a'), { maxBytes: 10, timeoutMs: 500, proxyUrl: p.url });
    assert.deepStrictEqual(r, { ok: false, reason: 'proxy_host_not_allowed' });
    assert.deepStrictEqual(p.connects, []);
  } finally { p.server.close(); }
});
test('d3. proxyAgent.js chỉ được require bởi safeHttp/youtubeSource (không module nguồn web nào)', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const users = walk(path.join(root, 'server')).filter((f) => f.endsWith('.js') && /proxyAgent'\)/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.basename(f)).sort();
  assert.deepStrictEqual(users, ['safeHttp.js', 'youtubeSource.js']);
});

// ---------- (e) Lớp B bằng mock ----------
test('e1. youtubei.js (mock): segments -> cues giây, bỏ header không có mốc, method text-youtubeijs', async () => {
  const seen = {};
  const Innertube = { create: async (o) => { seen.fetch = o.fetch; return { getInfo: async () => ({ getTranscript: async () => ({ languages: ['Vietnamese'], selectedLanguage: 'Vietnamese', transcript: { content: { body: { initial_segments: [
    { type: 'TranscriptSectionHeader', snippet: { text: 'H' } },
    { start_ms: '1500', end_ms: '3000', snippet: { text: ' Xin  chào ' } },
    { start_ms: '3000', end_ms: '4000', snippet: { text: '' } }
  ] } } } }) }) }; } };
  const r = await libs.viaYoutubei('abc', { langs: ['vi'], loader: async () => ({ Innertube }) });
  assert.deepStrictEqual(r.cues, [{ start: 1.5, duration: 1.5, text: 'Xin chào' }]);
  assert.strictEqual(r.method, 'text-youtubeijs');
  assert.strictEqual(typeof seen.fetch, 'function');
});
test('e2. youtube-transcript (mock): offset ms nguyên -> giây; số thực -> giữ giây; method đúng', async () => {
  const ms = await libs.viaYoutubeTranscript('abc', { langs: ['vi'], loader: async () => ({ fetchTranscript: async () => [{ text: 'a', offset: 1500, duration: 2000 }] }) });
  assert.deepStrictEqual(ms.cues, [{ start: 1.5, duration: 2, text: 'a' }]);
  const sec = await libs.viaYoutubeTranscript('abc', { langs: [], loader: async () => ({ fetchTranscript: async () => [{ text: 'b', offset: 1.36, duration: 2.5 }] }) });
  assert.deepStrictEqual(sec.cues, [{ start: 1.36, duration: 2.5, text: 'b' }]);
  assert.strictEqual(sec.method, 'text-youtube-transcript');
});
test('e3. tryFallbackLibs: thư viện 1 ném lỗi -> thử thư viện 2; tất cả hỏng -> null, không ném', async () => {
  const ok = async () => ({ cues: [{ start: 0, duration: 1, text: 'x' }], language: 'vi', method: 'm2' });
  const bad = async () => { throw new Error('blocked'); };
  assert.strictEqual((await libs.tryFallbackLibs('v', { attempts: [bad, ok] })).method, 'm2');
  assert.strictEqual(await libs.tryFallbackLibs('v', { attempts: [bad, bad] }), null);
  process.env.YOUTUBE_FALLBACK_LIB_ENABLED = 'false';
  try { assert.strictEqual(await libs.tryFallbackLibs('v', { attempts: [ok] }), null); } finally { delete process.env.YOUTUBE_FALLBACK_LIB_ENABLED; }
});
test('e4. makeScopedFetch: host YouTube mang dispatcher proxy; host khác đi thẳng, KHÔNG dispatcher', async () => {
  const p = await startFakeProxy(); const calls = [];
  try {
    const f = libs.makeScopedFetch(p.url, async (i, init) => { calls.push({ i: String(i), init }); return {}; });
    await f('https://www.youtube.com/x', {}); await f('https://example.com/y', {});
    assert.ok(calls[0].init && calls[0].init.dispatcher, 'YouTube phải có dispatcher');
    assert.ok(!calls[1].init || !calls[1].init.dispatcher, 'host ngoài YouTube không được qua proxy');
    assert.strictEqual(libs.makeScopedFetch(null, async () => 1)('https://www.youtube.com/', {}) instanceof Promise, true);
  } finally { p.server.close(); }
});
test('e5. tích hợp: Lớp A thất bại hết -> Lớp B trả cues -> READY, chunks.method = tên thư viện (trước ASR)', async () => {
  const orig = safeHttp.fetchPinned;
  safeHttp.fetchPinned = async () => ({ ok: false, reason: 'request_failed' });
  delete process.env.YOUTUBE_PROXY_URL;
  try {
    const vid = 'dQw4w9WgXcQ';
    const r = await yt.fetchYoutubeSource(`https://youtu.be/${vid}`, { fallbackLibOverrides: { attempts: [async () => ({ cues: [{ start: 0, duration: 2, text: 'phụ đề thật' }], language: 'vi', method: 'text-youtubeijs' })] } });
    assert.strictEqual(r.status, 'READY');
    assert.ok(r.chunks.length >= 1);
    assert.ok(r.chunks.every((c) => c.method === 'text-youtubeijs' || c.extractionMethod === 'text-youtubeijs'), JSON.stringify(r.chunks[0]));
  } finally { safeHttp.fetchPinned = orig; }
});

(async () => {
  let passed = 0, failed = 0;
  for (const t of tests) {
    try { await t.fn(); passed++; console.log('  ok  -', t.name); } catch (e) { failed++; console.log(' FAIL -', t.name, '\n       ', e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n        ') : e); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
