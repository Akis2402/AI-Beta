'use strict';

// PHẦN B + H + L + F — REGRESSION cho các lỗi P0/P1 của đợt audit này.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const budget = require('../server/utils/payloadBudget');
const guard = require('../server/utils/visual/visualResponseGuard');
const assetStore = require('../server/utils/visual/visualAssetStore');
const hqStore = require('../server/utils/visual/visualHqStore');
const safeHttp = require('../server/utils/safeHttp');
const { makePng } = require('./_imageFixtures');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok  - ' + name); passed++; }
  catch (e) { console.log(' FAIL - ' + name + '\n        ' + e.message); failed++; }
}

(async function main() {
  console.log('\n== PHẦN B: ảnh KHÔNG được nhồi base64 vào response JSON/SSE ==');

  await test('ảnh lớn -> response chỉ mang tham chiếu /api/visual/asset/<id>', async () => {
    assetStore._resetForTest();
    const dataUrl = 'data:image/png;base64,' + makePng(1.5 * 1024 * 1024);
    const out = await guard.externalizeVisuals([{ visualId: 'v1', format: 'data_url', url: dataUrl }]);
    const v = out.visuals[0];
    assert.strictEqual(v.format, 'asset_url');
    assert.ok(/^\/api\/visual\/asset\/[a-f0-9]{32}$/.test(v.url), 'url phải là tham chiếu, không phải base64');
    assert.ok(!/base64/.test(JSON.stringify(out.visuals)), 'response KHÔNG được còn chuỗi base64 nào');
  });

  await test('ảnh nhỏ vẫn nhúng thẳng (không tốn thêm 1 request cho 20KB)', async () => {
    const dataUrl = 'data:image/png;base64,' + makePng(8 * 1024);
    const out = await guard.externalizeVisuals([{ visualId: 'v2', format: 'data_url', url: dataUrl }]);
    assert.strictEqual(out.visuals[0].format, 'data_url');
  });

  await test('byte ảnh đọc lại được nguyên vẹn qua asset store', async () => {
    assetStore._resetForTest();
    const b64 = makePng(300 * 1024);
    const put = await assetStore.put({ mime: 'image/png', base64: b64 });
    assert.ok(put.ok && put.id);
    const got = await assetStore.get(put.id);
    assert.strictEqual(got.buffer.toString('base64'), b64);
    assert.strictEqual(got.mime, 'image/png');
  });

  await test('id asset phải ngẫu nhiên 128 bit và id sai hình dạng bị từ chối', async () => {
    const a = await assetStore.put({ mime: 'image/png', base64: makePng(1024) });
    const b = await assetStore.put({ mime: 'image/png', base64: makePng(1024) });
    assert.notStrictEqual(a.id, b.id);
    assert.strictEqual(await assetStore.get('../../etc/passwd'), null);
    assert.strictEqual(await assetStore.get('short'), null);
  });

  await test('payload cuối CHẮC CHẮN nằm dưới trần response', async () => {
    assetStore._resetForTest();
    const big = () => ({ visualId: 'v', format: 'data_url', url: 'data:image/png;base64,' + makePng(1.2 * 1024 * 1024) });
    const prepared = await guard.prepareResponsePayload({ text: 'lời giải', visuals: [big(), big(), big()] });
    assert.ok(prepared.bytes <= budget.SAFE_RESPONSE_BYTES, `payload ${prepared.bytes} vượt trần`);
    assert.ok(prepared.payload.text, 'lời giải KHÔNG được hy sinh — chỉ hình mới bị bỏ');
  });

  await test('môi trường nhiều instance + store không bền vững -> báo lỗi RÕ, không trả link chắc chắn 404', async () => {
    assetStore._resetForTest();
    process.env.VERCEL = '1';
    try {
      const dataUrl = 'data:image/png;base64,' + makePng(1024 * 1024);
      const out = await guard.externalizeVisuals([{ visualId: 'v9', format: 'data_url', url: dataUrl }]);
      assert.strictEqual(out.visuals[0].url, null);
      assert.strictEqual(out.visuals[0].format, 'unavailable');
      assert.strictEqual(out.visuals[0].error, 'image_store_not_durable');
      assert.strictEqual(out.notes[0].action, 'dropped');
    } finally { delete process.env.VERCEL; }
  });

  console.log('\n== PHẦN H: ngữ cảnh retry/HQ nói THẬT về khả năng cross-instance ==');

  await test('isDurable() phản ánh đúng việc CÓ hay KHÔNG có KV (không tuyên bố bừa)', async () => {
    const kv = require('../server/utils/kvStore');
    assert.strictEqual(hqStore.isDurable(), kv.isEnabled());
    assert.strictEqual(assetStore.isDurable(), kv.isEnabled());
  });

  await test('remember/get chỉ giữ đúng 5 field, KHÔNG giữ câu hỏi/lời giải', async () => {
    hqStore._resetForTest();
    await hqStore.remember('vz', { prompt: 'p', necessity: 'NECESSARY', subject: 's', question: 'đề bài', answer: 'lời giải' });
    const got = await hqStore.get('vz');
    assert.deepStrictEqual(Object.keys(got).sort(), ['necessity', 'prompt', 'subject', 'title', 'type']);
  });

  console.log('\n== PHẦN L: SSRF — địa chỉ nội bộ bị chặn kể cả khi hostname nằm trong whitelist ==');

  [
    '127.0.0.1', '127.255.255.254', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '192.0.0.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'ff02::1', 'not-an-ip'
  ].forEach((addr) => {
    test(`chặn địa chỉ nội bộ/đặc biệt: ${addr}`, () => {
      assert.strictEqual(safeHttp.isBlockedAddress(addr), true);
    });
  });

  ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'].forEach((addr) => {
    test(`cho phép địa chỉ công khai: ${addr}`, () => {
      assert.strictEqual(safeHttp.isBlockedAddress(addr), false);
    });
  });

  await test('route download dùng fetchPinned (ghim IP) chứ KHÔNG dùng fetch() trần', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'visual.js'), 'utf8');
    assert.ok(/safeHttp\.fetchPinned/.test(src), 'phải đi qua trình tải đã kiểm DNS + ghim IP');
    assert.ok(!/await fetch\(/.test(src), 'không được còn fetch() trần trong route proxy ảnh');
  });

  // BUG-007: CHỈ assertion này cần `express` thật (nó require server/routes/visual.js). 36 assertion
  // còn lại của file KHÔNG cần, nên guard cả file bằng _depGuard sẽ mất trắng 36 phép kiểm tra thật.
  // Thay vào đó: thiếu express -> in ĐÚNG dấu hiệu SKIPPED mà test/run-all.js nhận diện, để file
  // được đếm là SKIPPED (CHƯA CHẠY) chứ không phải FAILED-do-môi-trường và cũng KHÔNG phải PASS.
  let hasExpress = true;
  try { require.resolve('express'); } catch (e) { hasExpress = false; }
  if (!hasExpress) {
    console.log('  SKIPPED — thiếu dependency: express (chỉ ảnh hưởng phép kiểm tra whitelist host bên dưới)');
    console.log('  Chạy `npm install` rồi chạy lại — SKIPPED KHÔNG được tính là PASS.');
  }
  await test('whitelist host vẫn bắt buộc, và không đọc từ env (env đổi = mở toang SSRF)', () => {
    if (!hasExpress) return; // đã báo SKIPPED ở trên; không giả vờ pass, harness đánh dấu cả file là SKIPPED
    const route = require('../server/routes/visual.js');
    assert.strictEqual(route.parseAllowedUrl('https://evil.com/a.png'), null);
    assert.strictEqual(route.parseAllowedUrl('http://cdn.openai.com/a.png'), null, 'chỉ https');
    assert.strictEqual(route.parseAllowedUrl('file:///etc/passwd'), null);
    assert.ok(route.parseAllowedUrl('https://cdn.openai.com/a.png'));
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'visual.js'), 'utf8');
    const hostBlock = src.slice(src.indexOf('const ALLOWED_HOSTS'), src.indexOf('const MAX_BYTES'));
    assert.ok(!/process\.env/.test(hostBlock), 'whitelist không được đọc từ env');
  });

  console.log('\n== PHẦN F: thứ tự body-parser — trần khai ra phải là trần THẬT ==');

  await test('KHÔNG còn express.json toàn cục', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'app.js'), 'utf8');
    assert.ok(!/app\.use\(express\.json\(/.test(src),
      'parser toàn cục làm mọi trần khai ở route con trở nên vô nghĩa (lớp bảo vệ chết)');
  });

  await test('mỗi nhóm route có trần riêng, route ảnh nhỏ giữ 4kb', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'server', 'app.js'), 'utf8');
    const visual = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'visual.js'), 'utf8');
    assert.ok(/jsonLarge/.test(app) && /jsonSmall/.test(app));
    assert.ok(/'\/api\/visual'[^\n]*visualRoutes/.test(app) && !/'\/api\/visual', [^\n]*jsonLarge/.test(app),
      '/api/visual không được nhận parser lớn ở tầng app');
    assert.ok(/express\.json\(\{ limit: '4kb' \}\)/.test(visual), '/hq và /retry giữ trần 4kb');
  });

  await test('client disconnect KHÔNG được suy ra từ req.on("close") (root cause bug CANCELLED)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'chat.js'), 'utf8')
      .replace(/\/\/.*$/gm, '');
    assert.ok(!/req\.on\('close'/.test(src),
      'req "close" phát ngay sau khi đọc xong thân request -> mọi POST bị coi là bị huỷ');
    assert.ok(/res\.on\('close'/.test(src), 'phải dùng "close" của response');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
