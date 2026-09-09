'use strict';

// Chạy TOÀN BỘ file *.test.js trong thư mục này bằng cách spawn từng file như 1 tiến trình Node
// riêng (giữ đúng thói quen "node test/x.test.js" hiện có của mỗi file, không cần đổi framework),
// rồi gộp mã thoát — "npm test" trả về khác 0 nếu BẤT KỲ file nào fail (mục XVI).

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();

let anyFailed = false;
for (const f of files) {
  console.log(`\n=== ${f} ===`);
  const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit' });
  if (r.status !== 0) anyFailed = true;
}

console.log(`\n${files.length} test file(s) executed.`);
if (anyFailed) {
  console.log('RESULT: FAIL');
  process.exitCode = 1;
} else {
  console.log('RESULT: PASS');
}
