'use strict';

const express = require('express');
const router = express.Router();
const {
  getActiveProviders, callWithFailover, callFastest, streamWithFailover,
  gatherCrossCheckCandidates
} = require('../utils/aiProviders');
// Timeout riêng cho LƯỢT TỔNG HỢP cuối (sau khi đã có candidates) — tách khỏi CROSS_CHECK_BUDGET_MS
// (ngân sách đó chỉ tính cho bước THU THẬP lượt giải). Có timeout riêng, rõ ràng để lượt tổng hợp
// không bị "thừa hưởng" một REQUEST_TIMEOUT_MS quá dài rồi cộng dồn vượt quá maxDuration của hosting.
const RECONCILE_TIMEOUT_MS = Number(process.env.RECONCILE_TIMEOUT_MS) || 25000;
const {
  buildChatSystemPrompt,
  buildVariantAddendum,
  buildReconcileSystemPrompt
} = require('../utils/promptBuilder');
const { validateChatBody } = require('../utils/validators');
const { calculateAdaptiveBudget } = require('../utils/adaptiveBudget');
const { compressHistoryForBudget } = require('../utils/semanticCompression');
const { validateSolutionCompleteness, extractCoverageList } = require('../utils/completenessCheck');
const { MAX_CONTINUATIONS, appendContinuationTurn } = require('../utils/continuation');
const { validateAllDrawingBlocks, checkCanonicalDrawingConsistency } = require('../utils/drawingValidator');
const { createRequestDeadline } = require('../utils/requestDeadline');
const { STATES, isFinalSuccess, assertFinalResponseComplete } = require('../utils/runtimeState');
const { analyzeSourceCoverage } = require('../utils/sourceCoverage');
const { createRequestLogger } = require('../utils/logger');

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
  let completeness = checkCompletenessWithDrawings(text, { stage: ctx.stage, coverageList, approachText: ctx.approachText });
  let continuations = 0;

  while (
    completeness.status === 'INCOMPLETE' &&
    continuations < MAX_CONTINUATIONS &&
    ctx.deadline.remaining() > 8000
  ) {
    const contMessages = appendContinuationTurn(ctx.messages, text, completeness);
    let contResult;
    try {
      contResult = await callOnce(contMessages);
    } catch (e) {
      break; // provider lỗi ở continuation — dừng, rơi xuống assertFinalResponseComplete() bên dưới (mục 1/2)
    }
    text = text + '\n' + contResult.text;
    provider = contResult.provider;
    continuations += 1;
    completeness = checkCompletenessWithDrawings(text, { stage: ctx.stage, coverageList, approachText: ctx.approachText });
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
  try {
    const input = validateChatBody(req.body);
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

    // ---------- Semantic compression (mục IV/mục 8) trước khi ghép messages ----------
    // Đề bài/contexts/approachText KHÔNG bao giờ bị đụng tới — chỉ history (lượt hỏi-đáp CŨ, không
    // còn liên quan trực tiếp tới câu hỏi hiện tại) mới có thể bị loại bỏ NGUYÊN LƯỢT khi tổng ngữ
    // cảnh đã nặng (nhiều context/approachText dài), thay vì bị validators cắt cứng theo ký tự.
    // `currentProblemText` (mục 8): cho phép compressHistoryForBudget ưu tiên giữ lượt LIÊN QUAN tới
    // câu hỏi hiện tại thay vì chỉ cắt mù theo tuổi, và tự loại các lượt trùng lặp trước tiên.
    const contextsText = input.contexts.map((c) => c.text).join('\n');
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

    // ---------- Deadline DUY NHẤT cho toàn bộ request (mục 4) ----------
    // Instance này được truyền (KHÔNG tạo lại) xuống mọi bước: gatherCrossCheckCandidates,
    // callWithFailover, callFastest, streamWithFailover, continuation, và cả budgetOf() (mục 7 —
    // token budget phải co lại khi thời gian còn ít, xem calculateAdaptiveBudget/timeRemainingBudget).
    const globalDeadline = createRequestDeadline(GLOBAL_REQUEST_DEADLINE_MS);
    const budgetOf = (stage) => calculateAdaptiveBudget({
      stage, problemText, historyText, contextsText, approachText: input.approachText,
      hasImage: !!input.image, deepThinking: input.deepThinking, crossCheck: input.crossCheck,
      remainingMs: globalDeadline.remaining()
    });

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
          const system = buildChatSystemPrompt(input);
          const variantSystem = system + buildVariantAddendum();

          sseWrite(res, 'status', { message: 'Đang đối chiếu đa hướng…' });

          // Heartbeat: trong lúc thu thập các lượt giải (có thể im lặng nhiều giây, đặc biệt khi
          // đang thử lại provider lỗi), gửi định kỳ 1 comment SSE rỗng (":\n\n" — không phải sự
          // kiện, trình duyệt bỏ qua) để giữ kết nối "sống" trong mắt các proxy/CDN trung gian (vd
          // Vercel Edge Network) — tránh bị coi là kết nối treo và đóng ngang trước khi có dữ liệu.
          const heartbeat = setInterval(() => { try { res.write(':\n\n'); } catch (e) { /* đã đóng */ } }, 8000);

          let candidates;
          try {
            const gathered = await gatherCrossCheckCandidates(activeProviders, {
              system, variantSystem, messages, maxTokens: budgetOf('candidate').target, requestId: reqLogger.requestId,
              onStatus: (message) => sseWrite(res, 'status', { message }),
              deadline: globalDeadline // mục 4/6: dùng chung 1 đồng hồ với toàn bộ request, không tự tạo riêng
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
          const reconcileSystem = buildReconcileSystemPrompt({
            // candidates ở đây đã được strip <thinking>/<think> ngay từ gatherCrossCheckCandidates()
            // (xem server/utils/aiProviders.js) — không cần strip lại ở đây.
            candidates,
            contexts: input.contexts,
            settings: input.settings,
            hasWebSearch,
            deepThinking: input.deepThinking
          });

          sseWrite(res, 'status', { message: 'Đang tổng hợp lời giải cuối cùng…' });

          sseWrite(res, 'status', { state: STATES.GENERATING, message: 'Đang tổng hợp lời giải cuối cùng…' });

          let full = '';
          const { provider: reconciler } = await streamWithFailover(
            activeProviders,
            { system: reconcileSystem, messages, maxTokens: budgetOf('reconcile').target, webSearch: hasWebSearch, timeoutMs: RECONCILE_TIMEOUT_MS, requestId: reqLogger.requestId },
            (piece) => { full += piece; sseWrite(res, 'delta', { text: piece }); },
            { preferWebSearch: hasWebSearch, deadline: globalDeadline } // mục 4/6: cùng đồng hồ toàn request
          );

          // ---------- Completeness check + continuation (mục V/VI) trên response THẬT SỰ hiển thị ----------
          const coverageList = extractCoverageList(problemText);
          let completeness = checkCompletenessWithDrawings(full, { stage: 'detail', coverageList, approachText: input.approachText });
          let continuations = 0;
          while (completeness.status === 'INCOMPLETE' && continuations < MAX_CONTINUATIONS && globalDeadline.remaining() > 8000) {
            sseWrite(res, 'status', { state: STATES.RECOVERING, message: 'Câu trả lời chưa đầy đủ, đang khôi phục phần còn thiếu…' });
            const contMessages = appendContinuationTurn(messages, full, completeness);
            let piece2 = '';
            try {
              await streamWithFailover(
                activeProviders,
                { system: reconcileSystem, messages: contMessages, maxTokens: budgetOf('reconcile').target, webSearch: hasWebSearch, timeoutMs: RECONCILE_TIMEOUT_MS, requestId: reqLogger.requestId },
                (piece) => { piece2 += piece; full += piece; sseWrite(res, 'delta', { text: piece }); },
                { preferWebSearch: hasWebSearch, deadline: globalDeadline }
              );
            } catch (e) { break; }
            continuations += 1;
            completeness = checkCompletenessWithDrawings(full, { stage: 'detail', coverageList, approachText: input.approachText });
          }

          // ---------- Cổng bắt buộc (mục 1/2): KHÔNG BAO GIỜ gửi "done" nếu chưa thực sự COMPLETE ----------
          // RECOVERING không thành công (vẫn INCOMPLETE) hoặc INVALID → gửi "error" (state FAILED),
          // KHÔNG gửi "done". Chỉ có đúng 1 đường tới "done": completeness.status === 'COMPLETE'.
          if (!isFinalSuccess(completeness.status)) {
            sseWrite(res, 'error', {
              message: 'Câu trả lời chưa đầy đủ sau khi đã thử khôi phục — không thể coi là hoàn thành.',
              state: STATES.FAILED,
              completeness: completeness.status,
              text: full,
              continuations
            });
            return res.end();
          }

          sseWrite(res, 'done', {
            state: STATES.COMPLETED,
            text: full,
            crossChecked: true,
            providers: candidates.map((c) => c.label),
            reconciledBy: reconciler.label,
            completeness: completeness.status,
            continuations
          });
          return res.end();
        }

        // ---------- Giai đoạn "hướng giải" hoặc chế độ "Nhanh": stream trực tiếp 1 lượt duy nhất ----------
        const system = buildChatSystemPrompt(input);
        let full = '';
        // LỖI GỐC (ảnh mới nhất người dùng gửi): giai đoạn "hướng giải" (approach) bị cắt ngang giữa
        // câu ("- Khai thác tính") vì maxTokens cố định 700 bất kể độ dài đề bài/deepThinking. FIX:
        // dùng ADAPTIVE TOKEN BUDGET (mục III, xem adaptiveBudget.js) thay vì hằng số cố định.
        const directBudget = budgetOf(input.stage === 'approach' ? 'approach' : 'detail');
        sseWrite(res, 'status', { state: STATES.GENERATING, message: 'Đang tạo câu trả lời…' });
        const { provider } = await streamWithFailover(
          activeProviders,
          { system, messages, maxTokens: directBudget.target, fast: true, requestId: reqLogger.requestId },
          (piece) => { full += piece; sseWrite(res, 'delta', { text: piece }); },
          { deadline: globalDeadline } // mục 4/6
        );

        // ---------- Completeness check + continuation (mục V/VI) ----------
        const coverageList = extractCoverageList(problemText);
        let completeness = checkCompletenessWithDrawings(full, { stage: input.stage, coverageList, approachText: input.approachText });
        let continuations = 0;
        while (completeness.status === 'INCOMPLETE' && continuations < MAX_CONTINUATIONS && globalDeadline.remaining() > 6000) {
          sseWrite(res, 'status', { state: STATES.RECOVERING, message: 'Câu trả lời chưa đầy đủ, đang khôi phục phần còn thiếu…' });
          const contMessages = appendContinuationTurn(messages, full, completeness);
          const contBudget = budgetOf(input.stage === 'approach' ? 'approach' : 'detail');
          try {
            await streamWithFailover(
              activeProviders,
              { system, messages: contMessages, maxTokens: contBudget.target, fast: true, requestId: reqLogger.requestId },
              (piece) => { full += piece; sseWrite(res, 'delta', { text: piece }); },
              { deadline: globalDeadline }
            );
          } catch (e) { break; }
          continuations += 1;
          completeness = checkCompletenessWithDrawings(full, { stage: input.stage, coverageList, approachText: input.approachText });
        }

        // ---------- Cổng bắt buộc (mục 1/2): KHÔNG BAO GIỜ gửi "done" nếu chưa thực sự COMPLETE ----------
        if (!isFinalSuccess(completeness.status)) {
          sseWrite(res, 'error', {
            message: 'Câu trả lời chưa đầy đủ sau khi đã thử khôi phục — không thể coi là hoàn thành.',
            state: STATES.FAILED,
            completeness: completeness.status,
            text: full,
            continuations
          });
          return res.end();
        }

        sseWrite(res, 'done', {
          state: STATES.COMPLETED,
          text: full, crossChecked: false, provider: provider.label,
          completeness: completeness.status, continuations
        });
        return res.end();
      } catch (streamErr) {
        // Header SSE đã gửi (200 text/event-stream) — không thể chuyển sang next(err) để trả JSON
        // lỗi như luồng thường (sẽ crash vì response đã bắt đầu). Phát sự kiện "error" riêng cho
        // client tự xử lý, rồi đóng kết nối.
        sseWrite(res, 'error', {
          message: (streamErr && streamErr.message) || 'Có lỗi khi kết nối tới máy chủ AI.'
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
      const system = buildChatSystemPrompt(input);
      const variantSystem = system + buildVariantAddendum();

      const { candidates } = await gatherCrossCheckCandidates(activeProviders, {
        system, variantSystem, messages, maxTokens: budgetOf('candidate').target, requestId: reqLogger.requestId,
        deadline: globalDeadline // mục 4/6
      });

      if (!candidates.length) {
        const err = new Error('Tất cả nhà cung cấp AI đã cấu hình đều gặp lỗi khi giải bài. Vui lòng kiểm tra lại API key trong .env.');
        err.status = 502;
        throw err;
      }

      // Xem giải thích đầy đủ ở nhánh streaming phía trên — cùng lý do, cùng logic (mục 9/10/11).
      const sourceCoverage = analyzeSourceCoverage({ problemText, contexts: input.contexts });
      const hasWebSearch = sourceCoverage.webRequired;
      const reconcileSystem = buildReconcileSystemPrompt({
        // candidates ở đây đã được strip <thinking>/<think> ngay từ gatherCrossCheckCandidates()
        // (xem server/utils/aiProviders.js) — không cần strip lại ở đây.
        candidates,
        contexts: input.contexts,
        settings: input.settings,
        hasWebSearch,
        deepThinking: input.deepThinking
      });

      const initial = await callWithFailover(
        activeProviders,
        { system: reconcileSystem, messages, maxTokens: budgetOf('reconcile').target, webSearch: hasWebSearch, timeoutMs: RECONCILE_TIMEOUT_MS, requestId: reqLogger.requestId },
        { preferWebSearch: hasWebSearch, deadline: globalDeadline } // mục 4/6
      );

      const { text: finalText, completeness, continuations, provider: reconciler } = await ensureCompleteNonStream(
        (msgs) => callWithFailover(
          activeProviders,
          { system: reconcileSystem, messages: msgs, maxTokens: budgetOf('reconcile').target, webSearch: hasWebSearch, timeoutMs: RECONCILE_TIMEOUT_MS, requestId: reqLogger.requestId },
          { preferWebSearch: hasWebSearch, deadline: globalDeadline }
        ),
        initial,
        { messages, problemText, stage: 'detail', deadline: globalDeadline, approachText: input.approachText }
      );

      // ensureCompleteNonStream() đã assertFinalResponseComplete() ở trên — tới được đây nghĩa là
      // completeness.status chắc chắn === 'COMPLETE' (mục 1/2/14).
      return res.json({
        state: STATES.COMPLETED,
        text: finalText,
        crossChecked: true,
        providers: candidates.map((c) => c.label),
        reconciledBy: reconciler.label,
        completeness: completeness.status,
        continuations
      });
    }

    // ---------- Giai đoạn "hướng giải" hoặc chế độ "Nhanh": đua tốc độ giữa các provider ----------
    // Không cố định vào 1 nhà cung cấp — mỗi request ĐUA TỐC ĐỘ đồng thời vài provider ngẫu nhiên
    // (callFastest) và dùng ngay kết quả của provider trả lời nhanh nhất, kèm model "nhanh" riêng
    // (fast:true) để giảm độ trễ. Nếu (các) provider trong nhóm đua đều lỗi/timeout, tự động mở
    // rộng đua sang provider còn lại trước khi báo lỗi cho người dùng.
    const system = buildChatSystemPrompt(input);
    const directBudget = budgetOf(input.stage === 'approach' ? 'approach' : 'detail');
    const initialDirect = await callFastest(
      activeProviders,
      { system, messages, maxTokens: directBudget.target, fast: true, requestId: reqLogger.requestId },
      { deadline: globalDeadline } // mục 4/6
    );

    const { text, completeness, continuations, provider } = await ensureCompleteNonStream(
      (msgs) => callFastest(
        activeProviders,
        { system, messages: msgs, maxTokens: budgetOf(input.stage === 'approach' ? 'approach' : 'detail').target, fast: true, requestId: reqLogger.requestId },
        { deadline: globalDeadline }
      ),
      initialDirect,
      { messages, problemText, stage: input.stage, deadline: globalDeadline, approachText: input.approachText }
    );

    // ensureCompleteNonStream() đã assertFinalResponseComplete() — chắc chắn COMPLETE tới đây.
    res.json({ state: STATES.COMPLETED, text, crossChecked: false, provider: provider.label, completeness: completeness.status, continuations });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
