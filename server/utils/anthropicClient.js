'use strict';

const { iterateSSELines } = require('./sseParse');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const API_KEY = process.env.ANTHROPIC_API_KEY;
// LỖI "Anthropic API trả về lỗi (HTTP 400)": model mặc định cũ ('claude-sonnet-4-6') không phải
// một model string hợp lệ cho API key thông thường — Anthropic từ chối ngay ở trường "model" với
// lỗi 400 invalid_request_error, xảy ra ngay từ tin nhắn đầu tiên bất kể chế độ Nhanh/Sâu.
// Model hiện hành (có thể ghi đè bằng biến môi trường ANTHROPIC_MODEL nếu cần):
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
// Model "nhanh" — dùng riêng cho chế độ Nhanh (tham số fast:true) để giảm độ trễ phản hồi.
// claude-haiku-4-5 nhanh và rẻ hơn đáng kể so với sonnet, phù hợp cho câu trả lời tức thời.
const MODEL_FAST = process.env.ANTHROPIC_MODEL_FAST || 'claude-haiku-4-5-20251001';
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
 * @param {{system:string, messages:Array, maxTokens?:number, tools?:Array, temperature?:number, fast?:boolean, timeoutMs?:number}} opts
 * @returns {Promise<string>} nội dung text trả lời (đã gộp mọi khối "text", bỏ qua khối tool_use/tool_result)
 */
async function callClaude({ system, messages, maxTokens = 1000, tools, temperature, fast, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!API_KEY) {
    const err = new Error('Máy chủ chưa được cấu hình ANTHROPIC_API_KEY. Vui lòng liên hệ quản trị viên.');
    err.status = 500;
    throw err;
  }

  const body = {
    model: fast ? MODEL_FAST : MODEL,
    max_tokens: maxTokens,
    system,
    messages
  };
  if (Array.isArray(tools) && tools.length) body.tools = tools;
  if (typeof temperature === 'number') body.temperature = temperature;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (networkErr) {
    const isAbort = networkErr && networkErr.name === 'AbortError';
    const err = new Error(
      isAbort
        ? `Claude phản hồi quá chậm (vượt quá ${Math.round(timeoutMs / 1000)}s), đã hủy để chuyển sang nhà cung cấp khác.`
        : 'Không thể kết nối tới Anthropic API. Vui lòng thử lại sau.'
    );
    err.status = isAbort ? 504 : 503;
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    let anthropicMessage = '';
    try {
      const parsed = JSON.parse(detail);
      anthropicMessage = (parsed && parsed.error && parsed.error.message) || '';
    } catch (e) { /* body không phải JSON hợp lệ — bỏ qua, dùng detail thô */ }

    const err = new Error(
      'Anthropic API trả về lỗi (HTTP ' + res.status + ').' +
      (anthropicMessage ? ' Chi tiết: ' + anthropicMessage : '')
    );
    err.status = res.status === 429 ? 429 : 502;
    err.detail = detail.slice(0, 500);
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
async function callClaudeStream({ system, messages, maxTokens = 1000, tools, temperature, fast, timeoutMs = DEFAULT_TIMEOUT_MS, onDelta }) {
  if (!API_KEY) {
    const err = new Error('Máy chủ chưa được cấu hình ANTHROPIC_API_KEY. Vui lòng liên hệ quản trị viên.');
    err.status = 500;
    throw err;
  }

  const body = {
    model: fast ? MODEL_FAST : MODEL,
    max_tokens: maxTokens,
    system,
    messages,
    stream: true
  };
  if (Array.isArray(tools) && tools.length) body.tools = tools;
  if (typeof temperature === 'number') body.temperature = temperature;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (networkErr) {
    clearTimeout(timer);
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
    clearTimeout(timer);
    const detail = await res.text().catch(() => '');
    let anthropicMessage = '';
    try {
      const parsed = JSON.parse(detail);
      anthropicMessage = (parsed && parsed.error && parsed.error.message) || '';
    } catch (e) { /* body không phải JSON hợp lệ — bỏ qua, dùng detail thô */ }

    const err = new Error(
      'Anthropic API trả về lỗi (HTTP ' + res.status + ').' +
      (anthropicMessage ? ' Chi tiết: ' + anthropicMessage : '')
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
      if (evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta') {
        const piece = evt.delta.text || '';
        full += piece;
        if (piece && typeof onDelta === 'function') onDelta(piece);
      }
    }
  } finally {
    clearTimeout(timer);
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
async function callClaudeWebSearch({ system, messages, maxTokens = 1200, timeoutMs = 20000 }) {
  if (!API_KEY) {
    const err = new Error('Máy chủ chưa được cấu hình ANTHROPIC_API_KEY.');
    err.status = 500;
    throw err;
  }

  const body = {
    model: MODEL_FAST, // đủ dùng cho tác vụ tìm + tóm tắt link, không cần model mạnh/đắt nhất
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
