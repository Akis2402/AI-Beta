'use strict';

/* =====================================================================================
   puterAdapter.js — PHẦN A: tích hợp Puter.js làm AI provider bổ sung/fallback.

   LƯU Ý KIẾN TRÚC QUAN TRỌNG (khác các provider hiện có):
   Puter.js (https://js.puter.com/v2/) là SDK CHẠY Ở TRÌNH DUYỆT — `puter.ai.chat()` xác thực
   bằng phiên đăng nhập Puter CỦA NGƯỜI DÙNG (Puter tự mở popup đăng nhập khi cần), KHÔNG dùng
   API key kiểu server-to-server như Anthropic/OpenAI/Gemini hiện có (server/utils/*Client.js).
   Vì vậy Puter KHÔNG THỂ trở thành 1 execution target gọi được từ server (không có khái niệm
   "khoá API server" hợp lệ cho việc này — cố nhét 1 khoá tĩnh vào server sẽ VI PHẠM "Không được
   hard-code Puter API key" trong yêu cầu gốc, vì Puter không phát hành loại khoá đó cho mục đích
   này). Adapter này do đó chạy Ở PHÍA CLIENT, và cắm vào vị trí "Puter" trong sơ đồ Provider
   Router (xem providerRouter.js) như một NHÁNH THỰC THI RIÊNG — không đi qua /api/chat.

   Interface thống nhất (PHẦN C): normalize output về đúng 4 sự kiện mà apiPostStream() (app.js)
   đã dùng với provider hiện có — { onDelta(textChunk), onStatus(msg,state), done, error } — để
   phần còn lại của app (render, resumable buffer, conversationTaskManager...) không cần biết nó
   đang nói chuyện với provider nào.
   ===================================================================================== */

let puterSdkLoadPromise = null;
/** Nạp SDK Puter.js LAZY — chỉ khi thực sự cần dùng (không tải trước, không ảnh hưởng cold-start). */
function ensurePuterSdk() {
  if (window.puter && window.puter.ai) return Promise.resolve(window.puter);
  if (puterSdkLoadPromise) return puterSdkLoadPromise;
  puterSdkLoadPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://js.puter.com/v2/';
    s.async = true;
    s.onload = () => {
      if (window.puter && window.puter.ai) resolve(window.puter);
      else reject(new Error('Puter SDK đã tải nhưng window.puter.ai không tồn tại.'));
    };
    s.onerror = () => reject(new Error('Không tải được Puter SDK (js.puter.com) — kiểm tra kết nối mạng/CSP.'));
    document.head.appendChild(s);
  });
  return puterSdkLoadPromise;
}

/** PHẦN S: capability vision — Puter hỗ trợ ảnh tuỳ model; kiểm tra field trả về khi cần. */
function puterSupportsVision(model) {
  // Model GPT-4o/Claude/Gemini proxy qua Puter thường hỗ trợ vision; danh sách này chỉ là gợi ý
  // AN TOÀN (bảo thủ) — nếu không chắc, providerRouter sẽ ưu tiên provider có vision xác nhận.
  return /gpt-4o|gpt-4\.1|claude|gemini/i.test(model || '');
}

/**
 * Gọi Puter AI chat, chuẩn hoá thành cùng interface với apiPostStream() hiện có.
 * @param {{system:string, messages:Array, model?:string, image?:{mediaType,base64}, signal?:AbortSignal}} req
 * @param {{onDelta:Function, onStatus:Function}} callbacks
 * @returns {Promise<{text:string, provider:'puter', model:string, usage?:object, finishReason:string}>}
 */
async function streamPuter(req, { onDelta, onStatus } = {}) {
  onStatus && onStatus((window.t ? window.t('provider.puterFallback') : 'Đang dùng nhà cung cấp dự phòng (Puter)...'), 'info');
  const puter = await ensurePuterSdk();

  // Puter chưa có phiên đăng nhập -> puter.ai.chat() sẽ tự mở popup xác thực; báo trước cho người
  // dùng biết (PHẦN A: "Không được thay thế mù quáng provider hiện tại" — đây CHỈ là fallback khi
  // được providerRouter chọn, không tự ý chặn luồng chính).
  if (puter.auth && typeof puter.auth.isSignedIn === 'function' && !puter.auth.isSignedIn()) {
    onStatus && onStatus((window.t ? window.t('provider.puterLoginRequired') : 'Cần đăng nhập Puter để dùng nhà cung cấp dự phòng này.'), 'info');
  }

  const model = req.model || 'gpt-4o-mini';
  // Puter's puter.ai.chat(prompt, options) chấp nhận messages dạng OpenAI-style qua options.messages
  // (đã hỗ trợ trong SDK v2) hoặc 1 chuỗi prompt đơn — dùng dạng messages để giữ system + history.
  const puterMessages = [];
  if (req.system) puterMessages.push({ role: 'system', content: req.system });
  (req.messages || []).forEach((m) => puterMessages.push(m));
  if (req.image && req.image.base64) {
    const last = puterMessages[puterMessages.length - 1];
    if (last && last.role === 'user') {
      last.content = [
        { type: 'text', text: typeof last.content === 'string' ? last.content : '' },
        { type: 'image_url', image_url: { url: `data:${req.image.mediaType};base64,${req.image.base64}` } }
      ];
    }
  }

  let full = '';
  const finish = async () => {
    // API stream() trả AsyncIterable các delta; fallback non-stream nếu SDK phiên bản không hỗ trợ.
    try {
      const resp = await puter.ai.chat(puterMessages, { model, stream: true });
      if (resp && typeof resp[Symbol.asyncIterator] === 'function') {
        for await (const part of resp) {
          if (req.signal && req.signal.aborted) throw makePuterCancelledError();
          const chunk = (part && (part.text || (part.message && part.message.content))) || '';
          if (chunk) { full += chunk; onDelta && onDelta(chunk); }
        }
      } else {
        const text = (resp && (resp.text || resp.message && resp.message.content)) || String(resp || '');
        full = text;
        onDelta && onDelta(text);
      }
    } catch (e) {
      if (req.signal && req.signal.aborted) throw makePuterCancelledError();
      throw normalizePuterError(e);
    }
  };
  await finish();
  return { text: full, provider: 'puter', model, usage: null, finishReason: 'stop' };
}

function makePuterCancelledError() {
  const e = new Error('Đã hủy (Puter)');
  e.name = 'AbortError';
  e.cancelled = true;
  return e;
}

/** PHẦN AF: chuẩn hoá lỗi Puter về cùng error code như errorNormalize.js phía server dùng, để UI
 * dịch bằng error.* key sẵn có thay vì hiển thị message thô tiếng Anh của Puter. */
function normalizePuterError(e) {
  const msg = String((e && e.message) || e || '');
  let code = 'error.generic';
  if (/timeout/i.test(msg)) code = 'error.timeout';
  else if (/rate.?limit|429/i.test(msg)) code = 'error.rateLimit';
  else if (/network|fetch/i.test(msg)) code = 'error.network';
  else if (/unavailable|503/i.test(msg)) code = 'error.unavailable';
  else if (/invalid|400/i.test(msg)) code = 'error.invalidRequest';
  const err = new Error(window.t ? window.t(code) : msg);
  err.code = code;
  err.provider = 'puter';
  err.original = e;
  return err;
}

window.puterAdapter = { ensurePuterSdk, streamPuter, puterSupportsVision };
