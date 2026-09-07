'use strict';

// ---------- REGRESSION: /api/recommend PHẢI CACHE, KHÔNG GỌI AI THÊM Ý MUỐN (mục PHẦN 17) ----------
// BUG GỐC: recommend.js hoàn toàn KHÔNG có cache — mỗi lượt bấm mở khung "Đề xuất ôn tập" (kể cả 2
// lần liên tiếp với ĐÚNG 1 câu hỏi) đều gọi lại AI + web search từ đầu. FIX: createRecommendCache()
// (server/utils/recommendCache.js, không phụ thuộc express — test trực tiếp không cần node_modules)
// cache theo normalized query + prompt version, TTL 30 phút mặc định.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createRecommendCache } = require('../server/utils/recommendCache');

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, error: e.message }); }
}

test('cache miss trả về null (chưa từng lưu)', () => {
  const cache = createRecommendCache();
  assert.strictEqual(cache.get('đạo hàm của x^2'), null);
});

test('set() rồi get() cùng query trả về đúng giá trị đã lưu (không gọi AI lại)', () => {
  const cache = createRecommendCache();
  const payload = { topic: 'Đạo hàm', links: [{ url: 'https://a.com' }], source: 'ai' };
  cache.set('Đạo hàm của x^2', payload);
  assert.deepStrictEqual(cache.get('đạo hàm của x^2'), payload);
});

test('normalize query: khoảng trắng thừa/hoa-thường không tạo cache miss giả', () => {
  const cache = createRecommendCache();
  const payload = { topic: 't', links: [], source: 'fallback' };
  cache.set('  Tích   Phân  Từng  Phần  ', payload);
  assert.deepStrictEqual(cache.get('tích phân từng phần'), payload);
  assert.deepStrictEqual(cache.get('TÍCH PHÂN TỪNG PHẦN'), payload);
});

test('query khác nhau không collision (không trả nhầm kết quả)', () => {
  const cache = createRecommendCache();
  cache.set('đạo hàm', { topic: 'A', links: [], source: 'ai' });
  cache.set('tích phân', { topic: 'B', links: [], source: 'ai' });
  assert.strictEqual(cache.get('đạo hàm').topic, 'A');
  assert.strictEqual(cache.get('tích phân').topic, 'B');
});

test('đổi promptVersion -> cache cũ tự invalidate (không trả nhầm kết quả của prompt phiên bản khác, mục 20)', () => {
  const cacheV1 = createRecommendCache({ promptVersion: 'v1' });
  const cacheV2 = createRecommendCache({ promptVersion: 'v2' });
  cacheV1.set('q', { topic: 'v1-result', links: [], source: 'ai' });
  assert.strictEqual(cacheV2.get('q'), null, 'prompt version khác -> không dùng chung cache');
});

test('chặn trần maxEntries — Map không phình vô hạn', () => {
  const cache = createRecommendCache({ maxEntries: 3 });
  for (let i = 0; i < 10; i++) cache.set(`q${i}`, { topic: `t${i}`, links: [], source: 'ai' });
  assert.ok(cache.size() <= 3, `size (${cache.size()}) phải <= maxEntries (3)`);
});

// ---------- Static: recommend.js thực sự dùng cache TRƯỚC khi gọi fetchAiLinks (CACHE BEFORE CALL) ----------
const recommendSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'recommend.js'), 'utf8');

test('recommend.js check cache TRƯỚC lệnh gọi fetchAiLinks() (cache-before-call, không phải sau)', () => {
  const idxCacheCheck = recommendSrc.indexOf('recommendCache.get(query)');
  const idxFetchAi = recommendSrc.indexOf('await fetchAiLinks(query)');
  assert.ok(idxCacheCheck > 0 && idxFetchAi > 0, 'phải tìm thấy cả 2 dòng');
  assert.ok(idxCacheCheck < idxFetchAi, 'kiểm tra cache PHẢI đứng trước lệnh gọi AI, không phải ngược lại');
});

test('recommend.js return sớm khi cache hit (không rơi tiếp xuống fetchAiLinks)', () => {
  assert.ok(/if \(cached\) return res\.json\(\{ \.\.\.cached, fromCache: true \}\);/.test(recommendSrc), 'cache hit phải return ngay, không tiếp tục gọi AI');
});

test('recommend.js dùng createRecommendCache() thật (không phải Map trần không TTL)', () => {
  assert.ok(recommendSrc.includes("require('../utils/recommendCache')"), 'phải require module cache thật');
  assert.ok(recommendSrc.includes('createRecommendCache('), 'phải khởi tạo cache qua createRecommendCache()');
});

let passed = 0, failed = 0;
console.log('\n== Regression: /api/recommend CACHE BEFORE CALL (mục PHẦN 17) ==');
for (const r of results) {
  if (r.pass) { passed++; console.log('  ok  - ' + r.name); }
  else { failed++; console.log('  FAIL - ' + r.name + ' :: ' + r.error); }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
