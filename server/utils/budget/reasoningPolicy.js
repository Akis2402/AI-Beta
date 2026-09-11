'use strict';

// ============================================================================================
// PHẦN 4 — THINKING PROVIDER AWARE: getReasoningBudgetPolicy()
// ============================================================================================
// NGUYÊN NHÂN GỐC (PHẦN 1) mà file này sinh ra để sửa:
//
// Với Anthropic, `max_tokens` là NGÂN SÁCH DÙNG CHUNG cho CẢ reasoning lẫn văn bản hiển thị.
// Code cũ gọi `thinking.budget_tokens = nativeThinkingBudget(maxTokens) = 0.6 * maxTokens`, trong
// khi `maxTokens` được truyền vào lại là `coreBudget` (= 70% ngân sách đã tính). Kết quả thực tế:
//
//     visible answer = maxTokens - budget_tokens = 0.4 * (0.7 * target) = 28% target
//
// Tức là bật "Suy nghĩ sâu" làm phần TRẢ LỜI THẤY ĐƯỢC co lại còn hơn 1/4 so với ngân sách dự
// kiến — model gần như LUÔN bị cắt ở max_tokens -> finishReason='length' -> HARD 'finish_reason_length'
// -> recovery. Lượt recovery lại nhận `decision.amount` (lấy từ reserve = 30% target) làm maxTokens,
// VẪN bật deepThinking nên VẪN bị chia 60/40 -> lại bị cắt -> tiêu lô reserve tiếp -> reserve cạn ->
// "Câu trả lời chưa đầy đủ sau khi đã thử khôi phục — không thể coi là hoàn thành."
//
// Gemini còn nặng hơn: code cũ gửi `thinkingBudget: -1` (dynamic, model tự quyết) cùng
// `maxOutputTokens = maxTokens`. Thinking token của Gemini CŨNG tính vào maxOutputTokens, nên model
// có thể tiêu TOÀN BỘ ngân sách cho suy luận và trả về text RỖNG kèm finishReason=MAX_TOKENS.
//
// OpenAI Responses tương tự: `reasoning.effort='high'` + `max_output_tokens = maxTokens` — reasoning
// token tính vào max_output_tokens, effort 'high' rất dễ ăn hết ngân sách nhỏ -> status='incomplete',
// output rỗng.
//
// ---------- NGUYÊN TẮC MỚI (bất biến của toàn hệ thống) ----------
//   answerBudget    = ngân sách cho VĂN BẢN NGƯỜI DÙNG ĐỌC. KHÔNG BAO GIỜ bị reasoning ăn vào.
//   reasoningBudget = ngân sách CỘNG THÊM cho suy luận native.
//   providerMaxTokens = answerBudget + (reasoning có tính vào output ? reasoningBudget : 0)
//
// Nhờ vậy: bật Thinking KHÔNG làm giảm độ dài/độ đầy đủ câu trả lời (đúng "COMPLETENESS > ... >
// TOKEN EFFICIENCY"), và KHÔNG giảm độ sâu reasoning để tiết kiệm token.

/** Sàn tuyệt đối cho phần trả lời hiển thị — dưới mức này thì bật native thinking là tự sát. */
const MIN_ANSWER_TOKENS = 700;
/** Anthropic yêu cầu budget_tokens >= 1024 khi bật extended thinking. */
const ANTHROPIC_MIN_THINKING = 1024;
/** Trần reasoning mặc định — giữ reasoning SÂU nhưng không để 1 request ăn vô hạn ngân sách. */
const DEFAULT_MAX_REASONING = Number(process.env.MAX_REASONING_TOKENS) || 12000;

/**
 * Tỉ lệ reasoning/answer theo độ phức tạp. KHÔNG giảm theo token pressure — token saving phải đến
 * từ cache/dedup/compression (PHẦN 3/7), không phải từ việc cắt suy luận.
 */
const REASONING_RATIO = {
  short: 0.8,
  medium: 1.0,
  large: 1.2,
  very_large: 1.4
};

/**
 * getReasoningBudgetPolicy() — trả về CHÍNH SÁCH reasoning cho đúng 1 (provider, model, capability).
 *
 * @param {string} provider Khóa provider ('anthropic'|'openai'|'gemini'|<compatible key>).
 * @param {string} model Model id thật (đã qua discovery) — dùng để phân biệt thế hệ (Gemini 3 vs 2.5).
 * @param {{supportsThinking?:boolean, supportsAdaptiveThinking?:boolean}} [capabilities]
 *   undefined  = caller không biết gì (legacy direct call) -> permissive, giữ hành vi cũ.
 *   {}         = caller BIẾT nhưng model không khai capability -> fail-safe, KHÔNG gửi field lạ.
 * @param {{deepThinking?:boolean, fast?:boolean, stage?:string}} [context]
 * @returns {{
 *   mechanism:'none'|'prompt'|'anthropic_budget'|'openai_effort'|'gemini_budget'|'gemini_level'|'compatible_body',
 *   native:boolean,
 *   countsAgainstOutput:boolean,
 *   supportsExplicitBudget:boolean,
 *   minReasoningTokens:number,
 *   maxReasoningTokens:number,
 *   ratioFor:Function
 * }}
 */
function getReasoningBudgetPolicy(provider, model, capabilities, context = {}) {
  const { deepThinking = false, fast = false } = context;
  const providerKey = String(provider || '').toLowerCase();
  const modelId = String(model || '').toLowerCase();

  const base = {
    mechanism: 'none',
    native: false,
    countsAgainstOutput: false,
    supportsExplicitBudget: false,
    minReasoningTokens: 0,
    maxReasoningTokens: 0,
    ratioFor: (level) => REASONING_RATIO[level] || REASONING_RATIO.medium
  };

  // deepThinking=false -> KHÔNG có reasoning nào (ưu tiên latency/cost cho chế độ Nhanh).
  // fast=true -> model nhẹ, không bao giờ bật native reasoning.
  if (!deepThinking || fast) return base;

  const capsKnown = capabilities && typeof capabilities === 'object';
  const nativeCapable = capsKnown
    ? !!(capabilities.supportsThinking || capabilities.supportsAdaptiveThinking)
    : true; // legacy direct call: giữ hành vi permissive cũ

  // Không có native reasoning -> fallback prompt-based (buildDeepThinkingBlock trong system prompt).
  // KHÔNG gửi field API nào provider không hỗ trợ (PHẦN 4 + PHẦN 29).
  if (!nativeCapable) return { ...base, mechanism: 'prompt' };

  if (providerKey === 'anthropic' || providerKey.startsWith('anthropic')) {
    return {
      ...base,
      mechanism: 'anthropic_budget',
      native: true,
      countsAgainstOutput: true,     // max_tokens bao gồm cả thinking -> PHẢI cộng thêm
      supportsExplicitBudget: true,
      minReasoningTokens: ANTHROPIC_MIN_THINKING,
      maxReasoningTokens: DEFAULT_MAX_REASONING
    };
  }

  if (providerKey === 'openai' || providerKey.startsWith('openai')) {
    return {
      ...base,
      mechanism: 'openai_effort',
      native: true,
      countsAgainstOutput: true,     // reasoning token tính vào max_output_tokens
      supportsExplicitBudget: false, // chỉ có 'effort', không có số token cụ thể
      minReasoningTokens: 1024,
      maxReasoningTokens: DEFAULT_MAX_REASONING
    };
  }

  if (providerKey === 'gemini' || providerKey.startsWith('gemini') || providerKey === 'google') {
    // Gemini 3+ dùng thinkingLevel ('low'|'high'); 2.5-style dùng thinkingBudget (số token).
    const isGen3 = /gemini-3/.test(modelId);
    const is25 = /gemini-2\.5/.test(modelId);
    if (isGen3) {
      return {
        ...base, mechanism: 'gemini_level', native: true, countsAgainstOutput: true,
        supportsExplicitBudget: false, minReasoningTokens: 1024, maxReasoningTokens: DEFAULT_MAX_REASONING
      };
    }
    if (is25 || !capsKnown) {
      return {
        ...base, mechanism: 'gemini_budget', native: true, countsAgainstOutput: true,
        supportsExplicitBudget: true, minReasoningTokens: 1024, maxReasoningTokens: DEFAULT_MAX_REASONING
      };
    }
    // Thế hệ không xác định: fail-safe, không gửi cấu hình native mù (PHẦN 4).
    return { ...base, mechanism: 'prompt' };
  }

  // OpenAI-compatible: chỉ bật nếu provider TỰ khai supportsThinking + thinkingBody (extraProviders.js).
  return {
    ...base,
    mechanism: 'compatible_body',
    native: true,
    countsAgainstOutput: false, // đa số dùng max_tokens riêng cho completion; không cộng mù
    supportsExplicitBudget: false,
    minReasoningTokens: 0,
    maxReasoningTokens: DEFAULT_MAX_REASONING
  };
}

/**
 * Quy đổi ngân sách reasoning (số token) -> 'effort' của OpenAI Responses API.
 * Giữ reasoning SÂU: chỉ xuống 'medium' khi ngân sách thực sự nhỏ, không bao giờ vì "tiết kiệm".
 */
function effortFromBudget(reasoningBudget) {
  if (!Number.isFinite(reasoningBudget) || reasoningBudget <= 0) return null;
  if (reasoningBudget >= 6000) return 'high';
  if (reasoningBudget >= 2000) return 'medium';
  return 'low';
}

/** Quy đổi ngân sách reasoning -> thinkingLevel của Gemini 3+. */
function thinkingLevelFromBudget(reasoningBudget) {
  if (!Number.isFinite(reasoningBudget) || reasoningBudget <= 0) return null;
  return reasoningBudget >= 4000 ? 'high' : 'low';
}

module.exports = {
  getReasoningBudgetPolicy,
  effortFromBudget,
  thinkingLevelFromBudget,
  REASONING_RATIO,
  MIN_ANSWER_TOKENS,
  ANTHROPIC_MIN_THINKING,
  DEFAULT_MAX_REASONING
};
