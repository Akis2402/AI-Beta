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
// ============================================================================================
// A2 — TRẦN REASONING PHẢI THEO ĐÚNG MODEL, KHÔNG DÙNG 1 HẰNG SỐ GLOBAL
// ============================================================================================
// RỦI RO ĐÃ TỰ GHI NHẬN trong CHANGELOG-THINKING-VISUAL.md mục G.4 nhưng chưa xử lý:
// DEFAULT_MAX_REASONING áp dụng y hệt cho MỌI model. Với 1 model nhỏ có trần output thật chỉ
// 4096 token, việc xin 12000 token reasoning là vô nghĩa (providerMaxTokens = answer + reasoning
// vượt xa max output của model -> hoặc bị API từ chối, hoặc bị cắt ngang giữa chừng).
//
// NAY: nếu capabilities (merge từ model-discovery qua executionTargets.js) biết `maxOutputTokens`
// THẬT của model, trần reasoning bị KẸP theo model. KHÔNG biết -> giữ nguyên DEFAULT_MAX_REASONING
// (không đổi hành vi mặc định khi thiếu thông tin — A2.4).
//
// Đây KHÔNG phải "cắt suy luận để tiết kiệm token": nó chỉ ngăn việc xin một ngân sách mà model
// VẬT LÝ không thể cấp. Tỷ lệ 0.5 để phần answer luôn còn ít nhất nửa trần output của model.
const MODEL_REASONING_SHARE = Number(process.env.MODEL_REASONING_SHARE) || 0.5;

/**
 * maxReasoningForModel() — trần reasoning THẬT cho 1 model cụ thể.
 * @param {{maxOutputTokens?:number}} [capabilities]
 * @param {number} [defaultCap]
 * @returns {number}
 */
function maxReasoningForModel(capabilities, defaultCap = DEFAULT_MAX_REASONING) {
  const maxOut = capabilities && Number(capabilities.maxOutputTokens);
  if (!Number.isFinite(maxOut) || maxOut <= 0) return defaultCap;
  const capped = Math.floor(maxOut * MODEL_REASONING_SHARE);
  // Sàn ANTHROPIC_MIN_THINKING: không bao giờ trả về trần NHỎ HƠN mức tối thiểu hợp lệ của API,
  // nếu không sẽ sinh ra budget vô lệ (max < min) ở requestBudgetPlanner.
  return Math.max(ANTHROPIC_MIN_THINKING, Math.min(defaultCap, capped));
}

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

// ============================================================================================
// A5 — REASONING PHẢI TỈ LỆ VỚI KHỐI LƯỢNG SUY LUẬN THẬT, KHÔNG PHẢI VỚI CỜ deepThinking
// ============================================================================================
// Vấn đề đã quan sát: "12 * 8 = ?" bật Deep Thinking vẫn được cấp >= ANTHROPIC_MIN_THINKING (1024)
// token reasoning — bằng với một bài chứng minh hình học. Đây không phải lỗi làm tròn: sàn 1024 là
// yêu cầu CỨNG của Anthropic khi bật extended thinking, nên cách duy nhất để một câu MICRO không tiêu
// hàng nghìn reasoning token là KHÔNG bật native reasoning cho nó (scale = 0 -> mechanism 'prompt').
// Câu MICRO vẫn giữ nguyên khối suy luận prompt-based trong system prompt, tức KHÔNG hề "suy luận
// nông hơn" — chỉ là không mua một ngân sách reasoning riêng mà bài đó không dùng hết.
//
// Các lớp còn lại được nhân theo khối lượng thật; STANDARD giữ hệ số 1.0 (không đổi hành vi cũ).
const PROBLEM_CLASS_REASONING_SCALE = {
  MICRO: 0,
  SHORT: 0.5,
  STANDARD: 1,
  COMPLEX: 1.15,
  VERY_COMPLEX: 1.3
};

/**
 * @param {string} [problemClass] Nhãn từ tokenEconomy.classifyProblem(). Không truyền (undefined)
 *   => 1 (giữ NGUYÊN hành vi của mọi call-site cũ chưa biết problemClass).
 * @returns {number}
 */
function reasoningScaleForClass(problemClass) {
  if (!problemClass) return 1;
  const scale = PROBLEM_CLASS_REASONING_SCALE[String(problemClass).toUpperCase()];
  return Number.isFinite(scale) ? scale : 1;
}

/** Sàn TUYỆT ĐỐI cho phần văn bản hiển thị khi model có trần output rất nhỏ. */
const MIN_VISIBLE_ANSWER_TOKENS = 400;

/**
 * fitReasoningToModel() — CHỐT CUỐI CÙNG trước khi gửi request đi.
 *
 * maxReasoningForModel() ở trên là TRẦN CHÍNH SÁCH (luôn >= ANTHROPIC_MIN_THINKING để không bao giờ
 * sinh ra một khoảng min>max vô lệ ở tầng planner). Nó KHÔNG đủ để bảo đảm bất biến E của spec:
 *
 *     answerBudget + reasoningBudget <= model.maxOutputTokens
 *
 * vì answerBudget được tính độc lập với trần model. Hàm này nhận CẢ HAI con số cùng lúc và:
 *   1. Kẹp tổng vào đúng maxOutputTokens THẬT của model.
 *   2. Ưu tiên giữ answer >= MIN_VISIBLE_ANSWER_TOKENS (người dùng luôn phải đọc được câu trả lời).
 *   3. Nếu sau khi kẹp mà phần reasoning còn lại KHÔNG đạt mức tối thiểu hợp lệ của provider
 *      (vd Anthropic cần >= 1024), TẮT HẲN native reasoning thay vì gửi một budget bị API từ chối.
 *      Đây không phải "cắt suy luận để tiết kiệm token" — model đó VẬT LÝ không thể vừa suy luận
 *      vừa trả lời trong trần output của nó, nên cơ chế đúng là prompt-based (vẫn suy luận đầy đủ).
 *
 * @param {{reasoningBudget:number, answerBudget:number, capabilities?:object,
 *   minReasoningTokens?:number, countsAgainstOutput?:boolean}} opts
 * @returns {{nativeEnabled:boolean, reasoningBudget:number, answerBudget:number,
 *   providerMaxTokens:number, clamped:boolean}}
 */
function fitReasoningToModel({
  reasoningBudget = 0, answerBudget = 0, capabilities,
  minReasoningTokens = 0, countsAgainstOutput = true
} = {}) {
  let answer = Math.max(1, Math.round(Number(answerBudget) || 0));
  let reasoning = Math.max(0, Math.round(Number(reasoningBudget) || 0));
  const minR = Math.max(0, Math.round(Number(minReasoningTokens) || 0));
  const maxOut = capabilities && Number(capabilities.maxOutputTokens);
  const known = Number.isFinite(maxOut) && maxOut > 0;

  if (!known) {
    // Không biết trần model -> KHÔNG kẹp (giữ nguyên hành vi cũ, A2.4).
    return {
      nativeEnabled: reasoning > 0,
      reasoningBudget: reasoning,
      answerBudget: answer,
      providerMaxTokens: countsAgainstOutput ? answer + reasoning : answer,
      clamped: false
    };
  }

  const before = `${answer}:${reasoning}`;
  answer = Math.min(answer, maxOut);

  if (!countsAgainstOutput) {
    // Provider tách hẳn 2 ngân sách (vd một số OpenAI-compatible) — vẫn không được xin nhiều hơn
    // trần output của model cho riêng phần reasoning.
    reasoning = Math.min(reasoning, maxOut);
    if (reasoning > 0 && minR > 0 && reasoning < minR) reasoning = 0;
    return {
      nativeEnabled: reasoning > 0,
      reasoningBudget: reasoning,
      answerBudget: answer,
      providerMaxTokens: answer,
      clamped: `${answer}:${reasoning}` !== before
    };
  }

  if (reasoning > 0 && answer + reasoning > maxOut) {
    const answerFloor = Math.min(answer, Math.max(MIN_VISIBLE_ANSWER_TOKENS, Math.round(maxOut * 0.25)));
    reasoning = Math.min(reasoning, Math.max(0, maxOut - answerFloor));
    answer = Math.min(answer, Math.max(1, maxOut - reasoning));
  }
  if (reasoning > 0 && minR > 0 && reasoning < minR) {
    reasoning = 0; // model không đủ chỗ cho ngân sách reasoning HỢP LỆ -> fallback prompt-based
    answer = Math.min(answer, maxOut);
  }

  return {
    nativeEnabled: reasoning > 0,
    reasoningBudget: reasoning,
    answerBudget: answer,
    providerMaxTokens: Math.min(maxOut, answer + reasoning),
    clamped: `${answer}:${reasoning}` !== before
  };
}

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
  const { deepThinking = false, fast = false, problemClass } = context;
  const providerKey = String(provider || '').toLowerCase();
  const modelId = String(model || '').toLowerCase();
  const classScale = reasoningScaleForClass(problemClass);

  const base = {
    mechanism: 'none',
    native: false,
    countsAgainstOutput: false,
    supportsExplicitBudget: false,
    minReasoningTokens: 0,
    maxReasoningTokens: 0,
    classScale,
    ratioFor: (level) => (REASONING_RATIO[level] || REASONING_RATIO.medium) * classScale
  };

  // deepThinking=false -> KHÔNG có reasoning nào (ưu tiên latency/cost cho chế độ Nhanh).
  // fast=true -> model nhẹ, không bao giờ bật native reasoning.
  if (!deepThinking || fast) return base;
  // A5: lớp MICRO (vd "12 * 8 = ?") KHÔNG mua ngân sách native reasoning riêng — sàn 1024 của
  // Anthropic khiến việc bật native cho câu như vậy tốn gấp nhiều lần chính câu trả lời. Suy luận
  // vẫn diễn ra qua khối prompt-based có sẵn trong system prompt (KHÔNG nông hơn).
  if (classScale === 0) return { ...base, mechanism: 'prompt' };

  const capsKnown = capabilities && typeof capabilities === 'object';
  // A2: trần reasoning của ĐÚNG model này (kẹp theo maxOutputTokens thật nếu discovery biết).
  const modelCap = maxReasoningForModel(capsKnown ? capabilities : null);
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
      maxReasoningTokens: modelCap
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
      maxReasoningTokens: modelCap
    };
  }

  if (providerKey === 'gemini' || providerKey.startsWith('gemini') || providerKey === 'google') {
    // Gemini 3+ dùng thinkingLevel ('low'|'high'); 2.5-style dùng thinkingBudget (số token).
    const isGen3 = /gemini-3/.test(modelId);
    const is25 = /gemini-2\.5/.test(modelId);
    if (isGen3) {
      return {
        ...base, mechanism: 'gemini_level', native: true, countsAgainstOutput: true,
        supportsExplicitBudget: false, minReasoningTokens: 1024, maxReasoningTokens: modelCap
      };
    }
    if (is25 || !capsKnown) {
      return {
        ...base, mechanism: 'gemini_budget', native: true, countsAgainstOutput: true,
        supportsExplicitBudget: true, minReasoningTokens: 1024, maxReasoningTokens: modelCap
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
    maxReasoningTokens: modelCap
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
  maxReasoningForModel,
  fitReasoningToModel,
  reasoningScaleForClass,
  PROBLEM_CLASS_REASONING_SCALE,
  MIN_VISIBLE_ANSWER_TOKENS,
  MODEL_REASONING_SHARE,
  effortFromBudget,
  thinkingLevelFromBudget,
  REASONING_RATIO,
  MIN_ANSWER_TOKENS,
  ANTHROPIC_MIN_THINKING,
  DEFAULT_MAX_REASONING
};
