'use strict';

// Test thuần Node (giống test/rotation.test.js) cho mục 14 — Đa môn học.
// Chạy: node test/subject-detection.test.js

const assert = require('assert');
const { detectSubject, detectSubjects, resolveSubject, buildSubjectDirective, getSubject, ALLOWED_SUBJECT_IDS } = require('../server/utils/subjects');
const { validateChatBody } = require('../server/utils/validators');
const { buildChatSystemPrompt, PROMPT_VERSION } = require('../server/utils/promptBuilder');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  -', name); }
  catch (e) { failed++; console.log(' FAIL -', name, '\n       ', e.message); }
}

// ---------- 14.20.1-9: mỗi môn tự nhận diện đúng từ ví dụ trong yêu cầu ----------
test('1. Toán: "Giải phương trình x^2 - 5x + 6 = 0" -> math', () => {
  assert.strictEqual(detectSubject('Giải phương trình x^2 - 5x + 6 = 0').id, 'math');
});
test('2. Vật lý: khối lượng/gia tốc -> physics', () => {
  assert.strictEqual(detectSubject('Một vật có khối lượng 2kg chuyển động với gia tốc 3m/s2').id, 'physics');
});
test('3. Hóa học: HCl/NaOH -> chemistry', () => {
  assert.strictEqual(detectSubject('Cho dung dịch HCl 0.1M phản ứng với NaOH').id, 'chemistry');
});
test('4. Sinh học: "Ty thể có chức năng gì?" -> biology', () => {
  assert.strictEqual(detectSubject('Ty thể có chức năng gì?').id, 'biology');
});
test('5. Ngữ văn: "Phân tích hình tượng nhân vật..." -> literature', () => {
  assert.strictEqual(detectSubject('Phân tích hình tượng nhân vật trong bài thơ').id, 'literature');
});
test('6. Tiếng Anh: "Choose the correct answer..." -> english', () => {
  assert.strictEqual(detectSubject('Choose the correct answer for this grammar question').id, 'english');
});
test('7. Lịch sử: "Chiến thắng Điện Biên Phủ diễn ra năm nào?" -> history', () => {
  assert.strictEqual(detectSubject('Chiến thắng Điện Biên Phủ diễn ra năm nào? Nguyên nhân và ý nghĩa').id, 'history');
});
test('8. Địa lý: "Đồng bằng sông Hồng có đặc điểm..." -> geography', () => {
  assert.strictEqual(detectSubject('Đồng bằng sông Hồng có đặc điểm khí hậu và mật độ dân số ra sao').id, 'geography');
});
test('9. Tin học: "Hãy viết một chương trình Python..." -> computer-science', () => {
  assert.strictEqual(detectSubject('Hãy viết một chương trình Python thuật toán sắp xếp').id, 'computer-science');
});
test('10. Câu hỏi không xác định môn -> general, confidence 0', () => {
  const r = detectSubject('con mèo của tôi rất dễ thương hôm nay trời đẹp');
  assert.strictEqual(r.id, 'general');
  assert.strictEqual(r.confidence, 0);
});
test('10b. Chuỗi rỗng/không có nội dung -> general, confidence 0 (không đoán bừa — 14.9)', () => {
  const r = detectSubject('');
  assert.strictEqual(r.id, 'general');
  assert.strictEqual(r.confidence, 0);
});

// ---------- 14.7: câu hỏi liên quan nhiều môn — vẫn phải ra 1 kết quả ổn định, không throw ----------
test('11. Câu hỏi nhiều môn (Địa lý + Toán) -> vẫn trả về đúng 1 subject id hợp lệ, không crash', () => {
  const r = detectSubject('Phân tích số liệu dân số đồng bằng và tính tốc độ tăng trưởng');
  assert.ok(ALLOWED_SUBJECT_IDS.includes(r.id));
});
test('11b. detectSubjects() phát hiện ĐÚNG cả 2 môn khi cả 2 bộ từ khóa đều khớp rõ ràng', () => {
  const r = detectSubjects('Phân tích số liệu dân số và tính tốc độ tăng trưởng.');
  assert.ok(['math', 'geography'].includes(r.primary.id));
  assert.ok(r.secondary && ['math', 'geography'].includes(r.secondary.id));
  assert.notStrictEqual(r.primary.id, r.secondary.id);
});
test('11c. detectSubjects() KHÔNG gán môn phụ khi chỉ có 1 môn khớp rõ ràng (tránh gán bừa — 14.9)', () => {
  const r = detectSubjects('Giải phương trình x^2 - 5x + 6 = 0');
  assert.strictEqual(r.primary.id, 'math');
  assert.strictEqual(r.secondary, null);
});
test('11d. resolveSubject() ở chế độ auto trả kèm secondarySubjectId khi có', () => {
  const r = resolveSubject({ manualSubjectId: 'auto', problemText: 'Phân tích số liệu dân số và tính tốc độ tăng trưởng.', hasImage: false });
  assert.ok(r.secondarySubjectId);
  assert.ok(r.secondarySubjectConfidence > 0);
});
test('11e. resolveSubject() ở chế độ MANUAL không bao giờ gán secondary (tôn trọng lựa chọn tường minh)', () => {
  const r = resolveSubject({ manualSubjectId: 'geography', problemText: 'Phân tích số liệu dân số và tính tốc độ tăng trưởng.', hasImage: false });
  assert.strictEqual(r.subjectId, 'geography');
  assert.strictEqual(r.secondarySubjectId, null);
});
test('11f. buildSubjectDirective(primary, secondary) chèn khối reasoning kết hợp khi có secondary', () => {
  const block = buildSubjectDirective('geography', 'math');
  assert.ok(block.includes('LIÊN QUAN CẢ MÔN PHỤ'));
  assert.ok(block.includes('📐 Toán học'));
});
test('11g. buildSubjectDirective(primary) KHÔNG chèn khối reasoning kết hợp khi không có secondary', () => {
  const block = buildSubjectDirective('geography', null);
  assert.ok(!block.includes('LIÊN QUAN CẢ MÔN PHỤ'));
});

// ---------- 14.3: manual override luôn thắng auto ----------
test('12. Chọn thủ công "physics" cho text rõ ràng là Hóa -> vẫn dùng physics (ưu tiên tuyệt đối)', () => {
  const r = resolveSubject({ manualSubjectId: 'physics', problemText: 'Cho dung dịch HCl phản ứng NaOH', hasImage: false });
  assert.strictEqual(r.subjectId, 'physics');
  assert.strictEqual(r.subjectSource, 'manual');
  assert.strictEqual(r.subjectConfidence, 1);
});
test('12b. subjectId lạ/không hợp lệ từ client cũ -> fallback về auto-detect, không throw', () => {
  const r = resolveSubject({ manualSubjectId: 'khong-ton-tai', problemText: 'Giải phương trình bậc 2', hasImage: false });
  assert.strictEqual(r.subjectId, 'math');
  assert.strictEqual(r.subjectSource, 'auto');
});

// ---------- 14.6/14.9: ảnh không có text rõ để detect -> general, không đoán bừa ----------
test('13. Ảnh không kèm text -> general, confidence 0 (chưa đoán bừa, AI tự đọc ảnh lúc giải)', () => {
  const r = resolveSubject({ manualSubjectId: 'auto', problemText: '', hasImage: true });
  assert.strictEqual(r.subjectId, 'general');
  assert.strictEqual(r.subjectConfidence, 0);
});

// ---------- validators.js: settings.subject phải qua allow-list, không cho giá trị lạ lọt xuống AI ----------
test('14. validateChatBody: settings.subject hợp lệ được giữ nguyên', () => {
  const input = validateChatBody({ query: 'test', settings: { subject: 'chemistry' } });
  assert.strictEqual(input.settings.subject, 'chemistry');
});
test('14b. validateChatBody: settings.subject không hợp lệ/thiếu -> fallback "auto"', () => {
  const input1 = validateChatBody({ query: 'test', settings: { subject: '<script>' } });
  assert.strictEqual(input1.settings.subject, 'auto');
  const input2 = validateChatBody({ query: 'test' });
  assert.strictEqual(input2.settings.subject, 'auto');
});

// ---------- 14.18: KHÔNG được phá hỗ trợ Toán hiện tại ----------
test('15. buildSubjectDirective(math) CHỈ nhấn mạnh ngắn, không chèn cấu trúc bảng riêng đè lên Toán', () => {
  const block = buildSubjectDirective('math');
  assert.ok(block.includes('Toán học'));
  assert.ok(!block.includes('Ưu tiên nội dung:')); // math dùng nhánh rẽ riêng, không lặp khối chi tiết
});
test('16. buildChatSystemPrompt vẫn giữ nguyên toàn bộ chỉ thị KaTeX/LaTeX gốc khi subjectId=math', () => {
  const system = buildChatSystemPrompt({
    deepThinking: false, image: null, rules: [], contexts: [],
    settings: { lang: 'Tiếng Việt', detail: 'tiêu chuẩn', school: 'thpt', grade: '10' },
    stage: 'detail', approachText: '', problemText: 'Giải phương trình bậc 2', subjectId: 'math'
  });
  assert.ok(system.includes('LaTeX'));
  assert.ok(system.includes('## Lời giải'));
  assert.ok(system.includes('Toán học'));
});
test('17. buildChatSystemPrompt với subject khác (chemistry) vẫn giữ khung "## " gốc + chèn ưu tiên Hóa', () => {
  const system = buildChatSystemPrompt({
    deepThinking: false, image: null, rules: [], contexts: [],
    settings: { lang: 'Tiếng Việt', detail: 'tiêu chuẩn', school: 'thpt', grade: '10' },
    stage: 'detail', approachText: '', problemText: 'Cân bằng phương trình Fe + HCl', subjectId: 'chemistry'
  });
  assert.ok(system.includes('## Lời giải')); // cấu trúc chung không đổi
  assert.ok(system.includes('Hóa học'));
  assert.ok(system.includes('KHÔNG tự bịa phương trình hóa học'));
});
test('18. buildChatSystemPrompt stage=approach vẫn hoạt động bình thường khi có subjectId', () => {
  const system = buildChatSystemPrompt({
    deepThinking: false, image: null, rules: [], contexts: [],
    settings: { lang: 'Tiếng Việt', detail: 'tiêu chuẩn', school: 'thpt', grade: '10' },
    stage: 'approach', approachText: '', problemText: 'DNA là gì?', subjectId: 'biology'
  });
  assert.ok(system.includes('## Hướng giải'));
  assert.ok(system.includes('Sinh học'));
});
test('19. subjectId mặc định "general" khi không truyền -> không throw, vẫn build được prompt', () => {
  const system = buildChatSystemPrompt({
    deepThinking: false, image: null, rules: [], contexts: [],
    settings: { lang: 'Tiếng Việt', detail: 'tiêu chuẩn', school: 'thpt', grade: '10' },
    stage: 'detail', approachText: '', problemText: 'Câu hỏi bất kỳ'
  });
  assert.ok(typeof system === 'string' && system.length > 0);
});
test('20. PROMPT_VERSION đã bump khi thêm subject directive (tránh dùng nhầm cache L1 cũ)', () => {
  // Cập nhật lên v6 khi siết lại chỉ thị "## Hướng giải" (gọn hơn nhưng vẫn đủ ý khoa học) — xem
  // ghi chú tại PROMPT_VERSION trong promptBuilder.js. Ý nghĩa của test này KHÔNG đổi: version phải
  // được bump mỗi khi cấu trúc/nội dung prompt thay đổi đủ để làm output khác đi, nếu không cache
  // L1 cũ bị dùng nhầm.
  assert.strictEqual(PROMPT_VERSION, 'chat-prompt-v7');
});

// ---------- getSubject fallback ----------
test('21. getSubject với id không tồn tại -> fallback "general", không throw', () => {
  assert.strictEqual(getSubject('khong-ton-tai').id, 'general');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
