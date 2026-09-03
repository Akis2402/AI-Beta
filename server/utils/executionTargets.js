'use strict';

// ---------- Execution Target: 1 cặp (API Key × Model) = 1 đơn vị rotation độc lập ----------
// KHÔNG coi "AI = API Key" hay "AI = Model". Mỗi provider (Claude/GPT/Gemini/... + các provider bổ
// sung trong extraProviders.js) có thể khai NHIỀU khóa API và NHIỀU model qua .env (phân tách bằng
// dấu phẩy/xuống dòng — xem parseMultiEnv). Module này liệt kê TƯỜNG MINH mọi tổ hợp Key×Model
// thành 1 ExecutionTarget riêng, để rotationManager.js xoay vòng CÔNG BẰNG qua từng tổ hợp thay vì
// random chọn model mỗi lần gọi (hành vi cũ) — đúng yêu cầu mục 2 & 4.
//
// Model "nhanh" (fast:true, dùng cho chế độ Nhanh) KHÔNG được enumerate thành target riêng — nó vẫn
// là 1 lựa chọn ngẫu nhiên trong danh sách model nhanh của CÙNG khóa đó tại thời điểm gọi (giữ
// nguyên hành vi cũ cho đường Nhanh, nơi callFastest() đã đua song song nhiều target nên tính công
// bằng ít quan trọng hơn tốc độ). Việc này được note rõ trong báo cáo cuối — có thể mở rộng sau nếu
// cần rotation công bằng cho cả model nhanh.

const { callClaude, callClaudeStream } = require('./anthropicClient');
const { callOpenAI, callOpenAIStream, MODEL: OPENAI_DEFAULT_MODEL } = require('./openaiClient');
const { callGemini, callGeminiStream, MODEL: GEMINI_DEFAULT_MODEL } = require('./geminiClient');
const { createOpenAICompatibleClient } = require('./openaiCompatibleClient');
const { EXTRA_PROVIDERS } = require('../config/extraProviders');

const ANTHROPIC_DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const WEB_SEARCH_TOOL_ANTHROPIC = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }];

function parseMultiEnv(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function pickRandomOrUndefined(list) {
  return list.length ? list[Math.floor(Math.random() * list.length)] : undefined;
}

/**
 * Xây danh sách ExecutionTarget cho 1 provider definition — 1 phần tử cho MỖI tổ hợp (API key × model).
 * Nếu provider chỉ khai 1 model, mỗi khóa sinh đúng 1 target (tương thích ngược 100% với cấu hình cũ).
 *
 * @param {{baseKey:string, baseLabel:string, apiKeyEnv:string, modelEnv:string, fastModelEnv:string,
 *   defaultModel?:string, supportsWebSearch:boolean, call:Function, callStream:Function}} def
 * @returns {Array<ExecutionTarget>}
 */
function buildTargetsForDef({ baseKey, baseLabel, apiKeyEnv, modelEnv, fastModelEnv, defaultModel, supportsWebSearch, call, callStream }) {
  const apiKeys = parseMultiEnv(process.env[apiKeyEnv]);
  if (!apiKeys.length) return [];
  let models = parseMultiEnv(process.env[modelEnv]);
  if (!models.length) models = [defaultModel || 'default'];
  const fastModels = parseMultiEnv(process.env[fastModelEnv]);

  const targets = [];
  apiKeys.forEach((apiKeyOverride, keyIndex) => {
    const keyId = apiKeys.length > 1 ? `${baseKey}#${keyIndex + 1}` : baseKey;
    const keySuffix = apiKeys.length > 1 ? ` #${keyIndex + 1}` : '';
    models.forEach((modelName) => {
      const modelId = `${baseKey}::${modelName}`;
      const targetId = `${keyId}::${modelName}`;
      const label = models.length > 1
        ? `${baseLabel}${keySuffix} (${modelName})`
        : `${baseLabel}${keySuffix}${modelName ? ` (${modelName})` : ''}`;

      targets.push({
        id: targetId,
        providerKey: baseKey,
        keyId,
        modelId,
        modelName,
        label,
        supportsWebSearch,
        // Dùng cho nơi gọi cũ (aiProviders.js) vẫn còn code đọc `.key` — giữ tương thích, trỏ
        // thẳng vào keyId vì cooldown 429/khóa vẫn nên tra theo khóa trước tiên.
        key: keyId,
        call: (args) => call({
          ...args,
          apiKeyOverride,
          modelOverride: modelName,
          fastModelOverride: pickRandomOrUndefined(fastModels)
        }),
        callStream: (args) => callStream({
          ...args,
          apiKeyOverride,
          modelOverride: modelName,
          fastModelOverride: pickRandomOrUndefined(fastModels)
        })
      });
    });
  });
  return targets;
}

const CORE_DEFS = [
  {
    baseKey: 'anthropic',
    baseLabel: 'Claude',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    modelEnv: 'ANTHROPIC_MODEL',
    fastModelEnv: 'ANTHROPIC_MODEL_FAST',
    defaultModel: ANTHROPIC_DEFAULT_MODEL,
    supportsWebSearch: true,
    call: ({ webSearch, ...rest }) => callClaude({ ...rest, tools: webSearch ? WEB_SEARCH_TOOL_ANTHROPIC : undefined }),
    callStream: ({ webSearch, ...rest }) => callClaudeStream({ ...rest, tools: webSearch ? WEB_SEARCH_TOOL_ANTHROPIC : undefined })
  },
  {
    baseKey: 'openai',
    baseLabel: 'GPT',
    apiKeyEnv: 'OPENAI_API_KEY',
    modelEnv: 'OPENAI_MODEL',
    fastModelEnv: 'OPENAI_MODEL_FAST',
    defaultModel: OPENAI_DEFAULT_MODEL,
    supportsWebSearch: true,
    call: callOpenAI,
    callStream: callOpenAIStream
  },
  {
    baseKey: 'gemini',
    baseLabel: 'Gemini',
    apiKeyEnv: 'GEMINI_API_KEY',
    modelEnv: 'GEMINI_MODEL',
    fastModelEnv: 'GEMINI_MODEL_FAST',
    defaultModel: GEMINI_DEFAULT_MODEL,
    supportsWebSearch: true,
    call: callGemini,
    callStream: callGeminiStream
  }
];

// Mỗi provider bổ sung dùng CHUNG 1 client OpenAI-compatible — apiKeyOverride/modelOverride khác
// nhau theo từng target vẫn phục vụ được nhiều khóa/model qua đúng 1 client instance.
const EXTRA_DEFS = EXTRA_PROVIDERS.map((cfg) => {
  const client = createOpenAICompatibleClient(cfg);
  return {
    baseKey: cfg.key,
    baseLabel: cfg.label,
    apiKeyEnv: cfg.apiKeyEnv,
    modelEnv: cfg.modelEnv,
    fastModelEnv: cfg.fastModelEnv,
    supportsWebSearch: false,
    call: client.call,
    callStream: client.callStream
  };
});

const ALL_DEFS = [...CORE_DEFS, ...EXTRA_DEFS];

/**
 * Trả về TOÀN BỘ execution target đã cấu hình (đọc .env lại mỗi lần gọi — không cache, xem lý do
 * gốc trong aiProviders.js cũ: đổi .env + khởi động lại server là có hiệu lực ngay).
 * @returns {Array<ExecutionTarget>}
 */
function getAllExecutionTargets() {
  return ALL_DEFS.flatMap(buildTargetsForDef);
}

module.exports = { getAllExecutionTargets, parseMultiEnv };
