'use strict';
// ---------- Đăng nhập Google (PKCE phía server) + họ tên lúc đăng ký: kiểm hành vi thật của server/routes/auth.js ----------
// Supabase được GIẢ LẬP bằng cách thay global.fetch (chỉ chặn https://proj.supabase.co). Không cần mạng, không cần DB.
// Chạy: node test/auth-google-oauth.test.js
process.env.SUPABASE_URL = 'https://proj.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
process.env.RATE_LIMIT_AUTH = '1000';
process.env.RATE_LIMIT_SIGNUP = '1000';
delete process.env.AUTH_REDIRECT_URL;

const crypto = require('crypto');
const http = require('http');
const path = require('path');
const express = require('express');

// PoW không phải đối tượng test này: luôn hợp lệ.
const powPath = require.resolve('../server/utils/auth/pow');
require(powPath);
require.cache[powPath].exports = Object.assign({}, require.cache[powPath].exports, { verify: async () => ({ ok: true }) });

const realFetch = global.fetch;
const calls = [];
let tokenReply;
const resetToken = () => { tokenReply = { status: 200, body: { access_token: 'AT.jwt.x', refresh_token: 'RT1', expires_in: 3600, user: { id: 'u1', email: 'g@x.com' } } }; };
resetToken();
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.startsWith('https://proj.supabase.co')) return realFetch(url, opts);
  calls.push({ url: u, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (u.includes('/token?grant_type=pkce')) return json(tokenReply.status, tokenReply.body);
  if (u.includes('/auth/v1/signup')) return json(200, { id: 'u2' });
  return json(404, {});
};

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('  ok  - ' + msg); } else { failed++; console.log('  FAIL - ' + msg); } }
const b64u = (b) => Buffer.from(b).toString('base64url');
const CODE = '34e770dd-9ff9-416c-87fa-43b31d7ef225';

const app = express();
app.use('/api/auth', require('../server/routes/auth.js'));
const srv = http.createServer(app);

function get(port, p, headers) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers }, (r) => {
      r.resume();
      resolve({ status: r.statusCode, location: r.headers.location, cookies: [].concat(r.headers['set-cookie'] || []) });
    }).on('error', reject);
  });
}
function post(port, p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const rq = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (r) => {
      let s = ''; r.on('data', (c) => { s += c; });
      r.on('end', () => { let j = {}; try { j = JSON.parse(s); } catch (_) { /* không phải JSON */ } resolve({ status: r.statusCode, json: j }); });
    });
    rq.on('error', reject); rq.end(data);
  });
}
const cookieOf = (list, name) => list.find((c) => c.startsWith(name + '='));
const valueOf = (c) => decodeURIComponent(c.split(';')[0].slice(c.indexOf('=') + 1));

srv.listen(0, async () => {
  const port = srv.address().port;
  const HOST = { Host: 'app.example.com', 'X-Forwarded-Proto': 'https' };

  console.log('\n== GET /api/auth/google ==');
  let r = await get(port, '/api/auth/google?next=/index.html%3Fx%3D1&remember=1', HOST);
  const loc = new URL(r.location);
  ok(r.status === 302 && loc.origin + loc.pathname === 'https://proj.supabase.co/auth/v1/authorize', '302 sang /auth/v1/authorize của Supabase');
  ok(loc.searchParams.get('provider') === 'google', 'provider=google');
  ok(loc.searchParams.get('code_challenge_method') === 's256', 'code_challenge_method=s256 (giá trị auth-js dùng)');
  ok(loc.searchParams.get('redirect_to') === 'https://app.example.com/api/auth/callback', 'redirect_to = <origin>/api/auth/callback, KHÔNG kèm query (allow-list so cả query)');
  const pk = cookieOf(r.cookies, 'tg_pkce');
  ok(!!pk && /HttpOnly/.test(pk) && /SameSite=Lax/.test(pk) && /Max-Age=600/.test(pk) && /Secure/.test(pk), 'cookie tg_pkce: HttpOnly, SameSite=Lax, Secure, 10 phút');
  const cookieVal = valueOf(pk);
  const verifier = cookieVal.split('.')[0];
  ok(/^[A-Za-z0-9_-]{43}$/.test(verifier), 'code_verifier 43 ký tự base64url (RFC 7636: 43–128)');
  ok(loc.searchParams.get('code_challenge') === b64u(crypto.createHash('sha256').update(verifier).digest()), 'code_challenge = base64url(SHA-256(verifier))');
  ok(!/verifier/.test(r.location) && !r.location.includes(verifier), 'verifier KHÔNG xuất hiện trong URL điều hướng');
  const meta = JSON.parse(Buffer.from(cookieVal.split('.')[1], 'base64url').toString());
  ok(meta.n === '/index.html?x=1' && meta.r === true, 'next + remember lưu trong cookie, không trong redirect_to');

  const evil = await get(port, '/api/auth/google?next=//evil.com', HOST);
  const evilMeta = JSON.parse(Buffer.from(valueOf(cookieOf(evil.cookies, 'tg_pkce')).split('.')[1], 'base64url').toString());
  ok(evilMeta.n === '/index.html', 'next=//evil.com bị ép về /index.html (không open redirect)');

  r = await get(port, '/api/auth/google', { Host: 'bad host!' });
  ok(r.location === '/auth?oauth_error=failed', 'Host lạ => /auth?oauth_error=failed, không chuyển sang Supabase');
  r = await get(port, '/api/auth/google', { Host: 'evil.com/x?y=' });
  ok(r.location === '/auth?oauth_error=failed', 'Host chứa / hoặc ? bị từ chối');

  console.log('\n== GET /api/auth/callback ==');
  calls.length = 0;
  r = await get(port, '/api/auth/callback?code=' + CODE, { cookie: 'tg_pkce=' + encodeURIComponent(cookieVal) });
  ok(r.status === 302 && r.location === '/index.html?x=1', 'thành công => 302 /index.html?x=1');
  const ex = calls.find((c) => c.url.includes('grant_type=pkce'));
  ok(ex && ex.method === 'POST' && ex.body.auth_code === CODE && ex.body.code_verifier === verifier, 'POST /auth/v1/token?grant_type=pkce {auth_code, code_verifier}');
  ok(['tg_at', 'tg_rt', 'tg_rm'].every((n) => { const c = cookieOf(r.cookies, n); return c && /HttpOnly/.test(c); }), 'đặt cookie phiên tg_at/tg_rt/tg_rm đều HttpOnly');
  ok(cookieOf(r.cookies, 'tg_rm').startsWith('tg_rm=1') && /Max-Age=2592000/.test(cookieOf(r.cookies, 'tg_rt')), 'remember=1 => cookie refresh sống 30 ngày');
  ok(/Max-Age=0/.test(cookieOf(r.cookies, 'tg_pkce')), 'cookie tg_pkce bị xóa sau khi dùng');

  r = await get(port, '/api/auth/callback?code=' + CODE);
  ok(r.location === '/auth?oauth_error=failed' && !cookieOf(r.cookies, 'tg_at'), 'thiếu cookie PKCE => lỗi, KHÔNG tạo phiên (chặn code injection / login CSRF)');
  r = await get(port, '/api/auth/callback?error=access_denied');
  ok(r.location === '/auth?oauth_error=cancelled', 'người dùng hủy => oauth_error=cancelled');
  r = await get(port, '/api/auth/callback?error=server_error&code=abc');
  ok(r.location === '/auth?oauth_error=failed', 'error khác => oauth_error=failed');
  calls.length = 0;
  r = await get(port, '/api/auth/callback?code=%3Cscript%3E', { cookie: 'tg_pkce=' + encodeURIComponent(cookieVal) });
  ok(r.location === '/auth?oauth_error=failed' && calls.length === 0, 'code sai định dạng bị chặn trước khi gọi Supabase');
  r = await get(port, '/api/auth/callback?code=' + CODE, { cookie: 'tg_pkce=' + encodeURIComponent('short.' + cookieVal.split('.')[1]) });
  ok(r.location === '/auth?oauth_error=failed', 'verifier sai độ dài bị từ chối');

  tokenReply = { status: 400, body: { error: 'invalid_grant' } };
  r = await get(port, '/api/auth/callback?code=' + CODE, { cookie: 'tg_pkce=' + encodeURIComponent(cookieVal) });
  ok(r.location === '/auth?oauth_error=failed' && !cookieOf(r.cookies, 'tg_at'), 'Supabase từ chối code => lỗi, không có phiên');
  resetToken();
  r = await get(port, '/api/auth/callback?code=' + CODE, { cookie: 'tg_pkce=' + encodeURIComponent(verifier + '.%%%') });
  ok(r.location === '/index.html' && cookieOf(r.cookies, 'tg_rm').startsWith('tg_rm=0'), 'meta hỏng => next mặc định /index.html, remember=false');

  console.log('\n== POST /api/auth/signup: họ tên => options.data.full_name ==');
  const base = { email: 'a@b.co', password: 'abcdefg1', confirmPassword: 'abcdefg1', challenge: 'x', nonce: '1' };
  calls.length = 0;
  await post(port, '/api/auth/signup', { ...base, fullName: '  Nguyễn   Văn A ' });
  const su = calls.find((c) => c.url.includes('/auth/v1/signup'));
  ok(su && su.body.data && su.body.data.full_name === 'Nguyễn Văn A', 'gửi data.full_name đã chuẩn hóa (trim + gộp khoảng trắng)');
  calls.length = 0;
  await post(port, '/api/auth/signup', base);
  ok(calls[0] && !('data' in calls[0].body), 'không có họ tên => không gửi data');
  for (const [label, val] of [['zero-width', 'Eve\u200b'], ['> 60 ký tự', 'a'.repeat(61)], ['kiểu object', { $ne: 1 }], ['ký tự điều khiển', 'a\u0007b']]) {
    calls.length = 0;
    const res = await post(port, '/api/auth/signup', { ...base, fullName: val });
    ok(res.status === 400 && res.json.code === 'invalid_display_name' && calls.length === 0, `họ tên ${label} => 400 invalid_display_name, không gọi Supabase`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  srv.close();
  process.exit(failed ? 1 : 0);
});
