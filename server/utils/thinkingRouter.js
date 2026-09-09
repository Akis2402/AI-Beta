'use strict';

// ---------- DEEP THINKING CAPABILITY ROUTING (mục 1) ----------
// TRƯỚC ĐÂY: chat.js hard-code `fast: true` ở CẢ 2 nhánh gọi trực tiếp (stream + non-stream, giai
// đoạn "hướng giải"/"giải chi tiết không cross-check") — BẤT KỂ input.deepThinking. Hệ quả: bật
// "Suy nghĩ sâu" chỉ đổi PROMPT (buildDeepThinkingBlock) trong khi model thực tế vẫn là model NHANH/
// NHẸ (fastModelOverride) — sai đúng như mục 1 mô tả.
//
// FIX: 1 hàm thuần (không gọi network, dễ test — mục 18.A/18.L) quyết định:
//   - deepThinking=false -> fast model, KHÔNG có cơ chế reasoning native (ưu tiên latency/cost).
//   - deepThinking=true  -> KHÔNG BAO GIỜ ép fast model; nếu provider khai supportsThinking/
//     supportsAdaptiveThinking (mục 13) thì bật cơ chế reasoning NATIVE của chính provider đó (client
//     tự quyết định tham số cụ thể — xem anthropicClient/geminiClient/openaiClient); nếu provider
//     không khai capability đó (mọi OpenAI-compatible provider hiện tại trừ khi cấu hình rõ) thì chỉ
//     fallback về prompt-based mechanism (buildDeepThinkingBlock — đã có sẵn, giữ nguyên).

/**
 * @param {{deepThinking:boolean, capabilities?:{supportsThinking?:boolean, supportsAdaptiveThinking?:boolean}}} args
 * @returns {{fast:boolean, deepThinking:boolean, useNativeThinking:boolean, mechanism:'none'|'native'|'prompt'}}
 */
function resolveThinkingMode({ deepThinking = false, capabilities = {} } = {}) {
  if (!deepThinking) {
    return { fast: true, deepThinking: false, useNativeThinking: false, mechanism: 'none' };
  }
  const nativeAvailable = !!(capabilities.supportsAdaptiveThinking || capabilities.supportsThinking);
  return {
    fast: false, // mục 1: deepThinking=true KHÔNG BAO GIỜ ép fast model
    deepThinking: true,
    useNativeThinking: nativeAvailable,
    mechanism: nativeAvailable ? 'native' : 'prompt'
  };
}

/**
 * Ngân sách token dành cho reasoning native (Anthropic `thinking.budget_tokens` / Gemini
 * `thinkingConfig.thinkingBudget`) — phải NHỎ HƠN maxTokens (yêu cầu bắt buộc của API), và có sàn
 * tối thiểu để native thinking thực sự có tác dụng, không phải 1 con số tượng trưng.
 * @param {number} maxTokens
 * @returns {number}
 */
function nativeThinkingBudget(maxTokens) {
  const budget = Math.round((maxTokens || 1000) * 0.6);
  return Math.max(1024, Math.min(budget, Math.max(1024, (maxTokens || 1000) - 200)));
}

module.exports = { resolveThinkingMode, nativeThinkingBudget };
