'use strict';

// P7 — (a) `trust proxy` đọc từ TRUST_PROXY_HOPS (không còn literal => hết cảnh báo Turbopack TP1103),
//       (b) rate limit toàn cục thực sự dùng getClientIp: giả mạo x-forwarded-for KHÔNG đổi được bucket.
// Chạy: node test/trust-proxy-config.test.js

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
// Test dựng Express THẬT -> phải qua _depGuard (quy ước BUG-007 trong audit-v6.2-regressions.test.js).
require('./_depGuard').requireDeps(['express', 'express-rate-limit'], 'trust-proxy-config');

const root = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(root, 'server/app.js'), 'utf8');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  -', name); }
  catch (e) { failed++; console.log(' FAIL -', name, '\n       ', e.message); }
}

(async () => {
  // -------------------------------------------------------------------------------- (a) cấu hình
  await test('server/app.js không còn literal app.set("trust proxy", <số>) (nguyên nhân TP1103) và đọc TRUST_PROXY_HOPS', () => {
    // Bỏ comment `//...` trước khi so khớp: chính comment giải thích trong app.js có nhắc lại literal cũ.
    const code = appSrc.replace(/\/\/[^\n]*/g, '');
    assert.ok(!/app\.set\(\s*['"]trust proxy['"]\s*,\s*(true|false|\d+)\s*\)/.test(code), 'còn literal trust proxy');
    assert.ok(/process\.env\.TRUST_PROXY_HOPS/.test(appSrc));
  });

  await test('hành vi cấu hình: mặc định 1; "0"->0; "3"->3; âm / rác / rỗng -> 1', () => {
    const express = require('express');
    const m = appSrc.match(/const trustProxyHops = [^\n]+\napp\.set\('trust proxy'[^\n]+/);
    assert.ok(m, 'không trích được 2 dòng cấu hình trust proxy');
    const code = m[0].replace(/ \/\/ cần thiết[^\n]*$/, '');
    const resolve = (env) => {
      const saved = process.env.TRUST_PROXY_HOPS;
      if (env === undefined) delete process.env.TRUST_PROXY_HOPS; else process.env.TRUST_PROXY_HOPS = env;
      const app = express();
      new Function('app', 'process', code)(app, process);
      if (saved === undefined) delete process.env.TRUST_PROXY_HOPS; else process.env.TRUST_PROXY_HOPS = saved;
      return app.get('trust proxy');
    };
    assert.strictEqual(resolve(undefined), 1);
    assert.strictEqual(resolve('0'), 0);
    assert.strictEqual(resolve('3'), 3);
    assert.strictEqual(resolve('-2'), 1);
    assert.strictEqual(resolve('abc'), 1);
    assert.strictEqual(resolve(''), 1);
  });

  // -------------------------------------------------------------------------------- (b) tích hợp rate limit
  await test('rate limit toàn cục: đổi x-forwarded-for KHÔNG đổi bucket khi có x-vercel-forwarded-for; đổi IP Vercel thì đổi bucket', async () => {
    const express = require('express');
    const kvPath = require.resolve('../server/utils/kvStore');
    const keys = new Map();
    const stub = { isEnabled: () => true, incr: async (k) => { keys.set(k, (keys.get(k) || 0) + 1); return keys.get(k); } };
    const savedKv = require.cache[kvPath];
    require.cache[kvPath] = { id: kvPath, filename: kvPath, loaded: true, exports: stub };
    delete require.cache[require.resolve('../server/middleware/rateLimit')];
    process.env.VERCEL = '1';
    const { createLimiter } = require('../server/middleware/rateLimit');

    const app = express();
    app.set('trust proxy', 1);
    app.get('/x', ...createLimiter({ name: 'itest', windowMs: 60000, max: 1000, message: { error: 'rl' } }), (req, res) => res.json({ ok: true }));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const hit = (headers) => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/x', headers }, (res) => { res.resume(); res.on('end', resolve); }).on('error', reject);
    });
    try {
      // cùng IP Vercel, 3 giá trị x-forwarded-for giả mạo khác nhau -> phải dồn vào MỘT bucket
      await hit({ 'x-vercel-forwarded-for': '203.0.113.7', 'x-forwarded-for': '1.1.1.1' });
      await hit({ 'x-vercel-forwarded-for': '203.0.113.7', 'x-forwarded-for': '2.2.2.2' });
      await hit({ 'x-vercel-forwarded-for': '203.0.113.7', 'x-forwarded-for': '3.3.3.3, 4.4.4.4' });
      const same = [...keys.entries()].filter(([k]) => k.endsWith(':203.0.113.7'));
      assert.strictEqual(same.length, 1, 'bucket bị tách theo x-forwarded-for giả mạo: ' + [...keys.keys()].join(' | '));
      assert.strictEqual(same[0][1], 3);
      // IP Vercel khác -> bucket khác
      await hit({ 'x-vercel-forwarded-for': '198.51.100.9' });
      assert.ok([...keys.keys()].some((k) => k.endsWith(':198.51.100.9')));
    } finally {
      await new Promise((r) => server.close(r));
      delete process.env.VERCEL;
      if (savedKv) require.cache[kvPath] = savedKv; else delete require.cache[kvPath];
      delete require.cache[require.resolve('../server/middleware/rateLimit')];
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
