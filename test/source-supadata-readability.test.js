'use strict';

// v6.23 — khoá cơ chế lấy nguồn MỚI: YouTube = Supadata (1 tầng), Web = Readability+jsdom (+Firecrawl).
// Không gọi mạng thật: Supadata/Firecrawl là client giả được tiêm qua opts; safeHttp.fetchPinned bị thay bằng stub.
// Bất biến quan trọng nhất (PHẦN FA): không lấy được nội dung -> INCOMPLETE trung thực, KHÔNG bịa.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

delete process.env.SUPADATA_API_KEY;
delete process.env.FIRECRAWL_API_KEY;

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const yt = require('../server/utils/source/youtubeSource');
const web = require('../server/utils/source/webSource');
const safeHttp = require('../server/utils/safeHttp');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok  - ' + name); passed++; }
  catch (e) { console.log(' FAIL - ' + name + '\n        ' + (e.stack || e)); failed++; }
}

let vid = 0;
const newUrl = () => `https://youtu.be/${'ab' + String(++vid).padStart(9, '0')}`; // 11 ký tự, mỗi test 1 video (tránh cache)
const CONTENT = [
  { text: 'Chào các bạn', offset: 0, duration: 4000, lang: 'vi' },
  { text: 'hôm nay học dao động', offset: 4000, duration: 5000, lang: 'vi' },
  { text: 'phần hai bắt đầu', offset: 200000, duration: 3000, lang: 'vi' }
];

/** Client Supadata giả: `script` = hàm (params) => kết quả | throw. Ghi lại mọi lệnh gọi. */
function fakeClient(script, { jobs = {}, meta } = {}) {
  const calls = [];
  const transcript = async (params) => { calls.push(params); return script(params); };
  transcript.getJobStatus = async (id) => { const j = jobs[id]; return typeof j === 'function' ? j() : j; };
  return { calls, transcript, metadata: async () => { if (meta instanceof Error) throw meta; return meta || { title: 'Bài giảng dao động', author: { displayName: 'Thầy A' } }; } };
}
const supaErr = (code) => Object.assign(new Error(code), { error: code });

(async () => {
  console.log('\n== YouTube / Supadata ==');

  await test('toCues: offset/duration MILI-GIÂY -> GIÂY; bỏ cue rỗng/NaN/âm', () => {
    const cues = yt.toCues([...CONTENT, { text: '  ', offset: 1, duration: 1 }, { text: 'x', offset: 'abc' }, { text: 'y', offset: -5 }]);
    assert.strictEqual(cues.length, 3);
    assert.deepStrictEqual(cues[1], { start: 4, duration: 5, text: 'hôm nay học dao động' });
    assert.deepStrictEqual(yt.toCues('chuỗi phẳng không có mốc'), []);
  });

  await test('native có phụ đề -> READY, chunk stamp text-supadata, locator đúng, KHÔNG gọi generate', async () => {
    const c = fakeClient(() => ({ content: CONTENT, lang: 'vi', availableLangs: ['vi'] }));
    const r = await yt.fetchYoutubeSource(newUrl(), { supadataClient: c });
    assert.strictEqual(r.status, 'READY');
    assert.strictEqual(r.extractorVersion, 'yt-transcript-v4-supadata');
    assert.strictEqual(r.title, 'Bài giảng dao động');
    assert.strictEqual(r.author, 'Thầy A');
    assert.strictEqual(r.chunks.length, 2);
    assert.strictEqual(r.chunks[1].locator, '3:20–3:23');
    assert.ok(r.chunks.every((k) => k.extractionMethod === 'text-supadata'));
    assert.ok(!r.asrGenerated);
    assert.strictEqual(c.calls.length, 1);
    assert.strictEqual(c.calls[0].mode, 'native');
    assert.strictEqual(c.calls[0].text, false, 'BẮT BUỘC text:false để có mốc thời gian');
    assert.strictEqual(c.calls[0].lang, 'vi');
  });

  await test('schema chunk YouTube không đổi', async () => {
    const c = fakeClient(() => ({ content: CONTENT, lang: 'vi' }));
    const r = await yt.fetchYoutubeSource(newUrl(), { supadataClient: c });
    assert.deepStrictEqual(Object.keys(r.chunks[0]).sort(),
      ['chunkIndex', 'endSeconds', 'extractionMethod', 'locator', 'startSeconds', 'text', 'totalChunks']);
  });

  await test('native trả 206 transcript-unavailable trong body -> generate ĐÚNG 1 lần -> asr-supadata', async () => {
    const c = fakeClient((p) => (p.mode === 'native' ? { error: 'transcript-unavailable', message: 'x' } : { content: CONTENT, lang: 'vi' }));
    const r = await yt.fetchYoutubeSource(newUrl(), { supadataClient: c });
    assert.strictEqual(r.status, 'READY');
    assert.deepStrictEqual(c.calls.map((x) => x.mode), ['native', 'generate']);
    assert.ok(r.chunks.every((k) => k.extractionMethod === 'asr-supadata'));
    assert.strictEqual(r.asrGenerated, true);
  });

  await test('native throw SupadataError transcript-unavailable -> generate', async () => {
    const c = fakeClient((p) => { if (p.mode === 'native') throw supaErr('transcript-unavailable'); return { content: CONTENT, lang: 'en' }; });
    const r = await yt.fetchYoutubeSource(newUrl(), { supadataClient: c });
    assert.strictEqual(r.status, 'READY');
    assert.strictEqual(r.language, 'en');
    assert.ok(r.chunks.every((k) => k.extractionMethod === 'asr-supadata'));
  });

  await test('native rỗng + generate cũng rỗng -> INCOMPLETE trung thực, không bịa từ tiêu đề', async () => {
    const c = fakeClient(() => ({ content: [], lang: 'vi' }));
    const r = await yt.fetchYoutubeSource(newUrl(), { supadataClient: c });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 'INCOMPLETE');
    assert.strictEqual(r.reason, 'transcript_unavailable');
    assert.strictEqual(r.transcriptAvailable, false);
    assert.ok(!r.chunks, 'không có chunk nào');
    assert.ok(/không có phụ đề/.test(r.userMessage));
    assert.ok(!/Bài giảng dao động/.test(JSON.stringify(r)), 'không được đưa tiêu đề thật vào INCOMPLETE để suy diễn');
    assert.deepStrictEqual(c.calls.map((x) => x.mode), ['native', 'generate']);
  });

  await test('hết quota / key sai ở native -> INCOMPLETE, KHÔNG gọi generate (tốn tiền vô ích)', async () => {
    for (const code of ['limit-exceeded', 'unauthorized', 'upgrade-required', 'internal-error']) {
      const c = fakeClient(() => { throw supaErr(code); });
      const r = await yt.fetchYoutubeSource(newUrl(), { supadataClient: c });
      assert.strictEqual(r.status, 'INCOMPLETE', code);
      assert.strictEqual(c.calls.length, 1, code);
      assert.ok(/lỗi hoặc đã hết hạn mức/.test(r.userMessage), code);
    }
  });

  await test('not-found -> ERROR video_unavailable', async () => {
    const c = fakeClient(() => { throw supaErr('not-found'); });
    const r = await yt.fetchYoutubeSource(newUrl(), { supadataClient: c });
    assert.strictEqual(r.status, 'ERROR');
    assert.strictEqual(r.reason, 'video_unavailable');
    assert.strictEqual(c.calls.length, 1);
  });

  await test('không có SUPADATA_API_KEY -> INCOMPLETE ngay, không gọi mạng, không bịa', async () => {
    const r = await yt.fetchYoutubeSource(newUrl());
    assert.strictEqual(r.status, 'INCOMPLETE');
    assert.strictEqual(r.transcriptAvailable, false);
    assert.ok(/chưa được cấu hình/.test(r.userMessage));
  });

  await test('job 202: poll tới completed rồi trả READY', async () => {
    let n = 0;
    const c = fakeClient(() => ({ jobId: 'job-1' }), { jobs: { 'job-1': () => (++n < 3 ? { status: 'active' } : { status: 'completed', result: { content: CONTENT, lang: 'vi' } }) } });
    const r = await yt.fetchYoutubeSource(newUrl(), { supadataClient: c, pollIntervalMs: 5 });
    assert.strictEqual(r.status, 'READY');
    assert.strictEqual(n, 3);
  });

  await test('job failed transcript-unavailable ở native -> chuyển sang generate', async () => {
    const c = fakeClient((p) => (p.mode === 'native' ? { jobId: 'j2' } : { content: CONTENT, lang: 'vi' }),
      { jobs: { j2: { status: 'failed', error: { error: 'transcript-unavailable', message: 'm', details: 'd' } } } });
    const r = await yt.fetchYoutubeSource(newUrl(), { supadataClient: c, pollIntervalMs: 5 });
    assert.strictEqual(r.status, 'READY');
    assert.ok(r.chunks.every((k) => k.extractionMethod === 'asr-supadata'));
  });

  await test('treo quá deadline -> INCOMPLETE gọn (route không bị Vercel cắt ngang)', async () => {
    const c = fakeClient(() => new Promise(() => {}));
    const t0 = Date.now();
    const r = await yt.fetchYoutubeSource(newUrl(), { supadataClient: c, timeoutMs: 60 });
    assert.strictEqual(r.status, 'INCOMPLETE');
    assert.ok(Date.now() - t0 < 3000);
  });

  await test('metadata lỗi KHÔNG làm hỏng transcript (title dự phòng)', async () => {
    const id = newUrl();
    const c = fakeClient(() => ({ content: CONTENT, lang: 'vi' }), { meta: new Error('boom') });
    const r = await yt.fetchYoutubeSource(id, { supadataClient: c });
    assert.strictEqual(r.status, 'READY');
    assert.ok(/^YouTube: /.test(r.title));
  });

  await test('cache: lượt 2 cùng video KHÔNG gọi Supadata lại; INCOMPLETE không bị cache', async () => {
    const id = newUrl();
    const c = fakeClient(() => ({ content: CONTENT, lang: 'vi' }));
    await yt.fetchYoutubeSource(id, { supadataClient: c });
    const r2 = await yt.fetchYoutubeSource(id, { supadataClient: c });
    assert.strictEqual(r2.fromCache, true);
    assert.strictEqual(c.calls.length, 1);
    const id2 = newUrl();
    const bad = fakeClient(() => ({ content: [] }));
    await yt.fetchYoutubeSource(id2, { supadataClient: bad });
    const good = fakeClient(() => ({ content: CONTENT, lang: 'vi' }));
    const r3 = await yt.fetchYoutubeSource(id2, { supadataClient: good });
    assert.strictEqual(r3.status, 'READY', 'lần trước INCOMPLETE không được khoá cứng kết quả');
  });

  await test('URL không phải YouTube -> ERROR invalid_youtube_url, không gọi client', async () => {
    const c = fakeClient(() => ({ content: CONTENT }));
    const r = await yt.fetchYoutubeSource('https://vimeo.com/123', { supadataClient: c });
    assert.strictEqual(r.reason, 'invalid_youtube_url');
    assert.strictEqual(c.calls.length, 0);
  });

  console.log('\n== Web / Readability + Firecrawl ==');

  const realFetchPinned = safeHttp.fetchPinned;
  const stub = (res) => { safeHttp.fetchPinned = async () => (typeof res === 'function' ? res() : res); };
  const html200 = (html) => ({ ok: true, status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: Buffer.from(html) });
  const P = 'Đây là nội dung thật của bài viết về dao động điều hòa. '.repeat(30);
  const ARTICLE = `<html><head><title>Dao động | Trường X</title></head><body><nav>Menu Menu</nav>
    <article><h1>Dao động điều hòa</h1><p>${P}</p><h2>Chu kỳ và tần số</h2><p>${P}</p><h2>Năng lượng</h2><p>${P}</p></article>
    <footer>Bản quyền</footer><script>track()</script></body></html>`;
  const SPA = '<html><head><title>App</title></head><body><div id="root"></div><script>render()</script></body></html>';
  let n = 0;
  const wurl = () => `https://vd${++n}.example.com/bai`;
  const fcClient = (md, title = 'Tiêu đề FC') => { const calls = []; return { calls, scrape: async (u, o) => { calls.push({ u, o }); if (md instanceof Error) throw md; return { markdown: md, metadata: { title } }; } }; };

  try {
    await test('bài viết: Readability lọc nav/footer/script, chunk mang sectionAnchor + method text-readability', async () => {
      stub(html200(ARTICLE));
      const r = await web.fetchWebSource(wurl());
      assert.strictEqual(r.status, 'READY');
      assert.strictEqual(r.extractorVersion, 'web-extract-v3-readability');
      assert.ok(r.title.length > 0);
      const all = r.chunks.map((c) => c.text).join('\n');
      assert.ok(!/Menu Menu|Bản quyền|track\(\)/.test(all), 'rác phải bị lọc');
      assert.ok(r.chunks.every((c) => c.extractionMethod === 'text-readability'));
      assert.ok(r.chunks.some((c) => c.sectionAnchor === 'Năng lượng'), 'trích nguồn theo heading vẫn hoạt động');
      assert.deepStrictEqual(Object.keys(r.chunks[0]).sort(),
        ['charStart', 'chunkIndex', 'extractionMethod', 'sectionAnchor', 'sectionLevel', 'text', 'totalChunks']);
    });

    await test('SPA + không có FIRECRAWL_API_KEY -> INCOMPLETE no_readable_text (không bịa)', async () => {
      stub(html200(SPA));
      const r = await web.fetchWebSource(wurl());
      assert.strictEqual(r.status, 'INCOMPLETE');
      assert.strictEqual(r.reason, 'no_readable_text');
      assert.ok(!r.chunks);
    });

    await test('SPA + Firecrawl -> READY text-firecrawl; `#`/`##` thành sectionAnchor; link/ảnh bị bóc; # trong code fence KHÔNG là heading', async () => {
      stub(html200(SPA));
      const md = `# Giới thiệu\n\n${P}\n\n## Công thức\n\n[xem thêm](https://x.test/y) ![ảnh](https://x.test/a.png)\n\n\`\`\`py\n# không phải heading\n\`\`\`\n\n${P}`;
      const fc = fcClient(md);
      const u = wurl();
      const r = await web.fetchWebSource(u, { firecrawlClient: fc });
      assert.strictEqual(r.status, 'READY');
      assert.ok(r.chunks.every((c) => c.extractionMethod === 'text-firecrawl'));
      const all = r.chunks.map((c) => c.text).join('\n');
      assert.ok(all.includes('xem thêm') && !all.includes('https://x.test/y') && !all.includes('a.png'));
      assert.ok(all.includes('# không phải heading'));
      assert.ok(r.chunks.some((c) => c.sectionAnchor === 'Công thức'));
      assert.ok(!/[\uE010-\uE013]/.test(all), 'sentinel không được lộ ra model');
      assert.ok(fc.calls[0].u.startsWith('https://') && fc.calls[0].o.formats[0] === 'markdown');
    });

    await test('Firecrawl lỗi/timeout/rỗng -> INCOMPLETE no_readable_text', async () => {
      stub(html200(SPA));
      for (const client of [fcClient(new Error('402')), fcClient(''), fcClient('ngắn')]) {
        const r = await web.fetchWebSource(wurl(), { firecrawlClient: client });
        assert.strictEqual(r.status, 'INCOMPLETE');
        assert.strictEqual(r.reason, 'no_readable_text');
      }
    });

    await test('lỗi SSRF/mạng (blocked_ip, dns_failed) -> ERROR và TUYỆT ĐỐI không đưa URL cho Firecrawl', async () => {
      for (const reason of ['blocked_ip', 'dns_failed', 'too_large']) {
        stub({ ok: false, reason });
        const fc = fcClient(P + P);
        const r = await web.fetchWebSource(wurl(), { firecrawlClient: fc });
        assert.strictEqual(r.status, 'ERROR', reason);
        assert.strictEqual(r.reason, reason);
        assert.strictEqual(fc.calls.length, 0, reason);
      }
    });

    await test('403 chặn bot -> thử Firecrawl; 404 -> ERROR, không gọi Firecrawl', async () => {
      stub({ ok: true, status: 403, headers: {}, body: Buffer.from('blocked') });
      const fc = fcClient(`# Bài\n\n${P}`);
      const r = await web.fetchWebSource(wurl(), { firecrawlClient: fc });
      assert.strictEqual(r.status, 'READY');
      assert.strictEqual(fc.calls.length, 1);
      stub({ ok: true, status: 404, headers: {}, body: Buffer.from('nf') });
      const fc2 = fcClient(`# Bài\n\n${P}`);
      const r2 = await web.fetchWebSource(wurl(), { firecrawlClient: fc2 });
      assert.strictEqual(r2.reason, 'http_404');
      assert.strictEqual(fc2.calls.length, 0);
      stub({ ok: true, status: 403, headers: {}, body: Buffer.from('blocked') });
      const r3 = await web.fetchWebSource(wurl());
      assert.strictEqual(r3.reason, 'http_403', 'không có key -> giữ nguyên lỗi cũ');
    });

    await test('cache: lượt 2 cùng URL không fetch lại', async () => {
      let hits = 0;
      stub(() => { hits++; return html200(ARTICLE); });
      const u = wurl();
      await web.fetchWebSource(u);
      const r2 = await web.fetchWebSource(u);
      assert.strictEqual(r2.fromCache, true);
      assert.strictEqual(hits, 1);
    });

    await test('HTML lớn bất thường/DOM quá nhiều phần tử -> không treo, INCOMPLETE', async () => {
      stub(html200('<html><body>' + '<div><span>x</span></div>'.repeat(20000) + '</body></html>'));
      const t0 = Date.now();
      const r = await web.fetchWebSource(wurl());
      assert.strictEqual(r.status, 'INCOMPLETE');
      assert.ok(Date.now() - t0 < 20000);
    });
  } finally {
    safeHttp.fetchPinned = realFetchPinned;
  }

  console.log('\n== Bảo mật + dọn sạch cơ chế cũ ==');

  await test('safeHttp: DNS-pin/chặn nội bộ còn nguyên; proxy YouTube đã gỡ', () => {
    assert.strictEqual(safeHttp.isBlockedAddress('10.0.0.1'), true);
    assert.strictEqual(safeHttp.isBlockedAddress('169.254.169.254'), true);
    assert.strictEqual(safeHttp.isBlockedAddress('::ffff:127.0.0.1'), true);
    assert.strictEqual(safeHttp.isBlockedAddress('8.8.8.8'), false);
    assert.strictEqual(typeof safeHttp.resolvePublicAddress, 'function');
    assert.ok(!('PROXY_ALLOWED_HOST_RE' in safeHttp));
    const src = read('server/utils/safeHttp.js');
    assert.ok(!/proxyUrl|proxyAgent|PROXY_ALLOWED/.test(src));
    assert.ok(/lookup:/.test(src) && /resolvePublicAddress\(url\.hostname\)/.test(src));
  });

  await test('DoD: không còn dấu vết youtubei/proxy/ASR Gemini trong server/utils/source', () => {
    const dir = path.join(root, 'server', 'utils', 'source');
    for (const f of fs.readdirSync(dir)) {
      const s = fs.readFileSync(path.join(dir, f), 'utf8');
      assert.ok(!/youtubei|youtube-transcript|proxyAgent|YOUTUBE_PROXY_URL|YOUTUBE_ASR|GoogleGenAI/.test(s), f);
    }
    ['server/utils/source/youtubeAsrFallback.js', 'server/utils/source/youtubeFallbackLibs.js', 'server/utils/proxyAgent.js', 'test/youtube-proxy.test.js']
      .forEach((f) => assert.ok(!fs.existsSync(path.join(root, f)), f + ' phải bị xoá'));
  });

  await test('package.json + .env.example + route khớp master prompt v6.23', () => {
    const pkg = JSON.parse(read('package.json'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    ['youtube-transcript', 'youtubei.js', 'https-proxy-agent', 'socks-proxy-agent'].forEach((d) => assert.ok(!deps[d], d));
    ['@supadata/js', '@mozilla/readability', 'jsdom', '@mendable/firecrawl-js', '@types/jsdom', '@google/genai'].forEach((d) => assert.ok(deps[d], d));
    const env = read('.env.example');
    ['YOUTUBE_PROXY_URL', 'YOUTUBE_FALLBACK_LIB_ENABLED', 'YOUTUBE_ASR_ENABLED', 'YOUTUBE_ASR_MODEL', 'YOUTUBE_ASR_MAX_OUTPUT_TOKENS']
      .forEach((v) => assert.ok(!env.includes(v), v));
    assert.ok(/^SUPADATA_API_KEY=$/m.test(env) && /^FIRECRAWL_API_KEY=$/m.test(env));
    assert.ok(/maxDuration = 60/.test(read('app/api/source/youtube/route.ts')));
    assert.ok(/maxDuration = 30/.test(read('app/api/source/web/route.ts')));
  });

  await test('không còn đọc process.env.* của cơ chế cũ ở bất kỳ file server nào', () => {
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    walk(path.join(root, 'server')).filter((f) => f.endsWith('.js')).forEach((f) => {
      assert.ok(!/YOUTUBE_PROXY_URL|YOUTUBE_FALLBACK_LIB_ENABLED|YOUTUBE_ASR/.test(fs.readFileSync(f, 'utf8')), f);
    });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
