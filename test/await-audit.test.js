'use strict';
// MỤC 2.3 — khoá audit: số await trong chat.js phải khớp AWAIT-AUDIT-chat-js.md; hydrate+reserve chạy song song.
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const root = path.join(__dirname, '..');
const tests = []; const test = (n, f) => tests.push({ n, f });

test('W1. số await trong chat.js == số dòng bảng audit (thêm await mới phải phân loại vào AWAIT-AUDIT-chat-js.md)', () => {
  const chat = fs.readFileSync(path.join(root, 'server/routes/chat.js'), 'utf8');
  const awaits = chat.split('\n').filter((l) => /await /.test(l)).length;
  const doc = fs.readFileSync(path.join(root, 'AWAIT-AUDIT-chat-js.md'), 'utf8');
  const rows = doc.split('\n').filter((l) => /^\| \d+ \| \d+ \|/.test(l)).length;
  assert.strictEqual(awaits, rows, `chat.js có ${awaits} await nhưng audit ghi ${rows}`);
});
test('W2. ensureProvidersReady: hydrate + reserveRotationSlot chạy SONG SONG (~1 RTT, không phải 2)', async () => {
  const rs = require('../server/utils/rotationStore');
  const { ensureProvidersReady } = require('../server/utils/aiProviders');
  const oh = rs.hydrate, or = rs.reserveRotationSlot; const order = [];
  rs.hydrate = async () => { order.push('h0'); await new Promise((r) => setTimeout(r, 120)); order.push('h1'); return true; };
  rs.reserveRotationSlot = async () => { order.push('r0'); await new Promise((r) => setTimeout(r, 120)); order.push('r1'); return 7; };
  try {
    const t = Date.now(); await ensureProvidersReady(); const dt = Date.now() - t;
    assert.ok(dt < 220, `tuần tự sẽ ~240ms, đo được ${dt}ms`);
    assert.deepStrictEqual(order.slice(0, 2).sort(), ['h0', 'r0'], 'cả hai phải BẮT ĐẦU trước khi cái nào xong');
    assert.ok(order.indexOf('h1') > 1 && order.indexOf('r1') > 1);
  } finally { rs.hydrate = oh; rs.reserveRotationSlot = or; }
});
test('W3. một trong hai lỗi -> không ném, vẫn chạy tiếp (giữ hành vi best-effort cũ)', async () => {
  const rs = require('../server/utils/rotationStore'); const { ensureProvidersReady } = require('../server/utils/aiProviders');
  const oh = rs.hydrate, or = rs.reserveRotationSlot;
  rs.hydrate = async () => { throw new Error('kv down'); }; rs.reserveRotationSlot = async () => { throw new Error('kv down'); };
  try { await ensureProvidersReady(); } finally { rs.hydrate = oh; rs.reserveRotationSlot = or; }
});
(async () => {
  let p = 0, f = 0;
  for (const t of tests) { try { await t.f(); p++; console.log('  ok  -', t.n); } catch (e) { f++; console.log(' FAIL -', t.n, '\n       ', e.message); } }
  console.log(`\n${p} passed, ${f} failed`); process.exit(f ? 1 : 0);
})();
