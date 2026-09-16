'use strict';

// ---------- A1: PROMPT CACHING THẬT (không phải "cache vì nằm ở đầu prompt") ----------
// Bản trước tin rằng CORE_DIRECTIVE được cache chỉ vì nó đứng đầu system prompt. Anthropic KHÔNG
// cache theo vị trí — phải có `cache_control` tường minh. Bộ test này khẳng định:
//   1. buildChatSystemPromptParts/buildReconcileSystemPromptParts tách đúng tĩnh/động.
//   2. Phần TĨNH GIỐNG HỆT NHAU giữa 2 lần build với input động khác hẳn (cache key ổn định).
//   3. body.system của Anthropic là MẢNG content block, breakpoint ở ĐÚNG vị trí.
//   4. Nhánh `system` là string (caller cũ) vẫn hoạt động KHÔNG ĐỔI.
//   5. Provider không có cache tường minh vẫn nhận đủ nội dung, đúng thứ tự TĨNH -> CONTEXT -> ĐỘNG.

const assert = require('assert');
const {
  buildChatSystemPromptParts, buildChatSystemPrompt,
  buildReconcileSystemPromptParts, buildReconcileSystemPrompt
} = require('../server/utils/promptBuilder');
const {
  toAnthropicSystemBlocks, systemToString, appendToSystem, isPromptParts, estimatePromptTokens, CACHE_MIN_TOKENS
} = require('../server/utils/systemPromptParts');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  - ' + name); }
  catch (e) { failed++; console.log(' FAIL - ' + name + '\n        ' + e.message); }
}

const baseInput = (over = {}) => ({
  deepThinking: false, image: null, rules: [], contexts: [],
  settings: { lang: 'Tiếng Việt', detail: 'normal', school: 'THPT', grade: '10' },
  stage: 'detail', approachText: '', problemText: 'Giải phương trình 2x + 3 = 7.',
  subjectId: 'math', ...over
});

test('1. staticPart ỔN ĐỊNH giữa 2 lần build có input động KHÁC HẲN (điều kiện sống còn của cache key)', () => {
  const a = buildChatSystemPromptParts(baseInput());
  const b = buildChatSystemPromptParts(baseInput({
    stage: 'approach',
    problemText: 'Cho hình chóp S.ABCD đáy hình vuông cạnh a, tính thể tích.',
    settings: { lang: 'English', detail: 'ngắn gọn', school: 'dai-hoc', grade: 'dai-hoc' },
    rules: ['luôn dùng đơn vị SI'],
    contexts: [{ doc: 'sgk.pdf', id: 3, citeNo: 1, text: 'Công thức thể tích khối chóp V = 1/3·B·h' }],
    deepThinking: true, subjectId: 'physics'
  }));
  assert.strictEqual(a.staticPart, b.staticPart, 'staticPart phải giống hệt từng ký tự');
  assert.notStrictEqual(a.dynamicPart, b.dynamicPart, 'dynamicPart phải khác nhau');
});

test('2. staticPart đủ lớn để Anthropic thực sự cache (>= 1024 token ước lượng)', () => {
  const p = buildChatSystemPromptParts(baseInput());
  assert.ok(estimatePromptTokens(p.staticPart) >= CACHE_MIN_TOKENS,
    `staticPart chỉ ~${estimatePromptTokens(p.staticPart)} token, dưới ngưỡng cache ${CACHE_MIN_TOKENS}`);
});

test('3. text = staticPart + dynamicPart, và KHÔNG mất nội dung so với hàm string cũ', () => {
  const input = baseInput({ problemText: 'Cho tam giác ABC vuông tại A, đường cao AH.' });
  const p = buildChatSystemPromptParts(input);
  assert.strictEqual(p.text, p.staticPart + p.dynamicPart);
  assert.strictEqual(buildChatSystemPrompt(input), p.text, 'hàm string cũ phải trả đúng bản ghép');
  // Các chỉ thị cốt lõi không được rơi mất khi tách khối.
  ['MỆNH LỆNH DUY NHẤT', 'QUY TẮC NGÔN NGỮ', 'LaTeX', 'Tóm tắt đề bài'].forEach((needle) => {
    assert.ok(p.text.includes(needle), 'thiếu chỉ thị: ' + needle);
  });
});

test('4. reconcile: 3 khối tĩnh / ngữ cảnh nguồn / động, ngữ cảnh nguồn đứng TRƯỚC phần động', () => {
  const input = {
    candidates: [{ label: 'Claude', text: 'x = 2' }, { label: 'GPT', text: 'x = 2' }],
    contexts: [{ doc: 'a.pdf', id: 1, citeNo: 1, text: 'Định lý Pytago: a^2 + b^2 = c^2' }],
    settings: { lang: 'Tiếng Việt', detail: 'normal', school: 'THPT', grade: '10' },
    hasWebSearch: false, deepThinking: true, agreement: true, subjectId: 'math'
  };
  const p = buildReconcileSystemPromptParts(input);
  assert.ok(p.cachedContextPart.includes('Pytago'), 'khối ngữ cảnh nguồn phải nằm ở cachedContextPart');
  assert.ok(!p.dynamicPart.includes('Pytago'), 'không được lặp lại ngữ cảnh nguồn trong phần động');
  assert.strictEqual(p.text, p.staticPart + p.cachedContextPart + p.dynamicPart);
  assert.strictEqual(buildReconcileSystemPrompt(input), p.text);
  assert.ok(p.text.indexOf(p.cachedContextPart) < p.text.indexOf(p.dynamicPart),
    'ngữ cảnh nguồn phải là PREFIX của phần động, nếu không nó không bao giờ cache được');
});

test('5. reconcile: staticPart ổn định dù candidate/agreement/ngôn ngữ đổi', () => {
  const mk = (over) => buildReconcileSystemPromptParts({
    candidates: [{ label: 'A', text: 'x=1' }],
    contexts: [], settings: { lang: 'Tiếng Việt', detail: 'normal', school: 'THPT', grade: '10' },
    hasWebSearch: false, deepThinking: false, agreement: false, subjectId: 'math', ...over
  });
  const a = mk({});
  const b = mk({
    candidates: [{ label: 'A', text: 'x=1' }, { label: 'B', text: 'x=2' }, { label: 'C', text: 'x=3' }],
    settings: { lang: 'English', detail: 'ngắn gọn', school: 'THCS', grade: '8' },
    hasWebSearch: true, deepThinking: true, agreement: true
  });
  assert.strictEqual(a.staticPart, b.staticPart);
});

test('6. Anthropic: system trở thành MẢNG block, cache_control ở CUỐI khối tĩnh (và khối ngữ cảnh lớn)', () => {
  const parts = buildChatSystemPromptParts(baseInput());
  const blocks = toAnthropicSystemBlocks(parts);
  assert.ok(Array.isArray(blocks), 'phải là mảng content block');
  assert.strictEqual(blocks[0].type, 'text');
  assert.deepStrictEqual(blocks[0].cache_control, { type: 'ephemeral' }, 'khối tĩnh phải có breakpoint');
  assert.strictEqual(blocks[blocks.length - 1].cache_control, undefined, 'khối ĐỘNG không bao giờ được cache');

  // Khối ngữ cảnh nguồn LỚN -> breakpoint riêng ngay sau khối đó (A1 mục 3b).
  const bigContext = { staticPart: parts.staticPart, cachedContextPart: 'X'.repeat(CACHE_MIN_TOKENS * 4), dynamicPart: 'đề bài' };
  const b2 = toAnthropicSystemBlocks(bigContext);
  assert.strictEqual(b2.length, 3);
  assert.deepStrictEqual(b2[1].cache_control, { type: 'ephemeral' });

  // Khối ngữ cảnh NHỎ -> KHÔNG tốn breakpoint vô ích (Anthropic chỉ cho tối đa 4).
  const smallContext = { staticPart: parts.staticPart, cachedContextPart: 'ngắn', dynamicPart: 'đề bài' };
  assert.strictEqual(toAnthropicSystemBlocks(smallContext)[1].cache_control, undefined);
});

test('7. Nhánh string CŨ không đổi hành vi (tương thích ngược 100%)', () => {
  assert.strictEqual(toAnthropicSystemBlocks('một system prompt dạng chuỗi'), null,
    'string -> null -> caller giữ nguyên body.system là chuỗi như trước');
  assert.strictEqual(systemToString('nguyên văn'), 'nguyên văn');
  assert.strictEqual(isPromptParts('chuỗi'), false);
  assert.strictEqual(appendToSystem('abc', 'def'), 'abcdef');
});

test('8. Provider không cache tường minh: ghép đúng thứ tự TĨNH -> CONTEXT -> ĐỘNG', () => {
  const joined = systemToString({ staticPart: 'S', cachedContextPart: 'C', dynamicPart: 'D' });
  assert.strictEqual(joined, 'S\nC\nD');
  assert.ok(joined.indexOf('S') < joined.indexOf('D'), 'phần tĩnh PHẢI đứng trước phần động');
});

test('9. appendToSystem chỉ chạm phần ĐỘNG — cache key của phần tĩnh không bao giờ bị phá', () => {
  const parts = buildChatSystemPromptParts(baseInput());
  const variant = appendToSystem(parts, '\n\nYÊU CẦU BỔ SUNG: tự phản biện nghiêm khắc.');
  assert.strictEqual(variant.staticPart, parts.staticPart, 'staticPart phải nguyên vẹn');
  assert.ok(variant.dynamicPart.endsWith('tự phản biện nghiêm khắc.'));
});

console.log('\n== A1: prompt caching (static/dynamic split + cache breakpoint) ==');
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
