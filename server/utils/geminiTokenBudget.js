'use strict';

// ============================================================================================
// GEMINI TOKEN BUDGET & PRE-FLIGHT ESTIMATION
// ============================================================================================
// Quản lý ngân sách token cho Gemini requests:
//   1. estimateGeminiRequest: Ước lượng cục bộ (0 I/O, nhanh, không tốn tài nguyên mạng)
//   2. countGeminiRequestIfNeeded: Pre-flight check thông minh:
//      - Request nhỏ (< 1500 ký tự văn bản, không ảnh): dùng ước lượng cục bộ
//      - Request lớn / đa phương thức (ảnh) / có rủi ro vượt ngưỡng: gọi ai.models.countTokens()
//      - Cache kết quả đếm token theo fingerprint (TTL 5 phút)
//      - BẢO VỆ RESILIENCE: Nếu API countTokens() gặp lỗi mạng/timeout/500 -> tự động fallback
//        sang estimate cục bộ, TUYỆT ĐỐI không làm hỏng chat request của người dùng.
//   3. resolveGeminiOutputBudget: Cấp phát ngân sách output an toàn
//   4. recordGeminiUsage: Ghi nhận usage thật và điều chỉnh calibration

const crypto = require('crypto');
const tokenCounter = require('./tokenCounter');

// In-memory cache cho countTokens()
const countTokensCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;

function cleanupCache() {
  const now = Date.now();
  for (const [k, v] of countTokensCache.entries()) {
    if (v.expiresAt < now) countTokensCache.delete(k);
  }
}

function makeFingerprint(obj) {
  try {
    const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
    return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
  } catch {
    return 'default_fp';
  }
}

/**
 * Ước tính token cho Gemini request bằng giải thuật cục bộ (0 I/O).
 * @param {object} req { systemPrompt, contents, images, tools }
 * @returns {{ estimatedInputTokens: number, hasImages: boolean, charCount: number }}
 */
function estimateGeminiRequest(req = {}) {
  let charCount = 0;
  if (req.systemPrompt) charCount += String(req.systemPrompt).length;
  if (typeof req.contents === 'string') {
    charCount += req.contents.length;
  } else if (Array.isArray(req.contents)) {
    req.contents.forEach(c => {
      if (typeof c === 'string') charCount += c.length;
      else if (c && c.text) charCount += String(c.text).length;
      else if (c && Array.isArray(c.parts)) {
        c.parts.forEach(p => {
          if (p.text) charCount += String(p.text).length;
        });
      }
    });
  }

  const textTokens = tokenCounter.countTokens(charCount, { provider: 'gemini' });
  const images = Array.isArray(req.images) ? req.images : [];
  let imageTokens = 0;
  images.forEach(img => {
    // Ước tính ~1120 tokens / ảnh 1K chuẩn
    imageTokens += img.estimatedTokens || 1120;
  });

  return {
    estimatedInputTokens: textTokens + imageTokens,
    textTokens,
    imageTokens,
    hasImages: images.length > 0,
    charCount
  };
}

/**
 * Gọi models.countTokens() nếu request lớn hoặc có ảnh, có cache và fallback an toàn.
 *
 * @param {object} aiClient Instance GoogleGenAI (@google/genai)
 * @param {object} req { model, contents, systemInstruction, images, tools }
 * @param {object} [opts] { forceCount: boolean }
 * @returns {Promise<{ inputTokens: number, fromCache: boolean, isEstimated: boolean }>}
 */
async function countGeminiRequestIfNeeded(aiClient, req = {}, opts = {}) {
  const estimate = estimateGeminiRequest(req);
  const model = req.model || 'gemini-3.8-flash';

  // Điều kiện kích hoạt pre-flight API:
  // - Có ảnh, HOẶC
  // - Ký tự văn bản > 4000 (request lớn), HOẶC
  // - Bắt buộc (forceCount = true)
  const isLargeOrMultimodal = estimate.hasImages || estimate.charCount > 4000;
  if (!opts.forceCount && !isLargeOrMultimodal) {
    return {
      inputTokens: estimate.estimatedInputTokens,
      fromCache: false,
      isEstimated: true
    };
  }

  // Không có client SDK hoặc không có models.countTokens -> fallback estimate
  if (!aiClient || !aiClient.models || typeof aiClient.models.countTokens !== 'function') {
    return {
      inputTokens: estimate.estimatedInputTokens,
      fromCache: false,
      isEstimated: true
    };
  }

  // Tạo cache key
  const cacheKey = [
    model,
    makeFingerprint(req.systemInstruction || req.systemPrompt || ''),
    makeFingerprint(req.contents || ''),
    makeFingerprint(req.images || []),
    makeFingerprint(req.tools || [])
  ].join('::');

  cleanupCache();
  const cached = countTokensCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      inputTokens: cached.tokens,
      fromCache: true,
      isEstimated: false
    };
  }

  try {
    const countRes = await aiClient.models.countTokens({
      model,
      contents: req.contents
    });

    const realTokens = countRes && (countRes.totalTokens || countRes.total_tokens);
    if (Number.isFinite(realTokens) && realTokens > 0) {
      if (countTokensCache.size < MAX_CACHE_ENTRIES) {
        countTokensCache.set(cacheKey, {
          tokens: realTokens,
          expiresAt: Date.now() + CACHE_TTL_MS
        });
      }
      return {
        inputTokens: realTokens,
        fromCache: false,
        isEstimated: false
      };
    }
  } catch (err) {
    // RESILIENCE: Không bao giờ để lỗi countTokens làm hỏng request
    // console.warn('[geminiTokenBudget] countTokens API failed, falling back to local estimate', err.message);
  }

  return {
    inputTokens: estimate.estimatedInputTokens,
    fromCache: false,
    isEstimated: true
  };
}

/**
 * Cấp phát ngân sách output cho request.
 */
function resolveGeminiOutputBudget(req = {}, opts = {}) {
  const defaultBudget = opts.defaultBudget || 4096;
  const maxModelTokens = opts.maxModelTokens || 8192;
  const requested = opts.answerBudget || defaultBudget;
  return Math.min(requested, maxModelTokens);
}

/**
 * Ghi nhận usage thực tế sau khi request hoàn tất.
 */
function recordGeminiUsage(providerKey, usage = {}) {
  if (!usage) return;
  if (usage.outputTokens && usage.text) {
    tokenCounter.recordUsage(providerKey || 'gemini', {
      text: usage.text,
      tokens: usage.outputTokens
    });
  }
}

module.exports = {
  estimateGeminiRequest,
  countGeminiRequestIfNeeded,
  resolveGeminiOutputBudget,
  recordGeminiUsage
};
