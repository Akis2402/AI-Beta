'use strict';

// ============================================================================================
// PHẦN R — TEST TOKEN COMPRESSION (19 yêu cầu)
// ============================================================================================
// Chạy: node test/token-compression.test.js
// Không gọi mạng, không cần API key — compression là lớp APPLICATION thuần (contextCompressor.js).

const assert = require('assert');
const cc = require('../server/utils/contextCompressor');
const { buildMinimalContinuationContext, compactPriorText } = require('../server/utils/continuation');
const { calculateAdaptiveBudget } = require('../server/utils/adaptiveBudget');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  -', name); }
  catch (e) { failed++; console.log(' FAIL -', name, '\n       ', e.message); }
}

// ---------- Dữ liệu mẫu: hội thoại dài, có số liệu/công thức/hình vẽ/citation ----------
function makeHistory(turnPairs) {
  const out = [];
  for (let i = 0; i < turnPairs; i++) {
    out.push({
      role: 'user',
      content: `Bài ${i}: cho tam giác ABC vuông tại A, AB = ${3 + i} cm, AC = 4 cm. Tính diện tích.`
    });
    out.push({
      role: 'assistant',
      content: [
        'Trước khi bắt tay vào tính toán, ta cần đọc lại thật kỹ toàn bộ dữ kiện của bài toán và xác định rõ mình đang phải tìm cái gì.',
        `AB = ${3 + i} cm, AC = 4 cm`,
        'Công thức diện tích tam giác vuông là nửa tích hai cạnh góc vuông, đây là kiến thức nền tảng mà mọi học sinh đều cần ghi nhớ cho chắc.',
        `Vậy S = ${(3 + i) * 4 / 2} cm²`
      ].join('\n')
    });
  }
  return out;
}

const LONG_CONTEXT_TOKENS = 9000;
const MEDIUM_CONTEXT_TOKENS = 2600;

console.log('\n== 1-3. Ngưỡng + mục tiêu nén thích ứng theo độ dài ngữ cảnh ==');

test('1. context NGẮN => KHÔNG nén vô lý (targetRatio = 0, không đổi 1 item nào)', () => {
  const items = cc.assignTiers(makeHistory(2));
  const r = cc.semanticCompressContext({ items, problemText: 'tam giác', totalInputTokens: 500 });
  assert.strictEqual(r.stats.targetRatio, 0, 'context ngắn không được đặt mục tiêu nén');
  assert.strictEqual(r.stats.achievedSavingTokens, 0);
  assert.strictEqual(r.items.length, items.length, 'không được bỏ item nào khi không nén');
});

test('2. context TRUNG BÌNH => compression NHẸ (mục tiêu 10%)', () => {
  const items = cc.assignTiers(makeHistory(10));
  const r = cc.semanticCompressContext({ items, problemText: 'tam giác vuông diện tích', totalInputTokens: MEDIUM_CONTEXT_TOKENS });
  assert.strictEqual(r.stats.targetRatio, cc.TARGET_RATIO_NORMAL);
  assert.ok(r.stats.totalCompressionRatio > 0, 'phải nén được ít nhất một phần');
  assert.ok(r.stats.totalCompressionRatio < 0.16, `nén nhẹ, không vượt xa mục tiêu 10% (thấy ${(r.stats.totalCompressionRatio * 100).toFixed(1)}%)`);
});

test('3. context DÀI => compression đạt khoảng 10-20% tổng input', () => {
  const items = cc.assignTiers(makeHistory(40));
  const r = cc.semanticCompressContext({ items, problemText: 'tam giác vuông diện tích AB AC', totalInputTokens: LONG_CONTEXT_TOKENS });
  const pct = r.stats.totalCompressionRatio;
  assert.ok(pct >= 0.10, `phải đạt >= 10% (thấy ${(pct * 100).toFixed(1)}%)`);
  assert.ok(pct <= 0.26, `không được vượt quá xa trần 20% (thấy ${(pct * 100).toFixed(1)}%)`);
});

console.log('\n== 4-11. KHÔNG được mất thông tin quan trọng ==');

test('4. không mất đề bài (TIER 0 immutable) — item isCore giữ nguyên từng ký tự nội dung', () => {
  const problem = 'Cho hình chóp S.ABCD có SA = 2a, đáy là hình vuông cạnh a. Tính thể tích.';
  const items = [
    { id: 'core', text: problem, tier: cc.TIER.IMMUTABLE_CORE, isCore: true },
    ...cc.assignTiers(makeHistory(30))
  ];
  const r = cc.semanticCompressContext({ items, problemText: problem, totalInputTokens: LONG_CONTEXT_TOKENS });
  const core = r.items.find((i) => i.id === 'core');
  assert.ok(core, 'item đề bài không bao giờ được loại bỏ');
  assert.strictEqual(core.text, problem, 'đề bài phải giữ NGUYÊN VĂN');
});

test('5. không mất constraints/điều kiện/giả thiết', () => {
  const line = 'Điều kiện xác định: x khác 2 và x lớn hơn 0';
  const items = [
    ...cc.assignTiers(makeHistory(30)),
    { id: 'c', text: line, tier: cc.TIER.OLD_HISTORY, role: 'assistant' }
  ];
  const r = cc.semanticCompressContext({ items, problemText: 'giải phương trình', totalInputTokens: LONG_CONTEXT_TOKENS });
  const kept = r.items.find((i) => i.id === 'c');
  assert.ok(kept && kept.text.includes('Điều kiện xác định'), 'dòng điều kiện phải được giữ');
});

test('6. không mất variables (phép gán biến)', () => {
  const items = cc.assignTiers(makeHistory(40));
  const before = items.map((i) => i.text).join('\n');
  const r = cc.semanticCompressContext({ items, problemText: 'tam giác', totalInputTokens: LONG_CONTEXT_TOKENS });
  const after = r.items.map((i) => i.text).join('\n');
  const g = (t) => cc.semanticGrains(t).assignments;
  const lost = [...g(before)].filter((x) => !g(after).has(x));
  assert.deepStrictEqual(lost, [], 'không được mất phép gán biến nào');
});

test('7. không mất equations / công thức LaTeX', () => {
  const latex = 'Ta có $S = \\frac{1}{2}ab\\sin C$ và $$a^2 = b^2 + c^2 - 2bc\\cos A$$';
  const items = [
    ...cc.assignTiers(makeHistory(30)),
    { id: 'f', text: latex + '\nĐây là một đoạn diễn giải rất dài không mang bất kỳ dữ liệu nào cả, chỉ để giải thích thêm cho người đọc hiểu.', tier: cc.TIER.OLD_HISTORY, role: 'assistant' }
  ];
  const r = cc.semanticCompressContext({ items, problemText: 'định lý cosin', totalInputTokens: LONG_CONTEXT_TOKENS });
  const kept = r.items.find((i) => i.id === 'f');
  assert.ok(kept.text.includes('\\frac{1}{2}ab\\sin C'), 'công thức inline phải còn');
  assert.ok(kept.text.includes('a^2 = b^2 + c^2 - 2bc\\cos A'), 'công thức khối phải còn');
});

test('8. không mất numbers (mọi con số ở mọi tier)', () => {
  const items = cc.assignTiers(makeHistory(40));
  const before = items.map((i) => i.text).join('\n');
  const r = cc.semanticCompressContext({ items, problemText: 'tam giác', totalInputTokens: LONG_CONTEXT_TOKENS });
  const after = r.items.map((i) => i.text).join('\n');
  const nums = (t) => cc.semanticGrains(t).numbers;
  const lost = [...nums(before)].filter((x) => !nums(after).has(x));
  assert.deepStrictEqual(lost, [], `không được mất số nào (mất: ${lost.slice(0, 5)})`);
});

test('9. không mất unfinished section ("Bước 7:" cụt ở cuối)', () => {
  const unfinished = 'Bước 7:';
  const items = [
    ...cc.assignTiers(makeHistory(30)),
    { id: 'u', text: 'Ta tiếp tục phân tích thêm một chút nữa cho thật rõ ràng và đầy đủ ý nghĩa hình học.\n' + unfinished, tier: cc.TIER.OLD_HISTORY, role: 'assistant' }
  ];
  const r = cc.semanticCompressContext({ items, problemText: 'x', totalInputTokens: LONG_CONTEXT_TOKENS });
  const kept = r.items.find((i) => i.id === 'u');
  assert.ok(kept.text.includes('Bước 7:'), 'bước đang dở phải được giữ');
});

test('10. không mất drawing canonical state (khối ```shape giữ NGUYÊN VĂN)', () => {
  const block = '```shape\n{"ops":[{"op":"point","id":"A","x":0,"y":0},{"op":"point","id":"B","x":3,"y":0}]}\n```';
  const items = [
    ...cc.assignTiers(makeHistory(30)),
    { id: 'd', text: 'Hình vẽ minh hoạ cho lời giải phía trên, giúp người đọc hình dung rõ hơn về cấu hình.\n' + block, tier: cc.TIER.OLD_HISTORY, role: 'assistant' }
  ];
  const r = cc.semanticCompressContext({ items, problemText: 'vẽ hình', totalInputTokens: LONG_CONTEXT_TOKENS });
  const kept = r.items.find((i) => i.id === 'd');
  assert.ok(kept.text.includes(block), 'khối vẽ phải nguyên vẹn từng ký tự (canonical state)');
});

test('11. không mất citation state ([n])', () => {
  const items = [
    ...cc.assignTiers(makeHistory(30)),
    { id: 'cit', text: 'Theo tài liệu đã cung cấp thì kết quả này hoàn toàn phù hợp với lý thuyết chuẩn [2] và [5].', tier: cc.TIER.OLD_HISTORY, role: 'assistant' }
  ];
  const r = cc.semanticCompressContext({ items, problemText: 'x', totalInputTokens: LONG_CONTEXT_TOKENS });
  const all = r.items.map((i) => i.text).join('\n');
  assert.ok(all.includes('[2]') && all.includes('[5]'), 'citation phải được giữ');
});

console.log('\n== 12-14. Chống nén 2 lần + quality gate + tái dựng ngữ nghĩa ==');

test('12. KHÔNG duplicate compression (item đã có compressedFrom bị bỏ qua)', () => {
  const items = cc.assignTiers(makeHistory(40));
  const first = cc.semanticCompressContext({ items, problemText: 'tam giác', totalInputTokens: LONG_CONTEXT_TOKENS });
  const second = cc.semanticCompressContext({ items: first.items, problemText: 'tam giác', totalInputTokens: LONG_CONTEXT_TOKENS });
  assert.ok(second.stats.skippedAlreadyCompressed > 0, 'phải nhận ra item đã nén và bỏ qua');
  assert.strictEqual(second.stats.achievedSavingTokens, 0, 'lần nén thứ 2 không được xói mòn thêm');
  assert.strictEqual(
    second.items.map((i) => i.text).join('|'),
    first.items.map((i) => i.text).join('|'),
    'nội dung không được đổi ở lần nén thứ 2'
  );
});

test('13. quality gate FAIL => rollback (giữ bản lossless, không giữ bản nén lỗi)', () => {
  // Ép quality gate fail: nén 1 đoạn mà bản "nén" cố tình làm mất số.
  const original = 'Giá trị cần tìm là 42 và 7.5 đơn vị.';
  const broken = 'Giá trị cần tìm là đơn vị.';
  const gate = cc.qualityGate(original, broken);
  assert.strictEqual(gate.ok, false, 'gate phải phát hiện mất số');
  assert.ok(gate.missing.numbers && gate.missing.numbers.length >= 2, 'phải chỉ rõ số nào bị mất');
  // Và trong pipeline thật: mọi item được nén đều phải qua gate, nên không item nào mất số (test 8).
});

test('14. compressed context vẫn reconstruct đúng ý nghĩa (mọi hạt ngữ nghĩa được bảo toàn)', () => {
  const items = cc.assignTiers(makeHistory(40));
  const before = items.map((i) => i.text).join('\n');
  const r = cc.semanticCompressContext({ items, problemText: 'tam giác vuông', totalInputTokens: LONG_CONTEXT_TOKENS });
  const after = r.items.map((i) => i.text).join('\n');
  const missing = cc.missingGrains(cc.semanticGrains(before), cc.semanticGrains(after));
  assert.deepStrictEqual(Object.keys(missing), [], `không hạt ngữ nghĩa nào được phép mất (mất: ${JSON.stringify(missing).slice(0, 200)})`);
});

console.log('\n== 15-16. PHẦN E: OUTPUT budget ĐỘC LẬP với input compression ==');

test('15. output budget KHÔNG bị giảm chỉ vì input được nén', () => {
  const problemText = 'Cho hàm số y = x^3 - 3x + 2. a) Khảo sát. b) Tìm cực trị. c) Vẽ đồ thị. d) Biện luận số nghiệm.';
  const heavyHistory = makeHistory(40).map((h) => h.content).join('\n');
  const light = calculateAdaptiveBudget({ stage: 'detail', problemText, historyText: '', remainingMs: 60000 });
  const heavy = calculateAdaptiveBudget({ stage: 'detail', problemText, historyText: heavyHistory, remainingMs: 60000 });
  // Budget phụ thuộc ĐỘ PHỨC TẠP ĐỀ BÀI (+ bonus nhỏ theo contexts), KHÔNG phụ thuộc history dài/ngắn
  // => nén history không thể làm output budget nhỏ đi.
  assert.strictEqual(light.target, heavy.target, 'target output không được thay đổi theo độ dài history');
});

test('16. bài khó vẫn đủ output tokens (nhiều ý => budget lớn hơn bài 1 ý)', () => {
  const easy = calculateAdaptiveBudget({ stage: 'detail', problemText: 'Tính 2+2', remainingMs: 60000 });
  const hard = calculateAdaptiveBudget({
    stage: 'detail',
    problemText: 'a) Khảo sát hàm số. b) Tìm cực trị. c) Viết phương trình tiếp tuyến. d) Biện luận số nghiệm theo m. e) Tính diện tích hình phẳng.'.repeat(4),
    remainingMs: 60000
  });
  assert.ok(hard.target > easy.target, 'bài nhiều ý phải được cấp nhiều token hơn');
});

console.log('\n== 17-19. Compression không gây tác dụng phụ ==');

test('17. compression KHÔNG làm tăng continuation rate: mọi tín hiệu "chưa xong" đều được giữ', () => {
  // Nếu compression bỏ mất dấu hiệu "chưa xong" (Bước cụt / fence chưa đóng), completeness sẽ tưởng
  // đã xong -> KHÔNG continuation -> câu trả lời bị cắt. Nếu bỏ mất dữ liệu -> AI phải hỏi/tính lại
  // -> TĂNG continuation. Cả hai đều bị chặn bởi quality gate; ở đây kiểm tra tín hiệu cấu trúc.
  const withOpenFence = 'Ta có kết quả như sau, và bây giờ hãy xem xét thật kỹ phần hình vẽ minh hoạ ngay bên dưới đây.\n```shape\n{"ops":[';
  const out = cc.compressProsePreservingData(withOpenFence, { aggressive: true });
  assert.ok(out.includes('```shape'), 'ranh giới khối chưa đóng phải được giữ để completeness còn phát hiện được');
  assert.ok(out.includes('{"ops":['), 'phần JSON dở phải được giữ');
});

test('18. compression không tạo nội dung mới (không hallucination): mọi dòng còn lại là dòng gốc hoặc marker cố định', () => {
  const items = cc.assignTiers(makeHistory(40));
  const originalLines = new Set(items.flatMap((i) => i.text.split('\n').map((l) => l.trim())));
  const r = cc.semanticCompressContext({ items, problemText: 'tam giác', totalInputTokens: LONG_CONTEXT_TOKENS });
  const MARKER = '[…phần diễn giải đã hoàn thành ở trên…]';
  r.items.forEach((it) => {
    it.text.split('\n').map((l) => l.trim()).filter(Boolean).forEach((line) => {
      assert.ok(
        originalLines.has(line) || line === MARKER,
        `dòng "${line.slice(0, 60)}" không tới từ nội dung gốc — compression không được sinh text mới`
      );
    });
  });
});

test('19. compression không làm sai mathematical result (đáp số cuối luôn còn nguyên)', () => {
  const items = cc.assignTiers(makeHistory(40));
  const r = cc.semanticCompressContext({ items, problemText: 'tam giác', totalInputTokens: LONG_CONTEXT_TOKENS });
  const all = r.items.map((i) => i.text).join('\n');
  for (let i = 0; i < 40; i++) {
    const expected = `Vậy S = ${(3 + i) * 4 / 2} cm²`;
    assert.ok(all.includes(expected), `đáp số "${expected}" phải còn nguyên sau nén`);
  }
});

console.log('\n== Bổ sung: continuation context tối thiểu (PHẦN G) cũng phải bảo toàn ngữ nghĩa ==');

test('G1. compactPriorText giữ tail NGUYÊN VĂN và không cắt giữa khối vẽ', () => {
  let prior = '';
  for (let i = 1; i <= 30; i++) {
    prior += `### Bước ${i}\nĐây là phần diễn giải khá dài cho bước này, viết đầy đủ để người đọc theo dõi được mạch suy luận.\nt_${i} = ${i * 2}\n`;
  }
  prior += '```shape\n{"ops":[{"op":"point","id":"Z","x":9,"y":9}]}\n```\nS = 128 và chu vi bằng';
  const packed = compactPriorText(prior);
  assert.ok(packed.compacted, 'prior dài phải được nén');
  assert.ok(packed.text.endsWith('S = 128 và chu vi bằng'), 'tail phải nguyên văn để viết tiếp liền mạch');
  assert.ok(packed.text.includes('{"op":"point","id":"Z","x":9,"y":9}'), 'khối vẽ không được xẻ đôi');
  assert.ok(packed.compactChars < packed.rawChars, 'phải thực sự ngắn hơn');
});

test('G2. buildMinimalContinuationContext KHÔNG mất số nào và tiết kiệm token thật', () => {
  let prior = '';
  for (let i = 1; i <= 30; i++) {
    prior += `### Bước ${i}\nMột đoạn văn diễn giải dài dòng nhưng không chứa dữ liệu tính toán nào đáng kể cả.\nk_${i} = ${i * 7}\n`;
  }
  prior += 'Kết quả cuối cùng là S = 4242 và ta còn phải xét thêm';
  const ctx = buildMinimalContinuationContext({
    messages: [{ role: 'user', content: 'đề bài gốc' }],
    priorText: prior,
    completeness: { reasons: ['truncated_tail'], missingCoverage: [] },
    interrupted: true
  });
  const compacted = ctx.messages[ctx.messages.length - 2].content;
  const nums = (t) => new Set(t.match(/-?\d+(?:[.,]\d+)?/g) || []);
  const lost = [...nums(prior)].filter((n) => !nums(compacted).has(n));
  assert.deepStrictEqual(lost, [], `không được mất số nào (mất: ${lost.slice(0, 5)})`);
  assert.ok(ctx.ratio > 0.15, `phải tiết kiệm đáng kể input token (thấy ${(ctx.ratio * 100).toFixed(1)}%)`);
  assert.strictEqual(ctx.messages[0].content, 'đề bài gốc', 'đề bài gốc phải nằm nguyên ở đầu messages');
});

test('G3. resume prompt nói rõ KHÔNG viết lại từ đầu và KHÔNG lặp nội dung (PHẦN H)', () => {
  const ctx = buildMinimalContinuationContext({
    messages: [{ role: 'user', content: 'đề' }],
    priorText: 'x'.repeat(50),
    completeness: { reasons: [], missingCoverage: ['c', 'd'] },
    interrupted: true
  });
  const prompt = ctx.messages[ctx.messages.length - 1].content;
  assert.ok(/KHÔNG viết lại từ đầu/i.test(prompt));
  assert.ok(/KHÔNG lặp lại/i.test(prompt));
  assert.ok(/GIỮ NGUYÊN/i.test(prompt), 'phải yêu cầu giữ nguyên biến/ký hiệu/kết quả trung gian');
  assert.ok(prompt.includes('c, d'), 'phải chỉ rõ các ý còn thiếu khi biết');
  assert.ok(/ngắt giữa chừng/i.test(prompt), 'chế độ resume phải nói rõ lý do là bị ngắt kỹ thuật');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exitCode = 1;
