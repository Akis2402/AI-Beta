'use strict';

const { iterateSSELines } = require('./sseParse');
const { createLinkedAbort, makeCancelledError } = require('./abortLink');
const { normalizeFinishReason } = require('./finishReason');

// Client gọi Google Gemini API (generativelanguage.googleapis.com) bằng khóa API phía
// server (GEMINI_API_KEY), không bao giờ lộ ra client. Cùng "hình dạng" tham số/kết quả
// với callClaude() trong anthropicClient.js để aiProviders.js gọi mọi provider qua cùng
// một interface.

const API_KEY = process.env.GEMINI_API_KEY;
// ---------- mục 2/12/24: KHÔNG còn hard-code model mặc định ----------
// Model THẬT tới qua modelOverride/fastModelOverride do executionTargets.js truyền vào (đã được
// modelDiscovery.js xác nhận qua API liệt kê model thật, hoặc legacy GEMINI_MODEL/GEMINI_MODEL_FAST
// do người dùng tự khai). Không đoán mò tên model nếu không có gì được xác nhận (xem assertModel()).
const MODEL = process.env.GEMINI_MODEL || null;
const MODEL_FAST = process.env.GEMINI_MODEL_FAST || null;

function assertModel(model) {
  if (model) return model;
  const err = new Error(
    'Không xác định được model Gemini để gọi: chưa có model nào được model discovery xác nhận, và ' +
    'GEMINI_MODEL cũng chưa được khai trong .env. Kiểm tra GEMINI_API_KEY hợp lệ để hệ thống tự ' +
    'discovery model, hoặc khai GEMINI_MODEL để ghi đè thủ công.'
  );
  err.status = 500;
  throw err;
}
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

// ---------- FIX P1/F (audit): Gemini thinking PHẢI version-aware, không dùng 1 config chung ----------
// Gemini 3+ dùng `thinkingLevel` ('low'|'high'), Gemini 2.5-style dùng `thinkingBudget` (số token,
// -1 = model tự quyết). Gửi nhầm field cho model không hỗ trợ field đó có thể bị API từ chối hoặc
// im lặng bỏ qua. `capabilities` (forward từ executionTargets.js, đã merge model-level
// supportsReasoning từ modelDiscovery.js) là nguồn xác nhận model CÓ hỗ trợ reasoning native hay
// không — capabilities HOÀN TOÀN vắng mặt (gọi callGemini() trực tiếp ngoài executionTargets, vd
// test/legacy) giữ hành vi permissive cũ (thinkingBudget mặc định) để tương thích ngược; nếu
// capabilities CÓ nhưng xác nhận KHÔNG hỗ trợ reasoning, hoặc model thuộc thế hệ không xác định được
// (không phải 3.x/2.5.x) thì fail-safe: KHÔNG gửi cấu hình native thinking mù (mục F.3).
// @param {{modelId:string, capabilities?:object, deepThinking:boolean, fast:boolean}} args
// @returns {{thinkingLevel:string,includeThoughts:boolean}|{thinkingBudget:number,includeThoughts:boolean}|null}
function resolveGeminiThinkingConfig({ modelId, capabilities, deepThinking, fast }) {
  if (!deepThinking || fast) return null;
  const capsKnown = capabilities && typeof capabilities === 'object';
  const thinkingCapable = capsKnown ? !!(capabilities.supportsThinking || capabilities.supportsAdaptiveThinking) : true;
  if (!thinkingCapable) return null;
  const id = String(modelId || '');
  // includeThoughts:false vì đã có lớp lọc `thought:true` riêng bên dưới — xin luôn từ nguồn để đỡ
  // tốn băng thông/response size thay vì xin về rồi mới lọc bỏ.
  if (/gemini-3/i.test(id)) return { thinkingLevel: 'high', includeThoughts: false };
  if (/gemini-2\.5/i.test(id)) return { thinkingBudget: -1, includeThoughts: false };
  if (!capsKnown) return { thinkingBudget: -1, includeThoughts: false }; // legacy direct-call, không biết modelId/generation gì thêm -> giữ hành vi cũ
  return null; // capsKnown=true nhưng KHÔNG xác định được thế hệ model (không phải 3.x/2.5.x) -> fail-safe, không đoán mò field
}

/**
 * Gọi Gemini generateContent API. Đặt webSearch:true để cấp tool tìm kiếm web tích hợp sẵn
 * (google_search grounding) — dùng khi cần xác minh công thức trên các trang uy tín, ngang hàng
 * với khả năng tìm kiếm web của Claude/GPT trong dự án này.
 * @param {{system:string, messages:Array, maxTokens?:number, temperature?:number, webSearch?:boolean, fast?:boolean, timeoutMs?:number}} opts
 * @returns {Promise<string>}
 */
async function callGemini({ system, messages, maxTokens = 1000, temperature, webSearch, fast, deepThinking, capabilities, timeoutMs = DEFAULT_TIMEOUT_MS, apiKeyOverride, modelOverride, fastModelOverride, signal, meta }) {
  const key = apiKeyOverride || API_KEY;
  if (!key) {
    const err = new Error('Máy chủ chưa cấu hình GEMINI_API_KEY.');
    err.status = 500;
    throw err;
  }

  const modelId = assertModel(fast ? (fastModelOverride || MODEL_FAST || MODEL) : (modelOverride || MODEL));
  // FIX P1/E (audit): TRƯỚC ĐÂY API key nằm trong query string (?key=...) — lộ qua access log của
  // proxy/CDN trung gian, browser history (nếu URL này từng lộ ra client), và referrer header khi
  // request này (dù chỉ server-side) đi qua bất kỳ lớp trung gian nào log URL đầy đủ. Google Gemini
  // API CHẤP NHẬN khóa qua HTTP header `x-goog-api-key` — dùng header thay vì query string cho MỌI
  // request Gemini (discovery, generateContent, streamGenerateContent — xem modelDiscovery.js).
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`;
  const body = {
    contents: toGeminiContents(messages),
    generationConfig: {
      maxOutputTokens: maxTokens,
      ...(typeof temperature === 'number' ? { temperature } : {})
    }
  };
  // FIX P0/C/F (audit): thinkingConfig giờ do resolveGeminiThinkingConfig() quyết định — capability-
  // aware (model có hỗ trợ reasoning không) VÀ version-aware (thinkingLevel cho Gemini 3+,
  // thinkingBudget cho Gemini 2.5-style) thay vì 1 config cứng {thinkingBudget:-1} cho MỌI model.
  const thinkingConfig = resolveGeminiThinkingConfig({ modelId, capabilities, deepThinking, fast });
  if (thinkingConfig) body.generationConfig.thinkingConfig = thinkingConfig;
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (webSearch) body.tools = [{ google_search: {} }];

  const linked = createLinkedAbort(timeoutMs, signal);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: linked.signal
    });
  } catch (networkErr) {
    if (linked.isCancelledByCaller()) throw makeCancelledError();
    const isAbort = networkErr && networkErr.name === 'AbortError';
    const err = new Error(
      isAbort
        ? `Gemini phản hồi quá chậm (vượt quá ${Math.round(timeoutMs / 1000)}s), đã hủy để chuyển sang nhà cung cấp khác.`
        : 'Không thể kết nối tới Gemini API. Vui lòng thử lại sau.'
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

    // P0 mục 2: không nhét apiMessage thô vào err.message — chỉ debugMessage (dev-only).
    const err = new Error('Gemini API trả về lỗi (HTTP ' + res.status + ').');
    err.status = res.status === 429 ? 429 : 502;
    err.detail = detail.slice(0, 500);
    if (apiMessage) err.debugMessage = apiMessage;
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
  // mục 1 (completion-first): candidate.finishReason ('STOP'/'MAX_TOKENS'/...) forward qua meta.
  if (meta) meta.finishReason = normalizeFinishReason(candidate.finishReason);
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
async function callGeminiStream({ system, messages, maxTokens = 1000, temperature, webSearch, fast, deepThinking, capabilities, timeoutMs = DEFAULT_TIMEOUT_MS, onDelta, apiKeyOverride, modelOverride, fastModelOverride, signal, meta }) {
  const key = apiKeyOverride || API_KEY;
  if (!key) {
    const err = new Error('Máy chủ chưa cấu hình GEMINI_API_KEY.');
    err.status = 500;
    throw err;
  }

  const modelId = assertModel(fast ? (fastModelOverride || MODEL_FAST || MODEL) : (modelOverride || MODEL));
  // FIX P1/E (audit): key qua header x-goog-api-key, không còn nằm trong query string — xem callGemini().
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:streamGenerateContent?alt=sse`;
  const body = {
    contents: toGeminiContents(messages),
    generationConfig: {
      maxOutputTokens: maxTokens,
      ...(typeof temperature === 'number' ? { temperature } : {})
    }
  };
  const thinkingConfig = resolveGeminiThinkingConfig({ modelId, capabilities, deepThinking, fast });
  if (thinkingConfig) body.generationConfig.thinkingConfig = thinkingConfig;
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (webSearch) body.tools = [{ google_search: {} }];

  const linked = createLinkedAbort(timeoutMs, signal);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: linked.signal
    });
  } catch (networkErr) {
    linked.cleanup();
    if (linked.isCancelledByCaller()) throw makeCancelledError();
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
    linked.cleanup();
    const detail = await res.text().catch(() => '');
    let apiMessage = '';
    try {
      const parsed = JSON.parse(detail);
      apiMessage = (parsed && parsed.error && parsed.error.message) || '';
    } catch (e) { /* body không phải JSON hợp lệ — bỏ qua */ }

    // FIX P1/E (audit): thống nhất với callGemini()/anthropicClient.js — KHÔNG nhét apiMessage thô
    // (có thể chứa chi tiết nội bộ của provider) thẳng vào err.message hiển thị được; chỉ giữ ở
    // debugMessage (chỉ lộ khi NODE_ENV !== 'production', xem errorNormalize.js).
    const err = new Error('Gemini API trả về lỗi (HTTP ' + res.status + ').');
    err.status = res.status === 429 ? 429 : 502;
    err.detail = detail.slice(0, 500);
    if (apiMessage) err.debugMessage = apiMessage;
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
      // mục 1: finishReason chỉ xuất hiện ở chunk CUỐI (khi model thực sự dừng) — ghi đè liên tục,
      // giá trị còn lại sau vòng lặp chính là finishReason của chunk cuối cùng nhận được.
      if (cand.finishReason && meta) meta.finishReason = normalizeFinishReason(cand.finishReason);
    }
  } finally {
    linked.cleanup();
  }

  return full.trim();
}

module.exports = { callGemini, callGeminiStream, isConfigured, MODEL, resolveGeminiThinkingConfig };
