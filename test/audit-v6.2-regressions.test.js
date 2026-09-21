'use strict';

// ==============================================================================================
// REGRESSION V6.2 — mỗi bug được sửa trong lần audit này có ĐÚNG MỘT test tự động ở đây (§33).
// Không test nào cần `npm install`: tất cả đọc nguồn thật hoặc gọi module thuần Node, nên chúng
// chạy được trong CI và cả trong sandbox không mạng.
// ==============================================================================================

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  -', name); }
  catch (e) { failed++; console.log(' FAIL -', name, '\n       ', e.stack || e.message); }
}

// ----------------------------------------------------------------------------------------------
console.log('\n== BUG-001: locator nguồn Web/YouTube phải đi HẾT đường client -> validator -> prompt ==');
// BUG: public/js/app.js (production source-of-truth) không gửi kind/sourceUrl/timeStart/timeEnd/
//      sectionAnchor, và validators.js allow-list lại vứt bỏ đúng 5 trường đó -> nhánh youtube/web
//      của promptBuilder.formatContextLine() là dead code, mọi trích dẫn Web/YouTube mất locator.
// ROOT CAUSE: allow-list context thiếu trường + client không sinh trường.
// FIX: client sinh (qua httpUrlOrNull), validator nhận có kiểm tra chặt, promptBuilder in locator.

test('client app.js GỬI đủ 5 trường locator V6 trong evidence URL source', () => {
  const app = read('public/js/app.js');
  for (const f of ['kind:', 'sourceUrl:', 'timeStart:', 'timeEnd:', 'sectionAnchor:']) {
    assert.ok(app.includes(f), `public/js/app.js thiếu trường ${f} khi dựng context URL source`);
  }
  assert.ok(app.includes('httpUrlOrNull(s.url)'),
    'sourceUrl phải đi qua httpUrlOrNull() — không gửi URL thô, và không bịa "#" thành địa chỉ nguồn');
});

test('client renderCitations dùng sanitizeUrl cho href trích dẫn (escapeHtml KHÔNG chặn javascript:)', () => {
  const app = read('public/js/app.js');
  const i = app.indexOf('const safeSrcUrl');
  assert.ok(i > 0, 'renderCitations chưa có bước sanitizeUrl cho sourceUrl');
  const block = app.slice(i, i + 1200);
  assert.ok(/sanitizeUrl\(c\.sourceUrl\)/.test(block), 'href phải lấy từ sanitizeUrl(c.sourceUrl)');
  assert.ok(!/href="\$\{escapeHtml\(c\.sourceUrl\)\}"/.test(app),
    'KHÔNG được nhét c.sourceUrl vào href chỉ qua escapeHtml');
});

test('validators.js GIỮ LẠI 5 trường locator, và validate chặt từng trường', () => {
  const { validateChatBody } = require('../server/utils/validators');
  const base = {
    query: 'giải thích đoạn này',
    contexts: [{
      doc: 'Video bài giảng', id: 1, text: 'nội dung đoạn trích',
      sourceId: 'url:YOUTUBE:abc', kind: 'youtube',
      sourceUrl: 'https://www.youtube.com/watch?v=abc',
      timeStart: 65, timeEnd: 90, sectionAnchor: 'Định lý Pythagore'
    }]
  };
  const c = validateChatBody(base).contexts[0];
  assert.strictEqual(c.kind, 'youtube');
  assert.strictEqual(c.sourceUrl, 'https://www.youtube.com/watch?v=abc');
  assert.strictEqual(c.timeStart, 65);
  assert.strictEqual(c.timeEnd, 90);
  assert.strictEqual(c.sectionAnchor, 'Định lý Pythagore');
});

test('validators.js CHẶN URL không phải http/https và số giây vô lý (không bịa locator)', () => {
  const { validateChatBody } = require('../server/utils/validators');
  const mk = (over) => validateChatBody({
    query: 'q', contexts: [Object.assign({ doc: 'd', id: 1, text: 't' }, over)]
  }).contexts[0];
  assert.strictEqual(mk({ sourceUrl: 'javascript:alert(1)' }).sourceUrl, null, 'javascript: phải bị loại');
  assert.strictEqual(mk({ sourceUrl: 'data:text/html,<script>' }).sourceUrl, null, 'data: phải bị loại');
  assert.strictEqual(mk({ sourceUrl: 'file:///etc/passwd' }).sourceUrl, null, 'file: phải bị loại');
  assert.strictEqual(mk({ sourceUrl: 'not a url' }).sourceUrl, null);
  assert.strictEqual(mk({ kind: 'pdf-ish' }).kind, null, 'kind ngoài allow-list -> null');
  assert.strictEqual(mk({ timeStart: -5 }).timeStart, null);
  assert.strictEqual(mk({ timeStart: Infinity }).timeStart, null);
  assert.strictEqual(mk({ timeStart: 999999999 }).timeStart, null, 'mốc > 24h là vô lý');
  assert.strictEqual(mk({ timeStart: 12.7 }).timeStart, 12, 'làm tròn xuống, giữ số nguyên giây');
});

test('promptBuilder in locator YouTube khi CHỈ có timeStart (BUG-001b)', () => {
  const pb = require('../server/utils/promptBuilder');
  const fmt = pb.formatContextLine || (pb.__test && pb.__test.formatContextLine);
  if (typeof fmt !== 'function') { console.log('        (formatContextLine không export — kiểm tra qua nguồn)'); 
    const src = read('server/utils/promptBuilder.js');
    assert.ok(/else if \(c\.timeStart != null\) parts\.push\(`mốc \$\{formatSec\(c\.timeStart\)\}`\)/.test(src),
      'thiếu nhánh locator khi chỉ có timeStart');
    return;
  }
  const line = fmt({ kind: 'youtube', doc: 'V', id: 1, text: 'x', sourceUrl: 'https://y/1', timeStart: 65 }, 0);
  assert.ok(line.includes('mốc 1:05'), line);
});

// ----------------------------------------------------------------------------------------------
console.log('\n== BUG-002: asset đã fingerprint phải khớp NỘI DUNG (immutable 1 năm, sai là ghim sai) ==');

test('mọi asset trong asset-manifest.json: hash trong tên == hash nội dung == hash file nguồn', () => {
  const manifest = JSON.parse(read('public/asset-manifest.json'));
  const sha10 = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 10);
  for (const [name, url] of Object.entries(manifest.assets)) {
    const diskPath = path.join(root, 'public', url.replace(/^\//, ''));
    assert.ok(fs.existsSync(diskPath), `thiếu ${url}`);
    const declared = (url.match(/\.([0-9a-f]{10})\.(?:js|css)$/) || [])[1];
    const actual = sha10(fs.readFileSync(diskPath));
    assert.strictEqual(actual, declared, `${url}: tên khai ${declared} nhưng nội dung băm ra ${actual}`);
    const src = path.join(path.dirname(diskPath), name);
    assert.strictEqual(sha10(fs.readFileSync(src)), actual, `${name}: bản build trôi khỏi file nguồn`);
  }
});

test('check-static-assets.js THẬT SỰ kiểm tra hash (nếu không, BUG-002 lặp lại im lặng)', () => {
  const src = read('scripts/check-static-assets.js');
  assert.ok(src.includes("require('crypto')"), 'checker không băm gì cả');
  assert.ok(/hash trong TÊN file khớp NỘI DUNG file/.test(src));
});

test('build.js thay MỌI tham chiếu asset (cờ g) và reset lastIndex trước replace', () => {
  const src = read('scripts/build.js');
  assert.ok(/return new RegExp\(pattern, 'g'\);/.test(src), 'buildTagRegex phải có cờ g');
  assert.ok(/re\.lastIndex = 0;/.test(src), 're.test() với cờ g đã đẩy lastIndex — phải reset');
  const { buildTagRegex } = require('../scripts/build.js');
  const re = buildTagRegex('js', 'app.js');
  const html = '<script src="/js/app.js"></script><link href="/js/app.js">';
  re.lastIndex = 0;
  assert.strictEqual(html.replace(re, '$1/js/app.HASH.js$1').split('/js/app.HASH.js').length - 1, 2,
    'phải thay cả 2 tham chiếu, không chỉ tham chiếu đầu');
});

// ----------------------------------------------------------------------------------------------
console.log('\n== BUG-003: /api/health phải sống khi nền tảng tước tiền tố /api ==');

test('normalizer tiền tố /api đăng ký TRƯỚC handler /api/health', () => {
  const src = read('server/app.js');
  // lastIndexOf: chú thích giải thích bản vá cũng chứa chuỗi "app.get('/api/health'", phải lấy
  // lần xuất hiện THẬT (dòng code, luôn là lần cuối) chứ không phải lần trong comment.
  const iNorm = src.indexOf("const apiPrefixes");
  const iHealth = src.lastIndexOf("app.get('/api/health'");
  assert.ok(iNorm > 0 && iHealth > 0);
  assert.ok(iNorm < iHealth,
    'normalizer nằm SAU health -> request "/health" bị viết lại thành "/api/health" khi đã đi qua handler => 404');
});

// ----------------------------------------------------------------------------------------------
console.log('\n== BUG-004: MỘT chính sách security header duy nhất cho cả 3 nơi khai báo (§13) ==');

test('vercel.json / next.config.mjs / Helmet khớp nhau về X-Frame-Options, HSTS, Permissions-Policy, CSP', () => {
  const vercel = JSON.parse(read('vercel.json'));
  const rule = vercel.headers.find((h) => h.source === '/(.*)');
  const v = (k) => (rule.headers.find((h) => h.key === k) || {}).value;
  const nextSrc = read('next.config.mjs');
  const helmetSrc = read('server/middleware/security.js');

  assert.strictEqual(v('X-Frame-Options'), 'DENY');
  assert.ok(/\{ key: 'X-Frame-Options', value: 'DENY' \}/.test(nextSrc),
    'next.config.mjs phải là DENY (trước đây là SAMEORIGIN -> lệch với vercel.json và Helmet)');
  assert.ok(/frameguard: \{ action: 'deny' \}/.test(helmetSrc));

  for (const key of ['Strict-Transport-Security', 'Permissions-Policy', 'Referrer-Policy', 'X-Content-Type-Options']) {
    assert.ok(nextSrc.includes(v(key)), `next.config.mjs thiếu/lệch ${key}: vercel.json khai "${v(key)}"`);
  }

  // CSP: so khớp theo từng directive (thứ tự không quan trọng, nội dung thì có).
  const parse = (csp) => new Set(String(csp).split(';').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean));
  const vercelCsp = parse(v('Content-Security-Policy'));
  const nextCspMatch = nextSrc.match(/export const CONTENT_SECURITY_POLICY = \[([\s\S]*?)\]\.join\('; '\);/);
  assert.ok(nextCspMatch, 'next.config.mjs phải khai CSP tường minh (trước đây KHÔNG có CSP)');
  const nextCsp = parse(nextCspMatch[1].split('\n').map((l) => l.trim().replace(/^["']|["'],?$/g, '')).join('; '));
  assert.deepStrictEqual([...nextCsp].sort(), [...vercelCsp].sort(), 'CSP của Next và Vercel phải giống hệt');
  assert.ok(vercelCsp.has("frame-ancestors 'none'"));
});

// ----------------------------------------------------------------------------------------------
console.log('\n== BUG-005: filter nén KHÔNG được nhận diện SSE bằng so sánh chuỗi tuyệt đối ==');

test('compression filter nhận diện SSE theo media type (substring, case-insensitive, chịu mảng)', () => {
  const src = read('server/app.js');
  assert.ok(!/=== 'text\/event-stream; charset=utf-8'/.test(src),
    'so sánh BẰNG chuỗi đầy đủ: đổi charset/thứ tự tham số là SSE bị nén + đệm, mất streaming trong im lặng');
  assert.ok(/ct\.includes\('text\/event-stream'\)/.test(src));
  assert.ok(/Array\.isArray\(raw\)/.test(src), 'setHeader có thể nhận mảng — phải gộp trước khi so');
});

// ----------------------------------------------------------------------------------------------
console.log('\n== BUG-006: escape HTML phải ĐẦY ĐỦ, không chỉ ký tự "<" ==');

test('không còn chỗ render nào dùng escape nửa vời .replace(/</g,"&lt;") trên dữ liệu người dùng/AI', () => {
  const app = read('public/js/app.js');
  const bad = [];
  app.split('\n').forEach((l, i) => {
    if (!l.includes("replace(/</g, '&lt;')")) return;
    if (l.includes("'&amp;'")) return; // đã escape & ở cùng chuỗi -> hợp lệ
    bad.push(`${i + 1}: ${l.trim().slice(0, 110)}`);
  });
  assert.deepStrictEqual(bad, [], 'escape thiếu & -> "&amp;"/"&lt;" có thật trong nguồn bị giải mã lại, SAI nội dung');
});

test('highlightSnippet escape trước khi bọc <span>, và không cắt vào giữa entity', () => {
  const app = read('public/js/app.js');
  const i = app.indexOf('function highlightSnippet');
  const body = app.slice(i, app.indexOf('\n}', i));
  assert.ok(body.includes('escapeHtml(snippet.slice('), 'phải escape từng mảnh văn bản thô');
  assert.ok(!/let out = escapeHtml\(snippet\);[\s\S]*out\.replace\(re/.test(body),
    'escape-rồi-highlight sẽ cho từ khoá "amp"/"quot" khớp vào giữa entity và phá ký tự gốc');
});

// ----------------------------------------------------------------------------------------------
console.log('\n== BUG-007: thiếu dependency phải là SKIPPED trung thực, không phải FAILED/PASS ==');

test('mọi test dựng Express thật đều đi qua _depGuard (hoặc tự in SKIPPED đúng dấu hiệu)', () => {
  const files = fs.readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.test.js'));
  const offenders = [];
  for (const f of files) {
    const src = read(path.join('test', f));
    const needsExpress = /require\('\.\.\/server\/(app|routes\/)/.test(src)
      || /require\('express/.test(src)
      || /require\('\.\.\/server\/middleware\/(rateLimit|security)/.test(src);
    if (!needsExpress) continue;
    const guarded = src.includes('_depGuard') || /SKIPPED — thiếu dependency/.test(src);
    if (!guarded) offenders.push(f);
  }
  assert.deepStrictEqual(offenders, [],
    'các file này sẽ ném MODULE_NOT_FOUND và bị đếm là FAILED khi chưa npm install');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
