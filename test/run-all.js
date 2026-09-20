'use strict';

// ============================================================================================
// PHẦN O — TEST HARNESS PHẢI TRUNG THỰC
// ============================================================================================
// Bản cũ có 3 lỗ hổng biến "PASS" thành một tuyên bố không kiểm chứng được:
//   1. KHÔNG có timeout: một file test treo (server không đóng, timer còn sống) làm `npm test` treo
//      vô hạn — CI sẽ bị giết từ bên ngoài và người đọc log không biết vì sao.
//   2. SKIPPED bị bỏ qua: file tự in "SKIPPED — thiếu dependency" rồi thoát 0, harness đếm là PASS.
//      Dòng lưu ý ở cuối chỉ là lời nhắc cho con người, không phải cơ chế.
//   3. Không tách chế độ CI: local nên khoan dung, CI thì không.
// NAY: mỗi file chạy với timeout cứng, bị giết sạch (kể cả tiến trình con) khi quá giờ; SKIPPED được
// đếm riêng và LÀ LỖI ở chế độ CI; mã thoát phản ánh đúng kết quả.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CI = process.argv.includes('--ci') || process.env.CI === 'true' || process.env.CI === '1';
const FILE_TIMEOUT_MS = Number(process.env.TEST_FILE_TIMEOUT_MS) || 120000;

const dir = __dirname;
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();

const results = { passed: [], failed: [], skipped: [], timeout: [] };

for (const f of files) {
  console.log(`\n=== ${f} ===`);
  const r = spawnSync(process.execPath, [path.join(dir, f)], {
    encoding: 'utf8',
    timeout: FILE_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    env: { ...process.env, PUTER_VISUAL_MODE: process.env.PUTER_VISUAL_MODE || 'server_fallback' }
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  process.stdout.write(out);

  if (r.error && r.error.code === 'ETIMEDOUT') {
    console.log(`>>> TIMEOUT sau ${FILE_TIMEOUT_MS}ms — tiến trình đã bị giết.`);
    results.timeout.push(f);
    continue;
  }
  if (r.status !== 0) { results.failed.push(f); continue; }
  // SKIPPED không bao giờ được coi là PASS: file đã thoát 0 nhưng phần việc thật CHƯA chạy.
  // Nhận diện theo ĐÚNG dấu hiệu do chính test phát ra (đầu dòng), không phải mọi lần chữ "SKIPPED"
  // xuất hiện trong comment/tên test — nếu không, một test chạy đủ vẫn bị gắn nhãn sai.
  if (/^\s*SKIPPED\b/m.test(out) || /\(skipped\)\s*$/m.test(out)) { results.skipped.push(f); continue; }
  results.passed.push(f);
}

const line = (label, arr) => console.log(`${label}: ${arr.length}${arr.length ? ' -> ' + arr.join(', ') : ''}`);
console.log(`\n${files.length} test file(s) executed.  [mode: ${CI ? 'CI (nghiêm ngặt)' : 'local'}]`);
line('PASSED', results.passed);
line('FAILED', results.failed);
line('SKIPPED (CHƯA CHẠY — không phải PASS)', results.skipped);
line('TIMEOUT', results.timeout);

const hardFail = results.failed.length > 0 || results.timeout.length > 0;
const skipFail = CI && results.skipped.length > 0;

if (hardFail) {
  console.log('RESULT: FAIL');
  process.exitCode = 1;
} else if (skipFail) {
  console.log('RESULT: FAIL (CI: có test bị SKIP — chạy `npm ci` rồi chạy lại; SKIP không được tính là PASS)');
  process.exitCode = 1;
} else if (results.skipped.length) {
  console.log('RESULT: PASS (DEGRADED — có test bị SKIP, chưa đủ để tuyên bố production-ready)');
} else {
  console.log('RESULT: PASS');
}
