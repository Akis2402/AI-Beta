'use strict';

const { iterateSSELines } = require('./sseParse');
const { createLinkedAbort, makeCancelledError } = require('./abortLink');
const { nativeThinkingBudget } = require('./thinkingRouter');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const API_KEY = process.env.ANTHROPIC_API_KEY;
// ---------- mục 2/12/24: KHÔNG còn hard-code model mặc định ở đây ----------
// Model THẬT luôn tới qua modelOverride/fastModelOverride (executionTargets.js truyền vào — model
// đã được server/utils/modelDiscovery.js xác nhận tồn tại qua API liệt kê model, hoặc do người dùng
// tự khai ANTHROPIC_MODEL/ANTHROPIC_MODEL_FAST làm legacy explicit override). MODEL/MODEL_FAST ở
// đây CHỈ còn là legacy fallback khi ai đó gọi callClaude() trực tiếp (ngoài executionTargets) —
// không đoán mò tên model nào nếu người dùng không khai báo (xem assertModel() bên dưới).
const MODEL = process.env.ANTHROPIC_MODEL || null;
const MODEL_FAST = process.env.ANTHROPIC_MODEL_FAST || null;

function assertModel(model) {
  if (model) return model;
  const err = new Error(
    'Không xác định được model Claude để gọi: chưa có model nào được model discovery xác nhận, và ' +
    'ANTHROPIC_MODEL cũng chưa được khai trong .env. Kiểm tra ANTHROPIC_API_KEY hợp lệ để hệ thống tự ' +
    'discovery model, hoặc khai ANTHROPIC_MODEL để ghi đè thủ công.'
  );
  err.status = 500;
  throw err;
}
// Timeout mặc định cho 1 lượt gọi (ms) — có thể ghi đè bằng REQUEST_TIMEOUT_MS trong .env.
// Quá thời gian này, request bị hủy và tính là lỗi để hệ thống tự động chuyển sang provider khác
// (failover) thay vì bắt người dùng chờ vô thời hạn một nhà cung cấp đang phản hồi chậm.
const DEFAULT_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS) || 30000;

if (!API_KEY) {
  // Không throw ngay khi khởi động để dev vẫn xem được giao diện,
  // nhưng mọi request tới AI sẽ báo lỗi rõ ràng cho tới khi cấu hình .env
  console.warn(
    '[CẢNH BÁO BẢO MẬT/CẤU HÌNH] Chưa thấy ANTHROPIC_API_KEY trong biến môi trường. ' +
    'Tạo file .env từ .env.example rồi điền khóa API thật trước khi dùng thật.'
  );
}

/**
 * Gọi Anthropic Messages API bằng khóa API phía server (không bao giờ lộ ra client).
 * @param {{system:string, messages:Array, maxTokens?:number, tools?:Array, temperature?:number, fast?:boolean, timeoutMs?:number,
 *   apiKeyOverride?:string, modelOverride?:string, fastModelOverride?:string}} opts
 *   apiKeyOverride/modelOverride/fastModelOverride: dùng khi 1 provider được cấu hình NHIỀU khóa
 *   API/model (xem ANTHROPIC_API_KEY, ANTHROPIC_MODEL trong .env — hỗ trợ liệt kê nhiều giá trị
 *   phân tách bằng dấu phẩy) — server/utils/aiProviders.js#buildKeyedVariants() truyền khóa/model cụ
 *   thể của từng "provider ảo" vào đây; nếu bỏ trống, dùng đúng khóa/model mặc định đọc từ .env như
 *   trước (tương thích ngược 100% với cấu hình chỉ có 1 khóa/1 model).
 * @returns {Promise<string>} nội dung text trả lời (đã gộp mọi khối "text", bỏ qua khối tool_use/tool_result)
 */
async function callClaude({ system, messages, maxTokens = 1000, tools, temperature, fast, deepThinking, capabilities, timeoutMs = DEFAULT_TIMEOUT_MS, apiKeyOverride, modelOverride, fastModelOverride, signal }) {
  const key = apiKeyOverride || API_KEY;
  if (!key) {
    const err = new Error('Máy chủ chưa được cấu hình ANTHROPIC_API_KEY. Vui lòng liên hệ quản trị viên.');
    err.status = 500;
    throw err;
  }

  const body = {
    model: assertModel(fast ? (fastModelOverride || MODEL_FAST || MODEL) : (modelOverride || MODEL)),
    max_tokens: maxTokens,
    system,
    messages
  };
  if (Array.isArray(tools) && tools.length) body.tools = tools;
  // ---------- mục 1/12: NATIVE extended thinking (không phải prompt-based) ----------
  // deepThinking=true và KHÔNG chạy fast model -> bật cơ chế reasoning THẬT của Claude thay vì chỉ
  // dựa vào buildDeepThinkingBlock() trong system prompt. Khi thinking bật, Anthropic API KHÔNG cho
  // truyền temperature/top_p/top_k tùy chỉnh (chỉ được dùng mặc định) — capability-aware request
  // builder (mục 12): bỏ qua temperature thay vì gửi tham số không tương thích gây lỗi 400.
  // budget_tokens PHẢI < max_tokens (yêu cầu cứng của Anthropic) — nếu ngân sách output quá nhỏ để
  // dành chỗ cho cả thinking lẫn câu trả lời thật, bỏ qua native thinking (fallback về prompt-based,
  // đã có sẵn ở tầng system prompt — không throw lỗi 400 vì gửi budget_tokens vô nghĩa).
  // FIX P0/C (audit): TRƯỚC ĐÂY useNativeThinking chỉ dựa vào deepThinking+fast+maxTokens — KHÔNG hề
  // kiểm tra model THỰC TẾ (qua target.capabilities do executionTargets.js merge từ modelDiscovery)
  // có hỗ trợ reasoning native hay không => model không hỗ trợ vẫn có thể nhận `thinking:{enabled}`
  // và bị Anthropic trả 400. Nay: `capabilities` là object đã biết (được executionTargets.js LUÔN
  // forward ở đường gọi thật) -> chỉ bật native khi capabilities xác nhận supportsThinking/
  // supportsAdaptiveThinking; `capabilities` HOÀN TOÀN vắng mặt (undefined, không phải {}) nghĩa là
  // caller gọi callClaude() trực tiếp ngoài executionTargets (vd test thuần/legacy) và chưa biết gì
  // về capability model — giữ hành vi cũ (permissive) để không phá tương thích ngược.
  const capsKnown = capabilities && typeof capabilities === 'object';
  const nativeCapable = capsKnown ? !!(capabilities.supportsThinking || capabilities.supportsAdaptiveThinking) : true;
  const useNativeThinking = !!deepThinking && !fast && maxTokens >= 1500 && nativeCapable;
  if (useNativeThinking) {
    body.thinking = { type: 'enabled', budget_tokens: nativeThinkingBudget(maxTokens) };
  } else if (typeof temperature === 'number') {
    body.temperature = temperature;
  }

  const linked = createLinkedAbort(timeoutMs, signal);

  let res;
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body),
      signal: linked.signal
    });
  } catch (networkErr) {
    if (linked.isCancelledByCaller()) throw makeCancelledError();
    const isAbort = networkErr && networkErr.name === 'AbortError';
    const err = new Error(
      isAbort
        ? `Claude phản hồi quá chậm (vượt quá ${Math.round(timeoutMs / 1000)}s), đã hủy để chuyển sang nhà cung cấp khác.`
        : 'Không thể kết nối tới Anthropic API. Vui lòng thử lại sau.'
    );
    err.status = isAbort ? 504 : 503;
    throw err;
  } finally {
    linked.cleanup();
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    let anthropicMessage = '';
    try {
      const parsed = JSON.parse(detail);
      anthropicMessage = (parsed && parsed.error && parsed.error.message) || '';
    } catch (e) { /* body không phải JSON hợp lệ — bỏ qua, dùng detail thô */ }

    // P0 mục 2: KHÔNG nhét anthropicMessage (chi tiết thô từ provider, có thể chứa billing/nội bộ)
    // vào err.message — chỉ giữ ở debugMessage (errorNormalize.js chỉ lộ debugMessage khi
    // NODE_ENV !== 'production'). errorClassifier.js vẫn nhận diện đúng loại lỗi qua err.detail.
    const err = new Error('Anthropic API trả về lỗi (HTTP ' + res.status + ').');
    err.status = res.status === 429 ? 429 : 502;
    err.detail = detail.slice(0, 500);
    if (anthropicMessage) err.debugMessage = anthropicMessage;
    throw err;
  }

  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  return text;
}

/**
 * Bản streaming của callClaude() — gọi Anthropic Messages API với stream:true, phát từng đoạn văn
 * bản (delta) qua callback onDelta ngay khi nhận được (thay vì đợi trả lời xong toàn bộ), dùng cho
 * hiệu ứng "gõ chữ" thời gian thực trên giao diện. Trả về Promise<string> = toàn bộ văn bản khi
 * stream kết thúc (giống hệt giá trị trả về của callClaude, để nơi gọi vẫn lưu lại được y hệt).
 * @param {{system:string, messages:Array, maxTokens?:number, tools?:Array, temperature?:number, fast?:boolean, timeoutMs?:number, onDelta?:Function}} opts
 * @returns {Promise<string>}
 */
async function callClaudeStream({ system, messages, maxTokens = 1000, tools, temperature, fast, deepThinking, capabilities, timeoutMs = DEFAULT_TIMEOUT_MS, onDelta, apiKeyOverride, modelOverride, fastModelOverride, signal }) {
  const key = apiKeyOverride || API_KEY;
  if (!key) {
    const err = new Error('Máy chủ chưa được cấu hình ANTHROPIC_API_KEY. Vui lòng liên hệ quản trị viên.');
    err.status = 500;
    throw err;
  }

  const body = {
    model: assertModel(fast ? (fastModelOverride || MODEL_FAST || MODEL) : (modelOverride || MODEL)),
    max_tokens: maxTokens,
    system,
    messages,
    stream: true
  };
  if (Array.isArray(tools) && tools.length) body.tools = tools;
  const capsKnown = capabilities && typeof capabilities === 'object';
  const nativeCapable = capsKnown ? !!(capabilities.supportsThinking || capabilities.supportsAdaptiveThinking) : true;
  const useNativeThinking = !!deepThinking && !fast && maxTokens >= 1500 && nativeCapable;
  if (useNativeThinking) {
    body.thinking = { type: 'enabled', budget_tokens: nativeThinkingBudget(maxTokens) };
  } else if (typeof temperature === 'number') {
    body.temperature = temperature;
  }

  const linked = createLinkedAbort(timeoutMs, signal);

  let res;
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
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
        ? `Claude phản hồi quá chậm (vượt quá ${Math.round(timeoutMs / 1000)}s), đã hủy để chuyển sang nhà cung cấp khác.`
        : 'Không thể kết nối tới Anthropic API. Vui lòng thử lại sau.'
    );
    err.status = isAbort ? 504 : 503;
    throw err;
  }

  if (!res.ok) {
    linked.cleanup();
    const detail = await res.text().catch(() => '');
    let anthropicMessage = '';
    try {
      const parsed = JSON.parse(detail);
      anthropicMessage = (parsed && parsed.error && parsed.error.message) || '';
    } catch (e) { /* body không phải JSON hợp lệ — bỏ qua, dùng detail thô */ }

    const err = new Error('Anthropic API trả về lỗi (HTTP ' + res.status + ').');
    err.status = res.status === 429 ? 429 : 502;
    err.detail = detail.slice(0, 500);
    if (anthropicMessage) err.debugMessage = anthropicMessage;
    throw err;
  }

  let full = '';
  try {
    for await (const raw of iterateSSELines(res)) {
      if (!raw || raw === '[DONE]') continue;
      let evt;
      try { evt = JSON.parse(raw); } catch (e) { continue; }
      if (evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta') {
        const piece = evt.delta.text || '';
        full += piece;
        if (piece && typeof onDelta === 'function') onDelta(piece);
      }
    }
  } finally {
    linked.cleanup();
  }

  return full.trim();
}

module.exports = { callClaude, callClaudeStream, callClaudeWebSearch, isConfigured };

function isConfigured() {
  return Boolean(API_KEY);
}

/**
 * Gọi Claude với công cụ tìm kiếm web (web_search) BẮT BUỘC bật, dành riêng cho tính năng "Đề xuất
 * ôn tập" (server/routes/recommend.js) — KHÁC với callClaude() ở chỗ: trả về CẢ danh sách kết quả
 * tìm kiếm THẬT (url/title) mà Anthropic đã thực sự truy vấn được (khối "web_search_tool_result"
 * trong response), không chỉ văn bản tổng hợp cuối cùng. Nơi gọi dùng danh sách "results" này để
 * ĐỐI CHIẾU/lọc bỏ mọi URL model tự "chế" ra trong JSON nó trả lời — chỉ URL nào THỰC SỰ nằm trong
 * "results" mới được tin dùng, chặn triệt để rủi ro gợi ý link chết/bịa cho người học.
 * @param {{system:string, messages:Array, maxTokens?:number, timeoutMs?:number}} opts
 * @returns {Promise<{text:string, results:Array<{url:string,title:string}>}>}
 */
async function callClaudeWebSearch({ system, messages, maxTokens = 1200, timeoutMs = 20000, modelOverride }) {
  if (!API_KEY) {
    const err = new Error('Máy chủ chưa được cấu hình ANTHROPIC_API_KEY.');
    err.status = 500;
    throw err;
  }

  const body = {
    model: assertModel(modelOverride || MODEL_FAST || MODEL), // đủ dùng cho tác vụ tìm + tóm tắt link, không cần model mạnh/đắt nhất
    max_tokens: maxTokens,
    system,
    messages,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }]
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (networkErr) {
    const isAbort = networkErr && networkErr.name === 'AbortError';
    const err = new Error(isAbort ? 'Tìm kiếm web quá thời gian chờ.' : 'Không thể kết nối tới Anthropic API.');
    err.status = isAbort ? 504 : 503;
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error('Anthropic API (web search) trả về lỗi HTTP ' + res.status + '.');
    err.status = res.status === 429 ? 429 : 502;
    err.detail = detail.slice(0, 500);
    throw err;
  }

  const data = await res.json();
  const content = data.content || [];
  const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

  // Gom mọi kết quả tìm kiếm THẬT từ tất cả các lượt tool_use mà model đã thực hiện (có thể gọi
  // web_search nhiều lần) — mỗi khối "web_search_tool_result" chứa "content" là mảng kết quả
  // {type:"web_search_result", url, title, ...}; bỏ qua các khối lỗi (content không phải mảng).
  const results = [];
  const seenUrls = new Set();
  for (const block of content) {
    if (block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue;
    for (const r of block.content) {
      if (r && r.type === 'web_search_result' && r.url && !seenUrls.has(r.url)) {
        seenUrls.add(r.url);
        results.push({ url: r.url, title: r.title || r.url });
      }
    }
  }

  return { text, results };
}
