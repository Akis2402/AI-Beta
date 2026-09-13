'use strict';

// A1: OpenAI tự cache prefix trùng >1024 token — điều kiện DUY NHẤT là phần TĨNH phải luôn đứng
// TRƯỚC phần ĐỘNG. systemToString() ghép theo đúng thứ tự đó.
const { systemToString } = require('./systemPromptParts');

const { effortFromBudget, fitReasoningToModel } = require('./budget/reasoningPolicy');

const { iterateSSELines } = require('./sseParse');
const { createLinkedAbort, makeCancelledError } = require('./abortLink');
const { finishReasonFromResponsesApi } = require('./finishReason');

// Client gọi OpenAI Responses API (https://api.openai.com/v1/responses) bằng khóa API phía
// server (OPENAI_API_KEY), không bao giờ lộ ra client. Dùng Responses API (thay vì Chat
// Completions) vì đây là API hỗ trợ built-in tool "web_search_preview" — để GPT có thể tự
// xác minh công thức trên web giống hệt Claude/Gemini trong dự án này (không có nhà cung cấp
// nào "đặc quyền" hơn nhà cung cấp khác).
//
// Cùng "hình dạng" tham số với callClaude()/callGemini() để aiProviders.js gọi mọi provider
// qua cùng một interface: async ({system, messages, maxTokens, temperature, webSearch}) => text


// ============================================================================================
// PHẦN 1/2 ROOT-CAUSE FIX — reasoning token của Responses API tính vào `max_output_tokens`
// ============================================================================================
// TRƯỚC ĐÂY: body.max_output_tokens = maxTokens (= coreBudget) VÀ reasoning.effort = 'high' CỨNG.
// Với một ngân sách nhỏ, model reasoning có thể tiêu gần hết max_output_tokens cho suy luận rồi
// trả về status='incomplete' + incomplete_details.reason='max_output_tokens' và output RỖNG.
// finishReason -> 'length' -> HARD -> recovery -> lặp lại y hệt -> reserve cạn -> FAILED.
//
// NAY: `maxTokens` = answerBudget (bất khả xâm phạm). `reasoningBudget` được CỘNG THÊM vào
// max_output_tokens, và effort được suy ra TỪ ngân sách đó (effortFromBudget) thay vì hard-code —
// ngân sách lớn vẫn giữ 'high' (KHÔNG giảm độ sâu reasoning để tiết kiệm token).
function applyOpenAIReasoning(body, { maxTokens, reasoningBudget, deepThinking, fast, capabilities, temperature }) {
  const capsKnown = capabilities && typeof capabilities === 'object';
  const reasoningCapable = capsKnown ? !!capabilities.supportsThinking : true;
  const useReasoning = !!deepThinking && !fast && reasoningCapable;
  if (!useReasoning) {
    if (typeof temperature === 'number') body.temperature = temperature;
    return body;
  }
  // A5: reasoningBudget = 0 TƯỜNG MINH -> KHÔNG gửi tham số reasoning (lớp bài MICRO / model quá
  // nhỏ). `undefined` giữ hành vi legacy (effort 'high').
  if (reasoningBudget === 0 || (Number.isFinite(reasoningBudget) && reasoningBudget <= 0)) {
    if (typeof temperature === 'number') body.temperature = temperature;
    return body;
  }
  const explicit = Number.isFinite(reasoningBudget) && reasoningBudget > 0;
  if (explicit) {
    // A4 (bất biến E): reasoning token của Responses API tính vào max_output_tokens -> answer +
    // reasoning phải nằm trọn trong trần output THẬT của model.
    const fitted = fitReasoningToModel({
      reasoningBudget: Math.round(reasoningBudget), answerBudget: Math.round(maxTokens),
      capabilities: capsKnown ? capabilities : null,
      minReasoningTokens: 1024, countsAgainstOutput: true
    });
    if (!fitted.nativeEnabled) {
      if (typeof temperature === 'number') body.temperature = temperature;
      return body; // model không đủ chỗ cho reasoning hợp lệ -> prompt-based
    }
    body.reasoning = { effort: effortFromBudget(fitted.reasoningBudget) || 'high' };
    body.max_output_tokens = fitted.providerMaxTokens;
    return body;
  }
  body.reasoning = { effort: 'high' };
  return body;
}

const OPENAI_API_URL = 'https://api.openai.com/v1/responses';
const API_KEY = process.env.OPENAI_API_KEY;
// ---------- mục 2/12/24: KHÔNG còn hard-code model mặc định ----------
// Model THẬT tới qua modelOverride/fastModelOverride do executionTargets.js truyền vào (đã được
// modelDiscovery.js xác nhận qua API liệt kê model thật, hoặc legacy OPENAI_MODEL/OPENAI_MODEL_FAST
// do người dùng tự khai). Không đoán mò tên model nếu không có gì được xác nhận (xem assertModel()).
const MODEL = process.env.OPENAI_MODEL || null;
const MODEL_FAST = process.env.OPENAI_MODEL_FAST || null;

function assertModel(model) {
  if (model) return model;
  const err = new Error(
    'Không xác định được model GPT để gọi: chưa có model nào được model discovery xác nhận, và ' +
    'OPENAI_MODEL cũng chưa được khai trong .env. Kiểm tra OPENAI_API_KEY hợp lệ để hệ thống tự ' +
    'discovery model, hoặc khai OPENAI_MODEL để ghi đè thủ công.'
  );
  err.status = 500;
  throw err;
}
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
async function callOpenAI({ system, messages, maxTokens = 1000, reasoningBudget, temperature, webSearch, fast, deepThinking, capabilities, timeoutMs = DEFAULT_TIMEOUT_MS, apiKeyOverride, modelOverride, fastModelOverride, signal, meta }) {
  const key = apiKeyOverride || API_KEY;
  if (!key) {
    const err = new Error('Máy chủ chưa cấu hình OPENAI_API_KEY.');
    err.status = 500;
    throw err;
  }

  const body = {
    model: assertModel(fast ? (fastModelOverride || MODEL_FAST || MODEL) : (modelOverride || MODEL)),
    instructions: systemToString(system),
    input: toResponsesInput(messages),
    max_output_tokens: maxTokens
  };
  // mục 1/12: Responses API điều khiển reasoning qua `reasoning.effort` — KHÔNG có tham số "budget"
  // như Anthropic/Gemini (capability supportsAdaptiveThinking:false cho OpenAI — xem executionTargets.js).
  // Không gửi kèm temperature khi bật reasoning effort cao (một số model reasoning từ chối temperature
  // tùy chỉnh) — capability-aware: bỏ qua thay vì gửi tham số có thể không tương thích (mục 12).
  // FIX P0/C (audit): TRƯỚC ĐÂY useReasoning chỉ dựa vào deepThinking+fast — reasoning.effort là
  // tham số CHỈ o-series/gpt-5 reasoning model chấp nhận; gửi cho model không reasoning (vd gpt-4o,
  // gpt-4o-mini) sẽ bị OpenAI trả lỗi 400 "Unsupported parameter: 'reasoning'". Nay chỉ bật khi
  // capabilities (forward từ executionTargets.js, đã merge model-level supportsReasoning từ
  // modelDiscovery) xác nhận supportsThinking. capabilities HOÀN TOÀN vắng mặt (gọi trực tiếp ngoài
  // executionTargets, vd test cũ) -> giữ hành vi permissive cũ (tương thích ngược).
  applyOpenAIReasoning(body, { maxTokens, reasoningBudget, deepThinking, fast, capabilities, temperature });
  if (webSearch) body.tools = [{ type: 'web_search_preview' }];

  const linked = createLinkedAbort(timeoutMs, signal);

  let res;
  try {
    res = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify(body),
      signal: linked.signal
    });
  } catch (networkErr) {
    if (linked.isCancelledByCaller()) throw makeCancelledError();
    const isAbort = networkErr && networkErr.name === 'AbortError';
    const err = new Error(
      isAbort
        ? `GPT phản hồi quá chậm (vượt quá ${Math.round(timeoutMs / 1000)}s), đã hủy để chuyển sang nhà cung cấp khác.`
        : 'Không thể kết nối tới OpenAI API. Vui lòng thử lại sau.'
    );
    err.status = isAbort ? 504 : 503;
    throw err;
  } finally {
    linked.cleanup();
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    let apiMessage = '';
    try {
      const parsed = JSON.parse(detail);
      apiMessage = (parsed && parsed.error && parsed.error.message) || '';
    } catch (e) { /* body không phải JSON hợp lệ — bỏ qua */ }

    // P0 mục 2: không nhét apiMessage thô (billing/nội bộ) vào err.message — chỉ debugMessage
    // (chỉ lộ khi NODE_ENV !== 'production', xem errorNormalize.js).
    const err = new Error('OpenAI API trả về lỗi (HTTP ' + res.status + ').');
    err.status = res.status === 429 ? 429 : 502;
    err.detail = detail.slice(0, 500);
    if (apiMessage) err.debugMessage = apiMessage;
    throw err;
  }

  const data = await res.json();
  // mục 1 (completion-first): Responses API dùng {status, incomplete_details} thay vì 1 field đơn —
  // xem finishReasonFromResponsesApi() trong finishReason.js.
  if (meta) meta.finishReason = finishReasonFromResponsesApi(data);
  return extractResponsesText(data);
}

/**
 * Bản streaming của callOpenAI() — gọi Responses API với stream:true, phát từng đoạn văn bản qua
 * onDelta ngay khi nhận được. Sự kiện SSE quan tâm: "response.output_text.delta" (data.delta chứa
 * đoạn văn bản mới). Trả về Promise<string> = toàn bộ văn bản khi stream kết thúc.
 * @param {{system:string, messages:Array, maxTokens?:number, temperature?:number, webSearch?:boolean, fast?:boolean, timeoutMs?:number, onDelta?:Function}} opts
 * @returns {Promise<string>}
 */
async function callOpenAIStream({ system, messages, maxTokens = 1000, reasoningBudget, temperature, webSearch, fast, deepThinking, capabilities, timeoutMs = DEFAULT_TIMEOUT_MS, onDelta, apiKeyOverride, modelOverride, fastModelOverride, signal, meta }) {
  const key = apiKeyOverride || API_KEY;
  if (!key) {
    const err = new Error('Máy chủ chưa cấu hình OPENAI_API_KEY.');
    err.status = 500;
    throw err;
  }

  const body = {
    model: assertModel(fast ? (fastModelOverride || MODEL_FAST || MODEL) : (modelOverride || MODEL)),
    instructions: systemToString(system),
    input: toResponsesInput(messages),
    max_output_tokens: maxTokens,
    stream: true
  };
  applyOpenAIReasoning(body, { maxTokens, reasoningBudget, deepThinking, fast, capabilities, temperature });
  if (webSearch) body.tools = [{ type: 'web_search_preview' }];

  const linked = createLinkedAbort(timeoutMs, signal);

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
      signal: linked.signal
    });
  } catch (networkErr) {
    linked.cleanup();
    if (linked.isCancelledByCaller()) throw makeCancelledError();
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
    linked.cleanup();
    const detail = await res.text().catch(() => '');
    let apiMessage = '';
    try {
      const parsed = JSON.parse(detail);
      apiMessage = (parsed && parsed.error && parsed.error.message) || '';
    } catch (e) { /* body không phải JSON hợp lệ — bỏ qua */ }

    const err = new Error('OpenAI API trả về lỗi (HTTP ' + res.status + ').');
    err.status = res.status === 429 ? 429 : 502;
    err.detail = detail.slice(0, 500);
    if (apiMessage) err.debugMessage = apiMessage;
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
      // mục 1: sự kiện cuối stream mang response.status đầy đủ ('completed'/'incomplete') — cùng
      // hình dạng {status, incomplete_details} như bản không-streaming.
      if ((evt.type === 'response.completed' || evt.type === 'response.incomplete') && evt.response && meta) {
        meta.finishReason = finishReasonFromResponsesApi(evt.response);
      }
    }
  } finally {
    linked.cleanup();
  }

  return full.trim();
}

module.exports = { callOpenAI, callOpenAIStream, isConfigured, MODEL };
