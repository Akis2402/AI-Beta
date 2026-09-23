'use strict';

// Regression cho Global Worker Pool (V6.21.18/.19/.20) — thuần logic, không cần API key/mạng.
const assert = require('assert');
const { createGlobalWorkerPool, PRIORITY } = require('../server/utils/globalWorkerPool');

const results = [];
function test(name, fn) { results.push({ name, fn }); }

test('acquire() admit ngay khi còn chỗ, snapshot phản ánh đúng', async () => {
  const pool = createGlobalWorkerPool({ globalCapacity: 4, interactiveReserve: 2 });
  const release = await pool.acquire({ priority: PRIORITY.INTERACTIVE });
  assert.strictEqual(pool.snapshot().activeInteractive, 1);
  release();
  assert.strictEqual(pool.snapshot().activeInteractive, 0);
});

test('V6.21.20: background KHÔNG được vượt (globalCapacity - interactiveReserve) dù interactive đang rảnh', async () => {
  const pool = createGlobalWorkerPool({ globalCapacity: 5, interactiveReserve: 2 });
  // backgroundCapacity = 5-2 = 3. Chiếm đủ 3 slot background.
  const releases = [];
  for (let i = 0; i < 3; i++) releases.push(await pool.acquire({ priority: PRIORITY.BACKGROUND }));
  assert.strictEqual(pool.snapshot().activeBackground, 3);
  // Slot thứ 4 background phải BỊ CHẶN dù activeTotal(3) < globalCapacity(5) — còn 2 chỗ trống
  // nhưng đó là phần RESERVE cho interactive, background không được đụng vào.
  let admitted = false;
  const p = pool.acquire({ priority: PRIORITY.BACKGROUND, timeoutMs: 50 }).then(() => { admitted = true; }).catch(() => {});
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(admitted, false, 'background thứ 4 không được admit khi đã chạm backgroundCapacity');
  releases.forEach((r) => r());
  await p;
});

test('V6.21.19: interactive đang chờ được admit TRƯỚC background đang chờ (dù background xếp hàng trước)', async () => {
  const pool = createGlobalWorkerPool({ globalCapacity: 1, interactiveReserve: 1 });
  const releaseFirst = await pool.acquire({ priority: PRIORITY.INTERACTIVE }); // chiếm slot duy nhất
  const order = [];
  const bgPromise = pool.acquire({ priority: PRIORITY.BACKGROUND, timeoutMs: 2000 }).then((rel) => { order.push('background'); rel(); });
  await new Promise((r) => setTimeout(r, 10)); // đảm bảo background xếp hàng TRƯỚC
  const itPromise = pool.acquire({ priority: PRIORITY.INTERACTIVE, timeoutMs: 2000 }).then((rel) => { order.push('interactive'); rel(); });
  await new Promise((r) => setTimeout(r, 10));
  releaseFirst(); // nhả slot — cả 2 đang chờ, phải chọn interactive trước
  await Promise.race([Promise.all([bgPromise, itPromise]), new Promise((r) => setTimeout(r, 500))]);
  assert.strictEqual(order[0], 'interactive', `interactive phải được admit trước, thực tế: ${order.join(',')}`);
});

test('acquire() với timeoutMs hết hạn -> reject với code WORKER_POOL_TIMEOUT, status 503', async () => {
  const pool = createGlobalWorkerPool({ globalCapacity: 1, interactiveReserve: 1 });
  const release = await pool.acquire({ priority: PRIORITY.INTERACTIVE });
  try {
    await pool.acquire({ priority: PRIORITY.INTERACTIVE, timeoutMs: 30 });
    assert.fail('phải reject khi hết timeout');
  } catch (e) {
    assert.strictEqual(e.code, 'WORKER_POOL_TIMEOUT');
    assert.strictEqual(e.status, 503);
  } finally {
    release();
  }
});

test('release() gọi 2 lần (idempotent) không làm active đếm âm', async () => {
  const pool = createGlobalWorkerPool({ globalCapacity: 2, interactiveReserve: 1 });
  const release = await pool.acquire({ priority: PRIORITY.INTERACTIVE });
  release(); release(); release();
  assert.strictEqual(pool.snapshot().activeInteractive, 0);
});

test('createGlobalWorkerPool throw khi interactiveReserve > globalCapacity', () => {
  assert.throws(() => createGlobalWorkerPool({ globalCapacity: 2, interactiveReserve: 5 }));
});

test('wiring: chat.js require globalWorkerPool, acquire() priority=interactive, release hooked qua res.on(finish/close)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'chat.js'), 'utf8');
  assert.ok(/require\(['"]\.\.\/utils\/globalWorkerPool['"]\)/.test(src), 'phải require globalWorkerPool');
  assert.ok(/globalWorkerPool\.defaultPool\.acquire\(/.test(src), 'phải gọi defaultPool.acquire()');
  assert.ok(/priority:\s*globalWorkerPool\.PRIORITY\.INTERACTIVE/.test(src), 'route chat phải xin priority=interactive');
  assert.ok(/res\.on\('finish',\s*\(\)\s*=>\s*\{\s*if\s*\(releasePoolSlot\)\s*releasePoolSlot\(\)/.test(src), 'phải nhả slot khi response finish');
  assert.ok(/res\.on\('close',\s*\(\)\s*=>\s*\{\s*if\s*\(releasePoolSlot\)\s*releasePoolSlot\(\)/.test(src), 'phải nhả slot khi response close (guard cả trường hợp lỗi/client ngắt kết nối)');
});

(async () => {
  let passed = 0, failed = 0;
  console.log('\n== Regression: GLOBAL WORKER POOL (V6.21.18/.19/.20) ==');
  for (const { name, fn } of results) {
    try { await fn(); passed++; console.log('  ok  - ' + name); }
    catch (e) { failed++; console.log('  FAIL - ' + name + ' :: ' + (e && e.message)); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
