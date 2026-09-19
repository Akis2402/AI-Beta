'use strict';

// ---------- REGRESSION: maxTokens của request THẬT phải lấy từ Token Economy (mục PHẦN 3/18.2) ----------
// TRƯỚC ĐÂY route handler (server/routes/chat.js) tính tePlan (coreBudget/reserveBudget) NHƯNG chỉ
// dùng để log/telemetry — request thật vẫn gọi budgetOf(stage).target riêng (dead calculation).
// Vì gọi thật cần network/API key, ta xác minh bằng static-analysis: chat.js không còn dùng
// `budgetOf(...).target` làm maxTokens cho BẤT KỲ lượt gọi model nào (initial hay continuation),
// và allocateCoreReserve() được wire vào budgetPlanOf() dùng để tính maxTokens thực tế.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const te = require('../server/utils/tokenEconomy');

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, error: e.message }); }
}

const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'chat.js'), 'utf8');

test('chat.js never uses budgetOf(...).target directly as maxTokens anymore', () => {
  // Chỉ xét các dòng CODE thật (bỏ dòng comment '//') — comment vẫn được phép nhắc lại pattern cũ
  // để giải thích lý do sửa (xem các dòng "FIX PHẦN 3/6: ... không xin lại budgetOf(stage).target").
  const codeLines = chatSrc.split('\n').filter((l) => !l.trim().startsWith('//'));
  const codeSrc = codeLines.join('\n');
  assert.ok(!/maxTokens:\s*\w+\.target/.test(codeSrc), 'không được gán thẳng .target cho maxTokens');
  assert.ok(!/maxTokens:\s*budgetOf\([^)]*\)\.target/.test(codeSrc), 'không được gọi budgetOf(stage).target trực tiếp làm maxTokens nữa');
});

test('chat.js wires allocateCoreReserve into budgetPlanOf (Token Economy = source of truth)', () => {
  assert.ok(chatSrc.includes('tokenEconomy.allocateCoreReserve'), 'budgetPlanOf phải gọi allocateCoreReserve của tokenEconomy.js');
  assert.ok(chatSrc.includes('budgetPlanOf'), 'phải có budgetPlanOf thay cho budgetOf thô');
});

test('chat.js initial model calls use coreBudget, not totalBudget', () => {
  const coreBudgetUsages = (chatSrc.match(/maxTokens:\s*[\w.']*\(?[\w.']*\)?\.coreBudget/g) || []).length;
  assert.ok(coreBudgetUsages >= 4, `phải có ít nhất 4 lượt gọi initial dùng coreBudget (thấy ${coreBudgetUsages})`);
});

test('chat.js continuation calls draw from reserve via shouldUseReserve, never full target recompute', () => {
  assert.ok(chatSrc.includes('tokenEconomy.shouldUseReserve'), 'continuation phải gọi shouldUseReserve() để lấy budget theo lô nhỏ');
  const reserveUsagesCount = (chatSrc.match(/shouldUseReserve\(/g) || []).length;
  assert.ok(reserveUsagesCount >= 4, `phải có ít nhất 4 điểm continuation dùng shouldUseReserve (thấy ${reserveUsagesCount})`);
});

// ---------- Đơn vị: allocateCoreReserve tự nó vẫn đúng 70/30 + core<=effectiveTarget<=hardCap ----------
test('allocateCoreReserve: coreBudget <= effectiveTarget <= totalBudget (hardCap tôn trọng)', () => {
  const target = 4000;
  const { coreBudget, reserveBudget, totalBudget } = te.allocateCoreReserve(target);
  assert.ok(coreBudget <= target);
  assert.ok(coreBudget + reserveBudget === totalBudget);
  assert.ok(totalBudget <= target + 1); // allocateCoreReserve không vượt target gốc
});

// ---------- Reserve không được tiêu hết 1 lần — mỗi lần continuation chỉ lấy 1 phần (mục PHẦN 6) ----------
test('shouldUseReserve never grants full reserve in a single continuation call', () => {
  const reserveBudget = 1000;
  const decision = te.shouldUseReserve({ status: 'INCOMPLETE' }, 0, reserveBudget);
  assert.ok(decision.allow);
  assert.ok(decision.amount < reserveBudget, 'không được cấp toàn bộ reserve trong 1 lượt continuation duy nhất');
});

let passed = 0, failed = 0;
console.log('\n== Regression: Token Economy là source of truth cho maxTokens thực tế (mục PHẦN 3) ==');
for (const r of results) {
  if (r.pass) { passed++; console.log('  ok  - ' + r.name); }
  else { failed++; console.log('  FAIL - ' + r.name + ' :: ' + r.error); }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
