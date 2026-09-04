'use strict';
// P0 (master prompt v2, mục V/VI): school/grade phải đi xuyên suốt UI settings -> request body ->
// validateChatBody() -> promptBuilder -> system prompt gửi AI. Trước bản sửa, validateChatBody() bỏ
// hẳn 2 trường này (chỉ giữ lang/detail), nên AI không bao giờ biết học sinh học lớp mấy dù UI đã có
// đủ chip chọn "Cấp học/Khối lớp". Test này chứng minh bug đã tồn tại + đã được sửa thật sự (không
// chỉ sửa 1 lớp — phải thấy giá trị xuất hiện tới tận system prompt cuối cùng).

const assert = require('assert');
const { validateChatBody, SCHOOL_GRADES } = require('../server/utils/validators');
const { buildChatSystemPrompt, buildReconcileSystemPrompt, buildSchoolGradeDirective } = require('../server/utils/promptBuilder');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  -', name); }
  catch (e) { failed++; console.log('  FAIL -', name, '\n       ', e.message); }
}

console.log('\n== P0: school/grade — validateChatBody() giữ lại đúng giá trị hợp lệ ==');

test('THCS/Lớp 8 hợp lệ -> giữ nguyên trong settings đã validate', () => {
  const out = validateChatBody({ query: 'Giải phương trình', settings: { school: 'thcs', grade: '8' } });
  assert.strictEqual(out.settings.school, 'thcs');
  assert.strictEqual(out.settings.grade, '8');
});

test('THPT/Lớp 10 hợp lệ -> giữ nguyên trong settings đã validate', () => {
  const out = validateChatBody({ query: 'Khảo sát hàm số', settings: { school: 'thpt', grade: '10' } });
  assert.strictEqual(out.settings.school, 'thpt');
  assert.strictEqual(out.settings.grade, '10');
});

test('không gửi settings.school/grade -> có default hợp lệ (không phải undefined)', () => {
  const out = validateChatBody({ query: 'x' });
  assert.ok(SCHOOL_GRADES[out.settings.school], 'school mặc định phải nằm trong allow-list');
  assert.ok(SCHOOL_GRADES[out.settings.school].includes(out.settings.grade), 'grade mặc định phải khớp school mặc định');
});

test('school hợp lệ nhưng grade KHÔNG thuộc school đó (vd thcs + lớp 10) -> tự sửa về 1 grade hợp lệ của đúng school, không throw', () => {
  const out = validateChatBody({ query: 'x', settings: { school: 'thcs', grade: '10' } });
  assert.strictEqual(out.settings.school, 'thcs');
  assert.ok(SCHOOL_GRADES.thcs.includes(out.settings.grade), 'grade trả về phải thuộc đúng nhóm grade của thcs');
});

test('school lạ/injection -> rơi về default, không throw, không giữ giá trị lạ', () => {
  const out = validateChatBody({ query: 'x', settings: { school: '<script>', grade: '999' } });
  assert.ok(SCHOOL_GRADES[out.settings.school]);
  assert.ok(SCHOOL_GRADES[out.settings.school].includes(out.settings.grade));
});

console.log('\n== P0: school/grade thực sự XUẤT HIỆN trong system prompt gửi AI (không chỉ tồn tại ở validators) ==');

test('buildSchoolGradeDirective(): sinh chỉ thị chứa đúng nhãn cấp học + lớp', () => {
  const block = buildSchoolGradeDirective('thcs', '8');
  assert.ok(block.includes('THCS'), 'phải nêu rõ cấp học THCS');
  assert.ok(block.includes('Lớp 8'), 'phải nêu rõ đúng khối lớp 8');
});

test('buildChatSystemPrompt(stage=approach) chứa chỉ thị cấp học/lớp lấy từ settings đã validate', () => {
  const { settings } = validateChatBody({ query: 'x', settings: { school: 'thpt', grade: '11' } });
  const prompt = buildChatSystemPrompt({
    deepThinking: false, image: null, rules: [], contexts: [], settings, stage: 'approach', approachText: ''
  });
  assert.ok(prompt.includes('THPT'), 'system prompt (approach) phải chứa cấp học THPT');
  assert.ok(prompt.includes('Lớp 11'), 'system prompt (approach) phải chứa đúng lớp 11');
});

test('buildChatSystemPrompt(stage=detail) chứa chỉ thị cấp học/lớp lấy từ settings đã validate', () => {
  const { settings } = validateChatBody({ query: 'x', settings: { school: 'thcs', grade: '9' } });
  const prompt = buildChatSystemPrompt({
    deepThinking: false, image: null, rules: [], contexts: [], settings, stage: 'detail', approachText: ''
  });
  assert.ok(prompt.includes('THCS'), 'system prompt (detail) phải chứa cấp học THCS');
  assert.ok(prompt.includes('Lớp 9'), 'system prompt (detail) phải chứa đúng lớp 9');
});

test('buildReconcileSystemPrompt() (lượt tổng hợp cuối) cũng chứa đúng cấp học/lớp — không "quên" ở bước cross-check', () => {
  const { settings } = validateChatBody({ query: 'x', settings: { school: 'thpt', grade: '12' } });
  const prompt = buildReconcileSystemPrompt({
    candidates: [{ label: 'Claude', text: 'lời giải A' }, { label: 'GPT', text: 'lời giải B' }],
    contexts: [], settings, hasWebSearch: false, deepThinking: false
  });
  assert.ok(prompt.includes('THPT'), 'system prompt reconcile phải chứa cấp học THPT');
  assert.ok(prompt.includes('Lớp 12'), 'system prompt reconcile phải chứa đúng lớp 12');
});

test('2 học sinh khác lớp gửi CÙNG 1 câu hỏi -> system prompt SINH RA PHẢI KHÁC NHAU ở phần cấp học/lớp (bằng chứng end-to-end, không phải trùng hợp)', () => {
  const settingsGrade6 = validateChatBody({ query: 'Tính diện tích', settings: { school: 'thcs', grade: '6' } }).settings;
  const settingsGrade12 = validateChatBody({ query: 'Tính diện tích', settings: { school: 'thpt', grade: '12' } }).settings;
  const promptA = buildChatSystemPrompt({ deepThinking: false, image: null, rules: [], contexts: [], settings: settingsGrade6, stage: 'detail', approachText: '' });
  const promptB = buildChatSystemPrompt({ deepThinking: false, image: null, rules: [], contexts: [], settings: settingsGrade12, stage: 'detail', approachText: '' });
  assert.notStrictEqual(promptA, promptB);
  assert.ok(promptA.includes('Lớp 6') && !promptA.includes('Lớp 12'));
  assert.ok(promptB.includes('Lớp 12') && !promptB.includes('Lớp 6'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
