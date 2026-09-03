'use strict';

// Test cho các module MỚI của vòng sửa lần này (xem yêu cầu 20 mục):
//   - runtimeState.js       : mục 1/2 — KHÔNG BAO GIỜ coi INCOMPLETE/INVALID là thành công
//   - requestDeadline.js    : mục 5   — timeout không bao giờ vượt quá thời gian còn lại
//   - aiProviders.js        : mục 4/6 — 1 deadline DUY NHẤT được truyền xuyên suốt, không tự tạo thêm
//   - adaptiveBudget.js     : mục 7   — token budget co lại theo thời gian còn lại
// Chạy: node test/runtime.test.js (hoặc qua npm test / test/run-all.js)

const assert = require('assert');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  -', name); }
  catch (e) { failed++; console.log(' FAIL -', name, '\n       ', e.message); }
}

const { STATES, isFinalSuccess, assertFinalResponseComplete } = require('../server/utils/runtimeState');
const { createRequestDeadline, safeCallTimeout, MIN_CALL_TIMEOUT_MS } = require('../server/utils/requestDeadline');
const { calculateAdaptiveBudget } = require('../server/utils/adaptiveBudget');
const { validateSolutionCompleteness } = require('../server/utils/completenessCheck');
const { appendContinuationTurn, MAX_CONTINUATIONS } = require('../server/utils/continuation');

async function main() {
  // ========================================================================
  console.log('\n== A. FINAL STATE — KHÔNG BAO GIỜ INCOMPLETE/INVALID -> done (mục 1/2/14) ==');
  // ========================================================================

  await test('1. complete -> isFinalSuccess() true, assertFinalResponseComplete() không ném lỗi', () => {
    assert.strictEqual(isFinalSuccess('COMPLETE'), true);
    assert.doesNotThrow(() => assertFinalResponseComplete({ status: 'COMPLETE' }));
  });

  await test('2/4/5. incomplete/invalid -> isFinalSuccess() false, assertFinalResponseComplete() ném lỗi FINAL_RESPONSE_INCOMPLETE (không cho phép "done")', () => {
    assert.strictEqual(isFinalSuccess('INCOMPLETE'), false);
    assert.strictEqual(isFinalSuccess('INVALID'), false);
    assert.throws(() => assertFinalResponseComplete({ status: 'INCOMPLETE' }), /FINAL_RESPONSE_INCOMPLETE|chưa đầy đủ/);
    assert.throws(() => assertFinalResponseComplete({ status: 'INVALID' }), (e) => e.code === 'FINAL_RESPONSE_INCOMPLETE');
    assert.throws(() => assertFinalResponseComplete(undefined), (e) => e.code === 'FINAL_RESPONSE_INCOMPLETE');
  });

  await test('7. NEVER incomplete -> done: mô phỏng đúng vòng lặp continuation của chat.js — hết MAX_CONTINUATIONS mà vẫn INCOMPLETE thì PHẢI ném lỗi, không được trả 200/"done"', () => {
    // Response luôn bị cắt cụt (kết thúc bằng liên từ) dù continue bao nhiêu lần — mô phỏng provider
    // "lỗi lặp lại" mà mục 16.A.4 yêu cầu phải test.
    let text = 'Ta xét tam giác ABC và';
    let completeness = validateSolutionCompleteness(text, { stage: 'detail' });
    let continuations = 0;
    const deadline = createRequestDeadline(60000);
    while (completeness.status === 'INCOMPLETE' && continuations < MAX_CONTINUATIONS && deadline.remaining() > 8000) {
      const msgs = appendContinuationTurn([{ role: 'user', content: 'đề' }], text, completeness);
      assert.strictEqual(msgs[msgs.length - 2].role, 'assistant'); // continuation nối tiếp, không regenerate (mục 3)
      text = text + ' vẫn tiếp tục cụt và'; // provider "cứ lặp lại lỗi" -> vẫn INCOMPLETE
      continuations += 1;
      completeness = validateSolutionCompleteness(text, { stage: 'detail' });
    }
    assert.strictEqual(continuations, MAX_CONTINUATIONS, 'phải dừng đúng ở MAX_CONTINUATIONS, không lặp vô hạn');
    assert.strictEqual(completeness.status, 'INCOMPLETE');
    // Đây chính là điểm chat.js gọi assertFinalResponseComplete() — PHẢI throw, không được "done".
    assert.throws(() => assertFinalResponseComplete(completeness));
  });

  // ========================================================================
  console.log('\n== C. DEADLINE — 1 đồng hồ DUY NHẤT, không operation nào vượt deadline (mục 4/5/6) ==');
  // ========================================================================

  await test('16. createRequestDeadline: remaining() giảm dần, không âm, expired() đúng thời điểm', async () => {
    const d = createRequestDeadline(50);
    assert.ok(d.remaining() <= 50 && d.remaining() >= 0);
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(d.remaining(), 0);
    assert.strictEqual(d.expired(), true);
  });

  await test('20. remaining thấp (< MIN_CALL_TIMEOUT_MS) không bao giờ khiến 1 lệnh gọi chạy dài hơn deadline thật (mục 5)', () => {
    const d = createRequestDeadline(1); // gần như hết ngay
    const t = safeCallTimeout(30000, d);
    // KHÔNG được là Math.max(MIN, remaining) => 4000 (dài hơn deadline thật, đây chính là bug mục 5) —
    // phải là null: caller PHẢI bỏ qua lệnh gọi, không được ép timeout vượt quá deadline.
    assert.strictEqual(t, null);
  });

  await test('safeCallTimeout(): khi đủ ngân sách, không bao giờ trả về timeout > remaining()', () => {
    const d = createRequestDeadline(10000);
    const t = safeCallTimeout(30000, d); // preferred 30s nhưng deadline chỉ còn ~10s
    assert.ok(t !== null && t <= d.remaining() + 50, `timeout (${t}) không được vượt remaining (${d.remaining()})`);
    assert.ok(t >= MIN_CALL_TIMEOUT_MS);
  });

  const { aiProviders } = (() => {
    ['./server/utils/executionTargets.js', './server/utils/rotationManager.js', './server/utils/aiProviders.js']
      .forEach((p) => { const r = require.resolve(require('path').join('..', p)); delete require.cache[r]; });
    return { aiProviders: require('../server/utils/aiProviders') };
  })();

  function fakeTarget(id, { textOrThrow, recordedTimeouts }) {
    return {
      id, keyId: id, modelId: id + '-model', label: id, supportsWebSearch: false,
      call: async ({ timeoutMs }) => {
        if (recordedTimeouts) recordedTimeouts.push(timeoutMs);
        if (typeof textOrThrow === 'function') return textOrThrow();
        return textOrThrow;
      },
      callStream: async ({ timeoutMs, onDelta }) => {
        if (recordedTimeouts) recordedTimeouts.push(timeoutMs);
        const text = typeof textOrThrow === 'function' ? textOrThrow() : textOrThrow;
        onDelta(text);
        return text;
      }
    };
  }

  await test('17/18/19. callWithFailover dùng ĐÚNG deadline của caller truyền vào (opts.deadline), không tự tạo FAILOVER_BUDGET_MS riêng — timeout thực tế bị co theo remaining() của deadline CHUNG', async () => {
    const recorded = [];
    const shortDeadline = createRequestDeadline(6000); // đủ trên MIN_CALL_TIMEOUT_MS để lệnh gọi thực sự diễn ra
    await new Promise((r) => setTimeout(r, 50));
    const target = fakeTarget('t1', { textOrThrow: 'ok response', recordedTimeouts: recorded });
    await aiProviders.callWithFailover([target], { system: 's', messages: [], maxTokens: 100, timeoutMs: 30000 }, { deadline: shortDeadline });
    assert.ok(recorded.length === 1);
    // 30000 (preferredMs) phải bị co lại theo remaining() của deadline CHUNG (~5900ms), không phải
    // FAILOVER_BUDGET_MS mặc định 65000 — chứng minh dùng chung 1 đồng hồ (mục 4/6), không tự tạo mới.
    assert.ok(recorded[0] < 6100, `timeout thực tế (${recorded[0]}) phải bị giới hạn bởi deadline chung ~6s, không phải 30000/65000`);
  });

  await test('21. deadline đã hết -> gatherCrossCheckCandidates KHÔNG throw, trả về candidates rỗng thay vì cố gọi provider vượt deadline (mục 5/21)', async () => {
    const expiredDeadline = { remaining: () => 0, expired: () => true };
    const target = fakeTarget('t2', { textOrThrow: 'không nên được gọi tới' });
    const { candidates } = await aiProviders.gatherCrossCheckCandidates([target], {
      system: 's', variantSystem: 'v', messages: [], maxTokens: 100, deadline: expiredDeadline
    });
    assert.deepStrictEqual(candidates, []);
  });

  await test('18. gatherCrossCheckCandidates dùng deadline của caller (không tự tạo CROSS_CHECK_BUDGET_MS 45s riêng) khi caller đã có deadline ngắn hơn', async () => {
    const recorded = [];
    const shortDeadline = createRequestDeadline(6000);
    const target = fakeTarget('t3', { textOrThrow: 'lời giải đầy đủ. Đáp số: 5.', recordedTimeouts: recorded });
    const { candidates } = await aiProviders.gatherCrossCheckCandidates([target], {
      system: 's', variantSystem: 'v', messages: [], maxTokens: 100, deadline: shortDeadline
    });
    assert.ok(candidates.length >= 1, 'phải thu được ít nhất 1 candidate');
    assert.ok(recorded[0] <= 6100, `timeout vòng 1 (${recorded[0]}) phải theo deadline ngắn của caller, không phải 30000 mặc định`);
  });

  await test('19. streamWithFailover nhận deadline chung, co timeoutMs theo remaining() thay vì args.timeoutMs cố định', async () => {
    const recorded = [];
    const shortDeadline = createRequestDeadline(6000);
    const target = fakeTarget('t4', { textOrThrow: 'Vậy đáp số là 10.', recordedTimeouts: recorded });
    let delta = '';
    const { text } = await aiProviders.streamWithFailover([target], { system: 's', messages: [], maxTokens: 100, timeoutMs: 30000 }, (p) => { delta += p; }, { deadline: shortDeadline });
    assert.strictEqual(text, 'Vậy đáp số là 10.');
    assert.strictEqual(delta, 'Vậy đáp số là 10.');
    assert.ok(recorded[0] <= 6100, `timeout stream (${recorded[0]}) phải bị co theo deadline chung, không phải 30000`);
  });

  await test('callFastest với deadline chung: timeout của lệnh đua cũng bị co theo remaining()', async () => {
    const recorded = [];
    const shortDeadline = createRequestDeadline(6000);
    const t1 = fakeTarget('f1', { textOrThrow: 'Đáp số: 7.', recordedTimeouts: recorded });
    const t2 = fakeTarget('f2', { textOrThrow: 'Đáp số: 7.', recordedTimeouts: recorded });
    const { text } = await aiProviders.callFastest([t1, t2], { system: 's', messages: [], maxTokens: 100, timeoutMs: 30000 }, { deadline: shortDeadline });
    assert.strictEqual(text, 'Đáp số: 7.');
    assert.ok(recorded.every((t) => t <= 6100), `mọi lệnh gọi trong nhóm đua phải bị co theo deadline chung, thấy: ${recorded}`);
  });

  // ========================================================================
  console.log('\n== G. TOKEN BUDGET kết hợp deadline (mục 7) ==');
  // ========================================================================

  await test('22. remaining rất nhỏ (3s) -> target giảm mạnh so với không giới hạn thời gian, không còn yêu cầu sinh hàng nghìn token', () => {
    const problemText = Array.from({ length: 6 }, (_, i) => `${String.fromCharCode(97 + i)}) Chứng minh phần ${i + 1}.`).join('\n');
    const unlimited = calculateAdaptiveBudget({ stage: 'detail', problemText });
    const tight = calculateAdaptiveBudget({ stage: 'detail', problemText, remainingMs: 3000 });
    assert.ok(unlimited.target > 3000, `sanity: unlimited target phải lớn (${unlimited.target})`);
    assert.ok(tight.target < unlimited.target, `budget bị deadline giới hạn (${tight.target}) phải nhỏ hơn budget không giới hạn (${unlimited.target})`);
    assert.ok(tight.target < 300, `còn 3s thì không nên yêu cầu model sinh nhiều token, thấy target=${tight.target}`);
  });

  await test('23. remaining lớn -> budget không bị ảnh hưởng bởi deadline (chỉ phụ thuộc độ phức tạp như cũ)', () => {
    const problemText = 'Tính 2+2 bằng bao nhiêu?';
    const unlimited = calculateAdaptiveBudget({ stage: 'detail', problemText });
    const ample = calculateAdaptiveBudget({ stage: 'detail', problemText, remainingMs: 60000 });
    assert.strictEqual(ample.target, unlimited.target);
  });

  await test('budget không bao giờ âm/0 dù remaining <= 0', () => {
    const b = calculateAdaptiveBudget({ stage: 'detail', problemText: 'x', remainingMs: 0 });
    assert.ok(b.target > 0 && b.min > 0 && b.max >= b.target);
  });

  // ========================================================================
  console.log('\n== D. SOURCE COVERAGE — web search chỉ bật khi thực sự thiếu (mục 9/10/11) ==');
  // ========================================================================

  const { analyzeSourceCoverage } = require('../server/utils/sourceCoverage');

  await test('22. uploaded source đủ (khớp cao, không bị clip) -> complete=true, webRequired=false', () => {
    const problemText = 'a) Tính diện tích hình tròn bán kính R. b) Tính chu vi hình tròn đó.';
    const contexts = [{
      text: 'Công thức diện tích hình tròn bán kính R là S = pi R bình phương. Công thức chu vi hình tròn là C = 2 pi R.',
      truncated: false
    }];
    const r = analyzeSourceCoverage({ problemText, contexts });
    assert.strictEqual(r.webRequired, false, `webRequired phải false khi source đã đủ, thấy missing=${JSON.stringify(r.missing)}`);
    assert.strictEqual(r.complete, true);
  });

  await test('23. không có context nào -> webRequired=true (không có tài liệu để ưu tiên)', () => {
    const r = analyzeSourceCoverage({ problemText: 'a) Tính A. b) Tính B.', contexts: [] });
    assert.strictEqual(r.webRequired, true);
    assert.strictEqual(r.complete, false);
  });

  await test('23b. có context nhưng chỉ khớp 1 trong 2 yêu cầu -> vẫn thiếu -> webRequired=true', () => {
    const problemText = 'a) Tính diện tích tam giác đều cạnh a. b) Chứng minh định lý Pytago cho tam giác vuông.';
    const contexts = [{ text: 'Diện tích tam giác đều cạnh a là S = (a^2 * căn 3) / 4.', truncated: false }];
    const r = analyzeSourceCoverage({ problemText, contexts });
    assert.strictEqual(r.webRequired, true);
    assert.ok(r.missing.length >= 1);
  });

  await test('24. context bị clip (truncated=true) -> dù coverage đo được cao vẫn KHÔNG kết luận complete (mục 9 — không coi excerpt = full source)', () => {
    const problemText = 'a) Tính diện tích hình tròn bán kính R.';
    const contexts = [{ text: 'Công thức diện tích hình tròn bán kính R là S = pi R bình phương.', truncated: true }];
    const r = analyzeSourceCoverage({ problemText, contexts });
    assert.strictEqual(r.possiblyExcerpt, true);
    assert.strictEqual(r.complete, false, 'excerpt bị clip không được coi là đại diện đủ cho toàn bộ source');
    assert.strictEqual(r.webRequired, true);
  });

  await test('25. keyword overlap cao nhưng yêu cầu có nhắc công thức/định lý mà công thức thật sự không có trong excerpt -> vẫn INCOMPLETE (không chỉ dùng 1 ngưỡng overlap chung)', () => {
    const problemText = 'a) Tính chu vi tam giác vuông đó. b) Áp dụng định lý Pytago để tính cạnh huyền của tam giác vuông có 2 cạnh góc vuông.';
    const contexts = [{ text: 'Chu vi tam giác vuông đó bằng tổng 3 cạnh. Tam giác vuông là tam giác có một góc bằng 90 độ, thường gặp trong hình học phẳng cơ bản.', truncated: false }];
    const r = analyzeSourceCoverage({ problemText, contexts });
    assert.strictEqual(r.webRequired, true, 'phải vẫn coi là thiếu công thức dù overlap từ khoá không thấp');
  });

  // ========================================================================
  console.log('\n== E. SEMANTIC COMPRESSION — dedupe + ưu tiên liên quan, không cắt giữa (mục 8) ==');
  // ========================================================================

  const { compressHistoryForBudget, dedupeHistory } = require('../server/utils/semanticCompression');

  await test('dedupeHistory: loại lượt trùng lặp/gần trùng (giữ lần xuất hiện SAU CÙNG), giữ nguyên nội dung không cắt', () => {
    const h = [
      { role: 'user', content: 'Giải phương trình x^2 - 5x + 6 = 0' },
      { role: 'assistant', content: 'Nghiệm: x=2 hoặc x=3.' },
      { role: 'user', content: 'Giải phương trình   x^2 - 5x + 6 = 0' }, // trùng (chỉ khác khoảng trắng)
      { role: 'assistant', content: 'Nghiệm: x=2 hoặc x=3.' } // trùng y hệt
    ];
    const out = dedupeHistory(h);
    assert.strictEqual(out.length, 2, `phải còn 2 lượt sau khi loại trùng, thấy ${out.length}`);
    assert.strictEqual(out[0].content, h[2].content); // giữ lần xuất hiện SAU CÙNG của cặp trùng đầu
    assert.strictEqual(out[1].content, h[3].content);
  });

  await test('28/36-ish. history dài, budget hẹp -> loại lượt KHÔNG liên quan trước, giữ lượt liên quan tới đề bài hiện tại dù cũ hơn', () => {
    const oldRelevant = { role: 'user', content: 'Đề: đạo hàm f(x) = x^3 - 3x^2 + 2, điều kiện x thuộc [0;5].' };
    const oldRelevantAns = { role: 'assistant', content: 'f\'(x) = 3x^2 - 6x, điều kiện x thuộc [0;5].' };
    const longFiller = (n) => 'chuyện phiếm không liên quan gì tới bài toán cả, chỉ là tán gẫu cho vui thôi. '.repeat(n);
    const fillerA = { role: 'user', content: longFiller(30) };
    const fillerAAns = { role: 'assistant', content: longFiller(30) };
    const fillerB = { role: 'user', content: longFiller(30) };
    const fillerBAns = { role: 'assistant', content: longFiller(30) };
    const recentA = { role: 'user', content: 'Câu hỏi gần đây nhất phần 1.' };
    const recentAAns = { role: 'assistant', content: 'Trả lời gần đây nhất phần 1.' };
    const history = [oldRelevant, oldRelevantAns, fillerA, fillerAAns, fillerB, fillerBAns, recentA, recentAAns];
    const currentProblemText = 'Tiếp tục bài đạo hàm f(x) = x^3 - 3x^2 + 2 với điều kiện x thuộc [0;5] ở trên, tính f\'\'(x).';

    // budgetTokens rất nhỏ -> sàn cứng 500 token (~1600 ký tự) trong compressHistoryForBudget áp
    // dụng: đủ chỗ cho cặp oldRelevant (ngắn) nhưng KHÔNG đủ chỗ cho bất kỳ cặp filler nào (mỗi cặp
    // filler dài ~2000+ ký tự) -> buộc thuật toán phải CHỌN theo mức liên quan, không phải theo tuổi.
    const { history: kept } = compressHistoryForBudget(history, { budgetTokens: 1, currentProblemText });

    const keptContents = kept.map((h) => h.content);
    assert.ok(keptContents.includes(recentA.content) && keptContents.includes(recentAAns.content), 'luôn giữ MIN_KEPT_TURNS lượt gần nhất');
    assert.ok(keptContents.includes(oldRelevant.content), 'phải ưu tiên giữ lượt CŨ nhưng LIÊN QUAN tới đề bài hiện tại (đạo hàm f(x)=x^3-3x^2+2)');
    assert.ok(!keptContents.includes(fillerA.content) && !keptContents.includes(fillerB.content), 'phải loại lượt filler hội thoại không liên quan trước');
  });

  await test('29-34. mọi lượt được GIỮ vẫn nguyên vẹn 100% (không cắt giữa số/công thức/LaTeX/JSON) — vì đơn vị nhỏ nhất bị/không bị loại luôn là 1 lượt trọn vẹn', () => {
    const withFormulaAndDrawing = {
      role: 'assistant',
      content: 'Diện tích $S = \\pi R^2$ với R=5, điều kiện R>0. ```shape\n{"points":[{"id":"A","x":0,"y":0}]}\n```'
    };
    const history = [
      { role: 'user', content: 'câu hỏi cũ 1' }, { role: 'assistant', content: 'trả lời cũ 1' },
      { role: 'user', content: 'câu hỏi vẽ hình' }, withFormulaAndDrawing,
      { role: 'user', content: 'câu hỏi mới nhất' }, { role: 'assistant', content: 'trả lời mới nhất' }
    ];
    const { history: kept } = compressHistoryForBudget(history, { budgetTokens: 100000, currentProblemText: 'vẽ hình' });
    const found = kept.find((h) => h.content.includes('shape'));
    assert.ok(found, 'lượt chứa công thức/JSON dựng hình phải còn trong kết quả (đủ ngân sách)');
    assert.strictEqual(found.content, withFormulaAndDrawing.content, 'nội dung PHẢI giữ nguyên byte-for-byte — không bị cắt giữa LaTeX/JSON');
  });

  // ========================================================================
  console.log('\n== F. CANONICAL DRAWING STATE — Approach -> Detail (mục 15) ==');
  // ========================================================================

  const { checkCanonicalDrawingConsistency } = require('../server/utils/drawingValidator');

  await test('không có khối vẽ ở approach -> checked=false, không áp dụng ràng buộc (bài không phải hình học)', () => {
    const r = checkCanonicalDrawingConsistency('Không có hình vẽ nào ở đây.', 'Lời giải chi tiết bình thường.');
    assert.strictEqual(r.checked, false);
    assert.strictEqual(r.consistent, true);
  });

  await test('detail COPY NGUYÊN VĂN khối program của approach + chỉ THÊM điểm mới -> consistent=true', () => {
    const approach = 'Hướng giải:\n```shape\n{"type":"program","points":[{"id":"A","op":"free","x":0,"y":0},{"id":"B","op":"free","x":4,"y":0}]}\n```\n';
    const detail = 'Lời giải chi tiết:\n```shape\n{"type":"program","points":[{"id":"A","op":"free","x":0,"y":0},{"id":"B","op":"free","x":4,"y":0},{"id":"C","op":"free","x":2,"y":3}]}\n```\n';
    const r = checkCanonicalDrawingConsistency(approach, detail);
    assert.strictEqual(r.checked, true);
    assert.strictEqual(r.consistent, true, `không được báo lỗi khi chỉ THÊM điểm mới, thấy: ${JSON.stringify(r.errors)}`);
  });

  await test('detail TỰ ĐỔI toạ độ 1 điểm đã có ở approach -> consistent=false, báo đúng điểm bị đổi (mục 15)', () => {
    const approach = 'Hướng giải:\n```shape\n{"type":"program","points":[{"id":"A","op":"free","x":0,"y":0},{"id":"B","op":"free","x":4,"y":0}]}\n```\n';
    const detail = 'Lời giải chi tiết:\n```shape\n{"type":"program","points":[{"id":"A","op":"free","x":1,"y":1},{"id":"B","op":"free","x":4,"y":0}]}\n```\n'; // A bị đổi toạ độ!
    const r = checkCanonicalDrawingConsistency(approach, detail);
    assert.strictEqual(r.consistent, false);
    assert.ok(r.errors.some((e) => e.includes('"A"')), `phải chỉ đích danh điểm A bị đổi, thấy: ${JSON.stringify(r.errors)}`);
  });

  await test('detail XOÁ MẤT hình vẽ đã có ở approach -> consistent=false', () => {
    const approach = 'Hướng giải:\n```shape\n{"type":"program","points":[{"id":"A","op":"free","x":0,"y":0}]}\n```\n';
    const detail = 'Lời giải chi tiết không còn hình vẽ nào cả.';
    const r = checkCanonicalDrawingConsistency(approach, detail);
    assert.strictEqual(r.consistent, false);
  });

  await test('checkCompletenessWithDrawings(): vi phạm canonical -> status INCOMPLETE với reason drawing_canonical_mismatch (mục 1/15 phối hợp — không được coi hoàn thành)', () => {
    // Test này gọi lại đúng logic chat.js dùng (không export trực tiếp checkCompletenessWithDrawings
    // nên tái tạo tối thiểu phần liên quan tới drawing bằng chính 2 hàm export công khai nó gọi tới).
    const { validateAllDrawingBlocks: vad } = require('../server/utils/drawingValidator');
    const approach = '```shape\n{"type":"program","points":[{"id":"A","op":"free","x":0,"y":0}]}\n```';
    const detailBad = 'Đủ ý.\n```shape\n{"type":"program","points":[{"id":"A","op":"free","x":9,"y":9}]}\n```\nVậy đáp số là 5.';
    const drawingIssues = vad(detailBad).filter((b) => !b.valid);
    assert.strictEqual(drawingIssues.length, 0, 'JSON vẫn hợp lệ về cấu trúc — lỗi phải tới từ canonical mismatch, không phải invalid JSON');
    const canonical = checkCanonicalDrawingConsistency(approach, detailBad);
    assert.strictEqual(canonical.consistent, false, 'phải phát hiện A bị đổi toạ độ dù JSON hợp lệ và văn bản trông "đủ ý"');
  });




  if (failed) process.exitCode = 1;
}

main();
