'use strict';

// ---------- REGRESSION: recommendation KHÔNG còn tự động chạy trên mọi query (mục PHẦN 9/18.6) ----------
// TRƯỚC ĐÂY: `if (query) scheduleRecommend(query);` được gọi VÔ ĐIỀU KIỆN ở đầu sendMessage() cho
// MỌI câu hỏi -> tốn 1 lượt gọi AI+web search thêm cho gần như mọi query giải bài bình thường.
// Static-analysis test (cùng phong cách security-xss.test.js) khẳng định:
//   1. sendMessage() không còn gọi scheduleRecommend(...) một cách vô điều kiện.
//   2. Nhánh examOnly (ý định rõ ràng xin đề/tài liệu ôn tập) VẪN gọi scheduleRecommend(...).
//   3. openRecommendPanel() (người dùng chủ động bấm mở khung) gọi scheduleRecommend(...) khi có
//      câu hỏi gần nhất chưa fetch — đúng tinh thần "user bấm tính năng recommendation".

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ok  - ' + msg); }
  else { failed++; console.log('  FAIL - ' + msg); }
}

const appJsPath = path.join(__dirname, '..', 'public', 'js', 'app.js');
const src = fs.readFileSync(appJsPath, 'utf8');

console.log('\n== Regression PHẦN 9: recommendation không tự chạy trên mọi query (public/js/app.js) ==');

// 1. Trích thân hàm sendMessage() để kiểm tra không còn lời gọi vô điều kiện.
const sendMsgMatch = src.match(/async function sendMessage\(\)\s*\{[\s\S]*?\n\}\n/);
ok(!!sendMsgMatch, 'trích được thân hàm sendMessage()');
if (sendMsgMatch) {
  const body = sendMsgMatch[0];
  // Chỉ được PHÉP gán vào biến theo dõi (lastQueryForRecommend), KHÔNG được gọi scheduleRecommend()
  // trực tiếp ở phần đầu hàm (ngoài nhánh examOnly).
  const topLevelCall = /if\s*\(query\)\s*scheduleRecommend\(query\)\s*;/.test(body);
  ok(!topLevelCall, 'sendMessage() không còn gọi scheduleRecommend(query) vô điều kiện ở đầu hàm');
  ok(body.includes('lastQueryForRecommend = query'), 'sendMessage() vẫn lưu lại câu hỏi gần nhất (không gọi AI) để dùng khi có yêu cầu rõ ràng sau này');
}

// 2. Nhánh examOnly (ý định rõ ràng) vẫn gọi scheduleRecommend().
const examOnlyMatch = src.match(/if\s*\(examOnly\)\s*\{[\s\S]*?\n {2}\}\n/);
ok(!!examOnlyMatch, 'trích được nhánh examOnly');
if (examOnlyMatch) {
  ok(examOnlyMatch[0].includes('scheduleRecommend(query)'), 'nhánh examOnly (explicit recommend intent) vẫn gọi scheduleRecommend(query)');
}

// 3. openRecommendPanel() (hành động bấm nút của người dùng) chủ động fetch khi cần.
const openPanelMatch = src.match(/function openRecommendPanel\(\)\s*\{[\s\S]*?\n\}\n/);
ok(!!openPanelMatch, 'trích được hàm openRecommendPanel()');
if (openPanelMatch) {
  ok(openPanelMatch[0].includes('scheduleRecommend(lastQueryForRecommend)'), 'openRecommendPanel() (bấm nút chủ động) gọi scheduleRecommend() khi có câu hỏi chưa fetch');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
