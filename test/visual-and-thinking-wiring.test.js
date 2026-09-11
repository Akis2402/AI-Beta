'use strict';

// ============================================================================================
// REGRESSION — WIRING trong routes/chat.js (PHẦN 2/20/21/27/36)
// ============================================================================================
// Các bất biến dưới đây rất dễ bị phá khi sửa route về sau, và khi bị phá thì KHÔNG có test đơn vị
// nào bắt được (module con vẫn đúng, chỉ là route không dùng chúng). Vì vậy kiểm tra ở mức mã nguồn.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, error: e.message }); }
}

const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'chat.js'), 'utf8');
const codeSrc = chatSrc.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

// ---------- 1. reasoningBudget phải được truyền ở MỌI lượt gọi model ----------
test('1. chat.js truyền reasoningBudget ở cả 4 nhánh (stream/JSON × direct/cross-check)', () => {
  const count = (codeSrc.match(/reasoningBudget:/g) || []).length;
  assert.ok(count >= 8, `phải có >=8 điểm truyền reasoningBudget (initial + continuation × 4 nhánh), thấy ${count}`);
});

test('2. budgetPlanOf tính reasoningBudget TÁCH khỏi coreBudget', () => {
  assert.ok(codeSrc.includes('genericReasoningBudget'), 'phải dùng budget planner, không tự bịa công thức tại chỗ');
  assert.ok(/coreBudget,\s*reserveBudget,\s*totalBudget,\s*reasoningBudget/.test(codeSrc),
    'budgetPlanOf phải trả reasoningBudget như một field RIÊNG');
});

test('3. coreBudget vẫn là maxTokens của lượt đầu (không bị đổi ngữ nghĩa lén)', () => {
  const usages = (codeSrc.match(/maxTokens:\s*[\w.']*\(?[\w.']*\)?\.coreBudget/g) || []).length;
  assert.ok(usages >= 4, `phải còn >=4 lượt gọi initial dùng coreBudget, thấy ${usages}`);
});

test('4. lượt tiếp nối dùng phase recovery (reasoning giảm, answer bám deficit)', () => {
  assert.ok(codeSrc.includes("mode: 'CONTINUATION'") || codeSrc.includes('reasoningFor('),
    'continuation phải đi qua reasoningFor() để chuyển sang phase recovery');
});

// ---------- 2. Hệ thống hình: không được block/giết text ----------
test('5. visual pipeline CHỈ chạy sau khi text answer đã xong', () => {
  // Ở nhánh streaming, "done" (kèm visualPending) phải đi TRƯỚC lệnh gọi tạo hình — người dùng
  // đọc xong lời giải rồi hình mới tới, và hình không bao giờ giữ chân text.
  const pendingIdx = codeSrc.indexOf('visualPending: true');
  const visualIdx = codeSrc.indexOf('await runVisualsFor(');
  assert.ok(pendingIdx > 0, 'nhánh streaming phải gửi done kèm visualPending');
  assert.ok(visualIdx > 0, 'phải có lệnh gọi tạo hình');
  assert.ok(pendingIdx < visualIdx, 'PHẦN 20/21: "done" (text xong) phải được gửi TRƯỚC khi bắt đầu tạo hình');
});

test('6. mọi lượt gọi visual đều đi qua runVisualsFor (lớp bọc không-bao-giờ-throw)', () => {
  const direct = (codeSrc.match(/visualSystem\.runVisualPipeline\(/g) || []).length;
  assert.strictEqual(direct, 1, 'chỉ runVisualsFor() được gọi trực tiếp vào pipeline; route không gọi thẳng');
  const wrapped = (codeSrc.match(/runVisualsFor\(/g) || []).length;
  assert.ok(wrapped >= 5, `4 nhánh + 1 định nghĩa = >=5 lần xuất hiện, thấy ${wrapped}`);
});

test('7. hình KHÔNG BAO GIỜ được đưa vào luồng lỗi của text', () => {
  // Không được có bất kỳ đoạn nào biến visualStatus thành điều kiện FAILED / throw.
  assert.ok(!/visualStatus\s*===\s*'failed'\s*\)\s*\{[^}]*throw/.test(codeSrc));
  assert.ok(!/if\s*\(\s*!?visualRun[^)]*\)\s*\{[^}]*STATES\.FAILED/.test(codeSrc));
});

test('8. PHẦN 27: chế độ hình nằm trong cache key', () => {
  assert.ok(codeSrc.includes('visualMode: input.settings.visual'),
    'nếu thiếu, người chọn "Never" sẽ nhận lại response đã cache kèm hình');
});

test('8b. TẦNG 3 (model judge) ĐÃ được nối vào route — không còn là tham số chết', () => {
  assert.ok(codeSrc.includes('createVisualJudge('), 'chat.js phải dựng judge và truyền vào pipeline');
  assert.ok(/judge:\s*visualSystem\.judge\.createVisualJudge/.test(codeSrc),
    'judge phải nằm trong visualBase để cả 4 nhánh dùng chung');
  // Judge phải dùng model NHANH và KHÔNG bật deepThinking (đây là phân loại nhị phân).
  const judgeSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'utils', 'visual', 'visualJudge.js'), 'utf8');
  assert.ok(/fast:\s*true/.test(judgeSrc), 'judge phải dùng model nhanh');
  assert.ok(!/deepThinking:\s*true/.test(judgeSrc), 'judge KHÔNG được bật deep thinking');
});

// ---------- 3. Validator chấp nhận settings.visual ----------
test('9. validators chuẩn hoá settings.visual về auto|always|never', () => {
  const v = require('../server/utils/validators');
  assert.strictEqual(v.validateChatBody({ query: 'x', settings: { visual: 'never' } }).settings.visual, 'never');
  assert.strictEqual(v.validateChatBody({ query: 'x', settings: { visual: 'rác' } }).settings.visual, 'auto');
  assert.strictEqual(v.validateChatBody({ query: 'x' }).settings.visual, 'auto', 'client cũ không gửi field -> auto');
});

// ---------- 4. Frontend ----------
test('10. app.js xử lý sự kiện visual RIÊNG (không nhét vào text stream)', () => {
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.ok(appSrc.includes("currentEvent === 'visual:ready'"));
  assert.ok(appSrc.includes("currentEvent === 'visual:error'"));
  assert.ok(appSrc.includes('function renderVisuals('), 'phải có hàm render hình riêng');
  // Ảnh lỗi chỉ là ghi chú, không được throw như lỗi câu trả lời.
  const errIdx = appSrc.indexOf("currentEvent === 'visual:error'");
  const segment = appSrc.slice(errIdx, errIdx + 260);
  assert.ok(!/errorMsg\s*=/.test(segment), 'visual:error KHÔNG được set errorMsg (sẽ ném lỗi, xoá cả câu trả lời)');
});

test('11. index.html có đủ 3 lựa chọn cài đặt hình minh họa', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('id="visualChips"'));
  ['data-val="auto"', 'data-val="always"', 'data-val="never"'].forEach((v) => assert.ok(html.includes(v), v));
});

test('12. renderVisuals chặn SVG đáng ngờ ở tầng client (phòng thủ nhiều lớp)', () => {
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const idx = appSrc.indexOf('function renderVisuals(');
  const body = appSrc.slice(idx, idx + 2000);
  assert.ok(/<script\|javascript:/.test(body) || body.includes('foreignObject'),
    'client phải kiểm tra lại nội dung SVG trước khi nhúng, không tin tuyệt đối payload mạng');
});

let passed = 0, failed = 0;
console.log('\n== Wiring: reasoning budget + hệ thống hình trong route/frontend ==');
results.forEach((r) => {
  if (r.pass) { passed++; console.log('  ok  - ' + r.name); }
  else { failed++; console.log(' FAIL - ' + r.name + '\n        ' + r.error); }
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
