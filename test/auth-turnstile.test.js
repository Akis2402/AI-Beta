'use strict';
// ---------- Cloudflare Turnstile: server phải TỰ xác minh token (siteverify), không tin client ----------
// siteverify được GIẢ LẬP bằng cách thay global.fetch (chỉ chặn challenges.cloudflare.com). Không cần mạng.
// Chạy: node test/auth-turnstile.test.js
process.env.SUPABASE_URL = 'https://proj.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
process.env.RATE_LIMIT_AUTH = '1000';
process.env.RATE_LIMIT_SIGNUP = '1000';
process.env.RATE_LIMIT_FORGOT = '1000';
delete process.env.TURNSTILE_SECRET_KEY;

const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');

const powPath = require.resolve('../server/utils/auth/pow');
require(powPath);
require.cache[powPath].exports = Object.assign({}, require.cache[powPath].exports, { verify: async () => ({ ok: true }) });

const realFetch = global.fetch;
const verifyCalls = [];
let cfReply; // () => Response | throws
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://challenges.cloudflare.com/turnstile/v0/siteverify')) {
    verifyCalls.push({ method: opts.method, body: Object.fromEntries(new URLSearchParams(String(opts.body))) });
    return cfReply();
  }
  if (u.startsWith('https://proj.supabase.co')) {
    if (u.includes('/token?grant_type=password')) return json(200, { access_token: 'a.b.c', refresh_token: 'r', expires_in: 3600, user: { id: 'u1' } });
    if (u.includes('/auth/v1/signup')) return json(200, { id: 'u2' });
    if (u.includes('/auth/v1/recover')) return json(200, {});
    return json(404, {});
  }
  return realFetch(url, opts);
};

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('  ok  - ' + msg); } else { failed++; console.log('  FAIL - ' + msg); } }

const app = express();
app.use('/api/auth', require('../server/routes/auth.js'));
const srv = http.createServer(app);
function post(port, p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const rq = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (r) => {
      let s = ''; r.on('data', (c) => { s += c; });
      r.on('end', () => { let j = {}; try { j = JSON.parse(s); } catch (_) { /* không phải JSON */ } resolve({ status: r.statusCode, json: j, cookies: [].concat(r.headers['set-cookie'] || []) }); });
    });
    rq.on('error', reject); rq.end(data);
  });
}
const TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
const login = (port, extra) => post(port, '/api/auth/login', { email: 'a@b.co', password: 'abcdefg1', ...extra });

srv.listen(0, async () => {
  const port = srv.address().port;

  console.log('\n== Chưa đặt TURNSTILE_SECRET_KEY: không bắt buộc (dev/CI không bị khoá) ==');
  let r = await login(port, {});
  ok(r.status === 200 && verifyCalls.length === 0, 'đăng nhập chạy bình thường, không gọi Cloudflare');

  console.log('\n== Đã đặt secret: bắt buộc, fail-closed ==');
  process.env.TURNSTILE_SECRET_KEY = '1x0000000000000000000000000000000AA';
  cfReply = () => json(200, { success: true, action: 'auth', hostname: 'app.example.com' });
  verifyCalls.length = 0;
  r = await login(port, {});
  ok(r.status === 400 && r.json.code === 'captcha_failed' && verifyCalls.length === 0, 'thiếu token => 400 captcha_failed, KHÔNG gọi Cloudflare, KHÔNG gọi Supabase');
  r = await login(port, { turnstileToken: 'x'.repeat(2049) });
  ok(r.status === 400 && r.json.code === 'captcha_failed' && verifyCalls.length === 0, 'token > 2048 ký tự bị chặn trước khi gọi mạng');
  r = await login(port, { turnstileToken: { $ne: 1 } });
  ok(r.status === 400 && r.json.code === 'captcha_failed', 'token kiểu object bị từ chối');
  r = await login(port, { turnstileToken: 'có khoảng trắng & ký tự lạ' });
  ok(r.status === 400 && verifyCalls.length === 0, 'token sai định dạng bị chặn trước khi gọi mạng');

  r = await login(port, { turnstileToken: TOKEN });
  ok(r.status === 200 && r.json.status === 'authenticated', 'token hợp lệ => đăng nhập thành công');
  ok(verifyCalls.length === 1 && verifyCalls[0].method === 'POST', 'gọi siteverify đúng 1 lần bằng POST');
  ok(verifyCalls[0].body.secret === '1x0000000000000000000000000000000AA' && verifyCalls[0].body.response === TOKEN, 'gửi đúng secret + response dạng form');
  ok(!JSON.stringify(r.json).includes('1x0000000000000000000000000000000AA'), 'secret KHÔNG lọt vào phản hồi cho client');

  cfReply = () => json(200, { success: false, 'error-codes': ['timeout-or-duplicate'] });
  r = await login(port, { turnstileToken: TOKEN });
  ok(r.status === 400 && r.json.code === 'captcha_failed' && !r.cookies.some((c) => c.startsWith('tg_at=')), 'token hết hạn/đã dùng => 400, KHÔNG tạo phiên');

  cfReply = () => json(200, { success: true, action: 'newsletter' });
  r = await login(port, { turnstileToken: TOKEN });
  ok(r.status === 400 && r.json.code === 'captcha_failed', 'token tạo cho action khác ("newsletter") bị từ chối');

  cfReply = () => json(200, { success: false, 'error-codes': ['internal-error'] });
  r = await login(port, { turnstileToken: TOKEN });
  ok(r.status === 503 && r.json.code === 'captcha_unavailable', 'lỗi nội bộ Cloudflare => 503 captcha_unavailable (không đổ lỗi cho người dùng)');
  cfReply = () => json(502, {});
  r = await login(port, { turnstileToken: TOKEN });
  ok(r.status === 503 && r.json.code === 'captcha_unavailable', 'Cloudflare trả 5xx => 503 captcha_unavailable');
  cfReply = () => { throw new Error('ECONNRESET'); };
  r = await login(port, { turnstileToken: TOKEN });
  ok(r.status === 503 && r.json.code === 'captcha_unavailable', 'mất kết nối Cloudflare => 503, fail-closed (không cho qua)');

  console.log('\n== Áp dụng cho cả đăng ký và quên mật khẩu ==');
  cfReply = () => json(200, { success: true, action: 'auth' });
  const su = { email: 'a@b.co', password: 'abcdefg1', confirmPassword: 'abcdefg1', challenge: 'x', nonce: '1' };
  r = await post(port, '/api/auth/signup', su);
  ok(r.status === 400 && r.json.code === 'captcha_failed', 'đăng ký thiếu token => 400');
  r = await post(port, '/api/auth/signup', { ...su, turnstileToken: TOKEN });
  ok(r.status === 200, 'đăng ký có token hợp lệ => qua');
  r = await post(port, '/api/auth/forgot', { email: 'a@b.co', challenge: 'x', nonce: '1' });
  ok(r.status === 400 && r.json.code === 'captcha_failed', 'quên mật khẩu thiếu token => 400');
  r = await post(port, '/api/auth/forgot', { email: 'a@b.co', challenge: 'x', nonce: '1', turnstileToken: TOKEN });
  ok(r.status === 200, 'quên mật khẩu có token hợp lệ => qua');

  console.log('\n== Cấu hình CSP + site key ==');
  const root = path.join(__dirname, '..');
  const vercel = fs.readFileSync(path.join(root, 'vercel.json'), 'utf8');
  const csp = (vercel.match(/"Content-Security-Policy",\s*"value":\s*"([^"]+)"/) || [])[1] || '';
  const dir = (n) => ((csp.match(new RegExp(n + ' ([^;]*)')) || [])[1] || '');
  ok(/https:\/\/challenges\.cloudflare\.com/.test(dir('script-src')) && !/'unsafe-inline'/.test(dir('script-src')), 'vercel.json: script-src có challenges.cloudflare.com, KHÔNG unsafe-inline');
  ok(dir('frame-src').trim() === 'https://challenges.cloudflare.com', 'vercel.json: frame-src chỉ cho challenges.cloudflare.com');
  const sec = fs.readFileSync(path.join(root, 'server', 'middleware', 'security.js'), 'utf8');
  ok(/scriptSrc:\s*\[[^\]]*challenges\.cloudflare\.com[^\]]*\]/.test(sec) && /frameSrc:\s*\['https:\/\/challenges\.cloudflare\.com'\]/.test(sec), 'security.js (Express/Helmet) khớp vercel.json');
  const html = fs.readFileSync(path.join(root, 'public', 'auth.html'), 'utf8');
  ok(/id="cfTurnstile"[^>]*data-sitekey="0x[0-9A-Za-z_-]{10,}"/.test(html), 'auth.html có widget với site key công khai (dạng 0x…)');
  ok(!/TURNSTILE_SECRET|0x4[A-Za-z0-9_-]+.*secret/i.test(html), 'auth.html không chứa secret');
  ok(!/<script[^>]+challenges\.cloudflare\.com/.test(html), 'auth.html không có thẻ <script> ngoại lai (script tải động từ auth.js)');

  console.log(`\n${passed} passed, ${failed} failed`);
  srv.close();
  process.exit(failed ? 1 : 0);
});
