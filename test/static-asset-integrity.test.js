'use strict';

// ---------- REGRESSION (PHẦN 10 của yêu cầu audit): "Unexpected token '<'" / HTML-thay-vì-JS ----------
// Test này dựng THẬT server/app.js (giống test/vercel-header-parity.test.js — không mock), GET
// TRỰC TIẾP các URL JS/CSS core (cả dạng có ?v=... cũ lẫn dạng đã fingerprint mới) và khẳng định
// bằng HTTP thật, không suy đoán:
//   - status === 200
//   - Content-Type chứa "javascript" (hoặc "css")
//   - body KHÔNG bắt đầu bằng "<!DOCTYPE" / "<html" (dấu hiệu server trả nhầm index.html)
//   - body chứa đúng "chữ ký" của file đó
//   - 1 URL /js/*.js KHÔNG TỒN TẠI (giả lập asset bị thiếu/gõ sai) phải trả 404 THẬT — KHÔNG được
//     rơi vào fallback trả về index.html (đây chính là lỗi kiến trúc gốc đã bị xoá khỏi server/app.js).
//
// Yêu cầu: chạy `npm run build` TRƯỚC (đúng thứ tự Vercel làm), rồi mới `npm test`. Nếu chưa build,
// test này tự SKIP (không tự ý chạy build thay người dùng, tránh mutate file ngoài ý muốn).

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';

const publicDir = path.join(__dirname, '..', 'public');
const manifestPath = path.join(publicDir, 'asset-manifest.json');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  -', name); }
  catch (e) { failed++; console.log(' FAIL -', name, '\n       ', e.stack || e.message); }
}

function get(server, urlPath) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

async function main() {
  console.log('\n== Regression PHẦN 10: JS/CSS URL phải trả đúng JS/CSS thật, KHÔNG bao giờ trả HTML ==');

  if (!fs.existsSync(manifestPath)) {
    console.log(
      '  SKIP - public/asset-manifest.json chưa tồn tại. Test này kiểm tra OUTPUT của bước build,\n' +
      '         nên cần chạy `npm run build` trước (đúng như Vercel làm trước khi deploy), rồi chạy\n' +
      '         lại `npm test`. KHÔNG tự ý chạy build ở đây để tránh mutate index.html/asset ngoài ý\n' +
      '         muốn khi ai đó chỉ chạy `npm test` trên 1 checkout chưa build.'
    );
    console.log('\n0 passed, 0 failed (skipped)');
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const app = require('../server/app');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const SIGNATURES = {
    'storage.js': 'createDocStore',
    'solid3d.js': 'ACTIVE_3D',
    'app.js': '__appBooted',
    'boot.js': "__appBooted = false",
  };

  try {
    for (const [logicalName, urlPath] of Object.entries(manifest.assets)) {
      await test(`GET ${urlPath} -> 200 + Content-Type đúng + body KHÔNG phải HTML`, async () => {
        const res = await get(server, urlPath);
        assert.strictEqual(res.status, 200, `status thực tế: ${res.status}`);
        const ct = res.headers['content-type'] || '';
        const expectType = logicalName.endsWith('.css') ? 'css' : 'javascript';
        assert.ok(ct.includes(expectType), `Content-Type thực tế: "${ct}"`);
        const head = res.body.slice(0, 30).trimStart().toLowerCase();
        assert.ok(!head.startsWith('<!doctype') && !head.startsWith('<html'),
          `body 100 ký tự đầu (đang nhận HTML thay vì ${expectType}): ${JSON.stringify(res.body.slice(0, 100))}`);
        if (SIGNATURES[logicalName]) {
          assert.ok(res.body.includes(SIGNATURES[logicalName]),
            `thiếu chữ ký "${SIGNATURES[logicalName]}" trong response body`);
        }
      });

      // Cũng thử lại với query-string kiểu cũ (?v=test123) trỏ tới CHÍNH asset đã hash — mô phỏng
      // đúng dạng URL báo lỗi gốc, xác nhận nó vẫn resolve đúng file thật (query string bị bỏ qua
      // khi match static file, không ảnh hưởng nội dung trả về).
      await test(`GET ${urlPath}?v=test123 -> vẫn trả đúng asset thật (query string không phá route)`, async () => {
        const res = await get(server, `${urlPath}?v=test123`);
        assert.strictEqual(res.status, 200);
        const head = res.body.slice(0, 30).trimStart().toLowerCase();
        assert.ok(!head.startsWith('<!doctype') && !head.startsWith('<html'));
      });
    }

    // ---------- Mô phỏng CHÍNH XÁC lỗi gốc: 1 URL JS không tồn tại (gõ sai / asset thiếu) ----------
    await test('GET /js/khong-ton-tai.js -> 404 THẬT (KHÔNG rơi vào fallback trả index.html)', async () => {
      const res = await get(server, '/js/khong-ton-tai.js');
      assert.strictEqual(res.status, 404, `status thực tế: ${res.status} (nếu 200 + trả HTML -> đúng gốc lỗi "Unexpected token '<'")`);
      const head = res.body.slice(0, 30).trimStart().toLowerCase();
      assert.ok(!head.startsWith('<!doctype') && !head.startsWith('<html'),
        'response 404 KHÔNG được là trang index.html (fallback SPA đã bị xoá khỏi server/app.js)');
    });

    await test('GET / -> 200 + Content-Type text/html + Cache-Control no-store (không giữ tham chiếu asset cũ)', async () => {
      const res = await get(server, '/');
      assert.strictEqual(res.status, 200);
      assert.ok((res.headers['content-type'] || '').includes('html'));
      assert.ok(/no-store|no-cache/.test(res.headers['cache-control'] || ''),
        `Cache-Control thực tế: "${res.headers['cache-control']}"`);
    });

    await test('index.html KHÔNG chứa 2 thẻ <script> nào trỏ cùng 1 file JS core (không load trùng)', async () => {
      const res = await get(server, '/');
      for (const logicalName of Object.keys(manifest.assets)) {
        if (!logicalName.endsWith('.js')) continue;
        const stem = logicalName.replace(/\.js$/, '');
        const re = new RegExp(`src="/js/${stem}(?:\\.[0-9a-f]{10})?\\.js[^"]*"`, 'g');
        const count = (res.body.match(re) || []).length;
        assert.strictEqual(count, 1, `${logicalName} xuất hiện ${count} lần trong index.html trả về`);
      }
    });
  } finally {
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
