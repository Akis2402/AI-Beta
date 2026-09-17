'use strict';

// ============================================================================================
// AI CLIENT CONFIG — dùng RIÊNG cho tính năng "Image Studio V2" (/api/visual/generate-v2).
// ============================================================================================
// Đây KHÔNG phải là cấu hình provider dùng chung của toàn hệ thống (xem server/utils/aiProviders.js
// và server/utils/modelDiscovery.js cho phần đó). File này chỉ khởi tạo đúng 2 client cố định theo
// yêu cầu: Gemini (Primary, Imagen 3) và OpenAI (Fallback, DALL-E 3), đọc 2 biến môi trường RIÊNG:
//   - GEMINI_IMAGE_API_KEY   (Primary)
//   - FALLBACK_IMAGE_API_KEY (Fallback)
// Việc tách riêng là CÓ CHỦ ĐÍCH: tránh đụng vào GEMINI_API_KEY/OPENAI_API_KEY hay
// GEMINI_IMAGE_API_KEY (override tùy chọn) mà server/utils/visual/imageGenerationClient.js hiện có
// đang dùng cho pipeline hình minh họa chính của ứng dụng.

const { GoogleGenAI } = require('@google/genai');
const OpenAI = require('openai');

const GEMINI_IMAGE_MODEL = 'imagen-3.0-generate-002';
const OPENAI_IMAGE_MODEL = 'dall-e-3';

let geminiClientSingleton = null;
let openaiClientSingleton = null;

/**
 * Trả về client Gemini (Primary) đã khởi tạo, hoặc null nếu chưa cấu hình
 * GEMINI_IMAGE_API_KEY trong biến môi trường.
 * @returns {GoogleGenAI|null}
 */
function getGeminiClient() {
  const apiKey = process.env.GEMINI_IMAGE_API_KEY;
  if (!apiKey) return null;
  if (!geminiClientSingleton) {
    geminiClientSingleton = new GoogleGenAI({ apiKey });
  }
  return geminiClientSingleton;
}

/**
 * Trả về client OpenAI (Fallback) đã khởi tạo, hoặc null nếu chưa cấu hình
 * FALLBACK_IMAGE_API_KEY trong biến môi trường.
 * @returns {OpenAI|null}
 */
function getOpenAIClient() {
  const apiKey = process.env.FALLBACK_IMAGE_API_KEY;
  if (!apiKey) return null;
  if (!openaiClientSingleton) {
    openaiClientSingleton = new OpenAI({ apiKey });
  }
  return openaiClientSingleton;
}

/** @returns {boolean} true nếu ít nhất 1 trong 2 khóa ảnh (Primary hoặc Fallback) đã được cấu hình. */
function isImageStudioConfigured() {
  return Boolean(process.env.GEMINI_IMAGE_API_KEY || process.env.FALLBACK_IMAGE_API_KEY);
}

module.exports = {
  GEMINI_IMAGE_MODEL,
  OPENAI_IMAGE_MODEL,
  getGeminiClient,
  getOpenAIClient,
  isImageStudioConfigured
};
