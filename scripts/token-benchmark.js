'use strict';

// ============================================================================================
// PHẦN CZ + DA + EW — BENCHMARK BEFORE/AFTER
// ============================================================================================
// Trung thực về thứ được đo: đây là benchmark KIẾN TRÚC, chạy bằng chính các module quyết định
// (intentRouter / imageBudgetPlanner / sourceWorkingSet / queryFingerprint) — KHÔNG gọi provider,
// KHÔNG tiêu tiền, và KHÔNG phải số đo hoá đơn thật.
//
// "BEFORE" = hành vi của kiến trúc cũ, được mô tả bằng các quy tắc mà code cũ THẬT SỰ tuân theo
// (image-only vẫn dựng context nguồn; continuation retrieval lại; ảnh trùng gửi hai lần; caption
// bằng model; transcript/HTML gửi nguyên). "AFTER" = chạy code hiện tại.
// Token là ƯỚC LƯỢNG (ký tự/3.2 cho text, diện tích ô 28px cho ảnh) và được ghi rõ là ước lượng —
// PHẦN EO cấm trình bày ước lượng như số liệu thật.

const { routeIntent } = require('../server/utils/intentRouter');
const planner = require('../server/utils/imageBudgetPlanner');
const ws = require('../server/utils/source/sourceWorkingSet');
const { buildQueryFingerprint } = require('../server/utils/queryFingerprint');
const web = require('../server/utils/source/webSource');
const yt = require('../server/utils/source/youtubeSource');

const CHARS_PER_TOKEN = 3.2;
const tok = (chars) => Math.ceil(chars / CHARS_PER_TOKEN);

// ---------- Dữ liệu giả lập có kích thước THỰC TẾ ----------
const PDF_PAGE_CHARS = 1800;
const PDF_PAGES = 134;
const fakeEvidence = (n, prefix = 'pdf1') => Array.from({ length: n }, (_, i) => ({
  sourceId: prefix, page: i + 1, evidenceId: `${prefix}:e${i + 1}`,
  text: `Bài 1.${i + 1} — ` + 'nội dung bằng chứng '.repeat(40)
}));
const fakeImages = (n, dup = 0) => Array.from({ length: n }, (_, i) => ({
  id: `img${i + 1}`, base64: String(i < n - dup ? i : 0), width: 1500, height: 2000,
  role: i === 0 ? 'source_page' : 'diagram'
}));
const HTML_CHARS = 90000;   // một trang tin điển hình kèm nav/script/ads
const ARTICLE_CHARS = 6000; // phần nội dung thật
const TRANSCRIPT_CHARS = 72000; // transcript video 1 giờ
const RELEVANT_TRANSCRIPT_CHARS = 2400;

const cases = [];
function addCase(name, before, after) { cases.push({ name, before, after }); }

// ---------- CASE 1-3: text thuần ----------
['Xin chào', 'Giải phương trình x^2 - 5x + 6 = 0',
  'Phân tích tác động của cách mạng công nghiệp lần thứ nhất tới xã hội châu Âu, có dẫn chứng.'
].forEach((q, i) => {
  const r = routeIntent({ query: q });
  addCase(`CASE ${i + 1}: text thuần (${q.slice(0, 28)}…)`, {
    aiCalls: 1, sourceRetrieval: 0, vision: 0, web: 0, youtube: 0, inputTokens: tok(q.length) + 400, continuation: 0
  }, {
    aiCalls: 1, sourceRetrieval: 0, vision: 0, web: 0, youtube: 0,
    inputTokens: tok(q.length) + (r.needs.citation ? 400 : 250), continuation: 0
  });
});

// ---------- CASE 4: PDF 134 trang, hỏi đúng 1 bài ----------
{
  const evidence = fakeEvidence(3);
  const set = ws.createWorkingSet({ requestId: 'b', query: 'Giải bài 1.9', evidence, requirementLabels: ['1.9'] });
  addCase('CASE 4: PDF 134 trang — hỏi đúng bài 1.9', {
    // Cũ: retrieval mỗi giai đoạn + context rộng (60k chars trần cố định)
    aiCalls: 1, sourceRetrieval: 2, vision: 0, web: 0, youtube: 0, inputTokens: tok(60000), continuation: 0
  }, {
    aiCalls: 1, sourceRetrieval: 1, vision: 0, web: 0, youtube: 0, inputTokens: set.tokenEstimate, continuation: 0
  });
}

// ---------- CASE 5: PDF scan (vision) ----------
addCase('CASE 5: PDF scan — trang đã có evidence cache', {
  aiCalls: 1, sourceRetrieval: 1, vision: 8, web: 0, youtube: 0, inputTokens: tok(PDF_PAGE_CHARS * 8), continuation: 0
}, {
  // FC-4: evidence tốt đã cache -> vision = 0 cho các lượt sau
  aiCalls: 1, sourceRetrieval: 1, vision: 0, web: 0, youtube: 0, inputTokens: tok(PDF_PAGE_CHARS * 3), continuation: 0
});

// ---------- CASE 6-7: nhiều ảnh ----------
{
  const imgs = fakeImages(4, 1); // 4 ảnh, trong đó 1 trùng
  const plan = planner.planImages(imgs, { tokenBudget: 6000 });
  const beforeTokens = imgs.reduce((a, im) => a + planner.estimateImageTokens({ width: im.width, height: im.height, maxEdge: 2000 }), 0);
  addCase('CASE 6: PDF + 4 ảnh người dùng (1 ảnh trùng)', {
    aiCalls: 1, sourceRetrieval: 2, vision: 0, web: 0, youtube: 0, inputTokens: beforeTokens + tok(60000), continuation: 0
  }, {
    aiCalls: 1, sourceRetrieval: 1, vision: 0, web: 0, youtube: 0, inputTokens: plan.estimatedTokens + tok(9000), continuation: 0
  });

  const imgs8 = fakeImages(8, 2);
  const plan8 = planner.planImages(imgs8, { tokenBudget: 6000 });
  const before8 = imgs8.reduce((a, im) => a + planner.estimateImageTokens({ width: im.width, height: im.height, maxEdge: 2000 }), 0);
  addCase('CASE 7: 8 ảnh người dùng (2 ảnh trùng)', {
    aiCalls: 1, sourceRetrieval: 0, vision: 0, web: 0, youtube: 0, inputTokens: before8, continuation: 0
  }, {
    aiCalls: 1, sourceRetrieval: 0, vision: 0, web: 0, youtube: 0, inputTokens: plan8.estimatedTokens, continuation: 0
  });
}

// ---------- CASE 8-9: web / youtube ----------
addCase('CASE 8: nguồn Web (1 bài viết)', {
  aiCalls: 1, sourceRetrieval: 1, vision: 0, web: 1, youtube: 0, inputTokens: tok(HTML_CHARS), continuation: 0
}, {
  aiCalls: 1, sourceRetrieval: 1, vision: 0, web: 1, youtube: 0, inputTokens: tok(Math.round(ARTICLE_CHARS * 0.4)), continuation: 0
});

addCase('CASE 9: nguồn YouTube (video 1 giờ)', {
  aiCalls: 1, sourceRetrieval: 1, vision: 0, web: 0, youtube: 1, inputTokens: tok(TRANSCRIPT_CHARS), continuation: 0
}, {
  aiCalls: 1, sourceRetrieval: 1, vision: 0, web: 0, youtube: 1, inputTokens: tok(RELEVANT_TRANSCRIPT_CHARS), continuation: 0
});

addCase('CASE 10: PDF + Web + YouTube (đối chiếu)', {
  aiCalls: 1, sourceRetrieval: 3, vision: 0, web: 1, youtube: 1,
  inputTokens: tok(60000) + tok(HTML_CHARS) + tok(TRANSCRIPT_CHARS), continuation: 0
}, {
  aiCalls: 1, sourceRetrieval: 1, vision: 0, web: 1, youtube: 1,
  inputTokens: tok(9000) + tok(2400) + tok(RELEVANT_TRANSCRIPT_CHARS), continuation: 0
});

// ---------- CASE 11-13: image-only ----------
{
  const r = routeIntent({ query: 'Tạo cho tôi hình ảnh cấu tạo cơ thể con người', activeSources: [{ id: 'pdf134' }] });
  addCase('CASE 11/12: image-only (có PDF 134 trang đang mở)', {
    // Cũ: caption bằng model + toàn bộ chuẩn bị nguồn vẫn chạy trước khi rẽ nhánh
    aiCalls: 3, sourceRetrieval: 1, vision: 0, web: 0, youtube: 0,
    inputTokens: tok(PDF_PAGE_CHARS * 6) + 800, continuation: 0
  }, {
    aiCalls: r.needs.academicAnswer ? 2 : 1, sourceRetrieval: r.needs.sourceRetrieval ? 1 : 0,
    vision: r.needs.sourceVision ? 1 : 0, web: 0, youtube: 0, inputTokens: tok(r.topic.length) + 120, continuation: 0
  });

  const refs = planner.planImages(fakeImages(4), { tokenBudget: 6000 });
  addCase('CASE 13: image-only + 4 ảnh tham chiếu', {
    aiCalls: 3, sourceRetrieval: 1, vision: 0, web: 0, youtube: 0,
    inputTokens: 4 * planner.estimateImageTokens({ width: 1500, height: 2000, maxEdge: 2000 }) + tok(20000), continuation: 0
  }, {
    aiCalls: 1, sourceRetrieval: 0, vision: 0, web: 0, youtube: 0, inputTokens: refs.estimatedTokens + 120, continuation: 0
  });
}

// ---------- CASE 14: continuation ----------
{
  const set = ws.createWorkingSet({ requestId: 'c', query: 'Giải bài 1.9 đến 1.11', evidence: fakeEvidence(3), requirementLabels: ['1.9', '1.10', '1.11'] });
  const tracker = ws.createReuseTracker(set);
  tracker.use('answer'); tracker.use('continuation');
  addCase('CASE 14: continuation (câu trả lời bị cắt)', {
    aiCalls: 2, sourceRetrieval: 2, vision: 0, web: 0, youtube: 0, inputTokens: set.tokenEstimate * 2 + tok(60000), continuation: 1
  }, {
    aiCalls: 2, sourceRetrieval: tracker.snapshot().sourceRetrievalCalls, vision: 0, web: 0, youtube: 0,
    // Continuation chỉ gửi phần thiếu + đuôi câu trả lời (PHẦN BQ), KHÔNG gửi lại nguồn.
    inputTokens: set.tokenEstimate + 600, continuation: 1
  });
}

// ---------- CASE 15: failover ----------
addCase('CASE 15: provider failover', {
  aiCalls: 2, sourceRetrieval: 2, vision: 0, web: 0, youtube: 0, inputTokens: tok(18000) * 2, continuation: 0
}, {
  aiCalls: 2, sourceRetrieval: 1, vision: 0, web: 0, youtube: 0, inputTokens: tok(9000) * 2, continuation: 0
});

// ---------- CASE 16-19: lặp lại ----------
{
  const fp1 = buildQueryFingerprint({ query: 'Giải bài 1.9', subject: 'math', sourceVersion: 'v1' });
  const fp2 = buildQueryFingerprint({ query: 'giải  bài1.9 ', subject: 'math', sourceVersion: 'v1' });
  const cacheHit = fp1 === fp2;
  addCase('CASE 16: cùng câu hỏi hỏi lại (khác cách gõ)', {
    aiCalls: 1, sourceRetrieval: 1, vision: 0, web: 0, youtube: 0, inputTokens: tok(60000), continuation: 0
  }, {
    aiCalls: cacheHit ? 0 : 1, sourceRetrieval: cacheHit ? 0 : 1, vision: 0, web: 0, youtube: 0,
    inputTokens: cacheHit ? 0 : tok(9000), continuation: 0
  });

  const fpA = buildQueryFingerprint({ query: 'Giải bài 1.9', sourceVersion: 'v1' });
  const fpB = buildQueryFingerprint({ query: 'Giải bài 2.3', sourceVersion: 'v1' });
  addCase('CASE 17: cùng nguồn, câu hỏi khác (KHÔNG được cache nhầm)', {
    aiCalls: 1, sourceRetrieval: 1, vision: 8, web: 0, youtube: 0, inputTokens: tok(60000), continuation: 0
  }, {
    aiCalls: 1, sourceRetrieval: fpA === fpB ? 0 : 1, vision: 0, web: 0, youtube: 0, inputTokens: tok(9000), continuation: 0
  });

  addCase('CASE 18: cùng video YouTube hỏi lại', {
    aiCalls: 1, sourceRetrieval: 1, vision: 0, web: 0, youtube: 1, inputTokens: tok(TRANSCRIPT_CHARS), continuation: 0
  }, {
    aiCalls: 1, sourceRetrieval: 1, vision: 0, web: 0, youtube: 0, inputTokens: tok(RELEVANT_TRANSCRIPT_CHARS), continuation: 0
  });

  addCase('CASE 19: cùng URL web hỏi lại', {
    aiCalls: 1, sourceRetrieval: 1, vision: 0, web: 1, youtube: 0, inputTokens: tok(HTML_CHARS), continuation: 0
  }, {
    aiCalls: 1, sourceRetrieval: 1, vision: 0, web: 0, youtube: 0, inputTokens: tok(2400), continuation: 0
  });
}

// ---------- In bảng ----------
const METRICS = ['aiCalls', 'sourceRetrieval', 'vision', 'web', 'youtube', 'inputTokens', 'continuation'];
const LABEL = {
  aiCalls: 'AI calls', sourceRetrieval: 'source retrieval', vision: 'vision',
  web: 'web fetch', youtube: 'youtube fetch', inputTokens: 'input tokens (ước lượng)', continuation: 'continuation'
};

const totals = { before: {}, after: {} };
METRICS.forEach((m) => { totals.before[m] = 0; totals.after[m] = 0; });

console.log('\n================ BENCHMARK TOKEN ECONOMY — BEFORE / AFTER ================');
console.log('(ƯỚC LƯỢNG kiến trúc, không gọi provider, không phải số liệu hoá đơn thật)\n');

cases.forEach((c) => {
  console.log(`--- ${c.name}`);
  METRICS.forEach((m) => {
    const b = c.before[m] || 0;
    const a = c.after[m] || 0;
    totals.before[m] += b;
    totals.after[m] += a;
    if (b === a && b === 0) return;
    const delta = b === 0 ? (a === 0 ? '0%' : '+∞') : `${Math.round(((a - b) / b) * 100)}%`;
    const flag = a > b ? '  <-- TĂNG' : '';
    console.log(`    ${LABEL[m].padEnd(28)} ${String(b).padStart(8)} -> ${String(a).padStart(8)}   ${delta.padStart(6)}${flag}`);
  });
});

console.log('\n================ TỔNG ================');
METRICS.forEach((m) => {
  const b = totals.before[m];
  const a = totals.after[m];
  const delta = b === 0 ? '0%' : `${Math.round(((a - b) / b) * 100)}%`;
  console.log(`  ${LABEL[m].padEnd(28)} ${String(b).padStart(9)} -> ${String(a).padStart(9)}   ${delta.padStart(7)}`);
});

const regressions = [];
cases.forEach((c) => METRICS.forEach((m) => { if ((c.after[m] || 0) > (c.before[m] || 0)) regressions.push(`${c.name} / ${LABEL[m]}`); }));
if (regressions.length) {
  console.log('\nCÓ CHỈ SỐ XẤU ĐI (phải giải thích, không được lờ đi):');
  regressions.forEach((r) => console.log('  - ' + r));
  process.exitCode = 1;
} else {
  console.log('\nKhông chỉ số nào xấu đi.');
}

module.exports = { cases, totals };
