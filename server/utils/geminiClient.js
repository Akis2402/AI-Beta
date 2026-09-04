'use strict';

const { iterateSSELines } = require('./sseParse');

// Client gọi Google Gemini API (generativelanguage.googleapis.com) bằng khóa API phía
// server (GEMINI_API_KEY), không bao giờ lộ ra client. Cùng "hình dạng" tham số/kết quả
// với callClaude() trong anthropicClient.js để aiProviders.js gọi mọi provider qua cùng
// một interface.

const API_KEY = process.env.GEMINI_API_KEY;
// Model mặc định — có thể ghi đè bằng biến môi trường GEMINI_MODEL (vd 'gemini-3.1-flash',
// 'gemini-2.5-pro'...). Xem danh sách model mới nhất tại ai.google.dev/gemini-api/docs/models
// trước khi đổi (Google thường xuyên retire các model cũ).
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
// Model "nhanh" dùng riêng cho chế độ Nhanh (tham số fast:true) — flash-lite nhẹ/nhanh hơn flash.
const MODEL_FAST = process.env.GEMINI_MODEL_FAST || 'gemini-3.5-flash-lite';
// Timeout mặc định cho 1 lượt gọi (ms) — có thể ghi đè bằng REQUEST_TIMEOUT_MS trong .env.
const DEFAULT_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS) || 30000;

function isConfigured() {
  return !!API_KEY;
}

// Chuyển "messages" nội bộ (kiểu Anthropic: content là chuỗi HOẶC mảng block
// {type:'text',text} / {type:'image',source:{type:'base64',media_type,data}}) sang định dạng
// "contents" của Gemini (role 'user'|'model', parts là mảng {text} / {inlineData:{mimeType,data}}).
function toGeminiContents(messages) {
  return messages.map((m) => {
    const role = m.role === 'assistant' ? 'model' : 'user';
    let parts;
    if (typeof m.content === 'string') {
      parts = [{ text: m.content }];
    } else {
      parts = (m.content || [])
        .map((b) => {
          if (b.type === 'text') return { text: b.text };
          if (b.type === 'image') {
            const src = b.source || {};
            return { inlineData: { mimeType: src.media_type, data: src.data } };
          }
          return null;
        })
        .filter(Boolean);
    }
    return { role, parts };
  });
}

/**
 * Gọi Gemini generateContent API. Đặt webSearch:true để cấp tool tìm kiếm web tích hợp sẵn
 * (google_search grounding) — dùng khi cần xác minh công thức trên các trang uy tín, ngang hàng
 * với khả năng tìm kiếm web của Claude/GPT trong dự án này.
 * @param {{system:string, messages:Array, maxTokens?:number, temperature?:number, webSearch?:boolean, fast?:boolean, timeoutMs?:number}} opts
 * @returns {Promise<string>}
 */
async function callGemini({ system, messages, maxTokens = 1000, temperature, webSearch, fast, deepThinking, timeoutMs = DEFAULT_TIMEOUT_MS, apiKeyOverride, modelOverride, fastModelOverride }) {
  const key = apiKeyOverride || API_KEY;
  if (!key) {
    const err = new Error('Máy chủ chưa cấu hình GEMINI_API_KEY.');
    err.status = 500;
    throw err;
  }

  const modelId = fast ? (fastModelOverride || MODEL_FAST) : (modelOverride || MODEL);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${key}`;
  const body = {
    contents: toGeminiContents(messages),
    generationConfig: {
      maxOutputTokens: maxTokens,
      ...(typeof temperature === 'number' ? { temperature } : {})
    }
  };
  // mục 1/12: NATIVE adaptive thinking của Gemini (thinkingBudget:-1 = model tự quyết mức suy luận
  // cần thiết) — chỉ bật khi thực sự deepThinking && KHÔNG chạy fast model, tránh tốn thêm token cho
  // các lượt fast/thường. includeThoughts:false vì đã có lớp lọc `thought:true` riêng bên dưới — xin
  // luôn từ nguồn để đỡ tốn băng thông/response size thay vì xin về rồi mới lọc bỏ.
  if (deepThinking && !fast) {
    body.generationConfig.thinkingConfig = { thinkingBudget: -1, includeThoughts: false };
  }
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (webSearch) body.tools = [{ google_search: {} }];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (networkErr) {
    const isAbort = networkErr && networkErr.name === 'AbortError';
    const err = new Error(
      isAbort
        ? `Gemini phản hồi quá chậm (vượt quá ${Math.round(timeoutMs / 1000)}s), đã hủy để chuyển sang nhà cung cấp khác.`
        : 'Không thể kết nối tới Gemini API. Vui lòng thử lại sau.'
    );
    err.status = isAbort ? 504 : 503;
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    let apiMessage = '';
    try {
      const parsed = JSON.parse(detail);
      apiMessage = (parsed && parsed.error && parsed.error.message) || '';
    } catch (e) { /* body không phải JSON hợp lệ — bỏ qua */ }

    const err = new Error(
      'Gemini API trả về lỗi (HTTP ' + res.status + ').' + (apiMessage ? ' Chi tiết: ' + apiMessage : '')
    );
    err.status = res.status === 429 ? 429 : 502;
    err.detail = detail.slice(0, 500);
    throw err;
  }

  const data = await res.json();
  const candidate = (data.candidates && data.candidates[0]) || {};
  // LỌC BỎ part có "thought:true": các model Gemini dòng "thinking" (2.5+) có thể trả về nháp
  // suy luận nội bộ dưới dạng 1 part RIÊNG trong CÙNG mảng "parts" với part chứa câu trả lời thật
  // (đánh dấu bằng cờ thought:true, khác cách Claude/GPT dùng thẻ <thinking> trong văn bản) — nếu
  // không lọc, ghép luôn part.text bất kể cờ này sẽ vô tình lộ nháp suy luận ra câu trả lời cuối.
  const text = ((candidate.content && candidate.content.parts) || [])
    .filter((p) => !p.thought)
    .map((p) => p.text || '')
    .join('\n')
    .trim();
  return text;
}

/**
 * Bản streaming của callGemini() — dùng endpoint streamGenerateContent?alt=sse, phát từng đoạn văn
 * bản qua onDelta ngay khi nhận được. Mỗi dòng "data:" ở đây là 1 object JSON có "hình dạng" giống
 * hệt response không-streaming (candidates[0].content.parts[].text), chỉ là 1 mẩu nhỏ thay vì toàn
 * bộ câu trả lời. Trả về Promise<string> = toàn bộ văn bản khi stream kết thúc.
 * @param {{system:string, messages:Array, maxTokens?:number, temperature?:number, webSearch?:boolean, fast?:boolean, timeoutMs?:number, onDelta?:Function}} opts
 * @returns {Promise<string>}
 */
async function callGeminiStream({ system, messages, maxTokens = 1000, temperature, webSearch, fast, deepThinking, timeoutMs = DEFAULT_TIMEOUT_MS, onDelta, apiKeyOverride, modelOverride, fastModelOverride }) {
  const key = apiKeyOverride || API_KEY;
  if (!key) {
    const err = new Error('Máy chủ chưa cấu hình GEMINI_API_KEY.');
    err.status = 500;
    throw err;
  }

  const modelId = fast ? (fastModelOverride || MODEL_FAST) : (modelOverride || MODEL);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:streamGenerateContent?alt=sse&key=${key}`;
  const body = {
    contents: toGeminiContents(messages),
    generationConfig: {
      maxOutputTokens: maxTokens,
      ...(typeof temperature === 'number' ? { temperature } : {})
    }
  };
  if (deepThinking && !fast) {
    body.generationConfig.thinkingConfig = { thinkingBudget: -1, includeThoughts: false };
  }
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (webSearch) body.tools = [{ google_search: {} }];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (networkErr) {
    clearTimeout(timer);
    const isAbort = networkErr && networkErr.name === 'AbortError';
    const err = new Error(
      isAbort
        ? `Gemini phản hồi quá chậm (vượt quá ${Math.round(timeoutMs / 1000)}s), đã hủy để chuyển sang nhà cung cấp khác.`
        : 'Không thể kết nối tới Gemini API. Vui lòng thử lại sau.'
    );
    err.status = isAbort ? 504 : 503;
    throw err;
  }

  if (!res.ok) {
    clearTimeout(timer);
    const detail = await res.text().catch(() => '');
    let apiMessage = '';
    try {
      const parsed = JSON.parse(detail);
      apiMessage = (parsed && parsed.error && parsed.error.message) || '';
    } catch (e) { /* body không phải JSON hợp lệ — bỏ qua */ }

    const err = new Error(
      'Gemini API trả về lỗi (HTTP ' + res.status + ').' + (apiMessage ? ' Chi tiết: ' + apiMessage : '')
    );
    err.status = res.status === 429 ? 429 : 502;
    err.detail = detail.slice(0, 500);
    throw err;
  }

  let full = '';
  try {
    for await (const raw of iterateSSELines(res)) {
      if (!raw) continue;
      let chunk;
      try { chunk = JSON.parse(raw); } catch (e) { continue; }
      const cand = (chunk.candidates && chunk.candidates[0]) || {};
      // Lọc bỏ part có "thought:true" — xem giải thích chi tiết ở callGemini() phía trên.
      const piece = ((cand.content && cand.content.parts) || [])
        .filter((p) => !p.thought)
        .map((p) => p.text || '')
        .join('');
      if (piece) {
        full += piece;
        if (typeof onDelta === 'function') onDelta(piece);
      }
    }
  } finally {
    clearTimeout(timer);
  }

  return full.trim();
}

module.exports = { callGemini, callGeminiStream, isConfigured, MODEL };
