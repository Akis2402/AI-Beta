'use strict';

// ============================================================================================
// IMAGE COST TABLE — BẢNG GIÁ VÀ THÔNG SỐ TOKEN ẢNH TẬP TRUNG
// ============================================================================================
// Không hard-code $0.067 hay các con số ước lượng rải rác ở nhiều file.
// Module này là 1 nguồn sự thật duy nhất cho:
//   - Input/output token rates của các provider ảnh
//   - Token ước tính theo độ phân giải ảnh (0.5K, 1K, 2K, 4K)
//   - Chi phí cố định hoặc theo token (USD)
//   - Override linh hoạt qua biến môi trường (GEMINI_IMAGE_COST_1K, ...)
// Nếu một provider không có cấu hình giá chính thức: trả về null (KHÔNG ĐOÁN GIÁ).

function parseEnvCost(envVar) {
  const val = process.env[envVar];
  if (val !== undefined && val !== null && val !== '') {
    const num = Number(val);
    if (Number.isFinite(num) && num >= 0) return num;
  }
  return null;
}

// Bảng giá chính thức Google Gemini 3.1 Flash Image (USD / 1M tokens) & token ước lượng
const GEMINI_31_FLASH_IMAGE_COST = {
  provider: 'gemini',
  model: 'gemini-3.1-flash-image',
  inputPerMillionTokens: 0.25,
  imageOutputPerMillionTokens: 30.0,
  // Số token ảnh tương đương theo độ phân giải
  estimatedImageTokensBySize: {
    '0.5K': 320,
    '1K': 1120,
    '2K': 2000,
    '4K': 4000
  },
  // Giá ước tính mặc định theo kích thước nếu tính theo lượt gọi ảnh
  defaultCostUsdBySize: {
    '0.5K': 0.015,
    '1K': 0.030,
    '2K': 0.060,
    '4K': 0.120
  }
};

const OPENAI_IMAGE_COST = {
  provider: 'openai',
  model: 'dall-e-3',
  costPerImage: {
    '1024x1024': { standard: 0.040, hd: 0.080 },
    '1024x1792': { standard: 0.080, hd: 0.120 },
    '1792x1024': { standard: 0.080, hd: 0.120 }
  }
};

/**
 * Lấy chi phí ước tính USD cho việc tạo ảnh từ Gemini 3.1 Flash Image.
 * Hỗ trợ override qua biến môi trường:
 *   - GEMINI_IMAGE_COST_0_5K
 *   - GEMINI_IMAGE_COST_1K
 *   - GEMINI_IMAGE_COST_2K
 *   - GEMINI_IMAGE_COST_4K
 *
 * @param {string} size '0.5K' | '1K' | '2K' | '4K'
 * @returns {number|null}
 */
function getGeminiImageCostUsd(size = '1K') {
  const envMap = {
    '0.5K': 'GEMINI_IMAGE_COST_0_5K',
    '1K': 'GEMINI_IMAGE_COST_1K',
    '2K': 'GEMINI_IMAGE_COST_2K',
    '4K': 'GEMINI_IMAGE_COST_4K'
  };

  const envKey = envMap[size];
  if (envKey) {
    const envVal = parseEnvCost(envKey);
    if (envVal !== null) return envVal;
  }

  const defCost = GEMINI_31_FLASH_IMAGE_COST.defaultCostUsdBySize[size];
  if (defCost !== undefined) return defCost;

  // Nếu kích thước không xác định nhưng có token ước tính
  const tokens = GEMINI_31_FLASH_IMAGE_COST.estimatedImageTokensBySize[size];
  if (tokens) {
    return Number(((tokens / 1_000_000) * GEMINI_31_FLASH_IMAGE_COST.imageOutputPerMillionTokens).toFixed(4));
  }
  return null;
}

/**
 * Lấy số lượng output token ước lượng cho ảnh theo kích thước.
 * @param {string} size '0.5K' | '1K' | '2K' | '4K'
 * @returns {number}
 */
function getEstimatedImageTokens(size = '1K') {
  return GEMINI_31_FLASH_IMAGE_COST.estimatedImageTokensBySize[size] || 1120;
}

/**
 * Ước lượng chi phí tạo ảnh bằng USD theo provider và kích thước.
 */
function estimateImageCostUsd({ provider, size, quality } = {}) {
  const p = String(provider || '').toLowerCase();
  if (p === 'openai' || p.includes('openai') || p.includes('dall-e')) {
    const s = size || '1024x1024';
    const q = quality === 'hd' || quality === 'high' ? 'hd' : 'standard';
    const item = OPENAI_IMAGE_COST.costPerImage[s];
    return (item && item[q]) || 0.040;
  }
  return getGeminiImageCostUsd(size || '1K');
}

function estimateImageTokens(opts = {}) {
  const size = typeof opts === 'string' ? opts : (opts && opts.size);
  return getEstimatedImageTokens(size || '1K');
}

module.exports = {
  GEMINI_31_FLASH_IMAGE_COST,
  OPENAI_IMAGE_COST,
  getGeminiImageCostUsd,
  getEstimatedImageTokens,
  estimateImageCostUsd,
  estimateImageTokens
};
