'use strict';

const { iterateSSELines } = require('./sseParse');

// Client gọi OpenAI Responses API (https://api.openai.com/v1/responses) bằng khóa API phía
// server (OPENAI_API_KEY), không bao giờ lộ ra client. Dùng Responses API (thay vì Chat
// Completions) vì đây là API hỗ trợ built-in tool "web_search_preview" — để GPT có thể tự
// xác minh công thức trên web giống hệt Claude/Gemini trong dự án này (không có nhà cung cấp
// nào "đặc quyền" hơn nhà cung cấp khác).
//
// Cùng "hình dạng" tham số với callClaude()/callGemini() để aiProviders.js gọi mọi provider
// qua cùng một interface: async ({system, messages, maxTokens, temperature, webSearch}) => text

const OPENAI_API_URL = 'https://api.openai.com/v1/responses';
const API_KEY = process.env.OPENAI_API_KEY;
// Model mặc định — có thể ghi đè bằng biến môi trường OPENAI_MODEL (vd 'gpt-5.2', 'gpt-4.1-mini'...).
// Cần là model hỗ trợ Responses API + tool web_search_preview — xem platform.openai.com/docs/models.
const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1';
// Model "nhanh" dùng riêng cho chế độ Nhanh (tham số fast:true) — gpt-4.1-mini nhanh/rẻ hơn đáng kể.
const MODEL_FAST = process.env.OPENAI_MODEL_FAST || 'gpt-4.1-mini';
// Timeout mặc định cho 1 lượt gọi (ms) — có thể ghi đè bằng REQUEST_TIMEOUT_MS trong .env.
const DEFAULT_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS) || 30000;

function isConfigured() {
  return !!API_KEY;
}

// Chuyển "messages" nội bộ của dự án (kiểu Anthropic: content là chuỗi HOẶC mảng block
// {type:'text',text} / {type:'image',source:{type:'base64',media_type,data}}) sang định dạng
// "input" của Responses API (mỗi phần tử {role, content:[{type:'input_text'|'input_image',...}]}).
function toResponsesInput(messages) {
  return messages.map((m) => {
    if (typeof m.content === 'string') {
      return { role: m.role, content: [{ type: 'input_text', text: m.content }] };
    }
    const content = (m.content || [])
      .map((b) => {
        if (b.type === 'text') return { type: 'input_text', text: b.text };
        if (b.type === 'image') {
          const src = b.source || {};
          return { type: 'input_image', image_url: `data:${src.media_type};base64,${src.data}` };
        }
        return null;
      })
      .filter(Boolean);
    return { role: m.role, content };
  });
}

// Responses API trả kết quả trong data.output (mảng item); một số bản SDK còn tổng hợp sẵn
// data.output_text — ưu tiên dùng nếu có, nếu không thì tự gom text từ các item type "message".
function extractResponsesText(data) {
  if (typeof data.output_text === 'string' && data.output_text) return data.output_text.trim();
  const output = Array.isArray(data.output) ? data.output : [];
  const parts = [];
  for (const item of output) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c.type === 'output_text' && c.text) parts.push(c.text);
      }
    }
  }
  return parts.join('\n').trim();
}

/**
 * Gọi OpenAI Responses API. Đặt webSearch:true để cấp tool tìm kiếm web tích hợp sẵn
 * (web_search_preview) — dùng khi cần xác minh công thức trên các trang uy tín.
 * @param {{system:string, messages:Array, maxTokens?:number, temperature?:number, webSearch?:boolean, fast?:boolean, timeoutMs?:number}} opts
 * @returns {Promise<string>}
 */
async function callOpenAI({ system, messages, maxTokens = 1000, temperature, webSearch, fast, deepThinking, timeoutMs = DEFAULT_TIMEOUT_MS, apiKeyOverride, modelOverride, fastModelOverride }) {
  const key = apiKeyOverride || API_KEY;
  if (!key) {
    const err = new Error('Máy chủ chưa cấu hình OPENAI_API_KEY.');
    err.status = 500;
    throw err;
  }

  const body = {
    model: fast ? (fastModelOverride || MODEL_FAST) : (modelOverride || MODEL),
    instructions: system,
    input: toResponsesInput(messages),
    max_output_tokens: maxTokens
  };
  // mục 1/12: Responses API điều khiển reasoning qua `reasoning.effort` — KHÔNG có tham số "budget"
  // như Anthropic/Gemini (capability supportsAdaptiveThinking:false cho OpenAI — xem executionTargets.js).
  // Không gửi kèm temperature khi bật reasoning effort cao (một số model reasoning từ chối temperature
  // tùy chỉnh) — capability-aware: bỏ qua thay vì gửi tham số có thể không tương thích (mục 12).
  const useReasoning = !!deepThinking && !fast;
  if (useReasoning) {
    body.reasoning = { effort: 'high' };
  } else if (typeof temperature === 'number') {
    body.temperature = temperature;
  }
  if (webSearch) body.tools = [{ type: 'web_search_preview' }];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (networkErr) {
    const isAbort = networkErr && networkErr.name === 'AbortError';
    const err = new Error(
      isAbort
        ? `GPT phản hồi quá chậm (vượt quá ${Math.round(timeoutMs / 1000)}s), đã hủy để chuyển sang nhà cung cấp khác.`
        : 'Không thể kết nối tới OpenAI API. Vui lòng thử lại sau.'
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
      'OpenAI API trả về lỗi (HTTP ' + res.status + ').' + (apiMessage ? ' Chi tiết: ' + apiMessage : '')
    );
    err.status = res.status === 429 ? 429 : 502;
    err.detail = detail.slice(0, 500);
    throw err;
  }

  const data = await res.json();
  return extractResponsesText(data);
}

/**
 * Bản streaming của callOpenAI() — gọi Responses API với stream:true, phát từng đoạn văn bản qua
 * onDelta ngay khi nhận được. Sự kiện SSE quan tâm: "response.output_text.delta" (data.delta chứa
 * đoạn văn bản mới). Trả về Promise<string> = toàn bộ văn bản khi stream kết thúc.
 * @param {{system:string, messages:Array, maxTokens?:number, temperature?:number, webSearch?:boolean, fast?:boolean, timeoutMs?:number, onDelta?:Function}} opts
 * @returns {Promise<string>}
 */
async function callOpenAIStream({ system, messages, maxTokens = 1000, temperature, webSearch, fast, deepThinking, timeoutMs = DEFAULT_TIMEOUT_MS, onDelta, apiKeyOverride, modelOverride, fastModelOverride }) {
  const key = apiKeyOverride || API_KEY;
  if (!key) {
    const err = new Error('Máy chủ chưa cấu hình OPENAI_API_KEY.');
    err.status = 500;
    throw err;
  }

  const body = {
    model: fast ? (fastModelOverride || MODEL_FAST) : (modelOverride || MODEL),
    instructions: system,
    input: toResponsesInput(messages),
    max_output_tokens: maxTokens,
    stream: true
  };
  const useReasoning = !!deepThinking && !fast;
  if (useReasoning) {
    body.reasoning = { effort: 'high' };
  } else if (typeof temperature === 'number') {
    body.temperature = temperature;
  }
  if (webSearch) body.tools = [{ type: 'web_search_preview' }];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (networkErr) {
    clearTimeout(timer);
    const isAbort = networkErr && networkErr.name === 'AbortError';
    const err = new Error(
      isAbort
        ? `GPT phản hồi quá chậm (vượt quá ${Math.round(timeoutMs / 1000)}s), đã hủy để chuyển sang nhà cung cấp khác.`
        : 'Không thể kết nối tới OpenAI API. Vui lòng thử lại sau.'
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
      'OpenAI API trả về lỗi (HTTP ' + res.status + ').' + (apiMessage ? ' Chi tiết: ' + apiMessage : '')
    );
    err.status = res.status === 429 ? 429 : 502;
    err.detail = detail.slice(0, 500);
    throw err;
  }

  let full = '';
  try {
    for await (const raw of iterateSSELines(res)) {
      if (!raw || raw === '[DONE]') continue;
      let evt;
      try { evt = JSON.parse(raw); } catch (e) { continue; }
      if (evt.type === 'response.output_text.delta' && evt.delta) {
        full += evt.delta;
        if (typeof onDelta === 'function') onDelta(evt.delta);
      }
    }
  } finally {
    clearTimeout(timer);
  }

  return full.trim();
}

module.exports = { callOpenAI, callOpenAIStream, isConfigured, MODEL };
