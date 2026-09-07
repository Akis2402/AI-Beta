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
const { normalizeError } = require('../utils/errorNormalize');
const { calculateAdaptiveBudget } = require('../utils/adaptiveBudget');
const { compressHistoryForBudget } = require('../utils/semanticCompression');
const { validateSolutionCompleteness, extractCoverageList } = require('../utils/completenessCheck');
const { MAX_CONTINUATIONS, appendContinuationTurn } = require('../utils/continuation');
const { validateAllDrawingBlocks, checkCanonicalDrawingConsistency } = require('../utils/drawingValidator');
const { createRequestDeadline } = require('../utils/requestDeadline');
const { STATES, isFinalSuccess, assertFinalResponseComplete } = require('../utils/runtimeState');
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
 * Chạy completeness check + tối đa MAX_CONTINUATIONS lượt continuation (mục V/VI) cho MỘT response
 * cuối cùng (thứ người dùng thực sự đọc) — KHÔNG áp dụng cho từng candidate thu thập nội bộ (mục
 * XIV: chỉ tốn thêm lượt gọi AI khi thực sự có lợi cho response cuối).
 *
 * @param {Function} callOnce (msgs) => Promise<{text, provider}> — 1 lượt gọi (không stream).
 * @param {{messages:Array, problemText:string, stage:string, deadline:object}} ctx
 * @returns {Promise<{text:string, completeness:object, continuations:number, provider:object}>}
 */
async function ensureCompleteNonStream(callOnce, initialResult, ctx) {
  const coverageList = extractCoverageList(ctx.problemText);
  let text = initialResult.text;
  let provider = initialResult.provider;
  let completeness = checkCompletenessWithDrawings(text, { stage: ctx.stage, coverageList, approachText: ctx.approachText, contexts: ctx.contexts });
  let continuations = 0;

  while (
    completeness.status === 'INCOMPLETE' &&
    continuations < MAX_CONTINUATIONS &&
    ctx.deadline.remaining() > 8000 &&
    !(ctx.signal && ctx.signal.aborted) // mục 4: client đã hủy — dừng continuation ngay, không gọi thêm provider
  ) {
    const contMessages = appendContinuationTurn(ctx.messages, text, completeness);
    let contResult;
    try {
      contResult = await callOnce(contMessages);
    } catch (e) {
      break; // provider lỗi ở continuation — dừng, rơi xuống assertFinalResponseComplete() bên dưới (mục 1/2)
    }
    // PHẦN 2 FIX: reserve hết (callOnce trả sentinel thay vì gọi AI) — dừng ngay, KHÔNG tính là 1 lượt
    // gọi AI thành công, KHÔNG cố nối thêm. Rơi xuống assertFinalResponseComplete() như hết ngân sách.
    if (contResult && contResult.reserveExhausted) break;
    text = text + '\n' + contResult.text;
    provider = contResult.provider;
    continuations += 1;
    completeness = checkCompletenessWithDrawings(text, { stage: ctx.stage, coverageList, approachText: ctx.approachText, contexts: ctx.contexts });
  }

  // ---------- Cổng bắt buộc (mục 1/2/14): KHÔNG BAO GIỜ coi response này là thành công nếu chưa ----------
  // thực sự COMPLETE — kể cả khi đã hết MAX_CONTINUATIONS hoặc continuation bị lỗi provider giữa
  // chừng. assertFinalResponseComplete() ném lỗi (code=FINAL_RESPONSE_INCOMPLETE) để router bắt và
  // trả về lỗi/FAILED thay vì trả 200 kèm 1 kết quả vẫn còn INCOMPLETE/INVALID.
  assertFinalResponseComplete(completeness);

  return { text, completeness, continuations, provider };
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
    const contextsText = input.contexts.map((c) => c.text).join('\n');
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
    const historyText = compressedHistory.map((h) => h.content).join('\n');

    const messages = [
      ...compressedHistory.map((h) => ({ role: h.role, content: h.content })),
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
        remainingMs: globalDeadline.remaining()
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
    const sourceIdsFp = input.contexts.map((c) => `${c.doc}#${c.id}`).sort().join(',');
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
          const system = buildChatSystemPrompt({ ...input, problemText });
          const variantSystem = system + buildVariantAddendum();

          // PHẦN 10 FIX: crossCheckPolicy() nay THỰC SỰ điều khiển số candidate thu thập — trước đây
          // được tính (dead code) nhưng route luôn gọi cứng CROSS_CHECK_MAX_CANDIDATES bất kể risk.
          // Người dùng vẫn được tôn trọng lựa chọn bật "Đối chiếu đa hướng" (KHÔNG bỏ qua cross-check
          // hoàn toàn — vẫn >= 2 candidate để có gì đó đối chiếu), chỉ risk LOW mới giảm từ 3 -> 2.
          const ccPolicy = tokenEconomy.crossCheckPolicy({
            problemClass: tePlan.classification.problemClass,
            hasGeometryProof: tokenEconomy.detectGeometryProofHint(problemText)
          });
          const ccMaxCandidates = ccPolicy.risk === 'LOW' ? 2 : undefined; // undefined = giữ CROSS_CHECK_MAX_CANDIDATES mặc định

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
              ...(ccMaxCandidates ? { maxCandidates: ccMaxCandidates } : {}),
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

          let full = '';
          const { provider: reconciler } = await streamWithFailover(
            activeProviders,
            { system: reconcileSystem, messages, maxTokens: budgetOf(reconcileStage).coreBudget, webSearch: hasWebSearch, timeoutMs: RECONCILE_TIMEOUT_MS, requestId: reqLogger.requestId, deepThinking: input.deepThinking, signal },
            (piece) => { full += piece; sseWrite(res, 'delta', { text: piece }); },
            { preferWebSearch: hasWebSearch, deadline: globalDeadline, requireVision: !!input.image } // mục 4/6: cùng đồng hồ toàn request
          );

          // ---------- Completeness check + continuation (mục V/VI) trên response THẬT SỰ hiển thị ----------
          const coverageList = extractCoverageList(problemText);
          let completeness = checkCompletenessWithDrawings(full, { stage: 'detail', coverageList, approachText: input.approachText, contexts: input.contexts });
          let continuations = 0;
          // ---------- FIX PHẦN 3/6: continuation dùng RESERVE (lô nhỏ), KHÔNG xin lại full target ----------
          const reconcileReserveBudget = budgetOf(reconcileStage).reserveBudget;
          let reconcileReserveUsed = 0;
          while (completeness.status === 'INCOMPLETE' && continuations < MAX_CONTINUATIONS && globalDeadline.remaining() > 8000 && !disconnected) {
            const reserveDecision = tokenEconomy.shouldUseReserve(completeness, reconcileReserveUsed, reconcileReserveBudget);
            // PHẦN 2 FIX: reserve hết = KHÔNG ĐƯỢC gọi thêm AI. Fallback "Math.max(300, reserve*0.3)"
            // cũ có thể VƯỢT reserve còn lại (hard cap leak) — loại bỏ hoàn toàn, dừng vòng lặp ngay.
            if (!reserveDecision.allow) break;
            sseWrite(res, 'status', { state: STATES.RECOVERING, message: 'Câu trả lời chưa đầy đủ, đang khôi phục phần còn thiếu…' });
            const contMessages = appendContinuationTurn(messages, full, completeness);
            const contMaxTokens = reserveDecision.amount;
            let piece2 = '';
            try {
              await streamWithFailover(
                activeProviders,
                { system: reconcileSystem, messages: contMessages, maxTokens: contMaxTokens, webSearch: hasWebSearch, timeoutMs: RECONCILE_TIMEOUT_MS, requestId: reqLogger.requestId, deepThinking: input.deepThinking, signal },
                (piece) => { piece2 += piece; full += piece; sseWrite(res, 'delta', { text: piece }); },
                { preferWebSearch: hasWebSearch, deadline: globalDeadline, requireVision: !!input.image }
              );
            } catch (e) { break; }
            reconcileReserveUsed += contMaxTokens;
            continuations += 1;
            completeness = checkCompletenessWithDrawings(full, { stage: 'detail', coverageList, approachText: input.approachText, contexts: input.contexts });
          }

          // ---------- Cổng bắt buộc (mục 1/2): KHÔNG BAO GIỜ gửi "done" nếu chưa thực sự COMPLETE ----------
          // RECOVERING không thành công (vẫn INCOMPLETE) hoặc INVALID → gửi "error" (state FAILED),
          // KHÔNG gửi "done". Chỉ có đúng 1 đường tới "done": completeness.status === 'COMPLETE'.
          // mục 4: client đã ngắt kết nối — KHÔNG gửi thêm event nào (socket đã đóng), KHÔNG ghi
          // cache kết quả CHƯA CHẮC hoàn chỉnh, KHÔNG báo COMPLETED cho 1 request người dùng đã hủy.
          if (disconnected) return;

          if (!isFinalSuccess(completeness.status)) {
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
            state: STATES.COMPLETED,
            text: full,
            crossChecked: true,
            providers: candidates.map((c) => c.label),
            reconciledBy: reconciler.label,
            completeness: completeness.status,
            citationValidation: completeness.citationValidation || null,
            continuations
          };
          if (!tePlan.cacheBypassed) tokenEconomy.globalCache.set('L1', tePlan.cacheKeyParts, donePayload);
          tokenEconomy.recordOutcome(tePlan.classification.problemClass, reconcileStage, full.length / 3.2);
          teTelemetry.record('outputTokens', full.length / 3.2);
          teTelemetry.record('continuationTokens', continuations > 0 ? full.length / 3.2 * 0.2 : 0);
          reqLogger.log({ stage: 'token_economy_telemetry', ...teTelemetry.snapshot() });
          sseWrite(res, 'done', donePayload);
          return res.end();
        }

        // ---------- Giai đoạn "hướng giải" hoặc chế độ "Nhanh": stream trực tiếp 1 lượt duy nhất ----------
        const system = buildChatSystemPrompt({ ...input, problemText });
        let full = '';
        // LỖI GỐC (ảnh mới nhất người dùng gửi): giai đoạn "hướng giải" (approach) bị cắt ngang giữa
        // câu ("- Khai thác tính") vì maxTokens cố định 700 bất kể độ dài đề bài/deepThinking. FIX:
        // dùng ADAPTIVE TOKEN BUDGET (mục III, xem adaptiveBudget.js) thay vì hằng số cố định.
        const directBudget = budgetOf(input.stage === 'approach' ? 'approach' : 'detail');
        // PHẦN 8 FIX: modelTier (đã tính ở tePlan) nay THỰC SỰ ảnh hưởng lựa chọn model — trước đây
        // chỉ log (dead optimization). 'cheap'/'fast' tier -> model nhẹ; 'standard'/'strong'/
        // 'strong_reasoning' -> model đầy đủ dù deepThinking chưa bật (không ép fast cho bài phức tạp).
        const useFastModel = callMode.fast && tokenEconomy.tierUsesFastModel(tePlan.modelTier);
        sseWrite(res, 'status', { state: STATES.GENERATING, message: 'Đang tạo câu trả lời…' });
        const { provider } = await streamWithFailover(
          activeProviders,
          { system, messages, maxTokens: directBudget.coreBudget, fast: useFastModel, deepThinking: input.deepThinking, requestId: reqLogger.requestId, signal },
          (piece) => { full += piece; sseWrite(res, 'delta', { text: piece }); },
          { deadline: globalDeadline, requireVision: !!input.image } // mục 4/6
        );

        // ---------- Completeness check + continuation (mục V/VI) ----------
        const coverageList = extractCoverageList(problemText);
        let completeness = checkCompletenessWithDrawings(full, { stage: input.stage, coverageList, approachText: input.approachText, contexts: input.contexts });
        let continuations = 0;
        const directReserveBudget = directBudget.reserveBudget;
        let directReserveUsed = 0;
        while (completeness.status === 'INCOMPLETE' && continuations < MAX_CONTINUATIONS && globalDeadline.remaining() > 6000 && !disconnected) {
          // FIX PHẦN 3/6: dùng RESERVE (lô nhỏ), không xin lại budgetOf(stage).target đầy đủ.
          const reserveDecision = tokenEconomy.shouldUseReserve(completeness, directReserveUsed, directReserveBudget);
          // PHẦN 2 FIX: reserve hết = dừng ngay, không fallback token ngoài reserve (hard cap leak cũ).
          if (!reserveDecision.allow) break;
          sseWrite(res, 'status', { state: STATES.RECOVERING, message: 'Câu trả lời chưa đầy đủ, đang khôi phục phần còn thiếu…' });
          const contMessages = appendContinuationTurn(messages, full, completeness);
          const contMaxTokens = reserveDecision.amount;
          try {
            await streamWithFailover(
              activeProviders,
              { system, messages: contMessages, maxTokens: contMaxTokens, fast: useFastModel, deepThinking: input.deepThinking, requestId: reqLogger.requestId, signal },
              (piece) => { full += piece; sseWrite(res, 'delta', { text: piece }); },
              { deadline: globalDeadline, requireVision: !!input.image }
            );
          } catch (e) { break; }
          directReserveUsed += contMaxTokens;
          continuations += 1;
          completeness = checkCompletenessWithDrawings(full, { stage: input.stage, coverageList, approachText: input.approachText, contexts: input.contexts });
        }

        // mục 4: client đã ngắt kết nối — KHÔNG gửi thêm event nào, KHÔNG ghi cache, KHÔNG báo COMPLETED.
        if (disconnected) return;

        // ---------- Cổng bắt buộc (mục 1/2): KHÔNG BAO GIỜ gửi "done" nếu chưa thực sự COMPLETE ----------
        if (!isFinalSuccess(completeness.status)) {
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

        const directDonePayload = {
          ...subjectPayload,
          state: STATES.COMPLETED,
          text: full, crossChecked: false, provider: provider.label,
          completeness: completeness.status, citationValidation: completeness.citationValidation || null, continuations
        };
        if (!tePlan.cacheBypassed) tokenEconomy.globalCache.set('L1', tePlan.cacheKeyParts, directDonePayload);
        tokenEconomy.recordOutcome(tePlan.classification.problemClass, input.stage === 'approach' ? 'approach' : 'detail', full.length / 3.2);
        teTelemetry.record('outputTokens', full.length / 3.2);
        teTelemetry.record('continuationTokens', continuations > 0 ? full.length / 3.2 * 0.2 : 0);
        reqLogger.log({ stage: 'token_economy_telemetry', ...teTelemetry.snapshot() });
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
      const system = buildChatSystemPrompt({ ...input, problemText });
      const variantSystem = system + buildVariantAddendum();

      // PHẦN 10 FIX: xem giải thích đầy đủ ở nhánh streaming phía trên — cùng logic, cùng lý do.
      const ccPolicy = tokenEconomy.crossCheckPolicy({
        problemClass: tePlan.classification.problemClass,
        hasGeometryProof: tokenEconomy.detectGeometryProofHint(problemText)
      });
      const ccMaxCandidates = ccPolicy.risk === 'LOW' ? 2 : undefined;

      const { candidates } = await gatherCrossCheckCandidates(activeProviders, {
        system, variantSystem, messages, maxTokens: budgetOf('candidate').coreBudget, requestId: reqLogger.requestId,
        deepThinking: input.deepThinking,
        deadline: globalDeadline, // mục 4/6
        requireVision: !!input.image,
        ...(ccMaxCandidates ? { maxCandidates: ccMaxCandidates } : {}),
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

      // FIX PHẦN 3/6: continuation dùng RESERVE (lô nhỏ dần), không xin lại budgetOf(stage).target.
      const jsonReconcileReserveBudget = budgetOf(reconcileStage).reserveBudget;
      let jsonReconcileReserveUsed = 0;
      const { text: finalText, completeness, continuations, provider: reconciler } = await ensureCompleteNonStream(
        (msgs) => {
          const decision = tokenEconomy.shouldUseReserve({ status: 'INCOMPLETE' }, jsonReconcileReserveUsed, jsonReconcileReserveBudget);
          // PHẦN 2 FIX: reserve hết = KHÔNG gọi AI thêm (hard cap). Không còn fallback token ngoài reserve.
          if (!decision.allow) return Promise.resolve({ reserveExhausted: true });
          const amt = decision.amount;
          jsonReconcileReserveUsed += amt;
          return callWithFailover(
            activeProviders,
            { system: reconcileSystem, messages: msgs, maxTokens: amt, webSearch: hasWebSearch, timeoutMs: RECONCILE_TIMEOUT_MS, requestId: reqLogger.requestId, deepThinking: input.deepThinking, signal },
            { preferWebSearch: hasWebSearch, deadline: globalDeadline, requireVision: !!input.image }
          );
        },
        initial,
        { messages, problemText, stage: 'detail', deadline: globalDeadline, approachText: input.approachText, contexts: input.contexts, signal }
      );

      // mục 4: client đã ngắt kết nối trong lúc chờ — không còn ai để nhận response, không ghi cache
      // kết quả (dù đã COMPLETE) cho 1 request đã bị hủy, không tốn thêm việc serialize/gửi JSON.
      if (disconnected) return;

      // ensureCompleteNonStream() đã assertFinalResponseComplete() ở trên — tới được đây nghĩa là
      // completeness.status chắc chắn === 'COMPLETE' (mục 1/2/14).
      const jsonDonePayload = {
        ...subjectPayload,
        state: STATES.COMPLETED,
        text: finalText,
        crossChecked: true,
        providers: candidates.map((c) => c.label),
        reconciledBy: reconciler.label,
        completeness: completeness.status,
            citationValidation: completeness.citationValidation || null,
        continuations
      };
      if (!tePlan.cacheBypassed) tokenEconomy.globalCache.set('L1', tePlan.cacheKeyParts, jsonDonePayload);
      tokenEconomy.recordOutcome(tePlan.classification.problemClass, reconcileStage, finalText.length / 3.2);
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
    const system = buildChatSystemPrompt({ ...input, problemText });
    const directBudget = budgetOf(input.stage === 'approach' ? 'approach' : 'detail');
    const directCaller = callMode.fast ? callFastest : callWithFailover;
    // PHẦN 8 FIX: modelTier THỰC SỰ ảnh hưởng lựa chọn model (trước đây chỉ log — dead optimization).
    const useFastModel = callMode.fast && tokenEconomy.tierUsesFastModel(tePlan.modelTier);
    const initialDirect = await directCaller(
      activeProviders,
      { system, messages, maxTokens: directBudget.coreBudget, fast: useFastModel, deepThinking: input.deepThinking, requestId: reqLogger.requestId, signal },
      { deadline: globalDeadline, requireVision: !!input.image } // mục 4/6
    );

    // FIX PHẦN 3/6: continuation dùng RESERVE (lô nhỏ dần), không xin lại budgetOf(stage).target.
    const jsonDirectReserveBudget = directBudget.reserveBudget;
    let jsonDirectReserveUsed = 0;
    const { text, completeness, continuations, provider } = await ensureCompleteNonStream(
      (msgs) => {
        const decision = tokenEconomy.shouldUseReserve({ status: 'INCOMPLETE' }, jsonDirectReserveUsed, jsonDirectReserveBudget);
        // PHẦN 2 FIX: reserve hết = KHÔNG gọi AI thêm (hard cap). Không còn fallback token ngoài reserve.
        if (!decision.allow) return Promise.resolve({ reserveExhausted: true });
        const amt = decision.amount;
        jsonDirectReserveUsed += amt;
        return directCaller(
          activeProviders,
          { system, messages: msgs, maxTokens: amt, fast: useFastModel, deepThinking: input.deepThinking, requestId: reqLogger.requestId, signal },
          { deadline: globalDeadline, requireVision: !!input.image }
        );
      },
      initialDirect,
      { messages, problemText, stage: input.stage, deadline: globalDeadline, approachText: input.approachText, contexts: input.contexts, signal }
    );

    // mục 4: xem giải thích ở nhánh cross-check JSON phía trên — cùng lý do.
    if (disconnected) return;

    // ensureCompleteNonStream() đã assertFinalResponseComplete() — chắc chắn COMPLETE tới đây.
    const finalJsonPayload = { ...subjectPayload, state: STATES.COMPLETED, text, crossChecked: false, provider: provider.label, completeness: completeness.status, citationValidation: completeness.citationValidation || null, continuations };
    if (!tePlan.cacheBypassed) tokenEconomy.globalCache.set('L1', tePlan.cacheKeyParts, finalJsonPayload);
    tokenEconomy.recordOutcome(tePlan.classification.problemClass, input.stage === 'approach' ? 'approach' : 'detail', text.length / 3.2);
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
