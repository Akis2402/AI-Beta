'use strict';

// ============================================================================================
// CANONICAL REQUEST COST CALCULATOR
// ============================================================================================
// Tính chi phí USD cho từng lượt gọi API / request dựa trên biểu giá chính thức.
// Nguyên tắc:
//   1. Nếu provider / model không có cấu hình giá chính thức: trả về null (KHÔNG ĐOÁN GIÁ).
//   2. Tách bạch rõ ràng giữa:
//      - estimatedUsdInput: token đầu vào văn bản
//      - estimatedUsdOutput: token đầu ra văn bản (KHÔNG gồm reasoning)
//      - estimatedUsdThinking: token suy luận / reasoning
//      - estimatedUsdImageInput: token ảnh đầu vào
//      - estimatedUsdImageOutput: token ảnh đầu ra
//      - cacheSavingsUsd: chi phí tiết kiệm được từ cached tokens dựa trên discount thực tế
//   3. Tỷ lệ giảm giá cache (cache read discount) phụ thuộc theo từng provider/model.

const PROVIDER_PRICING = {
  gemini: {
    'gemini-3.1-flash-image': {
      inputPerMillion: 0.25,
      outputPerMillion: 30.0,
      thinkingPerMillion: 0.0,
      imageInputPerMillion: 0.25,
      imageOutputPerMillion: 30.0,
      cacheDiscount: 0.75 // Cache hit giảm 75% giá input trên Gemini
    },
    'gemini-3.8-flash': {
      inputPerMillion: 0.15,
      outputPerMillion: 0.60,
      thinkingPerMillion: 0.60,
      imageInputPerMillion: 0.15,
      imageOutputPerMillion: 0.60,
      cacheDiscount: 0.75
    },
    'gemini-2.5-flash': {
      inputPerMillion: 0.15,
      outputPerMillion: 0.60,
      thinkingPerMillion: 0.60,
      imageInputPerMillion: 0.15,
      imageOutputPerMillion: 0.60,
      cacheDiscount: 0.75
    },
    'gemini-3.1-pro-preview': {
      inputPerMillion: 1.25,
      outputPerMillion: 5.00,
      thinkingPerMillion: 5.00,
      imageInputPerMillion: 1.25,
      imageOutputPerMillion: 5.00,
      cacheDiscount: 0.75
    }
  },
  openai: {
    'gpt-4o': {
      inputPerMillion: 2.50,
      outputPerMillion: 10.00,
      thinkingPerMillion: 10.00,
      imageInputPerMillion: 2.50,
      imageOutputPerMillion: 10.00,
      cacheDiscount: 0.50
    },
    'gpt-4o-mini': {
      inputPerMillion: 0.15,
      outputPerMillion: 0.60,
      thinkingPerMillion: 0.60,
      imageInputPerMillion: 0.15,
      imageOutputPerMillion: 0.60,
      cacheDiscount: 0.50
    }
  }
};

function num(val) {
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Lấy tỷ lệ giảm giá khi đọc từ cache cho provider và model.
 */
function getCacheDiscount(provider, model) {
  const p = String(provider || '').toLowerCase();
  const m = String(model || '').toLowerCase();
  const provConfig = PROVIDER_PRICING[p];
  if (provConfig) {
    if (provConfig[m] && provConfig[m].cacheDiscount != null) {
      return provConfig[m].cacheDiscount;
    }
    // Lấy model đầu tiên của provider làm fallback nếu cùng họ
    const first = Object.values(provConfig)[0];
    if (first && first.cacheDiscount != null) return first.cacheDiscount;
  }
  return 0.75; // Approximation mặc định
}

/**
 * Tính toán chi phí cho một request / attempt.
 *
 * @param {object} params
 * @param {string} params.provider
 * @param {string} params.model
 * @param {number} [params.inputTokens]
 * @param {number} [params.outputTokens]
 * @param {number} [params.reasoningTokens]
 * @param {number} [params.cachedTokens]
 * @param {number} [params.imageInputTokens]
 * @param {number} [params.imageOutputTokens]
 * @param {number} [params.toolUseTokens]
 * @returns {{
 *   estimatedUsd: number|null,
 *   estimatedUsdInput: number|null,
 *   estimatedUsdOutput: number|null,
 *   estimatedUsdThinking: number|null,
 *   estimatedUsdImageInput: number|null,
 *   estimatedUsdImageOutput: number|null,
 *   cacheSavingsUsd: number|null
 * }}
 */
function estimateRequestCost(params = {}) {
  const p = String(params.provider || '').toLowerCase();
  const m = String(params.model || '').toLowerCase();

  const prov = PROVIDER_PRICING[p] || (p.includes('gemini') ? PROVIDER_PRICING.gemini : null);
  if (!prov) {
    return {
      estimatedUsd: null,
      estimatedUsdInput: null,
      estimatedUsdOutput: null,
      estimatedUsdThinking: null,
      estimatedUsdImageInput: null,
      estimatedUsdImageOutput: null,
      cacheSavingsUsd: null
    };
  }

  // Tìm model match chính xác hoặc gần đúng
  let pricing = prov[m];
  if (!pricing) {
    const key = Object.keys(prov).find(k => m.includes(k) || k.includes(m));
    if (key) pricing = prov[key];
    else if (p === 'gemini' || p.includes('gemini')) pricing = prov['gemini-3.8-flash'];
    else pricing = Object.values(prov)[0];
  }

  if (!pricing) {
    return {
      estimatedUsd: null,
      estimatedUsdInput: null,
      estimatedUsdOutput: null,
      estimatedUsdThinking: null,
      estimatedUsdImageInput: null,
      estimatedUsdImageOutput: null,
      cacheSavingsUsd: null
    };
  }

  const inTok = num(params.inputTokens);
  const outTok = num(params.outputTokens);
  const thinkTok = num(params.reasoningTokens);
  const cachedTok = num(params.cachedTokens);
  const imgInTok = num(params.imageInputTokens);
  const imgOutTok = num(params.imageOutputTokens);
  const toolTok = num(params.toolUseTokens);

  const costInput = ((inTok + toolTok) / 1_000_000) * pricing.inputPerMillion;
  const costOutput = (outTok / 1_000_000) * pricing.outputPerMillion;
  const costThinking = (thinkTok / 1_000_000) * pricing.thinkingPerMillion;
  const costImgIn = (imgInTok / 1_000_000) * pricing.imageInputPerMillion;
  const costImgOut = (imgOutTok / 1_000_000) * pricing.imageOutputPerMillion;

  const discountRate = pricing.cacheDiscount != null ? pricing.cacheDiscount : 0.75;
  const cacheSavings = ((cachedTok / 1_000_000) * pricing.inputPerMillion) * discountRate;

  const total = costInput + costOutput + costThinking + costImgIn + costImgOut;

  return {
    estimatedUsd: Number(total.toFixed(6)),
    estimatedUsdInput: Number(costInput.toFixed(6)),
    estimatedUsdOutput: Number(costOutput.toFixed(6)),
    estimatedUsdThinking: Number(costThinking.toFixed(6)),
    estimatedUsdImageInput: Number(costImgIn.toFixed(6)),
    estimatedUsdImageOutput: Number(costImgOut.toFixed(6)),
    cacheSavingsUsd: Number(cacheSavings.toFixed(6))
  };
}

/**
 * calculateRequestCostUsd() — Wrapper tính chi phí toàn diện cho request gồm cả text, cache và ảnh.
 */
function calculateRequestCostUsd(params = {}) {
  const base = estimateRequestCost({
    provider: params.provider,
    model: params.model,
    inputTokens: params.promptTokens || params.inputTokens,
    outputTokens: params.outputTokens,
    reasoningTokens: params.reasoningTokens,
    cachedTokens: params.cachedTokens,
    imageInputTokens: params.imageInputTokens,
    imageOutputTokens: params.imageOutputTokens,
    toolUseTokens: params.toolUseTokens
  });

  let imageCostUsd = 0;
  if (Array.isArray(params.images)) {
    const { estimateImageCostUsd } = require('../visual/imageCostTable');
    params.images.forEach(img => {
      imageCostUsd += estimateImageCostUsd(img) || 0;
    });
  }

  const totalCostUsd = (base.estimatedUsd || 0) + imageCostUsd;
  return {
    ...base,
    textCostUsd: base.estimatedUsd || 0,
    imageCostUsd: Number(imageCostUsd.toFixed(6)),
    totalCostUsd: Number(totalCostUsd.toFixed(6))
  };
}

module.exports = {
  estimateRequestCost,
  calculateRequestCostUsd,
  getCacheDiscount,
  PROVIDER_PRICING
};
