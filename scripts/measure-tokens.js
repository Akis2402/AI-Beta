'use strict';

// ============================================================================================
// PHẦN T — ĐO PERFORMANCE / COST THẬT (before vs after)
// ============================================================================================
// Chạy: node scripts/measure-tokens.js
//
// Script này KHÔNG gọi AI. Nó dựng lại ĐÚNG payload mà chat.js gửi tới provider trong 2 cấu hình:
//   BEFORE = pipeline cũ  (history không nén tầng, system prompt thô, continuation gửi lại NGUYÊN
//            VĂN toàn bộ answer cũ — tức appendContinuationTurn)
//   AFTER  = pipeline mới (semanticCompressContext + compressSystemPrompt +
//            buildMinimalContinuationContext)
// rồi đếm token bằng CÙNG 1 hàm ước lượng (adaptiveBudget.estimateTokens) để so sánh công bằng.

const { estimateTokens } = require('../server/utils/adaptiveBudget');
const cc = require('../server/utils/contextCompressor');
const { appendContinuationTurn, buildMinimalContinuationContext } = require('../server/utils/continuation');
const { buildChatSystemPrompt } = require('../server/utils/promptBuilder');
const { buildCitationIndex } = require('../server/utils/citationIndex');
const { calculateAdaptiveBudget } = require('../server/utils/adaptiveBudget');

function makeHistory(pairs) {
  const out = [];
  for (let i = 0; i < pairs; i++) {
    out.push({ role: 'user', content: `Bài ${i}: cho tam giác ABC vuông tại A, AB = ${3 + i} cm, AC = 4 cm. Tính diện tích tam giác.` });
    out.push({
      role: 'assistant',
      content: [
        'Trước khi bắt tay vào tính toán, ta cần đọc lại thật kỹ toàn bộ dữ kiện của bài toán và xác định rõ mình đang phải tìm cái gì để tránh nhầm lẫn.',
        `AB = ${3 + i} cm, AC = 4 cm`,
        'Công thức tính diện tích tam giác vuông là nửa tích hai cạnh góc vuông, đây là kiến thức nền tảng mà mọi học sinh đều cần ghi nhớ cho thật chắc chắn.',
        `Vậy S = ${(3 + i) * 4 / 2} cm²`
      ].join('\n')
    });
  }
  return out;
}

function makeLongAnswer(steps) {
  let t = '## Lời giải chi tiết\n';
  for (let i = 1; i <= steps; i++) {
    t += `### Bước ${i}\n`;
    t += 'Ở bước này ta phân tích cấu hình hình học và giải thích cặn kẽ lý do chọn cách biến đổi đại số như vậy cho người đọc dễ theo dõi mạch suy luận.\n';
    t += `x_${i} = ${i * 3} cm\n`;
  }
  t += '```shape\n{"ops":[{"op":"point","id":"A","x":0,"y":0},{"op":"point","id":"B","x":3,"y":0}]}\n```\n';
  t += 'Cuối cùng ta tổng hợp lại toàn bộ các kết quả trung gian đã tính được ở trên để đưa ra đáp số.\nS = 42 cm² và chu vi bằng';
  return t;
}

const SCENARIOS = [
  { name: 'MICRO  (câu hỏi ngắn, không history)', pairs: 0, problem: 'Tính 12 x 8.' },
  { name: 'SHORT  (history nhẹ)', pairs: 3, problem: 'Giải phương trình 2x + 5 = 13.' },
  { name: 'STANDARD (history trung bình)', pairs: 10, problem: 'Cho tam giác ABC vuông tại A, AB = 6 cm, AC = 8 cm. a) Tính BC. b) Tính diện tích.' },
  { name: 'COMPLEX (history dài)', pairs: 25, problem: 'Cho hàm số y = x^3 - 3x + 2. a) Khảo sát. b) Cực trị. c) Tiếp tuyến tại x = 1. d) Biện luận số nghiệm theo m.' },
  { name: 'VERY_COMPLEX (history rất dài)', pairs: 45, problem: 'Cho hình chóp S.ABCD, SA vuông góc đáy, SA = 2a, đáy hình vuông cạnh a. a) Tính thể tích. b) Khoảng cách từ A tới (SBD). c) Góc giữa SC và đáy. d) Diện tích thiết diện. e) Bán kính mặt cầu ngoại tiếp.' }
];

const baseInput = {
  settings: { lang: 'vi', detail: 'full', school: '', grade: '' },
  contexts: [], rules: [], stage: 'detail', deepThinking: true, crossCheck: false,
  approachText: '', subjectId: 'math'
};

console.log('\n============================================================');
console.log('PHẦN T — INPUT TOKEN: BEFORE vs AFTER (lượt gọi ĐẦU TIÊN)');
console.log('============================================================\n');
console.log('scenario                              | before | after  | giảm    | mục tiêu');
console.log('--------------------------------------+--------+--------+---------+---------');

const firstTurnRows = [];
for (const sc of SCENARIOS) {
  const history = makeHistory(sc.pairs);
  const systemRaw = buildChatSystemPrompt({ ...baseInput, problemText: sc.problem });
  const systemPack = cc.compressSystemPrompt(systemRaw);

  const beforeTokens = estimateTokens(systemRaw) + estimateTokens(sc.problem)
    + history.reduce((s, h) => s + estimateTokens(h.content), 0);

  const items = cc.assignTiers(history);
  const rawTotal = estimateTokens(systemPack.rawTokens ? systemRaw : '') + estimateTokens(sc.problem)
    + items.reduce((s, it) => s + estimateTokens(it.text), 0);
  const res = cc.semanticCompressContext({ items, problemText: sc.problem, totalInputTokens: rawTotal });

  const afterTokens = estimateTokens(systemPack.text) + estimateTokens(sc.problem)
    + res.items.reduce((s, it) => s + estimateTokens(it.text), 0);

  const pct = beforeTokens > 0 ? (1 - afterTokens / beforeTokens) * 100 : 0;
  firstTurnRows.push({ name: sc.name, beforeTokens, afterTokens, pct, target: res.stats.targetRatio });
  console.log(
    sc.name.padEnd(37) + ' | ' +
    String(beforeTokens).padStart(6) + ' | ' +
    String(afterTokens).padStart(6) + ' | ' +
    (pct.toFixed(1) + '%').padStart(7) + ' | ' +
    (res.stats.targetRatio ? (res.stats.targetRatio * 100).toFixed(0) + '%' : 'không nén')
  );
}

console.log('\n============================================================');
console.log('PHẦN T — INPUT TOKEN của LƯỢT CONTINUATION (nơi lãng phí lớn nhất)');
console.log('============================================================\n');
console.log('độ dài answer đã sinh | before | after  | giảm');
console.log('----------------------+--------+--------+-------');

const contRows = [];
for (const steps of [10, 25, 50, 80]) {
  const prior = makeLongAnswer(steps);
  const messages = [{ role: 'user', content: 'đề bài gốc ở đây' }];
  const completeness = { reasons: ['truncated_tail'], missingCoverage: [], hardReasons: ['truncated_tail'] };

  const beforeMsgs = appendContinuationTurn(messages, prior, completeness);
  const beforeTokens = beforeMsgs.reduce((s, m) => s + estimateTokens(typeof m.content === 'string' ? m.content : ''), 0);

  const afterCtx = buildMinimalContinuationContext({ messages, priorText: prior, completeness, interrupted: true });
  const afterTokens = afterCtx.messages.reduce((s, m) => s + estimateTokens(typeof m.content === 'string' ? m.content : ''), 0);

  const pct = (1 - afterTokens / beforeTokens) * 100;
  contRows.push({ steps, beforeTokens, afterTokens, pct });
  console.log(
    (steps + ' bước').padEnd(21) + ' | ' +
    String(beforeTokens).padStart(6) + ' | ' +
    String(afterTokens).padStart(6) + ' | ' +
    (pct.toFixed(1) + '%').padStart(6)
  );

  // Kiểm chứng an toàn: không mất số nào.
  const compacted = afterCtx.messages[afterCtx.messages.length - 2].content;
  const nums = (t) => new Set(t.match(/-?\d+(?:[.,]\d+)?/g) || []);
  const lost = [...nums(prior)].filter((n) => !nums(compacted).has(n));
  if (lost.length) {
    console.log(`   !! CẢNH BÁO: mất ${lost.length} số — quality gate phải chặn trường hợp này`);
    process.exitCode = 1;
  }
}

// ============================================================================================
// VẤN ĐỀ #1 + #2 — request CÓ NGUỒN: dedupe đoạn trùng + nén boilerplate trong đoạn trích
// ============================================================================================
console.log('\n============================================================');
console.log('VẤN ĐỀ #1+#2 — INPUT TOKEN của request CÓ ĐOẠN TRÍCH NGUỒN');
console.log('============================================================\n');
console.log('số đoạn nguồn | before | after  | giảm   | đoạn gộp | dòng boilerplate bỏ');
console.log('--------------+--------+--------+--------+----------+--------------------');

function makeSourceContexts(n, dupEvery) {
  const header = 'Tài liệu ôn tập Toán — Trường THPT chuyên Lê Quý Đôn';
  const footer = 'Bản quyền tổ Toán, lưu hành nội bộ, không phát tán';
  const bodies = [
    'Chu vi hình tròn bằng hai pi nhân bán kính, còn diện tích bằng pi nhân bình phương bán kính.',
    'Định lý Pytago phát biểu rằng trong tam giác vuông, bình phương cạnh huyền bằng tổng bình phương hai cạnh góc vuông.',
    'Công thức Heron cho phép tính diện tích tam giác khi biết độ dài ba cạnh và nửa chu vi của nó.',
    'Định lý cosin tổng quát hoá định lý Pytago cho tam giác bất kỳ, dùng để tính cạnh khi biết hai cạnh và góc xen giữa.'
  ];
  const first = `${header}\n${footer}\n${bodies[0]}\nGiá trị tham chiếu R_1 = 4 cm`;
  return Array.from({ length: n }, (_, i) => {
    // Cứ dupEvery đoạn lại có 1 đoạn TRÙNG HOÀN TOÀN đoạn đầu — mô phỏng đúng tình huống thực tế
    // hay gặp: client cắt excerpt chồng lấn, hoặc cùng 1 định lý xuất hiện ở 2 tài liệu khác nhau.
    if (i > 0 && dupEvery && i % dupEvery === 0) return { doc: 'ThamKhao', id: i + 1, text: first };
    return {
      doc: 'OnTap', id: i + 1,
      text: `${header}\n${footer}\n${bodies[i % bodies.length]}\nGiá trị tham chiếu R_${i + 1} = ${(i + 1) * 4} cm`
    };
  });
}

for (const n of [4, 8, 16]) {
  const raw = makeSourceContexts(n, 3);
  const rawTokens = raw.reduce((s2, c) => s2 + estimateTokens(c.text), 0);
  const idx = buildCitationIndex(raw);
  const packed = cc.compressSourceExcerpts(idx.effectiveContexts);
  const afterTokens = packed.contexts.reduce((s2, c) => s2 + estimateTokens(c.text), 0);
  const pct = (1 - afterTokens / rawTokens) * 100;
  console.log(
    String(n).padEnd(13) + ' | ' + String(rawTokens).padStart(6) + ' | ' + String(afterTokens).padStart(6) +
    ' | ' + (pct.toFixed(1) + '%').padStart(6) + ' | ' + String(idx.duplicatesMerged).padStart(8) +
    ' | ' + String(packed.droppedBoilerplateLines).padStart(19)
  );
  // an toàn: không mất số nào, citeNo không đổi
  const nums = (t) => new Set(t.match(/-?\d+(?:[.,]\d+)?/g) || []);
  const before = idx.effectiveContexts.map((c) => c.text).join('\n');
  const after = packed.contexts.map((c) => c.text).join('\n');
  const lost = [...nums(before)].filter((x) => !nums(after).has(x));
  if (lost.length) { console.log('   !! mất số:', lost.slice(0, 5)); process.exitCode = 1; }
  const noChanged = packed.contexts.some((c, i) => c.citeNo !== idx.effectiveContexts[i].citeNo);
  if (noChanged) { console.log('   !! citeNo bị đổi khi nén nội dung'); process.exitCode = 1; }
}

console.log('\n============================================================');
console.log('PHẦN E — OUTPUT BUDGET KHÔNG bị giảm vì input được nén');
console.log('============================================================\n');
for (const sc of SCENARIOS.slice(2)) {
  const history = makeHistory(sc.pairs);
  const historyText = history.map((h) => h.content).join('\n');
  const items = cc.assignTiers(history);
  const res = cc.semanticCompressContext({ items, problemText: sc.problem, totalInputTokens: 9000 });
  const compressedHistoryText = res.items.map((i) => i.text).join('\n');

  const budgetBefore = calculateAdaptiveBudget({ stage: 'detail', problemText: sc.problem, historyText, deepThinking: true, remainingMs: 60000 });
  const budgetAfter = calculateAdaptiveBudget({ stage: 'detail', problemText: sc.problem, historyText: compressedHistoryText, deepThinking: true, remainingMs: 60000 });
  const ok = budgetAfter.target >= budgetBefore.target;
  console.log(`${sc.name.padEnd(37)} | output target before=${budgetBefore.target} after=${budgetAfter.target} ${ok ? '-> OK (không giảm)' : '-> LỖI: budget bị giảm!'}`);
  if (!ok) process.exitCode = 1;
}

console.log('\n============================================================');
console.log('TỔNG HỢP');
console.log('============================================================\n');
const inScope = firstTurnRows.filter((r) => r.target > 0);
if (inScope.length) {
  const avg = inScope.reduce((s, r) => s + r.pct, 0) / inScope.length;
  const min = Math.min(...inScope.map((r) => r.pct));
  const max = Math.max(...inScope.map((r) => r.pct));
  console.log(`Lượt đầu (request CÓ ngữ cảnh dư): giảm trung bình ${avg.toFixed(1)}% (thấp nhất ${min.toFixed(1)}%, cao nhất ${max.toFixed(1)}%)`);
}
const outScope = firstTurnRows.filter((r) => r.target === 0);
console.log(`Request ngữ cảnh nhẹ (${outScope.length} scenario): giảm ${outScope.map((r) => r.pct.toFixed(1) + '%').join(', ')} — cố ý KHÔNG nén`);
const avgCont = contRows.reduce((s, r) => s + r.pct, 0) / contRows.length;
console.log(`Lượt continuation: giảm trung bình ${avgCont.toFixed(1)}% input token (đây là nguồn lãng phí lớn nhất của bản cũ)`);
console.log('');
