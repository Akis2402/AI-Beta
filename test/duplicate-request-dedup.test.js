'use strict';

// V6.21.52 (lượt 6): chặn double-submit THẬT (double-click Send / client tự động retry cùng
// clientRequestId) không được tạo 2 lệnh gọi AI. Test cả (a) hành vi trạng thái thật của
// aiJobStore.js mà logic chặn trong chat.js dựa vào, và (b) chat.js có đặt guard ĐÚNG VỊ TRÍ
// (trước createJob, không throw — vì đoạn đó chạy trước try{} chính của handler).
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const aiJobStore = require('../server/utils/aiJobStore');

const results = [];
function test(name, fn) { results.push({ name, fn }); }

test('aiJobStore: job vừa tạo có status RUNNING — request thứ 2 cùng requestId PHẢI bị chặn', async () => {
  aiJobStore.__resetForTest();
  const job = aiJobStore.createJob({ requestId: 'dup-test-1', query: 'q' });
  assert.strictEqual(job.status, aiJobStore.STATUS.RUNNING);
  const existing = await aiJobStore.getJob('dup-test-1');
  assert.strictEqual(existing.status, aiJobStore.STATUS.RUNNING, 'logic chặn trong chat.js phải thấy đúng RUNNING để từ chối request thứ 2');
});

test('aiJobStore: sau finishJob(COMPLETED), request cùng requestId KHÔNG bị chặn nữa', async () => {
  aiJobStore.__resetForTest();
  const job = aiJobStore.createJob({ requestId: 'dup-test-2', query: 'q' });
  aiJobStore.finishJob(job, { status: aiJobStore.STATUS.COMPLETED, result: { text: 'ok' } });
  const existing = await aiJobStore.getJob('dup-test-2');
  assert.strictEqual(existing.status, aiJobStore.STATUS.COMPLETED, 'job COMPLETED không được coi là đang chạy — request mới (hoặc resume) phải được phép tiếp tục');
});

test('aiJobStore: sau markDisconnected (client rời đi), request cùng requestId KHÔNG bị chặn nữa', async () => {
  aiJobStore.__resetForTest();
  const job = aiJobStore.createJob({ requestId: 'dup-test-3', query: 'q' });
  aiJobStore.markDisconnected(job);
  const existing = await aiJobStore.getJob('dup-test-3');
  assert.strictEqual(existing.status, aiJobStore.STATUS.CANCELLED);
});

test('wiring: chat.js check aiJobStore.getJob() TRƯỚC createJob(), không throw (early-return res.status(409))', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'chat.js'), 'utf8');
  const dupIdx = src.indexOf('const existingJob = await aiJobStore.getJob(clientRequestId);');
  const createIdx = src.indexOf('res.__aiJob = aiJobStore.createJob({');
  assert.ok(dupIdx !== -1, 'phải có bước check existingJob');
  assert.ok(createIdx !== -1, 'phải còn createJob (không regress)');
  assert.ok(dupIdx < createIdx, 'check duplicate PHẢI đứng trước createJob (chặn trước khi tạo job mới)');
  assert.ok(/res\.status\(409\)\.json\(/.test(src), 'phải trả 409 trực tiếp (không throw — đoạn này chạy trước try{} chính)');
  assert.ok(/isRunning\s*&&\s*!isAbandoned/.test(src), 'phải có guard chống job bị bỏ rơi (server crash) chặn vĩnh viễn');
});

(async () => {
  let passed = 0, failed = 0;
  console.log('\n== Regression: DUPLICATE REQUEST DEDUP (V6.21.52, lượt 6) ==');
  for (const { name, fn } of results) {
    try { await fn(); passed++; console.log('  ok  - ' + name); }
    catch (e) { failed++; console.log('  FAIL - ' + name + ' :: ' + (e && e.message)); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
