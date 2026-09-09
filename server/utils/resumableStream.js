'use strict';

// ============================================================================================
// RESUMABLE FAILOVER (PHẦN B / L) — một câu trả lời, nhiều provider, người dùng thấy LIỀN MẠCH
// ============================================================================================
// Đây là module thay thế 2 vòng `while (completeness.status === 'INCOMPLETE' && ...)` gần như trùng
// lặp trong chat.js (nhánh reconcile + nhánh direct). Lý do gộp lại 1 chỗ không chỉ là DRY:
//   - Trước đây mỗi vòng tự quản `full`, `finishReason`, `continuations`, `reserveState` bằng biến
//     rời rạc; bất kỳ sửa đổi nào (vd thêm xử lý interrupted) phải làm ĐÚNG 2 lần và rất dễ lệch.
//   - Không vòng nào đọc `partialError`/`interrupted`, nên KHÔNG có RESUME MODE thật: mọi thứ đều
//     bị coi là "continuation vì lý do cấu trúc", dùng cùng 1 prompt, cùng 1 kích cỡ lô token nhỏ,
//     và có thể quay lại đúng target vừa chết.
//
// Vòng đời 1 lượt trả lời ở module này:
//
//   INITIAL  ──(ok, COMPLETE)──────────────────────────────────► DONE
//      │
//      ├──(lỗi TRƯỚC delta đầu tiên)──► streamWithFailover tự đổi target (CASE 1, không vào đây)
//      │
//      ├──(lỗi SAU delta: interrupted)─► RESUME     ─┐
//      │                                             ├─► đánh giá completeness lại ─► DONE/tiếp
//      └──(finish_reason=length / cấu trúc hỏng)────► CONTINUATION ─┘
//
// RESUME và CONTINUATION dùng CHUNG cơ chế (giữ text đã sinh, gửi ngữ cảnh tối thiểu, viết tiếp),
// chỉ khác prompt và cách tính ngân sách — nên A→B→C→D hoạt động với BẤT KỲ tổ hợp lý do nào:
// A bị ngắt ở 40% → B viết tiếp rồi bị cắt vì hết token ở 75% → C viết tiếp rồi hoàn tất.

const { createStreamSession, STAGE } = require('./streamSession');
const { buildMinimalContinuationContext, createSeamDedupe, joinContinuation, computeRecoveryBudget } = require('./continuation');

/**
 * runResumableStream() — điều phối 1 lượt trả lời streaming có khả năng resume qua nhiều target.
 *
 * @param {object} cfg
 * @param {Array} cfg.providers Danh sách execution target đang hoạt động.
 * @param {Function} cfg.streamFn (providers, args, onDelta, opts) => Promise<result>. Thường là
 *   aiProviders.streamWithFailover; tách ra tham số để test inject stub không cần mạng.
 * @param {Function} cfg.buildArgs ({mode, messages, maxTokens}) => args truyền cho streamFn.
 *   chat.js sở hữu hàm này (nó biết system prompt/webSearch/fast/deepThinking/signal của stage đó)
 *   — module này KHÔNG tự dựng args để không phải biết gì về prompt.
 * @param {Array} cfg.messages messages gốc của lượt đầu (đề bài + history đã nén).
 * @param {Function} cfg.onDelta (text) => void — forward tới client (SSE).
 * @param {Function} [cfg.onStatus] ({state,message}) => void.
 * @param {Function} cfg.evaluate (text, {finishReason, interrupted}) => completeness.
 * @param {Function} cfg.resolveRecovery (completeness, session) => {allow:boolean, amount:number}.
 *   chat.js sở hữu chính sách reserve (tokenEconomy.shouldUseReserve + mở rộng động).
 * @param {object} cfg.deadline GLOBAL request deadline (PHẦN O) — KHÔNG tạo mới ở đây.
 * @param {object} [cfg.streamOpts] opts truyền thẳng cho streamFn (preferWebSearch/requireVision...).
 * @param {AbortSignal} [cfg.signal]
 * @param {Function} [cfg.isDisconnected] () => boolean.
 * @param {{stage?:string, totalBudget?:number, recoveryBudget?:number, requestId?:string,
 *   inputTokens?:number, compressedInputTokens?:number, requestStage?:string}} [cfg.sessionInit]
 * @returns {Promise<{session:object, completeness:object, text:string, provider:object,
 *   continuations:number, resumes:number, duplicateCharsRemoved:number}>}
 */
async function runResumableStream(cfg) {
  const {
    providers, streamFn, buildArgs, messages, onDelta, onStatus = () => {},
    evaluate, resolveRecovery, deadline, streamOpts = {}, signal,
    isDisconnected = () => false, sessionInit = {}
  } = cfg;

  const session = createStreamSession({ ...sessionInit, deadline });
  let duplicateCharsRemoved = 0;

  // ---------- Lượt ĐẦU TIÊN ----------
  const initialArgs = buildArgs({ mode: STAGE.INITIAL, messages, maxTokens: sessionInit.coreBudget });
  const initialResult = await streamFn(
    providers,
    initialArgs,
    (piece) => { session.appendText(piece); onDelta(piece); },
    { ...streamOpts, deadline }
  );
  session.stage = STAGE.INITIAL;
  session.absorbAttempt(initialResult, { mode: STAGE.INITIAL });

  // streamWithFailover trả text đã strip thinking; nếu vì lý do nào đó onDelta không được gọi (vd
  // provider trả trọn 1 lần không stream), lấy text từ kết quả để checkpoint không bị rỗng.
  if (!session.accumulatedText && initialResult && initialResult.text) {
    session.accumulatedText = initialResult.text;
    onDelta(initialResult.text);
  }

  if (initialResult && initialResult.cancelled) {
    return finish(session, evaluate, duplicateCharsRemoved, 0);
  }

  let completeness = evaluate(session.accumulatedText, {
    finishReason: session.finishReason,
    interrupted: session.interrupted
  });

  // ---------- Vòng RESUME / CONTINUATION ----------
  while (
    completeness.status === 'INCOMPLETE' &&
    completeness.severity === 'HARD' && // SOFT không bao giờ kích hoạt recovery (mục 2/9)
    computeRecoveryBudget({
      remainingMs: session.deadlineRemaining(),
      continuationsSoFar: session.continuationCount
    }).allowed &&
    !(signal && signal.aborted) &&
    !isDisconnected()
  ) {
    const wasInterrupted = !!session.interrupted;
    const decision = resolveRecovery(completeness, session);
    // Hết ngân sách token (kể cả sau khi đã thử mở rộng) = KHÔNG được gọi thêm AI (hard cap PHẦN I).
    if (!decision || !decision.allow) {
      session.recoveryReason = 'reserve_exhausted';
      break;
    }

    onStatus({
      state: 'RECOVERING',
      // Người dùng nhìn thấy MỘT câu trả lời liên tục — thông điệp nói về việc "đang tiếp tục",
      // không phải "đang sửa lỗi", vì phần đã hiện trên màn hình vẫn hoàn toàn hợp lệ.
      message: wasInterrupted
        ? 'Kết nối tới mô hình bị ngắt, đang tiếp tục câu trả lời bằng mô hình khác…'
        : 'Đang viết tiếp phần còn thiếu của câu trả lời…',
      interrupted: wasInterrupted
    });

    // ---------- Ngữ cảnh TỐI THIỂU (PHẦN G) — không gửi lại toàn bộ answer cũ ----------
    const ctx = buildMinimalContinuationContext({
      messages,
      priorText: session.accumulatedText,
      completeness,
      interrupted: wasInterrupted
    });
    session.noteContinuationInput(ctx.priorTokensAfter);

    const mode = wasInterrupted ? STAGE.RESUME : STAGE.CONTINUATION;
    session.stage = mode;

    // ---------- Chống lặp text ở điểm nối (PHẦN B) ----------
    const seam = createSeamDedupe(session.accumulatedText, (clean) => {
      session.appendText(clean);
      onDelta(clean);
    });

    let stepResult;
    try {
      stepResult = await streamFn(
        providers,
        buildArgs({ mode, messages: ctx.messages, maxTokens: decision.amount }),
        (piece) => seam.feed(piece),
        { ...streamOpts, deadline }
      );
      seam.flush();
    } catch (e) {
      seam.flush();
      // Lượt tiếp nối thất bại HOÀN TOÀN (không target nào mở được stream). KHÔNG mất phần đã có —
      // thoát vòng, để nơi gọi quyết định (giao phần đã có kèm cảnh báo, hoặc FAILED).
      session.recoveryReason = 'continuation_provider_error';
      if (e && e.cancelled) session.recoveryReason = 'cancelled';
      break;
    }
    duplicateCharsRemoved += seam.removedChars;
    session.noteRecoverySpend(decision.amount);
    session.absorbAttempt(stepResult, { mode });

    // Lượt tiếp nối KHÔNG sinh được ký tự nào (provider trả rỗng): dừng, tránh vòng lặp vô ích tiêu
    // hết reserve mà câu trả lời không dài thêm 1 chữ.
    if (stepResult && !stepResult.text && !seam.removedChars) {
      const grew = session.accumulatedText.length;
      if (!grew || stepResult.text === '') {
        session.recoveryReason = session.recoveryReason || 'continuation_empty';
        if (!stepResult.interrupted) break;
      }
    }
    if (stepResult && stepResult.cancelled) break;

    completeness = evaluate(session.accumulatedText, {
      finishReason: session.finishReason,
      interrupted: session.interrupted
    });
  }

  return finish(session, evaluate, duplicateCharsRemoved, 0, completeness);
}

function finish(session, evaluate, duplicateCharsRemoved, _unused, completeness) {
  const finalCompleteness = completeness || evaluate(session.accumulatedText, {
    finishReason: session.finishReason,
    interrupted: session.interrupted
  });
  session.stage = finalCompleteness.status === 'COMPLETE' || finalCompleteness.severity === 'SOFT'
    ? STAGE.DONE
    : STAGE.FAILED;
  return {
    session,
    completeness: finalCompleteness,
    text: session.accumulatedText,
    provider: session.currentProvider,
    continuations: session.continuationCount,
    resumes: session.resumeCount,
    duplicateCharsRemoved
  };
}

/**
 * runResumableNonStream() — bản KHÔNG streaming (nhánh JSON fallback cho trình duyệt không hỗ trợ
 * ReadableStream). Dùng CHUNG toàn bộ logic checkpoint/minimal-context/seam-dedupe ở trên; khác duy
 * nhất ở chỗ không có onDelta nên phần text của mỗi lượt được nối bằng joinContinuation() (không
 * chèn '\n' bừa làm đứt từ/công thức ở điểm cắt).
 *
 * @param {object} cfg Giống runResumableStream nhưng `callFn(args) => {text, provider, finishReason}`.
 */
async function runResumableNonStream(cfg) {
  const {
    callFn, buildArgs, messages, evaluate, resolveRecovery, deadline, signal,
    isDisconnected = () => false, sessionInit = {}, initialResult
  } = cfg;

  const session = createStreamSession({ ...sessionInit, deadline });
  session.accumulatedText = (initialResult && initialResult.text) || '';
  session.absorbAttempt(initialResult, { mode: STAGE.INITIAL });

  let completeness = evaluate(session.accumulatedText, {
    finishReason: session.finishReason,
    interrupted: session.interrupted
  });

  while (
    completeness.status === 'INCOMPLETE' &&
    completeness.severity === 'HARD' &&
    computeRecoveryBudget({
      remainingMs: session.deadlineRemaining(),
      continuationsSoFar: session.continuationCount
    }).allowed &&
    !(signal && signal.aborted) &&
    !isDisconnected()
  ) {
    const wasInterrupted = !!session.interrupted;
    const decision = resolveRecovery(completeness, session);
    if (!decision || !decision.allow) { session.recoveryReason = 'reserve_exhausted'; break; }

    const ctx = buildMinimalContinuationContext({
      messages, priorText: session.accumulatedText, completeness, interrupted: wasInterrupted
    });
    session.noteContinuationInput(ctx.priorTokensAfter);

    const mode = wasInterrupted ? STAGE.RESUME : STAGE.CONTINUATION;
    session.stage = mode;

    let step;
    try {
      step = await callFn(buildArgs({ mode, messages: ctx.messages, maxTokens: decision.amount }));
    } catch (e) {
      session.recoveryReason = e && e.cancelled ? 'cancelled' : 'continuation_provider_error';
      break;
    }
    if (!step || step.reserveExhausted) { session.recoveryReason = 'reserve_exhausted'; break; }
    session.noteRecoverySpend(decision.amount);

    // Chống lặp ở điểm nối cho cả đường non-stream.
    let cleaned = '';
    const seam = createSeamDedupe(session.accumulatedText, (t) => { cleaned += t; });
    seam.feed(step.text || '');
    seam.flush();
    session.accumulatedText = joinContinuation(session.accumulatedText, cleaned);
    session.absorbAttempt(step, { mode });

    if (!cleaned.trim()) { session.recoveryReason = session.recoveryReason || 'continuation_empty'; break; }

    completeness = evaluate(session.accumulatedText, {
      finishReason: session.finishReason,
      interrupted: session.interrupted
    });
  }

  return finish(session, evaluate, 0, 0, completeness);
}

module.exports = { runResumableStream, runResumableNonStream, STAGE };
