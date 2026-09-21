'use strict';

// ============================================================================================
// IMAGE RESOLUTION & COST POLICY
// ============================================================================================
// Module quyết định độ phân giải (0.5K, 1K, 2K, 4K) và mức chất lượng (fast, standard, high, ultra)
// dựa trên:
//   - Yêu cầu kỹ thuật của ảnh (mật độ chữ, nhãn cần đọc rõ, sơ đồ giải tích phức tạp)
//   - Yêu cầu của người dùng (nếu có chỉ định chất lượng)
//   - Ngân sách token / chi phí còn lại của request (nếu ngân sách hạn hẹp -> tự hạ độ phân giải
//     trước khi quyết định bỏ ảnh)
//   - Năng lực của provider được chọn (chỉ chọn kích thước mà provider hỗ trợ)

const {
  GEMINI_31_FLASH_IMAGE_COST,
  getGeminiImageCostUsd,
  getEstimatedImageTokens
} = require('./imageCostTable');

const SIZES_ORDER = ['0.5K', '1K', '2K', '4K'];

/**
 * Tìm kích thước phù hợp nhất mà provider hỗ trợ.
 * Nếu provider không có cấu hình kích thước -> mặc định '1K'.
 */
function resolveSupportedSize(supportedSizes, requestedSize) {
  if (!Array.isArray(supportedSizes) || !supportedSizes.length) {
    return requestedSize || '1K';
  }
  if (supportedSizes.includes(requestedSize)) {
    return requestedSize;
  }
  // Tìm kích thước gần nhất (ưu tiên thấp hơn nếu có)
  const reqIdx = SIZES_ORDER.indexOf(requestedSize);
  for (let i = reqIdx; i >= 0; i--) {
    if (supportedSizes.includes(SIZES_ORDER[i])) return SIZES_ORDER[i];
  }
  for (let i = reqIdx + 1; i < SIZES_ORDER.length; i++) {
    if (supportedSizes.includes(SIZES_ORDER[i])) return SIZES_ORDER[i];
  }
  return supportedSizes[0];
}

/**
 * Lập kế hoạch sinh ảnh cân đối chất lượng và chi phí.
 *
 * @param {object} params
 * @param {'simple'|'moderate'|'complex'} [params.complexity]
 * @param {string} [params.visualType]
 * @param {'low'|'medium'|'high'} [params.textDensity]
 * @param {boolean} [params.requiresReadableLabels]
 * @param {'fast'|'standard'|'high'|'ultra'} [params.userRequestedQuality]
 * @param {number} [params.remainingBudget] Ngân sách token hoặc USD còn lại
 * @param {object} [params.providerCapabilities]
 * @returns {{
 *   quality: 'fast'|'standard'|'high'|'ultra',
 *   imageSize: '0.5K'|'1K'|'2K'|'4K',
 *   estimatedImageOutputTokens: number,
 *   estimatedCostUsd: number|null,
 *   reason: string
 * }}
 */
function resolveImageGenerationPlan(params = {}) {
  const {
    complexity = 'moderate',
    visualType = 'concept_illustration',
    textDensity = 'medium',
    requiresReadableLabels = false,
    userRequestedQuality = null,
    remainingBudget = Infinity,
    providerCapabilities = {}
  } = params;

  let quality = 'standard';
  let imageSize = '1K';
  let reason = 'standard_resolution_default';

  // 1. Phân tích nhu cầu kỹ thuật
  const isHighDetailType = [
    'circuit_diagram',
    'optics_diagram',
    'geometry_diagram',
    'geometry_3d',
    'mathematical_plot',
    'architecture_diagram',
    'data_structure_diagram'
  ].includes(visualType);

  const needsHighRes = requiresReadableLabels ||
    textDensity === 'high' ||
    (isHighDetailType && complexity === 'complex');

  if (userRequestedQuality === 'ultra') {
    quality = 'ultra';
    imageSize = '4K';
    reason = 'user_requested_ultra';
  } else if (userRequestedQuality === 'high') {
    quality = 'high';
    imageSize = '2K';
    reason = 'user_requested_high';
  } else if (userRequestedQuality === 'fast') {
    quality = 'fast';
    imageSize = '0.5K';
    reason = 'user_requested_fast';
  } else if (needsHighRes) {
    quality = 'high';
    imageSize = '2K';
    reason = requiresReadableLabels
      ? 'readable_labels_require_2k'
      : (textDensity === 'high' ? 'dense_text_requires_2k' : 'complex_technical_diagram_requires_2k');
  } else if (complexity === 'simple' && !isHighDetailType) {
    quality = 'standard';
    imageSize = '1K';
    reason = 'simple_diagram_1k_sufficient';
  }

  // 2. Kiểm tra giới hạn ngân sách (Budget guard)
  // Nếu ngân sách token còn ít (< 1500 tokens) -> hạ độ phân giải xuống 1K hoặc 0.5K
  if (Number.isFinite(remainingBudget)) {
    let tokens = getEstimatedImageTokens(imageSize);
    if (tokens > remainingBudget) {
      if (imageSize === '4K') {
        imageSize = '2K';
        quality = 'high';
        tokens = getEstimatedImageTokens(imageSize);
        reason += '_budget_downgraded_to_2k';
      }
      if (tokens > remainingBudget && imageSize === '2K') {
        imageSize = '1K';
        quality = 'standard';
        tokens = getEstimatedImageTokens(imageSize);
        reason += '_budget_downgraded_to_1k';
      }
      if (tokens > remainingBudget && imageSize === '1K') {
        imageSize = '0.5K';
        quality = 'fast';
        reason += '_budget_downgraded_to_0_5k';
      }
    }
  }

  // 3. Khớp với khả năng của provider
  const supportedSizes = providerCapabilities.supportedImageSizes || ['1K', '2K', '0.5K'];
  const finalSize = resolveSupportedSize(supportedSizes, imageSize);
  if (finalSize !== imageSize) {
    reason += `_adapted_to_provider_${finalSize}`;
    imageSize = finalSize;
  }

  const estimatedImageOutputTokens = getEstimatedImageTokens(imageSize);
  const estimatedCostUsd = providerCapabilities.name === 'gemini' || !providerCapabilities.name
    ? getGeminiImageCostUsd(imageSize)
    : null;

  return {
    quality,
    imageSize,
    size: imageSize,
    estimatedImageOutputTokens,
    estimatedCostUsd,
    reason
  };
}

/**
 * Kiểm tra xem có đủ ngân sách USD để tạo ảnh không.
 */
function canAffordImage({ provider = 'gemini', size = '1K', remainingBudgetUsd = Infinity } = {}) {
  if (!Number.isFinite(remainingBudgetUsd)) return true;
  const cost = provider === 'gemini' ? (getGeminiImageCostUsd(size) || 0.03) : 0.04;
  return cost <= remainingBudgetUsd;
}

/**
 * resolveImagePlan() — Wrapper linh hoạt giải quyết plan kích thước và chất lượng ảnh.
 */
function resolveImagePlan(opts = {}) {
  const plan = resolveImageGenerationPlan({
    complexity: opts.complexity,
    visualType: opts.visualType,
    textDensity: opts.textDensity,
    requiresReadableLabels: opts.requiresReadableLabels,
    userRequestedQuality: opts.quality || opts.userRequestedQuality,
    remainingBudget: opts.remainingBudgetTokens || opts.remainingBudget || Infinity,
    providerCapabilities: opts.providerCapabilities || {}
  });

  let size = plan.imageSize;
  let quality = plan.quality;

  if (Number.isFinite(opts.remainingBudgetUsd)) {
    if (size === '4K' && !canAffordImage({ size: '4K', remainingBudgetUsd: opts.remainingBudgetUsd })) {
      size = '2K';
      quality = 'high';
    }
    if (size === '2K' && !canAffordImage({ size: '2K', remainingBudgetUsd: opts.remainingBudgetUsd })) {
      size = '1K';
      quality = 'standard';
    }
    if (size === '1K' && !canAffordImage({ size: '1K', remainingBudgetUsd: opts.remainingBudgetUsd })) {
      size = '0.5K';
      quality = 'fast';
    }
  }

  return {
    ...plan,
    size,
    quality
  };
}

module.exports = {
  resolveImageGenerationPlan,
  resolveImagePlan,
  canAffordImage,
  resolveSupportedSize
};
