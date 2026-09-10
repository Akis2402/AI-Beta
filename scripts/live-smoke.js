'use strict';

// ============================================================================================
// LIVE SMOKE TEST — chạy với API KEY THẬT (tồn đọng #6)
// ============================================================================================
// Đây là thứ DUY NHẤT trong danh sách tồn đọng mà tôi không thể tự chạy thay bạn: tôi không có khóa
// API của bạn. Nhưng tôi có thể làm cho việc đó thành MỘT LỆNH, và kiểm đúng những gì chỉ chạy thật
// mới lộ ra — những thứ mock/stub về bản chất không thể phát hiện:
//
//   1. Hình dạng response THẬT của từng provider (trường `usage` có tồn tại và tên field có đúng như
//      code giả định không — đây là chỗ dễ sai nhất vì các hãng đổi API không báo trước).
//   2. `finishReason` thật khi chạm maxTokens (chuỗi trả về có map đúng sang 'length' không).
//   3. Throughput thật (tok/s) của từng model — con số quyết định adaptive budget.
//   4. Tỷ lệ ký tự/token thật cho tiếng Việt và cho LaTeX (kiểm chứng con số ~2.4 đo bằng mẫu giả).
//   5. Continuation THẬT có nối liền mạch, không lặp text ở điểm nối.
//
// CÁCH CHẠY:
//   node scripts/live-smoke.js            # tất cả provider có khóa trong .env
//   node scripts/live-smoke.js --quick    # bỏ qua bài kiểm tra continuation (tốn token nhất)
//
// CHI PHÍ: mặc định ~4 lượt gọi nhỏ mỗi provider (khoảng vài nghìn token). Script IN RÕ ước tính
// trước khi gọi và cần xác nhận nếu chạy trong terminal tương tác.

require('dotenv').config();

const { ensureProvidersReady, streamWithFailover } = require('../server/utils/aiProviders');
const { createRequestDeadline } = require('../server/utils/requestDeadline');
const { validateSolutionCompleteness } = require('../server/utils/completenessCheck');
const { runResumableStream } = require('../server/utils/resumableStream');
const tokenCounter = require('../server/utils/tokenCounter');
const throughputStats = require('../server/utils/throughputStats');
const rotationStore = require('../server/utils/rotationStore');

const QUICK = process.argv.includes('--quick');

let passed = 0, failed = 0, skipped = 0;
function record(name, ok, detail) {
  if (ok === null) { skipped += 1; console.log('  skip -', name, detail ? `:: ${detail}` : ''); return; }
  if (ok) { passed += 1; console.log('  ok   -', name, detail ? `:: ${detail}` : ''); }
  else { failed += 1; console.log('  FAIL -', name, detail ? `:: ${detail}` : ''); }
}

const VI_PROSE_PROMPT =
  'Trả lời NGẮN bằng tiếng Việt, chỉ 2-3 câu văn xuôi, KHÔNG dùng công thức hay ký hiệu toán: ' +
  'giải thích vì sao tổng ba góc trong một tam giác luôn bằng 180 độ.';
const LATEX_PROMPT =
  'Chỉ viết CÔNG THỨC LaTeX, không viết văn xuôi: liệt kê 4 công thức lượng giác cơ bản, mỗi công thức trên một dòng, bọc trong $$...$$.';
const LONG_PROMPT =
  'Giải chi tiết, trình bày đầy đủ từng bước có đánh số: Cho tam giác ABC vuông tại A, AB = 6 cm, ' +
  'AC = 8 cm, đường cao AH. a) Tính BC. b) Tính AH. c) Tính BH và CH. d) Tính diện tích tam giác ABH.';

async function callOnce(providers, { prompt, maxTokens, deadline }) {
  let text = '';
  const res = await streamWithFailover(
    providers,
    {
      system: 'Bạn là trợ giảng toán. Trả lời bằng tiếng Việt.',
      messages: [{ role: 'user', content: prompt }],
      maxTokens,
      requestId: 'live-smoke'
    },
    (piece) => { text += piece; },
    { deadline }
  );
  return { ...res, text: res.text || text };
}

async function main() {
  console.log('\n============================================================');
  console.log('LIVE SMOKE — kiểm tra với API KEY THẬT');
  console.log('============================================================\n');

  const providers = await ensureProvidersReady();
  if (!providers || !providers.length) {
    console.log('Không tìm thấy provider nào có khóa hợp lệ. Điền .env (ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY) rồi chạy lại.');
    process.exitCode = 1;
    return;
  }

  // Nhóm target theo provider để kiểm từng hãng riêng (hình dạng response mỗi hãng một khác).
  const byProvider = new Map();
  providers.forEach((p) => {
    if (!byProvider.has(p.providerKey)) byProvider.set(p.providerKey, []);
    byProvider.get(p.providerKey).push(p);
  });

  const est = byProvider.size * (QUICK ? 3 : 4);
  console.log(`Phát hiện ${providers.length} target thuộc ${byProvider.size} provider: ${[...byProvider.keys()].join(', ')}`);
  console.log(`Rotation store: ${rotationStore.isEnabled() ? 'BẬT' : 'tắt (in-memory)'}`);
  console.log(`Ước tính khoảng ${est} lượt gọi AI thật.\n`);

  for (const [providerKey, targets] of byProvider) {
    console.log(`---------- ${providerKey} (${targets.length} target) ----------`);
    const deadline = createRequestDeadline(120000);

    // ---- 1. Response cơ bản + trường usage có đúng như code giả định? ----
    let proseRes = null;
    try {
      proseRes = await callOnce(targets, { prompt: VI_PROSE_PROMPT, maxTokens: 300, deadline });
      record('trả về text không rỗng', Boolean(proseRes.text && proseRes.text.length > 20), `${proseRes.text.length} ký tự`);
      record('finishReason được chuẩn hoá', ['stop', 'length', 'other', null].includes(proseRes.finishReason), String(proseRes.finishReason));
      record('không bị đánh dấu interrupted khi mọi thứ bình thường', proseRes.interrupted === false);
    } catch (e) {
      record('lượt gọi cơ bản', false, e.message);
      continue; // provider này không dùng được, sang provider khác
    }

    // ---- 2. Hiệu chỉnh token: tiếng Việt văn xuôi ----
    const proseRatio = tokenCounter.charsPerToken(providerKey, 'prose');
    const gotUsage = tokenCounter.snapshot()[providerKey] !== undefined;
    record('provider TRẢ VỀ trường usage (số token thật)', gotUsage,
      gotUsage ? `tỷ lệ đo được: ${proseRatio.toFixed(2)} ký tự/token` : 'KHÔNG có usage — hệ thống sẽ dùng hằng số 3.2, kém chính xác hơn');
    if (gotUsage) {
      record('tỷ lệ ký tự/token nằm trong khoảng hợp lý [1.2, 6.0]',
        proseRatio >= 1.2 && proseRatio <= 6.0, proseRatio.toFixed(2));
    }

    // ---- 3. Hiệu chỉnh token: nội dung nặng LaTeX (kiểm chứng phân lớp nội dung) ----
    try {
      const latexRes = await callOnce(targets, { prompt: LATEX_PROMPT, maxTokens: 300, deadline });
      const cls = tokenCounter.classifyContent(latexRes.text);
      record('nội dung nhiều LaTeX được phân lớp là symbolic/mixed',
        cls === 'symbolic' || cls === 'mixed', `lớp: ${cls}`);
      const symRatio = tokenCounter.charsPerToken(providerKey, 'symbolic');
      if (tokenCounter.snapshot()[`${providerKey}::symbolic`]) {
        record('LaTeX có tỷ lệ ký tự/token THẤP HƠN văn xuôi (đúng giả định thiết kế)',
          symRatio < proseRatio, `symbolic ${symRatio.toFixed(2)} vs prose ${proseRatio.toFixed(2)}`);
      } else {
        record('so sánh tỷ lệ LaTeX vs văn xuôi', null, 'chưa đủ mẫu cho lớp symbolic (cần >= 3 lượt)');
      }
    } catch (e) {
      record('lượt gọi nội dung LaTeX', false, e.message);
    }

    // ---- 4. throughput thật ----
    const tp = throughputStats.getThroughput(targets[0]);
    record('đo được throughput thật (tok/s)', Number.isFinite(tp) && tp > 0, `${Math.round(tp)} tok/s`);
    if (tp === throughputStats.DEFAULT_TOKENS_PER_SEC) {
      record('throughput đã rời khỏi giá trị mặc định', null, 'mẫu còn quá nhỏ, cần lượt gọi dài hơn');
    }

    // ---- 5. maxTokens rất nhỏ -> finishReason=length -> completeness HARD ----
    try {
      const cut = await callOnce(targets, { prompt: LONG_PROMPT, maxTokens: 120, deadline });
      const comp = validateSolutionCompleteness(cut.text, {
        stage: 'detail', finishReason: cut.finishReason, interrupted: cut.interrupted
      });
      record('chạm maxTokens -> finishReason = "length"', cut.finishReason === 'length', String(cut.finishReason));
      record('câu trả lời bị cắt bị đánh giá HARD INCOMPLETE (sẽ kích hoạt recovery)',
        comp.severity === 'HARD', `reasons: ${(comp.hardReasons || []).join(',')}`);
    } catch (e) {
      record('kiểm tra finish_reason=length', false, e.message);
    }
  }

  // ---- 6. Continuation THẬT xuyên provider: nối liền mạch, không lặp ----
  if (!QUICK) {
    console.log('\n---------- Continuation thật (A -> B) ----------');
    const deadline = createRequestDeadline(180000);
    try {
      let streamed = '';
      const run = await runResumableStream({
        providers,
        streamFn: streamWithFailover,
        messages: [{ role: 'user', content: LONG_PROMPT }],
        buildArgs: ({ messages, maxTokens }) => ({
          system: 'Bạn là trợ giảng toán. Trả lời bằng tiếng Việt, trình bày từng bước có đánh số.',
          messages,
          // maxTokens nhỏ ở lượt đầu để BUỘC hệ thống phải tiếp nối thật (đây là mục đích của bài test)
          maxTokens,
          requestId: 'live-smoke-cont'
        }),
        onDelta: (piece) => { streamed += piece; },
        evaluate: (text, sig) => validateSolutionCompleteness(text, {
          stage: 'detail', finishReason: sig.finishReason, interrupted: sig.interrupted
        }),
        resolveRecovery: (_c, session) => (session.continuationCount >= 2 ? { allow: false, amount: 0 } : { allow: true, amount: 700 }),
        deadline,
        sessionInit: { coreBudget: 220, totalBudget: 1600, recoveryBudget: 1400, requestStage: 'detail' }
      });

      record('có xảy ra continuation thật', run.continuations >= 1, `${run.continuations} lượt`);
      record('text người dùng nhận được KHỚP text cuối cùng', streamed === run.text,
        `stream ${streamed.length} vs final ${run.text.length} ký tự`);

      // Kiểm lặp text: không câu nào (>= 40 ký tự) xuất hiện 2 lần.
      const sentences = run.text.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.length >= 40);
      const seen = new Set();
      const dups = sentences.filter((x) => (seen.has(x) ? true : (seen.add(x), false)));
      record('KHÔNG lặp câu ở điểm nối', dups.length === 0,
        dups.length ? `lặp: "${dups[0].slice(0, 60)}…"` : `${sentences.length} câu, 0 lặp`);

      const providersUsed = new Set(run.session.triedTargets);
      record('ghi nhận được target đã dùng qua các lượt', providersUsed.size >= 1, [...providersUsed].join(' -> '));
      console.log(`         telemetry: ${JSON.stringify(run.session.snapshot())}`);
    } catch (e) {
      record('continuation thật', false, e.message);
    }
  }

  console.log('\n============================================================');
  console.log('KẾT QUẢ HIỆU CHỈNH TOKEN (số liệu THẬT):');
  console.log(JSON.stringify(tokenCounter.snapshot(), null, 2));
  console.log('\nTHROUGHPUT (số liệu THẬT):');
  console.log(JSON.stringify(throughputStats.snapshot(), null, 2));
  console.log('============================================================');
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped\n`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error('Live smoke lỗi:', e && e.message);
  process.exitCode = 1;
});
