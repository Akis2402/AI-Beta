'use strict';

// ============================================================================================
// TEST DRIVER ROTATION STORE BẰNG MOCK HTTP SERVER (sửa tồn đọng #2 của vòng trước)
// ============================================================================================
// Vòng trước tôi ghi thẳng vào phần "còn tồn tại": *"Store chưa được test với Upstash/KV thật — driver
// viết theo REST API chuẩn của họ nhưng tôi không có credential để verify"*. Không có credential thì
// vẫn verify được ĐÚNG cái đáng verify: **giao thức**. Test này dựng 1 HTTP server nói đúng phương
// ngữ REST của Upstash/Vercel KV (`GET /get/<key>`, `POST /set/<key>[/EX/<ttl>]`, `GET /incr/<key>`,
// Bearer auth) rồi chạy driver thật vào nó.
//
// Nhờ vậy bắt được đúng loại lỗi mà "đọc code rồi tin" sẽ bỏ sót: sai đường dẫn, sai method, thiếu
// header Authorization, parse sai `{"result": ...}`, không tôn trọng timeout, hoặc INCR không nguyên tử.
// Chạy: node test/rotation-store-driver.test.js

const assert = require('assert');
const http = require('http');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  -', name); }
  catch (e) { failed++; console.log(' FAIL -', name, '\n       ', e.message); }
}

const TOKEN = 'test-token-abc';

/** Mock server nói phương ngữ REST của Upstash Redis / Vercel KV. */
function startMockStore() {
  const state = { kv: new Map(), counters: new Map(), requests: [], failNext: 0, delayMs: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      state.requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });

      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
      if (state.failNext > 0) { state.failNext -= 1; res.writeHead(500); return res.end('boom'); }

      // Upstash yêu cầu Bearer token — driver sai chỗ này thì production sẽ 401 im lặng.
      if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401); return res.end('unauthorized'); }

      const parts = req.url.split('/').filter(Boolean).map(decodeURIComponent);
      const [cmd, key, ...rest] = parts;
      res.setHeader('Content-Type', 'application/json');

      if (cmd === 'get') {
        const v = state.kv.has(key) ? state.kv.get(key) : null;
        return res.end(JSON.stringify({ result: v }));
      }
      if (cmd === 'set') {
        state.kv.set(key, body);
        if (rest[0] === 'EX') state.kv.set(`${key}::ttl`, Number(rest[1]));
        return res.end(JSON.stringify({ result: 'OK' }));
      }
      if (cmd === 'incr') {
        const next = (state.counters.get(key) || 0) + 1; // nguyên tử: 1 tiến trình, 1 handler
        state.counters.set(key, next);
        return res.end(JSON.stringify({ result: next }));
      }
      res.writeHead(400);
      return res.end(JSON.stringify({ error: 'unknown cmd' }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

/**
 * Nạp rotationStore/rotationManager với env trỏ vào mock. Phải xoá require cache vì cả 2 module đọc
 * env NGAY KHI LOAD (thiết kế có chủ ý: store bật/tắt là quyết định lúc deploy, không đổi giữa runtime).
 */
function loadStoreFresh(port) {
  ['../server/utils/rotationStore', '../server/utils/rotationManager', '../server/utils/tokenCounter']
    .forEach((m) => { delete require.cache[require.resolve(m)]; });
  process.env.ROTATION_STORE_URL = `http://127.0.0.1:${port}`;
  process.env.ROTATION_STORE_TOKEN = TOKEN;
  process.env.ROTATION_STORE_KEY = 'airotation:test';
  process.env.ROTATION_STORE_WRITE_MS = '10';
  process.env.ROTATION_STORE_HYDRATE_MS = '0';
  const store = require('../server/utils/rotationStore');
  const manager = require('../server/utils/rotationManager');
  return { store, manager };
}

function clearStoreEnv() {
  delete process.env.ROTATION_STORE_URL;
  delete process.env.ROTATION_STORE_TOKEN;
  delete process.env.ROTATION_STORE_KEY;
  delete process.env.ROTATION_STORE_WRITE_MS;
  delete process.env.ROTATION_STORE_HYDRATE_MS;
  ['../server/utils/rotationStore', '../server/utils/rotationManager', '../server/utils/tokenCounter']
    .forEach((m) => { delete require.cache[require.resolve(m)]; });
}

const mkT = (id) => ({ id, keyId: id, modelId: `${id}::m`, providerKey: 'p', modelName: 'm', label: id, capabilities: {} });

async function main() {
  const { server, state, port } = await startMockStore();

  console.log('\n== Driver nói đúng giao thức REST của Upstash / Vercel KV ==');

  await test('store BẬT khi có URL + TOKEN', () => {
    const { store } = loadStoreFresh(port);
    assert.strictEqual(store.isEnabled(), true);
    assert.strictEqual(store.getStoreStats().enabled, true);
  });

  await test('reserveRotationSlot() gọi GET /incr/<key>:slot và parse {"result":n}', async () => {
    const { store } = loadStoreFresh(port);
    state.requests.length = 0;
    const a = await store.reserveRotationSlot();
    const b = await store.reserveRotationSlot();
    assert.strictEqual(typeof a, 'number');
    assert.strictEqual(b, a + 1, 'INCR phải tăng đơn điệu — đây là cơ sở của fairness toàn cục');
    const r = state.requests[0];
    assert.strictEqual(r.method, 'GET');
    assert.ok(r.url.startsWith('/incr/'), `đường dẫn phải là /incr/... (thấy ${r.url})`);
    assert.ok(r.url.includes('slot'), 'phải dùng key riêng cho bộ đếm slot');
    assert.strictEqual(r.auth, `Bearer ${TOKEN}`, 'thiếu Bearer là 401 im lặng trên production');
  });

  await test('INCR nguyên tử: 20 lượt đồng thời -> 20 slot KHÁC NHAU (không trùng)', async () => {
    const { store } = loadStoreFresh(port);
    const slots = await Promise.all(Array.from({ length: 20 }, () => store.reserveRotationSlot()));
    assert.strictEqual(new Set(slots).size, 20, `phải là 20 số duy nhất (thấy ${new Set(slots).size})`);
  });

  await test('scheduleWrite() gọi POST /set/<key>/EX/<ttl> với body JSON là snapshot', async () => {
    const { store, manager } = loadStoreFresh(port);
    state.requests.length = 0;
    manager.markSuccess(mkT('T1'), 100); // kích hoạt write-behind
    await new Promise((r) => setTimeout(r, 120));
    const setReq = state.requests.find((r) => r.url.startsWith('/set/'));
    assert.ok(setReq, 'phải có lượt POST /set');
    assert.strictEqual(setReq.method, 'POST');
    assert.ok(/\/EX\/\d+/.test(setReq.url), `phải đặt TTL (thấy ${setReq.url})`);
    const parsed = JSON.parse(setReq.body);
    assert.ok(parsed.lru && parsed.lru.T1, 'snapshot phải chứa mốc LRU');
    assert.ok(!/sk-|Bearer/i.test(setReq.body), 'snapshot không được chứa khóa API');
  });

  await test('hydrate() đọc GET /get/<key> và áp dụng cooldown từ instance khác', async () => {
    const { store, manager } = loadStoreFresh(port);
    const future = Date.now() + 60000;
    state.kv.set('airotation:test', JSON.stringify({
      v: 1, at: Date.now(), seq: 7, lru: { T1: 7 },
      key: { T2: { cooldownUntil: future } }, model: {}, target: {}
    }));
    const ok = await store.hydrate();
    assert.strictEqual(ok, true, 'hydrate phải báo thành công');
    const eligible = manager.getEligibleTargets([mkT('T1'), mkT('T2'), mkT('T3')], {});
    assert.deepStrictEqual(eligible.map((t) => t.id), ['T1', 'T3'], 'T2 phải bị loại nhờ cooldown từ store');
  });

  await test('hydrate() cũng khôi phục dữ liệu HIỆU CHỈNH TOKEN (không phải học lại sau cold start)', async () => {
    const { store } = loadStoreFresh(port);
    const tokenCounter = require('../server/utils/tokenCounter');
    tokenCounter._resetForTest();
    state.kv.set('airotation:test', JSON.stringify({
      v: 1, seq: 1, lru: {}, key: {}, model: {}, target: {},
      tokenCalib: { 'anthropic::prose': { charsPerToken: 2.4, samples: 50 } }
    }));
    await store.hydrate();
    assert.ok(Math.abs(tokenCounter.charsPerToken('anthropic', 'prose') - 2.4) < 0.01,
      'phải nhận được tỷ lệ đã hiệu chỉnh từ instance khác');
  });

  console.log('\n== Chịu lỗi: store lỗi/chậm KHÔNG BAO GIỜ làm chết request ==');

  await test('store trả 500 -> hydrate trả false, không throw', async () => {
    const { store } = loadStoreFresh(port);
    state.failNext = 1;
    const ok = await store.hydrate();
    assert.strictEqual(ok, false);
    assert.ok(store.getStoreStats().errors >= 1, 'phải ghi nhận lỗi vào telemetry');
  });

  await test('store trả 500 -> reserveRotationSlot trả null (rotation tự fallback LRU)', async () => {
    const { store } = loadStoreFresh(port);
    state.failNext = 1;
    assert.strictEqual(await store.reserveRotationSlot(), null);
  });

  await test('token sai -> 401 -> vẫn không throw, chỉ trả null/false', async () => {
    ['../server/utils/rotationStore', '../server/utils/rotationManager']
      .forEach((m) => { delete require.cache[require.resolve(m)]; });
    process.env.ROTATION_STORE_URL = `http://127.0.0.1:${port}`;
    process.env.ROTATION_STORE_TOKEN = 'wrong-token';
    process.env.ROTATION_STORE_HYDRATE_MS = '0';
    const store = require('../server/utils/rotationStore');
    require('../server/utils/rotationManager');
    assert.strictEqual(await store.reserveRotationSlot(), null);
    assert.strictEqual(await store.hydrate(), false);
  });

  await test('store treo lâu -> bị AbortController cắt, không giữ request quá lâu', async () => {
    const { store } = loadStoreFresh(port);
    state.delayMs = 2500; // > FETCH_TIMEOUT_MS (1500)
    const t0 = Date.now();
    const slot = await store.reserveRotationSlot();
    const elapsed = Date.now() - t0;
    state.delayMs = 0;
    assert.strictEqual(slot, null, 'timeout phải trả null');
    assert.ok(elapsed < 2400, `phải bị cắt trước khi server trả lời (thấy ${elapsed}ms)`);
  });

  await test('JSON hỏng từ store -> không throw', async () => {
    const { store } = loadStoreFresh(port);
    state.kv.set('airotation:test', '{{{ khong phai json');
    assert.strictEqual(await store.hydrate(), false);
  });

  console.log('\n== Fairness TOÀN CỤC thật sự (slot atomic -> round-robin xác định) ==');

  await test('slot toàn cục cho round-robin xác định, không phụ thuộc thứ tự mảng đầu vào', async () => {
    const { manager } = loadStoreFresh(port);
    const T = [mkT('T1'), mkT('T2'), mkT('T3'), mkT('T4')];
    const heads = [];
    for (let slot = 1; slot <= 8; slot++) {
      manager.setGlobalRotationSlot(slot);
      heads.push(manager.orderByRotation(T)[0].id);
    }
    assert.deepStrictEqual(heads, ['T2', 'T3', 'T4', 'T1', 'T2', 'T3', 'T4', 'T1']);
    // Đảo thứ tự mảng đầu vào -> KẾT QUẢ KHÔNG ĐỔI (vì sắp theo id trước). Nếu không có bước này,
    // 2 instance có thứ tự target khác nhau sẽ map cùng 1 slot vào 2 target khác nhau -> vỡ fairness.
    const reversed = [...T].reverse();
    const heads2 = [];
    for (let slot = 1; slot <= 8; slot++) {
      manager.setGlobalRotationSlot(slot);
      heads2.push(manager.orderByRotation(reversed)[0].id);
    }
    assert.deepStrictEqual(heads2, heads, 'cùng slot phải cho cùng target trên mọi instance');
  });

  await test('mất store giữa đường -> quay về LRU local, không hỏng gì', async () => {
    const { manager } = loadStoreFresh(port);
    manager._resetRotationStateForTest();
    manager.setGlobalRotationSlot(null); // mô phỏng INCR lỗi
    const T = [mkT('T1'), mkT('T2'), mkT('T3')];
    const heads = [];
    for (let i = 0; i < 4; i++) {
      const h = manager.orderByRotation(manager.getEligibleTargets(T, {}))[0];
      heads.push(h.id);
      manager.markSuccess(h, 50);
    }
    assert.deepStrictEqual(heads, ['T1', 'T2', 'T3', 'T1'], 'LRU local vẫn xoay công bằng');
  });

  server.close();
  clearStoreEnv();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed) process.exitCode = 1;
}

main();
