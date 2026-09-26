'use strict';

// ============================================================================================
// REGRESSION: QUESTION CLASSIFIER + KNOWLEDGE TEMPLATE BRANCH (Master Prompt V6.21.0-13)
// ============================================================================================
// Fix cho "OUTPUT GRANULARITY BUG": câu hỏi LÝ THUYẾT (vd "Tóm tắt lý thuyết về Dao động cơ") bị
// ép qua đúng khuôn "## Tóm tắt đề bài / ## Hướng giải / ## Lời giải / ## Kết luận / ## Lỗi sai
// thường gặp" của BÀI TOÁN, biến 4-5 gạch đầu dòng lý thuyết thành một "bài giảng" nhiều phần.
// Corpus dưới đây LÀ CHÍNH corpus hồi quy trong __MASTER_PROMPT_V6_19.md mục V6.21.2/.7.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { classifyQuestion } = require('../server/utils/questionClassifier');
const { buildChatSystemPrompt } = require('../server/utils/promptBuilder');
const { calculateAdaptiveBudget } = require('../server/utils/adaptiveBudget');

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, error: e.message }); }
}

// ---------- 1. Corpus phân loại (V6.21.2) ----------
const CORPUS = [
  ['Dao động cơ là gì?', 'KNOWLEDGE', 'SIMPLE'],
  ['Tần số là gì?', 'KNOWLEDGE', 'SIMPLE'],
  ['Công thức chu kỳ con lắc lò xo?', 'KNOWLEDGE', 'SIMPLE'],
  ['Tóm tắt lý thuyết về Dao động cơ', 'KNOWLEDGE', 'SIMPLE'], // V6.21.7 — case cụ thể
  ['Định luật Hooke là gì?', 'KNOWLEDGE', 'SIMPLE'],
  ['T = 2π√(m/k), m=1kg,k=4N/m tính T', 'PROBLEM', 'SIMPLE'],
  ['Giải phương trình x² - 5x + 6 = 0', 'PROBLEM', 'MODERATE'],
  ['Giải hệ phương trình có tham số và biện luận.', 'PROBLEM', 'COMPLEX'],
  ['Bài HSG nhiều hướng giải + cần kiểm chứng.', 'PROBLEM', 'EXPERT']
];
CORPUS.forEach(([q, wantKind, wantComplexity]) => {
  test(`classify "${q}" -> ${wantKind}/${wantComplexity}`, () => {
    const r = classifyQuestion({ problemText: q });
    assert.strictEqual(r.kind, wantKind, `kind sai: nhận ${r.kind}`);
    assert.strictEqual(r.complexity, wantComplexity, `complexity sai: nhận ${r.complexity}`);
  });
});

// ---------- 2. Không nhầm "giải thích"/"tìm hiểu" (chứa "giải"/"tìm") thành PROBLEM ----------
test('classify "Giải thích ngắn gọn về dao động cơ" -> KNOWLEDGE (không nhầm "giải thích"="giải")', () => {
  const r = classifyQuestion({ problemText: 'Giải thích ngắn gọn về dao động cơ' });
  assert.strictEqual(r.kind, 'KNOWLEDGE');
});
test('classify "Tìm hiểu về sóng cơ" -> KNOWLEDGE (không nhầm "tìm hiểu"="tìm")', () => {
  const r = classifyQuestion({ problemText: 'Tìm hiểu về sóng cơ' });
  assert.strictEqual(r.kind, 'KNOWLEDGE');
});

// ---------- 3. V6.21.7 — case cụ thể: responseDepth ĐÚNG D1, không bị ép xuống D0 ----------
test('V6.21.7: "Tóm tắt lý thuyết về Dao động cơ" -> responseDepth=D1 (không phải D0)', () => {
  const r = classifyQuestion({ problemText: 'Tóm tắt lý thuyết về Dao động cơ' });
  assert.strictEqual(r.responseDepth, 'D1');
});

// ---------- 4. V6.21.66 — explicit user override thắng suy luận mặc định ----------
test('override "giải chi tiết x2-5x+6=0 từng bước" -> complexity được nâng lên (expand)', () => {
  const base = classifyQuestion({ problemText: 'Giải phương trình x2-5x+6=0' });
  const expanded = classifyQuestion({ problemText: 'Giải phương trình x2-5x+6=0 từng bước, phân tích kỹ' });
  const order = ['TRIVIAL', 'SIMPLE', 'MODERATE', 'COMPLEX', 'EXPERT'];
  assert.ok(order.indexOf(expanded.complexity) >= order.indexOf(base.complexity), 'expand phải không làm giảm complexity');
  assert.strictEqual(expanded.explicitOverride, 'expand');
});

// ---------- 5. V6.21.6/.12 — prompt KNOWLEDGE không chứa mục thuộc khuôn giải bài tập ----------
test('buildChatSystemPrompt(kind=KNOWLEDGE) KHÔNG chứa "## Hướng giải"/"## Lời giải"/"## Kết luận"/"## Lỗi sai thường gặp"', () => {
  const problemText = 'Tóm tắt lý thuyết về Dao động cơ';
  const questionProfile = classifyQuestion({ problemText });
  const prompt = buildChatSystemPrompt({
    deepThinking: false, image: null, rules: [], contexts: [],
    settings: { lang: 'Tiếng Việt', school: '', grade: '', detail: 'tiêu chuẩn' },
    stage: 'approach', approachText: '', problemText, questionProfile
  });
  ['## Hướng giải', '## Lời giải', '## Kết luận', '## Lỗi sai thường gặp'].forEach((forbidden) => {
    assert.ok(!prompt.includes(forbidden), `prompt không được chứa "${forbidden}"`);
  });
  assert.ok(prompt.includes('KHÔNG PHẢI một bài tập'), 'prompt phải nêu rõ đây không phải bài tập cần giải');
});
test('buildChatSystemPrompt(kind=KNOWLEDGE) áp dụng NHƯ NHAU dù client gửi stage="detail"', () => {
  const problemText = 'Định luật Hooke là gì?';
  const questionProfile = classifyQuestion({ problemText });
  const prompt = buildChatSystemPrompt({
    deepThinking: false, image: null, rules: [], contexts: [],
    settings: { lang: 'Tiếng Việt', school: '', grade: '', detail: 'tiêu chuẩn' },
    stage: 'detail', approachText: '', problemText, questionProfile
  });
  assert.ok(!prompt.includes('## Lời giải'), 'stage="detail" vẫn không được ép khuôn giải bài khi kind=KNOWLEDGE');
});
test('buildChatSystemPrompt(kind=PROBLEM, stage=approach) VẪN giữ nguyên "## Hướng giải" (không regress)', () => {
  const problemText = 'Giải phương trình x² - 5x + 6 = 0';
  const questionProfile = classifyQuestion({ problemText });
  const prompt = buildChatSystemPrompt({
    deepThinking: false, image: null, rules: [], contexts: [],
    settings: { lang: 'Tiếng Việt', school: '', grade: '', detail: 'tiêu chuẩn' },
    stage: 'approach', approachText: '', problemText, questionProfile
  });
  assert.ok(prompt.includes('## Hướng giải'), 'bài toán thật vẫn phải qua khuôn Hướng giải như cũ');
});

// ---------- 6. V6.21.5/.19 — 'knowledge' có budget nhỏ hơn hẳn 'detail' cho CÙNG 1 đề bài ----------
test("calculateAdaptiveBudget(stage='knowledge') nhỏ hơn stage='detail' cho cùng problemText", () => {
  const problemText = 'Tóm tắt lý thuyết về Dao động cơ';
  const knowledge = calculateAdaptiveBudget({ stage: 'knowledge', problemText });
  const detail = calculateAdaptiveBudget({ stage: 'detail', problemText });
  assert.ok(knowledge.target < detail.target, `knowledge budget (${knowledge.target}) phải nhỏ hơn detail (${detail.target})`);
});

// ---------- 7. Wiring: chat.js phải gọi classifyQuestion() đúng 1 lần, gắn vào input.questionProfile ----------
test('chat.js require questionClassifier và gọi classifyQuestion() đúng 1 lần', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'chat.js'), 'utf8');
  assert.ok(/require\(['"]\.\.\/utils\/questionClassifier['"]\)/.test(src), 'phải require questionClassifier');
  const calls = (src.match(/classifyQuestion\(/g) || []).length;
  assert.strictEqual(calls, 1, `phải gọi classifyQuestion đúng 1 lần, thấy ${calls}`);
  assert.ok(/input\.questionProfile\s*=\s*classifyQuestion/.test(src), 'kết quả phải gắn vào input.questionProfile (để spread tự động vào buildChatSystemPrompt)');
});

// ---------- 8. Wiring: promptBuilder.js phải có nhánh KNOWLEDGE đứng TRƯỚC nhánh stage==='approach' ----------
test("promptBuilder.js: nhánh questionProfile.kind==='KNOWLEDGE' đứng TRƯỚC if(stage==='approach')", () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'utils', 'promptBuilder.js'), 'utf8');
  const knowledgeIdx = src.indexOf("questionProfile.kind === 'KNOWLEDGE'");
  const approachIdx = src.indexOf("stage === 'approach'");
  assert.ok(knowledgeIdx !== -1, 'phải có nhánh kiểm tra kind KNOWLEDGE');
  assert.ok(approachIdx !== -1, 'phải còn nhánh stage approach (không regress)');
  assert.ok(knowledgeIdx < approachIdx, 'nhánh KNOWLEDGE phải được kiểm tra TRƯỚC nhánh approach, để áp dụng cho cả stage approach lẫn detail');
});

// ---------- 9. V6.21.38 — cross-check bị tắt cho KNOWLEDGE dù client bật toggle ----------
test('wiring: chat.js tắt input.crossCheck khi questionProfile.crossCheckAllowed===false (V6.21.38, refactor lượt 5: đọc field Task Profile thay vì tự kiểm tra kind lần nữa)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'chat.js'), 'utf8');
  assert.ok(/if\s*\(input\.crossCheck\s*&&\s*!input\.questionProfile\.crossCheckAllowed\)/.test(src),
    'phải có guard tắt crossCheck khi crossCheckAllowed===false');
  assert.ok(/input\.crossCheck\s*=\s*false;/.test(src), 'phải thực sự set input.crossCheck = false');
});

// ---------- 10. V6.21.76-79 — Task Profile: crossCheckAllowed/budgetStage tính 1 lần, gắn vào questionProfile ----------
test('wiring: input.questionProfile.crossCheckAllowed tính ngay sau classify (Task Profile, không rải rác)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'chat.js'), 'utf8');
  assert.ok(/input\.questionProfile\.crossCheckAllowed\s*=\s*input\.questionProfile\.kind\s*!==\s*'KNOWLEDGE';/.test(src),
    'phải gắn crossCheckAllowed vào questionProfile');
  assert.ok(/if\s*\(input\.crossCheck\s*&&\s*!input\.questionProfile\.crossCheckAllowed\)/.test(src),
    'nhánh tắt cross-check phải ĐỌC lại field đã tính, không tự kiểm tra kind lần nữa');
});
test('wiring: input.questionProfile.budgetStage tính 1 lần, directStage() chỉ đọc lại (không tự quyết định lại)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'chat.js'), 'utf8');
  assert.ok(/input\.questionProfile\.budgetStage\s*=\s*input\.questionProfile\.kind\s*===\s*'KNOWLEDGE'/.test(src),
    'phải gắn budgetStage vào questionProfile ngay sau classify');
  assert.ok(/const directStage = \(\) => input\.questionProfile\.budgetStage;/.test(src),
    'directStage() giờ phải chỉ đọc lại field đã tính, không còn tự tính ternary riêng (Single Source of Truth)');
});

// ---------- 11. V6.21.33/.34 — history compression budget siết hơn cho KNOWLEDGE ----------
test('wiring: chat.js truyền budgetTokens=1200 cho compressHistoryForBudget khi kind=KNOWLEDGE', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'chat.js'), 'utf8');
  assert.ok(/const historyBudgetTokens = input\.questionProfile\.kind === 'KNOWLEDGE' \? 1200 : undefined;/.test(src),
    'phải tính historyBudgetTokens dựa trên kind');
  assert.ok(/compressHistoryForBudget\(input\.history,\s*\{[^}]*historyBudgetTokens/s.test(src),
    'phải truyền historyBudgetTokens vào compressHistoryForBudget');
});
test('wiring: PROBLEM kind không bị ép budgetTokens=1200 (chỉ KNOWLEDGE mới siết, giữ mặc định 3000 cho bài toán)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'chat.js'), 'utf8');
  assert.ok(/kind === 'KNOWLEDGE' \? 1200 : undefined/.test(src),
    'PROBLEM phải rơi vào nhánh undefined (dùng DEFAULT_HISTORY_BUDGET_TOKENS mặc định của semanticCompression.js), không bị siết nhầm');
});

let passed = 0, failed = 0;
console.log('\n== Regression: QUESTION CLASSIFIER + KNOWLEDGE TEMPLATE (Master Prompt V6.21.0-13) ==');
for (const r of results) {
  if (r.pass) { passed++; console.log('  ok  - ' + r.name); }
  else { failed++; console.log('  FAIL - ' + r.name + ' :: ' + r.error); }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
