'use strict';

// Audit follow-up (V6.21.19/.87): 3 route chuẩn bị nguồn (vision-extract/web/youtube) phải xin
// priority=background từ CÙNG Global Worker Pool với '/api/chat' (priority=interactive) — nếu
// không, việc "thêm nguồn" vẫn có thể cạnh tranh không giới hạn với chat đang chờ trong cùng tiến
// trình, đúng kịch bản sự cố V6.21.19 ("YouTube indexing chiếm hết capacity, Quick chat đợi 40-60s").
require('./_depGuard').requireDeps(['express'], 'background-priority-wiring.test.js');

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const results = [];
function test(name, fn) { try { fn(); results.push({ name, pass: true }); } catch (e) { results.push({ name, pass: false, error: e.message }); } }

test('sourceVision.js load được sau khi wiring (require không throw)', () => {
  delete require.cache[require.resolve('../server/routes/sourceVision')];
  assert.doesNotThrow(() => require('../server/routes/sourceVision'));
});

test('sourceVision.js require globalWorkerPool và định nghĩa acquireBackgroundSlot()', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'sourceVision.js'), 'utf8');
  assert.ok(/require\(['"]\.\.\/utils\/globalWorkerPool['"]\)/.test(src));
  assert.ok(/async function acquireBackgroundSlot/.test(src));
  assert.ok(/priority:\s*globalWorkerPool\.PRIORITY\.BACKGROUND/.test(src), 'phải xin priority=BACKGROUND, không phải interactive');
});

['/vision-extract', '/web', '/youtube'].forEach((routePath) => {
  test(`route ${routePath} gọi acquireBackgroundSlot() TRƯỚC khi làm việc chính`, () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'sourceVision.js'), 'utf8');
    const routeIdx = src.indexOf(`router.post('${routePath}'`);
    assert.ok(routeIdx !== -1, `phải tìm thấy route ${routePath}`);
    const nextRouteIdx = src.indexOf("router.post(", routeIdx + 10);
    const block = src.slice(routeIdx, nextRouteIdx === -1 ? src.length : nextRouteIdx);
    assert.ok(/await acquireBackgroundSlot\(/.test(block), `route ${routePath} phải gọi acquireBackgroundSlot()`);
  });
});

test('acquireBackgroundSlot() release là idempotent (dùng lại release() gốc của pool, không tự tracking trùng)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'sourceVision.js'), 'utf8');
  assert.ok(/res\.on\('finish',\s*release\)/.test(src));
  assert.ok(/res\.on\('close',\s*release\)/.test(src));
});

let passed = 0, failed = 0;
console.log('\n== Regression: BACKGROUND PRIORITY WIRING (V6.21.19/.87 audit follow-up) ==');
for (const r of results) {
  if (r.pass) { passed++; console.log('  ok  - ' + r.name); }
  else { failed++; console.log('  FAIL - ' + r.name + ' :: ' + r.error); }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
