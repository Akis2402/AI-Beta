'use strict';

// ============================================================================================
// PUTER AUTH — Settings-only, KHÔNG BAO GIỜ tự popup. Chạy các file client THẬT trong vm + DOM giả:
//   puterAdapter.js (canonical auth state) · providerRouter.js · puterVisualManager.js · puterAuthUI.js
// SDK Puter được giả lập (đếm số lần signIn / txt2img / chat) — đây KHÔNG phải test với Puter thật.
// ============================================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const results = [];
const pending = [];
function atest(name, fn) { pending.push(Promise.resolve().then(fn).then(() => results.push({ name, pass: true }), (e) => results.push({ name, pass: false, error: e && (e.message || String(e)) }))); }
// các test dùng chung nhiều context -> chạy TUẦN TỰ để log/đếm không lẫn
let chain = Promise.resolve();
function seq(name, fn) { chain = chain.then(() => Promise.resolve().then(fn).then(() => results.push({ name, pass: true }), (e) => results.push({ name, pass: false, error: e && (e.message || String(e)) }))); pending.push(chain); }

// ---------------------------------------------------------------- DOM giả tối thiểu
function makeEl(tag, registry) {
  const el = {
    tagName: String(tag).toUpperCase(), children: [], attributes: {}, listeners: {}, style: {}, hidden: false, disabled: false, textContent: '', className: '', _id: '', parentNode: null,
    classList: { _set: new Set(), add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); }, contains(c) { return this._set.has(c); } },
    appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
    removeChild(c) { el.children = el.children.filter((x) => x !== c); c.parentNode = null; return c; },
    setAttribute(k, v) { el.attributes[k] = String(v); if (k === 'id') el._id = String(v); },
    getAttribute(k) { return k in el.attributes ? el.attributes[k] : null; },
    addEventListener(t, fn) { (el.listeners[t] = el.listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { el.listeners[t] = (el.listeners[t] || []).filter((f) => f !== fn); },
    click(ev) { (el.listeners.click || []).forEach((fn) => fn(ev || { isTrusted: false, type: 'click' })); },
    focus() {}, scrollIntoView() {}, querySelectorAll() { return []; }
  };
  Object.defineProperty(el, 'id', { get() { return el._id; }, set(v) { el._id = String(v); } });
  return el;
}

/** Dựng môi trường trình duyệt giả + nạp các script client thật. */
function makeEnv(opts = {}) {
  const o = { sdk: 'ok', signed: false, signIn: 'success', storage: null, settingsOpen: false, staticSettings: true, ...opts };
  const calls = { signIn: 0, signOut: 0, txt2img: 0, chat: 0, getUser: 0, windowOpen: 0, scripts: 0 };
  const store = o.storage || new Map();
  const state = { signed: o.signed };
  const timers = []; let now = 0;
  const puter = {
    auth: {
      isSignedIn: () => state.signed,
      signIn: () => { calls.signIn++; if (o.signIn === 'success') { state.signed = true; return Promise.resolve({ ok: true }); } if (o.signIn === 'cancel') return Promise.reject(new Error('auth window closed by user')); if (o.signIn === 'popup') return Promise.reject(new Error('popup blocked by browser')); return Promise.reject(new Error('boom')); },
      signOut: () => { calls.signOut++; state.signed = false; return Promise.resolve(); },
      getUser: () => { calls.getUser++; return Promise.resolve({ username: 'hoc_sinh' }); }
    },
    ai: {
      txt2img: (prompt) => { calls.txt2img++; if (o.txt2imgError) return Promise.reject(o.txt2imgError); return Promise.resolve({ nodeType: 1, tagName: 'IMG', src: 'data:image/png;base64,iVBORw0KGgo=' }); },
      chat: () => { calls.chat++; return Promise.resolve({ text: 'xin chào' }); }
    }
  };
  const body = makeEl('body'); const head = makeEl('head');
  const doc = {
    body, head, readyState: 'complete', hidden: false, _l: {},
    createElement: (t) => makeEl(t),
    getElementById(id) { const walk = (n) => { if (n.id === id) return n; for (const c of n.children) { const r = walk(c); if (r) return r; } return null; }; return walk(body); },
    addEventListener(t, fn) { (doc._l[t] = doc._l[t] || []).push(fn); }, removeEventListener(t, fn) { doc._l[t] = (doc._l[t] || []).filter((f) => f !== fn); },
    fire(t, ev) { (doc._l[t] || []).forEach((fn) => fn(ev)); }
  };
  head.appendChild = (s) => {
    s.parentNode = head; head.children.push(s); calls.scripts++;
    if (s.src && /js\.puter\.com/.test(s.src)) {
      if (o.sdk === 'ok') Promise.resolve().then(() => { sandbox.puter = puter; s.onload && s.onload(); });
      else if (o.sdk === 'fail') Promise.resolve().then(() => { s.onerror && s.onerror(); });
      // o.sdk === 'hang': không bao giờ phản hồi (test timeout)
    }
    return s;
  };
  const sandbox = {
    console, Promise, JSON, Math, Date, Object, Array, Set, Map, Error, String, Number, RegExp, Symbol, Blob, atob, encodeURIComponent, decodeURIComponent, Uint8Array, URL,
    document: doc, location: { search: '' },
    localStorage: { getItem: (k) => (o.storageThrows ? (() => { throw new Error('denied'); })() : (store.has(k) ? store.get(k) : null)), setItem: (k, v) => { if (o.storageThrows) throw new Error('denied'); store.set(k, String(v)); }, removeItem: (k) => store.delete(k) },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    setTimeout: (fn, ms) => { timers.push({ fn, at: now + (ms || 0), id: timers.length + 1 }); return timers.length; }, clearTimeout: (id) => { const t = timers.find((x) => x.id === id); if (t) t.dead = true; },
    open: () => { calls.windowOpen++; return null; }, _winListeners: {}
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = (t, fn) => { (sandbox._winListeners[t] = sandbox._winListeners[t] || []).push(fn); };
  sandbox.dispatchEvent = () => true;
  sandbox.Image = class { decode() { this.width = 1; this.height = 1; this.naturalWidth = 1; this.naturalHeight = 1; return Promise.resolve(); } };
  sandbox.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} };
  if (o.staticSettings) {
    const overlay = makeEl('div'); overlay.id = 'settingsOverlay'; if (o.settingsOpen) overlay.classList.add('show'); body.appendChild(overlay);
    const sec = makeEl('div'); sec.id = 'puterAuthSection'; body.appendChild(sec);
    ['puterAuthStatus', 'puterAuthUser', 'puterAuthBtn', 'puterSignOutBtn', 'puterRecheckBtn', 'puterAuthHelp'].forEach((id) => { const e = makeEl(id.endsWith('Btn') ? 'button' : 'span'); e.id = id; sec.appendChild(e); });
    sandbox.openSettings = () => { overlay.classList.add('show'); sandbox._opened = (sandbox._opened || 0) + 1; };
  }
  const ctx = vm.createContext(sandbox);
  const load = (p) => vm.runInContext(read(p), ctx, { filename: p });
  const env = {
    opts: o, ctx, win: sandbox, doc, calls, state, store, puter, timers, load,
    advance(ms) { now += ms; timers.filter((t) => !t.dead && t.at <= now).forEach((t) => { t.dead = true; t.fn(); }); },
    async flush() { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); },
    el: (id) => doc.getElementById(id),
    click: (id, trusted) => { const e = doc.getElementById(id); e.click({ isTrusted: !!trusted, type: 'click' }); }
  };
  return env;
}
function loadAdapter(env) { env.load('public/js/i18n/translations.js'); env.win.t = (k) => env.win.TRANSLATIONS.vi[k] || k; env.load('public/js/providers/puterAdapter.js'); return env.win.puterAdapter; }
const expectReject = async (p, code) => { let err = null; try { await p; } catch (e) { err = e; } assert.ok(err, 'phải reject'); if (code) assert.strictEqual(err.code, code, `mã lỗi: ${err.code} — ${err.message}`); return err; };
const trusted = { isTrusted: true, type: 'click' };

// ================================================================ A. Adapter: canonical state, KHÔNG popup
console.log('\n== A. puterAdapter — canonical auth state, không popup ==');
seq('A1. tải trang: init() chỉ nạp SDK + isSignedIn(): signIn=0, txt2img=0, chat=0, window.open=0; trạng thái unauthenticated', async () => {
  const e = makeEnv(); const a = loadAdapter(e).auth;
  assert.strictEqual(a.getState().status, 'unknown');
  await a.init(); await e.flush();
  assert.strictEqual(a.getState().status, 'unauthenticated'); assert.strictEqual(a.getState().provider, 'puter'); assert.ok(a.getState().checkedAt > 0);
  assert.deepStrictEqual([e.calls.signIn, e.calls.txt2img, e.calls.chat, e.calls.windowOpen], [0, 0, 0, 0]);
});
seq('A2. đã đăng nhập từ trước -> authenticated ngay khi init (không hỏi lại), lấy được username', async () => {
  const e = makeEnv({ signed: true }); const a = loadAdapter(e).auth; await a.init(); await e.flush();
  assert.strictEqual(a.getState().status, 'authenticated'); assert.strictEqual(a.getState().user.username, 'hoc_sinh'); assert.strictEqual(e.calls.signIn, 0);
});
seq('A3. generatePuterImage khi CHƯA Auth -> PUTER_AUTH_REQUIRED, KHÔNG chạm puter.ai.txt2img, KHÔNG signIn', async () => {
  const e = makeEnv(); const ad = loadAdapter(e);
  const err = await expectReject(ad.generatePuterImage({ visualId: 'v1', prompt: 'vẽ tế bào', ratio: '1:1' }), 'PUTER_AUTH_REQUIRED');
  assert.strictEqual(err.authRequired, true); assert.deepStrictEqual([e.calls.txt2img, e.calls.signIn, e.calls.windowOpen], [0, 0, 0]);
});
seq('A4. streamPuter (chat fallback nền) khi CHƯA Auth -> PUTER_AUTH_REQUIRED, KHÔNG gọi puter.ai.chat', async () => {
  const e = makeEnv(); const ad = loadAdapter(e);
  await expectReject(ad.streamPuter({ system: 's', messages: [{ role: 'user', content: 'hi' }] }, {}), 'PUTER_AUTH_REQUIRED'); assert.deepStrictEqual([e.calls.chat, e.calls.signIn], [0, 0]);
});
seq('A5. cổng cử chỉ: signIn không có event / event giả (isTrusted=false) bị TỪ CHỐI, signIn SDK = 0', async () => {
  const e = makeEnv(); const ad = loadAdapter(e); await ad.auth.init();
  await expectReject(ad.auth.signIn(), 'PUTER_AUTH_GESTURE_REQUIRED'); await expectReject(ad.auth.signIn({}), 'PUTER_AUTH_GESTURE_REQUIRED');
  await expectReject(ad.auth.signIn({ event: { isTrusted: false } }), 'PUTER_AUTH_GESTURE_REQUIRED'); await expectReject(ad.signIn(), 'PUTER_AUTH_GESTURE_REQUIRED'); // alias cũ cũng bị chặn
  assert.strictEqual(e.calls.signIn, 0);
});
seq('A6. click THẬT -> puter.auth.signIn() đúng 1 lần -> authenticated; người nghe được báo đúng 1 lần cho mỗi thay đổi', async () => {
  const e = makeEnv(); const ad = loadAdapter(e); await ad.auth.init();
  const seen = []; ad.auth.subscribe((s) => seen.push(s.status + (s.busy ? '+busy' : '')));
  const st = await ad.auth.signIn({ event: trusted });
  assert.strictEqual(st.status, 'authenticated'); assert.strictEqual(e.calls.signIn, 1); assert.ok(seen.includes('unauthenticated+busy') && seen[seen.length - 1].startsWith('authenticated'), seen.join(','));
  const before = seen.length; ad.auth.refresh(); ad.auth.refresh(); assert.strictEqual(seen.length, before, 'refresh không đổi gì thì KHÔNG được báo lại');
});
seq('A7. sau khi Auth: tạo ảnh chạy được (txt2img 1 lần), KHÔNG cần reload, trả về dataUrl', async () => {
  const e = makeEnv(); const ad = loadAdapter(e); await ad.auth.init(); await ad.auth.signIn({ event: trusted });
  const r = await ad.generatePuterImage({ visualId: 'v2', prompt: 'p', ratio: '1:1' }); assert.strictEqual(e.calls.txt2img, 1); assert.strictEqual(r.provider, 'puter'); assert.ok(/^data:image\/png/.test(r.dataUrl));
});
seq('A8. người dùng đóng cửa sổ Auth / popup bị chặn -> PUTER_AUTH_FAILED (+reason), vẫn unauthenticated, thử lại được', async () => {
  for (const [mode, reason] of [['cancel', 'auth_cancelled'], ['popup', 'popup_blocked'], ['other', 'auth_failed']]) {
    const e = makeEnv({ signIn: mode }); const ad = loadAdapter(e); await ad.auth.init();
    const err = await expectReject(ad.auth.signIn({ event: trusted }), 'PUTER_AUTH_FAILED'); assert.strictEqual(err.reason, reason);
    const st = ad.auth.getState(); assert.strictEqual(st.status, 'unauthenticated'); assert.strictEqual(st.busy, false); assert.strictEqual(st.errorMessage, reason);
  }
});
seq('A9. token bị từ chối lúc tạo ảnh -> PUTER_AUTH_FAILED + trạng thái error (yêu cầu Re-Auth) cho tới khi Auth lại', async () => {
  const e = makeEnv({ signed: true, txt2imgError: { code: 'token_auth_failed', message: 'Authentication failed' } }); const ad = loadAdapter(e); await ad.auth.init();
  await expectReject(ad.generatePuterImage({ visualId: 'v3', prompt: 'p' }), 'PUTER_AUTH_FAILED');
  assert.strictEqual(ad.auth.getState().status, 'error'); ad.auth.refresh(); assert.strictEqual(ad.auth.getState().status, 'error', 'SDK vẫn báo signed-in nhưng token đã hỏng -> phải giữ error');
  e.puter.ai.txt2img = () => Promise.resolve({ nodeType: 1, tagName: 'IMG', src: 'data:image/png;base64,AAAA' });
  await ad.auth.signIn({ event: trusted }); assert.strictEqual(ad.auth.getState().status, 'authenticated');
});
seq('A10. phân loại lỗi -> đủ mã PUTER_* (không dùng lỗi chung chung)', async () => {
  const e = makeEnv(); const ad = loadAdapter(e);
  const table = [
    [{ code: 'insufficient_funds', message: 'no funds' }, 'PUTER_INSUFFICIENT_FUNDS'], [{ status: 402 }, 'PUTER_INSUFFICIENT_FUNDS'], [{ code: 'moderation_flagged' }, 'PUTER_CONTENT_REFUSED'],
    [{ code: 'token_auth_failed' }, 'PUTER_AUTH_FAILED'], [{ status: 401 }, 'PUTER_AUTH_FAILED'], [{ status: 429 }, 'PUTER_RATE_LIMIT'], [{ message: 'rate limit exceeded' }, 'PUTER_RATE_LIMIT'],
    [{ code: 'upstream_failed' }, 'PUTER_PROVIDER_ERROR'], [{ status: 503 }, 'PUTER_PROVIDER_ERROR'], [{ message: 'Failed to fetch' }, 'PUTER_NETWORK_ERROR'], [{ message: 'request timeout' }, 'PUTER_NETWORK_ERROR'],
    [{ code: 'invalid_output' }, 'PUTER_INVALID_RESULT'], [{ message: 'lỗi lạ hoàn toàn' }, 'PUTER_GENERATION_FAILED']
  ];
  table.forEach(([raw, code]) => assert.strictEqual(ad.classifyPuterError(raw).code, code, JSON.stringify(raw)));
  ['AUTH_REQUIRED', 'SDK_UNAVAILABLE', 'AUTH_FAILED', 'GENERATION_FAILED', 'INVALID_RESULT', 'IMAGE_VALIDATION_FAILED', 'RATE_LIMIT', 'NETWORK_ERROR', 'PROVIDER_ERROR'].forEach((k) => assert.strictEqual(ad.PUTER_ERR[k], 'PUTER_' + k));
});
seq('A11. ảnh trả về không phải HTMLImageElement -> PUTER_INVALID_RESULT', async () => {
  const e = makeEnv({ signed: true }); const ad = loadAdapter(e); await ad.auth.init(); e.puter.ai.txt2img = () => Promise.resolve({ not: 'an image' });
  await expectReject(ad.generatePuterImage({ visualId: 'v4', prompt: 'p' }), 'PUTER_INVALID_RESULT');
});
seq('A12. SDK không tải được -> status error + PUTER_SDK_UNAVAILABLE; init KHÔNG throw; retryInit khôi phục; tạo ảnh báo đúng mã', async () => {
  const e = makeEnv({ sdk: 'fail' }); const ad = loadAdapter(e); await ad.auth.init();
  assert.strictEqual(ad.auth.getState().status, 'error'); assert.strictEqual(ad.auth.getState().errorCode, 'PUTER_SDK_UNAVAILABLE');
  await expectReject(ad.generatePuterImage({ visualId: 'v5', prompt: 'p' }), 'PUTER_SDK_UNAVAILABLE');
  e.win.puter = undefined; e.opts.sdk = 'ok'; // SDK "sống lại"
  const st = await ad.auth.retryInit(); assert.strictEqual(st.status, 'unauthenticated');
});
seq('A13. init idempotent: gọi nhiều lần chỉ nạp SDK 1 lần', async () => { const e = makeEnv(); const ad = loadAdapter(e); await Promise.all([ad.auth.init(), ad.auth.init(), ad.auth.init()]); assert.strictEqual(e.calls.scripts, 1); });
seq('A14. signOut chỉ có khi SDK thật sự có puter.auth.signOut (không tạo API giả)', async () => {
  const e = makeEnv({ signed: true }); const ad = loadAdapter(e); await ad.auth.init(); assert.strictEqual(ad.auth.canSignOut(), true); await ad.auth.signOut(); assert.strictEqual(ad.auth.getState().status, 'unauthenticated');
  const e2 = makeEnv({ signed: true }); delete e2.puter.auth.signOut; const ad2 = loadAdapter(e2); await ad2.auth.init(); assert.strictEqual(ad2.auth.canSignOut(), false); await expectReject(ad2.auth.signOut());
});
seq('A15. isSignedIn() ném lỗi -> status error (không crash)', async () => { const e = makeEnv(); e.puter.auth.isSignedIn = () => { throw new Error('x'); }; const ad = loadAdapter(e); await ad.auth.init(); assert.strictEqual(ad.auth.getState().status, 'error'); });

// ================================================================ B. providerRouter
console.log('\n== B. providerRouter — fallback Puter CHỈ khi đã Auth ==');
function routerEnv(signed) {
  const e = makeEnv({ signed }); const ad = loadAdapter(e); e.load('public/js/providers/providerRouter.js');
  const serverErr = Object.assign(new Error('all providers failed'), { status: 503 });
  e.win.apiPostStream = async () => { throw serverErr; };
  return { e, ad, serverErr };
}
seq('B1. server cạn provider + Puter CHƯA Auth -> ném LẠI lỗi gốc của server, không gọi puter.ai.chat, không popup', async () => {
  const { e, ad, serverErr } = routerEnv(false); await ad.auth.init();
  const err = await expectReject(e.win.streamViaProviderRouter('/api/chat', { query: 'x', history: [] }, {})); assert.strictEqual(err, serverErr); assert.strictEqual(err.puterFallbackSkipped, 'PUTER_AUTH_REQUIRED');
  assert.deepStrictEqual([e.calls.chat, e.calls.signIn, e.calls.windowOpen], [0, 0, 0]);
});
seq('B2. server cạn provider + Puter ĐÃ Auth -> fallback Puter chạy (chat 1 lần)', async () => {
  const { e, ad } = routerEnv(true); await ad.auth.init();
  const r = await e.win.streamViaProviderRouter('/api/chat', { query: 'x', history: [] }, {}); assert.strictEqual(r.provider, 'puter'); assert.strictEqual(e.calls.chat, 1);
});

// ================================================================ C. puterVisualManager (job chờ Auth)
console.log('\n== C. puterVisualManager — job chờ Auth ==');
function managerEnv(signed) {
  const e = makeEnv({ signed }); const ad = loadAdapter(e);
  e.win.chatImageStore = { save: async () => {}, get: async () => ({ url: 'blob:stored' }) };
  e.load('public/js/visual/puterVisualManager.js'); return { e, ad, m: e.win.puterVisualManager };
}
const job = (id) => ({ visualId: id, visualFingerprint: 'fp-' + id, renderer: 'puter_image', prompt: 'p', ratio: '1:1', quality: 'standard', status: 'QUEUED', inputImageIds: [] });
seq('C1. enqueue khi CHƯA Auth -> PUTER_AUTH_REQUIRED, không signIn/không popup, không tính vào giới hạn thử lại', async () => {
  const { e, ad, m } = managerEnv(false); await ad.auth.init(); await expectReject(m.enqueue(job('c1')), 'PUTER_AUTH_REQUIRED'); assert.deepStrictEqual([e.calls.signIn, e.calls.txt2img, e.calls.windowOpen], [0, 0, 0]);
});
seq('C2. job đỗ autoResume=true tự chạy khi người dùng Auth (không cần bấm lại); autoResume=false thì CHỜ nút', async () => {
  const { e, ad, m } = managerEnv(false); await ad.auth.init();
  const got = []; m.park(job('c2a'), { autoResume: true, onReady: (v) => got.push('a:' + v.status) }); m.park(job('c2b'), { autoResume: false, onReady: (v) => got.push('b') });
  assert.strictEqual(m.getParkedCount(), 2); assert.strictEqual(e.calls.txt2img, 0);
  await ad.auth.signIn({ event: trusted }); await e.flush(); await e.flush();
  assert.deepStrictEqual(got, ['a:READY']); assert.strictEqual(e.calls.txt2img, 1); assert.strictEqual(m.getParkedCount(), 1);
  const v = await m.runNow(job('c2b')); assert.strictEqual(v.status, 'READY'); assert.strictEqual(m.getParkedCount(), 0);
});
seq('C3. mã lỗi kiểm tra ảnh dùng PUTER_IMAGE_VALIDATION_FAILED', async () => {
  const { e, ad, m } = managerEnv(true); await ad.auth.init(); await expectReject(m.validatePuterImageBlob(new e.win.Blob([])), 'PUTER_IMAGE_VALIDATION_FAILED');
});

seq('C4. JOB TRÙNG: enqueue đồng thời cùng visualId chỉ tạo ảnh MỘT lần (txt2img=1) — idempotent', async () => {
  const { e, ad, m } = managerEnv(true); await ad.auth.init(); const [a, b, c] = await Promise.all([m.enqueue(job('dup')), m.enqueue(job('dup')), m.enqueue(job('dup'))]);
  assert.strictEqual(e.calls.txt2img, 1, 'txt2img=' + e.calls.txt2img); assert.strictEqual(a.status, 'READY'); assert.ok(b && c);
});
seq('C5. Kho ảnh (IndexedDB) lỗi lúc lưu: ảnh ĐÃ tạo KHÔNG bị vứt — giữ trong phiên bằng object URL, kèm storageError; không crash, không unhandled rejection', async () => {
  const { e, ad, m } = managerEnv(true); await ad.auth.init(); e.win.chatImageStore = { save: async () => { throw new Error('QuotaExceededError: IndexedDB'); }, get: async () => null };
  let unhandled = 0; const h = () => { unhandled++; }; process.on('unhandledRejection', h);
  const out = await m.enqueue(job('idb')); await e.flush(); process.removeListener('unhandledRejection', h);
  assert.strictEqual(unhandled, 0); assert.strictEqual(out.status, 'READY'); assert.strictEqual(out.format, 'image_url'); assert.ok(/^blob:/.test(out.url)); assert.strictEqual(out.imageId, null); assert.ok(/Quota/.test(out.storageError)); assert.strictEqual(e.calls.txt2img, 1);
});
seq('C6. SSE lặp lại (duplicate event): cùng job 2 lần sau khi xong -> KHÔNG tạo thêm ảnh khi đã READY', async () => {
  const { e, ad, m } = managerEnv(true); await ad.auth.init(); await m.enqueue(job('dup2')); const before = e.calls.txt2img; let again = null; try { again = await m.enqueue(job('dup2')); } catch (x) { again = x; }
  assert.strictEqual(e.calls.txt2img, before, 'không được tạo lại ảnh cho job đã READY'); assert.ok(again);
});

// ================================================================ D. puterAuthUI
console.log('\n== D. puterAuthUI — Settings + popup thông báo ==');
function uiEnv(opts) { const e = makeEnv(opts); const ad = loadAdapter(e); e.load('public/js/ui/puterAuthUI.js'); return { e, ad, ui: e.win.puterAuthUI }; }
const NOTICE_VI = 'Phần tạo hình ảnh bằng AI chưa dùng được vì chưa Auth Puter.js, hãy Auth trong setting. Các tính năng khác thì không sao.';
const notice = (e) => e.doc.getElementById('puterAuthNotice');
seq('D1. chính sách NGÀY LỊCH (không phải 24h): dismissedUntilDate = YYYY-MM-DD theo giờ địa phương', async () => {
  const { ui } = uiEnv({}); const d = (y, m, dd, h, mi) => new Date(y, m - 1, dd, h, mi);
  assert.strictEqual(ui.localDateKey(d(2026, 1, 5, 23, 59)), '2026-01-05'); assert.strictEqual(ui.localDateKey(d(2026, 1, 6, 0, 1)), '2026-01-06'); assert.strictEqual(ui.localDateKey(d(2026, 12, 31, 12, 0)), '2026-12-31');
  ui.dismissForToday(d(2026, 1, 5, 23, 59));
  assert.strictEqual(ui.isDismissedForToday(d(2026, 1, 5, 23, 59)), true); assert.strictEqual(ui.isDismissedForToday(d(2026, 1, 5, 0, 1)), true);
  assert.strictEqual(ui.isDismissedForToday(d(2026, 1, 6, 0, 1)), false, 'sang ngày mới (dù mới 2 phút sau) là hết hiệu lực — không phải mốc 24h');
  assert.strictEqual(ui.isDismissedForToday(d(2026, 1, 4, 12, 0)), true, 'đồng hồ lùi lại vẫn coi là đã tắt (không hiện lại bất ngờ)');
  assert.strictEqual(ui.isDismissedForToday(d(2027, 1, 5, 12, 0)), false);
});
seq('D2. tải trang chưa Auth: sau init + 1,2 s mới hiện THÔNG BÁO đúng chữ; signIn = 0 (thông báo KHÔNG phải popup Auth)', async () => {
  const { e, ad, ui } = uiEnv({}); await ad.auth.init(); await e.flush();
  assert.strictEqual(notice(e), null, 'chưa hiện ngay lúc load'); e.advance(1300);
  const n = notice(e); assert.ok(n, 'phải hiện thông báo'); assert.strictEqual(n.getAttribute('role'), 'dialog');
  const body = n.children.find((c) => c.id === 'puterNoticeBody'); assert.strictEqual(body.textContent, NOTICE_VI);
  assert.deepStrictEqual([e.calls.signIn, e.calls.windowOpen, e.calls.txt2img], [0, 0, 0]); assert.strictEqual(n.children[2].children.length, 3, '3 nút: Mở Settings / Đã hiểu / Không hiển thị lại hôm nay');
});
seq('D3. "Đã hiểu" = tắt MỘT LẦN: không lưu ngày; tải trang lần sau hiện lại; trong cùng trang không hiện lại', async () => {
  const { e, ad, ui } = uiEnv({}); await ad.auth.init(); await e.flush(); e.advance(1300);
  const btns = notice(e).children[2].children; assert.strictEqual(btns[1].textContent, 'Đã hiểu'); btns[1].click(); assert.strictEqual(notice(e), null); assert.strictEqual(e.store.size, 0);
  assert.strictEqual(ui.shouldShowNotice(ad.auth.getState(), new Date()), false, 'cùng một lần tải trang: KHÔNG hiện lại (SSE reconnect/re-render không nag)');
  const e2 = makeEnv({ storage: e.store }); loadAdapter(e2); e2.load('public/js/ui/puterAuthUI.js'); await e2.win.puterAdapter.auth.init(); await e2.flush(); e2.advance(1300); assert.ok(notice(e2), 'tải lại trang -> hiện lại');
});
seq('D4. "Không hiển thị lại hôm nay" -> lưu ngày lịch hôm nay; tải lại trang KHÔNG hiện; ngày mai hiện lại', async () => {
  const { e, ad, ui } = uiEnv({}); await ad.auth.init(); await e.flush(); e.advance(1300);
  const btns = notice(e).children[2].children; assert.strictEqual(btns[2].textContent, 'Không hiển thị lại hôm nay'); btns[2].click(); assert.strictEqual(notice(e), null);
  assert.strictEqual(e.store.get(ui.DISMISS_KEY), ui.localDateKey(new Date()));
  const e2 = makeEnv({ storage: e.store }); loadAdapter(e2); e2.load('public/js/ui/puterAuthUI.js'); await e2.win.puterAdapter.auth.init(); await e2.flush(); e2.advance(5000); assert.strictEqual(notice(e2), null, 'cùng ngày -> không hiện');
  const yest = new Date(); yest.setDate(yest.getDate() - 1); e.store.set(ui.DISMISS_KEY, e2.win.puterAuthUI.localDateKey(yest));
  const e3 = makeEnv({ storage: e.store }); loadAdapter(e3); e3.load('public/js/ui/puterAuthUI.js'); await e3.win.puterAdapter.auth.init(); await e3.flush(); e3.advance(1300); assert.ok(notice(e3), 'ngày mới -> hiện lại');
});
seq('D5. đã Auth / unknown / SDK lỗi / đang mở Settings -> KHÔNG hiện thông báo', async () => {
  for (const [name, opts] of [['authenticated', { signed: true }], ['sdk-fail', { sdk: 'fail' }], ['settings-open', { settingsOpen: true }]]) {
    const { e, ad } = uiEnv(opts); await ad.auth.init(); await e.flush(); e.advance(5000); assert.strictEqual(notice(e), null, name); assert.strictEqual(e.calls.signIn, 0, name);
  }
  const { ui } = uiEnv({}); assert.strictEqual(ui.shouldShowNotice({ status: 'unknown' }, new Date()), false); assert.strictEqual(ui.shouldShowNotice({ status: 'error' }, new Date()), false);
});
seq('D6. Auth thành công -> thông báo tự đóng; Settings hiển thị "Đã Auth" + username + Re-Auth; không cần reload', async () => {
  const { e, ad } = uiEnv({}); await ad.auth.init(); await e.flush(); e.advance(1300); assert.ok(notice(e));
  assert.strictEqual(e.el('puterAuthStatus').textContent, 'Trạng thái'.length ? e.win.TRANSLATIONS.vi['puter.status.unauthenticated'] : '');
  await ad.auth.signIn({ event: trusted }); await e.flush();
  assert.strictEqual(notice(e), null); assert.strictEqual(e.el('puterAuthStatus').textContent, e.win.TRANSLATIONS.vi['puter.status.authenticated']); assert.strictEqual(e.el('puterAuthBtn').textContent, 'Re-Auth');
  assert.ok(/hoc_sinh/.test(e.el('puterAuthUser').textContent)); assert.strictEqual(e.el('puterSignOutBtn').hidden, false);
});
seq('D7. nút Auth trong Settings: click GIẢ (isTrusted=false) KHÔNG gọi signIn; click THẬT gọi đúng 1 lần', async () => {
  const { e, ad } = uiEnv({}); await ad.auth.init(); await e.flush();
  e.click('puterAuthBtn', false); await e.flush(); assert.strictEqual(e.calls.signIn, 0); assert.strictEqual(ad.auth.getState().status, 'unauthenticated');
  e.click('puterAuthBtn', true); await e.flush(); assert.strictEqual(e.calls.signIn, 1); assert.strictEqual(ad.auth.getState().status, 'authenticated');
});
seq('D8. lỗi Auth hiển thị đúng lý do ngay trong Settings (popup bị chặn / đóng cửa sổ)', async () => {
  const { e, ad } = uiEnv({ signIn: 'popup' }); await ad.auth.init(); await e.flush(); e.click('puterAuthBtn', true); await e.flush();
  assert.strictEqual(e.el('puterAuthHelp').textContent, e.win.TRANSLATIONS.vi['puter.err.popup_blocked']); assert.strictEqual(e.el('puterAuthBtn').disabled, false);
});
seq('D9. SDK lỗi: Settings báo lỗi + hiện nút "Kiểm tra lại"; nút Auth không làm app sập', async () => {
  const { e, ad } = uiEnv({ sdk: 'fail' }); await ad.auth.init(); await e.flush(); assert.strictEqual(e.el('puterRecheckBtn').hidden, false); assert.strictEqual(e.el('puterAuthHelp').textContent, e.win.TRANSLATIONS.vi['puter.err.sdk']);
  e.click('puterAuthBtn', true); await e.flush(); assert.strictEqual(e.calls.signIn, 0);
});
seq('D10. "Mở Settings" chỉ ĐIỀU HƯỚNG (mở modal + cuộn tới mục Puter) — KHÔNG gọi signIn', async () => {
  const { e, ad, ui } = uiEnv({}); await ad.auth.init(); ui.openSettingsAtPuter(); assert.strictEqual(e.win._opened, 1); assert.strictEqual(e.calls.signIn, 0);
});
seq('D11. localStorage bị chặn (private mode): không crash, vẫn không nag trong cùng trang', async () => {
  const { e, ad, ui } = uiEnv({ storageThrows: true }); await ad.auth.init(); await e.flush(); e.advance(1300); notice(e).children[2].children[2].click(); assert.strictEqual(notice(e), null); assert.strictEqual(ui.isDismissedForToday(new Date()), true);
});

// ================================================================ E. Hợp đồng tĩnh (mã nguồn)
console.log('\n== E. Hợp đồng tĩnh ==');
const clientFiles = [];
(function walk(dir) { fs.readdirSync(path.join(root, dir)).forEach((f) => { const p = dir + '/' + f; if (fs.statSync(path.join(root, p)).isDirectory()) return walk(p); if (/\.js$/.test(f) && !/\.[0-9a-f]{10}\.js$/.test(f)) clientFiles.push(p); }); })('public/js');
seq('E1. CHỈ puterAdapter.js được gọi puter.auth.signIn() / puter.ai.* (không file client nào khác)', async () => {
  const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
  clientFiles.filter((f) => !/providers\/puterAdapter\.js$/.test(f)).forEach((f) => { const s = stripComments(read(f)); assert.ok(!/puter\.auth\.signIn\s*\(/.test(s), `${f} gọi puter.auth.signIn()`); assert.ok(!/\bputer\.ai\./.test(s), `${f} gọi puter.ai.*`); assert.ok(!/\.signIn\s*\(\s*\)/.test(s), `${f} gọi signIn() không có event`); });
  assert.strictEqual((read('public/js/providers/puterAdapter.js').match(/puter\.auth\.signIn\s*\(/g) || []).length, 1, 'adapter chỉ có ĐÚNG 1 chỗ gọi puter.auth.signIn()');
});
seq('E2. adapter: signIn chỉ nằm trong signInFromUserGesture (có isTrusted); init/refresh/requireAuthenticated KHÔNG gọi signIn; mọi puter.ai.* đứng sau requireAuthenticated()', async () => {
  const s = read('public/js/providers/puterAdapter.js'); const fn = (name) => { const i = s.indexOf(name); assert.ok(i >= 0, name); return s.slice(i, i + 1600); };
  assert.ok(/isTrusted\s*!==\s*true/.test(fn('function signInFromUserGesture')));
  ['function initPuterAuth', 'function refreshAuthState', 'async function requireAuthenticated', 'function loadPuterSdk'].forEach((n) => assert.ok(!/signIn\s*\(/.test(fn(n).split('\n\n')[0]), n + ' không được gọi signIn'));
  const gen = s.slice(s.indexOf('async function generatePuterImage'), s.indexOf('/** PHẦN S: capability vision')); assert.ok(gen.indexOf('requireAuthenticated()') > 0 && gen.indexOf('requireAuthenticated()') < gen.indexOf('puter.ai.txt2img'));
  const st = s.slice(s.indexOf('async function streamPuter'), s.indexOf('function makePuterCancelledError')); assert.ok(st.indexOf('requireAuthenticated()') > 0 && st.indexOf('requireAuthenticated()') < st.indexOf('puter.ai.chat'));
});
seq('E3. index.html: mục Settings Puter có đủ id + script nạp SAU adapter/manager, TRƯỚC app.js; không handler inline', async () => {
  const h = read('public/index.html'); ['puterAuthSection', 'puterAuthStatus', 'puterAuthUser', 'puterAuthBtn', 'puterSignOutBtn', 'puterRecheckBtn', 'puterAuthHelp'].forEach((id) => assert.ok(h.includes(`id="${id}"`), id));
  const pos = (n) => h.search(new RegExp(`<script src="/js/${n}(\\.[0-9a-f]{10})?\\.js"`)); assert.ok(pos('providers/puterAdapter') < pos('visual/puterVisualManager') && pos('visual/puterVisualManager') < pos('ui/puterAuthUI') && pos('ui/puterAuthUI') < pos('app'), 'thứ tự script');
  assert.ok(!/\son(click|load)=/i.test(h.slice(h.indexOf('id="puterAuthSection"'), h.indexOf('id="puterAuthSection"') + 1800)));
});
seq('E4. build.js fingerprint puterAuthUI.js; CSP giữ nguyên (không nới thêm cho Auth)', async () => { const b = read('scripts/build.js'); assert.ok(/UI_JS\s*=\s*\['puterAuthUI\.js'\]/.test(b) && /process\('js\/ui', UI_JS\)/.test(b)); const sec = read('server/middleware/security.js'); assert.ok(!/frame-src|childSrc|frameSrc/.test(sec), 'không nới CSP frame'); });
seq('E5. app.js: gửi clientCaps.puterAuth trong /api/chat; không còn signInAndResume; thẻ Auth chỉ mở Settings', async () => {
  const s = read('public/js/app.js'); assert.ok(/withClientCaps\(path, body\)/.test(s) && s.includes('function buildClientCaps'));
  assert.ok(!s.includes('signInAndResume'), 'không còn signInAndResume'); const card = s.slice(s.indexOf('function renderVisualAuthCard'), s.indexOf('function puterFailKey')); assert.ok(/openSettingsAtPuter/.test(card) && !/\.signIn\s*\(/.test(card), 'thẻ Auth chỉ điều hướng tới Settings');
});
seq('E5b. UI trạng thái: "Đang tạo hình ảnh AI…" cho Puter, dòng nhắc nhẹ chỉ MỘT lần/trang + nút Mở Settings, thẻ mâu thuẫn không có nút thử lại', async () => {
  const s = read('public/js/app.js'); assert.ok(/t\('visual\.status\.ai'\)/.test(s)); const n = s.slice(s.indexOf('function renderVisualNoticeCard'), s.indexOf('/** Thẻ "cần Auth Puter"'));
  assert.ok(/puterSkipNoteId/.test(n) && /openSettingsAtPuter/.test(n) && /puter\.skip\.message/.test(n) && !/retry/i.test(n), 'thẻ notice');
});
seq('E6. i18n: đủ khoá puter.* ở vi+en, chữ thông báo vi ĐÚNG NGUYÊN VĂN', async () => {
  const e = makeEnv(); e.load('public/js/i18n/translations.js'); const T = e.win.TRANSLATIONS; assert.strictEqual(T.vi['puter.notice.body'], NOTICE_VI);
  const ks = Object.keys(T.vi).filter((k) => /^(puter|visual\.svg|visual\.notice)/.test(k)); assert.ok(ks.length >= 38); ks.forEach((k) => { assert.ok(k in T.en, 'thiếu en: ' + k); assert.ok(T.en[k].length > 0); });
  assert.deepStrictEqual(Object.keys(T.vi).filter((k) => !(k in T.en)), []); assert.deepStrictEqual(Object.keys(T.en).filter((k) => !(k in T.vi)), []);
});
seq('E7. CSS: có style popup thông báo + trạng thái Auth + SVG card, theme-aware (dùng biến), responsive', async () => {
  const c = read('public/css/styles.css'); ['.puter-notice', '.puter-status[data-status="authenticated"]', '.visual-svg-wrap', '.visual-card-notice'].forEach((s) => assert.ok(c.includes(s), s)); assert.ok(/\.puter-notice\s*\{[^}]*var\(--paper-3/.test(c)); assert.ok(/@media \(max-width: 640px\) \{ \.puter-notice/.test(c));
});

chain.then(() => Promise.all(pending)).then(() => {
  let passed = 0, failed = 0;
  results.forEach((r) => { if (r.pass) { passed++; console.log('  ok  - ' + r.name); } else { failed++; console.log(' FAIL - ' + r.name + '\n        ' + r.error); } });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
});
