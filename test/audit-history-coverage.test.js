'use strict';

// ============================================================================================
// AUDIT MỤC 16/17/19/20/21/22 — DỮ KIỆN NGẮN + COVERAGE THEO TỪNG YÊU CẦU
// ============================================================================================
// (a) MỤC 16/17: dữ kiện ngắn ("x=2", "y=-3", "AB=6", "R = 5 cm", "(2,3)") phải là CRITICAL;
//     "ok" phải là OPTIONAL; và tokenEconomy + contextCompressor phải dùng CHUNG một classifier.
// (b) MỤC 19/20/21/22: coverage tính theo TỪNG yêu cầu (a)(b)(c), không phải `text.includes(label)`,
//     không phải tỷ lệ số chunk chọn được.
// Chạy: node test/audit-history-coverage.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); passed += 1; }
  catch (e) { console.log(` FAIL - ${name}\n        ${e.message}`); failed += 1; }
}

const root = path.join(__dirname, '..');
const shared = require(path.join(root, 'server', 'utils', 'historyImportance.js'));
const te = require(path.join(root, 'server', 'utils', 'tokenEconomy.js'));
const cc = require(path.join(root, 'server', 'utils', 'contextCompressor.js'));
const ws = require(path.join(root, 'server', 'utils', 'source', 'sourceWorkingSet.js'));
const teSrc = fs.readFileSync(path.join(root, 'server', 'utils', 'tokenEconomy.js'), 'utf8');
const ccSrc = fs.readFileSync(path.join(root, 'server', 'utils', 'contextCompressor.js'), 'utf8');

console.log('\n== (a) MỤC 16/17: dữ kiện NGẮN không được coi là rác ==');

const CRITICAL_CASES = [
  'x=2', 'y=-3', 'a=5', 'AB=6', 'R=4', 'R = 5 cm', '(2,3)', 'A(0,0)', 'x ≥ 0',
  'v = 20 m/s', '60°', 'S = $\\frac{1}{2}ah$', '```shape\ncircle\n```', 'chọn B'
];
const OPTIONAL_CASES = ['ok', 'okay', 'cảm ơn', 'thanks', 'dạ', 'vâng', 'hi'];

test('A1. mọi dữ kiện ngắn đều CRITICAL (tokenEconomy — đường đi thật của history)', () => {
  CRITICAL_CASES.forEach((c) => {
    const got = te.classifyHistoryImportance({ role: 'user', content: c });
    assert.strictEqual(got, te.IMPORTANCE.CRITICAL, `"${c}" bị xếp ${got}, mất dữ kiện của đề bài`);
  });
});

test('A2. chào hỏi/xác nhận thuần tuý vẫn OPTIONAL (không nới lỏng quá tay)', () => {
  OPTIONAL_CASES.forEach((c) => {
    assert.strictEqual(te.classifyHistoryImportance({ role: 'user', content: c }), te.IMPORTANCE.OPTIONAL, `"${c}"`);
  });
});

test('A3. heuristic độ dài chỉ chạy SAU khi đã loại trừ dữ kiện', () => {
  // "abc" ngắn, không dữ kiện -> OPTIONAL. "a=1" cũng ngắn nhưng LÀ dữ kiện -> CRITICAL.
  assert.strictEqual(te.classifyHistoryImportance({ content: 'abc' }), te.IMPORTANCE.OPTIONAL);
  assert.strictEqual(te.classifyHistoryImportance({ content: 'a=1' }), te.IMPORTANCE.CRITICAL);
  const d = shared.detectDataState('AB=6');
  assert.strictEqual(d.protected, true);
  assert.ok(d.reasons.includes('assignment'), `reasons=${d.reasons}`);
});

test('A4. contextCompressor KHÔNG vứt dữ kiện ngắn (bản cũ: trimmed.length < 8 -> REDUNDANT)', () => {
  const keptShortData = ['x=2', 'y=-3', 'AB=6', '(2,3)'];
  keptShortData.forEach((text) => {
    const out = cc.compressContext ? null : null; // API nén đầy đủ không cần cho case này
    void out;
    const level = cc.scoreImportance ? cc.scoreImportance({ text }) : null;
    assert.ok(level, 'contextCompressor phải xuất scoreImportance để kiểm được');
    assert.notStrictEqual(level, 'REDUNDANT', `"${text}" bị đánh REDUNDANT -> sẽ bị nén mất`);
  });
  assert.strictEqual(cc.scoreImportance({ text: 'ok' }), 'REDUNDANT');
});

test('A5. MỤC 17: cả hai module dùng CHUNG classifier, không còn luật riêng', () => {
  assert.ok(/require\('\.\/historyImportance'\)/.test(teSrc), 'tokenEconomy chưa dùng classifier chung');
  assert.ok(/require\('\.\/historyImportance'\)/.test(ccSrc), 'contextCompressor chưa dùng classifier chung');
  // Chỉ soi MÃ THỰC THI (bỏ comment) — phần giải thích bug cũ vẫn được phép nhắc lại nguyên văn.
  const teCode = teSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/content\.trim\(\)\.length < 4/.test(teCode), 'vẫn còn heuristic độ dài chạy trước ở tokenEconomy');
  const ccCode = ccSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/GREETING_RE\.test\(trimmed\) \|\| trimmed\.length < 8/.test(ccCode),
    'vẫn còn heuristic độ dài chạy trước ở contextCompressor');
});

test('A6. hai module KHÔNG được đánh giá lệch nhau trên cùng một nội dung', () => {
  CRITICAL_CASES.concat(OPTIONAL_CASES).forEach((text) => {
    const teLevel = te.classifyHistoryImportance({ content: text });
    const ccLevel = cc.scoreImportance({ text });
    if (teLevel === 'CRITICAL') {
      assert.notStrictEqual(ccLevel, 'REDUNDANT',
        `"${text}": tokenEconomy giữ (CRITICAL) nhưng contextCompressor vứt (REDUNDANT)`);
    }
    if (teLevel === 'OPTIONAL' && OPTIONAL_CASES.includes(text)) {
      assert.strictEqual(ccLevel, 'REDUNDANT', `"${text}": hai bên lệch nhau ở phía filler`);
    }
  });
});

console.log('\n== (b) MỤC 19/20/21/22: coverage theo TỪNG yêu cầu ==');

const evidence = [
  { evidenceId: 'e1', sourceId: 's1', text: 'a) Tính diện tích tam giác ABC' },
  { evidenceId: 'e2', sourceId: 's1', text: 'Bài 1.10 — công thức Heron' },
  { evidenceId: 'e3', sourceId: 's2', text: 'nội dung cho ý c', requirementIds: ['c'] }
];

test('B1. MỤC 19: đề có (a)(b)(c) mà chỉ có bằng chứng cho (a)(c) -> KHÔNG được báo đủ', () => {
  const m = ws.coverageMatrix(evidence, ['(a)', '(b)', '(c)']);
  assert.strictEqual(m.total, 3);
  assert.strictEqual(m.covered, 2);
  assert.deepStrictEqual(m.missingRequirementIds, ['b']);
  assert.strictEqual(ws.coversAllRequirements(evidence, ['(a)', '(b)', '(c)']), false);
});

test('B2. MỤC 22: "(a)" khớp được với đoạn viết "a)" — không phụ thuộc exact string', () => {
  const row = ws.coverageMatrix(evidence, ['(a)']).rows[0];
  assert.strictEqual(row.covered, true);
  assert.strictEqual(row.matchKind, 'label_item');
  assert.strictEqual(row.evidenceIds[0], 'e1');
});

test('B3. KHÔNG khớp nhầm giữa chuỗi số: "1.1" không được coi là có trong "1.10"', () => {
  const m = ws.coverageMatrix(evidence, ['1.1']);
  assert.strictEqual(m.rows[0].covered, false, '"1.1" khớp nhầm vào "1.10" -> báo đủ trong khi đang thiếu');
  assert.strictEqual(ws.coverageMatrix(evidence, ['1.10']).rows[0].covered, true);
});

test('B4. MỤC 20: metadata requirementIds được ưu tiên, kèm confidence + evidenceIds', () => {
  const row = ws.coverageMatrix(evidence, ['c']).rows[0];
  assert.strictEqual(row.matchKind, 'metadata');
  assert.ok(row.confidence > 0.9, 'khớp bằng metadata phải có độ tin cậy cao nhất');
  assert.deepStrictEqual(row.evidenceIds, ['e3']);
  assert.deepStrictEqual(row.sourceIds, ['s2']);
});

test('B5. MỤC 20: yêu cầu thiếu phải nêu LÝ DO, để expansion nhắm đúng chỗ', () => {
  const row = ws.coverageMatrix(evidence, ['(b)']).rows[0];
  assert.strictEqual(row.covered, false);
  assert.strictEqual(row.missingReason, 'no_evidence_for_requirement');
  assert.strictEqual(row.confidence, 0);
  const empty = ws.coverageMatrix([], ['(b)']).rows[0];
  assert.strictEqual(empty.missingReason, 'no_evidence_at_all', 'phân biệt "không có nguồn nào" với "có nguồn nhưng không đúng ý"');
});

test('B6. MỤC 21: coverage tính theo YÊU CẦU, không theo số chunk', () => {
  // 10 chunk đều cho ý (a), 0 chunk cho (b)(c): tỷ lệ chunk rất "đẹp" nhưng coverage thật = 1/3.
  const manyForA = Array.from({ length: 10 }, (_, i) => ({ evidenceId: 'a' + i, sourceId: 's1', text: 'a) đoạn ' + i }));
  const m = ws.coverageMatrix(manyForA, ['(a)', '(b)', '(c)']);
  assert.strictEqual(m.covered, 1);
  assert.ok(Math.abs(m.requirementCoverageRatio - 1 / 3) < 1e-9, `ratio=${m.requirementCoverageRatio}`);
  assert.strictEqual(m.rows[0].evidenceIds.length, 10, 'vẫn liệt kê đủ bằng chứng của ý được phủ');
});

test('B7. nhãn dạng câu chữ dài vẫn khớp được (chứng minh/tính/tìm…)', () => {
  const ev = [{ evidenceId: 'x1', sourceId: 's3', text: 'Ta cần chứng minh rằng tam giác ABC cân tại A.' }];
  const m = ws.coverageMatrix(ev, ['chứng minh rằng tam giác ABC cân']);
  assert.strictEqual(m.rows[0].covered, true);
  assert.ok(['label_item', 'text_contains'].includes(m.rows[0].matchKind), `matchKind=${m.rows[0].matchKind}`);
  assert.ok(m.rows[0].confidence < 0.9, 'khớp theo nội dung phải có độ tin cậy thấp hơn metadata');
  // Nhãn dạng câu chữ KHÔNG có trong nguồn -> phải báo thiếu, không được khớp bừa.
  const miss = ws.coverageMatrix(ev, ['chứng minh tứ giác ABCD nội tiếp']);
  assert.strictEqual(miss.rows[0].covered, false);
});

test('B8. tương thích ngược: hình dạng cũ của mỗi hàng vẫn còn nguyên', () => {
  const row = ws.coverageMatrix(evidence, ['(a)']).rows[0];
  ['label', 'covered', 'sourceId', 'evidenceId'].forEach((k) => {
    assert.ok(Object.prototype.hasOwnProperty.call(row, k), `mất field cũ "${k}" -> vỡ caller trong chat.js`);
  });
});

console.log(`\n== KẾT QUẢ: ${passed} ok, ${failed} fail ==`);
if (failed > 0) process.exit(1);
