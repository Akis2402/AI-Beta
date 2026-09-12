'use strict';

// ============================================================================================
// A1 — PROMPT CACHING: "system" có thể là STRING (như cũ) hoặc PARTS OBJECT (mới)
// ============================================================================================
// Trước bản sửa này, comment trong promptBuilder.js khẳng định CORE_DIRECTIVE "được prompt cache"
// chỉ vì nó nằm ở đầu system prompt. Điều đó SAI với Anthropic: API chỉ cache khi có
// `cache_control: {type:'ephemeral'}` tường minh trên content block. Kết quả: ở chế độ đối chiếu đa
// hướng, N candidate + 1 lượt reconcile đều trả tiền đầy đủ cho cùng một khối system tĩnh.
//
// Module này định nghĩa MỘT kiểu dữ liệu dùng chung để mọi client (anthropic/openai/gemini/
// openai-compatible) hiểu được:
//
//   PromptParts = { staticPart: string, cachedContextPart?: string, dynamicPart: string }
//
// - `staticPart`   : hoàn toàn KHÔNG phụ thuộc input động của lượt này (cache key ổn định).
// - `cachedContextPart` : khối ngữ cảnh nguồn lớn (PDF/web) dùng lại giữa nhiều lượt của cùng 1
//   request — chỉ đặt breakpoint khi đủ lớn (>= CACHE_MIN_TOKENS), nếu không sẽ tốn 1 breakpoint vô ích.
// - `dynamicPart`  : phần còn lại, thay đổi theo từng lượt.
//
// Client nào KHÔNG hỗ trợ cache tường minh (OpenAI/Gemini tự cache prefix trùng) chỉ cần ghép
// theo đúng thứ tự TĨNH -> CONTEXT -> ĐỘNG là đã đủ điều kiện để cache ngầm hoạt động.

/** Anthropic/OpenAI đều yêu cầu prefix >= ~1024 token mới cache được. */
const CACHE_MIN_TOKENS = 1024;

/** Ước lượng token thống nhất với phần còn lại của repo (~3.2 ký tự/token). */
function estimatePromptTokens(text) {
  return Math.ceil(String(text || '').length / 3.2);
}

function isPromptParts(value) {
  return !!(value && typeof value === 'object' && !Array.isArray(value)
    && (typeof value.staticPart === 'string' || typeof value.dynamicPart === 'string'));
}

/**
 * Ghép PromptParts (hoặc trả lại nguyên văn nếu đã là string) — dùng cho mọi provider KHÔNG có cơ
 * chế cache breakpoint tường minh. Thứ tự ghép giữ nguyên TĨNH -> CONTEXT -> ĐỘNG.
 * @returns {string}
 */
function systemToString(system) {
  if (!isPromptParts(system)) return system;
  return [system.staticPart, system.cachedContextPart, system.dynamicPart]
    .filter((s) => typeof s === 'string' && s.length)
    .join('\n');
}

/**
 * Dựng mảng content block cho Anthropic Messages API, có `cache_control` ở ĐÚNG 2 điểm tốn nhất
 * (A1 mục 3): (a) cuối khối system tĩnh, (b) cuối khối ngữ cảnh nguồn nếu đủ lớn.
 * @returns {Array<{type:'text', text:string, cache_control?:object}>|null} null nếu không nên dùng
 *   dạng mảng (caller giữ nguyên nhánh string cũ).
 */
function toAnthropicSystemBlocks(system) {
  if (!isPromptParts(system)) return null;
  const blocks = [];
  const staticPart = String(system.staticPart || '');
  const contextPart = String(system.cachedContextPart || '');
  const dynamicPart = String(system.dynamicPart || '');

  if (staticPart) {
    const block = { type: 'text', text: staticPart };
    // Breakpoint chỉ có ý nghĩa khi phần tĩnh đủ lớn; nhỏ hơn thì Anthropic bỏ qua và ta mất 1
    // breakpoint (tối đa 4) một cách vô ích.
    if (estimatePromptTokens(staticPart) >= CACHE_MIN_TOKENS) block.cache_control = { type: 'ephemeral' };
    blocks.push(block);
  }
  if (contextPart) {
    const block = { type: 'text', text: contextPart };
    if (estimatePromptTokens(contextPart) >= CACHE_MIN_TOKENS) block.cache_control = { type: 'ephemeral' };
    blocks.push(block);
  }
  if (dynamicPart) blocks.push({ type: 'text', text: dynamicPart });
  return blocks.length ? blocks : null;
}

/**
 * Nối thêm chỉ thị vào phần ĐỘNG (không bao giờ đụng vào phần tĩnh — nếu không cache key sẽ đổi và
 * toàn bộ lợi ích cache biến mất). Chuỗi thường vẫn nối như cũ.
 */
function appendToSystem(system, suffix) {
  if (!suffix) return system;
  if (!isPromptParts(system)) return String(system || '') + suffix;
  return { ...system, dynamicPart: String(system.dynamicPart || '') + suffix };
}

module.exports = {
  CACHE_MIN_TOKENS,
  estimatePromptTokens,
  isPromptParts,
  systemToString,
  toAnthropicSystemBlocks,
  appendToSystem
};
