'use strict';

/* =====================================================================================
   providerRouter.js — PHẦN B: Provider Router.

        Request
         ↓
        Capability Detection
         ↓
        Provider Router
         ├─ Existing Providers (server /api/chat — rotation/failover/streaming đã có sẵn)
         └─ Puter (client-side, xem puterAdapter.js)
         ↓
        Unified Adapter (streamViaProviderRouter trả cùng interface cho cả 2 nhánh)

   QUYẾT ĐỊNH CHỌN PROVIDER (PHẦN B liệt kê: availability/capability/vision/streaming/latency/
   token budget/previous failures/timeout/request type):
   - Mặc định LUÔN thử "Existing Providers" trước (server đã có rotation/failover/token-economy/
     context-compression rất kỹ — Puter KHÔNG thay thế mù quáng, chỉ là lưới an toàn cuối).
   - Chỉ rơi xuống Puter khi: server trả lỗi coi là "toàn bộ rotation đã cạn" (không phải lỗi do
     người dùng bấm Dừng), HOẶC server báo hết mọi execution target khả dụng (ví dụ 503/no-target),
     HOẶC failureStreak của server vượt ngưỡng trong phiên hiện tại (previous failures).
   - Puter KHÔNG dùng cho request có ảnh nếu model Puter không xác nhận vision (PHẦN S) — trong
     trường hợp đó, coi Puter là "không khả dụng" cho request này và báo lỗi rõ thay vì gửi ảnh mù.
   - KHÔNG retry vô hạn (PHẦN B): tối đa 1 lần fallback Puter mỗi request gốc.

   PHẦN AJ/AM/AN — LANGUAGE LOCK: payload đưa vào streamViaProviderRouter() đã được app.js "chốt"
   (đóng băng) tại thời điểm request bắt đầu (requestLanguage/answerLanguage/explanationLanguage
   nằm trong payload.settings, snapshot COPY chứ không phải tham chiếu tới state.settings sống) —
   router CHỈ forward nguyên payload đó sang Puter khi fallback, KHÔNG bao giờ đọc lại state.settings
   hiện tại của UI để "cập nhật" ngôn ngữ giữa chừng.
   ===================================================================================== */

const PROVIDER_ROUTER_FAILURE_WINDOW_MS = 10 * 60 * 1000;
let serverFailureLog = []; // timestamps các lần server-side stream thất bại "toàn cục" gần đây

function recordServerFailure() {
  const now = Date.now();
  serverFailureLog = serverFailureLog.filter((t) => now - t < PROVIDER_ROUTER_FAILURE_WINDOW_MS);
  serverFailureLog.push(now);
}
function recentServerFailureCount() {
  const now = Date.now();
  serverFailureLog = serverFailureLog.filter((t) => now - t < PROVIDER_ROUTER_FAILURE_WINDOW_MS);
  return serverFailureLog.length;
}

/** Lỗi nào coi là "toàn bộ rotation đã cạn" (đáng để thử Puter) vs lỗi cục bộ (đáng báo thẳng,
 * KHÔNG fallback — ví dụ lỗi 400 do request sai thì Puter cũng sẽ sai y hệt). */
function isRotationExhaustedError(err) {
  if (!err) return false;
  if (err.cancelled || err.name === 'AbortError') return false; // người dùng bấm Dừng -> không fallback
  const status = err.status || (err.original && err.original.status);
  if (status === 503 || status === 429) return true;
  const msg = String(err.message || '').toLowerCase();
  return /không có execution target|hết execution target|no.*target.*available|tất cả.*thất bại|all providers failed/i.test(msg);
}

/** Xây system prompt RÚT GỌN dùng khi fallback sang Puter (client không có toàn bộ promptBuilder.js
 * phía server — PHẦN AB: vẫn phải giữ đúng static language rule dù ngắn gọn hơn). */
function buildPuterFallbackSystemPrompt(payload) {
  const settings = payload.settings || {};
  const langDirective = settings.lang === 'English'
    ? 'Answer ENTIRELY in English, including all section headings.'
    : settings.lang === 'tự động theo câu hỏi'
      ? "Detect the user's question language and answer entirely in that same language, including headings."
      : 'Trả lời TOÀN BỘ bằng tiếng Việt, kể cả tiêu đề các mục.';
  return `Bạn là một AI trợ giảng chuyên giải bài tập học thuật (Toán, Lý, Hóa, Sinh...), trình bày khoa học, chính xác, từng bước rõ ràng.
NGÔN NGỮ TRẢ LỜI — BẮT BUỘC: ${langDirective}
Đây là lượt gọi DỰ PHÒNG (Puter) khi hệ thống provider chính đang bận — vẫn phải tuân thủ đầy đủ định dạng: "## Tóm tắt đề bài", "## Hướng giải" hoặc "## Lời giải", "## Kết luận" (dịch đúng ngôn ngữ đã chỉ định ở trên).`;
}

/**
 * Điểm vào DUY NHẤT mà app.js nên gọi thay cho apiPostStream() trực tiếp khi muốn có fallback Puter.
 * Giữ đúng chữ ký callback { onDelta, onStatus } như apiPostStream() hiện có (PHẦN C — Unified Adapter).
 * @param {string} path route server hiện có (vd '/api/chat')
 * @param {object} body payload ĐÃ chốt ngôn ngữ/settings tại thời điểm bắt đầu request (PHẦN AJ)
 * @param {{onDelta:Function, onStatus:Function, signal:AbortSignal, allowPuterFallback?:boolean}} opts
 */
async function streamViaProviderRouter(path, body, opts = {}) {
  const { onDelta, onStatus, signal, allowPuterFallback = true } = opts;
  try {
    return await window.apiPostStream(path, body, { onDelta, onStatus, signal });
  } catch (err) {
    if (err && (err.cancelled || err.name === 'AbortError')) throw err; // Dừng thủ công -> không fallback (PHẦN D)
    recordServerFailure();
    const hasImage = !!(body && body.image);
    const puterOk = allowPuterFallback && isRotationExhaustedError(err) &&
      window.puterAdapter && (!hasImage || window.puterAdapter.puterSupportsVision(body.puterModel));
    if (!puterOk) throw err;

    onStatus && onStatus(window.t ? window.t('provider.puterFallback') : 'Đang chuyển sang nhà cung cấp dự phòng...', 'info');
    const messages = Array.isArray(body.history)
      ? body.history.map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.text || h.content || '' }))
      : [];
    messages.push({ role: 'user', content: body.query || body.message || '' });
    const result = await window.puterAdapter.streamPuter({
      system: buildPuterFallbackSystemPrompt(body),
      messages,
      model: body.puterModel,
      image: body.image,
      signal
    }, { onDelta, onStatus });
    return { text: result.text, provider: 'puter', model: result.model, usage: result.usage, finishReason: result.finishReason };
  }
}

window.streamViaProviderRouter = streamViaProviderRouter;
window.providerRouterDebug = { recentServerFailureCount, isRotationExhaustedError };
