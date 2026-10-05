'use strict';
// ============================================================================================
// TEST TÍCH HỢP: middleware THẬT (requireUser/reserveQuota/auth routes) + hàm SQL THẬT trên Postgres.
// Supabase Auth (GoTrue) được GIẢ LẬP bằng một HTTP server nhỏ; các RPC ai_* chạy trên Postgres thật.
// Chạy: xem test-integration/README.md. Cần: PG* env, `npm i --no-save pg`, đã áp migration + stub-supabase.sql.
// Không nằm trong `npm test` vì cần Postgres.
// ============================================================================================
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (sub, expSec) => `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ sub, exp: expSec })}.sig`;
const ANON = jwt('anon', 4102444800);
const SVC = jwt('service', 4102444800);
const MOCK_PORT = Number(process.env.MOCK_SUPABASE_PORT) || 4999;

process.env.SUPABASE_URL = `http://127.0.0.1:${MOCK_PORT}`;
process.env.SUPABASE_ANON_KEY = ANON;
process.env.SUPABASE_SERVICE_ROLE_KEY = SVC;
process.env.AI_TOKEN_LIMIT = '5000';
process.env.AI_COOLDOWN_MINUTES = '35';
process.env.AI_MAX_CONCURRENT = '2';
process.env.AI_RESERVE_CHAT = '2000';
process.env.AI_MIN_REQUEST_TOKENS = '500';
process.env.AI_ABORT_SETTLE_GRACE_MS = '200';
process.env.NODE_ENV = 'test';
delete process.env.AUTH_ENFORCEMENT;

const pool = new Pool(); // dùng PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD

// ---------------- mock Supabase ----------------
const users = new Map(); // email -> {id, password}
const tokens = new Map(); // access -> userId
const refreshes = new Map(); // refresh -> userId
const revoked = new Set();
function issue(userId, email) {
  const access = jwt(userId, Math.floor(Date.now() / 1000) + 3600 + Math.floor(Math.random() * 100000));
  tokens.set(access, userId);
  const rt = `rt_${crypto.randomBytes(8).toString('hex')}`;
  refreshes.set(rt, userId);
  return { access_token: access, refresh_token: rt, expires_in: 3600, user: { id: userId, email, email_confirmed_at: new Date().toISOString() } };
}
const emailOf = (id) => [...users.entries()].find(([, v]) => v.id === id)[0];

const mock = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  const body = raw ? JSON.parse(raw) : {};
  const send = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/auth/v1/signup') {
      if (users.has(body.email)) return send(200, { id: users.get(body.email).id, email: body.email }); // email tồn tại: GoTrue trả "giả thành công"
      const id = crypto.randomUUID();
      await pool.query('insert into auth.users(id,email) values ($1,$2)', [id, body.email]);
      users.set(body.email, { id, password: body.password });
      return send(200, issue(id, body.email));
    }
    if (p === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
      const u = users.get(body.email);
      if (!u || u.password !== body.password) return send(400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      return send(200, issue(u.id, body.email));
    }
    if (p === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
      const id = refreshes.get(body.refresh_token);
      if (!id) return send(400, { error_code: 'refresh_token_not_found' });
      refreshes.delete(body.refresh_token);
      return send(200, issue(id, emailOf(id)));
    }
    if (p === '/auth/v1/user') {
      const t = (req.headers.authorization || '').replace('Bearer ', '');
      if (revoked.has(t) || !tokens.has(t)) return send(401, { msg: 'invalid JWT' });
      const id = tokens.get(t);
      return send(200, { id, email: emailOf(id), email_confirmed_at: new Date().toISOString() });
    }
    if (p === '/auth/v1/logout') {
      const t = (req.headers.authorization || '').replace('Bearer ', '');
      revoked.add(t);
      const uid = tokens.get(t); // GoTrue thật: logout xoá cả session => refresh token của session đó cũng vô hiệu
      for (const [k, v] of refreshes) if (v === uid) refreshes.delete(k);
      return send(204, {});
    }
    if (p.startsWith('/rest/v1/rpc/')) {
      const fn = p.split('/').pop();
      const keys = Object.keys(body);
      const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
      const r = await pool.query(sql, keys.map((k) => body[k]));
      return send(200, r.rows[0].r);
    }
    if (p === '/rest/v1/profiles') {
      const id = url.searchParams.get('id').replace('eq.', '');
      const r = await pool.query('select id,email,display_name,avatar_url,role from public.profiles where id=$1', [id]);
      return send(200, r.rows);
    }
    return send(404, { msg: `not found ${p}` });
  } catch (e) { return send(500, { message: e.message }); }
});

// ---------------- app thật ----------------
const { requireUser, reserveQuota } = require('../server/middleware/authQuota');
const authRoutes = require('../server/routes/auth');
const usage = require('../server/utils/quota/usageContext');

let handlerCalls = 0;
const app = express();
app.use('/api/auth', authRoutes);
app.post('/api/chat', requireUser, express.json(), reserveQuota('chat'), async (req, res) => {
  handlerCalls += 1;
  const b = req.body || {};
  if (b.delay) await new Promise((r) => setTimeout(r, b.delay));
  if (b.mode === 'cache') return res.json({ ok: true, cache: true });
  if (b.mode === 'fail') { usage.recordUsage({ usage: null, provider: 'p', model: 'm' }); return res.status(500).json({ error: 'provider down' }); }
  if (b.recordAfter) await new Promise((r) => setTimeout(r, b.recordAfter));
  usage.recordUsage({ usage: { inputTokens: b.inTok || 0, outputTokens: b.outTok || 0, cachedTokens: b.cached || 0 }, provider: 'anthropic', model: 'sonnet' });
  if (b.delayAfter) await new Promise((r) => setTimeout(r, b.delayAfter));
  return res.json({ ok: true });
});
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => { console.error('APP ERR', err); res.status(500).json({ error: String(err && err.message) }); });

let pass = 0; let fail = 0;
const ok = (cond, name, extra) => { if (cond) { pass += 1; console.log('  PASS', name); } else { fail += 1; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); } };

let base;
async function call(method, path, { body, cookie, headers } = {}) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch (_) { /* body rỗng */ }
  return { status: r.status, json, setCookie: r.headers.getSetCookie ? r.headers.getSetCookie() : [], headers: r.headers };
}
const cookieJar = (sc) => sc.map((c) => c.split(';')[0]).filter((c) => !/=$/.test(c)).join('; ');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (sql, args) => pool.query(sql, args).then((r) => r.rows);

(async () => {
  await q('truncate public.ai_usage, public.ai_quota cascade');
  await new Promise((r) => mock.listen(MOCK_PORT, r));
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}`;

  console.log('# 1. Chưa đăng nhập');
  let r = await call('POST', '/api/chat', { body: { inTok: 1 } });
  ok(r.status === 401 && r.json.code === 'auth_required', 'không cookie -> 401 auth_required', r);
  ok(handlerCalls === 0, 'handler/model KHÔNG được gọi', handlerCalls);

  console.log('# 2. Đăng ký');
  r = await call('POST', '/api/auth/signup', { body: { email: 'a@x.vn', password: 'abc', confirmPassword: 'abc' } });
  ok(r.status === 400 && r.json.code === 'weak_password', 'mật khẩu yếu bị từ chối', r.json);
  r = await call('POST', '/api/auth/signup', { body: { email: 'a@x.vn', password: 'abcdef12', confirmPassword: 'zzzzzz99' } });
  ok(r.status === 400 && r.json.code === 'password_mismatch', 'confirm không khớp bị từ chối', r.json);
  r = await call('POST', '/api/auth/signup', { body: { email: ' A@X.vn ', password: 'abcdef12', confirmPassword: 'abcdef12', remember: true } });
  ok(r.status === 200 && r.json.status === 'authenticated', 'đăng ký ok (trim + lowercase email)', r.json);
  ok(r.setCookie.length === 3 && r.setCookie.every((c) => /HttpOnly/.test(c) && /SameSite=Lax/.test(c)), '3 cookie httpOnly SameSite=Lax', r.setCookie);
  ok(/tg_rt=.*Max-Age=2592000/.test(r.setCookie.join('|')), 'remember => refresh cookie bền 30 ngày');
  let cookieA = cookieJar(r.setCookie);
  const dup = await call('POST', '/api/auth/signup', { body: { email: 'a@x.vn', password: 'abcdef12', confirmPassword: 'abcdef12' } });
  ok(dup.status === 200 && dup.json.status === 'confirmation_pending' && !dup.setCookie.length, 'email đã tồn tại -> thông điệp trung tính, không cookie', dup.json);

  console.log('# 3. Đăng nhập / session');
  r = await call('POST', '/api/auth/login', { body: { email: 'a@x.vn', password: 'sai-mat-khau1' } });
  ok(r.status === 401 && r.json.code === 'invalid_credentials', 'sai mật khẩu -> 401 chung chung', r.json);
  r = await call('POST', '/api/auth/login', { body: { email: 'khongco@x.vn', password: 'sai-mat-khau1' } });
  ok(r.status === 401 && r.json.error === 'Email hoặc mật khẩu không đúng.', 'email không tồn tại -> cùng thông điệp (không dò tài khoản)', r.json);
  r = await call('POST', '/api/auth/login', { body: { email: 'a@x.vn', password: 'abcdef12' } });
  ok(r.status === 200, 'login ok'); cookieA = cookieJar(r.setCookie);
  ok(!/Max-Age=2592000/.test(r.setCookie.join('|')), 'không tick remember => cookie phiên');
  r = await call('GET', '/api/auth/session', { cookie: cookieA });
  ok(r.json.status === 'authenticated' && r.json.user.email === 'a@x.vn' && r.json.user.role === 'user', 'GET session (F5) vẫn đăng nhập, role=user', r.json);
  r = await call('GET', '/api/auth/session');
  ok(r.json.status === 'unauthenticated', 'không cookie -> unauthenticated', r.json);

  console.log('# 4. Gọi AI + quota theo usage thật');
  r = await call('POST', '/api/chat', { cookie: cookieA, body: { inTok: 1000, outTok: 500 } });
  ok(r.status === 200, 'AI call ok', r.json);
  await sleep(300);
  let st = (await call('GET', '/api/auth/quota', { cookie: cookieA })).json;
  ok(st.tokensUsed === 1500 && st.tokensReserved === 0 && st.tokenLimit === 5000, 'settle theo usage THẬT 1500 (không phải mức đặt chỗ 2000)', st);

  console.log('# 5. Song song: giới hạn concurrent = 2');
  handlerCalls = 0;
  const par = await Promise.all(Array.from({ length: 6 }, () => call('POST', '/api/chat', { cookie: cookieA, body: { inTok: 10, outTok: 10, delay: 400 } })));
  const okN = par.filter((x) => x.status === 200).length;
  const denied = par.filter((x) => x.status === 429 && x.json.code === 'ai_concurrency_limit').length;
  ok(okN === 2 && denied === 4, `6 request cùng lúc: 2 qua, 4 bị chặn (${okN}/${denied})`);
  ok(handlerCalls === 2, 'model chỉ được gọi 2 lần', handlerCalls);
  await sleep(300);

  console.log('# 6. Lỗi provider / cache hit không bị tính phí');
  let before = (await call('GET', '/api/auth/quota', { cookie: cookieA })).json.tokensUsed;
  await call('POST', '/api/chat', { cookie: cookieA, body: { mode: 'fail' } });
  await call('POST', '/api/chat', { cookie: cookieA, body: { mode: 'cache' } });
  await sleep(300);
  st = (await call('GET', '/api/auth/quota', { cookie: cookieA })).json;
  ok(st.tokensUsed === before && st.tokensReserved === 0, 'fail + cache hit => release, không tốn token', { before, st });

  console.log('# 7. Client ngắt giữa chừng nhưng provider đã tính phí');
  before = st.tokensUsed;
  await new Promise((resolve) => {
    const req = http.request(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookieA } }, () => {});
    req.on('error', () => {});
    req.write(JSON.stringify({ inTok: 300, outTok: 200, recordAfter: 150, delayAfter: 600 }));
    req.end();
    setTimeout(() => { req.destroy(); resolve(); }, 350); // ngắt SAU khi usage đã ghi (150ms), TRƯỚC khi response xong (750ms)
  });
  await sleep(1200);
  st = (await call('GET', '/api/auth/quota', { cookie: cookieA })).json;
  ok(st.tokensUsed === before + 500 && st.tokensReserved === 0, 'abort giữa chừng vẫn tính 500 token thực, không treo reservation', { before, st });

  console.log('# 8. Chặn origin lạ (CSRF)');
  r = await call('POST', '/api/chat', { cookie: cookieA, headers: { Origin: 'https://evil.example' }, body: { inTok: 1 } });
  ok(r.status === 403 && r.json.code === 'bad_origin', 'Origin khác host -> 403', r.json);

  console.log('# 9. Cạn quota -> cooldown 35 phút, server chặn TRƯỚC khi gọi model');
  r = await call('POST', '/api/chat', { cookie: cookieA, body: { inTok: 2500, outTok: 1500 } });
  ok(r.status === 200, 'request vượt hạn mức vẫn hoàn tất, tính theo thực tế'); await sleep(300);
  st = (await call('GET', '/api/auth/quota', { cookie: cookieA })).json;
  ok(st.status === 'cooldown' && st.retryAfterSeconds > 2000 && st.retryAfterSeconds <= 2100, 'trạng thái cooldown ~35 phút', st);
  handlerCalls = 0;
  r = await call('POST', '/api/chat', { cookie: cookieA, body: { inTok: 1 } });
  ok(r.status === 429 && r.json.code === 'quota_cooldown' && Number(r.headers.get('retry-after')) > 2000, '429 quota_cooldown + Retry-After', { s: r.status, j: r.json });
  ok(handlerCalls === 0, 'model KHÔNG được gọi khi cooldown', handlerCalls);
  ok(/\d\d:\d\d/.test(r.json.error), 'thông báo có mm:ss', r.json.error);

  console.log('# 10. Cooldown sống sót khi logout/login');
  const lo = await call('POST', '/api/auth/logout', { cookie: cookieA });
  ok(lo.status === 200 && lo.setCookie.every((c) => /Max-Age=0/.test(c)), 'logout xoá cookie');
  r = await call('POST', '/api/chat', { cookie: cookieA, body: { inTok: 1 } });
  ok(r.status === 401, 'dùng lại cookie cũ sau logout bị từ chối ngay', r.status);
  r = await call('POST', '/api/auth/login', { body: { email: 'a@x.vn', password: 'abcdef12' } });
  const cookieA2 = cookieJar(r.setCookie);
  r = await call('POST', '/api/chat', { cookie: cookieA2, body: { inTok: 1 } });
  ok(r.status === 429 && r.json.code === 'quota_cooldown', 'login lại: vẫn cooldown', r.json);

  console.log('# 11. User khác có quota riêng');
  r = await call('POST', '/api/auth/signup', { body: { email: 'b@x.vn', password: 'abcdef12', confirmPassword: 'abcdef12' } });
  const cookieB = cookieJar(r.setCookie);
  r = await call('POST', '/api/chat', { cookie: cookieB, body: { inTok: 100, outTok: 100 } });
  ok(r.status === 200, 'user B không bị ảnh hưởng bởi cooldown của A');

  console.log('# 12. Hết cooldown -> reset tự động (đồng hồ DB)');
  await q("update public.ai_quota set cooldown_until = now() - interval '1 second' where user_id = $1", [users.get('a@x.vn').id]);
  r = await call('POST', '/api/chat', { cookie: cookieA2, body: { inTok: 10, outTok: 10 } });
  ok(r.status === 200, 'sau cooldown dùng lại được', r.json); await sleep(300);
  st = (await call('GET', '/api/auth/quota', { cookie: cookieA2 })).json;
  ok(st.status === 'active' && st.tokensUsed === 20, 'tokens_used reset về 0 rồi cộng 20', st);

  console.log('# 13. Access token hết hạn + refresh token hợp lệ => tự refresh');
  const idA = users.get('a@x.vn').id;
  const expired = jwt(idA, Math.floor(Date.now() / 1000) - 100);
  const rt = 'rt_manual'; refreshes.set(rt, idA);
  r = await call('POST', '/api/chat', { cookie: `tg_at=${expired}; tg_rt=${rt}; tg_rm=0`, body: { inTok: 5, outTok: 5 } });
  ok(r.status === 200 && r.setCookie.some((c) => c.startsWith('tg_at=')), 'refresh tự động + Set-Cookie mới', { s: r.status, sc: r.setCookie.length });
  r = await call('POST', '/api/chat', { cookie: `tg_at=${expired}; tg_rt=rt_bad; tg_rm=0`, body: { inTok: 5 } });
  ok(r.status === 401 && r.json.code === 'session_expired' && r.setCookie.every((c) => /Max-Age=0/.test(c)), 'refresh hỏng => session_expired + xoá cookie', r.json);

  console.log('# 14. Fail-closed khi Supabase chết');
  mock.closeAllConnections(); mock.close(); await sleep(150);
  require('../server/utils/auth/session')._clearCachesForTest();
  r = await call('POST', '/api/chat', { cookie: `tg_at=${expired}; tg_rt=${rt}`, body: { inTok: 5 } });
  ok(r.status === 503 && r.json.code === 'auth_unavailable', 'Supabase down => 503, không gọi model, không coi là "đã đăng xuất"', { s: r.status, j: r.json });

  console.log(`\nKẾT QUẢ: ${pass} pass, ${fail} fail`);
  srv.close(); await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH', e); process.exit(2); });
