'use strict';

const fs = require('fs');
const path = require('path');
// ---------- REGRESSION: FINAL AUDIT section N — Vercel vs local Express header parity ----------
// Phát hiện qua scripts/smoke-test.js chạy trên local server THẬT (không phải suy đoán tĩnh):
// vercel.json khai báo tường minh X-Frame-Options: DENY cho response Vercel, nhưng khi chạy qua
// Express thuần (local `npm start`, hoặc deploy ngoài Vercel như Railway/Render/Fly.io — README có
// đề cập các lựa chọn này) Helmet mặc định trả SAMEORIGIN vì helmetConfig chưa khai báo frameguard
// tường minh -> 2 môi trường lệch nhau, đúng cảnh báo "không giả định local Express behavior luôn
// giống Vercel Function behavior" của mục N. Test này dựng THẬT server/app.js trên 1 cổng ngẫu
// nhiên (không mock) và gọi HTTP thật để xác nhận song song, không suy đoán từ mã nguồn.

const assert = require('assert');
const http = require('http');

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';

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
  console.log('\n== Regression P2/N: local Express server phải cùng security header với vercel.json ==');
  const app = require('../server/app');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    await test('X-Frame-Options: DENY trên local Express (khớp vercel.json, không phải SAMEORIGIN mặc định của Helmet)', async () => {
      const res = await get(server, '/api/health');
      assert.strictEqual(res.headers['x-frame-options'], 'DENY');
    });

    await test('Content-Security-Policy có frame-ancestors none (lớp phòng thủ chính, X-Frame-Options chỉ là dự phòng)', async () => {
      const res = await get(server, '/api/health');
      const csp = res.headers['content-security-policy'] || '';
      assert.ok(/frame-ancestors\s+'none'/.test(csp));
    });

    await test('Permissions-Policy có mặt trên local Express (khớp vercel.json)', async () => {
      const res = await get(server, '/api/health');
      assert.ok(!!res.headers['permissions-policy']);
    });

    // PHẦN E mục 21: hai nơi set Permissions-Policy (Express + Vercel edge). Nếu chúng lệch nhau,
    // microphone sẽ chạy ở local nhưng CHẾT trên production (hoặc ngược lại) — đúng lớp lỗi mà
    // người dùng không thể tự chẩn đoán. Test này khoá parity BYTE-FOR-BYTE.
    await test('Permissions-Policy KHỚP CHÍNH XÁC giữa Express và vercel.json (không được lệch)', async () => {
      const res = await get(server, '/api/health');
      const live = String(res.headers['permissions-policy'] || '');
      const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
      const rule = vercel.headers.find((h) => h.source === '/(.*)');
      const declared = (rule.headers.find((h) => h.key === 'Permissions-Policy') || {}).value || '';
      assert.strictEqual(live, declared,
        `lệch header: Express="${live}" vs vercel.json="${declared}"`);
    });

    await test('Permissions-Policy cho phép microphone=(self) và KHÔNG mở cho origin khác', async () => {
      const res = await get(server, '/api/health');
      const policy = String(res.headers['permissions-policy'] || '');
      assert.ok(/microphone=\(self\)/.test(policy), `Voice Input cần microphone=(self), thực tế "${policy}"`);
      assert.ok(!/microphone=\*/.test(policy), 'KHÔNG được mở microphone cho mọi origin');
      assert.ok(/camera=\(\)/.test(policy), 'camera vẫn phải bị chặn tuyệt đối');
    });

    await test('Strict-Transport-Security có mặt (Helmet mặc định bật HSTS)', async () => {
      const res = await get(server, '/api/health');
      assert.ok(!!res.headers['strict-transport-security']);
    });
  } finally {
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
