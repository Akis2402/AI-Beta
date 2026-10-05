'use strict';

// Unit test KHÔNG cần mạng/DB cho: cấu hình auth+quota, sổ usage (AsyncLocalStorage), cookie/validate,
// kiểm tra file asset, và LOGIC middleware quota (reserve/settle/release) với quotaService được thay thế.
// Chạy: node test/auth-quota-unit.test.js   (hoặc `npm test`)

const assert = require('assert');
const { EventEmitter } = require('events');

let pass = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); pass += 1; results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e && e.stack]); }
}

// Biến môi trường TRƯỚC khi require config.
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_ANON_KEY = 'anon-key-not-jwt';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key-not-jwt';
process.env.NODE_ENV = 'test';
delete process.env.AUTH_ENFORCEMENT;
process.env.AI_ABORT_SETTLE_GRACE_MS = '20';

const cfgMod = require('../server/utils/quota/config');
const usage = require('../server/utils/quota/usageContext');
const session = require('../server/utils/auth/session');
const quotaSvc = require('../server/utils/quota/quotaService');
const mw = require('../server/middleware/authQuota');
const assets = require('../server/routes/assets')._test;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeRes() {
  const res = new EventEmitter();
  res.statusCode = 200; res.headers = {}; res.body = null; res.writableEnded = false;
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.getHeader = (k) => res.headers[k.toLowerCase()];
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; res.writableEnded = true; return res; };
  return res;
}
const fakeReq = (over = {}) => ({ method: 'POST', headers: { host: 'app.test' }, body: {}, ...over });

(async () => {
  // ---------------- config ----------------
  await t('config: mặc định hợp lệ (cooldown 35, concurrent 2)', () => {
    const c = cfgMod.loadConfig({ NODE_ENV: 'test' });
    assert.strictEqual(c.quota.cooldownMinutes, 35);
    assert.strictEqual(c.quota.maxConcurrent, 2);
    assert.strictEqual(c.enforcement, true);
  });
  await t('config: AI_COOLDOWN_MINUTES chỉ nhận 30..40 (30/35/40 ok)', () => {
    [30, 35, 40].forEach((n) => assert.strictEqual(cfgMod.loadConfig({ AI_COOLDOWN_MINUTES: String(n) }).quota.cooldownMinutes, n));
    ['29', '41', 'abc', '35.5', '-35'].forEach((v) => assert.throws(() => cfgMod.loadConfig({ AI_COOLDOWN_MINUTES: v }), /AI_COOLDOWN_MINUTES/));
  });
  await t('config: AI_TOKEN_LIMIT sai => lỗi rõ ràng, không silent fallback', () => {
    assert.throws(() => cfgMod.loadConfig({ AI_TOKEN_LIMIT: 'nhieu' }), /AI_TOKEN_LIMIT/);
    assert.throws(() => cfgMod.loadConfig({ AI_TOKEN_LIMIT: '10' }), /AI_TOKEN_LIMIT/);
    assert.strictEqual(cfgMod.loadConfig({ AI_TOKEN_LIMIT: '250000' }).quota.tokenLimit, 250000);
  });
  await t('config: AUTH_ENFORCEMENT=off bị cấm ở production', () => {
    assert.throws(() => cfgMod.loadConfig({ AUTH_ENFORCEMENT: 'off', NODE_ENV: 'production' }), /CẤM/);
    assert.strictEqual(cfgMod.loadConfig({ AUTH_ENFORCEMENT: 'off', NODE_ENV: 'development' }).enforcement, false);
    assert.throws(() => cfgMod.loadConfig({ AUTH_ENFORCEMENT: 'maybe' }), /AUTH_ENFORCEMENT/);
  });
  await t('config: supabase.configured chỉ khi đủ url + anon + service', () => {
    assert.strictEqual(cfgMod.loadConfig({}).supabase.configured, false);
    assert.strictEqual(cfgMod.loadConfig({ SUPABASE_URL: 'https://x.supabase.co/', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's' }).supabase.configured, true);
    assert.strictEqual(cfgMod.loadConfig({ SUPABASE_URL: 'https://x.supabase.co/', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's' }).supabase.url, 'https://x.supabase.co');
  });

  // ---------------- usageContext ----------------
  await t('usage: không có context => no-op, không ném lỗi', () => {
    assert.strictEqual(usage.recordUsage({ usage: { inputTokens: 5, outputTokens: 5 } }), false);
  });
  await t('usage: cộng dồn nhiều lượt + cache đọc tính 10%', () => {
    const ctx = usage.createContext({ userId: 'u', requestId: 'r', kind: 'chat', granted: 1000 });
    usage.run(ctx, () => {
      usage.recordUsage({ usage: { inputTokens: 1000, outputTokens: 200, cachedTokens: 500, cacheCreationTokens: 50 }, provider: 'a', model: 'm' });
      usage.recordUsage({ usage: { inputTokens: 100, outputTokens: 100, reasoningTokens: 40 } });
    });
    assert.strictEqual(ctx.meteredAttempts, 2);
    assert.strictEqual(usage.chargeableTokens(ctx), 1000 + 200 + 50 + 100 + 100 + 40 + 50); // + ceil(500*0.1)
  });
  await t('usage: số âm/NaN/chuỗi rác không làm hỏng sổ', () => {
    const ctx = usage.createContext({ userId: 'u', requestId: 'r', kind: 'chat', granted: 1 });
    usage.run(ctx, () => usage.recordUsage({ usage: { inputTokens: -5, outputTokens: 'abc' } }));
    assert.strictEqual(usage.chargeableTokens(ctx), 0);
    assert.strictEqual(ctx.meteredAttempts, 0);
  });
  await t('usage: context cô lập giữa 2 request song song', async () => {
    const a = usage.createContext({ userId: 'A', requestId: 'a', kind: 'chat', granted: 1 });
    const b = usage.createContext({ userId: 'B', requestId: 'b', kind: 'chat', granted: 1 });
    await Promise.all([
      usage.run(a, async () => { await sleep(10); usage.recordUsage({ usage: { inputTokens: 7, outputTokens: 0 } }); }),
      usage.run(b, async () => { usage.recordUsage({ usage: { inputTokens: 100, outputTokens: 0 } }); await sleep(20); })
    ]);
    assert.strictEqual(a.input, 7); assert.strictEqual(b.input, 100);
  });

  // ---------------- session helpers ----------------
  await t('session: parseCookies an toàn với cookie hỏng', () => {
    const c = session.parseCookies('a=1; tg_at=%E0%A4%A; b=2; tg_rt=xyz');
    assert.strictEqual(c.a, '1'); assert.strictEqual(c.b, '2'); assert.strictEqual(c.tg_rt, 'xyz'); assert.strictEqual(c.tg_at, undefined);
    assert.strictEqual(Object.getPrototypeOf(c), null);
  });
  await t('session: cookie có HttpOnly + SameSite=Lax (+Secure trên https)', () => {
    const c = session.serializeCookie('tg_at', 'abc', { maxAge: 3600, secure: true });
    assert.ok(/HttpOnly/.test(c) && /SameSite=Lax/.test(c) && /Secure/.test(c) && /Max-Age=3600/.test(c) && /Path=\//.test(c));
  });
  await t('session: validate email/password', () => {
    assert.ok(session.validateEmail('  A@B.vn ').ok);
    assert.strictEqual(session.validateEmail('A@B.vn').value, 'a@b.vn');
    ['', 'abc', 'a@b', 'a b@c.vn', 'x'.repeat(260) + '@a.vn'].forEach((e) => assert.ok(!session.validateEmail(e).ok, e));
    assert.ok(!session.validatePassword('abc1').ok);
    assert.ok(!session.validatePassword('abcdefgh').ok);
    assert.ok(!session.validatePassword('12345678').ok);
    assert.ok(!session.validatePassword('a1'.repeat(40)).ok);
    assert.ok(session.validatePassword('matkhau123').ok);
  });
  await t('session: setSessionCookies ghi 3 cookie, dùng append không ghi đè', () => {
    const res = fakeRes();
    session.setSessionCookies({ headers: {} }, res, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }, { remember: true });
    const sc = res.getHeader('set-cookie');
    assert.ok(Array.isArray(sc) && sc.length === 3);
    session.clearSessionCookies({ headers: {} }, res);
    assert.strictEqual(res.getHeader('set-cookie').length, 6);
  });

  // ---------------- assets validate ----------------
  const png = (w, h, extra = 0) => {
    const b = Buffer.alloc(33 + extra);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
    return b;
  };
  await t('assets: PNG hợp lệ qua; kích thước vượt 4096 bị chặn', () => {
    assert.ok(assets.validateImage(png(64, 64), 'logo').ok);
    assert.strictEqual(assets.validateImage(png(5000, 10), 'logo').code, 'bad_dimensions');
    assert.strictEqual(assets.validateImage(png(0, 10), 'logo').code, 'bad_dimensions');
  });
  await t('assets: SVG / HTML / file giả đuôi bị từ chối theo magic bytes', () => {
    assert.strictEqual(assets.validateImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'logo').code, 'unsupported_type');
    assert.strictEqual(assets.validateImage(Buffer.from('<html><script>1</script></html>'), 'favicon').code, 'unsupported_type');
    assert.strictEqual(assets.validateImage(Buffer.alloc(0), 'logo').code, 'empty_file');
  });
  await t('assets: >1MB bị chặn; ICO chỉ cho favicon', () => {
    assert.strictEqual(assets.validateImage(png(10, 10, assets.MAX_BYTES), 'logo').code, 'file_too_large');
    const ico = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 22, 0, 0, 0]);
    assert.ok(assets.validateImage(ico, 'favicon').ok);
    assert.strictEqual(assets.validateImage(ico, 'logo').code, 'ico_only_favicon');
  });

  // ---------------- middleware quota (quotaService thay thế) ----------------
  const origQ = { ...quotaSvc };
  const restore = () => Object.assign(quotaSvc, origQ);
  const spy = () => { const calls = { reserve: [], settle: [], release: [] }; return calls; };

  await t('requireUser: không cookie => 401 auth_required, KHÔNG gọi next', async () => {
    const res = fakeRes(); let nexted = false;
    await mw.requireUser(fakeReq({ headers: { host: 'app.test' } }), res, () => { nexted = true; });
    assert.strictEqual(res.statusCode, 401); assert.strictEqual(res.body.code, 'auth_required'); assert.ok(!nexted);
    assert.strictEqual(res.getHeader('cache-control'), 'no-store');
  });
  await t('requireUser: Origin lạ trên POST => 403 bad_origin (trước cả xác thực)', async () => {
    const res = fakeRes(); let nexted = false;
    await mw.requireUser(fakeReq({ headers: { host: 'app.test', origin: 'https://evil.test', cookie: 'tg_at=x' } }), res, () => { nexted = true; });
    assert.strictEqual(res.statusCode, 403); assert.strictEqual(res.body.code, 'bad_origin'); assert.ok(!nexted);
  });
  await t('reserveQuota: thiếu req.user => fail-closed 500 auth_misordered', async () => {
    const res = fakeRes(); let nexted = false;
    await mw.reserveQuota('chat')(fakeReq(), res, () => { nexted = true; });
    assert.strictEqual(res.statusCode, 500); assert.ok(!nexted);
  });
  await t('reserveQuota: cooldown_active => 429 + Retry-After + mm:ss, không next', async () => {
    quotaSvc.reserve = async () => ({ ok: false, code: 'cooldown_active', retry_after_seconds: 2100, cooldown_until: '2026-01-01T00:00:00Z', tokens_used: 100000, token_limit: 100000 });
    const res = fakeRes(); let nexted = false;
    await mw.reserveQuota('chat')(fakeReq({ user: { id: 'u1' } }), res, () => { nexted = true; });
    restore();
    assert.strictEqual(res.statusCode, 429); assert.strictEqual(res.body.code, 'quota_cooldown');
    assert.strictEqual(res.getHeader('retry-after'), '2100'); assert.ok(/35:00/.test(res.body.error)); assert.ok(!nexted);
  });
  await t('reserveQuota: kho quota lỗi => 503 fail-closed (KHÔNG cho gọi model)', async () => {
    quotaSvc.reserve = async () => { throw new Error('db down'); };
    const res = fakeRes(); let nexted = false;
    await mw.reserveQuota('chat')(fakeReq({ user: { id: 'u1' } }), res, () => { nexted = true; });
    restore();
    assert.strictEqual(res.statusCode, 503); assert.strictEqual(res.body.code, 'quota_unavailable'); assert.ok(!nexted);
  });
  await t('reserveQuota: GET không đặt chỗ (không gọi model)', async () => {
    let reserved = false; quotaSvc.reserve = async () => { reserved = true; return { ok: true }; };
    let nexted = false;
    await mw.reserveQuota('chat')(fakeReq({ method: 'GET', user: { id: 'u1' } }), fakeRes(), () => { nexted = true; });
    restore(); assert.ok(nexted && !reserved);
  });

  async function runFlow({ record, status = 200, abort = false }) {
    const c = spy();
    quotaSvc.reserve = async (a) => { c.reserve.push(a); return { ok: true, granted: 8000 }; };
    quotaSvc.settle = async (a) => { c.settle.push(a); return { ok: true }; };
    quotaSvc.release = async (a) => { c.release.push(a); return { ok: true }; };
    const res = fakeRes();
    await mw.reserveQuota('chat')(fakeReq({ user: { id: 'u1' }, body: {} }), res, () => {
      if (record) record();
    });
    res.statusCode = status;
    if (abort) { res.emit('close'); await sleep(80); } else { res.emit('finish'); await sleep(20); }
    restore();
    return c;
  }
  await t('settle: ghi usage THẬT từ aiProviders (không phải mức đặt chỗ)', async () => {
    const c = await runFlow({ record: () => { usage.recordUsage({ usage: { inputTokens: 1200, outputTokens: 300 }, provider: 'anthropic', model: 'sonnet' }); } });
    assert.strictEqual(c.reserve.length, 1); assert.strictEqual(c.release.length, 0); assert.strictEqual(c.settle.length, 1);
    assert.strictEqual(c.settle[0].total, 1500); assert.strictEqual(c.settle[0].provider, 'anthropic');
    assert.strictEqual(c.settle[0].requestId, c.reserve[0].requestId);
  });
  await t('release: không có lượt gọi provider (cache hit / route không dùng AI)', async () => {
    const c = await runFlow({ record: null });
    assert.strictEqual(c.release.length, 1); assert.strictEqual(c.settle.length, 0);
  });
  await t('release: provider lỗi toàn bộ (không usage, response 502)', async () => {
    const c = await runFlow({ record: () => usage.recordUsage({ usage: null, provider: 'p' }), status: 502 });
    assert.strictEqual(c.release.length, 1); assert.strictEqual(c.settle.length, 0);
  });
  await t('settle: provider ĐÃ tính phí dù response lỗi => vẫn ghi usage thực', async () => {
    const c = await runFlow({ record: () => usage.recordUsage({ usage: { inputTokens: 400, outputTokens: 100 } }), status: 500 });
    assert.strictEqual(c.settle.length, 1); assert.strictEqual(c.settle[0].total, 500);
  });
  await t('settle: provider không báo usage nhưng có trả lời => tính bảo thủ theo mức đặt chỗ', async () => {
    const c = await runFlow({ record: () => usage.recordUsage({ usage: null, estimatedOutputTokens: 800 }) });
    assert.strictEqual(c.settle.length, 1); assert.strictEqual(c.settle[0].total, 8000);
  });
  await t('abort: client ngắt giữa chừng => vẫn settle theo usage đã ghi', async () => {
    const c = await runFlow({ record: () => usage.recordUsage({ usage: { inputTokens: 50, outputTokens: 50 } }), abort: true });
    assert.strictEqual(c.settle.length, 1); assert.strictEqual(c.settle[0].total, 100);
  });
  await t('finalize chỉ chạy một lần dù finish + close cùng phát', async () => {
    const c = spy();
    quotaSvc.reserve = async (a) => { c.reserve.push(a); return { ok: true, granted: 100 }; };
    quotaSvc.settle = async (a) => { c.settle.push(a); return { ok: true }; };
    quotaSvc.release = async (a) => { c.release.push(a); return { ok: true }; };
    const res = fakeRes();
    await mw.reserveQuota('chat')(fakeReq({ user: { id: 'u1' } }), res, () => usage.recordUsage({ usage: { inputTokens: 10, outputTokens: 10 } }));
    res.emit('finish'); res.emit('close'); await sleep(80); restore();
    assert.strictEqual(c.settle.length + c.release.length, 1);
  });

  // ---------------- báo cáo ----------------
  let failed = 0;
  results.forEach(([s, n, e]) => { console.log(`  ${s} ${n}`); if (s === 'FAIL') { failed += 1; console.log(String(e).split('\n').slice(0, 4).join('\n')); } });
  console.log(`\n${pass}/${results.length} pass`);
  process.exit(failed ? 1 : 0);
})();
