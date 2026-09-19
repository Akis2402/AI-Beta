'use strict';

// ============================================================================================
// STREAM CHECKPOINT (PHẦN B) — trạng thái duy nhất mô tả "câu trả lời đang được sinh"
// ============================================================================================
// NGUYÊN NHÂN GỐC mà module này giải quyết: TRƯỚC ĐÂY không có bất kỳ đối tượng nào giữ trạng thái
// của 1 lượt trả lời xuyên qua NHIỀU provider. chat.js chỉ có 1 biến `full` (string) cộng dồn trong
// closure của onDelta, cộng thêm vài biến rời rạc (`finishReason`, `continuations`, `reserveState`).
// Khi provider chết giữa stream, mọi thứ cần cho việc RESUME (đã stream tới đâu, target nào vừa
// chết, còn bao nhiêu ngân sách, đã thử những target nào) nằm rải rác ở 3-4 nơi và KHÔNG có chỗ nào
// ghi lại "lượt này bị NGẮT" — nên pipeline không thể phân biệt "model tự kết thúc" với "provider
// chết giữa câu", và không thể chọn target khác một cách có chủ đích.
//
// StreamSession là checkpoint DUY NHẤT: mọi nhánh (streaming/JSON, direct/reconcile) đọc-ghi qua
// đây, nên hành vi resume nhất quán và telemetry (PHẦN Q) lấy từ 1 nguồn.

const { estimateTokens } = require('./adaptiveBudget');

const STAGE = Object.freeze({
  INITIAL: 'initial',      // lượt sinh đầu tiên
  RESUME: 'resume',        // tiếp tục sau khi bị NGẮT giữa stream (interrupted)
  CONTINUATION: 'continuation', // tiếp tục vì lỗi cấu trúc/finish_reason=length (không bị ngắt)
  DONE: 'done',
  FAILED: 'failed'
});

/**
 * @param {{stage?:string, totalBudget?:number, recoveryBudget?:number, deadline?:object,
 *   requestId?:string, inputTokens?:number}} init
 */
function createStreamSession(init = {}) {
  const session = {
    // ---------- nội dung ----------
    accumulatedText: '',
    // ---------- target/provider hiện tại ----------
    currentProvider: null,
    currentTarget: null,
    // ---------- tín hiệu kết thúc ----------
    finishReason: null,
    interrupted: false,
    // ---------- đếm lượt ----------
    continuationCount: 0,
    resumeCount: 0,
    attempts: 0,
    // ---------- token ----------
    outputTokens: 0,
    inputTokens: init.inputTokens || 0,
    compressedInputTokens: init.compressedInputTokens || 0,
    totalBudget: init.totalBudget || 0,
    recoveryBudget: init.recoveryBudget || 0,
    recoveryUsed: 0,
    continuationTokens: 0,
    // ---------- target đã dùng ----------
    triedTargets: [],
    failedTargets: [],
    // ---------- pipeline ----------
    stage: init.stage || STAGE.INITIAL,
    requestStage: init.requestStage || 'detail',
    recoveryReason: null,
    deadline: init.deadline || null,
    requestId: init.requestId || null,

    /** ms còn lại của GLOBAL deadline (PHẦN O — 1 request = 1 đồng hồ, không tự tạo mới ở đây). */
    deadlineRemaining() {
      return this.deadline && typeof this.deadline.remaining === 'function'
        ? this.deadline.remaining()
        : Infinity;
    },

    /** Ghi thêm 1 đoạn text ĐÃ được forward tới người dùng. */
    appendText(piece) {
      if (!piece) return;
      this.accumulatedText += piece;
    },

    /** Đoạn cuối của text đã sinh — dùng làm mốc resume (không bao giờ regenerate từ đầu). */
    tail(chars = 1200) {
      return this.accumulatedText.slice(-chars);
    },

    /**
     * Hợp nhất kết quả 1 lượt gọi provider vào checkpoint. `result` là giá trị trả về của
     * streamWithFailover() (đã mang thêm interrupted/partialError sau bản fix PHẦN B).
     */
    absorbAttempt(result, { mode } = {}) {
      this.attempts += 1;
      if (!result) return this;
      if (result.provider) {
        this.currentProvider = result.provider;
        this.currentTarget = result.provider.id || result.provider.label || null;
        if (this.currentTarget && !this.triedTargets.includes(this.currentTarget)) {
          this.triedTargets.push(this.currentTarget);
        }
      }
      if (Array.isArray(result.tried)) {
        result.tried.forEach((t) => {
          const label = t && (t.label || t.id);
          if (label && !this.failedTargets.includes(label)) this.failedTargets.push(label);
        });
      }
      // interrupted của LƯỢT NÀY (không cộng dồn vĩnh viễn): nếu lượt resume sau đó chạy trọn vẹn,
      // câu trả lời KHÔNG còn ở trạng thái bị ngắt nữa — nếu giữ cờ cũ thì completeness sẽ mãi mãi
      // HARD và vòng recovery không bao giờ dừng được (đúng 1 trong các bẫy của bản trước).
      this.interrupted = !!result.interrupted;
      if (result.interrupted) {
        this.failedTargets.push(this.currentTarget || 'unknown');
        this.recoveryReason = 'stream_interrupted';
        if (this.currentTarget && !this.failedTargets.includes(this.currentTarget)) {
          this.failedTargets.push(this.currentTarget);
        }
      }
      // finishReason: khi bị NGẮT, provider chưa kịp gửi tín hiệu kết thúc nào — tuyệt đối không
      // được suy ra 'stop' (xem completenessCheck PHẦN C).
      this.finishReason = result.interrupted ? null : (result.finishReason || null);
      if (mode === STAGE.RESUME) this.resumeCount += 1;
      if (mode === STAGE.RESUME || mode === STAGE.CONTINUATION) this.continuationCount += 1;
      this.outputTokens = estimateTokens(this.accumulatedText);
      return this;
    },

    /** Ghi nhận phần token input phụ trội của 1 lượt continuation (PHẦN Q). */
    noteContinuationInput(tokens) {
      this.continuationTokens += Math.max(0, Math.round(tokens || 0));
    },

    noteRecoverySpend(tokens) {
      this.recoveryUsed += Math.max(0, Math.round(tokens || 0));
    },

    /** Telemetry snapshot (PHẦN Q) — KHÔNG chứa API key/prompt/nội dung câu trả lời. */
    snapshot() {
      return {
        requestId: this.requestId,
        stage: this.stage,
        requestStage: this.requestStage,
        provider: this.currentProvider ? this.currentProvider.providerKey : null,
        model: this.currentProvider ? this.currentProvider.modelName : null,
        targetId: this.currentTarget,
        attempts: this.attempts,
        inputTokens: this.inputTokens,
        compressedInputTokens: this.compressedInputTokens,
        compressionRatio: this.inputTokens > 0
          ? Number((1 - this.compressedInputTokens / this.inputTokens).toFixed(4))
          : 0,
        outputTokens: this.outputTokens,
        finishReason: this.finishReason,
        interrupted: this.interrupted,
        continuationCount: this.continuationCount,
        resumeCount: this.resumeCount,
        continuationTokens: this.continuationTokens,
        totalBudget: this.totalBudget,
        recoveryBudget: this.recoveryBudget,
        recoveryUsed: this.recoveryUsed,
        deadlineRemaining: Number.isFinite(this.deadlineRemaining()) ? this.deadlineRemaining() : null,
        triedTargets: this.triedTargets.slice(),
        failedTargets: [...new Set(this.failedTargets)],
        recoveryReason: this.recoveryReason
      };
    }
  };
  return session;
}

module.exports = { createStreamSession, STAGE };
