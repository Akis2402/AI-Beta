'use strict';

// ---------- REGRESSION: REQUEST DEADLINE PHẢI TÍNH TỪ ĐẦU (mục PHẦN 13) ----------
// BUG GỐC: createRequestDeadline() được gọi SAU ensureProvidersReady() (model discovery) + body
// validation + nén ngữ cảnh — thời gian discovery không bị tính vào đồng hồ chung của request, nên
// globalDeadline.remaining() ở các bước sau "được tặng không" thêm thời gian đã mất ở discovery.
// FIX: createRequestDeadline() phải đứng TRƯỚC ensureProvidersReady() trong chat.js.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, error: e.message }); }
}

const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'chat.js'), 'utf8');

test('createRequestDeadline() xuất hiện TRƯỚC ensureProvidersReady() trong chat.js (deadline tính cả thời gian discovery)', () => {
  const idxDeadline = chatSrc.indexOf('createRequestDeadline(GLOBAL_REQUEST_DEADLINE_MS)');
  const idxDiscovery = chatSrc.indexOf('await ensureProvidersReady()');
  assert.ok(idxDeadline > 0, 'phải tìm thấy createRequestDeadline(GLOBAL_REQUEST_DEADLINE_MS)');
  assert.ok(idxDiscovery > 0, 'phải tìm thấy await ensureProvidersReady()');
  assert.ok(idxDeadline < idxDiscovery, 'globalDeadline PHẢI được tạo TRƯỚC discovery, không phải sau');
});

test('chỉ có đúng 1 lần tạo globalDeadline trong toàn route (không tạo lại đồng hồ mới giữa chừng)', () => {
  const count = (chatSrc.match(/createRequestDeadline\(GLOBAL_REQUEST_DEADLINE_MS\)/g) || []).length;
  assert.strictEqual(count, 1, `phải có đúng 1 lần tạo globalDeadline, thấy ${count}`);
});

let passed = 0, failed = 0;
console.log('\n== Regression: REQUEST DEADLINE tính từ đầu, bao gồm discovery (mục PHẦN 13) ==');
for (const r of results) {
  if (r.pass) { passed++; console.log('  ok  - ' + r.name); }
  else { failed++; console.log('  FAIL - ' + r.name + ' :: ' + r.error); }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
