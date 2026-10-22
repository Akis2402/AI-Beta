'use strict';
// ---------- Hồ sơ mở rộng + lịch sử Usage + đổi mật khẩu + đăng xuất mọi thiết bị + hạn mức mặc định 50.000 ----------
// Dùng route THẬT server/routes/auth.js (requireUser thật). Supabase được GIẢ LẬP bằng cách thay global.fetch.
// Chạy: node test/auth-profile-usage.test.js
process.env.SUPABASE_URL = 'https://proj.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
process.env.RATE_LIMIT_AUTH = '1000';
delete process.env.AI_TOKEN_LIMIT;
delete process.env.TURNSTILE_SECRET_KEY;

const http = require('http');
const express = require('express');

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('  ok  - ' + msg); } else { failed++; console.log('  FAIL - ' + msg); } }

// ---- hạn mức mặc định ----
const cfgMod = require('../server/utils/quota/config');
function findKey(obj, key) { if (!obj || typeof obj !== 'object') return undefined; if (key in obj) return obj[key]; for (const v of Object.values(obj)) { const r = findKey(v, key); if (r !== undefined) return r; } return undefined; }
if (typeof cfgMod._resetConfigForTest === 'function') cfgMod._resetConfigForTest();
console.log('\n== Hạn mức mặc định ==');
ok(findKey(cfgMod.getConfig(), 'tokenLimit') === 50000, 'mặc định mỗi user = 50.000 token (khi không đặt AI_TOKEN_LIMIT)');

// ---- Supabase giả ----
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const AT = `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
// Token KHÁC (exp khác) cho ca "chỉ đăng nhập Google": server cache user theo hash token nên dùng lại AT sẽ trả user cũ.
const AT_GOOGLE = `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 7200 })}.sig`;
const calls = [];
let providers = ['email'];
let currentPasswordOk = true;
let usageRows = [];
let usageFails = false;
const realFetch = global.fetch;
const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.startsWith('https://proj.supabase.co')) return realFetch(url, opts);
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ url: u, method: opts.method, body, auth: opts.headers && (opts.headers.Authorization || opts.headers.authorization) });
  if (u.includes('/auth/v1/user') && opts.method === 'GET') return json(200, { id: 'user-1', email: 'a@b.co', app_metadata: { providers } });
  if (u.includes('/auth/v1/user') && opts.method === 'PUT') return json(200, { id: 'user-1' });
  if (u.includes('/token?grant_type=password')) return currentPasswordOk ? json(200, { access_token: 'x', refresh_token: 'y', user: { id: 'user-1' } }) : json(400, { error: 'invalid_grant' });
  if (u.includes('/auth/v1/logout')) return json(204);
  if (u.includes('/rest/v1/profiles') && opts.method === 'GET') return json(200, [{ id: 'user-1', email: 'a@b.co', display_name: 'An', avatar_url: null, role: 'user', bio: 'Xin chào', phone: '0912 345 678' }]);
  if (u.includes('/rest/v1/profiles') && opts.method === 'PATCH') return json(200, [{ id: 'user-1', display_name: body.display_name || 'An', bio: 'bio' in body ? body.bio : 'Xin chào', phone: 'phone' in body ? body.phone : '0912 345 678' }]);
  if (u.includes('/rest/v1/ai_usage')) return usageFails ? json(500, { message: 'boom' }) : json(200, usageRows);
  return json(404, {});
};

const app = express();
app.use('/api/auth', require('../server/routes/auth.js'));
const srv = http.createServer(app);

function req(port, method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    if (cookie !== false) headers.cookie = `tg_at=${typeof cookie === 'string' ? cookie : AT}`;
    const rq = http.request({ host: '127.0.0.1', port, path, method, headers }, (r) => {
      let s = ''; r.on('data', (c) => { s += c; });
      r.on('end', () => { let j = {}; try { j = JSON.parse(s); } catch (_) { /* không JSON */ } resolve({ status: r.statusCode, json: j, cookies: [].concat(r.headers['set-cookie'] || []) }); });
    });
    rq.on('error', reject); if (data) rq.write(data); rq.end();
  });
}
const last = (re, method) => calls.filter((c) => re.test(c.url) && (!method || c.method === method)).pop();

srv.listen(0, async () => {
  const port = srv.address().port;

  console.log('\n== GET /session: hồ sơ mở rộng ==');
  let r = await req(port, 'GET', '/api/auth/session');
  ok(r.status === 200 && r.json.user.bio === 'Xin chào' && r.json.user.phone === '0912 345 678', 'trả bio + phone');
  ok(Array.isArray(r.json.user.providers) && r.json.user.providers.includes('email'), 'trả providers (để UI biết có mật khẩu hay không)');
  ok(/select=[^&]*bio[^&]*phone/.test(decodeURIComponent(last(/rest\/v1\/profiles/, 'GET').url)), 'truy vấn profiles có chọn cột bio, phone');

  console.log('\n== PATCH /profile ==');
  r = await req(port, 'PATCH', '/api/auth/profile', { bio: '  Học sinh lớp 11\r\nThích toán  ', phone: ' +84 912 345 678 ' });
  ok(r.status === 200 && r.json.ok === true, 'lưu bio + phone hợp lệ');
  const patched = last(/rest\/v1\/profiles/, 'PATCH').body;
  ok(patched.bio === 'Học sinh lớp 11\nThích toán' && patched.phone === '+84 912 345 678', 'chuẩn hóa: trim, CRLF -> \\n');
  ok(!('display_name' in patched) && !('role' in patched) && !('email' in patched) && !!patched.updated_at, 'chỉ gửi đúng cột được phép (không role/email/display_name khi không đổi)');
  r = await req(port, 'PATCH', '/api/auth/profile', { phone: '' });
  ok(r.status === 200 && last(/rest\/v1\/profiles/, 'PATCH').body.phone === null, 'xoá số điện thoại => null');
  r = await req(port, 'PATCH', '/api/auth/profile', { displayName: 'Nguyễn   Văn  A' });
  ok(r.status === 200 && last(/rest\/v1\/profiles/, 'PATCH').body.display_name === 'Nguyễn Văn A', 'đổi tên vẫn hoạt động (gộp khoảng trắng)');
  const n0 = calls.length;
  for (const [label, body, code] of [
    ['phone chữ', { phone: 'abc' }, 'invalid_phone'],
    ['phone object', { phone: { $ne: 1 } }, 'invalid_phone'],
    ['bio > 280', { bio: 'x'.repeat(281) }, 'invalid_bio'],
    ['bio có ký tự điều khiển', { bio: 'a\u0007b' }, 'invalid_bio'],
    ['bio có zero-width', { bio: 'a\u200bb' }, 'invalid_bio'],
    ['bio kiểu số', { bio: 42 }, 'invalid_bio'],
    ['tên rỗng', { displayName: '   ' }, 'invalid_display_name'],
    ['tên 61 ký tự', { displayName: 'a'.repeat(61) }, 'invalid_display_name'],
    ['không có trường nào', {}, 'nothing_to_update']
  ]) {
    r = await req(port, 'PATCH', '/api/auth/profile', body);
    ok(r.status === 400 && r.json.code === code, `${label} => 400 ${code}`);
  }
  ok(!calls.slice(n0).some((c) => c.method === 'PATCH'), 'đầu vào xấu KHÔNG bao giờ chạm DB');
  r = await req(port, 'PATCH', '/api/auth/profile', { bio: 'x' }, false);
  ok(r.status === 401, 'chưa đăng nhập => 401');

  console.log('\n== GET /usage ==');
  usageRows = [
    { created_at: '2026-10-18T10:00:00Z', kind: 'chat', provider: 'puter', model: 'm1', input_tokens: 700, output_tokens: 300, cached_tokens: 0, total_tokens: 1000 },
    { created_at: '2026-10-17T09:00:00Z', kind: 'image', provider: null, model: null, input_tokens: 0, output_tokens: 0, cached_tokens: 0, total_tokens: 4000 }
  ];
  r = await req(port, 'GET', '/api/auth/usage');
  ok(r.status === 200 && r.json.items.length === 2 && r.json.items[0].total === 1000 && r.json.items[1].kind === 'image', 'trả lịch sử đã chuẩn hóa tên trường');
  const uq = decodeURIComponent(last(/rest\/v1\/ai_usage/, 'GET').url);
  ok(uq.includes('user_id=eq.user-1') && uq.includes('status=eq.settled') && uq.includes('limit=100') && uq.includes('order=created_at.desc'), 'chỉ lấy dòng CỦA user đang đăng nhập, đã quyết toán, mới nhất trước, tối đa 100');
  ok(!('user_id' in r.json.items[0]) && !('request_id' in r.json.items[0]), 'không lộ user_id/request_id');
  usageFails = true; r = await req(port, 'GET', '/api/auth/usage');
  ok(r.status === 503 && r.json.code === 'usage_unavailable', 'DB lỗi => 503 usage_unavailable'); usageFails = false;
  r = await req(port, 'GET', '/api/auth/usage', undefined, false);
  ok(r.status === 401, 'chưa đăng nhập => 401 (không xem được usage người khác)');

  console.log('\n== POST /password ==');
  const pw = { currentPassword: 'Matkhau-cu-1', newPassword: 'Matkhau-moi-2026', confirmPassword: 'Matkhau-moi-2026' };
  calls.length = 0;
  r = await req(port, 'POST', '/api/auth/password', pw);
  ok(r.status === 200 && r.json.ok === true, 'đổi mật khẩu thành công');
  const put = last(/auth\/v1\/user/, 'PUT');
  ok(put && put.body.password === 'Matkhau-moi-2026' && /Bearer /.test(put.auth || ''), 'gọi GoTrue PUT /user bằng token của chính user');
  ok(calls.findIndex((c) => /grant_type=password/.test(c.url)) < calls.findIndex((c) => c.method === 'PUT'), 'XÁC MINH mật khẩu hiện tại TRƯỚC khi đổi');
  currentPasswordOk = false; calls.length = 0;
  r = await req(port, 'POST', '/api/auth/password', pw);
  ok(r.status === 400 && r.json.code === 'invalid_current_password', 'mật khẩu hiện tại sai => 400 (KHÔNG 401: UI không nhầm là hết phiên)');
  ok(!calls.some((c) => c.method === 'PUT'), 'mật khẩu hiện tại sai => KHÔNG đổi gì'); currentPasswordOk = true;
  for (const [label, body, code] of [
    ['thiếu mật khẩu hiện tại', { ...pw, currentPassword: '' }, 'invalid_current_password'],
    ['mật khẩu xác nhận lệch', { ...pw, confirmPassword: 'khac' }, 'password_mismatch'],
    ['mật khẩu mới yếu', { currentPassword: 'Matkhau-cu-1', newPassword: '123', confirmPassword: '123' }, 'weak_password'],
    ['mật khẩu mới trùng cũ', { currentPassword: 'Matkhau-cu-2026', newPassword: 'Matkhau-cu-2026', confirmPassword: 'Matkhau-cu-2026' }, 'same_password']
  ]) { r = await req(port, 'POST', '/api/auth/password', body); ok(r.status === 400 && r.json.code === code, `${label} => 400 ${code}`); }
  providers = ['google']; calls.length = 0;
  r = await req(port, 'POST', '/api/auth/password', pw, AT_GOOGLE);
  ok(r.status === 400 && r.json.code === 'no_password_account' && !calls.some((c) => /grant_type=password/.test(c.url)), 'tài khoản chỉ có Google => thông báo rõ, không thử đăng nhập'); providers = ['email'];
  r = await req(port, 'POST', '/api/auth/password', pw, false);
  ok(r.status === 401, 'chưa đăng nhập => 401');

  console.log('\n== POST /logout-all ==');
  calls.length = 0;
  r = await req(port, 'POST', '/api/auth/logout-all', {});
  ok(r.status === 200 && r.json.revoked === true && r.json.status === 'unauthenticated', 'đăng xuất mọi thiết bị, revoked=true');
  ok(/scope=global/.test(last(/auth\/v1\/logout/, 'POST').url), 'gọi GoTrue logout?scope=global');
  ok(r.cookies.some((c) => c.startsWith('tg_at=') && /Max-Age=0/.test(c)), 'xoá cookie phiên trên trình duyệt này');

  console.log(`\n${passed} passed, ${failed} failed`);
  srv.close();
  process.exit(failed ? 1 : 0);
});
