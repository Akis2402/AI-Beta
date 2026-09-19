'use strict';

// ============================================================================================
// IMAGE STUDIO V2 — generateImage(prompt, options)
// ============================================================================================
// Cơ chế PRIMARY (Gemini Imagen 3) -> FALLBACK (OpenAI DALL-E 3), tách biệt hoàn toàn khỏi
// server/utils/visual/imageGenerationClient.js (pipeline hình minh họa chính của ứng dụng, dùng
// khóa/model khác, được visualPipeline.js/chat.js gọi). File này CHỈ phục vụ route mới
// POST /api/visual/generate-v2 (trang /image-studio.html), không được require ở nơi khác.

const { GEMINI_IMAGE_MODEL, OPENAI_IMAGE_MODEL, getGeminiClient, getOpenAIClient } = require('../aiClientConfig');

/** Backdoor kiểm thử fallback: prompt chứa đúng chuỗi này sẽ ép Gemini "crash" giả lập. */
const FALLBACK_TEST_TRIGGER = 'TRIGGER_FALLBACK_TEST';

/**
 * Chuẩn hoá aspectRatio người dùng chọn (1:1, 16:9, 9:16) sang định dạng Gemini Imagen 3 chấp nhận.
 * @param {string} aspectRatio
 * @returns {string}
 */
function mapAspectRatioToGemini(aspectRatio) {
  const allowed = ['1:1', '3:4', '4:3', '9:16', '16:9'];
  if (allowed.includes(aspectRatio)) return aspectRatio;
  return '1:1';
}

/**
 * Chuẩn hoá aspectRatio người dùng chọn (1:1, 16:9, 9:16) sang size ảnh mà DALL-E 3 chấp nhận.
 * DALL-E 3 chỉ hỗ trợ đúng 3 kích thước: 1024x1024, 1792x1024, 1024x1792.
 * @param {string} aspectRatio
 * @returns {string}
 */
function mapAspectRatioToOpenAiSize(aspectRatio) {
  if (aspectRatio === '16:9') return '1792x1024';
  if (aspectRatio === '9:16') return '1024x1792';
  return '1024x1024';
}

/**
 * Gọi Gemini Imagen 3 để sinh ảnh (Primary).
 * @param {string} prompt
 * @param {{aspectRatio?:string, numberOfImages?:number, safetySettings?:object}} options
 * @returns {Promise<{provider:string, model:string, images:string[]}>}
 */
async function generateWithGemini(prompt, options) {
  if (prompt.includes(FALLBACK_TEST_TRIGGER)) {
    // Backdoor kiểm thử: ép "sập" Primary để buộc route qua Fallback (DALL-E 3).
    throw new Error('[TEST BACKDOOR] Gemini Primary bị ép lỗi thủ công do prompt chứa TRIGGER_FALLBACK_TEST');
  }

  const client = getGeminiClient();
  if (!client) {
    throw new Error('Gemini client chưa được cấu hình: thiếu biến môi trường GEMINI_IMAGE_API_KEY');
  }

  const numberOfImages = Math.min(Math.max(Number(options.numberOfImages) || 1, 1), 4);
  const aspectRatio = mapAspectRatioToGemini(options.aspectRatio);
  const safetySettings = options.safetySettings && typeof options.safetySettings === 'object'
    ? options.safetySettings
    : { safetyFilterLevel: 'BLOCK_MEDIUM_AND_ABOVE', personGeneration: 'ALLOW_ADULT' };

  const response = await client.models.generateImages({
    model: GEMINI_IMAGE_MODEL,
    prompt,
    config: {
      numberOfImages,
      aspectRatio,
      safetyFilterLevel: safetySettings.safetyFilterLevel || 'BLOCK_MEDIUM_AND_ABOVE',
      personGeneration: safetySettings.personGeneration || 'ALLOW_ADULT'
    }
  });

  const generated = response && Array.isArray(response.generatedImages) ? response.generatedImages : [];
  if (generated.length === 0) {
    throw new Error('Gemini Imagen 3 không trả về ảnh nào (có thể bị chặn bởi safety filter)');
  }

  const images = generated
    .map((item) => (item && item.image && item.image.imageBytes) ? item.image.imageBytes : null)
    .filter(Boolean)
    .map((base64Bytes) => `data:image/png;base64,${base64Bytes}`);

  if (images.length === 0) {
    throw new Error('Gemini Imagen 3 trả về dữ liệu ảnh không hợp lệ');
  }

  return { provider: 'gemini', model: GEMINI_IMAGE_MODEL, images };
}

/**
 * Gọi OpenAI DALL-E 3 để sinh ảnh (Fallback). DALL-E 3 chỉ hỗ trợ n=1 mỗi lượt gọi, nên nếu
 * numberOfImages > 1 hàm này gọi API nhiều lần tuần tự.
 * @param {string} prompt
 * @param {{aspectRatio?:string, numberOfImages?:number}} options
 * @returns {Promise<{provider:string, model:string, images:string[]}>}
 */
async function generateWithOpenAiFallback(prompt, options) {
  const client = getOpenAIClient();
  if (!client) {
    throw new Error('OpenAI client chưa được cấu hình: thiếu biến môi trường FALLBACK_IMAGE_API_KEY');
  }

  const numberOfImages = Math.min(Math.max(Number(options.numberOfImages) || 1, 1), 4);
  const size = mapAspectRatioToOpenAiSize(options.aspectRatio);
  const images = [];

  for (let i = 0; i < numberOfImages; i += 1) {
    const response = await client.images.generate({
      model: OPENAI_IMAGE_MODEL,
      prompt,
      n: 1,
      size,
      quality: 'standard',
      response_format: 'b64_json'
    });

    const item = response && Array.isArray(response.data) ? response.data[0] : null;
    if (item && item.b64_json) {
      images.push(`data:image/png;base64,${item.b64_json}`);
    } else if (item && item.url) {
      images.push(item.url);
    }
  }

  if (images.length === 0) {
    throw new Error('OpenAI DALL-E 3 không trả về ảnh nào');
  }

  return { provider: 'openai-dalle3', model: OPENAI_IMAGE_MODEL, images };
}

/**
 * Sinh ảnh với cơ chế PRIMARY (Gemini) -> FALLBACK (OpenAI DALL-E 3) tự động khi Primary lỗi.
 * @param {string} prompt Prompt đã được tối ưu hoá (xem visualSpecBuilderV2.enhanceImagePrompt).
 * @param {{aspectRatio?:string, numberOfImages?:number, safetySettings?:object}} [options]
 * @returns {Promise<{provider:string, model:string, images:string[]}>}
 * @throws {Error} khi CẢ HAI provider đều thất bại.
 */
async function generateImage(prompt, options = {}) {
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('Prompt không hợp lệ: prompt phải là chuỗi không rỗng');
  }

  try {
    const result = await generateWithGemini(prompt, options);
    return result;
  } catch (primaryError) {
    console.error('[imageGenerationClientV2] Gemini (Primary) thất bại, chuyển sang OpenAI DALL-E 3 (Fallback):', primaryError && primaryError.message ? primaryError.message : primaryError);

    try {
      const fallbackResult = await generateWithOpenAiFallback(prompt, options);
      return fallbackResult;
    } catch (fallbackError) {
      console.error('[imageGenerationClientV2] OpenAI DALL-E 3 (Fallback) cũng thất bại:', fallbackError && fallbackError.message ? fallbackError.message : fallbackError);
      const combinedError = new Error('Cả Gemini (Primary) và OpenAI DALL-E 3 (Fallback) đều thất bại khi sinh ảnh');
      combinedError.primaryError = primaryError;
      combinedError.fallbackError = fallbackError;
      throw combinedError;
    }
  }
}

module.exports = {
  generateImage,
  mapAspectRatioToGemini,
  mapAspectRatioToOpenAiSize,
  FALLBACK_TEST_TRIGGER
};
