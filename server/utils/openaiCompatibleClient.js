'use strict';

const { iterateSSELines } = require('./sseParse');

// Client DÙNG CHUNG cho mọi nhà cung cấp AI có API tương thích chuẩn "OpenAI Chat Completions"
// (POST {baseURL}, body {model, messages}, header Authorization: Bearer <key>) — đa số các hãng
// AI mới (Grok/xAI, Mistral, DeepSeek, Groq, OpenRouter, Together, Fireworks...) đều theo chuẩn
// này. Nhờ vậy, thêm 1 provider mới chỉ cần khai báo trong server/config/extraProviders.js —
// KHÔNG cần viết file client riêng như anthropicClient.js/openaiClient.js/geminiClient.js.
//
// createOpenAICompatibleClient(config) trả về { call, isConfigured } — cùng "hình dạng" với các
// client khác để aiProviders.js gọi qua chung 1 interface:
//   async ({system, messages, maxTokens, temperature, fast, timeoutMs}) => text

// Chuyển "messages" nội bộ (kiểu Anthropic: content là chuỗi HOẶC mảng block {type:'text',text} /
// {type:'image',source:{type:'base64',media_type,data}}) sang định dạng Chat Completions chuẩn
// (content là chuỗi HOẶC mảng {type:'text'} / {type:'image_url'}).
function toOpenAICompatibleMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const parts = (m.content || [])
      .map((b) => {
        if (b.type === 'text') return { type: 'text', text: b.text };
        if (b.type === 'image') {
          const src = b.source || {};
          return { type: 'image_url', image_url: { url: `data:${src.media_type};base64,${src.data}` } };
        }
        return null;
      })
      .filter(Boolean);
    out.push({ role: m.role, content: parts });
  }
  return out;
}

/**
 * @param {object} config Xem khuôn 1 provider trong server/config/extraProviders.js
 * @param {string} config.key
 * @param {string} config.label
 * @param {string} config.apiKeyEnv
 * @param {string} config.baseURL
 * @param {string} [config.modelEnv]
 * @param {string} config.defaultModel
 * @param {string} [config.fastModelEnv]
 * @param {string} [config.defaultFastModel]
 * @param {object} [config.extraBody] Trường bổ sung gộp thẳng vào body JSON (vd Groq
 *   {reasoning_format:'hidden'} để ẩn nháp suy luận — xem đầu extraProviders.js).
 * @returns {{call: Function, isConfigured: Function, MODEL: string}}
 */
function createOpenAICompatibleClient(config) {
  const { label, apiKeyEnv, baseURL, modelEnv, defaultModel, fastModelEnv, defaultFastModel, extraBody } = config;

  function apiKey() {
    return process.env[apiKeyEnv];
  }
  function model() {
    return (modelEnv && process.env[modelEnv]) || defaultModel;
  }
  function fastModel() {
    return (fastModelEnv && process.env[fastModelEnv]) || defaultFastModel || model();
  }

  function isConfigured() {
    return !!apiKey();
  }

  /**
   * @param {{system:string, messages:Array, maxTokens?:number, temperature?:number, fast?:boolean, timeoutMs?:number,
   *   apiKeyOverride?:string, modelOverride?:string, fastModelOverride?:string}} opts
   *   apiKeyOverride/modelOverride/fastModelOverride: dùng khi apiKeyEnv/modelEnv được khai NHIỀU
   *   giá trị (phân tách bằng dấu phẩy) — server/utils/aiProviders.js#buildKeyedVariants() truyền
   *   khóa/model cụ thể của từng "provider ảo" vào đây; bỏ trống = dùng đúng khóa/model đầu tiên đọc
   *   trực tiếp từ .env như trước (tương thích ngược với cấu hình chỉ có 1 khóa/1 model).
   */
  async function call({ system, messages, maxTokens = 1000, temperature, fast, deepThinking, timeoutMs = 30000, apiKeyOverride, modelOverride, fastModelOverride }) {
    const key = apiKeyOverride || apiKey();
    if (!key) {
      const err = new Error(`Máy chủ chưa cấu hình ${apiKeyEnv} cho nhà cung cấp ${label}.`);
      err.status = 500;
      throw err;
    }

    const body = {
      model: fast ? (fastModelOverride || fastModel()) : (modelOverride || model()),
      messages: toOpenAICompatibleMessages(system, messages),
      max_tokens: maxTokens,
      ...(extraBody || {}) // vd Groq: {reasoning_format:'hidden'} — xem extraProviders.js
    };
    // mục 1/12/13: KHÔNG giả định 1 provider OpenAI-compatible bất kỳ hỗ trợ reasoning native — chỉ
    // gộp `config.thinkingBody` khi provider đó TỰ khai supportsThinking:true trong extraProviders.js
    // (declare tường minh tham số reasoning riêng của hãng đó qua thinkingBody, giống cơ chế extraBody
    // sẵn có). Mặc định mọi extra provider hiện tại KHÔNG khai -> deepThinking chỉ còn tác dụng qua
    // prompt-based fallback (buildDeepThinkingBlock), không gửi tham số lạ gây lỗi 400.
    if (deepThinking && !fast && config.supportsThinking && config.thinkingBody) {
      Object.assign(body, config.thinkingBody);
    } else if (typeof temperature === 'number') {
      body.temperature = temperature;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res;
    try {
      res = await fetch(baseURL, {
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
          ? `${label} phản hồi quá chậm (vượt quá ${Math.round(timeoutMs / 1000)}s), đã hủy để chuyển sang nhà cung cấp khác.`
          : `Không thể kết nối tới ${label}. Vui lòng thử lại sau.`
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
        apiMessage = (parsed && parsed.error && (parsed.error.message || parsed.error)) || '';
      } catch (e) { /* body không phải JSON hợp lệ — bỏ qua */ }

      const err = new Error(
        `${label} trả về lỗi (HTTP ${res.status}).` + (apiMessage ? ' Chi tiết: ' + apiMessage : '')
      );
      err.status = res.status === 429 ? 429 : 502;
      err.detail = detail.slice(0, 500);
      throw err;
    }

    const data = await res.json();
    const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    return String(text).trim();
  }

  /**
   * Bản streaming của call() — chuẩn OpenAI Chat Completions streaming: mỗi dòng "data:" là 1 JSON
   * chunk {choices:[{delta:{content:"..."}}]}, kết thúc bằng dòng "data: [DONE]". Phát từng đoạn
   * văn bản qua onDelta ngay khi nhận được. Trả về Promise<string> = toàn bộ văn bản khi xong.
   * @param {{system:string, messages:Array, maxTokens?:number, temperature?:number, fast?:boolean, timeoutMs?:number, onDelta?:Function}} opts
   */
  async function callStream({ system, messages, maxTokens = 1000, temperature, fast, deepThinking, timeoutMs = 30000, onDelta, apiKeyOverride, modelOverride, fastModelOverride }) {
    const key = apiKeyOverride || apiKey();
    if (!key) {
      const err = new Error(`Máy chủ chưa cấu hình ${apiKeyEnv} cho nhà cung cấp ${label}.`);
      err.status = 500;
      throw err;
    }

    const body = {
      model: fast ? (fastModelOverride || fastModel()) : (modelOverride || model()),
      messages: toOpenAICompatibleMessages(system, messages),
      max_tokens: maxTokens,
      stream: true,
      ...(extraBody || {}) // vd Groq: {reasoning_format:'hidden'} — xem extraProviders.js
    };
    if (deepThinking && !fast && config.supportsThinking && config.thinkingBody) {
      Object.assign(body, config.thinkingBody);
    } else if (typeof temperature === 'number') {
      body.temperature = temperature;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res;
    try {
      res = await fetch(baseURL, {
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
          ? `${label} phản hồi quá chậm (vượt quá ${Math.round(timeoutMs / 1000)}s), đã hủy để chuyển sang nhà cung cấp khác.`
          : `Không thể kết nối tới ${label}. Vui lòng thử lại sau.`
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
        apiMessage = (parsed && parsed.error && (parsed.error.message || parsed.error)) || '';
      } catch (e) { /* body không phải JSON hợp lệ — bỏ qua */ }

      const err = new Error(
        `${label} trả về lỗi (HTTP ${res.status}).` + (apiMessage ? ' Chi tiết: ' + apiMessage : '')
      );
      err.status = res.status === 429 ? 429 : 502;
      err.detail = detail.slice(0, 500);
      throw err;
    }

    let full = '';
    try {
      for await (const raw of iterateSSELines(res)) {
        if (!raw || raw === '[DONE]') continue;
        let chunk;
        try { chunk = JSON.parse(raw); } catch (e) { continue; }
        const piece = (chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content) || '';
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

  return { call, callStream, isConfigured, get MODEL() { return model(); } };
}

module.exports = { createOpenAICompatibleClient };
