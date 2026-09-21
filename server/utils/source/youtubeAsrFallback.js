'use strict';

// ============================================================================================
// V6 — YOUTUBE ASR FALLBACK (nội dung video KHÔNG có phụ đề)
// ============================================================================================
// Root cause fix cho "Video này không có phụ đề/bản ghi lời nên hệ thống chưa đọc được nội dung":
// khi 3 nhánh trước đó (captionTracks có chữ ký Innertube, timedtext truyền thống, ASR tự sinh
// của YouTube) đều fail, ta gọi Gemini native YouTube URL processing — SDK @google/genai
// (đã có sẵn trong deps) hỗ trợ `fileData: { fileUri, mimeType }` với YouTube URL và Gemini tự
// xử lý video (bao gồm OCR khung hình + audio transcribe). Ta yêu cầu JSON [{start, end, text}]
// rồi chunk theo timestamp giống y hệt nhánh captionTracks — cùng schema cue → cùng schema chunk
// → client không phân biệt.
//
// Ranh giới:
//   - Fallback này ẰT tiền (video 10 phút qua Gemini tốn ~15–30k input token). Chỉ gọi khi
//     TRẮM ĐI tất cả nhánh miễn phí đều fail.
//   - Có timeout dài hơn (60s) vì video lớn cần thời gian upload/process.
//   - Không dùng qua callWithFailover() (không cross-provider) vì chỉ Gemini support native
//     YouTube URL — gọi trực tiếp SDK, không phụ thuộc vào rotation.
//   - Nếu API key không có hoặc SDK lỗi → trả null, caller vẫn nhận INCOMPLETE như cũ.
//   - Kết quả được cache trong sourceContentCache (persistent) — gọi 1 lần cho đến khi user
//     chủ động refresh, không gọi lại cho mỗi câu hỏi.
// ============================================================================================

const ASR_EXTRACTOR_VERSION = 'yt-asr-gemini-v1';
const ASR_TIMEOUT_MS = 60_000;
const ASR_MODEL = process.env.YOUTUBE_ASR_MODEL || 'gemini-2.0-flash-exp';
// V6.1 token-opt: default 8k (đủ cho video ~30ph với cue gộp). Operator có thể tăng bằng env.
const ASR_MAX_OUTPUT_TOKENS = Number(process.env.YOUTUBE_ASR_MAX_OUTPUT_TOKENS) || 8_000;
// Ngưỡng gộp cue để giảm số dòng downstream (mỗi dòng = ~5 token overhead cho timestamp+quote).
const ASR_MERGE_MAX_GAP_SEC = 1.5;
const ASR_MERGE_MAX_CHARS = 240;

// Lắng nghe feature flag: cho phép disable toàn cục bằng env nếu operator lo chi phí.
function isEnabled() {
  const flag = String(process.env.YOUTUBE_ASR_ENABLED || 'true').toLowerCase();
  if (flag === 'false' || flag === '0' || flag === 'off') return false;
  return !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
}

/**
 * Thử gọi Gemini để transcribe video YouTube.
 * @param {string} youtubeUrl URL đầy đủ (cần hiển thị với Gemini — https://youtu.be/... hoặc https://www.youtube.com/watch?v=...)
 * @param {{languages?: string[], timeoutMs?: number}} opts
 * @returns {Promise<{cues: Array<{start:number, duration:number, text:string}>, language?: string} | null>}
 *   null nếu fallback không áp dụng được hoặc lỗi (caller tự fall về INCOMPLETE).
 */
async function transcribeYouTubeWithGemini(youtubeUrl, opts = {}) {
  if (!isEnabled()) return null;

  let GoogleGenAI;
  try {
    // Lazy require — tránh crash khi @google/genai không install trong test env.
    ({ GoogleGenAI } = require('@google/genai'));
  } catch (err) {
    return null;
  }

  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) return null;

  // V6.1 token-opt: prompt ngắn gọn tối đa. Cắt bỏ hướng dẫn thừa (Gemini native đã biết transcribe).
  const langHint = Array.isArray(opts.languages) && opts.languages.length
    ? ` Ưu tiên ${opts.languages.join('/')}.`
    : '';
  const prompt = `Transcribe toàn bộ video, giữ nguyên ngôn ngữ gốc.${langHint}
Trả JSON array: [{"start":sec,"end":sec,"text":"..."}]. Mỗi entry 5-15s. Không giải thích, không markdown. Nếu không có lời thoại: [{"start":0,"end":0,"text":"[không có lời thoại]"}].`;

  const timeoutMs = Number(opts.timeoutMs) || ASR_TIMEOUT_MS;
  const abortCtrl = new AbortController();
  const timer = setTimeout(() => abortCtrl.abort(), timeoutMs);

  try {
    const ai = new GoogleGenAI({ apiKey });
    const result = await ai.models.generateContent({
      model: ASR_MODEL,
      contents: [{
        role: 'user',
        parts: [
          { fileData: { fileUri: youtubeUrl, mimeType: 'video/*' } },
          { text: prompt }
        ]
      }],
      config: {
        maxOutputTokens: ASR_MAX_OUTPUT_TOKENS,
        temperature: 0,
        responseMimeType: 'application/json',
        abortSignal: abortCtrl.signal
      }
    });

    const raw = extractTextFromGeminiResponse(result);
    if (!raw) return null;

    const cues = parseAsrJson(raw);
    if (!cues || !cues.length) return null;

    return { cues, language: opts.languages && opts.languages[0] };
  } catch (err) {
    // Các lỗi thường gặp: vượt quota, video quicky private, model không hỗ trợ video, abort.
    // Không log stack — caller đã xuống đến cảnh báo INCOMPLETE cho user.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Lấy text từ response Gemini — SDK mới (@google/genai >= 2) trả `.text` hoặc `.candidates[0].content.parts[].text`.
 * Hỗ trợ cả 2 shape để không phụ thuộc version SDK.
 */
function extractTextFromGeminiResponse(result) {
  if (!result) return '';
  if (typeof result.text === 'string') return result.text;
  if (typeof result.text === 'function') {
    try { return result.text() || ''; } catch (_) {}
  }
  const parts = result.candidates && result.candidates[0] && result.candidates[0].content && result.candidates[0].content.parts;
  if (Array.isArray(parts)) {
    return parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('');
  }
  return '';
}

/**
 * Parse JSON transcript từ Gemini — tự viện gỡ code fence nếu model lệch spec.
 * @returns {Array<{start:number, duration:number, text:string}>}
 */
function parseAsrJson(raw) {
  let s = String(raw || '').trim();
  // Gỡ code fence nếu model ló ra ```json ... ``` (không đúng yêu cầu nhưng thực tế có xảy ra).
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
  if (fence) s = fence[1].trim();

  let parsed;
  try {
    parsed = JSON.parse(s);
  } catch (_) {
    // Thử giải cứu: tìm mảng đầu tiên trong chuỗi.
    const m = /\[[\s\S]*\]/.exec(s);
    if (!m) return [];
    try { parsed = JSON.parse(m[0]); } catch (_) { return []; }
  }

  if (!Array.isArray(parsed)) return [];
  const out = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const start = Number(entry.start);
    const end = Number(entry.end);
    const text = String(entry.text || '').trim();
    if (!Number.isFinite(start) || start < 0) continue;
    if (!text) continue;
    const duration = Number.isFinite(end) && end > start ? (end - start) : 3;
    out.push({ start, duration, text });
  }
  return out;
}

/**
 * V6.1 token-opt: gộp các cue liền kề, ngắn để giảm số chunk downstream.
 * Mỗi cue trong chunk sinh ra ~1 timestamp label ở locator → gộp = ít label = ít token.
 * Chỉ gộp khi 2 cue kế tiếp cách nhau ≤ maxGapSec VÀ tổng text sau gộp ≤ maxChars.
 */
function mergeCues(cues, opts = {}) {
  const maxGap = Number(opts.maxGapSec) || ASR_MERGE_MAX_GAP_SEC;
  const maxChars = Number(opts.maxChars) || ASR_MERGE_MAX_CHARS;
  const list = Array.isArray(cues) ? cues : [];
  if (list.length <= 1) return list.slice();
  const out = [];
  let cur = { ...list[0] };
  for (let i = 1; i < list.length; i++) {
    const next = list[i];
    const curEnd = cur.start + (cur.duration || 0);
    const gap = next.start - curEnd;
    const merged = `${cur.text} ${next.text}`.trim();
    if (gap >= 0 && gap <= maxGap && merged.length <= maxChars) {
      cur.duration = (next.start + (next.duration || 0)) - cur.start;
      cur.text = merged;
    } else {
      out.push(cur);
      cur = { ...next };
    }
  }
  out.push(cur);
  return out;
}

module.exports = {
  transcribeYouTubeWithGemini,
  parseAsrJson,
  mergeCues,
  isEnabled,
  ASR_EXTRACTOR_VERSION,
  ASR_MODEL,
  ASR_TIMEOUT_MS,
  ASR_MAX_OUTPUT_TOKENS
};
