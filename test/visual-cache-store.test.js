'use strict';

// ---------- A5: VISUAL CACHE PHẢI SỐNG QUA NHIỀU SERVERLESS INSTANCE ----------
// Root cause: visualCache dùng `new Map()` trong biến module -> mỗi cold start/instance trên Vercel
// là một Map RỖNG -> hit rate thật gần 0% dù logic dedupe rất kỹ. Cùng lớp vấn đề mà
// rotationStore.js đã sửa cho rotation state (xem test/pending-issues.test.js mục #3).
// Khuôn test theo đúng mẫu đó: KHÔNG cấu hình -> y hệt bản cũ; có driver -> set ở "instance A",
// get ở "instance B" phải ra đúng giá trị.

const assert = require('assert');
const cache = require('../server/utils/visual/visualCache');
const store = require('../server/utils/visual/visualCacheStore');

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, error: e.message }); }
}

const PARTS = {
  promptVersion: 'chat-prompt-v8', specFingerprint: 'spec-abc', answerStructureHash: 'ans-1',
  subject: 'math', language: 'vi', style: 'clean', renderer: 'deterministic',
  model: 'deterministic', sourceFingerprint: 's1', imageFingerprint: '', userPreference: 'auto'
};
const VALUE = { content: '<svg width="10"/>', renderer: 'deterministic', format: 'svg' };
const OK = { validated: true, answerComplete: true };

/** Driver giả mô phỏng 1 Redis dùng chung giữa các instance. */
function sharedDriver(backing) {
  return {
    async get(key) { const v = backing.get(key); return v === undefined ? null : v; },
    async set(key, value) { backing.set(key, value); }
  };
}

(async () => {
  await test('A5-1. KHÔNG cấu hình store -> hành vi Y HỆT bản cũ (in-memory, đồng bộ)', async () => {
    cache._resetForTest();
    assert.strictEqual(store.isEnabled(), false, 'mặc định phải tắt hoàn toàn');
    assert.strictEqual(cache.get(PARTS), null);
    assert.strictEqual(cache.set(PARTS, VALUE, OK), true);
    assert.ok(cache.get(PARTS), 'phải hit trong cùng instance');
    assert.strictEqual(cache.get({ ...PARTS, specFingerprint: 'khac' }), null, 'key khác -> miss');
  });

  await test('A5-2. Quality gate KHÔNG đổi: chưa validate / answer chưa COMPLETED -> không ghi', async () => {
    cache._resetForTest();
    assert.strictEqual(cache.set(PARTS, VALUE, { validated: false, answerComplete: true }), false);
    assert.strictEqual(await cache.setAsync(PARTS, VALUE, { validated: true, answerComplete: false }), false);
    assert.strictEqual(cache.get(PARTS), null);
  });

  await test('A5-3. CÓ store: set ở "instance A" -> get ở "instance B" trả ĐÚNG giá trị', async () => {
    const backing = new Map();
    // Instance A
    cache._resetForTest();
    store._setDriverForTest(sharedDriver(backing));
    assert.strictEqual(await cache.setAsync(PARTS, VALUE, OK), true);
    assert.ok(backing.size > 0, 'phải ghi được xuống store dùng chung');

    // Instance B: bộ nhớ cục bộ RỖNG hoàn toàn (mô phỏng cold start), chỉ còn store dùng chung.
    cache._resetForTest();
    store._setDriverForTest(sharedDriver(backing));
    assert.strictEqual(cache.get(PARTS), null, 'bộ nhớ cục bộ của instance mới phải rỗng');
    const hit = await cache.getAsync(PARTS);
    assert.ok(hit, 'instance B PHẢI hit qua store dùng chung — đây chính là fix A5');
    assert.strictEqual(hit.content, VALUE.content);
    store._setDriverForTest(null);
  });

  await test('A5-4. Store LỖI/timeout -> cache-miss ÊM, không throw, không hỏng pipeline hình', async () => {
    cache._resetForTest();
    store._setDriverForTest({
      async get() { throw new Error('ECONNRESET'); },
      async set() { throw new Error('ECONNRESET'); }
    });
    assert.strictEqual(await cache.getAsync(PARTS), null, 'lỗi store = miss, không throw');
    assert.strictEqual(await cache.setAsync(PARTS, VALUE, OK), true, 'ghi in-memory vẫn thành công');
    assert.ok(await cache.getAsync(PARTS), 'fallback in-memory vẫn phục vụ được');
    store._setDriverForTest(null);
  });

  await test('A5-5. Fingerprint logic KHÔNG đổi (B9.16): mọi thành phần key vẫn phân biệt đúng', async () => {
    cache._resetForTest();
    const k = cache.buildKey(PARTS);
    ['promptVersion', 'specFingerprint', 'answerStructureHash', 'subject', 'language', 'style',
      'renderer', 'model', 'sourceFingerprint', 'imageFingerprint', 'userPreference'].forEach((field) => {
      const changed = cache.buildKey({ ...PARTS, [field]: 'DOI-' + field });
      assert.notStrictEqual(changed, k, `đổi "${field}" phải ra key khác`);
    });
  });

  let p = 0, f = 0;
  console.log('\n== A5: visual cache store (cross-instance) ==');
  results.forEach((r) => {
    if (r.pass) { p++; console.log('  ok  - ' + r.name); }
    else { f++; console.log(' FAIL - ' + r.name + '\n        ' + r.error); }
  });
  console.log(`\n${p} passed, ${f} failed`);
  if (f) process.exitCode = 1;
})();
