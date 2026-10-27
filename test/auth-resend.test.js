'use strict';
// ---------- Gửi lại email xác minh = supabase.auth.resend({ type: 'signup', email }) ----------
// Route THẬT server/routes/auth.js; Supabase giả lập bằng global.fetch. Không cần mạng.
// Chạy: node test/auth-resend.test.js
process.env.NODE_ENV = 'test';
process.env.AUTH_ENFORCEMENT = 'on';
process.env.SUPABASE_URL = 'https://proj.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
process.env.RATE_LIMIT_AUTH = '1000';
process.env.RATE_LIMIT_SIGNUP = '1000';
process.env.AI_TOKEN_LIMIT = '';
process.env.AUTH_REDIRECT_URL = '';
process.env.TURNSTILE_SECRET_KEY = '';

const http = require('http');
const express = require('express');

const powPath = require.resolve('../server/utils/auth/pow');
require(powPath);
let powOk = true;
require.cache[powPath].exports = Object.assign({}, require.cache[powPath].exports, { verify: async () => (powOk ? { ok: true } : { ok: false, code: 'pow_invalid' }) });

const realFetch = global.fetch;
const calls = [];
let signupReply, resendReply;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.startsWith('https://proj.supabase.co')) return realFetch(url, opts);
  calls.push({ url: u, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
  if (u.includes('/auth/v1/signup')) return signupReply();
  if (u.includes('/auth/v1/resend')) return resendReply();
  return json(404, {});
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
      r.on('end', () => { let j = {}; try { j = JSON.parse(s); } catch (_) { /* không JSON */ } resolve({ status: r.statusCode, json: j }); });
    });
    rq.on('error', reject); rq.end(data);
  });
}
const resendCalls = () => calls.filter((c) => c.url.includes('/auth/v1/resend'));
const su = { email: 'a@b.co', password: 'Matkhau-2026-x', confirmPassword: 'Matkhau-2026-x', challenge: 'x', nonce: '1' };

srv.listen(0, async () => {
  const port = srv.address().port;

  console.log('\n== POST /api/auth/resend ==');
  resendReply = () => json(200, {});
  calls.length = 0;
  let r = await post(port, '/api/auth/resend', { email: 'a@b.co', challenge: 'x', nonce: '1' });
  ok(r.status === 200 && r.json.ok === true && /x\u00e1c nh\u1eadn/.test(r.json.message), 'th\u00e0nh c\u00f4ng => 200 + th\u00f4ng \u0111i\u1ec7p trung t\u00ednh');
  const rc = resendCalls()[0];
  ok(rc && rc.method === 'POST' && rc.body.email === 'a@b.co' && rc.body.type === 'signup', 'g\u1ecdi POST /auth/v1/resend {email, type: "signup"} (kh\u1edbp supabase.auth.resend)');
  resendReply = () => json(400, { error_code: 'user_not_found', msg: 'User not found' });
  const r2 = await post(port, '/api/auth/resend', { email: 'khong-ton-tai@b.co', challenge: 'x', nonce: '1' });
  ok(r2.status === 200 && r2.json.message === r.json.message, 'email kh\u00f4ng t\u1ed3n t\u1ea1i/\u0111\u00e3 x\u00e1c nh\u1eadn => c\u00f9ng m\u1ed9t ph\u1ea3n h\u1ed3i (kh\u00f4ng d\u00f2 \u0111\u01b0\u1ee3c t\u00e0i kho\u1ea3n)');
  resendReply = () => json(429, { error_code: 'over_email_send_rate_limit' });
  r = await post(port, '/api/auth/resend', { email: 'a@b.co', challenge: 'x', nonce: '1' });
  ok(r.status === 429 && r.json.code === 'resend_rate_limited', 'GoTrue gi\u1edbi h\u1ea1n 1 th\u01b0/60s => 429 resend_rate_limited');
  resendReply = () => json(502, {});
  r = await post(port, '/api/auth/resend', { email: 'a@b.co', challenge: 'x', nonce: '1' });
  ok(r.status === 503 && r.json.code === 'auth_unavailable', 'l\u1ed7i ph\u00eda Supabase => 503');
  calls.length = 0;
  r = await post(port, '/api/auth/resend', { email: 'kh\u00f4ng ph\u1ea3i email', challenge: 'x', nonce: '1' });
  ok(r.status === 400 && r.json.code === 'invalid_email' && calls.length === 0, 'email sai \u0111\u1ecbnh d\u1ea1ng => 400, kh\u00f4ng g\u1ecdi Supabase');
  powOk = false;
  r = await post(port, '/api/auth/resend', { email: 'a@b.co', challenge: 'x', nonce: '1' });
  ok(r.status === 400 && calls.length === 0, 'thi\u1ebfu/sai PoW => 400, kh\u00f4ng g\u1ecdi Supabase (ch\u1ed1ng l\u1ea1m d\u1ee5ng g\u1eedi th\u01b0)');
  powOk = true;
  process.env.TURNSTILE_SECRET_KEY = '1x0000000000000000000000000000000AA';
  r = await post(port, '/api/auth/resend', { email: 'a@b.co', challenge: 'x', nonce: '1' });
  ok(r.status === 400 && r.json.code === 'captcha_failed' && calls.length === 0, 'b\u1eadt Turnstile m\u00e0 thi\u1ebfu token => 400 captcha_failed');
  process.env.TURNSTILE_SECRET_KEY = '';

  console.log('\n== \u0110\u0103ng k\u00fd l\u1ea1i c\u00f9ng email: t\u1ef1 g\u1eedi l\u1ea1i m\u00e3 x\u00e1c minh ==');
  resendReply = () => json(200, {});
  // GoTrue KH\u00d4NG b\u00e1o \u0111\u00e3 g\u1eedi th\u01b0 (kh\u00f4ng c\u00f3 confirmation_sent_at) => server t\u1ef1 resend
  signupReply = () => json(200, { id: 'u1', email: 'a@b.co', identities: [] });
  calls.length = 0;
  r = await post(port, '/api/auth/signup', su);
  ok(r.status === 200 && r.json.status === 'confirmation_pending', '\u0111\u0103ng k\u00fd => confirmation_pending');
  ok(resendCalls().length === 1 && resendCalls()[0].body.email === 'a@b.co' && resendCalls()[0].body.type === 'signup', 'kh\u00f4ng c\u00f3 confirmation_sent_at => t\u1ef1 g\u1ecdi resend({type:"signup"})');
  // GoTrue \u0111\u00e3 g\u1eedi th\u01b0 => KH\u00d4NG g\u1eedi th\u00eam (tr\u00e1nh 2 th\u01b0)
  signupReply = () => json(200, { id: 'u2', email: 'a@b.co', confirmation_sent_at: '2026-10-21T10:00:00Z' });
  calls.length = 0;
  const r3 = await post(port, '/api/auth/signup', su);
  ok(r3.status === 200 && resendCalls().length === 0, '\u0111\u00e3 c\u00f3 confirmation_sent_at => kh\u00f4ng g\u1eedi th\u00eam');
  ok(r3.json.message === r.json.message && r3.json.status === r.json.status, 'ph\u1ea3n h\u1ed3i \u0111\u0103ng k\u00fd gi\u1ed1ng h\u1ec7t nhau d\u00f9 c\u00f3 g\u1eedi l\u1ea1i hay kh\u00f4ng (kh\u00f4ng l\u1ed9 email \u0111\u00e3 t\u1ed3n t\u1ea1i)');
  // resend l\u1ed7i (429) kh\u00f4ng l\u00e0m h\u1ecfng \u0111\u0103ng k\u00fd
  signupReply = () => json(200, { id: 'u3', email: 'a@b.co', identities: [] });
  resendReply = () => json(429, { error_code: 'over_email_send_rate_limit' });
  const r4 = await post(port, '/api/auth/signup', su);
  ok(r4.status === 200 && r4.json.status === 'confirmation_pending', 'resend b\u1ecb gi\u1edbi h\u1ea1n t\u1ea7n su\u1ea5t => \u0111\u0103ng k\u00fd v\u1eabn tr\u1ea3 k\u1ebft qu\u1ea3 trung t\u00ednh');
  resendReply = () => { throw new Error('ECONNRESET'); };
  const r5 = await post(port, '/api/auth/signup', su);
  ok(r5.status === 200 && r5.json.status === 'confirmation_pending', 'resend l\u1ed7i m\u1ea1ng => \u0111\u0103ng k\u00fd v\u1eabn tr\u1ea3 k\u1ebft qu\u1ea3 trung t\u00ednh');
  // d\u1ef1 \u00e1n t\u1eaft x\u00e1c nh\u1eadn email: c\u00f3 session => v\u00e0o lu\u00f4n, kh\u00f4ng resend
  signupReply = () => json(200, { access_token: 'a.b.c', refresh_token: 'r', expires_in: 3600, user: { id: 'u4' } });
  resendReply = () => json(200, {});
  calls.length = 0;
  const r6 = await post(port, '/api/auth/signup', su);
  ok(r6.json.status === 'authenticated' && resendCalls().length === 0, 'c\u00f3 session (t\u1eaft x\u00e1c nh\u1eadn email) => \u0111\u0103ng nh\u1eadp lu\u00f4n, kh\u00f4ng resend');

  console.log(`\n${passed} passed, ${failed} failed`);
  srv.close();
  process.exit(failed ? 1 : 0);
});
