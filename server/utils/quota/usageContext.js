'use strict';

// ============================================================================================
// USAGE CONTEXT — gắn "sổ token của request này" vào chuỗi async bằng AsyncLocalStorage
// ============================================================================================
// Vấn đề: token THẬT chỉ biết sau khi provider trả lời, ở sâu trong aiProviders.logAttempt() (điểm
// nghẽn duy nhất mọi lượt gọi AI đi qua). Luồn `userId/requestId` qua hàng chục chữ ký hàm của
// chat.js (2000+ dòng) dễ rơi mất đúng như các bug đã ghi trong tokenTelemetry.js.
// Giải pháp: middleware quota mở một ALS context; logAttempt()/callClaudeWebSearch() chỉ cần gọi
// recordUsage() — nếu không có context (test, đường gọi nội bộ) thì no-op.
//
// Cộng dồn từ MỌI lượt gọi trong request (cross-check, reconcile, recovery, retry...): tiền thật
// đã tiêu cho từng lượt, kể cả lượt bị bỏ kết quả.

const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

function createContext({ userId, requestId, kind, granted }) {
  return {
    userId, requestId, kind, granted,
    attempts: 0,            // số lượt gọi provider đã ghi nhận (thành công hay không)
    meteredAttempts: 0,     // số lượt có usage THẬT từ provider
    input: 0, output: 0, reasoning: 0, cached: 0, cacheCreation: 0, media: 0, toolUse: 0,
    flat: 0,                // chi phí cố định quy đổi ra token (ảnh sinh thành công...)
    estimatedOutput: 0,     // chỉ dùng để hiển thị/log; KHÔNG dùng tính tiền khi đã có usage thật
    provider: null, model: null,
    settled: false
  };
}

function run(ctx, fn) { return als.run(ctx, fn); }
function current() { return als.getStore() || null; }

const n = (v) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? Math.round(x) : 0; };

/**
 * Ghi một lượt gọi provider vào context hiện tại. An toàn khi không có context.
 * @param {{usage?:object, provider?:string, model?:string, estimatedOutputTokens?:number}} a
 */
function recordUsage(a = {}) {
  const ctx = als.getStore();
  if (!ctx || ctx.settled) return false;
  ctx.attempts += 1;
  if (a.provider) ctx.provider = a.provider;
  if (a.model) ctx.model = a.model;
  const u = a.usage;
  const real = u && (n(u.inputTokens) > 0 || n(u.outputTokens) > 0);
  if (real) {
    ctx.meteredAttempts += 1;
    ctx.input += n(u.inputTokens);
    ctx.output += n(u.outputTokens);
    ctx.reasoning += n(u.reasoningTokens);
    ctx.cached += n(u.cachedTokens);
    ctx.cacheCreation += n(u.cacheCreationTokens);
    ctx.media += n(u.imageInputTokens) + n(u.imageOutputTokens);
    ctx.toolUse += n(u.toolUseTokens);
  } else {
    ctx.estimatedOutput += n(a.estimatedOutputTokens);
  }
  return true;
}

/**
 * Ghi một khoản chi phí CỐ ĐỊNH quy đổi ra token (vd. 1 ảnh server sinh thành công). Provider ảnh không trả usage
 * kiểu token, nhưng tiền thật đã chi => phải tính vào hạn mức. An toàn khi không có context (no-op).
 */
function recordFlatCost(tokens, meta = {}) {
  const ctx = als.getStore();
  if (!ctx || ctx.settled) return false;
  const t = n(tokens);
  if (t <= 0) return false;
  ctx.attempts += 1;
  ctx.meteredAttempts += 1;
  ctx.flat += t;
  if (meta.provider) ctx.provider = ctx.provider || meta.provider;
  if (meta.model) ctx.model = ctx.model || meta.model;
  return true;
}

/**
 * Token tính vào quota. Quy ước: input + output + reasoning + media + tool + cacheCreation
 * + 10% token đọc từ cache (cache đọc rẻ hơn ~10 lần ở hầu hết provider) + chi phí cố định (ảnh).
 */
function chargeableTokens(ctx) {
  return ctx.input + ctx.output + ctx.reasoning + ctx.media + ctx.toolUse + ctx.cacheCreation + ctx.flat + Math.ceil(ctx.cached * 0.1);
}

module.exports = { createContext, run, current, recordUsage, recordFlatCost, chargeableTokens };
