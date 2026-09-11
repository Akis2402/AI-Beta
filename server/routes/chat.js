'use strict';

const express = require('express');
const router = express.Router();
const {
  getActiveProviders, ensureProvidersReady, callWithFailover, callFastest, streamWithFailover,
  gatherCrossCheckCandidates
} = require('../utils/aiProviders');
// Timeout riêng cho LƯỢT TỔNG HỢP cuối (sau khi đã có candidates) — tách khỏi CROSS_CHECK_BUDGET_MS
// (ngân sách đó chỉ tính cho bước THU THẬP lượt giải). Có timeout riêng, rõ ràng để lượt tổng hợp
// không bị "thừa hưởng" một REQUEST_TIMEOUT_MS quá dài rồi cộng dồn vượt quá maxDuration của hosting.
const RECONCILE_TIMEOUT_MS = Number(process.env.RECONCILE_TIMEOUT_MS) || 25000;
const {
  buildChatSystemPrompt,
  buildVariantAddendum,
  buildReconcileSystemPrompt,
  PROMPT_VERSION
} = require('../utils/promptBuilder');
const { validateChatBody } = require('../utils/validators');
// Mục II master spec: "Hướng giải" (approach) phải ngắn/compact, độc lập với "Lời giải" — validator
// + repair NGẮN (KHÔNG regenerate toàn bộ, KHÔNG retry vô hạn) khi model lỡ sinh approach quá dài/
// leak đáp số/tính toán chi tiết.
const { validateApproachCompactness, buildApproachRepairPrompt, extractApproachSection } = require('../utils/approachValidator');
const { normalizeError } = require('../utils/errorNormalize');
const { calculateAdaptiveBudget } = require('../utils/adaptiveBudget');
const { compressHistoryForBudget } = require('../utils/semanticCompression');
const { validateSolutionCompleteness, extractCoverageList } = require('../utils/completenessCheck');
const { computeRecoveryBudget, appendContinuationTurn } = require('../utils/continuation');
// PHẦN B/L: vòng RESUME/CONTINUATION dùng chung (checkpoint + resumable failover A->B->C->D).
const { runResumableStream, runResumableNonStream } = require('../utils/resumableStream');
// PHẦN D/E/F: nén ngữ cảnh loss-aware (chỉ INPUT side — không bao giờ giảm output budget).
const contextCompressor = require('../utils/contextCompressor');
// PHẦN J: throughput đo thật theo provider/model, thay hằng số 60 tok/s.
const throughputStats = require('../utils/throughputStats');
const { validateAllDrawingBlocks, checkCanonicalDrawingConsistency } = require('../utils/drawingValidator');
// Vấn đề #1: citeNo ỔN ĐỊNH -> mới bật được dedupe context an toàn (xem citationIndex.js).
const { buildCitationIndex } = require('../utils/citationIndex');
const { createRequestDeadline } = require('../utils/requestDeadline');
const { STATES, isFinalSuccess, assertFinalResponseComplete, classifyFinalOutcome } = require('../utils/runtimeState');
const { analyzeSourceCoverage } = require('../utils/sourceCoverage');
const { createRequestLogger } = require('../utils/logger');
const { extractFinalAnswer, normalizeAnswerString } = require('../utils/studyTasks');
const { resolveThinkingMode } = require('../utils/thinkingRouter');
const tokenEconomy = require('../utils/tokenEconomy');
const { resolveSubject } = require('../utils/subjects');

// ---------- Mục 5/5A: candidate đã ĐỒNG THUẬN thì reconcile không cần sinh lại full solution ----------
// So sánh đáp số cuối cùng (trích bằng cùng logic dùng ở self-check — extractFinalAnswer) giữa MỌI
// candidate: nếu tất cả khớp nhau (sau khi chuẩn hoá), coi là "agreement" — reconcile chuyển sang chế
// độ NHẸ (buildReconcileSystemPrompt({agreement:true}) + budget 'reconcileLight' thay vì 'reconcile').
function candidatesAgree(candidates) {
  if (!candidates || candidates.length < 2) return false;
  const answers = candidates.map((c) => normalizeAnswerString(extractFinalAnswer(c.text) || ''));
  if (answers.some((a) => !a)) return false;
  return answers.every((a) => a === answers[0]);
}

/**
 * maybeRepairApproach() — mục II: chỉ chạy khi stageName === 'approach'. Validator thuần (không AI)
 * kiểm tra compactness; nếu vi phạm, gửi ĐÚNG 1 lượt repair prompt NGẮN (system tối giản, chỉ đúng
 * approachText cũ + yêu cầu viết lại phần "Hướng giải" gọn hơn) — KHÔNG regenerate toàn bộ
 * conversation, KHÔNG retry nếu lượt repair đó lỗi/timeout (mục II cấm "retry vô hạn"). Nếu repair
 * thất bại vì bất kỳ lý do gì, giữ nguyên bản gốc — không để lỗi ở bước tối ưu này làm hỏng câu trả
 * lời chính đã có.
 */
async function maybeRepairApproach({ stageName, text, activeProviders, requestId, signal, deadline, reqLogger }) {
  if (stageName !== 'approach' || !text) return text;
  const check = validateApproachCompactness(extractApproachSection(text));
  if (check.ok) return text;
  try {
    const repairPrompt = buildApproachRepairPrompt(text, check.violations);
    const repaired = await callWithFailover(
      activeProviders,
      {
        system: 'Bạn là trợ lý sửa định dạng câu trả lời — chỉ thực hiện đúng yêu cầu rút gọn được nêu, không thêm/bớt nội dung khoa học nào khác.',
        messages: [{ role: 'user', content: repairPrompt }],
        maxTokens: 900,
        requestId,
        signal
      },
      { deadline }
    );
    const repairedText = repaired && repaired.text ? repaired.text.trim() : '';
    if (repairedText.length > 40) {
      const recheck = validateApproachCompactness(extractApproachSection(repairedText));
      if (reqLogger) reqLogger.log({ stage: 'approach_repair', violations: check.violations, repairOk: recheck.ok });
      return repairedText;
    }
  } catch (e) {
    if (reqLogger) reqLogger.log({ stage: 'approach_repair_failed', violations: check.violations, error: e && e.message });
  }
  return text; // repair thất bại/không đủ dài -> giữ bản gốc, không retry thêm lần nào nữa
}

/**
 * validateSolutionCompleteness() chỉ nhìn CẤU TRÚC văn bản (fence/LaTeX chưa đóng...) — gộp thêm
 * kết quả validate JSON của MỌI khối shape/solid3d/plot (mục X) vào cùng 1 lần đánh giá, vì hình vẽ
 * hỏng cũng khiến response không thể coi là hoàn chỉnh dù văn bản xung quanh đã đủ ý.
 * `opts.approachText` (mục 15): khi stage==='detail' và hướng giải trước đó đã có hình minh họa,
 * đối chiếu THÊM canonical drawing state — model chỉ được PHÉP THÊM điểm/phần tử mới, không được
 * xoá/sửa hình đã dựng ở "Hướng giải". Vi phạm bị coi là INCOMPLETE (kích hoạt continuation yêu cầu
 * sửa lại đúng canonical state — xem continuation.js), KHÔNG được lặng lẽ chấp nhận hình đã bị vẽ lại.
 */
function checkCompletenessWithDrawings(text, opts) {
  const base = validateSolutionCompleteness(text, opts);
  const drawingIssues = validateAllDrawingBlocks(text).filter((b) => !b.valid);
  if (drawingIssues.length) {
    return {
      ...base,
      status: 'INCOMPLETE',
      reasons: [...base.reasons, 'invalid_drawing_json'],
      drawingErrors: drawingIssues.map((b) => ({ kind: b.kind, errors: b.errors }))
    };
  }
  if (opts && opts.stage === 'detail' && opts.approachText) {
    const canonical = checkCanonicalDrawingConsistency(opts.approachText, text);
    if (canonical.checked && !canonical.consistent) {
      return {
        ...base,
        status: 'INCOMPLETE',
        reasons: [...base.reasons, 'drawing_canonical_mismatch'],
        drawingCanonicalErrors: canonical.errors
      };
    }
  }
  return base;
}

// ---------- Ngân sách thời gian TOÀN CỤC cho 1 request (mục XIII) ----------
// Trước đây mỗi bước (candidate, retry, reconcile, continuation) tự có timeout RIÊNG, cộng dồn tuần
// tự có thể vượt quá maxDuration của hosting serverless (Vercel...). Mọi request giờ có 1 deadline
// DÙNG CHUNG — continuation chỉ chạy thêm nếu vẫn còn đủ ngân sách thời gian, không "cố thêm" rồi bị
// nền tảng hủy ngang toàn bộ response (kể cả phần đã hoàn thành đúng).
const GLOBAL_REQUEST_DEADLINE_MS = Number(process.env.GLOBAL_REQUEST_DEADLINE_MS) || 55000;
// createGlobalDeadline() nội bộ đã bị loại bỏ — dùng createRequestDeadline() dùng chung từ
// requestDeadline.js (mục 4), truyền đúng 1 instance xuyên suốt toàn bộ pipeline của request này
// (gatherCrossCheckCandidates/callWithFailover/callFastest/streamWithFailover/continuation/budgetOf).

/**
 * Chạy completeness check + continuation (mục V/VI, refactor mục 1-4 audit continuation) cho MỘT
 * response cuối cùng (thứ người dùng thực sự đọc) — KHÔNG áp dụng cho từng candidate thu thập nội bộ
 * (mục XIV: chỉ tốn thêm lượt gọi AI khi thực sự có lợi cho response cuối).
 *
 * FIX ROOT CAUSE (mục 1-4/9 audit continuation): vòng lặp continuation TRƯỚC ĐÂY chỉ dừng theo
 * `continuations < MAX_CONTINUATIONS` (hằng số cố định) và coi MỌI completeness.status==='INCOMPLETE'
 * đều cần continuation — kể cả khi lý do CHỈ là SOFT (thiếu từ khoá kết luận/vài label, xem
 * completenessCheck.js). Nay:
 *   - CHỈ continuation khi severity==='HARD' (SOFT đã được coi là thành công — không cần "sửa").
 *   - Điều kiện dừng dùng computeRecoveryBudget() (mục 3 — deadline/safety cap ĐỘNG), không phải so
 *     sánh cứng với MAX_CONTINUATIONS.
 *   - finishReason của MỖI lượt (initial + từng continuation) được forward vào completeness check
 *     kế tiếp — model tự kết thúc (finishReason='stop') ở BẤT KỲ lượt nào (kể cả sau continuation)
 *     đều đủ để coi là COMPLETE ngay nếu không còn HARD reason nào khác (mục 1).
 *
 * @param {Function} callOnce (msgs, completeness) => Promise<{text, provider, finishReason}> — 1 lượt
 *   gọi continuation (không stream). `completeness` hiện tại được truyền vào để callOnce có thể tự
 *   quyết định reserve/mở rộng ngân sách phù hợp với mức độ nghiêm trọng thực tế (xem chat.js).
 * @param {{text, provider, finishReason}} initialResult Kết quả lượt gọi ĐẦU TIÊN (đã có finishReason
 *   nếu callWithFailover/callFastest đã forward — xem aiProviders.js).
 * @param {{messages:Array, problemText:string, stage:string, deadline:object}} ctx
 * @returns {Promise<{text:string, completeness:object, continuations:number, provider:object}>}
 */
async function ensureCompleteNonStream(callOnce, initialResult, ctx) {
  // REFACTOR PHẦN B: thân hàm này (vòng while continuation viết tay) đã được chuyển vào
  // resumableStream.runResumableNonStream() để dùng CHUNG checkpoint/minimal-context/seam-dedupe với
  // nhánh streaming — trước đây 2 nhánh có 2 bản logic gần trùng nhau và chỉ nhánh nào được sửa mới
  // có fix (đúng lý do lỗi tồn tại dai dẳng). Chữ ký hàm giữ NGUYÊN để mọi nơi gọi cũ không phải sửa.
  const coverageList = extractCoverageList(ctx.problemText);
  const evaluate = (text, sig) => checkCompletenessWithDrawings(text, {
    stage: ctx.stage, coverageList, approachText: ctx.approachText, contexts: ctx.contexts,
    finishReason: sig.finishReason, interrupted: sig.interrupted,
    validCiteNos: ctx.validCiteNos, aliasOf: ctx.aliasOf
  });

  const run = await runResumableNonStream({
    callFn: (args) => callOnce(args.messages, args.__completeness, args.maxTokens),
    buildArgs: ({ messages: msgs, maxTokens }) => ({ messages: msgs, maxTokens }),
    messages: ctx.messages,
    initialResult,
    evaluate,
    // ctx.resolveRecovery do caller (route) cung cấp — chính sách reserve nằm ở chat.js (xem
    // makeRecoveryResolver). Fallback: cho phép 1 lô mặc định nếu caller không truyền (test cũ).
    resolveRecovery: ctx.resolveRecovery || (() => ({ allow: true, amount: 800 })),
    deadline: ctx.deadline,
    signal: ctx.signal,
    isDisconnected: ctx.isDisconnected || (() => false),
    sessionInit: { requestStage: ctx.stage, requestId: ctx.requestId }
  });

  // ---------- Cổng bắt buộc: KHÔNG BAO GIỜ gắn nhãn thành công cho response còn HARD ----------
  // Khác bản trước ở đúng 1 điểm: nếu KHÔNG còn đường recovery nào mà nội dung vẫn dùng được, ta
  // KHÔNG xoá nó — trả về kèm cờ `partial` để route gắn state PARTIAL (xem classifyFinalOutcome).
  // Chỉ khi thực sự không có gì dùng được mới ném FINAL_RESPONSE_INCOMPLETE như cũ.
  const outcome = classifyFinalOutcome(run.completeness, { textLength: run.text.length });
  if (outcome.state === STATES.FAILED) assertFinalResponseComplete(run.completeness);

  return {
    text: run.text,
    completeness: run.completeness,
    continuations: run.continuations,
    resumes: run.resumes,
    provider: run.provider || initialResult.provider,
    partial: outcome.partial,
    session: run.session
  };
}

/**
 * FIX ROOT CAUSE mục 4 (audit continuation): dùng chung cho MỌI closure `callOnce` truyền vào
 * ensureCompleteNonStream() hoặc vòng lặp continuation streaming — quyết định có tiêu tiếp reserve
 * hay không, và nếu reserve (30% mặc định) đã cạn NHƯNG completeness thực sự HARD (đáng để tiếp tục)
 * VÀ deadline vẫn còn nhiều, THỬ MỞ RỘNG reserve dựa trên adaptiveBudget tính LẠI theo thời gian còn
 * lại hiện tại — thay vì dừng cứng ngay khi chạm mốc 30% ban đầu trong khi tổng ngân sách request
 * (so với deadline) vẫn còn dư dả (mục 4: "không hard-code reserve cố định nếu điều đó làm câu trả
 * lời bị cắt... không fail chỉ vì reserve cố định đã hết trong khi total request budget vẫn còn").
 *
 * @param {{completeness:object, reserveState:{budget:number, used:number}, recalcBudget:Function,
 *   deadline:object}} opts `recalcBudget()` => target budget hiện tại (gọi lại calculateAdaptiveBudget
 *   với remainingMs mới nhất — do caller cung cấp vì nó biết chính xác opts nào cần cho stage đó).
 * @returns {{allow:boolean, amount:number}}
 */
function resolveReserveDecision({ completeness, reserveState, recalcBudget, deadline, deficitTokens }) {
  // PHẦN I FIX: truyền `deficitTokens` (ước lượng phần CÒN THIẾU, xem tokenEconomy.estimateRemainingWork)
  // để lô reserve được cấp ĐÚNG mức cần hoàn thành thay vì luôn là 50% reserve một cách mù quáng —
  // nguyên nhân trực tiếp khiến câu trả lời dài bị cắt lặp lại rồi cạn reserve dù deadline còn dư.
  const opts = Number.isFinite(deficitTokens) ? { deficitTokens } : {};
  let decision = tokenEconomy.shouldUseReserve(completeness, reserveState.used, reserveState.budget, opts);
  if (decision.allow) return decision;
  // Reserve báo KHÔNG cho phép — chỉ đáng thử MỞ RỘNG khi lý do là "đã dùng hết reserve hiện có" (chứ
  // không phải vì completeness là SOFT/COMPLETE, những trường hợp đó KHÔNG được đụng reserve dù còn
  // bao nhiêu — xem shouldUseReserve()) VÀ vẫn còn đủ thời gian cho ít nhất 1 lượt gọi nữa.
  const reserveWasTheBlocker = completeness && completeness.status !== 'COMPLETE' && completeness.severity !== 'SOFT';
  if (!reserveWasTheBlocker) return decision;
  if (!deadline || deadline.remaining() < 8000) return decision;
  const recalculatedTarget = recalcBudget();
  const { extendedReserveBudget, extraGranted } = tokenEconomy.extendReserveIfTruncated({
    reserveBudget: reserveState.budget, reserveUsed: reserveState.used, recalculatedTarget
  });
  if (extraGranted <= 0) return decision;
  reserveState.budget = extendedReserveBudget; // cập nhật để lần gọi sau (nếu có) thấy đúng phần đã mở rộng
  return tokenEconomy.shouldUseReserve(completeness, reserveState.used, reserveState.budget, opts);
}

/**
 * makeRecoveryResolver() — CHÍNH SÁCH ngân sách recovery cho 1 stage, dùng cho cả nhánh streaming và
 * nhánh JSON. chat.js giữ quyền quyết định này (không đẩy xuống resumableStream.js) vì chỉ nó biết
 * budget/stage/deadline của request; resumableStream.js chỉ gọi lại qua callback.
 *
 * Điểm khác cốt lõi so với bản trước: `deficitTokens` được tính từ ngân sách kỳ vọng của CHÍNH stage
 * đó trừ phần đã sinh thật (tokenEconomy.estimateRemainingWork) — nên lượt tiếp nối của 1 câu trả lời
 * bị ngắt ở 40% được cấp đủ token để đi tới hết, thay vì 1 lô nhỏ cố định rồi lại bị cắt.
 *
 * @param {{reserveState:{budget:number,used:number}, recalcTarget:Function, deadline:object}} cfg
 * @returns {Function} (completeness, session) => {allow:boolean, amount:number}
 */
function makeRecoveryResolver({ reserveState, recalcTarget, deadline }) {
  return (completeness, session) => {
    const expectedTotal = recalcTarget();
    const deficitTokens = tokenEconomy.estimateRemainingWork({
      expectedTotal,
      producedTokens: session ? session.outputTokens : 0,
      missingSections: (completeness && completeness.missingCoverage) ? completeness.missingCoverage.length : 0,
      interrupted: !!(session && session.interrupted)
    });
    const decision = resolveReserveDecision({
      completeness, reserveState, deadline, deficitTokens,
      recalcBudget: recalcTarget
    });
    // QUAN TRỌNG: ghi nhận phần reserve ĐÃ CẤP ngay tại đây. resolveReserveDecision() chỉ QUYẾT
    // ĐỊNH, không trừ ngân sách — nếu nơi gọi quên trừ (lỗi rất dễ mắc khi vòng lặp nằm ở module
    // khác), reserve sẽ không bao giờ cạn và vòng recovery chạy tới safety cap ở MỌI request lỗi.
    if (decision && decision.allow) reserveState.used += decision.amount;
    return decision;
  };
}

// ---------- Tiện ích SSE (Server-Sent Events) dùng cho phản hồi streaming ----------
// Sự kiện phát ra cho client: "delta" (1 đoạn văn bản mới), "status" (thông báo tiến trình, vd
// đang đối chiếu đa hướng ở chế độ Sâu — không có delta nào trong lúc này), "done" (kết thúc
// thành công, kèm metadata provider/crossChecked), "error" (kết thúc do lỗi).
function sseWrite(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
function sseHeaders(res) {
  // QUAN TRỌNG: phải dùng res.setHeader() cho TỪNG header rồi mới gọi res.writeHead(200) KHÔNG kèm
  // object headers — KHÔNG được gộp headers vào chung 1 lệnh res.writeHead(200, {...}) như trước.
  // NGUYÊN NHÂN GỐC của lỗi "AI streaming không xuất hiện" (hiệu ứng gõ chữ mất hẳn, câu trả lời
  // xuất hiện dồn cục 1 lần): server/app.js có bật app.use(compression({filter:...})) TOÀN CỤC,
  // module compression dùng thư viện "on-headers" để tự kiểm tra Content-Type NGAY TRƯỚC KHI
  // header thực sự được ghi ra socket — nhưng listener của "on-headers" chạy TRƯỚC KHI các header
  // truyền trực tiếp làm THAM SỐ của lệnh res.writeHead(status, headersObj) được áp dụng vào
  // res.getHeader(); nó CHỈ thấy được các header đã được set từ trước bằng res.setHeader(). Vì
  // vậy khi gọi res.writeHead(200, {'Content-Type':'text/event-stream',...}) trực tiếp như cũ,
  // tại thời điểm filter của compression chạy, res.getHeader('Content-Type') vẫn trả về undefined
  // (chưa "thấy" giá trị vừa truyền) => điều kiện bỏ qua nén KHÔNG khớp => compression vẫn nén
  // gzip response SSE này như bình thường, mà gzip stream lại ĐỆM một lượng dữ liệu nhất định
  // trước khi flush ra ngoài — kết quả là client nhận được các đoạn "delta" dồn cục thành từng
  // cụm lớn/chậm thay vì từng chữ một theo thời gian thực, nhìn như "mất" hiệu ứng streaming.
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // vô hiệu hoá đệm ở các proxy kiểu Nginx (không ảnh hưởng Vercel nhưng vô hại)
  res.writeHead(200);
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  // Tắt thuật toán Nagle trên socket TCP — một số môi trường hosting/proxy trung gian vẫn gộp các
  // lần res.write() nhỏ, liên tiếp lại thành 1 gói TCP để tối ưu băng thông, gây độ trễ hiển thị
  // dù server đã gửi đi đúng từng đoạn nhỏ. setNoDelay(true) buộc gửi ngay lập tức từng res.write().
  if (res.socket && typeof res.socket.setNoDelay === 'function') res.socket.setNoDelay(true);
}

router.post('/', async (req, res, next) => {
  const wantsStream = req.body && req.body.stream === true;
  // Observability (mục LVIII): 1 requestId duy nhất cho cả request (kể cả nhiều lượt gọi AI bên
  // trong — cross-check, retry, tổng hợp...) — dùng để nối các dòng log lại thành 1 timeline khi
  // debug production. Không log body/API key, chỉ log route/stage/latency/status/error class.
  const reqLogger = createRequestLogger({ route: '/api/chat', method: 'POST' });
  reqLogger.log({ stage: 'request_start', stream: wantsStream });
  // 'finish' bắt MỌI đường kết thúc response (JSON thường lẫn SSE) mà không cần sửa từng nhánh
  // return rải rác trong handler — 1 dòng log 'request_end' duy nhất, luôn đúng latency thật.
  res.on('finish', () => reqLogger.end({ statusCode: res.statusCode }));

  // ---------- Cancellation (mục 4): client đóng kết nối/bấm "Dừng" giữa chừng ----------
  // `abortController.signal` được truyền xuống MỌI lệnh gọi provider bên dưới (qua field `signal`
  // trong args) — mỗi client (anthropicClient.js/openaiClient.js/geminiClient.js/
  // openaiCompatibleClient.js) tự "nối" signal này với AbortController nội bộ của nó (xem
  // abortLink.js) nên request tới provider bị hủy NGAY, không chờ hết timeoutMs. `disconnected`
  // được check ở các điểm nối tiếp của pipeline (giữa vòng cross-check/continuation/reconcile) để
  // dừng SỚM — không tiếp tục continuation/retry/reconcile, không ghi cache, không gửi "done".
  const abortController = new AbortController();
  let disconnected = false;
  req.on('close', () => {
    if (res.writableEnded) return; // response đã kết thúc bình thường — không phải disconnect thật
    disconnected = true;
    abortController.abort();
  });
  const signal = abortController.signal;

  try {
    // PHẦN 13 FIX: TRƯỚC ĐÂY globalDeadline được tạo SAU ensureProvidersReady() (discovery) + body
    // validation + semantic compression — thời gian discovery hoàn toàn KHÔNG bị tính vào deadline
    // chung của request (globalDeadline.remaining() ở các bước sau bị "cho không" thêm thời gian đã
    // mất ở discovery, có thể khiến tổng thời gian thực tế vượt GLOBAL_REQUEST_DEADLINE_MS dự kiến).
    // FIX: tạo deadline NGAY ĐẦU tiên — discovery/validation/nén ngữ cảnh/generation/continuation
    // đều dùng CHUNG 1 đồng hồ, đúng thứ tự createRequestDeadline() -> discovery -> preparation ->
    // generation -> validation -> continuation -> finalization.
    const globalDeadline = createRequestDeadline(GLOBAL_REQUEST_DEADLINE_MS);
    const input = validateChatBody(req.body);
    await ensureProvidersReady();
    const activeProviders = getActiveProviders();
    if (!activeProviders.length) {
      const err = new Error(
        'Máy chủ chưa cấu hình bất kỳ nhà cung cấp AI nào (thiếu ANTHROPIC_API_KEY/OPENAI_API_KEY/GEMINI_API_KEY trong .env).'
      );
      err.status = 500;
      throw err;
    }

    const userContent = [];
    if (input.image) {
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: input.image.mediaType, data: input.image.base64 }
      });
    }
    const problemText = input.query || 'Hãy đọc kỹ và giải chi tiết bài tập có trong hình ảnh này.';
    userContent.push({ type: 'text', text: problemText });

    // ---------- Mục 14.2/14.3: nhận diện môn học (auto) hoặc dùng lựa chọn thủ công ----------
    // Chạy 1 lần duy nhất ở đây rồi gắn vào `input` — mọi lệnh gọi buildChatSystemPrompt/
    // buildReconcileSystemPrompt bên dưới đều spread `input` nên tự động nhận subjectId, không phải
    // sửa từng điểm gọi riêng lẻ.
    const subjectResolved = resolveSubject({
      manualSubjectId: input.settings.subject, problemText, hasImage: !!input.image
    });
    input.subjectId = subjectResolved.subjectId;
    input.secondarySubjectId = subjectResolved.secondarySubjectId;
    reqLogger.log({
      stage: 'subject_detect', subjectId: subjectResolved.subjectId,
      confidence: subjectResolved.subjectConfidence, source: subjectResolved.subjectSource,
      secondarySubjectId: subjectResolved.secondarySubjectId
    });
    // 14.16: gắn kèm vào MỌI payload trả về (streaming lẫn JSON thường) để client lưu subjectId vào
    // metadata tin nhắn (lọc lịch sử theo môn) và hiển thị badge — xem các payload bên dưới.
    const subjectPayload = {
      subjectId: subjectResolved.subjectId, subjectConfidence: subjectResolved.subjectConfidence,
      secondarySubjectId: subjectResolved.secondarySubjectId,
      secondarySubjectConfidence: subjectResolved.secondarySubjectConfidence
    };

    // ---------- Semantic compression (mục IV/mục 8) trước khi ghép messages ----------
    // Đề bài/contexts/approachText KHÔNG bao giờ bị đụng tới — chỉ history (lượt hỏi-đáp CŨ, không
    // còn liên quan trực tiếp tới câu hỏi hiện tại) mới có thể bị loại bỏ NGUYÊN LƯỢT khi tổng ngữ
    // cảnh đã nặng (nhiều context/approachText dài), thay vì bị validators cắt cứng theo ký tự.
    // `currentProblemText` (mục 8): cho phép compressHistoryForBudget ưu tiên giữ lượt LIÊN QUAN tới
    // câu hỏi hiện tại thay vì chỉ cắt mù theo tuổi, và tự loại các lượt trùng lặp trước tiên.
    // ---------- Vấn đề #1: BẬT context dedupe (trước đây tePlan.dedupedContexts là dead code) ----------
    // Gán citeNo ổn định MỘT LẦN cho cả request rồi gộp đoạn trùng/gần trùng. Từ đây trở xuống, MỌI
    // nơi (prompt, completeness/citation validation, sourceCoverage, cache key, payload trả client)
    // đều dùng `effectiveContexts` — KHÔNG dùng `input.contexts` thô nữa, để 3 nơi sinh số citation
    // không thể lệch nhau được nữa.
    const citationIndex = buildCitationIndex(input.contexts);
    // ---------- Vấn đề #2: nén NỘI DUNG đoạn trích (header/footer trang lặp lại giữa các đoạn) ----------
    // Chạy SAU buildCitationIndex để citeNo đã cố định (nén nội dung không bao giờ đổi số trích dẫn),
    // và KHÔNG BAO GIỜ loại bỏ 1 đoạn nào — việc gộp đoạn trùng là của citationIndex.js.
    const excerptPack = contextCompressor.compressSourceExcerpts(citationIndex.effectiveContexts);
    const effectiveContexts = excerptPack.contexts;
    input.contexts = effectiveContexts;
    if (citationIndex.duplicatesMerged) {
      reqLogger.log({
        stage: 'context_dedupe',
        excerptBoilerplateLinesDropped: excerptPack.droppedBoilerplateLines,
        excerptRolledBack: excerptPack.rolledBack,
        merged: citationIndex.duplicatesMerged,
        before: citationIndex.citationMap.reduce((n, m) => n + m.originalIndexes.length, 0),
        after: effectiveContexts.length
      });
    }

    const contextsText = effectiveContexts.map((c) => c.text).join('\n');
    // ---------- mục 1: deep thinking capability routing (KHÔNG hard-code fast:true nữa) ----------
    // deepThinking=false -> fast model (như cũ). deepThinking=true -> KHÔNG BAO GIỜ ép fast model;
    // client tự quyết cơ chế reasoning NATIVE hay prompt-based dựa theo capability của provider được
    // chọn tại thời điểm gọi thực (xem thinkingRouter.js + anthropicClient/geminiClient/openaiClient).
    const callMode = resolveThinkingMode({ deepThinking: !!input.deepThinking });
    const { history: compressedHistory } = compressHistoryForBudget(input.history, {
      contextsTokenLoad: contextsText.length / 3.2,
      approachTokenLoad: input.approachText.length / 3.2,
      problemTokenLoad: problemText.length / 3.2,
      currentProblemText: problemText
    });

    // ---------- PHẦN D/E/F: LOSS-AWARE SEMANTIC COMPRESSION (lớp thứ 2, sau khi đã bỏ lượt cũ) ----------
    // compressHistoryForBudget() ở trên chỉ LOẠI BỎ NGUYÊN LƯỢT khi ngân sách history bị vượt. Lớp
    // này làm việc khác hẳn: với các lượt CÒN LẠI, nó nén theo TẦNG (TIER 0-4) và theo IMPORTANCE,
    // chỉ bỏ prose diễn giải đã hoàn thành/boilerplate lặp, GIỮ NGUYÊN mọi số liệu/công thức/biến/
    // đơn vị/nhãn ý/citation/drawing state (quality gate + rollback — xem contextCompressor.js).
    //
    // Quyết định CÓ NÉN hay không dựa trên TỔNG tải input của request (system prompt + nguồn + đề
    // bài + history), không dựa riêng phần history — request nhẹ thì KHÔNG nén (PHẦN D.2).
    // System prompt CHỨA LUÔN khối đoạn trích, nên muốn có 1 con số "before" TRUNG THỰC ta phải dựng
    // 2 bản: bản RAW (đoạn trích chưa nén) và bản đã nén. Trước đó tôi cộng riêng excerptPack.rawTokens
    // vào tổng input — sai, vì như vậy đoạn trích bị ĐẾM 2 LẦN (một lần trong system prompt, một lần
    // riêng), làm tỷ lệ nén báo cáo THẤP hơn thực tế.
    const rawSystemPrompt = buildChatSystemPrompt({
      ...input, problemText, contexts: citationIndex.effectiveContexts
    });
    const preSystemPrompt = buildChatSystemPrompt({ ...input, problemText });
    const systemPack = contextCompressor.compressSystemPrompt(preSystemPrompt);
    const historyItems = contextCompressor.assignTiers(compressedHistory);

    const rawHistoryTokens = historyItems.reduce((acc, it) => acc + Math.ceil(String(it.text).length / 3.2), 0);
    const estimatedRawInput =
      Math.ceil(rawSystemPrompt.length / 3.2)
      + Math.ceil(problemText.length / 3.2)
      + Math.ceil(input.approachText.length / 3.2)
      + rawHistoryTokens;

    const compressedResult = contextCompressor.semanticCompressContext({
      items: historyItems,
      problemText,
      totalInputTokens: estimatedRawInput
    });
    const finalHistory = compressedResult.items.map((it) => ({ role: it.role, content: it.text }));
    const historyText = finalHistory.map((h) => h.content).join('\n');

    // PHẦN E: compression CHỈ tối ưu phía INPUT. Các con số dưới đây đi vào TELEMETRY và KHÔNG BAO
    // GIỜ được dùng để suy ra maxTokens/output budget — budget output vẫn tính hoàn toàn theo độ
    // phức tạp bài + deadline (budgetOf/calculateAdaptiveBudget), xem PHẦN E trong báo cáo.
    const estimatedCompressedInput =
      systemPack.compressedTokens
      + Math.ceil(problemText.length / 3.2)
      + Math.ceil(input.approachText.length / 3.2)
      + compressedResult.stats.compressedTokens;

    const compressionTelemetry = {
      rawInputTokens: estimatedRawInput,
      compressedInputTokens: Math.max(1, estimatedCompressedInput),
      compressionRatio: estimatedRawInput > 0
        ? Number(((estimatedRawInput - estimatedCompressedInput) / estimatedRawInput).toFixed(4))
        : 0,
      compressionTargetRatio: compressedResult.stats.targetRatio,
      compressionRollbacks: compressedResult.stats.rolledBack.length,
      compressionDroppedItems: compressedResult.stats.droppedItems,
      systemPromptSaving: systemPack.rawTokens - systemPack.compressedTokens,
      excerptSaving: Math.max(0, excerptPack.rawTokens - excerptPack.compressedTokens),
      excerptBoilerplateLinesDropped: excerptPack.droppedBoilerplateLines,
      contextsMerged: citationIndex.duplicatesMerged
    };
    reqLogger.log({ stage: 'context_compression', ...compressionTelemetry });

    const messages = [
      ...finalHistory.map((h) => ({ role: h.role, content: h.content })),
      { role: 'user', content: userContent }
    ];

    // ---------- FIX PHẦN 3: Token Economy PHẢI là source of truth cho maxTokens thực tế ----------
    // TRƯỚC ĐÂY: budgetOf(stage).target được dùng thẳng làm maxTokens cho MỌI lượt gọi (kể cả lượt
    // ĐẦU TIÊN) — coreBudget/reserveBudget do tokenEconomy tính chỉ nằm trong tePlan để LOG, không
    // điều khiển request thật (dead calculation — mục 17). NAY: budgetPlanOf(stage) trả thêm
    // coreBudget/reserveBudget (allocateCoreReserve của chính tokenEconomy.js) — lượt gọi ĐẦU TIÊN
    // dùng đúng coreBudget (70%), reserve (30%) CHỈ được cấp phát khi completeness FAIL và theo lô
    // nhỏ (xem shouldUseReserve() ở các vòng continuation bên dưới), không phải totalBudget ngay từ đầu.
    const budgetPlanOf = (stage) => {
      const base = calculateAdaptiveBudget({
        stage, problemText, historyText, contextsText, approachText: input.approachText,
        hasImage: !!input.image, deepThinking: input.deepThinking, crossCheck: input.crossCheck,
        remainingMs: globalDeadline.remaining(),
        // PHẦN J: throughput ĐO THẬT của các target đang khả dụng thay cho hằng số 60 tok/s — quyết
        // định "trong thời gian còn lại model kịp sinh bao nhiêu token" phải khác nhau giữa 1
        // provider 110 tok/s và 1 provider 30 tok/s, nếu không sẽ hoặc cắt sớm hoặc timeout giữa stream.
        throughputTokensPerSec: throughputStats.getRepresentativeThroughput(activeProviders)
      });
      const { coreBudget, reserveBudget, totalBudget } = tokenEconomy.allocateCoreReserve(base.target);
      return { ...base, coreBudget, reserveBudget, totalBudget };
    };
    // Giữ tên cũ cho các nơi vẫn cần {min,target,max} thô (vd budget hiển thị debug) — KHÔNG còn
    // dùng .target trực tiếp làm maxTokens của lượt gọi model thật (xem trên).
    const budgetOf = budgetPlanOf;

    // ---------- TOKEN ECONOMY ENGINE (mục 21) ----------
    // Lớp điều phối bọc ngoài pipeline hiện có: phân lớp bài (MICRO..VERY_COMPLEX), kiểm tra cache
    // L1 (request đã chuẩn hoá), model routing theo độ phức tạp.
    // ---------- FIX PHẦN 2: canonical request fingerprint — cache key giờ phủ ĐẦY ĐỦ ngữ cảnh ảnh
    // hưởng output, không chỉ problem/stage/deepThinking/crossCheck/approach như trước (nguy cơ
    // collision: cùng đề + source khác nhau, hoặc cùng đề + ngôn ngữ/lớp/trường khác nhau, trước đây
    // có thể trả NHẦM kết quả đã cache của nhau). Ảnh: bypass hẳn L1 (xem tokenEconomy.js).
    const requirementsList = extractCoverageList(problemText);
    const teTelemetry = new tokenEconomy.TelemetryRecorder();
    const sourceIdsFp = effectiveContexts.map((c) => `${c.doc}#${c.id}#${c.citeNo}`).sort().join(',');
    const tePlan = tokenEconomy.runTokenEconomyPipeline({
      problemText, historyText, contextsText, approachText: input.approachText,
      contexts: input.contexts, history: compressedHistory, stage: input.stage,
      hasImage: !!input.image, hasDrawing: /```(shape|solid3d|plot)/.test(problemText + input.approachText),
      deepThinking: !!input.deepThinking, crossCheck: !!input.crossCheck,
      remainingMs: globalDeadline.remaining(), requirements: requirementsList,
      cacheKeyExtra: {
        promptVersion: PROMPT_VERSION,
        lang: input.settings.lang,
        detail: input.settings.detail,
        school: input.settings.school,
        grade: input.settings.grade,
        subjectId: input.subjectId,
        secondarySubjectId: input.secondarySubjectId,
        approachFp: tokenEconomy.fingerprint(input.approachText),
        rulesFp: tokenEconomy.fingerprint(input.rules.join('|')),
        sourceIdsFp: tokenEconomy.fingerprint(sourceIdsFp),
        contextsFp: tokenEconomy.fingerprint(contextsText),
        // PHẦN 20 FIX: fingerprint THẬT (SHA-256) của đúng ảnh này khi có — cho phép cache an toàn
        // theo từng ảnh cụ thể thay vì bypass hoàn toàn L1 (xem tokenEconomy.runTokenEconomyPipeline).
        ...(input.image ? { imageFp: tokenEconomy.imageFingerprint(input.image.base64, input.image.mediaType) } : {})
      }
    });
    reqLogger.log({
      stage: 'token_economy_classify', problemClass: tePlan.classification.problemClass,
      modelTier: tePlan.modelTier, cacheHit: tePlan.cacheHit, coreBudget: tePlan.budget.coreBudget,
      reserveBudget: tePlan.budget.reserveBudget
    });

    // ---------- Cache hit: trả thẳng response đã tính trước, KHÔNG gọi lại AI (mục 21.18) ----------
    if (tePlan.cacheHit && tePlan.cachedValue) {
      reqLogger.log({ stage: 'token_economy_cache_hit' });
      if (wantsStream) {
        sseHeaders(res);
        sseWrite(res, 'delta', { text: tePlan.cachedValue.text });
        sseWrite(res, 'done', { ...tePlan.cachedValue, fromCache: true });
        return res.end();
      }
      return res.json({ ...tePlan.cachedValue, fromCache: true });
    }

    // ============================================================================================
    // ---------- NHÁNH STREAMING (SSE) — chỉ áp dụng khi client gửi { stream: true } ----------
    // Chế độ "hướng giải" và "giải chi tiết KHÔNG sâu" chỉ có 1 lượt gọi AI duy nhất nên stream trực
    // tiếp toàn bộ. Chế độ Sâu + giai đoạn "giải chi tiết" vẫn cần thu thập nhiều lượt giải độc lập
    // song song trước (không hiển thị cho người dùng) rồi mới tổng hợp — chỉ lượt TỔNG HỢP cuối
    // cùng (thứ người dùng thực sự đọc) được stream, các lượt thu thập trước đó báo tiến trình qua
    // sự kiện "status" vì bản thân chúng không hiển thị trực tiếp lên giao diện.
    // ============================================================================================
    if (wantsStream) {
      sseHeaders(res);
      req.on('close', () => { try { res.end(); } catch (e) { /* đã đóng — bỏ qua */ } });

      try {
        if (input.crossCheck && input.stage === 'detail') {
          // PHẦN D (TIER 4): dùng system prompt ĐÃ nén boilerplate (systemPack) thay vì dựng lại —
          // vừa hiện thực hoá phần token tiết kiệm được, vừa bỏ 1 lần build prompt trùng lặp.
          const system = systemPack.text;
          const variantSystem = system + buildVariantAddendum();

          // Mục XII/XXII (spec token-compression v2): KHÔNG được giảm SỐ LƯỢNG candidate cross-check
          // chỉ vì risk thấp — token saving CHỈ được đến từ nén representation/context, không phải
          // giảm verification. Luôn dùng CROSS_CHECK_MAX_CANDIDATES mặc định (>=2, tôn trọng lựa
          // chọn "Đối chiếu đa hướng" của người dùng đầy đủ, mọi problemClass).

          sseWrite(res, 'status', { message: 'Đang đối chiếu đa hướng…' });

          // Heartbeat: trong lúc thu thập các lượt giải (có thể im lặng nhiều giây, đặc biệt khi
          // đang thử lại provider lỗi), gửi định kỳ 1 comment SSE rỗng (":\n\n" — không phải sự
          // kiện, trình duyệt bỏ qua) để giữ kết nối "sống" trong mắt các proxy/CDN trung gian (vd
          // Vercel Edge Network) — tránh bị coi là kết nối treo và đóng ngang trước khi có dữ liệu.
          const heartbeat = setInterval(() => { try { res.write(':\n\n'); } catch (e) { /* đã đóng */ } }, 8000);

          let candidates;
          try {
            const gathered = await gatherCrossCheckCandidates(activeProviders, {
              system, variantSystem, messages, maxTokens: budgetOf('candidate').coreBudget, requestId: reqLogger.requestId,
              deepThinking: input.deepThinking,
              onStatus: (message) => sseWrite(res, 'status', { message }),
              deadline: globalDeadline, // mục 4/6: dùng chung 1 đồng hồ với toàn bộ request, không tự tạo riêng
              requireVision: !!input.image,
              signal
            });
            candidates = gathered.candidates;
          } finally {
            clearInterval(heartbeat);
          }

          if (!candidates.length) {
            sseWrite(res, 'error', { message: 'Tất cả nhà cung cấp AI đã cấu hình đều gặp lỗi khi giải bài. Vui lòng kiểm tra lại API key trong .env.' });
            return res.end();
          }

          // TRƯỚC ĐÂY: `const hasWebSearch = true;` hardcode — luôn cấp web cho MỌI lượt tổng hợp bất
          // kể tài liệu người dùng đã đủ hay chưa (mục 11 cấm việc này). NAY: gate ở TẦNG APPLICATION
          // bằng analyzeSourceCoverage() (mục 9/10/13) — chỉ cấp công cụ web khi source thực sự CHƯA
          // đủ theo TỪNG YÊU CẦU của đề bài (hoặc context có thể chỉ là excerpt bị clip — mục 9), và
          // prompt (buildSourcePolicyBlock) vẫn nói rõ CHỈ được dùng web cho đúng phần còn thiếu đó.
          const sourceCoverage = analyzeSourceCoverage({ problemText, contexts: input.contexts });
          const hasWebSearch = sourceCoverage.webRequired;
          const agreement = candidatesAgree(candidates);
          const reconcileStage = agreement ? 'reconcileLight' : 'reconcile';
          const reconcileSystem = buildReconcileSystemPrompt({
            // candidates ở đây đã được strip <thinking>/<think> ngay từ gatherCrossCheckCandidates()
            // (xem server/utils/aiProviders.js) — không cần strip lại ở đây.
            candidates,
            contexts: input.contexts,
            settings: input.settings,
            hasWebSearch,
            deepThinking: input.deepThinking,
            agreement,
            subjectId: input.subjectId
          });

          sseWrite(res, 'status', { message: agreement ? 'Các hướng giải đã khớp nhau, đang trình bày lại…' : 'Đang tổng hợp lời giải cuối cùng…' });

          sseWrite(res, 'status', { state: STATES.GENERATING, message: 'Đang tổng hợp lời giải cuối cùng…' });

          // ---------- PHẦN B/L: RESUMABLE STREAM (checkpoint + failover A->B->C->D) ----------
          // Toàn bộ vòng continuation trước đây (viết tay tại đây, không đọc partialError, không
          // biết interrupted, có thể gọi lại đúng target vừa chết) được thay bằng runResumableStream:
          // giữ nguyên phần đã stream, đánh dấu interrupted, chuyển sang target KHÁC, gửi ngữ cảnh
          // TỐI THIỂU, chống lặp text ở điểm nối. Người dùng vẫn chỉ thấy MỘT câu trả lời liên tục.
          const coverageList = extractCoverageList(problemText);
          const reconcileReserveState = { budget: budgetOf(reconcileStage).reserveBudget, used: 0 };
          const reconcileRun = await runResumableStream({
            providers: activeProviders,
            streamFn: streamWithFailover,
            messages,
            sessionInit: {
              requestStage: 'detail', requestId: reqLogger.requestId,
              coreBudget: budgetOf(reconcileStage).coreBudget,
              totalBudget: budgetOf(reconcileStage).totalBudget,
              recoveryBudget: reconcileReserveState.budget,
              inputTokens: compressionTelemetry.rawInputTokens,
              compressedInputTokens: compressionTelemetry.compressedInputTokens
            },
            buildArgs: ({ messages: msgs, maxTokens }) => ({
              system: reconcileSystem, messages: msgs, maxTokens,
              webSearch: hasWebSearch, timeoutMs: RECONCILE_TIMEOUT_MS,
              requestId: reqLogger.requestId, deepThinking: input.deepThinking, signal
            }),
            streamOpts: { preferWebSearch: hasWebSearch, requireVision: !!input.image },
            onDelta: (piece) => sseWrite(res, 'delta', { text: piece }),
            onStatus: (st) => sseWrite(res, 'status', { state: STATES.RECOVERING, message: st.message }),
            evaluate: (text, sig) => checkCompletenessWithDrawings(text, {
              stage: 'detail', coverageList, approachText: input.approachText,
              contexts: input.contexts, finishReason: sig.finishReason, interrupted: sig.interrupted,
              validCiteNos: citationIndex.validCiteNos, aliasOf: citationIndex.aliasOf
            }),
            resolveRecovery: makeRecoveryResolver({
              reserveState: reconcileReserveState, deadline: globalDeadline,
              recalcTarget: () => budgetOf(reconcileStage).target
            }),
            deadline: globalDeadline,
            signal,
            isDisconnected: () => disconnected
          });

          const full = reconcileRun.text;
          const completeness = reconcileRun.completeness;
          const continuations = reconcileRun.continuations;
          const reconciler = reconcileRun.provider || { label: 'unknown' };

          if (disconnected) return;

          // ---------- Trạng thái cuối: COMPLETED / PARTIAL / FAILED (PHẦN C + runtimeState.js) ----------
          // KHÔNG BAO GIỜ gắn COMPLETED cho response còn HARD. Nhưng cũng KHÔNG xoá phần đã sinh:
          // nếu đã hết đường recovery mà nội dung vẫn dùng được -> giao ra ở trạng thái PARTIAL kèm
          // nhãn/lý do rõ ràng (xem classifyFinalOutcome + public/js/app.js).
          const outcome = classifyFinalOutcome(completeness, { textLength: full.length });
          reqLogger.log({ stage: 'resumable_stream_done', ...reconcileRun.session.snapshot(), finalStatus: outcome.state, duplicateCharsRemoved: reconcileRun.duplicateCharsRemoved });

          if (outcome.state === STATES.FAILED) {
            sseWrite(res, 'error', {
              message: 'Câu trả lời chưa đầy đủ sau khi đã thử khôi phục — không thể coi là hoàn thành.',
              state: STATES.FAILED,
              completeness: completeness.status,
              citationValidation: completeness.citationValidation || null,
              text: full,
              continuations
            });
            return res.end();
          }

          const donePayload = {
            ...subjectPayload,
            state: outcome.state,
            partial: outcome.partial,
            text: full,
            crossChecked: true,
            providers: candidates.map((c) => c.label),
            reconciledBy: reconciler.label,
            completeness: completeness.status,
            incompleteReasons: outcome.partial ? (completeness.hardReasons || []) : [],
            citationValidation: completeness.citationValidation || null,
            continuations,
            resumes: reconcileRun.resumes,
            citationMap: citationIndex.citationMap
          };
          // PHẦN P: KHÔNG BAO GIỜ cache response PARTIAL/interrupted/chưa validate — chỉ cache khi
          // thực sự COMPLETED (partial=false), nếu không lần sau sẽ trả lại đúng câu trả lời bị cắt.
          if (!tePlan.cacheBypassed && !outcome.partial) tokenEconomy.globalCache.set('L1', tePlan.cacheKeyParts, donePayload);
          if (!outcome.partial) tokenEconomy.recordOutcome(tePlan.classification.problemClass, reconcileStage, full.length / 3.2);
          teTelemetry.record('inputTokens', compressionTelemetry.compressedInputTokens);
          teTelemetry.record('outputTokens', full.length / 3.2);
          teTelemetry.record('continuationTokens', reconcileRun.session.continuationTokens);
          reqLogger.log({ stage: 'token_economy_telemetry', ...teTelemetry.snapshot(), ...compressionTelemetry });
          sseWrite(res, 'done', donePayload);
          return res.end();
        }

        // ---------- Giai đoạn "hướng giải" hoặc chế độ "Nhanh": stream trực tiếp 1 lượt duy nhất ----------
        const system = systemPack.text; // PHẦN D (TIER 4): bản đã nén boilerplate
        // LỖI GỐC (ảnh người dùng gửi): giai đoạn "hướng giải" (approach) bị cắt ngang giữa
        // câu ("- Khai thác tính") vì maxTokens cố định 700 bất kể độ dài đề bài/deepThinking. FIX:
        // dùng ADAPTIVE TOKEN BUDGET (mục III, xem adaptiveBudget.js) thay vì hằng số cố định.
        const directBudget = budgetOf(input.stage === 'approach' ? 'approach' : 'detail');
        // PHẦN 8 FIX: modelTier (đã tính ở tePlan) nay THỰC SỰ ảnh hưởng lựa chọn model — trước đây
        // chỉ log (dead optimization). 'cheap'/'fast' tier -> model nhẹ; 'standard'/'strong'/
        // 'strong_reasoning' -> model đầy đủ dù deepThinking chưa bật (không ép fast cho bài phức tạp).
        const useFastModel = callMode.fast && tokenEconomy.tierUsesFastModel(tePlan.modelTier);
        sseWrite(res, 'status', { state: STATES.GENERATING, message: 'Đang tạo câu trả lời…' });

        // ---------- PHẦN B/L: RESUMABLE STREAM cho nhánh 1 lượt (approach / Nhanh) ----------
        const coverageList = extractCoverageList(problemText);
        const directReserveState = { budget: directBudget.reserveBudget, used: 0 };
        const directStageName = input.stage === 'approach' ? 'approach' : 'detail';
        const directRun = await runResumableStream({
          providers: activeProviders,
          streamFn: streamWithFailover,
          messages,
          sessionInit: {
            requestStage: directStageName, requestId: reqLogger.requestId,
            coreBudget: directBudget.coreBudget,
            totalBudget: directBudget.totalBudget,
            recoveryBudget: directReserveState.budget,
            inputTokens: compressionTelemetry.rawInputTokens,
            compressedInputTokens: compressionTelemetry.compressedInputTokens
          },
          buildArgs: ({ messages: msgs, maxTokens }) => ({
            system, messages: msgs, maxTokens, fast: useFastModel,
            deepThinking: input.deepThinking, requestId: reqLogger.requestId, signal
          }),
          streamOpts: { requireVision: !!input.image },
          onDelta: (piece) => sseWrite(res, 'delta', { text: piece }),
          onStatus: (st) => sseWrite(res, 'status', { state: STATES.RECOVERING, message: st.message }),
          evaluate: (text, sig) => checkCompletenessWithDrawings(text, {
            stage: input.stage, coverageList, approachText: input.approachText,
            contexts: input.contexts, finishReason: sig.finishReason, interrupted: sig.interrupted,
            validCiteNos: citationIndex.validCiteNos, aliasOf: citationIndex.aliasOf
          }),
          resolveRecovery: makeRecoveryResolver({
            reserveState: directReserveState, deadline: globalDeadline,
            recalcTarget: () => budgetOf(directStageName).target
          }),
          deadline: globalDeadline,
          signal,
          isDisconnected: () => disconnected
        });

        let full = directRun.text;
        const completeness = directRun.completeness;
        const continuations = directRun.continuations;
        const provider = directRun.provider || { label: 'unknown' };

        // mục 4: client đã ngắt kết nối — KHÔNG gửi thêm event nào, KHÔNG ghi cache, KHÔNG báo COMPLETED.
        if (disconnected) return;

        const directOutcome = classifyFinalOutcome(completeness, { textLength: full.length });
        reqLogger.log({ stage: 'resumable_stream_done', ...directRun.session.snapshot(), finalStatus: directOutcome.state, duplicateCharsRemoved: directRun.duplicateCharsRemoved });

        if (directOutcome.state === STATES.FAILED) {
          sseWrite(res, 'error', {
            message: 'Câu trả lời chưa đầy đủ sau khi đã thử khôi phục — không thể coi là hoàn thành.',
            state: STATES.FAILED,
            completeness: completeness.status,
            citationValidation: completeness.citationValidation || null,
            text: full,
            continuations
          });
          return res.end();
        }

        // Mục II: chỉ áp dụng cho stage 'approach' — repair NGẮN nếu vi phạm compactness contract.
        full = await maybeRepairApproach({
          stageName: directStageName, text: full, activeProviders,
          requestId: reqLogger.requestId, signal, deadline: globalDeadline, reqLogger
        });

        const directDonePayload = {
          ...subjectPayload,
          state: directOutcome.state,
          partial: directOutcome.partial,
          text: full, crossChecked: false, provider: provider.label,
          completeness: completeness.status,
          incompleteReasons: directOutcome.partial ? (completeness.hardReasons || []) : [],
          citationValidation: completeness.citationValidation || null,
          continuations,
          resumes: directRun.resumes,
          citationMap: citationIndex.citationMap
        };
        // PHẦN P: chỉ cache khi COMPLETED thật (không cache partial/interrupted).
        if (!tePlan.cacheBypassed && !directOutcome.partial) tokenEconomy.globalCache.set('L1', tePlan.cacheKeyParts, directDonePayload);
        if (!directOutcome.partial) tokenEconomy.recordOutcome(tePlan.classification.problemClass, directStageName, full.length / 3.2);
        teTelemetry.record('inputTokens', compressionTelemetry.compressedInputTokens);
        teTelemetry.record('outputTokens', full.length / 3.2);
        teTelemetry.record('continuationTokens', directRun.session.continuationTokens);
        reqLogger.log({ stage: 'token_economy_telemetry', ...teTelemetry.snapshot(), ...compressionTelemetry });
        sseWrite(res, 'done', directDonePayload);
        return res.end();
      } catch (streamErr) {
        // Header SSE đã gửi (200 text/event-stream) — không thể chuyển sang next(err) để trả JSON
        // lỗi như luồng thường (sẽ crash vì response đã bắt đầu). Phát sự kiện "error" riêng cho
        // client tự xử lý, rồi đóng kết nối.
        // P0 mục 2: đi qua CHUNG normalizeError() như errorHandler.js — tránh lộ raw streamErr.message
        // (có thể tới từ 1 client provider nào đó lỡ không sanitize) trực tiếp qua SSE, bỏ qua toàn
        // bộ lớp chuẩn hóa lỗi dùng cho response JSON thường.
        const normalized = normalizeError(streamErr);
        sseWrite(res, 'error', {
          message: normalized.userMessage,
          code: normalized.code,
          retryable: normalized.retryable
        });
        return res.end();
      }
    }

    // ---------- Công tắc "Đối chiếu đa hướng" + giai đoạn "giải chi tiết": đối chiếu đa mô hình ----------
    // Đây là công tắc ĐỘC LẬP với "Suy nghĩ sâu" (deepThinking chỉ ảnh hưởng suy luận NỘI BỘ của
    // từng lượt gọi — xem promptBuilder.js) — bật/tắt riêng, không phụ thuộc lẫn nhau.
    // KHÔNG có nhà cung cấp AI nào "chính"/"phụ" — mọi provider đang cấu hình khóa API đều giải
    // 1 lượt ĐỘC LẬP SONG SONG (nếu chỉ có 1 provider thì chính provider đó tự làm cả 2 lượt với
    // 2 góc nhìn khác nhau, vì không còn lựa chọn nào khác). Nếu 1 provider báo lỗi ở lượt của nó,
    // hệ thống TỰ ĐỘNG thử lại lượt đó bằng 1 provider KHÁC còn hoạt động (failover) để không mất
    // đi cơ hội đối chiếu chéo. Lượt TỔNG HỢP cuối cùng cũng KHÔNG cố định vào 1 nhà cung cấp nào —
    // được chọn NGẪU NHIÊN trong số các provider đang hoạt động (ưu tiên provider hỗ trợ tìm kiếm
    // web khi cần xác minh công thức), và cũng có failover tự động nếu provider được chọn lỗi.
    // (Chỉ áp dụng cho giai đoạn giải chi tiết — giai đoạn "hướng giải" luôn dùng 1 lượt gọi, nhanh gọn.)
    // LƯU Ý: nhánh JSON thường (không streaming) này chỉ còn được dùng khi trình duyệt không hỗ
    // trợ ReadableStream (xem apiPostStream() ở public/js/app.js) — client bình thường luôn gửi
    // stream:true nên chạy qua nhánh SSE phía trên. Dùng chung gatherCrossCheckCandidates() (có
    // ngân sách thời gian tổng + thử lại provider lỗi SONG SONG) để tránh lặp logic và tránh cộng
    // dồn thời gian chờ tuần tự — xem giải thích chi tiết ở đầu server/utils/aiProviders.js.
    if (input.crossCheck && input.stage === 'detail') {
      const system = systemPack.text; // PHẦN D (TIER 4): bản đã nén boilerplate
      const variantSystem = system + buildVariantAddendum();

      // Mục XII/XXII: xem giải thích đầy đủ ở nhánh streaming phía trên — không giảm số candidate
      // theo risk, luôn dùng CROSS_CHECK_MAX_CANDIDATES mặc định.
      const { candidates } = await gatherCrossCheckCandidates(activeProviders, {
        system, variantSystem, messages, maxTokens: budgetOf('candidate').coreBudget, requestId: reqLogger.requestId,
        deepThinking: input.deepThinking,
        deadline: globalDeadline, // mục 4/6
        requireVision: !!input.image,
        signal
      });

      if (!candidates.length) {
        const err = new Error('Tất cả nhà cung cấp AI đã cấu hình đều gặp lỗi khi giải bài. Vui lòng kiểm tra lại API key trong .env.');
        err.status = 502;
        throw err;
      }

      // Xem giải thích đầy đủ ở nhánh streaming phía trên — cùng lý do, cùng logic (mục 9/10/11).
      const sourceCoverage = analyzeSourceCoverage({ problemText, contexts: input.contexts });
      const hasWebSearch = sourceCoverage.webRequired;
      const agreement = candidatesAgree(candidates);
      const reconcileStage = agreement ? 'reconcileLight' : 'reconcile';
      const reconcileSystem = buildReconcileSystemPrompt({
        // candidates ở đây đã được strip <thinking>/<think> ngay từ gatherCrossCheckCandidates()
        // (xem server/utils/aiProviders.js) — không cần strip lại ở đây.
        candidates,
        contexts: input.contexts,
        settings: input.settings,
        hasWebSearch,
        deepThinking: input.deepThinking,
        agreement,
        subjectId: input.subjectId
      });

      const initial = await callWithFailover(
        activeProviders,
        { system: reconcileSystem, messages, maxTokens: budgetOf(reconcileStage).coreBudget, webSearch: hasWebSearch, timeoutMs: RECONCILE_TIMEOUT_MS, requestId: reqLogger.requestId, deepThinking: input.deepThinking, signal },
        { preferWebSearch: hasWebSearch, deadline: globalDeadline, requireVision: !!input.image } // mục 4/6
      );

      // FIX PHẦN 3/6 + mục 4 audit continuation: continuation dùng RESERVE (lô nhỏ dần), có thể MỞ
      // RỘNG động khi thực sự cần (xem resolveReserveDecision) thay vì hard-cap 30% cố định.
      const jsonReconcileReserveState = { budget: budgetOf(reconcileStage).reserveBudget, used: 0 };
      const jsonReconcileRecovery = makeRecoveryResolver({
        reserveState: jsonReconcileReserveState, deadline: globalDeadline,
        recalcTarget: () => budgetOf(reconcileStage).target
      });
      const { text: finalText, completeness, continuations, provider: reconciler, partial: reconcilePartial } = await ensureCompleteNonStream(
        (msgs, _currentCompleteness, grantedMaxTokens) => callWithFailover(
          activeProviders,
          { system: reconcileSystem, messages: msgs, maxTokens: grantedMaxTokens, webSearch: hasWebSearch, timeoutMs: RECONCILE_TIMEOUT_MS, requestId: reqLogger.requestId, deepThinking: input.deepThinking, signal },
          { preferWebSearch: hasWebSearch, deadline: globalDeadline, requireVision: !!input.image }
        ),
        initial,
        {
          messages, problemText, stage: 'detail', deadline: globalDeadline,
          approachText: input.approachText, contexts: input.contexts, signal,
          requestId: reqLogger.requestId,
          validCiteNos: citationIndex.validCiteNos, aliasOf: citationIndex.aliasOf,
          resolveRecovery: jsonReconcileRecovery,
          isDisconnected: () => disconnected
        }
      );

      // mục 4: client đã ngắt kết nối trong lúc chờ — không còn ai để nhận response, không ghi cache
      // kết quả (dù đã COMPLETE) cho 1 request đã bị hủy, không tốn thêm việc serialize/gửi JSON.
      if (disconnected) return;

      // ensureCompleteNonStream() đã assertFinalResponseComplete() ở trên — tới được đây nghĩa là
      // completeness.status chắc chắn === 'COMPLETE' (mục 1/2/14).
      const jsonDonePayload = {
        ...subjectPayload,
        state: reconcilePartial ? STATES.PARTIAL : STATES.COMPLETED,
        partial: !!reconcilePartial,
        text: finalText,
        crossChecked: true,
        providers: candidates.map((c) => c.label),
        reconciledBy: reconciler.label,
        completeness: completeness.status,
            citationValidation: completeness.citationValidation || null,
        continuations,
        citationMap: citationIndex.citationMap
      };
      if (!tePlan.cacheBypassed && !reconcilePartial) tokenEconomy.globalCache.set('L1', tePlan.cacheKeyParts, jsonDonePayload);
      if (!reconcilePartial) tokenEconomy.recordOutcome(tePlan.classification.problemClass, reconcileStage, finalText.length / 3.2);
      teTelemetry.record('outputTokens', finalText.length / 3.2);
      reqLogger.log({ stage: 'token_economy_telemetry', ...teTelemetry.snapshot() });
      return res.json(jsonDonePayload);
    }

    // ---------- Giai đoạn "hướng giải" hoặc chế độ "Nhanh": đua tốc độ giữa các provider ----------
    // Không cố định vào 1 nhà cung cấp — mỗi request ĐUA TỐC ĐỘ đồng thời vài provider ngẫu nhiên
    // (callFastest) và dùng ngay kết quả của provider trả lời nhanh nhất, kèm model "nhanh" riêng
    // (fast:true) để giảm độ trễ. Nếu (các) provider trong nhóm đua đều lỗi/timeout, tự động mở
    // rộng đua sang provider còn lại trước khi báo lỗi cho người dùng.
    // ---------- mục 1: deepThinking=true KHÔNG đua tốc độ ----------
    // callFastest() ưu tiên latency (đua song song, dùng model nhanh) — đúng tinh thần chế độ Nhanh
    // nhưng SAI tinh thần "Suy nghĩ sâu" (ưu tiên capability, không phải tốc độ). deepThinking=true
    // chuyển sang callWithFailover() — vẫn tự động failover khi lỗi, nhưng thử TUẦN TỰ theo rotation
    // công bằng với model ĐẦY ĐỦ (fast:false) thay vì đua nhiều target bằng model nhẹ.
    const system = systemPack.text; // PHẦN D (TIER 4): bản đã nén boilerplate
    const directBudget = budgetOf(input.stage === 'approach' ? 'approach' : 'detail');
    const directCaller = callMode.fast ? callFastest : callWithFailover;
    // PHẦN 8 FIX: modelTier THỰC SỰ ảnh hưởng lựa chọn model (trước đây chỉ log — dead optimization).
    const useFastModel = callMode.fast && tokenEconomy.tierUsesFastModel(tePlan.modelTier);
    const initialDirect = await directCaller(
      activeProviders,
      { system, messages, maxTokens: directBudget.coreBudget, fast: useFastModel, deepThinking: input.deepThinking, requestId: reqLogger.requestId, signal },
      { deadline: globalDeadline, requireVision: !!input.image } // mục 4/6
    );

    // FIX PHẦN 3/6 + mục 4 audit continuation: continuation dùng RESERVE (lô nhỏ dần), có thể MỞ
    // RỘNG động khi thực sự cần (xem resolveReserveDecision) thay vì hard-cap 30% cố định.
    const jsonDirectReserveState = { budget: directBudget.reserveBudget, used: 0 };
    const jsonDirectRecovery = makeRecoveryResolver({
      reserveState: jsonDirectReserveState, deadline: globalDeadline,
      recalcTarget: () => budgetOf(input.stage === 'approach' ? 'approach' : 'detail').target
    });
    let { text, completeness, continuations, provider, partial: directJsonPartial } = await ensureCompleteNonStream(
      (msgs, _currentCompleteness, grantedMaxTokens) => directCaller(
        activeProviders,
        { system, messages: msgs, maxTokens: grantedMaxTokens, fast: useFastModel, deepThinking: input.deepThinking, requestId: reqLogger.requestId, signal },
        { deadline: globalDeadline, requireVision: !!input.image }
      ),
      initialDirect,
      {
        messages, problemText, stage: input.stage, deadline: globalDeadline,
        approachText: input.approachText, contexts: input.contexts, signal,
        requestId: reqLogger.requestId,
        validCiteNos: citationIndex.validCiteNos, aliasOf: citationIndex.aliasOf,
        resolveRecovery: jsonDirectRecovery,
        isDisconnected: () => disconnected
      }
    );

    // mục 4: xem giải thích ở nhánh cross-check JSON phía trên — cùng lý do.
    if (disconnected) return;

    // Mục II: repair NGẮN cho stage 'approach' nếu vi phạm compactness contract (xem streaming ở trên).
    text = await maybeRepairApproach({
      stageName: input.stage === 'approach' ? 'approach' : 'detail', text, activeProviders,
      requestId: reqLogger.requestId, signal, deadline: globalDeadline, reqLogger
    });

    // ensureCompleteNonStream() đã assertFinalResponseComplete() — chắc chắn COMPLETE tới đây.
    const finalJsonPayload = { ...subjectPayload, state: directJsonPartial ? STATES.PARTIAL : STATES.COMPLETED, partial: !!directJsonPartial, text, crossChecked: false, provider: provider.label, completeness: completeness.status, incompleteReasons: directJsonPartial ? (completeness.hardReasons || []) : [], citationValidation: completeness.citationValidation || null, continuations, citationMap: citationIndex.citationMap };
    if (!tePlan.cacheBypassed && !directJsonPartial) tokenEconomy.globalCache.set('L1', tePlan.cacheKeyParts, finalJsonPayload);
    if (!directJsonPartial) tokenEconomy.recordOutcome(tePlan.classification.problemClass, input.stage === 'approach' ? 'approach' : 'detail', text.length / 3.2);
    teTelemetry.record('inputTokens', compressionTelemetry.compressedInputTokens);
    teTelemetry.record('outputTokens', text.length / 3.2);
    reqLogger.log({ stage: 'token_economy_telemetry', ...teTelemetry.snapshot() });
    res.json(finalJsonPayload);
  } catch (err) {
    // mục 4: lỗi (bao gồm err.cancelled từ abortLink.js khi bị hủy) xảy ra SAU KHI client đã ngắt
    // kết nối — không còn ai để nhận response, gọi next(err) chỉ tạo thêm 1 lượt ghi log lỗi 499
    // không cần thiết cho 1 lượt hủy chủ động, và tránh Express cố set header/ghi lên socket đã đóng.
    if (disconnected || (err && err.cancelled)) return;
    next(err);
  }
});

module.exports = router;
