'use strict';

// ============================================================================================
// PHẦN 2 — TÁCH REASONING BUDGET / ANSWER BUDGET / RECOVERY BUDGET / VISUAL BUDGET
// ============================================================================================
// Trước đây toàn hệ thống chỉ có MỘT con số: `calculateAdaptiveBudget().target`, rồi
// allocateCoreReserve() chia 70/30 thành core/reserve, rồi con số core đó bị dùng làm `max_tokens`
// cho provider — trong khi `max_tokens` của Anthropic/Gemini/OpenAI-Responses lại BAO GỒM CẢ
// reasoning token. Tức là một ngân sách duy nhất đang phục vụ 3 mục đích xung khắc nhau:
// suy luận nội bộ, văn bản hiển thị, và phần dự phòng để viết tiếp.
//
// resolveBudget() dưới đây trả về MỘT KẾ HOẠCH RÕ RÀNG:
//
//   TOTAL REQUEST PLAN
//   ├── reasoningBudget   (suy luận native — CỘNG THÊM, không lấn answer)
//   ├── answerBudget      (văn bản người dùng đọc — lượt gọi đầu tiên)
//   ├── recoveryBudget    (dự phòng cho continuation/resume)
//   └── visualBudget      (spec/prompt hình minh họa — tách hẳn, xem PHẦN 30)
//
// và `providerMaxTokens` = con số THẬT phải gửi cho provider ở lượt gọi này.

const { calculateAdaptiveBudget, HARD_CEILING } = require('../adaptiveBudget');
const { getReasoningBudgetPolicy, MIN_ANSWER_TOKENS } = require('./reasoningPolicy');

// Tỷ lệ core/recovery giữ NGUYÊN 70/30 như tokenEconomy.allocateCoreReserve (không đổi hợp đồng cũ).
const CORE_RATIO = 0.7;
// Ngân sách cho toàn bộ hệ thống hình minh họa (spec + prompt ảnh). Rất nhỏ theo thiết kế: PHẦN 17
// yêu cầu image prompt là "DELTA MINIMUM SUFFICIENT CONTEXT", không phải cả lời giải.
const VISUAL_BUDGET_TOKENS = Number(process.env.VISUAL_BUDGET_TOKENS) || 700;

/**
 * resolveBudget() — kế hoạch ngân sách cho ĐÚNG 1 lượt gọi provider.
 *
 * @param {object} opts
 * @param {string} [opts.provider] providerKey của target sẽ gọi (để lấy đúng reasoning policy).
 * @param {string} [opts.model] modelId thật.
 * @param {object} [opts.capabilities] capability đã merge (provider + model discovery).
 * @param {'fast'|'thinking'|'crosscheck'} [opts.mode]
 * @param {string} opts.stage 'approach'|'detail'|'candidate'|'reconcile'|'reconcileLight'|...
 * @param {'initial'|'recovery'|'visual'} [opts.phase='initial']
 * @param {number} [opts.remainingMs] deadline.remaining() TẠI THỜI ĐIỂM gọi.
 * @param {boolean} [opts.requiresVisual]
 * @param {number} [opts.deficitTokens] (phase='recovery') phần còn thiếu đã ước lượng.
 * @returns {{reasoningBudget:number, answerBudget:number, recoveryBudget:number, visualBudget:number,
 *   totalBudget:number, providerMaxTokens:number, strategy:string, complexity:object,
 *   reasoningMechanism:string, reasoningCountsAgainstOutput:boolean, timeBudget:number}}
 */
function resolveBudget(opts = {}) {
  const {
    provider, model, capabilities, stage = 'detail', phase = 'initial',
    problemText = '', historyText = '', contextsText = '', approachText = '',
    hasImage = false, deepThinking = false, crossCheck = false, fast = false,
    remainingMs, throughputTokensPerSec, requiresVisual = false, deficitTokens
  } = opts;

  const policy = getReasoningBudgetPolicy(provider, model, capabilities, { deepThinking, fast, stage });

  // ---------- 1. Ngân sách ANSWER theo độ phức tạp (không đụng reasoning) ----------
  // QUAN TRỌNG: truyền deepThinking=false vào calculateAdaptiveBudget. Hệ số ×1.35 cũ ở đó là một
  // cách "ước chừng chỗ cho khối <thinking> nằm chung trong output" của cơ chế prompt-based; với
  // native reasoning, chỗ đó nay được cấp RIÊNG qua reasoningBudget nên không được cộng 2 lần.
  // Cơ chế prompt-based (provider không có native) vẫn cần hệ số đó -> giữ lại đúng trường hợp này.
  const promptBasedThinking = deepThinking && (policy.mechanism === 'prompt' || policy.mechanism === 'none');
  const base = calculateAdaptiveBudget({
    stage, problemText, historyText, contextsText, approachText, hasImage,
    deepThinking: promptBasedThinking, crossCheck,
    // Thời gian: reasoning token CŨNG tốn wall-clock. Chia ngân sách thời gian cho (1 + ratio) để
    // phần answer không bao giờ bị timeout giữa chừng chỉ vì model còn đang suy luận.
    remainingMs: Number.isFinite(remainingMs) && policy.native
      ? remainingMs / (1 + policy.ratioFor('medium'))
      : remainingMs,
    throughputTokensPerSec
  });

  let answerTarget = base.target;

  // ---------- 2. Ngân sách REASONING — CỘNG THÊM, không trừ vào answer ----------
  let reasoningBudget = 0;
  if (policy.native) {
    const ratio = policy.ratioFor(base.complexity.level);
    reasoningBudget = Math.round(answerTarget * ratio);
    reasoningBudget = Math.max(policy.minReasoningTokens, Math.min(reasoningBudget, policy.maxReasoningTokens));
  }

  // ---------- 3. Chia core (lượt đầu) / recovery (dự phòng) TRÊN answer budget ----------
  const answerCore = Math.max(MIN_ANSWER_TOKENS, Math.round(answerTarget * CORE_RATIO));
  const recoveryBudget = Math.max(200, answerTarget - answerCore);

  // ---------- 4. phase='recovery': ngân sách theo phần CÒN THIẾU (delta), không phải cả bài ----------
  let answerBudget = answerCore;
  let strategy = policy.native ? `native_${policy.mechanism}` : (promptBasedThinking ? 'prompt_thinking' : 'plain');
  if (phase === 'recovery') {
    const want = Number.isFinite(deficitTokens) && deficitTokens > 0 ? Math.round(deficitTokens) : recoveryBudget;
    answerBudget = Math.max(MIN_ANSWER_TOKENS, Math.min(want, HARD_CEILING));
    // PHẦN 6: lượt tiếp nối KHÔNG cần suy luận lại từ đầu — nó đã có toàn bộ kết quả trung gian
    // trong ngữ cảnh tối thiểu. Giảm reasoning ở đây KHÔNG phải "cắt reasoning để tiết kiệm token":
    // công việc suy luận đã hoàn thành ở lượt trước, lượt này chỉ VIẾT TIẾP phần còn thiếu.
    if (reasoningBudget > 0) {
      reasoningBudget = Math.max(policy.minReasoningTokens, Math.round(reasoningBudget * 0.4));
    }
    strategy += '_delta_recovery';
  }

  const visualBudget = requiresVisual ? VISUAL_BUDGET_TOKENS : 0;

  // ---------- 5. Con số THẬT gửi provider ----------
  const providerMaxTokens = policy.countsAgainstOutput
    ? answerBudget + reasoningBudget
    : answerBudget;

  return {
    reasoningBudget,
    answerBudget,
    recoveryBudget,
    visualBudget,
    totalBudget: answerBudget + recoveryBudget + reasoningBudget + visualBudget,
    providerMaxTokens,
    strategy,
    complexity: base.complexity,
    timeBudget: base.timeBudget,
    reasoningMechanism: policy.mechanism,
    reasoningCountsAgainstOutput: policy.countsAgainstOutput
  };
}

/**
 * Ngân sách reasoning cho 1 answerBudget đã biết — dùng ở các điểm gọi đã có sẵn coreBudget
 * (chat.js giữ nguyên budgetPlanOf/coreBudget để không phá hợp đồng cũ, chỉ bổ sung field này).
 * @returns {number} 0 nếu provider/model không có native reasoning.
 */
function reasoningBudgetFor({ provider, model, capabilities, deepThinking, fast, answerBudget, complexityLevel = 'medium' }) {
  const policy = getReasoningBudgetPolicy(provider, model, capabilities, { deepThinking, fast });
  if (!policy.native) return 0;
  const want = Math.round((answerBudget || 1000) * policy.ratioFor(complexityLevel));
  return Math.max(policy.minReasoningTokens, Math.min(want, policy.maxReasoningTokens));
}

module.exports = { resolveBudget, reasoningBudgetFor, CORE_RATIO, VISUAL_BUDGET_TOKENS };

/**
 * genericReasoningBudget() — ngân sách reasoning KHÔNG phụ thuộc provider cụ thể.
 *
 * chat.js không biết trước target nào sẽ thắng rotation/failover, nên nó tính MỘT con số rồi truyền
 * kèm mọi lượt gọi; mỗi client tự GATE theo capability thật của model nó đang gọi (anthropicClient/
 * geminiClient/openaiClient) — provider không hỗ trợ reasoning sẽ bỏ qua field này hoàn toàn, nên
 * việc truyền luôn AN TOÀN (PHẦN 29: không gửi tham số không được hỗ trợ tới API).
 *
 * @param {{answerBudget:number, complexityLevel?:string, deepThinking:boolean, phase?:string}} opts
 * @returns {number} 0 khi không bật deep thinking.
 */
function genericReasoningBudget({ answerBudget, complexityLevel = 'medium', deepThinking, phase = 'initial' }) {
  if (!deepThinking) return 0;
  const { REASONING_RATIO, ANTHROPIC_MIN_THINKING, DEFAULT_MAX_REASONING } = require('./reasoningPolicy');
  const ratio = REASONING_RATIO[complexityLevel] || REASONING_RATIO.medium;
  let want = Math.round((answerBudget || 1000) * ratio);
  // PHẦN 6: lượt tiếp nối đã có toàn bộ kết quả trung gian trong ngữ cảnh — không phải suy luận lại
  // từ đầu. Đây KHÔNG phải "cắt reasoning để tiết kiệm token".
  if (phase === 'recovery') want = Math.round(want * 0.4);
  return Math.max(ANTHROPIC_MIN_THINKING, Math.min(want, DEFAULT_MAX_REASONING));
}

module.exports.genericReasoningBudget = genericReasoningBudget;
