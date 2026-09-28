'use strict';

// MỤC 2.1 (backlog v6.22, .72) — latency_breakdown: fake provider có độ trễ BIẾT TRƯỚC -> số đo đúng sai số.
const assert = require('assert');
const lb = require('../server/utils/latencyBreakdown');
const tests = []; const test = (n, f) => tests.push({ n, f });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('L1. unit (đồng hồ giả): queue/pre/provider/post tách đúng, tổng khớp', () => {
  let t = 1000; const tr = lb.createTracker({ now: () => t });
  tr.markQueueStart(); t = 1100; tr.markAdmitted();          // chờ 100
  t = 1150;                                                   // chuẩn bị 50
  t = 1350; tr.recordProviderSpan(200, 1350);                 // provider 200
  const s = tr.summarize(1400);                               // hậu xử lý 50
  assert.deepStrictEqual(s, { queueWaitMs: 100, preProviderMs: 50, providerRunMs: 200, providerCalls: 1, postProcessMs: 50, totalMs: 400 });
});
test('L2. provider SONG SONG (cross-check) không bị cộng dồn: hợp khoảng, không tổng', () => {
  const tr = lb.createTracker({ now: () => 0 });
  tr.recordProviderSpan(300, 400); tr.recordProviderSpan(300, 450); tr.recordProviderSpan(50, 600); // [100,400][150,450][550,600]
  const s = tr.summarize(700);
  assert.strictEqual(s.providerRunMs, 350 + 50);  // hợp [100,450] + [550,600]
  assert.strictEqual(s.providerCalls, 3);
});
test('L3. không có lệnh gọi provider (cache hit) -> pre/post = null, không NaN', () => {
  const s = lb.createTracker({ now: () => 5 }).summarize(5);
  assert.strictEqual(s.providerRunMs, 0); assert.strictEqual(s.preProviderMs, null); assert.strictEqual(s.postProcessMs, null);
});
test('L4. registry: recordProviderSpan no-op khi thiếu requestId/tracker; finish() idempotent, xoá tracker', () => {
  assert.doesNotThrow(() => lb.recordProviderSpan(undefined, 5));
  assert.doesNotThrow(() => lb.recordProviderSpan('khong-ton-tai', 5));
  lb.begin('req-x'); assert.ok(lb.finish('req-x')); assert.strictEqual(lb.finish('req-x'), null);
});
test('L5. fake provider trễ ĐÚNG 200ms (đồng hồ thật): providerRunMs ∈ [190,320], total >= provider', async () => {
  const tr = lb.begin('req-real');
  tr.markQueueStart(); tr.markAdmitted();
  await sleep(30);
  const start = Date.now(); await sleep(200); lb.recordProviderSpan('req-real', Date.now() - start);
  await sleep(20);
  const s = lb.finish('req-real');
  assert.ok(s.providerRunMs >= 190 && s.providerRunMs <= 320, `providerRunMs=${s.providerRunMs}`);
  assert.ok(s.totalMs >= s.providerRunMs && s.preProviderMs >= 20 && s.postProcessMs >= 10, JSON.stringify(s));
});
test('L6. wiring: aiProviders.logAttempt ghi span; chat.js phát latency_breakdown + mốc queue/admit', () => {
  const fs = require('fs'); const path = require('path');
  const ai = fs.readFileSync(path.join(__dirname, '../server/utils/aiProviders.js'), 'utf8');
  const chat = fs.readFileSync(path.join(__dirname, '../server/routes/chat.js'), 'utf8');
  assert.ok(/latencyBreakdown\.recordProviderSpan\(requestId, latency\)/.test(ai));
  for (const needle of ["stage: 'latency_breakdown'", 'markQueueStart()', 'markAdmitted()', 'latencyBreakdown.begin(reqLogger.requestId)']) assert.ok(chat.includes(needle), needle);
});

(async () => {
  let p = 0, f = 0;
  for (const t of tests) { try { await t.f(); p++; console.log('  ok  -', t.n); } catch (e) { f++; console.log(' FAIL -', t.n, '\n       ', e.message); } }
  console.log(`\n${p} passed, ${f} failed`); process.exit(f ? 1 : 0);
})();
