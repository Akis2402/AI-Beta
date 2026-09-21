'use strict';

// BUG-007: file test này require gián tiếp `express`/`dotenv` THẬT. Khi chưa `npm install` (máy mới
// clone, sandbox không có mạng), trước đây nó ném MODULE_NOT_FOUND và harness đếm là FAILED — một
// "FAIL" hoàn toàn do môi trường, che mất kết quả thật và làm người đọc tưởng code hỏng. Dùng đúng
// cơ chế đã có sẵn của repo (test/_depGuard.js): in SKIPPED trung thực + tên gói còn thiếu.
// KHÔNG assertion nào bị nới lỏng hay bỏ đi: khi dependency có mặt, file chạy y như cũ.
require('./_depGuard').requireDeps(['express-rate-limit'], 'rate-limit-scope.test.js');

// PHẦN J + I + K — REGRESSION: hệ thống phải NÓI THẬT trạng thái nào là toàn cục, trạng thái nào
// chỉ sống trong 1 instance. Bug lớp này không làm sập gì cả — nó chỉ khiến người vận hành tin vào
// một giới hạn không tồn tại.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok  - ' + name); passed++; }
  catch (e) { console.log(' FAIL - ' + name + '\n        ' + e.message); failed++; }
}

(async function main() {
  const limiter = require('../server/middleware/rateLimit');
  const kv = require('../server/utils/kvStore');

  console.log('\n== PHẦN J: rate limit ==');

  await test('không có KV -> scope báo "instance", KHÔNG giả vờ toàn cục', async () => {
    assert.strictEqual(limiter.isGlobalScope(), kv.isEnabled());
    const [globalMw] = limiter.createLimiter({ name: 't', windowMs: 1000, max: 2, message: {} });
    const headers = {};
    const res = { setHeader: (k, v) => { headers[k] = v; }, status: () => res, json: () => res };
    await new Promise((r) => globalMw({ ip: '1.2.3.4', headers: {} }, res, r));
    assert.strictEqual(headers['X-RateLimit-Scope'], kv.isEnabled() ? 'global' : 'instance');
  });

  await test('khoá đếm gắn với CỬA SỔ thời gian (không phải bộ đếm vĩnh viễn)', () => {
    const k1 = limiter.bucketKey('chat', '1.2.3.4', 1000);
    assert.ok(/^rl:chat:\d+:1\.2\.3\.4$/.test(k1));
    assert.notStrictEqual(limiter.bucketKey('chat', '1.2.3.4', 1000), limiter.bucketKey('chat', '1.2.3.4', 2000));
  });

  await test('khoá đếm KHÔNG chứa nội dung câu hỏi hay bất kỳ dữ liệu người dùng nào khác', () => {
    assert.ok(!/query|prompt|content/i.test(limiter.bucketKey('chat', '1.2.3.4', 1000)));
  });

  await test('tầng cục bộ LUÔN tồn tại làm lưới an toàn khi KV lỗi', () => {
    const chain = limiter.createLimiter({ name: 'x', windowMs: 1000, max: 1, message: {} });
    assert.strictEqual(chain.length, 2, 'phải có cả tầng toàn cục và tầng cục bộ');
  });

  await test('mọi endpoint tốn tiền AI đều đi qua limiter', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'server', 'app.js'), 'utf8');
    ['/api/chat', '/api/generate', '/api/recommend', '/api/study', '/api/visual', '/api/source'].forEach((route) => {
      const line = app.split('\n').find((l) => l.includes(`app.use('${route}'`));
      assert.ok(line && /Limiter/.test(line), `${route} phải có rate limit`);
    });
  });

  console.log('\n== PHẦN I: recommend cache phân tầng trung thực ==');

  await test('tiers() báo đúng L1 hay L1+L2 theo cấu hình thật', () => {
    const { createRecommendCache } = require('../server/utils/recommendCache');
    const noL2 = createRecommendCache({ l2: false });
    assert.strictEqual(noL2.tiers(), 'L1');
    const withL2 = createRecommendCache({ l2: { isEnabled: () => true, get: async () => null, set: async () => true } });
    assert.strictEqual(withL2.tiers(), 'L1+L2');
  });

  await test('L2 lỗi KHÔNG làm hỏng request (best-effort thật sự)', async () => {
    const { createRecommendCache } = require('../server/utils/recommendCache');
    const broken = createRecommendCache({
      l2: { isEnabled: () => true, get: async () => { throw new Error('kv down'); }, set: async () => { throw new Error('kv down'); } }
    });
    assert.strictEqual(await broken.getAsync('abc'), null);
    assert.strictEqual(await broken.setAsync('abc', { a: 1 }), false);
    assert.deepStrictEqual(broken.get('abc'), { a: 1 }, 'L1 vẫn phải được ghi dù L2 hỏng');
  });

  await test('cache key đổi theo promptVersion (đổi prompt tự vô hiệu cache cũ)', () => {
    const { createRecommendCache } = require('../server/utils/recommendCache');
    const a = createRecommendCache({ promptVersion: 'v1', l2: false });
    const b = createRecommendCache({ promptVersion: 'v2', l2: false });
    assert.notStrictEqual(a.keyFor('x'), b.keyFor('x'));
  });

  console.log('\n== PHẦN K: phân loại trạng thái rotation ==');

  await test('không có dữ liệu load-bearing nào nằm trong đường write-behind/unref', () => {
    const store = require('../server/utils/rotationStore');
    assert.ok(store.STATE_CLASSIFICATION.advisory.length > 0);
    assert.deepStrictEqual(store.STATE_CLASSIFICATION.loadBearing, ['rotationSlot']);
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'utils', 'rotationStore.js'), 'utf8');
    const slotFn = src.slice(src.indexOf('async function reserveRotationSlot'), src.indexOf('let extraSnapshotProviders'));
    assert.ok(/await restFetch\(\['incr'/.test(slotFn), 'slot phải cấp bằng INCR nguyên tử và ĐƯỢC await');
    assert.ok(!/unref/.test(slotFn), 'đường load-bearing không được phụ thuộc unref()');
  });

  await test('flush() ép ghi ngay (dùng cho môi trường chạy dài/test), không dùng trong request nóng', () => {
    const store = require('../server/utils/rotationStore');
    assert.strictEqual(typeof store.flush, 'function');
    const chat = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'chat.js'), 'utf8');
    assert.ok(!/rotationStore\.flush|\.flush\(\)/.test(chat), 'không thêm 1 lượt đi mạng vào đường request cho dữ liệu advisory');
  });

  console.log('\n== PHẦN N: runtime được pin và kiểm chứng được sau deploy ==');

  await test('engines pin rõ ràng, không còn ">=18"', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.ok(!/^>=18/.test(pkg.engines.node), 'phải pin phiên bản cụ thể, không mở tới mọi bản >=18');
    assert.ok(/22/.test(pkg.engines.node));
    assert.ok(pkg.scripts['test:ci'], 'phải có chế độ CI nghiêm ngặt');
    assert.ok(/build/.test(pkg.scripts['test:ci']),
      'CI phải BUILD trước khi test — nếu không, test static-asset sẽ SKIP và CI báo FAIL đúng như thiết kế');
  });

  await test('/api/health trả process.version để kiểm chứng runtime THẬT sau deploy', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'app.js'), 'utf8');
    assert.ok(/nodeVersion: process\.version/.test(src));
  });

  await test('vercel.json KHÔNG còn rewrite gộp /api/* về /api (path preservation qua App Router V5)', () => {
    // V5 MIGRATION: file-based `api/[...path].js` + `api/index.js` (Vercel legacy file routing) đã
    // được thay bằng App Router `app/api/[...path]/route.ts` + các route handler cụ thể trong
    // `app/api/**` — cùng đảm bảo path preservation (Next chuyển req.url thẳng vào handler, không
    // rewrite ngầm). `vercel.json.functions` block cũng đã bị xoá vì framework: nextjs tự quản
    // serverless boundary. Test này bám vào bất biến: KHÔNG có rewrites gộp + KHÔNG có functions
    // block cũ + PHẢI tồn tại catch-all App Router bảo toàn subpath.
    const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
    assert.ok(!vercel.rewrites, 'không được có rewrites gộp /api/* — App Router giữ nguyên req.url');
    assert.ok(!vercel.functions, 'không được còn functions block trỏ tới api/*.js đã xoá');
    assert.ok(vercel.framework === 'nextjs', 'framework phải là nextjs để Vercel dùng Next runtime');
    assert.ok(
      fs.existsSync(path.join(__dirname, '..', 'app', 'api', '[...path]', 'route.ts')),
      'phải có App Router catch-all bảo toàn subpath (thay cho api/[...path].js cũ)'
    );
    assert.ok(
      fs.existsSync(path.join(__dirname, '..', 'app', 'api', 'chat', 'route.ts')),
      'các route handler /api/* cụ thể phải tồn tại trong app/api/** (thay cho api/index.js cũ)'
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
