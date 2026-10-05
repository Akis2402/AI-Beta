'use strict';

// Test bổ sung (không cần mạng/DB): cấu hình mới, chi phí CỐ ĐỊNH (ảnh), chi phí ảnh qua generateImage() THẬT với fetch giả,
// và proof-of-work đăng ký (HMAC, hạn dùng, độ khó, chống dùng lại).
// Chạy: node test/auth-quota-extra.test.js   (hoặc `npm test`)

const assert = require('assert');
const crypto = require('crypto');
const { EventEmitter } = require('events');

let pass = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); pass += 1; results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e && e.stack]); }
}

process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_ANON_KEY = 'anon-key-not-jwt';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key-not-jwt';
process.env.NODE_ENV = 'test';
process.env.AI_ABORT_SETTLE_GRACE_MS = '20';
process.env.AI_IMAGE_TOKEN_COST = '4000';
process.env.AUTH_SIGNUP_POW_BITS = '14'; // đủ khó để kiểm tra, đủ nhanh để test
delete process.env.AUTH_ENFORCEMENT;
delete process.env.PUTER_VISUAL_MODE;
process.env.GEMINI_IMAGE_API_KEY = 'test-image-key';
process.env.IMAGE_PROVIDER_ORDER = 'gemini-image';

const cfgMod = require('../server/utils/quota/config');
const usage = require('../server/utils/quota/usageContext');
const quotaSvc = require('../server/utils/quota/quotaService');
const mw = require('../server/middleware/authQuota');
const pow = require('../server/utils/auth/pow');
const img = require('../server/utils/visual/imageGenerationClient');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function fakeRes() {
  const res = new EventEmitter();
  res.statusCode = 200; res.headers = {}; res.writableEnded = false;
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.getHeader = (k) => res.headers[k.toLowerCase()];
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; res.writableEnded = true; return res; };
  return res;
}
const fakeReq = (over = {}) => ({ method: 'POST', headers: { host: 'app.test' }, body: {}, ...over });
const lz = (buf) => { let bits = 0; for (const b of buf) { if (b === 0) { bits += 8; continue; } bits += Math.clz32(b) - 24; break; } return bits; };
function solve(salt, bits) { for (let n = 0; n < 5e6; n += 1) { if (lz(crypto.createHash('sha256').update(`${salt}:${n}`).digest()) >= bits) return n; } throw new Error('unsolved'); }

const realFetch = global.fetch;

(async () => {
  // ---------------- config ----------------
  await t('config: mặc định imageTokenCost=4000, powBits=16, signupPerHour=5', () => {
    const c = cfgMod.loadConfig({ NODE_ENV: 'test' });
    assert.strictEqual(c.quota.imageTokenCost, 4000);
    assert.strictEqual(c.auth.powBits, 16);
    assert.strictEqual(c.auth.signupPerHour, 5);
    assert.strictEqual(c.quota.reserve.visual, 4000);
  });
  await t('config: AUTH_SIGNUP_POW_BITS 0..24, RATE_LIMIT_SIGNUP/AI_IMAGE_TOKEN_COST sai => lỗi rõ ràng', () => {
    assert.strictEqual(cfgMod.loadConfig({ AUTH_SIGNUP_POW_BITS: '0' }).auth.powBits, 0);
    assert.strictEqual(cfgMod.loadConfig({ AUTH_SIGNUP_POW_BITS: '24' }).auth.powBits, 24);
    ['25', '-1', 'abc', '16.5'].forEach((v) => assert.throws(() => cfgMod.loadConfig({ AUTH_SIGNUP_POW_BITS: v }), /AUTH_SIGNUP_POW_BITS/));
    assert.throws(() => cfgMod.loadConfig({ RATE_LIMIT_SIGNUP: '0' }), /RATE_LIMIT_SIGNUP/);
    assert.throws(() => cfgMod.loadConfig({ AI_IMAGE_TOKEN_COST: '5' }), /AI_IMAGE_TOKEN_COST/);
  });

  // ---------------- chi phí cố định ----------------
  await t('recordFlatCost: không có context => no-op, không ném lỗi', () => {
    assert.strictEqual(usage.recordFlatCost(4000), false);
  });
  await t('recordFlatCost: cộng vào chargeable + coi là đã đo (metered) + cộng dồn nhiều ảnh', () => {
    const ctx = usage.createContext({ userId: 'u', requestId: 'r', kind: 'visual', granted: 1 });
    usage.run(ctx, () => { usage.recordFlatCost(4000, { provider: 'gemini-image' }); usage.recordFlatCost(4000); usage.recordUsage({ usage: { inputTokens: 100, outputTokens: 50 } }); });
    assert.strictEqual(ctx.meteredAttempts, 3);
    assert.strictEqual(usage.chargeableTokens(ctx), 8000 + 150);
    assert.strictEqual(ctx.provider, 'gemini-image');
  });
  await t('recordFlatCost: số không hợp lệ (0, âm, NaN) bị bỏ qua', () => {
    const ctx = usage.createContext({ userId: 'u', requestId: 'r', kind: 'visual', granted: 1 });
    usage.run(ctx, () => { usage.recordFlatCost(0); usage.recordFlatCost(-5); usage.recordFlatCost(NaN); });
    assert.strictEqual(usage.chargeableTokens(ctx), 0); assert.strictEqual(ctx.meteredAttempts, 0);
  });

  // ---------------- chi phí ảnh: generateImage() thật ----------------
  const geminiOk = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: TINY_PNG } }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  const PROMPT = 'Vẽ hình minh hoạ tam giác vuông ABC với các cạnh được ghi chú rõ ràng';

  await t('ảnh sinh THÀNH CÔNG qua generateImage() => ghi 4000 token-tương-đương vào sổ quota', async () => {
    global.fetch = async () => geminiOk();
    const ctx = usage.createContext({ userId: 'u', requestId: 'r', kind: 'visual', granted: 4000 });
    const out = await usage.run(ctx, () => img.generateImage({ prompt: PROMPT }));
    global.fetch = realFetch;
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    assert.strictEqual(ctx.flat, 4000); assert.strictEqual(ctx.meteredAttempts, 1);
    assert.strictEqual(usage.chargeableTokens(ctx), 4000);
  });
  await t('ảnh THẤT BẠI (provider 500) => KHÔNG tính phí', async () => {
    global.fetch = async () => new Response('{}', { status: 500 });
    const ctx = usage.createContext({ userId: 'u', requestId: 'r', kind: 'visual', granted: 4000 });
    const out = await usage.run(ctx, () => img.generateImage({ prompt: PROMPT }));
    global.fetch = realFetch;
    assert.strictEqual(out.ok, false); assert.strictEqual(ctx.flat, 0); assert.strictEqual(ctx.meteredAttempts, 0);
  });
  await t('ảnh sinh ngoài context quota (script/test) => vẫn hoạt động, không ném lỗi', async () => {
    global.fetch = async () => geminiOk();
    const out = await img.generateImage({ prompt: PROMPT });
    global.fetch = realFetch;
    assert.strictEqual(out.ok, true);
  });
  await t('ảnh 2 lần trong một request => tính 2 lần', async () => {
    global.fetch = async () => geminiOk();
    const ctx = usage.createContext({ userId: 'u', requestId: 'r', kind: 'chat', granted: 8000 });
    await usage.run(ctx, async () => { await img.generateImage({ prompt: PROMPT }); await img.generateImage({ prompt: PROMPT }); });
    global.fetch = realFetch;
    assert.strictEqual(ctx.flat, 8000);
  });

  // ---------------- middleware + ảnh: settle đúng số ----------------
  const origQ = { ...quotaSvc };
  const restore = () => Object.assign(quotaSvc, origQ);
  async function flow(record, status = 200) {
    const c = { reserve: [], settle: [], release: [] };
    quotaSvc.reserve = async (a) => { c.reserve.push(a); return { ok: true, granted: 4000 }; };
    quotaSvc.settle = async (a) => { c.settle.push(a); return { ok: true }; };
    quotaSvc.release = async (a) => { c.release.push(a); return { ok: true }; };
    const res = fakeRes();
    const done = new Promise((resolve) => {
      mw.reserveQuota('visual')(fakeReq({ user: { id: 'u1' } }), res, async () => { try { await record(); } finally { resolve(); } });
    });
    await done; res.statusCode = status; res.emit('finish'); await sleep(40); restore();
    return c;
  }
  await t('/api/visual: ảnh thành công => settle đúng 4000, kind=visual', async () => {
    global.fetch = async () => geminiOk();
    const c = await flow(() => img.generateImage({ prompt: PROMPT }));
    global.fetch = realFetch;
    assert.strictEqual(c.reserve[0].kind, 'visual');
    assert.strictEqual(c.settle.length, 1); assert.strictEqual(c.settle[0].total, 4000); assert.strictEqual(c.release.length, 0);
  });
  await t('/api/visual: ảnh lỗi hoặc cache hit => release (0 token)', async () => {
    global.fetch = async () => new Response('{}', { status: 500 });
    let c = await flow(() => img.generateImage({ prompt: PROMPT }), 502);
    assert.strictEqual(c.release.length, 1); assert.strictEqual(c.settle.length, 0);
    global.fetch = realFetch;
    c = await flow(async () => {});
    assert.strictEqual(c.release.length, 1); assert.strictEqual(c.settle.length, 0);
  });

  // ---------------- proof-of-work ----------------
  cfgMod._resetConfigForTest();
  pow._clearForTest();
  await t('pow: challenge hợp lệ + lời giải đúng => ok; dùng lại => pow_replay', async () => {
    const ch = pow.createChallenge();
    assert.strictEqual(ch.enabled, true); assert.strictEqual(ch.bits, 14);
    const nonce = solve(ch.salt, ch.bits);
    assert.deepStrictEqual(await pow.verify(ch.token, nonce), { ok: true });
    assert.strictEqual((await pow.verify(ch.token, nonce)).code, 'pow_replay');
  });
  await t('pow: nonce sai / không phải số / thiếu => từ chối, KHÔNG đốt challenge', async () => {
    const ch = pow.createChallenge();
    let bad = 0; while (lz(crypto.createHash('sha256').update(`${ch.salt}:${bad}`).digest()) >= ch.bits) bad += 1;
    assert.strictEqual((await pow.verify(ch.token, bad)).code, 'pow_invalid');
    assert.strictEqual((await pow.verify(ch.token, 'abc')).code, 'pow_invalid');
    assert.strictEqual((await pow.verify(ch.token, '1e9')).code, 'pow_invalid');
    assert.strictEqual((await pow.verify(ch.token, undefined)).code, 'pow_missing');
    assert.strictEqual((await pow.verify(undefined, 5)).code, 'pow_missing');
    assert.strictEqual((await pow.verify('x'.repeat(500), 5)).code, 'pow_missing');
    assert.deepStrictEqual(await pow.verify(ch.token, solve(ch.salt, ch.bits)), { ok: true }); // vẫn dùng được sau các lần thử sai
  });
  await t('pow: token bị sửa (đổi bit/salt/chữ ký) => pow_invalid', async () => {
    const ch = pow.createChallenge();
    const [body, sig] = ch.token.split('.');
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    const forged = Buffer.from(JSON.stringify({ ...p, b: 1 })).toString('base64url'); // hạ độ khó
    assert.strictEqual((await pow.verify(`${forged}.${sig}`, solve(p.s, 1))).code, 'pow_invalid');
    assert.strictEqual((await pow.verify(`${body}.${sig.slice(0, -2)}AA`, 1)).code, 'pow_invalid');
    assert.strictEqual((await pow.verify(`${body}`, 1)).code, 'pow_invalid');
    assert.strictEqual((await pow.verify(`.${sig}`, 1)).code, 'pow_invalid');
  });
  await t('pow: challenge hết hạn (>5 phút) => pow_expired', async () => {
    const ch = pow.createChallenge(Date.now() - 6 * 60 * 1000);
    assert.strictEqual((await pow.verify(ch.token, solve(ch.salt, ch.bits))).code, 'pow_expired');
  });
  await t('pow: challenge cấp khi độ khó thấp bị từ chối sau khi nâng độ khó (pow_weak)', async () => {
    const ch = pow.createChallenge();
    const nonce = solve(ch.salt, ch.bits);
    process.env.AUTH_SIGNUP_POW_BITS = '16'; cfgMod._resetConfigForTest();
    assert.strictEqual((await pow.verify(ch.token, nonce)).code, 'pow_weak');
    process.env.AUTH_SIGNUP_POW_BITS = '14'; cfgMod._resetConfigForTest();
  });
  await t('pow: token ký bằng khoá khác (AUTH_POW_SECRET đổi) => pow_invalid', async () => {
    const ch = pow.createChallenge();
    process.env.AUTH_POW_SECRET = 'another-secret'; cfgMod._resetConfigForTest();
    assert.strictEqual((await pow.verify(ch.token, solve(ch.salt, ch.bits))).code, 'pow_invalid');
    delete process.env.AUTH_POW_SECRET; cfgMod._resetConfigForTest();
  });
  await t('pow: AUTH_SIGNUP_POW_BITS=0 => tắt hoàn toàn (challenge disabled, verify luôn ok)', async () => {
    process.env.AUTH_SIGNUP_POW_BITS = '0'; cfgMod._resetConfigForTest();
    assert.deepStrictEqual(pow.createChallenge(), { enabled: false });
    assert.deepStrictEqual(await pow.verify(undefined, undefined), { ok: true });
    assert.strictEqual(pow.isEnabled(), false);
    process.env.AUTH_SIGNUP_POW_BITS = '14'; cfgMod._resetConfigForTest();
  });
  await t('pow: 50 challenge song song đều độc lập; mỗi lời giải dùng đúng 1 lần', async () => {
    const chs = Array.from({ length: 50 }, () => pow.createChallenge());
    assert.strictEqual(new Set(chs.map((c) => c.salt)).size, 50);
    const first = await Promise.all(chs.map((c) => pow.verify(c.token, solve(c.salt, c.bits))));
    assert.ok(first.every((r) => r.ok));
    const second = await Promise.all(chs.map((c) => pow.verify(c.token, solve(c.salt, c.bits))));
    assert.ok(second.every((r) => r.code === 'pow_replay'));
  });
  await t('pow: leadingZeroBits đúng ở biên', () => {
    assert.strictEqual(pow.leadingZeroBits(Buffer.from([0x00, 0x00, 0x0f])), 20);
    assert.strictEqual(pow.leadingZeroBits(Buffer.from([0x80])), 0);
    assert.strictEqual(pow.leadingZeroBits(Buffer.from([0x01])), 7);
    assert.strictEqual(pow.leadingZeroBits(Buffer.from([0, 0, 0, 0])), 32);
  });

  let failed = 0;
  results.forEach(([s, n, e]) => { console.log(`  ${s} ${n}`); if (s === 'FAIL') { failed += 1; console.log(String(e).split('\n').slice(0, 5).join('\n')); } });
  console.log(`\n${pass}/${results.length} pass`);
  process.exit(failed ? 1 : 0);
})();
