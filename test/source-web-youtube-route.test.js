'use strict';

// PROMPT V5 — PHẦN AK/AO: NỐI webSource.js/youtubeSource.js VÀO ĐƯỜNG REQUEST THẬT.
// AUDIT-REPORT-V5-TOKEN-ECONOMY.md mục 5 nói thẳng: 2 module này "chưa có route /api/source/web và
// /api/source/youtube". Bộ test này khoá đúng phần vừa nối — validator thuần chạy không cần
// `express` (môi trường sửa bài không cài được qua npm), và kiểm tra TĨNH rằng route thật sự gọi
// đúng hàm SSRF-safe/single-flight đã có, không tự viết lại logic fetch (tránh 2 nơi có 2 luật SSRF
// khác nhau — đúng nguyên tắc PHẦN AL "kiểm tra cả initial URL, redirect URL, DNS-resolved").

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { validateSourceUrlBody, ValidationError } = require('../server/utils/validators');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ok  - ' + name); passed++; }
  catch (e) { console.log(' FAIL - ' + name + '\n        ' + e.stack); failed++; }
}

console.log('\n== validateSourceUrlBody() — thuần, không I/O ==');

test('1. thiếu url -> ValidationError, không âm thầm chạy tiếp', () => {
  assert.throws(() => validateSourceUrlBody({}), ValidationError);
  assert.throws(() => validateSourceUrlBody({ url: '' }), ValidationError);
});

test('2. url hợp lệ -> trim + trả nguyên', () => {
  const out = validateSourceUrlBody({ url: '  https://example.com/bai-viet  ' });
  assert.strictEqual(out.url, 'https://example.com/bai-viet');
});

test('3. url quá dài -> bị cắt (chặn payload rác), không throw', () => {
  const longUrl = 'https://example.com/' + 'a'.repeat(3000);
  const out = validateSourceUrlBody({ url: longUrl });
  assert.ok(out.url.length <= 2000);
});

console.log('\n== Route /api/source/web + /api/source/youtube — kiểm tra TĨNH đã nối đúng module ==');

const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'sourceVision.js'), 'utf8');

test('4. route file require ĐÚNG webSource.js/youtubeSource.js đã có SSRF-safe + single-flight', () => {
  assert.ok(/require\(['"]\.\.\/utils\/source\/webSource['"]\)/.test(routeSrc));
  assert.ok(/require\(['"]\.\.\/utils\/source\/youtubeSource['"]\)/.test(routeSrc));
});

test('5. POST /web tồn tại và gọi fetchWebSource() + validateSourceUrlBody() — không tự parse HTML riêng', () => {
  const m = /router\.post\(['"]\/web['"][\s\S]{0,400}?\}\);/.exec(routeSrc);
  assert.ok(m, 'không tìm thấy handler POST /web');
  assert.ok(/validateSourceUrlBody\(req\.body\)/.test(m[0]));
  assert.ok(/fetchWebSource\(url\)/.test(m[0]));
});

test('6. POST /youtube tồn tại và gọi fetchYoutubeSource() — không tự bịa nội dung khi thiếu transcript', () => {
  const m = /router\.post\(['"]\/youtube['"][\s\S]{0,400}?\}\);/.exec(routeSrc);
  assert.ok(m, 'không tìm thấy handler POST /youtube');
  assert.ok(/validateSourceUrlBody\(req\.body\)/.test(m[0]));
  assert.ok(/fetchYoutubeSource\(url\)/.test(m[0]));
});

test('7. cả 2 route đều next(err) khi lỗi — không tự nuốt lỗi/tự trả 200 giả', () => {
  const webBlock = /router\.post\(['"]\/web['"][\s\S]{0,400}?\}\);/.exec(routeSrc)[0];
  const ytBlock = /router\.post\(['"]\/youtube['"][\s\S]{0,400}?\}\);/.exec(routeSrc)[0];
  assert.ok(/catch \(err\) \{\s*next\(err\);/.test(webBlock));
  assert.ok(/catch \(err\) \{\s*next\(err\);/.test(ytBlock));
});

test('8. app.js mount /api/source đúng router chứa 2 route mới (cùng file sourceVision.js)', () => {
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'app.js'), 'utf8');
  assert.ok(/app\.use\(['"]\/api\/source['"][\s\S]{0,80}?sourceVisionRoutes\)/.test(appSrc),
    "app.js phải mount '/api/source' bằng đúng router của sourceVision.js — nếu không, /web và /youtube 404");
});

test('9. singleFlight bọc ĐÚNG quanh lệnh gọi vision (PHẦN AU/CB/CC) — cùng 1 ảnh 2 batch đồng thời chỉ tốn 1 lệnh gọi', () => {
  const visionExtractBody = routeSrc.slice(routeSrc.indexOf("router.post('/vision-extract'"), routeSrc.indexOf("router.post('/web'"));
  assert.ok(/require\(['"]\.\.\/utils\/singleFlight['"]\)/.test(routeSrc), 'phải require singleFlight');
  assert.ok(/singleFlight\.scoped\(['"]vision['"]\)\(visionKey/.test(visionExtractBody),
    'lệnh gọi callWithFailover cho vision phải nằm trong singleFlight.scoped(\'vision\')');
  assert.ok(/contentFingerprint\(pageImg\.base64\)/.test(visionExtractBody),
    'khoá single-flight phải theo NỘI DUNG ảnh (fingerprint), không phải số trang — 2 tài liệu khác nhau có thể trùng số trang');
  // Bug đã tránh: `page` KHÔNG được nằm TRONG phần dùng chung qua single-flight (nếu không, caller
  // thứ 2 sẽ nhận nhầm số trang của caller thứ nhất khi 2 trang khác số nhưng trùng ảnh).
  const sharedBlock = /singleFlight\.scoped\(['"]vision['"]\)\(visionKey, async \(\) => \{([\s\S]*?)\}\);/.exec(visionExtractBody);
  assert.ok(sharedBlock, 'không tìm thấy thân hàm single-flight');
  assert.ok(!/page:\s*pageImg\.page/.test(sharedBlock[1]),
    '`page` phải được gắn RIÊNG cho từng caller SAU KHI single-flight trả về, không phải bên trong');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
