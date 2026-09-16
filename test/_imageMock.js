'use strict';

// ============================================================================================
// HELPER DÙNG CHUNG CHO TEST HỆ THỐNG HÌNH — MOCK IMAGE PROVIDER
// ============================================================================================
// Kiến trúc mới (AI image-first) KHÔNG còn deterministic renderer làm lưới an toàn, nên MỌI test
// pipeline đều phải có provider ảnh giả lập. File này gom đúng 1 chỗ:
//   - PNG_B64 / PNG_DATA_URL: ảnh PNG 1x1 THẬT (magic bytes hợp lệ, qua được imageBinaryValidator)
//   - loadVisualModules(env): nạp lại imageGenerationClient + visualPipeline với env mới
//   - withFetch(stub, fn): thay global.fetch trong đúng phạm vi một test
//   - geminiImageResponse()/geminiTextResponse(): shape response THẬT của Gemini Image
//
// Không có API key thật trong CI -> đây là cách duy nhất chạy được ĐƯỜNG ẢNH mà vẫn kiểm chứng
// được hợp đồng kiến trúc (không SVG, failover, quality gate, retry stub).

const path = require('path');

const CLIENT_PATH = path.join(__dirname, '..', 'server', 'utils', 'visual', 'imageGenerationClient.js');
const PIPELINE_PATH = path.join(__dirname, '..', 'server', 'utils', 'visual', 'visualPipeline.js');
const CACHE_PATH = path.join(__dirname, '..', 'server', 'utils', 'visual', 'visualCache.js');

/** PNG 1x1 hợp lệ — magic bytes 89 50 4E 47 ... */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_DATA_URL = 'data:image/png;base64,' + PNG_B64;

const IMAGE_ENV_KEYS = [
  'GEMINI_IMAGE_API_KEY', 'OPENAI_IMAGE_API_KEY', 'GEMINI_IMAGE_MODEL', 'OPENAI_IMAGE_MODEL'
];

/**
 * loadVisualModules() — nạp lại client + pipeline với biến môi trường mới (client đọc env lúc
 * require). Trả về hàm restore() phải luôn gọi trong finally.
 * @param {object} env vd { GEMINI_IMAGE_API_KEY: 'k' }
 * @returns {{client:object, pipeline:object, cache:object, restore:Function}}
 */
function loadVisualModules(env = {}) {
  delete require.cache[require.resolve(CLIENT_PATH)];
  delete require.cache[require.resolve(PIPELINE_PATH)];
  const saved = {};
  IMAGE_ENV_KEYS.forEach((k) => {
    saved[k] = process.env[k];
    if (k in env) process.env[k] = env[k]; else delete process.env[k];
  });
  const client = require(CLIENT_PATH);
  const pipeline = require(PIPELINE_PATH);
  const cache = require(CACHE_PATH);
  cache._resetForTest();
  return {
    client,
    pipeline,
    cache,
    restore: () => {
      Object.entries(saved).forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; });
      delete require.cache[require.resolve(CLIENT_PATH)];
      delete require.cache[require.resolve(PIPELINE_PATH)];
    }
  };
}

/** Thay global.fetch trong đúng phạm vi một test. */
async function withFetch(stub, fn) {
  const real = global.fetch;
  global.fetch = stub;
  try { return await fn(); } finally { global.fetch = real; }
}

/** Response THÀNH CÔNG đúng shape Gemini Image (inlineData base64). */
function geminiImageResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }] } }] })
  };
}

/** Response KHÔNG có ảnh (model trả text) — phải bị coi là thất bại, không bao giờ thành "ảnh". */
function geminiTextResponse(text = 'xin lỗi, tôi không tạo được ảnh') {
  return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) };
}

/** Response HTTP lỗi. */
function httpErrorResponse(status = 500) {
  return { ok: false, status, text: async () => '', json: async () => ({}) };
}

/** Output ảnh AI hợp lệ dùng cho test validator/cache (đã qua magic bytes). */
function validImageOutput(extra = {}) {
  return {
    format: 'data_url', url: PNG_DATA_URL, renderer: 'generated_image',
    origin: 'ai_generated', model: 'mock-image-model', ...extra
  };
}

module.exports = {
  PNG_B64, PNG_DATA_URL, CLIENT_PATH, PIPELINE_PATH, CACHE_PATH,
  loadVisualModules, withFetch, geminiImageResponse, geminiTextResponse, httpErrorResponse,
  validImageOutput
};
