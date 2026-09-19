'use strict';

// ============================================================================================
// AUDIT MỤC 5 + 6 — HISTORICAL BUDGET AN TOÀN + ADMISSION CONTROLLER THẬT
// ============================================================================================
// (a) MỤC 5: recordOutcome() ưu tiên usage THẬT, outlier rejection, maximum adjustment/rollback,
//     tách theo (problemClass, stage, provider, model), min sample count trước khi override.
// (b) MỤC 6: aiCallBudget.admit() là GATE THẬT (ALLOW/DEGRADED/DENY theo ma trận stage×purpose),
//     không chỉ ghi telemetry sau khi đã gọi — và chat.js thực sự gọi gate này trước reconcile.
// Chạy: node test/audit-budget-admission.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); passed += 1; }
  catch (e) { console.log(` FAIL - ${name}\n        ${e.message}`); failed += 1; }
}

const root = path.join(__dirname, '..');
const te = require(path.join(root, 'server', 'utils', 'tokenEconomy.js'));
const ac = require(path.join(root, 'server', 'utils', 'aiCallBudget.js'));
const chatSrc = fs.readFileSync(path.join(root, 'server', 'routes', 'chat.js'), 'utf8');

console.log('\n== (a) MỤC 5: historical adaptive budget an toàn ==');

test('H1. usage THẬT được ưu tiên, không phải char/3.2', () => {
  te.__resetBudgetHistoryForTest();
  const r = te.recordOutcome('algebra', 'detail', 99999 /* fallback rất khác */, { actualTokens: 480, provider: 'gemini', model: 'g1' });
  assert.strictEqual(r.estimated, false);
  const stat = te.getBudgetHistoryStat('algebra', 'detail', 'gemini', 'g1');
  assert.strictEqual(stat.avg, 480, 'phải dùng đúng usage thật, không lẫn số ước lượng');
});

test('H2. không có usage thật -> dùng estimator VÀ ghi estimated=true', () => {
  te.__resetBudgetHistoryForTest();
  const r = te.recordOutcome('algebra', 'detail', 700, {});
  assert.strictEqual(r.estimated, true);
  const stat = te.getBudgetHistoryStat('algebra', 'detail', null, null);
  assert.strictEqual(stat.avg, 700);
  assert.strictEqual(stat.estimatedSamples, 1);
  assert.strictEqual(stat.actualSamples, 0);
});

test('H3. min sample count: chưa đủ mẫu -> suggestBudgetOverride() trả null', () => {
  te.__resetBudgetHistoryForTest();
  te.recordOutcome('geo', 'detail', 1000, {});
  te.recordOutcome('geo', 'detail', 1000, {});
  assert.strictEqual(te.suggestBudgetOverride('geo', 'detail', 1500), null, '2 mẫu chưa đủ (cần 3)');
  te.recordOutcome('geo', 'detail', 1000, {});
  assert.notStrictEqual(te.suggestBudgetOverride('geo', 'detail', 1500), null, '3 mẫu phải đủ');
});

test('H4. outlier rejection: mẫu lệch quá xa KHÔNG được cập nhật avg', () => {
  te.__resetBudgetHistoryForTest();
  for (let i = 0; i < 5; i++) te.recordOutcome('trig', 'detail', 1000, {});
  const before = te.getBudgetHistoryStat('trig', 'detail', null, null);
  const r = te.recordOutcome('trig', 'detail', 50000, {}); // 50x avg
  assert.strictEqual(r.accepted, false);
  assert.strictEqual(r.rejectedReason, 'outlier');
  const after = te.getBudgetHistoryStat('trig', 'detail', null, null);
  assert.strictEqual(after.avg, before.avg, 'avg không được đổi khi mẫu bị coi là outlier');
  assert.strictEqual(after.samples, before.samples, 'samples không tăng khi bị từ chối');
  assert.strictEqual(after.rejected, 1, 'phải log lại số lần bị từ chối để soi được');
});

test('H5. maximum adjustment: 1 bước không được kéo avg đi quá xa dù đã qua outlier filter', () => {
  te.__resetBudgetHistoryForTest();
  for (let i = 0; i < 4; i++) te.recordOutcome('calc', 'detail', 1000, {});
  const before = te.getBudgetHistoryStat('calc', 'detail', null, null).avg;
  // 2.5x avg — dưới ngưỡng outlier (3x) nên được CHẤP NHẬN, nhưng vẫn phải bị ghìm bởi max-adjust.
  te.recordOutcome('calc', 'detail', before * 2.5, {});
  const after = te.getBudgetHistoryStat('calc', 'detail', null, null).avg;
  assert.ok(after <= before * 1.35 + 1, `avg nhảy quá xa trong 1 bước: ${before} -> ${after}`);
});

test('H6. 1 request bất thường KHÔNG được làm hỏng budget của hàng loạt request sau', () => {
  te.__resetBudgetHistoryForTest();
  for (let i = 0; i < 10; i++) te.recordOutcome('fx', 'detail', 1000, {});
  te.recordOutcome('fx', 'detail', 9000000, {}); // 1 request cực đoan
  const stat = te.getBudgetHistoryStat('fx', 'detail', null, null);
  assert.ok(stat.avg < 3000, `1 outlier vẫn kéo avg lên ${stat.avg} — phải bị chặn`);
});

test('H7. tách riêng theo provider/model: gemini và openai không lẫn lịch sử', () => {
  te.__resetBudgetHistoryForTest();
  te.recordOutcome('algebra', 'detail', 1000, { actualTokens: 500, provider: 'gemini', model: 'g1' });
  te.recordOutcome('algebra', 'detail', 1000, { actualTokens: 5000, provider: 'openai', model: 'o1' });
  assert.strictEqual(te.getBudgetHistoryStat('algebra', 'detail', 'gemini', 'g1').avg, 500);
  assert.strictEqual(te.getBudgetHistoryStat('algebra', 'detail', 'openai', 'o1').avg, 5000);
});

test('H8. chat.js truyền usage thật (requestUsage.outputTokens) vào recordOutcome, có guard requestUsage.calls>0', () => {
  const calls = (chatSrc.match(/tokenEconomy\.recordOutcome\([^;]*actualTokens: requestUsage\.calls > 0 \? requestUsage\.outputTokens : null/gs) || []).length;
  assert.strictEqual(calls, 4, `phải có đủ 4 điểm gọi recordOutcome truyền usage thật (đếm được ${calls})`);
});

console.log('\n== (b) MỤC 6: admission controller THẬT (ALLOW/DENY/DEGRADED) ==');

test('AC1. approach: answer=ALLOW, image_generation=ALLOW (nơi duy nhất tự generate visual)', () => {
  const b = ac.createCallBudget({ intent: 'PLAIN_TEXT' });
  assert.strictEqual(b.admit(ac.PURPOSE.ANSWER, 'approach').decision, ac.DECISION.ALLOW);
  assert.strictEqual(b.admit(ac.PURPOSE.IMAGE_GENERATION, 'approach').decision, ac.DECISION.ALLOW);
});

test('AC2. approach: reconcile/judge/rerank/summarize/cross_check = DENY cứng', () => {
  const b = ac.createCallBudget({ intent: 'PLAIN_TEXT' });
  [ac.PURPOSE.RECONCILE, ac.PURPOSE.JUDGE, ac.PURPOSE.RERANK, ac.PURPOSE.SUMMARIZE, ac.PURPOSE.CROSS_CHECK].forEach((p) => {
    const d = b.admit(p, 'approach');
    assert.strictEqual(d.decision, ac.DECISION.DENY, `${p} phải bị DENY ở stage approach`);
  });
});

test('AC3. approach: continuation "tightly limited" — chỉ 1 lần, lần 2 bị DENY', () => {
  const b = ac.createCallBudget({ intent: 'PLAIN_TEXT' });
  const first = b.admit(ac.PURPOSE.CONTINUATION, 'approach');
  assert.strictEqual(first.decision, ac.DECISION.ALLOW);
  b.record(ac.PURPOSE.CONTINUATION, { stage: 'approach', reason: 'truncated' });
  const second = b.admit(ac.PURPOSE.CONTINUATION, 'approach');
  assert.strictEqual(second.decision, ac.DECISION.DENY);
  assert.ok(/continuation_limit_reached/.test(second.reason));
});

test('AC4. detail: image = FORBIDDEN cứng (mục 23/26)', () => {
  const b = ac.createCallBudget({ intent: 'PLAIN_TEXT' });
  const d = b.admit(ac.PURPOSE.IMAGE_GENERATION, 'detail');
  assert.strictEqual(d.decision, ac.DECISION.DENY);
  assert.ok(/forbidden/.test(d.reason));
});

test('AC5. detail: continuation/reconcile/judge = conditional — thiếu reason -> DEGRADED, có reason -> ALLOW', () => {
  const b = ac.createCallBudget({ intent: 'PLAIN_TEXT' });
  [ac.PURPOSE.CONTINUATION, ac.PURPOSE.RECONCILE, ac.PURPOSE.JUDGE].forEach((p) => {
    assert.strictEqual(b.admit(p, 'detail').decision, ac.DECISION.DEGRADED, `${p} thiếu reason phải DEGRADED`);
    assert.strictEqual(b.admit(p, 'detail', { reason: 'vì lý do X' }).decision, ac.DECISION.ALLOW, `${p} có reason phải ALLOW`);
  });
});

test('AC6. image stage: image_generation=ALLOW, answer/reconcile=FORBIDDEN', () => {
  const b = ac.createCallBudget({ intent: 'IMAGE_ONLY' });
  assert.strictEqual(b.admit(ac.PURPOSE.IMAGE_GENERATION, 'image').decision, ac.DECISION.ALLOW);
  assert.strictEqual(b.admit(ac.PURPOSE.ANSWER, 'image').decision, ac.DECISION.DENY);
});

test('AC7. purpose không có trong ma trận của stage đó -> DENY an toàn (không mặc định ALLOW)', () => {
  const b = ac.createCallBudget({ intent: 'PLAIN_TEXT' });
  const d = b.admit(ac.PURPOSE.CROSS_CHECK, 'approach');
  assert.strictEqual(d.decision, ac.DECISION.DENY);
});

test('AC8. high risk không kèm lý do -> DEGRADED dù purpose vốn "allowed"', () => {
  const b = ac.createCallBudget({ intent: 'PLAIN_TEXT' });
  const d = b.admit(ac.PURPOSE.ANSWER, 'detail', { risk: 'high' });
  assert.strictEqual(d.decision, ac.DECISION.DEGRADED);
  const ok = b.admit(ac.PURPOSE.ANSWER, 'detail', { risk: 'high', reason: 'đã giải thích' });
  assert.strictEqual(ok.decision, ac.DECISION.ALLOW);
});

test('AC9. vượt trần tổng số lệnh gọi (maxCalls) -> DENY', () => {
  const b = ac.createCallBudget({ intent: 'PLAIN_TEXT', maxCalls: 2 });
  b.record(ac.PURPOSE.ANSWER, { stage: 'detail' });
  b.record(ac.PURPOSE.ANSWER, { stage: 'detail' });
  const d = b.admit(ac.PURPOSE.ANSWER, 'detail');
  assert.strictEqual(d.decision, ac.DECISION.DENY);
  assert.ok(/call_budget_exhausted/.test(d.reason));
});

test('AC10. requestCall() = admit()+record() gộp — 1 điểm gọi cho caller mới', () => {
  const b = ac.createCallBudget({ intent: 'PLAIN_TEXT' });
  const r1 = b.requestCall(ac.PURPOSE.ANSWER, 'detail');
  assert.strictEqual(r1.decision, ac.DECISION.ALLOW);
  assert.strictEqual(b.count, 1, 'requestCall() phải tự record() khi ALLOW');
  const r2 = b.requestCall(ac.PURPOSE.IMAGE_GENERATION, 'detail');
  assert.strictEqual(r2.decision, ac.DECISION.DENY);
  assert.strictEqual(b.count, 1, 'DENY thì KHÔNG được record — lệnh gọi không xảy ra');
});

test('AC11. snapshot() vẫn tương thích ngược (không vỡ chat.js/telemetry cũ)', () => {
  const b = ac.createCallBudget({ intent: 'PLAIN_TEXT' });
  b.record(ac.PURPOSE.ANSWER, { stage: 'detail' });
  const snap = b.snapshot();
  ['aiCallIntent', 'aiCallBaseline', 'aiCallCount', 'aiCallsByPurpose', 'aiCallsOverBaseline', 'aiCallsUnjustified', 'aiCallPurposes'].forEach((k) => {
    assert.ok(Object.prototype.hasOwnProperty.call(snap, k), `mất field cũ "${k}"`);
  });
});

test('AC12. chat.js THỰC SỰ gọi admit() trước reconcile và return khi DENY (không phải chỉ record() rồi bỏ qua)', () => {
  assert.ok(/aiCallBudget\.admit\(aiBudget\.PURPOSE\.RECONCILE, 'detail'/.test(chatSrc), 'thiếu lệnh gọi admit() trước reconcile');
  const idx = chatSrc.indexOf("aiCallBudget.admit(aiBudget.PURPOSE.RECONCILE, 'detail'");
  const after = chatSrc.slice(idx, idx + 700);
  assert.ok(/decision === aiBudget\.DECISION\.DENY/.test(after), 'phải kiểm tra quyết định DENY');
  assert.ok(/return res\.end\(\)/.test(after), 'DENY phải thực sự dừng request, không âm thầm tiếp tục');
});

test('AC13. purpose CAPTION giữ tương thích: caption có reason tường minh vẫn ALLOW (không phá luồng ảnh hiện có)', () => {
  const b = ac.createCallBudget({ intent: 'IMAGE_ONLY' });
  const d = b.admit(ac.PURPOSE.CAPTION, 'approach', { reason: 'IMAGE_CAPTION_MODEL=1' });
  assert.strictEqual(d.decision, ac.DECISION.ALLOW);
});

console.log(`\n== KẾT QUẢ: ${passed} ok, ${failed} fail ==`);
if (failed > 0) process.exit(1);
