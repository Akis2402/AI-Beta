'use strict';

// ============================================================================================
// PHẦN B (mục 10/11/12) — TELEMETRY TOKEN PHẢI PHẢN ÁNH TOKEN THẬT
// ============================================================================================
// Trước đây hệ thống chỉ có 2 nguồn số rời rạc:
//   - `emptyUsageAccumulator()`/`accumulateUsage()` trong aiProviders.js: cộng dồn usage THẬT nhưng
//     KHÔNG biết lượt gọi đó thuộc stage/phase nào, cũng không biết ngân sách đã cấp là bao nhiêu.
//   - `TelemetryRecorder` trong tokenEconomy.js: cộng dồn số ƯỚC LƯỢNG (text.length / 3.2) vào cùng
//     một trường `outputTokens` mà không đánh dấu là ước lượng -> báo cáo trông như đo thật.
// Hệ quả: không trả lời được câu hỏi "một câu hỏi đã tiêu bao nhiêu lượt gọi AI và bao nhiêu token".
//
// Module này ghi TỪNG LƯỢT GỌI (attempt) kèm ngân sách đã cấp và usage provider trả về, rồi tổng
// hợp thành thống kê cấp request. Hai nguyên tắc bất di bất dịch:
//   1. Nếu provider TRẢ usage thật -> ghi vào actual*, `estimated:false`.
//      Nếu KHÔNG -> ghi vào estimated*, `estimated:true`. KHÔNG BAO GIỜ trộn hai loại vào một trường.
//   2. reasoningTokens KHÔNG BAO GIỜ được cộng vào outputTokens (phần người dùng đọc) — chúng là hai
//      đại lượng khác nhau về cả chi phí lẫn ý nghĩa.
// KHÔNG ghi API key, prompt, hay nội dung câu trả lời — chỉ số đếm và nhãn.

const MAX_ATTEMPTS_KEPT = 200; // chặn rò rỉ bộ nhớ nếu một request bệnh lý gọi quá nhiều lượt

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * Phân loại stage của một attempt thành nhóm đếm cấp request.
 * @param {string} stage
 * @returns {'crossCheck'|'reconcile'|'recovery'|'visual'|'other'}
 */
function bucketOf(stage) {
  const s = String(stage || '').toLowerCase();
  if (s.includes('cross_check') || s.includes('crosscheck') || s.includes('candidate')) return 'crossCheck';
  if (s.includes('reconcile')) return 'reconcile';
  if (s.includes('recovery') || s.includes('continuation') || s.includes('resume')) return 'recovery';
  if (s.includes('visual') || s.includes('image')) return 'visual';
  return 'other';
}

class RequestTokenTelemetry {
  constructor(requestId) {
    this.requestId = requestId || null;
    this.attempts = [];
    this.totals = {
      callsTotal: 0,
      successfulCalls: 0,
      failedCalls: 0,
      retriedCalls: 0,
      crossCheckCalls: 0,
      reconcileCalls: 0,
      recoveryCalls: 0,
      visualCalls: 0,
      // ---- token ----
      inputTokens: 0,            // THẬT (provider trả về)
      outputTokens: 0,           // THẬT, KHÔNG gồm reasoning
      reasoningTokens: 0,        // THẬT, tách hẳn khỏi outputTokens
      cachedTokens: 0,
      cacheCreationTokens: 0,
      continuationTokens: 0,
      retryTokens: 0,
      actualTokens: 0,           // tổng các con số THẬT ở trên
      estimatedTokens: 0,        // tổng các con số ƯỚC LƯỢNG (provider không trả usage)
      estimatedSavings: 0,       // token lẽ ra phải trả tiền nhưng đọc được từ cache
      // ---- cache ----
      cacheHit: 0,
      cacheMiss: 0,
      // ---- chất lượng số liệu ----
      attemptsWithRealUsage: 0,
      attemptsEstimatedOnly: 0
    };
  }

  /**
   * Ghi MỘT lượt gọi provider.
   * @param {{stage?:string, provider?:string, model?:string, targetId?:string, phase?:string,
   *   answerBudget?:number, reasoningBudget?:number, providerMaxTokens?:number,
   *   usage?:object, estimatedOutputTokens?:number, finishReason?:string, latencyMs?:number,
   *   status?:'success'|'error'|'empty', retry?:boolean, recovery?:boolean}} a
   */
  recordAttempt(a = {}) {
    const usage = a.usage || null;
    const hasRealUsage = !!usage && (num(usage.inputTokens) > 0 || num(usage.outputTokens) > 0);
    const bucket = bucketOf(a.stage);

    const record = {
      requestId: this.requestId,
      stage: a.stage || null,
      provider: a.provider || null,
      model: a.model || null,
      targetId: a.targetId || null,
      phase: a.phase || (a.recovery ? 'recovery' : 'initial'),
      answerBudget: num(a.answerBudget) || null,
      reasoningBudget: Number.isFinite(a.reasoningBudget) ? Math.round(a.reasoningBudget) : null,
      providerMaxTokens: num(a.providerMaxTokens) || null,
      inputTokens: hasRealUsage ? num(usage.inputTokens) : null,
      outputTokens: hasRealUsage ? num(usage.outputTokens) : null,
      reasoningTokens: hasRealUsage && usage.reasoningTokens != null ? num(usage.reasoningTokens) : null,
      cachedTokens: hasRealUsage ? num(usage.cachedTokens) : null,
      cacheCreationTokens: hasRealUsage ? num(usage.cacheCreationTokens) : null,
      estimatedOutputTokens: hasRealUsage ? null : num(a.estimatedOutputTokens),
      estimated: !hasRealUsage,
      finishReason: a.finishReason || null,
      latencyMs: num(a.latencyMs) || null,
      status: a.status || 'success',
      retry: !!a.retry,
      recovery: !!a.recovery
    };

    if (this.attempts.length < MAX_ATTEMPTS_KEPT) this.attempts.push(record);

    const t = this.totals;
    t.callsTotal += 1;
    if (record.status === 'success') t.successfulCalls += 1; else t.failedCalls += 1;
    if (record.retry) t.retriedCalls += 1;
    if (bucket === 'crossCheck') t.crossCheckCalls += 1;
    else if (bucket === 'reconcile') t.reconcileCalls += 1;
    else if (bucket === 'visual') t.visualCalls += 1;
    if (bucket === 'recovery' || record.recovery) t.recoveryCalls += 1;

    if (hasRealUsage) {
      t.attemptsWithRealUsage += 1;
      t.inputTokens += record.inputTokens || 0;
      t.outputTokens += record.outputTokens || 0;
      t.reasoningTokens += record.reasoningTokens || 0;
      t.cachedTokens += record.cachedTokens || 0;
      t.cacheCreationTokens += record.cacheCreationTokens || 0;
      if (bucket === 'recovery' || record.recovery) t.continuationTokens += record.outputTokens || 0;
      if (record.retry) t.retryTokens += record.outputTokens || 0;
    } else {
      t.attemptsEstimatedOnly += 1;
      t.estimatedTokens += record.estimatedOutputTokens || 0;
    }

    t.actualTokens = t.inputTokens + t.outputTokens + t.reasoningTokens;
    // Token đọc từ cache được tính giá ~10% input thường -> phần tiết kiệm ≈ 90%.
    t.estimatedSavings = Math.round(t.cachedTokens * 0.9);
    return record;
  }

  /** @param {boolean} hit */
  recordCache(hit) {
    if (hit) this.totals.cacheHit += 1; else this.totals.cacheMiss += 1;
  }

  /** Thống kê cấp request, phẳng hoá sẵn để đi thẳng vào logger.log(). */
  snapshot() {
    return { ...this.totals, attemptCount: this.attempts.length };
  }

  /** Danh sách attempt (đã lọc mọi thứ nhạy cảm ngay từ recordAttempt). */
  listAttempts() {
    return this.attempts.slice();
  }
}

// ---------- Registry theo requestId ----------
// aiProviders.js gọi provider ở nhiều đường (failover / cross-check / stream) và chỉ luôn có
// `requestId` trong args. Thay vì phải luồn một object telemetry qua hàng chục chữ ký hàm (dễ rơi
// mất đúng như bug B2 với reasoningBudget), route ĐĂNG KÝ recorder theo requestId và aiProviders tra
// ngược lại. Registry tự dọn khi route gọi release().
const registry = new Map();
const MAX_LIVE_REQUESTS = 500;

function createRequestTelemetry(requestId) {
  const rec = new RequestTokenTelemetry(requestId);
  if (requestId) {
    if (registry.size >= MAX_LIVE_REQUESTS) {
      const oldest = registry.keys().next().value;
      if (oldest !== undefined) registry.delete(oldest);
    }
    registry.set(requestId, rec);
  }
  return rec;
}

function getRequestTelemetry(requestId) {
  return requestId ? registry.get(requestId) || null : null;
}

function releaseRequestTelemetry(requestId) {
  if (requestId) registry.delete(requestId);
}

/** Ghi attempt qua registry — no-op an toàn nếu route chưa đăng ký recorder nào. */
function recordAttemptFor(requestId, attempt) {
  const rec = getRequestTelemetry(requestId);
  if (!rec) return null;
  try { return rec.recordAttempt(attempt); } catch (e) { return null; }
}

module.exports = {
  RequestTokenTelemetry,
  createRequestTelemetry,
  getRequestTelemetry,
  releaseRequestTelemetry,
  recordAttemptFor,
  bucketOf
};
