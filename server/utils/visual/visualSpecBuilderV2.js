'use strict';

// ============================================================================================
// IMAGE STUDIO V2 — enhanceImagePrompt(userPrompt, style)
// ============================================================================================
// Tự động nối thêm từ khoá tối ưu hoá theo 5 phong cách vào prompt gốc của người dùng, trước khi
// gửi cho imageGenerationClientV2.generateImage(). File riêng biệt, KHÔNG đụng vào
// server/utils/visual/visualSpecBuilder.js (đang được visualPipeline.js/chat.js dùng).

const STYLE_KEYWORDS = {
  photorealistic: 'photorealistic, ultra-detailed, 8K resolution, DSLR photography, sharp focus, natural lighting, realistic textures, professional photo',
  anime: 'anime style, Japanese animation art, vibrant colors, cel-shaded, detailed line art, studio quality anime illustration',
  '3d-render': '3D render, octane render, physically based rendering, cinema 4D, ray tracing, high poly, studio lighting, hyper-detailed 3D model',
  cinematic: 'cinematic lighting, dramatic composition, film grain, wide-angle lens, movie still, color graded, atmospheric, epic scale',
  cyberpunk: 'cyberpunk style, neon lights, futuristic cityscape, high-tech low-life, dystopian atmosphere, glowing neon signs, rain-soaked streets'
};

const STYLE_ALIASES = {
  photorealistic: 'photorealistic',
  photo: 'photorealistic',
  realistic: 'photorealistic',
  anime: 'anime',
  '3d': '3d-render',
  '3drender': '3d-render',
  '3d-render': '3d-render',
  '3d_render': '3d-render',
  cinematic: 'cinematic',
  cyberpunk: 'cyberpunk'
};

/**
 * Chuẩn hoá tên style người dùng gửi lên (không phân biệt hoa thường, khoảng trắng, gạch dưới)
 * về đúng 1 trong 5 key hợp lệ của STYLE_KEYWORDS.
 * @param {string} style
 * @returns {string|null}
 */
function normalizeStyleKey(style) {
  if (!style || typeof style !== 'string') return null;
  const normalized = style.trim().toLowerCase().replace(/\s+/g, '-');
  return STYLE_ALIASES[normalized] || (STYLE_KEYWORDS[normalized] ? normalized : null);
}

/**
 * Nối thêm từ khoá tối ưu hoá theo phong cách vào prompt gốc.
 * @param {string} userPrompt Prompt người dùng nhập.
 * @param {string} [style] Một trong: photorealistic, anime, 3d-render, cinematic, cyberpunk.
 * @returns {string} Prompt đã được tăng cường, sẵn sàng gửi cho AI sinh ảnh.
 */
function enhanceImagePrompt(userPrompt, style) {
  if (!userPrompt || typeof userPrompt !== 'string' || !userPrompt.trim()) {
    throw new Error('userPrompt không hợp lệ: phải là chuỗi không rỗng');
  }

  const trimmedPrompt = userPrompt.trim();
  const styleKey = normalizeStyleKey(style);

  if (!styleKey) {
    return trimmedPrompt;
  }

  const keywords = STYLE_KEYWORDS[styleKey];
  return `${trimmedPrompt}, ${keywords}`;
}

module.exports = {
  enhanceImagePrompt,
  normalizeStyleKey,
  STYLE_KEYWORDS
};
