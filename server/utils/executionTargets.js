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
const { callOpenAI, callOpenAIStream } = require('./openaiClient');
const { callGemini, callGeminiStream } = require('./geminiClient');
const { createOpenAICompatibleClient } = require('./openaiCompatibleClient');
const { EXTRA_PROVIDERS } = require('../config/extraProviders');
const { getCachedModels } = require('./modelDiscovery');

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
 * NGUỒN MODEL cho mỗi khóa API (mục 2/12/24 — KHÔNG hard-code fallback):
 *   1. Legacy explicit override: modelEnv/fastModelEnv có giá trị trong .env -> dùng ĐÚNG như cũ,
 *      KHÔNG qua discovery (người dùng đã tự chọn model, tôn trọng lựa chọn đó).
 *   2. Auto discovery (mặc định mới, KHÔNG cấu hình modelEnv): đọc model đã được modelDiscovery.js
 *      xác nhận qua cache (getCachedModels — đồng bộ, không gọi mạng ở đây). Nếu cache trống (chưa
 *      warm hoặc discovery thất bại và không có cache cũ), khóa đó KHÔNG sinh target nào cho lượt
 *      gọi này — aiProviders.ensureProvidersReady() phải được gọi TRƯỚC (xem chat.js/generate.js/...)
 *      để warm cache; KHÔNG bao giờ fallback về 1 chuỗi model đoán mò/hard-code.
 *
 * @param {{baseKey:string, baseLabel:string, apiKeyEnv:string, modelEnv:string, fastModelEnv:string,
 *   supportsWebSearch:boolean, call:Function, callStream:Function}} def
 * @returns {Array<ExecutionTarget>}
 */
function buildTargetsForDef({ baseKey, baseLabel, apiKeyEnv, modelEnv, fastModelEnv, supportsWebSearch, capabilities, call, callStream }) {
  const apiKeys = parseMultiEnv(process.env[apiKeyEnv]);
  if (!apiKeys.length) return [];
  const legacyModels = parseMultiEnv(process.env[modelEnv]);
  const legacyFastModels = parseMultiEnv(process.env[fastModelEnv]);
  const usingLegacyOverride = legacyModels.length > 0;

  const targets = [];
  apiKeys.forEach((apiKeyOverride, keyIndex) => {
    const keyId = apiKeys.length > 1 ? `${baseKey}#${keyIndex + 1}` : baseKey;
    const keySuffix = apiKeys.length > 1 ? ` #${keyIndex + 1}` : '';

    let models = legacyModels;
    let fastModels = legacyFastModels;
    let capsById = {};

    if (!usingLegacyOverride) {
      // ---------- Auto discovery: model phải đến từ cache đã được modelDiscovery.js xác nhận ----------
      const cached = getCachedModels(baseKey, apiKeyOverride);
      if (!cached || !cached.qualityModelIds || !cached.qualityModelIds.length) return; // chưa discovery/không có model khả dụng -> bỏ qua khóa này, KHÔNG hard-code
      models = cached.qualityModelIds;
      fastModels = (cached.fastModelIds && cached.fastModelIds.length) ? cached.fastModelIds : cached.qualityModelIds;
      capsById = cached.capsById || {};
    }

    models.forEach((modelName) => {
      const modelId = `${baseKey}::${modelName}`;
      const targetId = `${keyId}::${modelName}`;
      const label = models.length > 1
        ? `${baseLabel}${keySuffix} (${modelName})`
        : `${baseLabel}${keySuffix}${modelName ? ` (${modelName})` : ''}`;

      // mục 13/16: capability THẬT của MODEL cụ thể (khi đã biết qua discovery) đè lên capability
      // mặc định của provider — model không hỗ trợ vision/reasoning thì không được coi là có, dù
      // provider nói chung hỗ trợ.
      const modelCaps = capsById[modelName];
      const mergedCapabilities = {
        ...(capabilities || {}),
        ...(modelCaps ? {
          supportsVision: !!(modelCaps.inputCapabilities && modelCaps.inputCapabilities.vision),
          supportsThinking: !!modelCaps.supportsReasoning,
          supportsWebSearch: !!modelCaps.supportsWebSearch && !!(capabilities && capabilities.supportsWebSearch),
          // A2/B3: giới hạn THẬT của model đi kèm capability, để reasoningPolicy.js kẹp trần
          // reasoning theo đúng model thay vì 1 hằng số global. Model discovery không biết ->
          // field vắng mặt -> giữ nguyên hành vi mặc định.
          ...(Number(modelCaps.maxOutputTokens) > 0 ? { maxOutputTokens: Number(modelCaps.maxOutputTokens) } : {}),
          ...(Number(modelCaps.contextWindow) > 0 ? { contextWindow: Number(modelCaps.contextWindow) } : {})
        } : {})
      };

      targets.push({
        id: targetId,
        providerKey: baseKey,
        keyId,
        modelId,
        modelName,
        label,
        supportsWebSearch,
        // mục 13/16: capability THẬT (provider VÀ, khi biết, model cụ thể) — client tự đọc field
        // này gián tiếp qua chat.js truyền `deepThinking` xuống, KHÔNG qua target.call() (target.call
        // chỉ forward args nguyên vẹn) — expose ở đây để route/test có thể introspect trước khi gọi.
        capabilities: mergedCapabilities,
        // Dùng cho nơi gọi cũ (aiProviders.js) vẫn còn code đọc `.key` — giữ tương thích, trỏ
        // thẳng vào keyId vì cooldown 429/khóa vẫn nên tra theo khóa trước tiên.
        key: keyId,
        // mục 21: khóa API THẬT của target này — CHỈ dùng nội bộ để aiProviders.js có thể gọi
        // modelDiscovery.invalidateModelCache()/markModelInvalid() khi model báo lỗi 404/deprecated
        // ở runtime (buộc discovery lại thay vì tiếp tục dùng model đã biết là hỏng). KHÔNG log field
        // này trực tiếp (logger.js tự redact mọi field tên chứa "apikey", nhưng route/UI cũng không
        // bao giờ đọc field này — chỉ aiProviders.js dùng nội bộ).
        apiKeyOverride,
        usingLegacyOverride,
        // FIX P0/C (audit): TRƯỚC ĐÂY mergedCapabilities chỉ được expose ở target.capabilities để
        // route/test introspect, KHÔNG hề được forward vào call()/callStream() — mỗi client
        // (anthropicClient/openaiClient/geminiClient) tự quyết định "useNativeThinking" chỉ dựa vào
        // deepThinking+fast+maxTokens, hoàn toàn KHÔNG biết model thực tế có hỗ trợ reasoning native
        // hay không (dead capability metadata — mục C/P). Nay capabilities THẬT của target (đã merge
        // provider-level + model-level từ discovery) được forward vào MỌI lượt gọi thật, để từng
        // client tự gate: model không hỗ trợ -> không gửi field API không được hỗ trợ (fallback
        // prompt-based hoặc bỏ qua native thinking một cách có chủ đích).
        call: (args) => call({
          ...args,
          apiKeyOverride,
          modelOverride: modelName,
          fastModelOverride: pickRandomOrUndefined(fastModels),
          capabilities: mergedCapabilities
        }),
        callStream: (args) => callStream({
          ...args,
          apiKeyOverride,
          modelOverride: modelName,
          fastModelOverride: pickRandomOrUndefined(fastModels),
          capabilities: mergedCapabilities
        })
      });
    });
  });
  return targets;
}

// mục 24: KHÔNG còn "defaultModel" hard-code ở đây cho 3 provider lõi — model chỉ đến từ (a) legacy
// explicit override trong .env, hoặc (b) modelDiscovery.js đã xác nhận qua API liệt kê model thật.
const CORE_DEFS = [
  {
    baseKey: 'anthropic',
    baseLabel: 'Claude',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    modelEnv: 'ANTHROPIC_MODEL',
    fastModelEnv: 'ANTHROPIC_MODEL_FAST',
    discoveryProvider: 'anthropic',
    supportsWebSearch: true,
    // mục 13: khai báo capability THẬT — client (anthropicClient.js) tự quyết tham số cụ thể dựa
    // trên các cờ này, chat.js/aiProviders.js không hard-code hành vi theo provider.
    capabilities: { supportsThinking: true, supportsAdaptiveThinking: true, supportsVision: true, supportsWebSearch: true, supportsStreaming: true },
    call: ({ webSearch, ...rest }) => callClaude({ ...rest, tools: webSearch ? WEB_SEARCH_TOOL_ANTHROPIC : undefined }),
    callStream: ({ webSearch, ...rest }) => callClaudeStream({ ...rest, tools: webSearch ? WEB_SEARCH_TOOL_ANTHROPIC : undefined })
  },
  {
    baseKey: 'openai',
    baseLabel: 'GPT',
    apiKeyEnv: 'OPENAI_API_KEY',
    modelEnv: 'OPENAI_MODEL',
    fastModelEnv: 'OPENAI_MODEL_FAST',
    discoveryProvider: 'openai',
    supportsWebSearch: true,
    // OpenAI Responses API điều khiển reasoning qua `reasoning.effort` (không có "adaptive budget"
    // như Anthropic/Gemini) — supportsThinking:true, supportsAdaptiveThinking:false (mục 13).
    capabilities: { supportsThinking: true, supportsAdaptiveThinking: false, supportsVision: true, supportsWebSearch: true, supportsStreaming: true },
    call: callOpenAI,
    callStream: callOpenAIStream
  },
  {
    baseKey: 'gemini',
    baseLabel: 'Gemini',
    apiKeyEnv: 'GEMINI_API_KEY',
    modelEnv: 'GEMINI_MODEL',
    fastModelEnv: 'GEMINI_MODEL_FAST',
    discoveryProvider: 'gemini',
    supportsWebSearch: true,
    capabilities: { supportsThinking: true, supportsAdaptiveThinking: true, supportsVision: true, supportsWebSearch: true, supportsStreaming: true },
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
    discoveryProvider: 'openai-compatible',
    discoveryConfig: cfg,
    supportsWebSearch: false,
    // mục 13/1: KHÔNG được giả định 1 provider OpenAI-compatible bất kỳ hỗ trợ reasoning native —
    // chỉ bật khi chính provider đó khai rõ `supportsThinking:true` trong extraProviders.js (ví dụ
    // 1 hãng có tham số reasoning riêng qua extraBody). Mặc định false -> deepThinking=true vẫn chỉ
    // fallback prompt-based cho các provider này (không gây lỗi 400 vì gửi tham số không tương thích).
    capabilities: {
      supportsThinking: !!cfg.supportsThinking,
      supportsAdaptiveThinking: !!cfg.supportsAdaptiveThinking,
      supportsVision: !!cfg.supportsVision,
      supportsWebSearch: false,
      supportsStreaming: true
    },
    call: client.call,
    callStream: client.callStream
  };
});

const ALL_DEFS = [...CORE_DEFS, ...EXTRA_DEFS];

/**
 * Trả về TOÀN BỘ execution target đã cấu hình (đọc .env lại mỗi lần gọi — không cache, xem lý do
 * gốc trong aiProviders.js cũ: đổi .env + khởi động lại server là có hiệu lực ngay). Với provider
 * dùng auto-discovery (không có modelEnv), target CHỈ được sinh nếu modelDiscovery.js đã cache model
 * cho khóa đó — gọi ensureProvidersReady() (aiProviders.js) trước để warm cache (mục 2/11/24).
 * @returns {Array<ExecutionTarget>}
 */
function getAllExecutionTargets() {
  return ALL_DEFS.flatMap(buildTargetsForDef);
}

/**
 * Danh sách provider definition cần modelDiscovery warm-up — dùng bởi aiProviders.ensureProvidersReady().
 * Chỉ trả về provider ĐANG có API key cấu hình VÀ KHÔNG dùng legacy explicit modelEnv (nếu đã explicit
 * override thì không cần discovery — tôn trọng lựa chọn của người dùng, mục 12).
 * @returns {Array<{baseKey:string, apiKeys:Array<string>, discoveryProvider:string, discoveryConfig?:object}>}
 */
function listAutoDiscoveryDefs() {
  return ALL_DEFS
    .map((def) => {
      const apiKeys = parseMultiEnv(process.env[def.apiKeyEnv]);
      if (!apiKeys.length) return null;
      const legacyModels = parseMultiEnv(process.env[def.modelEnv]);
      if (legacyModels.length) return null; // explicit override — không cần discovery
      return { baseKey: def.baseKey, apiKeys, discoveryProvider: def.discoveryProvider, discoveryConfig: def.discoveryConfig };
    })
    .filter(Boolean);
}

module.exports = { getAllExecutionTargets, listAutoDiscoveryDefs, parseMultiEnv };
