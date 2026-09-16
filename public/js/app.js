'use strict';

// FIX ROOT CAUSE (Cannot access 'el' before initialization): `el` PHẢI được khai báo TRƯỚC bất kỳ
// chỗ nào gọi el() trong file — kể cả các lệnh chạy ngay ở top-level (không nằm trong function).
// Trước đây `const el = ...` nằm ở dòng ~54 nhưng `el('stopBtn').addEventListener(...)` ở top-level
// lại chạy sớm hơn (dòng ~47) => rơi vào Temporal Dead Zone của `el` => ReferenceError => TOÀN BỘ
// app.js dừng thực thi ngay tại đó, không nút nào được gắn sự kiện nữa (trang "trông có vẻ load"
// nhưng không bấm được gì). Khai báo `el` làm dòng đầu tiên sau 'use strict' để loại bỏ hoàn toàn
// khả năng này, bất kể thứ tự các đoạn code khác bên dưới có thay đổi ra sao trong tương lai.
const el = (id) => document.getElementById(id);

/* ================= Motion: scroll khung chat có "nhận thức" vị trí người dùng =================
   TRƯỚC ĐÂY mọi lần có nội dung mới (kể cả từng mẩu nhỏ lúc AI streaming) đều ép threadEl nhảy
   thẳng xuống cuối — nếu người dùng đang cuộn lên đọc lại tin nhắn cũ trong lúc AI (của 1 cuộc hội
   thoại nền khác, hoặc chỉ đang đọc lại) vẫn tiếp tục sinh chữ, màn hình bị giật xuống liên tục.
   Giờ: chỉ auto-scroll khi người dùng ĐANG THỰC SỰ ở gần đáy (near-bottom), trừ khi force=true
   (hành động chủ động của chính người dùng, ví dụ vừa bấm gửi câu hỏi). */
function isThreadNearBottom(threshold = 120) {
  const t = threadElRef();
  if (!t) return true;
  return (t.scrollHeight - t.scrollTop - t.clientHeight) < threshold;
}
function scrollThreadToBottom(force) {
  const t = threadElRef();
  if (!t) return;
  if (force || isThreadNearBottom()) t.scrollTop = t.scrollHeight;
}
// threadEl (biến toàn cục bên dưới) được khai báo sau điểm này trong file gốc — dùng hàm tra cứu
// lười (lazy) để tránh lỗi "used before defined" khi đây là hàm được gọi về sau, không phải khi định nghĩa.
function threadElRef() { return typeof threadEl !== 'undefined' ? threadEl : el('thread'); }
// PHẦN W (an toàn khi nạp lỗi): app.js gọi t(...) ở rất nhiều chỗ. i18n.js được nạp TRƯỚC app.js
// trong index.html nên window.t luôn có sẵn ở đường chạy bình thường — nhưng nếu vì lý do nào đó
// i18n.js tải lỗi (mạng/CSP/content-blocker), mọi lần gọi t() sẽ ném ReferenceError và làm chết
// toàn bộ app. Shim này chỉ nhảy vào khi window.t THỰC SỰ vắng mặt, trả về chính key để giao diện
// vẫn dùng được (xuống cấp mềm) thay vì trắng màn hình.
if (typeof window.t !== 'function') {
  window.t = function tFallback(key, vars) {
    const dict = (window.TRANSLATIONS && (window.TRANSLATIONS.vi || {})) || {};
    let s = dict[key] != null ? dict[key] : key;
    if (vars) Object.keys(vars).forEach((k) => { s = String(s).replace(new RegExp('\\{\\{' + k + '\\}\\}', 'g'), String(vars[k])); });
    return s;
  };
}
const t = window.t;

// FIX ROOT CAUSE (desktop hoạt động sai trong khi mobile bình thường): dòng này TRƯỚC ĐÂY chạy
// KHÔNG có guard, ngay đầu file — nếu pdf.js CDN tải chậm/bị chặn (ad-block, tường lửa mạng
// công ty/trường học, antivirus web-filter... phổ biến trên desktop hơn di động dùng mạng 4G/5G),
// `pdfjsLib` sẽ là `undefined` và dòng này ném ReferenceError NGAY LẬP TỨC, làm dừng thực thi
// TOÀN BỘ app.js phía sau (mọi định nghĩa hàm, mọi addEventListener gắn nút bấm...) — kết quả:
// HTML/CSS vẫn hiển thị bình thường (nên "trông giống app") nhưng KHÔNG nút nào phản hồi. Đã đưa
// vào guard: nếu pdf.js chưa sẵn sàng, bỏ qua dòng này — parsePDF() bên dưới sẽ tự phát hiện
// `pdfjsLib` thiếu và báo lỗi rõ ràng riêng cho tính năng đọc PDF, không còn làm chết cả ứng dụng.
// FIX ROOT CAUSE (CDN là điểm lỗi trên iPhone/Safari): pdf.worker giờ tự host cùng-origin tại
// /vendor/pdfjs/pdf.worker.min.js (xem index.html + comment giải thích chi tiết ở đó) thay vì tải
// từ cdnjs.cloudflare.com — loại bỏ luôn rủi ro worker bị content-blocker/CSP/mạng chặn riêng dù
// pdf.min.js chính đã tải được.
// FIX ROOT CAUSE (PHẦN VII audit): pdf.min.js giờ KHÔNG còn nạp eager trong index.html (lazy-load
// on-demand — xem ensurePdfJs() bên dưới), nên workerSrc phải gán NGAY SAU khi pdf.min.js tải xong
// (ensurePdfJs), không còn gán 1 lần duy nhất ở đây lúc đầu file.
async function ensurePdfJs() {
  if (window.pdfjsLib && pdfjsLib.GlobalWorkerOptions) return;
  await window.__loadVendorScript('/vendor/pdfjs/pdf.min.js');
  if (window.pdfjsLib && pdfjsLib.GlobalWorkerOptions) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';
  }
}
async function ensureMammoth() {
  if (window.mammoth) return;
  await window.__loadVendorScript('/vendor/mammoth/mammoth.browser.min.js');
}
async function ensureThree() {
  if (window.THREE) return;
  await window.__loadVendorScript('/vendor/three/three.min.js');
}
async function ensureDocx() {
  if (window.docx) return;
  await window.__loadVendorScript('/vendor/docx/index.umd.js');
}

const state = {
  docs: [],              // {id, name, ext, status:'loading'|'ready'|'error', processing:{...}, chunks:[{id,text,garbled}]} — mọi nguồn đã tải lên đều tự động được dùng khi trả lời, không cần bật/tắt thủ công
  // ROOT CAUSE FIX (PHẦN A/B): TRƯỚC ĐÂY chỉ theo dõi `docParsePromises` (parse/rasterize) còn
  // vision extraction được bắn kiểu fire-and-forget `processPdfVisionEvidence(doc).catch(...)` —
  // nên doc bị coi là 'ready' ngay khi RENDER xong ảnh, trong khi AI CHƯA ĐỌC trang nào. NAY: mỗi
  // source có ĐÚNG 1 promise bao trọn parse -> rasterize -> vision extract -> verify, và
  // waitForAllSourceProcessing() vẫn theo dõi trọn vòng đời đó, nhưng KHÔNG còn là hàng rào bắt buộc
  // trước MỌI request (PHẦN II.B/IV kiến trúc mới — progressive ingestion): sendMessage() và các flow
  // tương tự nay dùng collectAvailableEvidence()/isSourceUsableNow() để lấy evidence THẬT đang có
  // ngay, trong khi mảng này chỉ còn phục vụ nơi cần đợi full coverage thật sự (không phải mọi câu hỏi).
  sourceProcessingPromises: [],
  rules: [],
  // Ghi chú KHÔNG lưu ở mảng riêng nữa — mỗi ghi chú gắn trực tiếp vào tin nhắn AI tương ứng
  // (msg.userNote / msg.userNoteAt trong conversations bên dưới), nhờ vậy luôn đồng bộ 1-1 với
  // đúng câu trả lời và tự động được lưu/khôi phục cùng cuộc trò chuyện, không cần đồng bộ 2 nơi.
  conversations: [],       // {id, title, createdAt, updatedAt, messages:[...]}
  currentConvId: null,
  history: [],             // {role, content:string} — ngữ cảnh gửi API cho cuộc trò chuyện hiện tại
  pendingImage: null,      // {seq, file, previewUrl(blob:), mediaType, base64, imageId, status:'loading'|'ready'|'error'}
  deepThinking: false,     // "Suy nghĩ sâu" — AI tự phản biện/kiểm tra lại trong khối <thinking> nội bộ
  crossCheck: false,       // "Đối chiếu đa hướng" — giải 2 hướng độc lập rồi tổng hợp (chỉ áp dụng ở bước giải chi tiết)
  formulaSubject: 'toan',
  // PHẦN 27: `visual` = chế độ hình minh hoạ ('auto' | 'always' | 'never'). Mặc định 'auto'.
  settings: { detail: 'tiêu chuẩn', lang: 'Tiếng Việt', school: 'thpt', grade: '10', subject: 'auto', visual: 'auto' },
  historyFilterSubject: 'all',
  // Thư viện flashcard đã lưu — {id, topic, cards:[{q,a}], createdAt}. Bộ thẻ VỪA tạo (chưa đóng
  // khung/quay lại danh sách) được giữ tạm ở activeFlashcardSet, chỉ chuyển vào flashcardSets (và
  // lưu localStorage) khi người dùng đóng khung hoặc bấm "quay lại danh sách" — xem
  // commitActiveFlashcardSet().
  flashcardSets: [],
  activeFlashcardSet: null,
  flashcardLibraryPage: 0
};
// Expose cho devtools/console và cho test harness (vm sandbox không thấy được top-level const nếu
// không gắn vào global) — không đổi hành vi runtime, chỉ thêm 1 tham chiếu debug.
window.state = state;

let pendingTurn = null; // lượt hỏi đang chờ (đã có "Hướng giải", chưa bấm "Xem chi tiết")
// PHẦN E/F/G (thay thế "chatAbortController" toàn cục cũ — đúng anti-pattern mà PHẦN F liệt kê):
// trạng thái generating/AbortController giờ SỐNG TRONG conversationTaskManager, tra theo
// conversationId — KHÔNG còn 1 biến duy nhất khoá toàn app. setChatStreaming() chỉ còn nhiệm vụ
// UI THUẦN TÚY: cập nhật nút Gửi/Dừng CHO ĐÚNG conversation đang được xem — nếu task hoàn thành ở
// 1 conversation khác (đang chạy nền), KHÔNG được đụng vào nút của conversation đang hiển thị
// (NGUYÊN TẮC TỐI CAO #1: "UI lifecycle KHÔNG quyết định AI lifecycle").
function setChatStreaming(isStreaming, conversationId) {
  // Nếu có truyền conversationId và nó KHÁC conversation đang mở trên màn hình -> đây là 1 task nền,
  // không đụng gì tới nút bấm hiện tại (chỉ cập nhật khi đúng là conv đang xem, hoặc gọi không kèm id).
  if (conversationId != null && (!currentConversation() || currentConversation().id !== conversationId)) return;
  if (el('sendBtn')) el('sendBtn').style.display = isStreaming ? 'none' : '';
  if (el('stopBtn')) el('stopBtn').style.display = isStreaming ? '' : 'none';
}
/** Gọi mỗi khi đổi conversation đang xem (loadConversation/startNewConversation) — đồng bộ lại nút
 * Gửi/Dừng theo ĐÚNG trạng thái generating của conversation VỪA MỞ (PHẦN F: trạng thái sinh câu trả
 * lời độc lập theo từng conversation, không phải 1 cờ isGenerating dùng chung). */
function syncSendButtonForActiveConversation() {
  const conv = currentConversation();
  const generating = !!conv && window.conversationTaskManager && window.conversationTaskManager.isGenerating(conv.id);
  if (el('sendBtn')) { el('sendBtn').style.display = generating ? 'none' : ''; el('sendBtn').disabled = false; }
  if (el('stopBtn')) el('stopBtn').style.display = generating ? '' : 'none';
  if (statusEl) statusEl.textContent = generating ? (window.t ? window.t('chat.generating').toUpperCase() : 'ĐANG TẠO...') : 'SẴN SÀNG';
}
// FIX (event listener safety, mục 8): guard null trước khi bind — nếu vì lý do gì đó #stopBtn
// không tồn tại trong DOM (HTML đổi id, load lỗi một phần...), KHÔNG được ném TypeError làm dừng
// toàn bộ phần script còn lại phía dưới.
if (el('stopBtn')) {
  el('stopBtn').addEventListener('click', () => {
    // PHẦN D: Dừng CHỈ abort task của conversation ĐANG XEM — không đụng các conversation khác
    // đang chạy nền (đây chính là điểm khác biệt cốt lõi với "chuyển chat = abort" bị cấm).
    const conv = currentConversation();
    if (conv && window.conversationTaskManager) window.conversationTaskManager.abortActiveTask(conv.id);
  });
}
function isCancelledError(e) {
  return !!(e && (e.name === 'AbortError' || e.cancelled));
}

const threadEl = el('thread');
const statusEl = el('statusText');

/* ================= Gọi backend (KHÔNG bao giờ gọi Anthropic trực tiếp từ trình duyệt) ================= */
function apiHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (window.APP_CONFIG && window.APP_CONFIG.appKey) headers['x-app-key'] = window.APP_CONFIG.appKey;
  return headers;
}
/**
 * PHẦN A2/A4 — KIỂM TRA KÍCH THƯỚC THẬT TRƯỚC KHI GỬI.
 * Đo bằng JSON.stringify + TextEncoder (đúng thứ nền tảng đếm), giảm tải theo ưu tiên nếu vượt, và
 * KHÔNG BAO GIỜ gửi đi một request chắc chắn bị 413 — thà báo lỗi rõ ràng để người dùng thu hẹp
 * phạm vi còn hơn để họ chờ rồi nhận lỗi vô nghĩa.
 * @returns {{body:object, dropped:object}}
 */
function enforceRequestBudget(body) {
  const PB = window.PayloadBudget;
  if (!PB) return { body, dropped: null };
  const result = PB.reduceBodyToBudget(body);
  if (!result.ok) {
    const err = new Error(t('error.payloadTooLarge'));
    err.code = 'PAYLOAD_TOO_LARGE';
    err.status = 413;
    err.clientPrevented = true;
    err.actualSize = result.bytes;
    err.safeLimit = result.limit;
    throw err;
  }
  const dropped = result.dropped;
  if (dropped && (dropped.sourceImages || dropped.history || dropped.contexts)) {
    console.warn('[payload] đã giảm tải để vừa ngân sách', dropped);
  }
  return { body: result.body, dropped };
}

async function apiPost(path, body, { signal } = {}) {
  const prepared = enforceRequestBudget(body);
  body = prepared.body;
  const res = await fetch(path, { method: 'POST', headers: apiHeaders(), body: JSON.stringify(body), signal });
  let data;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) {
    // PHẦN AG: ưu tiên DỊCH theo `code` ổn định do backend trả về (errorNormalize.js) thay vì dùng
    // nguyên câu chữ tiếng Việt của server — nhờ đó thông báo lỗi đổi theo Settings > Language.
    let msg = (data && data.code && window.tError)
      ? window.tError(data.code, data && data.error)
      : ((data && data.error) || t('error.generic'));
    // Khi TẤT CẢ nhà cung cấp AI đều lỗi, server trả kèm providerErrors (tên provider + lý do lỗi
    // cụ thể của từng nơi, vd "API key sai", "model không hợp lệ", "hết hạn mức"...) — nối luôn vào
    // thông báo để tự chẩn đoán ngay trên giao diện mà không cần vào xem log server. Phần này CỐ Ý
    // giữ nguyên văn từ provider (chẩn đoán kỹ thuật, không phải câu hiển thị cho người học).
    if (data && Array.isArray(data.providerErrors) && data.providerErrors.length) {
      msg += '\n' + data.providerErrors.map((p) => `• ${p.label}: ${p.error}`).join('\n');
    }
    const err = new Error(msg);
    err.status = res.status;
    if (data && data.code) err.code = data.code;
    if (data && typeof data.retryable === 'boolean') err.retryable = data.retryable;
    throw err;
  }
  return data;
}

/**
 * Gửi request streaming (SSE) tới backend — dùng cho hiệu ứng "gõ chữ" thời gian thực thay vì đợi
 * AI trả lời xong toàn bộ rồi mới hiển thị. callbacks:
 *   onDelta(text)   — gọi mỗi khi có 1 đoạn văn bản mới từ AI
 *   onStatus(msg)   — gọi khi server báo tiến trình (vd đang đối chiếu đa hướng ở chế độ Sâu, lúc
 *                     này chưa có delta nào để hiển thị)
 * `signal` (tùy chọn, mục 4): AbortSignal từ nút "Dừng" — khi abort, fetch() bị hủy NGAY, trình
 * duyệt tự đóng kết nối SSE (server phát hiện qua `req.on('close')` trong chat.js và dừng pipeline
 * phía server tương ứng, không tốn thêm lệnh gọi AI/continuation nào).
 * Trả về Promise<object> = metadata cuối cùng từ sự kiện "done" (text đầy đủ, provider, crossChecked...).
 * Nếu trình duyệt không hỗ trợ ReadableStream (rất hiếm), hoặc server trả lỗi trước khi kịp mở
 * stream, tự động rơi về apiPost() thường (không streaming) để vẫn hoạt động được.
 */
async function apiPostStream(path, body, { onDelta, onStatus, signal } = {}) {
  if (!window.ReadableStream || !window.TextDecoder) {
    const data = await apiPost(path, body, { signal });
    if (data && data.text && typeof onDelta === 'function') onDelta(data.text);
    return data;
  }

  const preparedStream = enforceRequestBudget({ ...body, stream: true });
  const res = await fetch(path, { method: 'POST', headers: apiHeaders(), body: JSON.stringify(preparedStream.body), signal });
  if (!res.ok || !res.body) {
    // Server từ chối trước khi mở stream (lỗi validate, thiếu API key...) — đọc lỗi JSON thường.
    let data;
    try { data = await res.json(); } catch (e) { data = null; }
    let msg = (data && data.code && window.tError)
      ? window.tError(data.code, data && data.error)
      : ((data && data.error) || t('error.generic'));
    if (data && Array.isArray(data.providerErrors) && data.providerErrors.length) {
      msg += '\n' + data.providerErrors.map((p) => `• ${p.label}: ${p.error}`).join('\n');
    }
    const err = new Error(msg);
    err.status = res.status;
    if (data && data.code) err.code = data.code;
    if (data && typeof data.retryable === 'boolean') err.retryable = data.retryable;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let currentEvent = 'message';
  let doneData = null;
  let errorMsg = null;
  let errorState = null;
  let errorCode = null;
  let lastKnownState = 'IDLE';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (line === '') { currentEvent = 'message'; continue; }
      if (line.startsWith('event:')) { currentEvent = line.slice(6).trim(); continue; }
      if (!line.startsWith('data:')) continue;
      let payload;
      try { payload = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
      if (payload && payload.state) lastKnownState = payload.state;
      if (currentEvent === 'delta' && typeof onDelta === 'function') onDelta(payload.text || '');
      // Mục 17: server có thể gửi status với state GENERATING hoặc RECOVERING — RECOVERING nghĩa là
      // câu trả lời vừa rồi chưa đầy đủ và server đang thử khôi phục, KHÔNG PHẢI là đã xong. UI chỉ
      // được coi 1 lượt là hoàn tất khi nhận đúng sự kiện "done" (xử lý bên dưới) — không được suy ra
      // completion chỉ từ việc có status/delta.
      else if (currentEvent === 'status' && typeof onStatus === 'function') onStatus(payload.message || '', payload.state || 'GENERATING');
      // Server gửi "done" cho CẢ 2 trạng thái giao được: COMPLETED (đủ) và PARTIAL (chưa đủ nhưng
      // phần đã sinh vẫn dùng được — xem runtimeState.classifyFinalOutcome). PARTIAL vẫn được lưu và
      // hiển thị, kèm cảnh báo rõ ràng; TRƯỚC ĐÂY trường hợp này bị server trả về sự kiện "error" và
      // client XOÁ SẠCH toàn bộ phần đã stream (có thể là 90% một lời giải dài đúng) — hành vi tệ
      // nhất có thể, và chính là thứ người dùng nhìn thấy khi câu trả lời dài bị ngắt giữa chừng.
      else if (currentEvent === 'done') doneData = payload;
      // ---------- PHẦN 21: kênh SỰ KIỆN RIÊNG cho hình minh hoạ ----------
      // Server gửi "done" NGAY khi text xong (kèm visualPending), rồi mới gửi visual:ready/error.
      // Vì vậy vòng đọc vẫn tiếp tục sau "done" và ta gộp hình vào doneData trước khi trả về.
      // Ảnh lỗi TUYỆT ĐỐI không được biến câu trả lời thành lỗi (PHẦN 20/32).
      else if (currentEvent === 'visual:pending') { if (typeof onStatus === 'function') onStatus(t('chat.visualPending'), lastKnownState); }
      else if (currentEvent === 'visual:ready') {
        if (!doneData) doneData = {};
        if (!Array.isArray(doneData.visuals)) doneData.visuals = [];
        doneData.visuals.push(payload);
        doneData.visualStatus = 'ready';
      }
      else if (currentEvent === 'visual:error') { if (doneData) { doneData.visualStatus = 'failed'; doneData.visualError = payload.reason || null; } }
      // PHẦN AF/AG: sự kiện error qua SSE cũng mang `code` ổn định — ưu tiên dịch theo code, chỉ
      // dùng payload.message làm phương án cuối (code lạ/backend cũ chưa gửi code).
      else if (currentEvent === 'error') {
        errorMsg = (payload.code && window.tError) ? window.tError(payload.code, payload.message) : (payload.message || t('error.generic'));
        errorState = payload.state || 'FAILED';
        errorCode = payload.code || null;
      }
    }
  }

  // Mục 17: nếu server đóng kết nối TRƯỚC KHI gửi "done" (mất mạng, timeout, server crash giữa
  // chừng...) — dù đã stream được bao nhiêu delta, KHÔNG được coi phần đã nhận là câu trả lời cuối
  // cùng. Némlỗi thay vì âm thầm dùng preview.getText() làm kết quả, để nơi gọi (sendMessage/
  // fetchDetail) không lưu nhầm 1 câu trả lời dang dở vào lịch sử hội thoại.
  if (errorMsg) { const err = new Error(errorMsg); err.state = errorState; if (errorCode) err.code = errorCode; throw err; }
  if (!doneData) {
    const err = new Error(t('error.streamInterrupted'));
    err.state = lastKnownState === 'IDLE' ? 'FAILED' : lastKnownState;
    throw err;
  }
  return doneData;
}

/* ================= Icons (SVG) ================= */
const ICONS = {
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="6.34" y2="6.34"/><line x1="17.66" y1="17.66" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="6.34" y2="17.66"/><line x1="17.66" y1="6.34" x2="19.07" y2="4.93"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  microphone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>',
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
  zap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  sparkles: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/></svg>',
  cards: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
  note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="12" y2="17"/></svg>',
  compass: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>',
  outline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="13" y2="16"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>',
  mindmap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2.6"/><circle cx="4" cy="5" r="2"/><circle cx="4" cy="19" r="2"/><circle cx="20" cy="6.5" r="2"/><circle cx="20" cy="17.5" r="2"/><path d="M9.9 10.7 5.6 6.2M9.9 13.3l-4.3 4.5M14.1 10.7l3.9-3.6M14.1 13.3l3.9 3.6"/></svg>',
  zoomIn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>',
  zoomOut: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>',
  expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  fit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/><rect x="8.5" y="8.5" width="7" height="7" rx="1"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
  brain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3.5 3.5 0 0 0 1 6.5V19a3 3 0 0 0 3 3h1a1 1 0 0 0 1-1V4a2 2 0 0 0-1-2z"/><path d="M14.5 2a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3.5 3.5 0 0 1-1 6.5V19a3 3 0 0 1-3 3h-1a1 1 0 0 1-1-1V4a2 2 0 0 1 1-2z"/></svg>',
  paperclip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  ruler: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 2l6 6-14 14-6-6z"/><path d="M14.5 3.5l2 2M11 7l2 2M7.5 10.5l2 2M4 14l2 2"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
  save: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>',
  warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
};
// FIX (event/DOM safety, mục 8): mọi gán innerHTML top-level đều guard null — 1 id thiếu trong
// DOM không còn làm TypeError chặn phần script phía sau (state, event listeners chính...) chạy tiếp.
if (el('menuBtn')) el('menuBtn').innerHTML = ICONS.menu;
if (el('settingsBtnTop')) el('settingsBtnTop').innerHTML = ICONS.settings;
if (el('flashcardTopBtn')) el('flashcardTopBtn').innerHTML = ICONS.cards;
if (el('recommendTopBtn')) el('recommendTopBtn').innerHTML = ICONS.outline;
if (el('attachBtn')) el('attachBtn').innerHTML = ICONS.camera;
if (el('micBtn')) el('micBtn').innerHTML = ICONS.microphone;
if (el('settingsGearIcon')) el('settingsGearIcon').innerHTML = ICONS.settings;
document.querySelectorAll('.think-opt .ic').forEach((s) => { s.innerHTML = ICONS[s.dataset.icon]; });
// PREMIUM PASS: nạp icon SVG cho các chỗ trước đây dùng emoji làm icon chính (mục 5/18/29 brief nâng cấp UI) —
// chỉ thay icon thuần trang trí, KHÔNG đụng emoji nào tham gia parse nội dung AI (vd 🌐 trong extractWebSourceNote).
['icSources', 'icHistory', 'icNotes', 'icFormulas'].forEach((id, i) => {
  const map = [ICONS.paperclip, ICONS.clock, ICONS.note, ICONS.ruler];
  if (el(id)) el(id).innerHTML = map[i];
});
if (el('icSettingsModal')) el('icSettingsModal').innerHTML = ICONS.settings;
if (el('icNoteModal')) el('icNoteModal').innerHTML = ICONS.note;
if (el('icPracticeModal')) el('icPracticeModal').innerHTML = ICONS.note;
if (el('icRecommend')) el('icRecommend').innerHTML = ICONS.book;
if (el('icFlashcardPanel')) el('icFlashcardPanel').innerHTML = ICONS.cards;
if (el('icSave')) el('icSave').innerHTML = ICONS.save;
if (el('icSun')) el('icSun').innerHTML = ICONS.sun;
if (el('icMoon')) el('icMoon').innerHTML = ICONS.moon;
if (el('icDrop')) el('icDrop').innerHTML = ICONS.paperclip;
if (el('icAddSourceModal')) el('icAddSourceModal').innerHTML = ICONS.paperclip;
if (el('icAddSourceDrop')) el('icAddSourceDrop').innerHTML = ICONS.paperclip;

/* ================= Lưu trữ cục bộ (localStorage — trang web độc lập, không dùng window.storage) ================= */
const LS_KEYS = {
  rules: 'tro-giai:rules', theme: 'tro-giai:theme', think: 'tro-giai:think-mode',
  deepThinking: 'tro-giai:deep-thinking', crossCheck: 'tro-giai:cross-check', settings: 'tro-giai:settings',
  notes: 'tro-giai:notes', conversations: 'tro-giai:conversations', currentConv: 'tro-giai:current-conv',
  flashcardSets: 'tro-giai:flashcard-sets', docs: 'tro-giai:docs'
};
const MAX_STORED_CONVERSATIONS = 40;
const MAX_STORED_FLASHCARD_SETS = 40;
const FLASHCARD_SETS_PER_PAGE = 6;
function lsGet(key, fallback) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch (e) { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* localStorage có thể bị chặn/đầy — bỏ qua an toàn */ }
}
function loadAll() {
  state.rules = lsGet(LS_KEYS.rules, []);
  renderRules();
  applyTheme(lsGet(LS_KEYS.theme, 'light'));
  // Di chuyển dữ liệu cũ: trước đây chỉ có 1 chế độ "fast"/"deep" gộp chung — nếu người dùng đã
  // từng bật "deep" ở phiên bản cũ và chưa có lựa chọn mới nào được lưu, coi như bật cả 2 công tắc
  // (giữ đúng hành vi cũ họ đã quen) thay vì âm thầm reset về tắt hết.
  const legacyDeep = lsGet(LS_KEYS.think, 'fast') === 'deep';
  state.deepThinking = lsGet(LS_KEYS.deepThinking, legacyDeep);
  state.crossCheck = lsGet(LS_KEYS.crossCheck, legacyDeep);
  applyThinkModes();
  state.settings = Object.assign(state.settings, lsGet(LS_KEYS.settings, {}));
  applySubjectUI();
  // Mục 1 — migration: localStorage cũ có thể còn giá trị 'rất chi tiết' (đã bị loại khỏi UI/server).
  // Migrate ngay khi load để applySettingsUI() không cố highlight 1 chip không còn tồn tại, và mọi
  // request sau đó gửi đúng giá trị hợp lệ (server validators.js vẫn tự migrate lần nữa cho chắc).
  if (!['auto', 'always', 'never'].includes(state.settings.visual)) state.settings.visual = 'auto';
  if (state.settings.detail !== 'ngắn gọn' && state.settings.detail !== 'tiêu chuẩn') {
    state.settings.detail = 'tiêu chuẩn';
    lsSet(LS_KEYS.settings, state.settings);
  }
  applySettingsUI();
  state.conversations = lsGet(LS_KEYS.conversations, []);
  // FIX (buổi học ma): startNewConversation() từng lưu ngay hội thoại RỖNG (0 tin nhắn) vào
  // localStorage mỗi lần app khởi động không khớp savedCurrentId, hoặc mỗi lần bấm "Buổi học mới"
  // mà không gõ gì — tích tụ hàng chục thẻ trùng tên "Buổi học mới" lấp đầy Lịch sử, đẩy hội thoại
  // thật ra ngoài (trần MAX_STORED_CONVERSATIONS). Dọn 1 lần các hội thoại rỗng còn sót lại từ lỗi cũ.
  const emptyConvCount = state.conversations.filter((c) => !c.messages || c.messages.length === 0).length;
  if (emptyConvCount) {
    state.conversations = state.conversations.filter((c) => c.messages && c.messages.length > 0);
    lsSet(LS_KEYS.conversations, state.conversations);
  }
  // Di chuyển dữ liệu cũ: gán id ổn định cho các tin nhắn AI chưa có (cần id này để liên kết
  // ghi chú -> đúng câu trả lời và cuộn tới đúng vị trí khi bấm vào ghi chú đã lưu).
  state.conversations.forEach((conv) => {
    (conv.messages || []).forEach((m) => { if (m.role === 'ai' && !m.id) m.id = uid(); });
    // Mục 14.20 (migration): hội thoại cũ lưu trước khi có dominantSubjectId -> tính bù ngay lúc nạp.
    if (!conv.dominantSubjectId) conv.dominantSubjectId = computeDominantSubject(conv);
  });
  renderNotesList();
  renderFormulaSubjectTabs();
  renderFormulaList();
  state.flashcardSets = lsGet(LS_KEYS.flashcardSets, []);

  // Khôi phục các nguồn (file PDF/DOCX/TXT) đã tải lên trước đó từ IndexedDB (mục 13). Nếu
  // đây là lần đầu chạy sau khi nâng cấp, migrateFromLegacyIfNeeded() sẽ tự chuyển dữ liệu cũ
  // từng lưu ở localStorage['tro-giai:docs'] sang IndexedDB (1 lần duy nhất, an toàn nếu lỗi
  // giữa chừng). state.docs bắt đầu rỗng và được điền khi Promise resolve — không chặn phần
  // còn lại của loadAll() (đúng tinh thần "async, không chặn UI" nhưng vẫn hiển thị lại được).
  state.docs = [];
  // PHẦN B: "Nguồn gần đây" (tối đa 3) — nguồn active và nguồn gần đây được lưu CHUNG 1 docStore
  // (mục B6, phương án "1 store duy nhất + field status") để không phải migrate schema IndexedDB.
  // Field dùng để phân biệt là `listStatus` ('active'|'recent') — KHÔNG trùng với `doc.status`
  // ('loading'/'ready'/'error', mục A12 — trạng thái xử lý parse, khác khái niệm với active/recent).
  state.recentSources = [];
  // FIX P0 (race migration vs. upload): handleFiles() PHẢI await state.docsReadyPromise trước khi
  // đọc/ghi state.docs — nếu không, upload xảy ra trong lúc migration đang chạy có thể bị ghi đè
  // mất khi Promise bên dưới resolve và gán đè `state.docs = docs`. Gắn promise này vào `state`
  // (không phải biến cục bộ) để mọi nơi khác trong file có thể chờ cùng 1 "cổng khởi tạo storage".
  state.docsReadyPromise = (window.docStore ? window.docStore.migrateFromLegacyIfNeeded() : Promise.resolve([]))
    .then((docs) => {
      const all = docs || [];
      state.docs = all.filter((d) => d.listStatus !== 'recent');
      state.recentSources = all.filter((d) => d.listStatus === 'recent')
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 3);
      sourceCounter = all.reduce((max, d) => Math.max(max, d.id), 0);
      // PHẦN J: khôi phục vòng đời SAU F5. Source đã READY -> dùng cache, KHÔNG parse/vision lại.
      // Source dở dang -> KHÔNG giả vờ READY: đánh INCOMPLETE rồi resume đúng phần còn thiếu.
      state.docs.forEach(rehydrateSourceProcessing);
      renderSources();
      renderRecentSources();
    })
    .catch(() => { state.docs = []; state.recentSources = []; renderSources(); });


  const savedCurrentId = lsGet(LS_KEYS.currentConv, null);
  const existing = state.conversations.find((c) => c.id === savedCurrentId);
  if (existing) {
    loadConversation(existing.id, true);
  } else {
    startNewConversation(true);
  }
}

/* ================= Theme ================= */
function applyTheme(theme) {
  document.body.setAttribute('data-theme', theme);
  el('main').setAttribute('data-theme', theme); // giữ lại cho tương thích ngược với các selector cũ nhắm vào #main
  el('themeBtn').innerHTML = theme === 'dark' ? ICONS.sun : ICONS.moon;
  el('setLightBtn').classList.toggle('active', theme === 'light');
  el('setDarkBtn').classList.toggle('active', theme === 'dark');
}
el('themeBtn').onclick = () => { const t = document.body.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'; applyTheme(t); lsSet(LS_KEYS.theme, t); };
el('setLightBtn').onclick = () => { applyTheme('light'); lsSet(LS_KEYS.theme, 'light'); };
el('setDarkBtn').onclick = () => { applyTheme('dark'); lsSet(LS_KEYS.theme, 'dark'); };

/* ================= Sidebar mobile ================= */
el('menuBtn').onclick = () => { el('sidebar').classList.add('open'); el('sidebarOverlay').classList.add('show'); };
el('closeSidebarBtn').onclick = () => { el('sidebar').classList.remove('open'); el('sidebarOverlay').classList.remove('show'); };
el('sidebarOverlay').onclick = () => { el('sidebar').classList.remove('open'); el('sidebarOverlay').classList.remove('show'); };
function closeSidebarOnMobile() {
  if (window.innerWidth <= 760) { el('sidebar').classList.remove('open'); el('sidebarOverlay').classList.remove('show'); }
}

/* ================= Tabs khung bên trái: Nguồn / Lịch sử / Ghi chú / Công thức =================
   Motion system nhỏ, gom lại 1 chỗ (không rải logic animation khắp file):
   - positionTabIndicator(): đo offsetLeft/offsetWidth THẬT của tab active rồi set transform/width
     cho 1 indicator dùng chung (không hard-code vị trí, không có 4 indicator riêng).
   - animatePanelTransition(): panel cũ fade/slide ra trong lúc panel mới fade/slide vào, hướng
     trượt (trái/phải) suy ra từ thứ tự tab để có cảm giác "đang di chuyển trong 1 dải điều hướng".
   - initSidebarTabsMotion(): đặt indicator đúng vị trí khi tải trang (không animate) + theo dõi
     resize bằng ResizeObserver (không đọc offsetLeft/offsetWidth liên tục trong loop animation). */
(function initSidebarTabsMotion() {
  const TAB_ORDER = ['sources', 'history', 'notes', 'formulas'];
  const tabsWrap = el('sidebarTabs');
  const indicator = el('sbTabIndicator');
  const panelsWrap = el('sidebarPanels');
  const PANEL_OFFSET_PX = 10;
  if (!tabsWrap || !indicator || !panelsWrap) return; // an toàn nếu HTML thay đổi ngoài dự kiến

  function positionTabIndicator(tab, animate) {
    if (!tab) return;
    if (!animate) indicator.classList.add('no-anim');
    indicator.style.transform = `translateX(${tab.offsetLeft}px)`;
    indicator.style.width = `${tab.offsetWidth}px`;
    indicator.dataset.tab = tab.dataset.tab || '';
    if (!animate) {
      void indicator.offsetWidth; // ép reflow để bỏ transition không bị "nuốt" khung tiếp theo
      indicator.classList.remove('no-anim');
    }
  }

  function animatePanelTransition(toPanel, direction) {
    if (!toPanel) return;
    const fromPanel = panelsWrap.querySelector('.sbpanel.active');
    if (fromPanel === toPanel) return;
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) {
      if (fromPanel) fromPanel.classList.remove('active');
      toPanel.classList.add('active');
      return;
    }
    // Panel mới: đặt tức thời (không transition) về vị trí "bắt đầu" bên phải/trái rồi mới bật
    // active ở khung hình sau để trượt mượt vào 0 — dữ liệu bên trong panel không hề bị động tới.
    toPanel.classList.add('no-anim');
    toPanel.style.setProperty('--panel-offset', `${direction * PANEL_OFFSET_PX}px`);
    toPanel.classList.remove('active');
    void toPanel.offsetWidth;
    toPanel.classList.remove('no-anim');
    if (fromPanel) {
      fromPanel.style.setProperty('--panel-offset', `${-direction * PANEL_OFFSET_PX}px`);
      fromPanel.classList.remove('active');
    }
    requestAnimationFrame(() => { toPanel.classList.add('active'); });
  }

  function activateSidebarTab(tab) {
    if (!tab || tab.classList.contains('active')) return;
    const prevTab = tabsWrap.querySelector('.sbtab.active');
    const prevIndex = prevTab ? TAB_ORDER.indexOf(prevTab.dataset.tab) : 0;
    const nextIndex = TAB_ORDER.indexOf(tab.dataset.tab);
    const direction = nextIndex >= prevIndex ? 1 : -1;

    document.querySelectorAll('.sbtab').forEach((t) => t.classList.toggle('active', t === tab));
    positionTabIndicator(tab, true);
    animatePanelTransition(el('panel-' + tab.dataset.tab), direction);
  }

  document.querySelectorAll('.sbtab').forEach((tab) => {
    tab.onclick = () => activateSidebarTab(tab);
  });

  // Đặt indicator đúng vị trí tab active đầu tiên ngay khi vào trang — không animate, không có
  // hiệu ứng "chạy từ 0" gây cảm giác lỗi.
  positionTabIndicator(tabsWrap.querySelector('.sbtab.active'), false);

  // Resize/i18n đổi độ dài chữ → tab đổi kích thước → indicator phải bám theo, không lệch.
  function handleTabResize() {
    positionTabIndicator(tabsWrap.querySelector('.sbtab.active'), false);
  }
  if (typeof ResizeObserver !== 'undefined') {
    let raf = null;
    const ro = new ResizeObserver(() => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(handleTabResize);
    });
    ro.observe(tabsWrap);
    document.querySelectorAll('.sbtab').forEach((t) => ro.observe(t));
  } else {
    window.addEventListener('resize', handleTabResize);
  }
})();

/* ================= Settings modal ================= */
function openSettings() { el('settingsOverlay').classList.add('show'); }
function closeSettings() { el('settingsOverlay').classList.remove('show'); }
el('settingsBtnSide').onclick = openSettings;
el('settingsBtnTop').onclick = openSettings;
el('settingsCloseBtn').onclick = closeSettings;
el('settingsOverlay').addEventListener('click', (e) => { if (e.target.id === 'settingsOverlay') closeSettings(); });

/* ================= Luyện tập (Practice Mode setup) =================
 * Không có endpoint riêng — panel chỉ thu thập Chủ đề/Độ khó/Số câu rồi DỰNG 1 câu hỏi có cấu trúc,
 * gửi qua đúng pipeline giải bài hiện có (sendMessage), để bài luyện vẫn có đủ Hướng giải/Lời giải
 * chi tiết/Learning actions như 1 bài giải bình thường. Không tạo bộ đếm/điểm số giả ở client.
 */
function openPracticeSetup() { el('practiceOverlay').classList.add('show'); el('practiceTopicInput').focus(); }
function closePracticeSetup() { el('practiceOverlay').classList.remove('show'); }
el('practiceCloseBtn').onclick = closePracticeSetup;
el('practiceOverlay').addEventListener('click', (e) => { if (e.target.id === 'practiceOverlay') closePracticeSetup(); });
document.querySelectorAll('#practiceDifficultyChips .chip').forEach((c) => {
  c.onclick = () => document.querySelectorAll('#practiceDifficultyChips .chip').forEach((x) => x.classList.toggle('active', x === c));
});
document.querySelectorAll('#practiceCountChips .chip').forEach((c) => {
  c.onclick = () => document.querySelectorAll('#practiceCountChips .chip').forEach((x) => x.classList.toggle('active', x === c));
});
el('practiceStartBtn').onclick = () => {
  const topic = el('practiceTopicInput').value.trim();
  if (!topic) { el('practiceTopicInput').focus(); return; }
  const diff = document.querySelector('#practiceDifficultyChips .chip.active').dataset.val;
  const count = document.querySelector('#practiceCountChips .chip.active').dataset.val;
  closePracticeSetup();
  el('practiceTopicInput').value = '';
  el('qInput').value = `Cho mình ${count} bài luyện tập về chủ đề "${topic}", độ khó ${diff}. Ra đề trước, chưa đưa đáp án ngay.`;
  el('qInput').dispatchEvent(new Event('input'));
  sendMessage();
};

function applySettingsUI() {
  document.querySelectorAll('#detailChips .chip').forEach((c) => c.classList.toggle('active', c.dataset.val === state.settings.detail));
  document.querySelectorAll('#visualChips .chip').forEach((c) => c.classList.toggle('active', c.dataset.val === state.settings.visual));
  document.querySelectorAll('#langChips .chip').forEach((c) => c.classList.toggle('active', c.dataset.val === state.settings.lang));
  document.querySelectorAll('#schoolChips .chip').forEach((c) => c.classList.toggle('active', c.dataset.val === state.settings.school));
  renderGradeChips();
  updateGradeBadge();
}
// Badge cấp học/khối lớp thật (lấy từ Cài đặt, không bịa dữ liệu) hiện cạnh tiêu đề buổi học —
// giúp UI "nhìn là biết đang học gì" theo mục 4/10 brief, ẩn hẳn nếu chưa xác định được.
function updateGradeBadge() {
  const badgeEl = el('chatGradeBadge');
  if (!badgeEl) return;
  const schoolLabel = (window.SCHOOL_LEVELS[state.settings.school] || {}).label || '';
  const gradeLabel = window.GRADE_LABELS[state.settings.grade] || '';
  const parts = gradeLabel === schoolLabel ? [schoolLabel] : [gradeLabel, schoolLabel.toUpperCase()];
  const text = parts.filter(Boolean).join(' · ');
  badgeEl.textContent = text;
  badgeEl.style.display = text ? '' : 'none';
}
document.querySelectorAll('#detailChips .chip').forEach((c) => c.onclick = () => { state.settings.detail = c.dataset.val; applySettingsUI(); lsSet(LS_KEYS.settings, state.settings); });
document.querySelectorAll('#visualChips .chip').forEach((c) => c.onclick = () => { state.settings.visual = c.dataset.val; applySettingsUI(); lsSet(LS_KEYS.settings, state.settings); });
// PHẦN T/U/AH: đổi ngôn ngữ TRẢ LỜI (settings.lang, cơ chế cũ) đồng thời đồng bộ languageStore —
// nguồn ngôn ngữ UI trung tâm — để toàn bộ giao diện (qua t()) chuyển theo NGAY, không cần reload.
document.querySelectorAll('#langChips .chip').forEach((c) => c.onclick = () => {
  state.settings.lang = c.dataset.val;
  applySettingsUI();
  lsSet(LS_KEYS.settings, state.settings);
  if (window.languageStore) {
    const code = c.dataset.val === 'English' ? 'en' : (c.dataset.val === 'Tiếng Việt' ? 'vi' : null);
    if (code) window.languageStore.setUILanguage(code); // "tự động theo câu hỏi": giữ nguyên uiLanguage hiện tại, chỉ đổi answerLanguage
  }
});
document.querySelectorAll('#schoolChips .chip').forEach((c) => c.onclick = () => {
  state.settings.school = c.dataset.val;
  const grades = (window.SCHOOL_LEVELS[state.settings.school] || {}).grades || [];
  if (!grades.includes(state.settings.grade)) state.settings.grade = grades[0];
  applySettingsUI();
  lsSet(LS_KEYS.settings, state.settings);
  renderFormulaList();
});
function renderGradeChips() {
  const wrap = el('gradeChips');
  const grades = (window.SCHOOL_LEVELS[state.settings.school] || {}).grades || [];
  wrap.innerHTML = grades.map((g) => `<button class="chip${g === state.settings.grade ? ' active' : ''}" data-val="${g}">${window.GRADE_LABELS[g] || g}</button>`).join('');
  wrap.querySelectorAll('.chip').forEach((c) => c.onclick = () => {
    state.settings.grade = c.dataset.val;
    applySettingsUI();
    lsSet(LS_KEYS.settings, state.settings);
    renderFormulaList();
  });
}

el('clearHistoryBtn').onclick = () => {
  if (!confirm('Xóa cuộc trò chuyện hiện tại? Thao tác này không thể hoàn tác.')) return;
  deleteConversation(state.currentConvId);
  closeSettings();
};

/* ================= Rules ================= */
function renderRules() {
  const ul = el('ruleList');
  ul.innerHTML = '';
  if (state.rules.length === 0) { ul.innerHTML = '<div class="set-empty">Chưa có quy tắc nào. AI sẽ ghi nhớ các quy tắc bạn thêm ở đây cho mọi câu hỏi sau này.</div>'; return; }
  state.rules.forEach((r, i) => {
    const li = document.createElement('li');
    const span = document.createElement('span'); span.textContent = r;
    const btn = document.createElement('button'); btn.textContent = '✕';
    btn.onclick = () => { state.rules.splice(i, 1); lsSet(LS_KEYS.rules, state.rules); renderRules(); };
    li.appendChild(span); li.appendChild(btn);
    ul.appendChild(li);
  });
}
el('ruleAddBtn').onclick = () => {
  // Mục 4: chuẩn hoá NGAY tại nguồn (trim + gộp khoảng trắng + loại duplicate không phân biệt
  // hoa/thường) — cùng logic normalizeRules() phía server (validators.js), để rule không bị lưu 2
  // bản "gần giống nhau" rồi hiện tượng "lúc có lúc không" tuỳ bản nào server nhận được trước.
  const v = el('ruleInput').value.trim().replace(/\s+/g, ' ');
  if (!v) return;
  const exists = state.rules.some((r) => r.trim().toLowerCase() === v.toLowerCase());
  if (exists) { el('ruleInput').value = ''; return; }
  state.rules.push(v);
  el('ruleInput').value = '';
  lsSet(LS_KEYS.rules, state.rules);
  renderRules();
};

/* ================= Chế độ suy nghĩ (thanh chat, kiểu Claude) — 2 công tắc ĐỘC LẬP ================= */
function applyThinkModes() {
  const btn = el('thinkBtn');
  const { deepThinking, crossCheck } = state;
  const anyOn = deepThinking || crossCheck;
  const label = deepThinking && crossCheck ? 'Sâu + đối chiếu'
    : deepThinking ? 'Suy nghĩ sâu'
    : crossCheck ? 'Đối chiếu đa hướng'
    : 'Nhanh';
  btn.innerHTML = (anyOn ? ICONS.sparkles : ICONS.zap) + `<span>${label}</span>`;
  btn.classList.toggle('deep', anyOn);
  document.querySelectorAll('.think-opt').forEach((o) => {
    const on = o.dataset.mode === 'deepThinking' ? deepThinking : crossCheck;
    o.classList.toggle('active', on);
  });
}
el('thinkBtn').onclick = (e) => { e.stopPropagation(); el('thinkPopover').classList.toggle('show'); };
document.querySelectorAll('.think-opt').forEach((o) => {
  // Mỗi dòng chỉ đảo TRẠNG THÁI CỦA CHÍNH NÓ — không đóng popover sau khi bấm, để có thể bật/tắt
  // liên tiếp cả 2 công tắc trong cùng 1 lần mở menu (khác hành vi cũ: chọn 1 trong 2 rồi đóng ngay).
  o.onclick = () => {
    const key = o.dataset.mode; // 'deepThinking' | 'crossCheck'
    state[key] = !state[key];
    applyThinkModes();
    lsSet(key === 'deepThinking' ? LS_KEYS.deepThinking : LS_KEYS.crossCheck, state[key]);
  };
});
document.addEventListener('click', (e) => { if (!el('thinkBtnWrap').contains(e.target)) el('thinkPopover').classList.remove('show'); });

/* ================= Mục 14.3/14.4/14.21: Subject Selector (chọn môn thủ công / Tự động) ================= */
// Popover dựng ĐỘNG từ window.SUBJECTS (public/js/subjects.js) — thêm môn mới ở đó, KHÔNG cần sửa gì
// ở đây. Button hiển thị icon+tên môn đang chọn, gọn (14.21: không chiếm nhiều diện tích, dễ chạm mobile).
function applySubjectUI() {
  const btn = el('subjectBtn');
  if (!btn || !window.SUBJECTS) return;
  const cur = window.getSubjectInfo(state.settings.subject || 'auto');
  btn.innerHTML = `<span>${cur.icon} ${cur.name}</span>`;
  btn.classList.toggle('deep', state.settings.subject && state.settings.subject !== 'auto');
  document.querySelectorAll('.subject-opt').forEach((o) => {
    o.classList.toggle('active', o.dataset.subject === (state.settings.subject || 'auto'));
  });
}
function buildSubjectPopover() {
  const pop = el('subjectPopover');
  if (!pop || !window.SUBJECTS) return;
  pop.innerHTML = window.SUBJECTS.map((s) =>
    `<button class="subject-opt" data-subject="${s.id}" type="button"><span class="ic">${s.icon}</span><span class="tt">${s.name}</span></button>`
  ).join('');
  document.querySelectorAll('.subject-opt').forEach((o) => {
    o.onclick = () => {
      state.settings.subject = o.dataset.subject;
      lsSet(LS_KEYS.settings, state.settings);
      applySubjectUI();
      pop.classList.remove('show');
    };
  });
}
buildSubjectPopover();
applySubjectUI();
el('subjectBtn').onclick = (e) => { e.stopPropagation(); el('subjectPopover').classList.toggle('show'); };
document.addEventListener('click', (e) => { if (!el('subjectBtnWrap').contains(e.target)) el('subjectPopover').classList.remove('show'); });


/* ================= Sources (kiểu NotebookLM) — đọc file hoàn toàn trên trình duyệt ================= */
let sourceCounter = 0;

// Ký tự điều khiển / vùng "Private Use Area" — PDF chứa nhiều công thức toán thường nhúng font
// riêng cho ký hiệu (∫, √, phân số dựng bằng glyph...) mà KHÔNG có bảng ToUnicode chuẩn, nên
// pdf.js buộc phải đoán và trả ra glyph rác/lặp lại (vd hàng loạt ký tự "g", ô vuông trống...).
// Lọc các ký tự này ra để phần trích nguồn không còn hiển thị chuỗi ký tự vô nghĩa.
const CONTROL_OR_PUA_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uE000-\uF8FF\uFFF9-\uFFFB\uFFFD]/g;
function cleanExtractedText(raw) {
  return (raw || '').replace(CONTROL_OR_PUA_RE, ' ');
}
// Ước lượng tỉ lệ ký tự "vỡ font" còn sót lại trong 1 đoạn (không phải chữ/số/dấu câu thông
// thường). Tỉ lệ cao => đoạn này gần như chắc chắn không đọc được thành văn bản có nghĩa (thường
// là công thức/hình vẽ được dựng bằng glyph đặc biệt) — cần xử lý riêng thay vì hiển thị y nguyên.
function garbledRatio(text) {
  if (!text) return 0;
  const readable = text.match(/[\p{L}\p{N}\s.,;:()\-+=/%!?"'À-ỹ]/gu) || [];
  return 1 - readable.length / text.length;
}
// PHẦN A2 (SOURCE-COMPLETE): mỗi chunk PHẢI giữ metadata trang/nguồn để truy nguyên chính xác, không
// chỉ {id, text} như trước — nếu không, citation không thể khớp đúng trang (mục A9) và AI không có
// cách nào biết 1 chunk thuộc trang nào để trả lời "giải bài ở trang X". `pages` là mảng {page, text}
// (page = null cho DOCX/TXT, không có khái niệm trang). Chunk theo TỪNG TRANG riêng (không gộp nhiều
// trang vào 1 chuỗi rồi cắt mù) để startPage luôn = endPage = page thật, tránh 1 chunk "lỡ" vắt qua 2
// trang mà vẫn chỉ ghi 1 số trang (sai citation).
function chunkText(pages, meta = {}, size = 900) {
  const doc = meta.doc || null;
  const sourceId = meta.sourceId != null ? meta.sourceId : null;
  const pageList = Array.isArray(pages) ? pages : [{ page: null, text: pages }];
  const out = [];
  pageList.forEach(({ page, text }) => {
    const clean = cleanExtractedText(text).replace(/\s+/g, ' ').trim();
    if (!clean) return;
    for (let i = 0; i < clean.length; i += size) {
      const t = clean.slice(i, i + size);
      out.push({ text: t, garbled: garbledRatio(t) > 0.3, page, startPage: page, endPage: page, doc, sourceId });
    }
  });
  const totalChunks = out.length;
  // PHẦN F: mỗi chunk mang sẵn provenance đầy đủ (evidenceId/extractionMethod/extractionStatus) để
  // citationMap phía server không phải suy luận lại từ vị trí mảng.
  return out.map((c, idx) => ({
    id: idx + 1, chunkIndex: idx + 1, totalChunks,
    evidenceId: `${sourceId != null ? sourceId : 'src'}:c${idx + 1}${c.page != null ? `:p${c.page}` : ''}`,
    extractionMethod: 'text', extractionStatus: 'ok',
    ...c
  }));
}
// FIX: PDF "chỉ ảnh" (bài scan/chụp rồi gộp vào PDF, không có text layer) — trước đây parsePDF() chỉ
// gọi getTextContent() nên trả về chuỗi RỖNG, doc vẫn được đánh dấu 'ready' nhưng không có nội dung
// thật nào để trích dẫn (giống hệt triệu chứng ở bug race điều kiện trước, nhưng lần này không phải
// do đọc dở mà do bản chất file không có text để đọc). NAY: nếu lượng text trích được quá ít so với
// số trang (heuristic: trung bình < PDF_TEXT_MIN_CHARS_PER_PAGE ký tự/trang), coi là "PDF chỉ ảnh" —
// tự động render từng trang (giới hạn PDF_MAX_RASTER_PAGES trang đầu) thành ảnh PNG rồi gửi thẳng cho
// model đọc bằng vision, y hệt cách 1 ảnh chụp bài đính kèm được xử lý.
const PDF_TEXT_MIN_CHARS_PER_PAGE = 15;
// PHẦN A10 (SOURCE-COMPLETE cho PDF scan): TRƯỚC đây giới hạn cứng 6 TRANG ĐẦU rồi coi như đã xử lý
// xong toàn bộ PDF — ROOT CAUSE thứ hai khiến PDF scan dài bị "cụt" ngay từ lúc upload, trước cả khi
// tới retrieval. NAY: rasterize TOÀN BỘ số trang (không còn trần cứng), chia theo batch để không
// đứng hình UI, có retry + ghi nhận trang lỗi (không giả vờ đã đọc hết) — xem parsePDF().
const PDF_RASTER_BATCH_SIZE = 8;
const PDF_RASTER_MAX_DIM = 1400; // px — đủ nét để model đọc chữ nhỏ, vẫn giữ base64 gọn

async function rasterizePdfPage(pdf, pageNum) {
  const page = await pdf.getPage(pageNum);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = Math.min(2, PDF_RASTER_MAX_DIM / Math.max(baseViewport.width, baseViewport.height));
  const viewport = page.getViewport({ scale: Math.max(scale, 0.5) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;
  // FIX ROOT CAUSE (lỗi "Đã có lỗi xảy ra. Vui lòng thử lại." khi hỏi trích nguồn từ PDF scan dài):
  // TRƯỚC ĐÂY dùng PNG (nén KHÔNG MẤT DỮ LIỆU) cho mỗi trang raster — với 1 trang scan văn bản
  // (nhiều chi tiết tần số cao), 1 ảnh PNG 1400px thường nặng 0.5-2MB. collectSourceImages() có
  // thể gửi tới 18 ảnh như vậy trong 1 request (~9-36MB base64) — vượt xa giới hạn body
  // ngân sách request dùng chung (payloadBudget.js), và còn vượt giới hạn payload cứng của nền
  // tảng hosting (Vercel Serverless Functions) vốn KHÔNG thể nới qua cấu hình app. Khi vượt, body-
  // parser trả lỗi 413 TRƯỚC KHI request chạm tới route /api/chat — client nhận lỗi không có
  // `code`/`error` nhận diện được, rơi về thông báo chung chung (xem errorNormalize.js/i18n.js).
  // JPEG NÉN CÓ MẤT DỮ LIỆU nhưng ở quality 0.82 vẫn đủ nét cho vision model đọc chữ/công thức,
  // trong khi giảm kích thước base64 xuống còn khoảng 1/4-1/8 so với PNG cho cùng nội dung scan.
  const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
  const m = dataUrl.match(/^data:(.*?);base64,(.*)$/);
  canvas.width = 0; canvas.height = 0; // giải phóng bộ nhớ canvas ngay, không chờ GC
  if (!m) return null;
  return { mediaType: m[1], base64: m[2] };
}

async function parsePDF(file) {
  try { await ensurePdfJs(); } catch (e) { /* rơi xuống check window.pdfjsLib bên dưới để báo lỗi đúng nội dung */ }
  if (!window.pdfjsLib) throw new Error('Không tải được thư viện đọc PDF (pdf.js) — kiểm tra kết nối mạng hoặc trình chặn quảng cáo rồi thử lại.');
  const buf = await file.arrayBuffer();
  // FIX ROOT CAUSE (mục 4 audit — "Content Security Policy ... blocks the use of eval"): pdf.js tự
  // dò `FeatureTest.isEvalSupported` bằng `new Function("")` để quyết định có dùng đường compile
  // nhanh (glyph rendering / PostScript transfer function) hay không. Việc DÒ này được try/catch bên
  // trong pdf.js nên KHÔNG làm app crash, nhưng trình duyệt vẫn log cảnh báo CSP mỗi lần dò vì bản
  // thân `new Function()` bị chặn là 1 CSP violation thật (dù bị catch). Khai báo thẳng
  // `isEvalSupported: false` ở đây để pdf.js dùng ngay nhánh thông dịch (không compile) từ đầu,
  // không cần dò nữa — hết luôn cảnh báo, không đổi kết quả (app này chỉ getTextContent(), không
  // dùng canvas rendering nên không phụ thuộc nhánh compile glyph đó).
  const pdf = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
  // PHẦN A2/A3: giữ text TỪNG TRANG riêng (không chỉ gộp vào 1 chuỗi `full`) — cần cho chunkText()
  // gán đúng số trang cho mỗi chunk (trước đây gộp hết vào `full` là mất luôn ranh giới trang).
  const pages = [];
  let full = '';
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const pageText = content.items.map((it) => it.str).join(' ');
    pages.push({ page: p, text: pageText });
    full += pageText + '\n';
  }
  const meaningfulLen = full.replace(/\s+/g, '').length;
  const isImageOnly = meaningfulLen < pdf.numPages * PDF_TEXT_MIN_CHARS_PER_PAGE;
  if (!isImageOnly) {
    return {
      text: full, pages, pageImages: [], isImageOnly: false, totalPages: pdf.numPages,
      renderedPages: pdf.numPages, failedPages: [], coveragePercent: 100
    };
  }

  // PDF chỉ ảnh (mục A10): render TOÀN BỘ trang (KHÔNG còn giới hạn cứng 6 trang đầu), chia theo
  // batch PDF_RASTER_BATCH_SIZE để trình duyệt có dịp nhả luồng UI giữa các batch thay vì đứng hình
  // với PDF nhiều trang. 1 trang lỗi được retry 1 lần, nếu vẫn lỗi thì GHI RÕ (failedPages), không
  // được coi như "đã xử lý xong toàn bộ" khi thực ra thiếu vài trang (mục A10 cấm giả vờ hoàn chỉnh).
  const pageImages = [];
  const failedPages = [];
  for (let batchStart = 1; batchStart <= pdf.numPages; batchStart += PDF_RASTER_BATCH_SIZE) {
    const batchEnd = Math.min(pdf.numPages, batchStart + PDF_RASTER_BATCH_SIZE - 1);
    for (let p = batchStart; p <= batchEnd; p++) {
      let ok = false;
      for (let attempt = 0; attempt < 2 && !ok; attempt++) {
        try {
          const img = await rasterizePdfPage(pdf, p);
          if (img) { pageImages.push({ ...img, page: p }); ok = true; }
        } catch (e) { console.error('[pdf] render trang ' + p + ' thất bại (lần ' + (attempt + 1) + '):', e); }
      }
      if (!ok) failedPages.push(p);
    }
    // Nhả luồng UI giữa 2 batch (PDF dài nhiều batch sẽ không làm trang bị treo).
    if (batchEnd < pdf.numPages) await new Promise((r) => setTimeout(r, 0));
  }
  const coveragePercent = pdf.numPages ? Math.round((pageImages.length / pdf.numPages) * 100) : 0;
  return {
    text: '', pages: [], pageImages, isImageOnly: true, totalPages: pdf.numPages,
    renderedPages: pageImages.length, failedPages, coveragePercent
  };
}

async function parseDocx(file) {
  try { await ensureMammoth(); } catch (e) { /* rơi xuống check window.mammoth bên dưới để báo lỗi đúng nội dung */ }
  if (!window.mammoth) throw new Error('Không tải được thư viện đọc DOCX (mammoth.js) — kiểm tra kết nối mạng hoặc trình chặn quảng cáo rồi thử lại.');
  const buf = await file.arrayBuffer();
  const res = await mammoth.extractRawText({ arrayBuffer: buf });
  return res.value;
}
async function parseTxt(file) { return await file.text(); }
function iconFor(ext) { return ext === 'pdf' ? ICONS.outline : ext === 'docx' ? ICONS.note : ICONS.outline; }

/** PHẦN J: sau F5 — READY thì giữ nguyên (cache), dở dang thì resume ĐÚNG phần còn thiếu.
 * Evidence từng trang đã lưu trong IndexedDB nên trang nào đọc rồi KHÔNG bao giờ gọi vision lại. */
function rehydrateSourceProcessing(doc) {
  const ps = ensureSourceProcessingState(doc);
  if (ps.status === SOURCE_STATUS.READY || ps.status === SOURCE_STATUS.ERROR) return null;
  // Không còn ảnh trang (không persist được / bị dọn) -> không thể resume, giữ INCOMPLETE trung thực.
  if (!(doc.sourceType === 'image-pdf' && doc.pageImages && doc.pageImages.length)) {
    setSourceStatus(doc, SOURCE_STATUS.INCOMPLETE);
    return null;
  }
  setSourceStatus(doc, SOURCE_STATUS.INCOMPLETE);
  const resume = processPdfVisionEvidence(doc).catch((e) => {
    console.error('[vision-extract] resume lỗi:', e);
    setSourceStatus(doc, SOURCE_STATUS.INCOMPLETE, { lastError: String((e && e.message) || e) });
  });
  state.sourceProcessingPromises.push(resume);
  resume.finally(() => {
    const idx = state.sourceProcessingPromises.indexOf(resume);
    if (idx !== -1) state.sourceProcessingPromises.splice(idx, 1);
  });
  return resume;
}

/* ---------- PHẦN Q: NHÃN TRẠNG THÁI NGUỒN — mỗi giai đoạn 1 câu chữ khác nhau ---------- */
function sourceCardLabel(doc) {
  const ps = ensureSourceProcessingState(doc);
  const total = ps.totalPages || 0;
  switch (ps.status) {
    case SOURCE_STATUS.UPLOADING: return 'Đang tải lên…';
    case SOURCE_STATUS.PARSING: return 'Đang phân tích tài liệu…';
    case SOURCE_STATUS.RASTERIZING: return `Đang dựng ảnh trang ${ps.renderedPages}/${total || '?'}…`;
    case SOURCE_STATUS.EXTRACTING: return `Đang đọc trang ${ps.extractedPages}/${total || '?'}…`;
    case SOURCE_STATUS.VERIFYING: return 'Đang xác minh nguồn…';
    case SOURCE_STATUS.ERROR: return '⚠️ Không đọc được tài liệu này';
    case SOURCE_STATUS.INCOMPLETE: {
      const miss = ps.failedPages.length;
      return `⚠️ Mới đọc ${ps.verifiedPages}/${total} trang${miss ? ` · không đọc được ${miss} trang` : ''} · chưa sẵn sàng`;
    }
    case SOURCE_STATUS.READY:
    default: {
      if (ps.extractionMethod === 'vision') return `${ps.verifiedPages}/${total} trang · AI đã đọc xong`;
      const chunks = (doc.chunks || []).filter((c) => !c[SOURCE_PLACEHOLDER_FLAG]).length;
      return `${chunks} đoạn${total > 1 ? ` · ${total} trang` : ''} · đã đọc ${ps.verifiedPages}/${total}`;
    }
  }
}

/* ---------- PHẦN III/IV/VII (kiến trúc mới — INSTANT SOURCE AVAILABILITY) ----------
 * TRƯỚC ĐÂY: nút gửi bị disable bất cứ khi nào còn ≥1 nguồn "processing", kể cả khi nguồn đó ĐÃ có
 * evidence thật dùng được (vd PDF scan 134 trang, 72 trang đã đọc xong) — ép user chờ TOÀN BỘ tài
 * liệu xử lý xong mới được hỏi, đúng bug bị audit ở mục II.A ("UI chặn gửi khi source còn
 * processing"). NAY: KHÔNG BAO GIỜ disable nút gửi chỉ vì có nguồn đang xử lý nền — user luôn được
 * gửi câu hỏi ngay khi họ muốn; retrieveContext()/collectAvailableEvidence() sẽ tự lấy đúng phần
 * evidence THẬT đang có (xem PHẦN VIII), và completenessCheck ở server tự nhắc nếu câu hỏi cần phần
 * nguồn CHƯA có evidence (source-aware completeness — đã có sẵn trong promptBuilder/completenessCheck).
 * statusText chỉ còn vai trò THÔNG BÁO tiến độ nền — không khoá tương tác. */
function updateComposerSourceState() {
  const btn = typeof el === 'function' ? el('sendBtn') : null;
  const statusTextEl = typeof el === 'function' ? el('statusText') : null;
  if (!btn) return;
  // Nút gửi không bao giờ bị nguồn-đang-xử-lý disable nữa (PHẦN IV, mục acceptance criteria LXIX:
  // "Không còn disable Send chỉ vì source đang background processing"). Các lý do disable KHÁC (vd
  // đang stream câu trả lời) do code chỗ khác quản lý qua dataset key riêng, không đụng ở đây.
  if (btn.dataset.blockedBySource === '1') { btn.disabled = false; delete btn.dataset.blockedBySource; }
  const summary = sourceReadinessSummary();
  if (!statusTextEl) return;
  if (summary.unusableDocs.length > 0) {
    // Có nguồn CHƯA có 1 evidence thật nào (vừa mới đăng ký/đang parse trang đầu) — báo tiến độ,
    // KHÔNG nói "sẵn sàng" (mục LXII NO FALSE READY) nhưng cũng không chặn gửi.
    const d = summary.unusableDocs[0];
    const ps = ensureSourceProcessingState(d);
    statusTextEl.textContent = ps.status === SOURCE_STATUS.EXTRACTING && ps.totalPages
      ? `Đang đọc trang ${ps.extractedPages}/${ps.totalPages}… (có thể hỏi ngay, các nguồn khác đã dùng được)`
      : `Đang đọc nguồn "${d.name}"…`;
  } else if (summary.processing > 0) {
    // Mọi nguồn đều đã usableNow, nhưng vẫn có nguồn đang enrich nền (PHẦN III: PARTIAL_AVAILABLE ->
    // ENRICHING) — nói rõ đây là PARTIAL, không phải đã đọc xong, tránh false-ready.
    const d = summary.processingDocs[0];
    const ps = ensureSourceProcessingState(d);
    statusTextEl.textContent = `Đã dùng được — đang đọc thêm ${ps.verifiedPages}/${ps.totalPages || '?'} trang "${d.name}"…`;
  } else {
    statusTextEl.textContent = typeof t === 'function' ? t('chat.statusReady') : '';
  }
}

function renderSources() {
  updateComposerSourceState();
  const list = el('sourceList');
  list.innerHTML = '';
  el('emptySources').style.display = state.docs.length ? 'none' : 'block';
  // Số lượng tài liệu thật cạnh header "Tài liệu học tập" (mục 6), ẩn nếu chưa có tài liệu nào.
  if (el('sourceCount')) el('sourceCount').textContent = state.docs.length ? ` (${state.docs.length})` : '';
  state.docs.forEach((doc) => {
    const li = document.createElement('li');
    li.className = 'source-card';
    const chars = doc.chunks.reduce((a, c) => a + c.text.length, 0);
    const firstChunk = doc.chunks[0];
    // PHẦN D: hiển thị coverage THẬT thay vì chỉ "X ký tự" — người dùng cần biết PDF đã đọc bao
    // nhiêu % để không nghi ngờ nhầm lúc AI trả lời thiếu (vd PDF scan đang xử lý dở, chưa xong hẳn).
    // PHẦN Q: nhãn PHẢI phân biệt render vs đã đọc vs đã xác minh. TUYỆT ĐỐI không "100% đã đọc"
    // khi mới rasterize xong.
    const coverageLabel = sourceCardLabel(doc);
    // Nguồn tự động được dùng ngay khi tải lên (không còn tick chọn thủ công) — nếu đoạn đầu bị
    // "vỡ font" (xem garbledRatio), hiển thị ghi chú thân thiện thay vì đổ chuỗi ký tự rác ra preview.
    const previewText = firstChunk
      ? (firstChunk.garbled
        ? '⚠️ Tài liệu chứa nhiều công thức/ký hiệu đặc biệt — bản xem trước có thể không hiển thị đầy đủ, nhưng nội dung vẫn được dùng khi trả lời.'
        : firstChunk.text.slice(0, 320).replace(/</g, '&lt;') + '…')
      : '';
    li.innerHTML = `
      <div class="row">
        <span class="icon">${iconFor(doc.ext)}</span>
        <div class="meta">
          <div class="nm">${escapeHtml(doc.name)}</div>
          <div class="sub">${coverageLabel} · đang dùng</div>
        </div>
        <button class="rm" title="Xóa nguồn">✕</button>
      </div>
      <div class="preview">${previewText}</div>
    `;
    li.querySelector('.rm').onclick = (e) => {
      e.stopPropagation();
      // PHẦN B4: xóa source đang dùng KHÔNG xóa hẳn dữ liệu — chuyển sang "Nguồn gần đây" để có
      // thể khôi phục lại (mục B2/B5), thay vì mất trắng như trước (state.docs.filter(...) cũ).
      moveDocToRecent(doc.id);
    };
    li.querySelector('.row').addEventListener('click', (e) => {
      if (e.target.closest('.rm')) return;
      li.classList.toggle('expanded');
    });
    list.appendChild(li);
  });
  // Lưu lại danh sách nguồn (mục 13): nội dung file PDF/DOCX/TXT có thể rất lớn nên KHÔNG
  // còn lưu vào localStorage (giới hạn ~5MB, đồng bộ) — dùng IndexedDB qua docStore, có
  // fallback an toàn về localStorage nếu IndexedDB không khả dụng. Bất đồng bộ, không chặn UI.
  persistDocs();
}

/** PHẦN B6: lưu CẢ state.docs (active) VÀ state.recentSources (gần đây, tối đa 3) vào CHUNG 1
 * docStore, đánh dấu bằng `listStatus` để tách ra lại lúc load (xem loadAll()). Gọi hàm này thay
 * cho việc gọi thẳng `window.docStore.saveAll(state.docs)` ở mọi nơi state.docs/recentSources đổi,
 * nếu không nguồn gần đây sẽ KHÔNG sống sót qua reload (phá mục B8). */
function persistDocs() {
  if (!window.docStore) return;
  const activeTagged = state.docs.map((d) => ({ ...d, listStatus: 'active' }));
  const recentTagged = (state.recentSources || []).map((d) => ({ ...d, listStatus: 'recent' }));
  window.docStore.saveAll(activeTagged.concat(recentTagged));
}

/** PHẦN B4/B7: chuyển 1 active doc sang "Nguồn gần đây" thay vì xóa hẳn — dedupe theo fingerprint
 * (nếu file giống hệt đã có trong recent, giữ bản MỚI hơn) rồi cắt còn tối đa 3, sort theo
 * updatedAt/addedAt giảm dần (mục B3). */
function moveDocToRecent(docId) {
  const idx = state.docs.findIndex((d) => d.id === docId);
  if (idx === -1) return;
  const [doc] = state.docs.splice(idx, 1);
  doc.updatedAt = Date.now();
  const fp = doc.fingerprint;
  state.recentSources = state.recentSources.filter((d) => !(fp && d.fingerprint === fp));
  state.recentSources.unshift(doc);
  state.recentSources = state.recentSources
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 3);
  renderSources();
  renderRecentSources();
}

/** PHẦN B5: "Dùng lại" — phục hồi 1 recent source thành active KHÔNG parse lại (chunks/pageImages/
 * pageCoverage/fingerprint/citations metadata vẫn nguyên trong object đã lưu, xem B5 yêu cầu đủ
 * danh sách trường phải phục hồi). */
function restoreRecentSource(docId) {
  const idx = state.recentSources.findIndex((d) => d.id === docId);
  if (idx === -1) return;
  const [doc] = state.recentSources.splice(idx, 1);
  doc.updatedAt = Date.now();
  // Nếu đã có 1 active doc cùng fingerprint (hiếm, nhưng có thể xảy ra), không tạo bản trùng.
  if (!doc.fingerprint || !state.docs.some((d) => d.fingerprint === doc.fingerprint)) {
    state.docs.push(doc);
  }
  renderSources();
  renderRecentSources();
  closeAddSourcePanel();
}

/** PHẦN B15/A15: fingerprint nhẹ cho 1 file, dùng để dedupe "Nguồn gần đây" (B7) và làm cache key
 * cho source (A14/A15). Ưu tiên SHA-256 thật qua crypto.subtle (secure context); nếu không có
 * (http không có TLS, trình duyệt cũ...) rơi về fingerprint dựa trên tên+kích thước+lastModified —
 * vẫn đủ để phân biệt file khác nhau trong đa số trường hợp thực tế, KHÔNG throw ra ngoài. */
async function computeFingerprint(file) {
  try {
    if (window.crypto && window.crypto.subtle && window.crypto.subtle.digest) {
      const buf = await file.arrayBuffer();
      const hashBuf = await window.crypto.subtle.digest('SHA-256', buf);
      const bytes = Array.from(new Uint8Array(hashBuf));
      return 'sha256:' + bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch (e) { /* rơi xuống fallback bên dưới */ }
  return `meta:${file.name}:${file.size}:${file.lastModified || 0}`;
}

/** PHẦN B1/B9/B10: panel "Thêm nguồn". Cùng pattern mở/đóng với settings/note/practice (class
 * .show trên overlay) — thêm Esc để đóng + trả focus về nút vừa mở (mục B10, thứ settings modal
 * hiện tại CHƯA có, làm chuẩn hơn ở panel mới này). */
let addSourcePanelOpenerEl = null;
function openAddSourcePanel(openerEl) {
  addSourcePanelOpenerEl = openerEl || document.activeElement;
  renderRecentSources();
  el('addSourceOverlay').classList.add('show');
  const dz = el('addSourceDropZone');
  if (dz) dz.focus();
}
function closeAddSourcePanel() {
  el('addSourceOverlay').classList.remove('show');
  if (addSourcePanelOpenerEl && typeof addSourcePanelOpenerEl.focus === 'function') addSourcePanelOpenerEl.focus();
  addSourcePanelOpenerEl = null;
}

/** PHẦN B3/B11: render tối đa 3 "Nguồn gần đây", mọi text qua t() (i18n — mục B11). */
function formatRecentMeta(doc) {
  const kindKey = doc.ext === 'pdf' ? 'recentSources.pdf' : doc.ext === 'docx' ? 'recentSources.docx' : 'recentSources.txt';
  const kind = t(kindKey);
  const ts = doc.updatedAt || doc.addedAt || 0;
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  const timeLabel = sameDay
    ? d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
    : (isYesterday ? t('recentSources.yesterday') : d.toLocaleDateString('vi-VN'));
  let pagesLabel = '';
  if (doc.sourceType === 'image-pdf' && doc.pageCoverage) pagesLabel = ' · ' + t('recentSources.pages', { n: doc.pageCoverage.totalPages });
  else {
    const pages = (doc.chunks || []).map((c) => c.page).filter((p) => p != null);
    if (pages.length) pagesLabel = ' · ' + t('recentSources.pages', { n: Math.max(...pages) });
  }
  return `${timeLabel} · ${kind}${pagesLabel}`;
}
function renderRecentSources() {
  const listEl = el('recentSourcesList');
  const emptyEl = el('recentSourcesEmpty');
  if (!listEl) return;
  listEl.innerHTML = '';
  const items = (state.recentSources || []).slice(0, 3);
  if (emptyEl) emptyEl.style.display = items.length ? 'none' : 'block';
  items.forEach((doc) => {
    const li = document.createElement('li');
    li.className = 'recent-src-item';
    li.innerHTML = `
      <div class="recent-src-info">
        <span class="recent-src-name">${escapeHtml(doc.name)}</span>
        <span class="recent-src-meta">${escapeHtml(formatRecentMeta(doc))}</span>
      </div>
      <button class="recent-src-use">${escapeHtml(t('recentSources.use'))}</button>
      <button class="recent-src-remove" aria-label="${escapeHtml(t('recentSources.remove'))}">✕</button>
    `;
    li.querySelector('.recent-src-use').onclick = () => restoreRecentSource(doc.id);
    li.querySelector('.recent-src-remove').onclick = () => {
      state.recentSources = state.recentSources.filter((d) => d.id !== doc.id);
      persistDocs();
      renderRecentSources();
    };
    listEl.appendChild(li);
  });
}

/* ============================================================================================
 * SOURCE PROCESSING LIFECYCLE (PHẦN A/B/D) — 1 MÁY TRẠNG THÁI DUY NHẤT CHO MỌI NGUỒN
 * ============================================================================================
 * ROOT CAUSE đã sửa: 'ready' TRƯỚC ĐÂY chỉ có nghĩa "đã parse/đã render ảnh xong". Với PDF scan,
 * render xong ≠ ĐỌC xong — vision extraction mới là bước đọc, mà nó lại chạy fire-and-forget. Kết
 * quả: user hỏi ngay sau upload -> retrieveContext() chỉ thấy 1 chunk ghi chú -> AI nói "không tìm
 * thấy trong nguồn"; các câu sau chất lượng trồi sụt theo tiến độ nền.
 *
 * NAY vòng đời tường minh:
 *   UPLOADING -> PARSING -> (RASTERIZING -> EXTRACTING) -> VERIFYING -> READY | INCOMPLETE | ERROR
 * và READY CHỈ được đặt khi có BẰNG CHỨNG (PHẦN D): verifiedPages === totalPages, failedPages rỗng.
 * Ba loại coverage được tách hẳn, KHÔNG được dùng lẫn nhau:
 *   renderCoverage   — đã có ảnh/đã đọc được text thô của bao nhiêu trang
 *   readCoverage     — AI/parser đã TRÍCH XUẤT nội dung của bao nhiêu trang
 *   verifiedCoverage — bao nhiêu trang đã qua kiểm tra metadata (đúng số trang, có nội dung thật)
 */
const SOURCE_EXTRACTION_VERSION = 2; // đổi số này khi thuật toán trích xuất đổi -> cache cũ tự invalidate (PHẦN T)
const SOURCE_STATUS = {
  UPLOADING: 'UPLOADING', PARSING: 'PARSING', RASTERIZING: 'RASTERIZING', EXTRACTING: 'EXTRACTING',
  VERIFYING: 'VERIFYING', READY: 'READY', INCOMPLETE: 'INCOMPLETE', ERROR: 'ERROR'
};
const SOURCE_TERMINAL_STATUSES = [SOURCE_STATUS.READY, SOURCE_STATUS.INCOMPLETE, SOURCE_STATUS.ERROR];
// Mọi chunk do hệ thống tự sinh để BÁO TRẠNG THÁI (không phải nội dung nguồn) đều mang cờ này và
// TUYỆT ĐỐI không bao giờ được lọt vào contexts gửi cho AI (PHẦN C / TEST 13).
const SOURCE_PLACEHOLDER_FLAG = 'placeholder';

function coveragePct(done, total) { return total > 0 ? Math.round((Number(done) || 0) / total * 100) : 0; }

// PROGRESSIVE INGESTION — 3 trục trạng thái ĐỘC LẬP (không được dùng `status`/READY làm điều kiện
// DUY NHẤT để quyết định "dùng được hay không" — đó chính là root cause khiến UI/sendMessage/
// collectReadyChunks/collectSourceImages phải chờ 100% mới cho dùng nguồn). Một nguồn có thể ĐỒNG
// THỜI: availabilityStatus=AVAILABLE (có evidence thật dùng được ngay) + processingStatus=PROCESSING
// (nền vẫn đang đọc tiếp) + verificationStatus=PARTIAL (chưa xác minh hết) — đây là trạng thái BÌNH
// THƯỜNG và MONG MUỐN trong phần lớn thời gian xử lý nguồn lớn, không phải lỗi.
const AVAILABILITY_STATUS = { UNAVAILABLE: 'UNAVAILABLE', PARTIAL: 'PARTIAL', AVAILABLE: 'AVAILABLE' };
const PROCESSING_STATUS_AXIS = { IDLE: 'IDLE', PROCESSING: 'PROCESSING', DONE: 'DONE', ERROR: 'ERROR' };
const VERIFICATION_STATUS = { UNVERIFIED: 'UNVERIFIED', PARTIAL: 'PARTIAL', VERIFIED: 'VERIFIED' };

function createSourceProcessingState(patch) {
  return Object.assign({
    status: SOURCE_STATUS.UPLOADING,
    extractionMethod: 'unknown',        // 'text' (parser) | 'vision' | 'none'
    extractionVersion: SOURCE_EXTRACTION_VERSION,
    totalPages: 0,
    parsedPages: 0,
    renderedPages: 0,
    extractedPages: 0,
    verifiedPages: 0,
    failedPages: [],
    renderCoverage: 0,
    readCoverage: 0,
    verifiedCoverage: 0,
    coveragePercent: 0,                 // = verifiedCoverage, KHÔNG BAO GIỜ = renderCoverage
    // 3 trục progressive-ingestion — xem khối comment ngay phía trên. Giá trị thật được tính trong
    // recomputeSourceCoverage()/setSourceStatus(), đây chỉ là default trước khi có patch đầu tiên.
    availabilityStatus: AVAILABILITY_STATUS.UNAVAILABLE,
    processingStatus: PROCESSING_STATUS_AXIS.IDLE,
    verificationStatus: VERIFICATION_STATUS.UNVERIFIED,
    startedAt: Date.now(),
    completedAt: null,
    lastError: null
  }, patch || {});
}

function recomputeSourceCoverage(ps) {
  const total = ps.totalPages || 0;
  const isVision = ps.extractionMethod === 'vision';
  ps.renderCoverage = coveragePct(isVision ? ps.renderedPages : ps.parsedPages, total);
  ps.readCoverage = coveragePct(isVision ? ps.extractedPages : ps.parsedPages, total);
  ps.verifiedCoverage = coveragePct(ps.verifiedPages, total);
  // PHẦN D/Q: "đã đọc %" hiển thị và gửi đi PHẢI là verified, không phải render.
  ps.coveragePercent = ps.verifiedCoverage;

  // --- 3 trục progressive-ingestion (kiến trúc mới, mục III của yêu cầu audit) ---
  // processingStatus: trục thuần "đang chạy nền hay đã dừng", KHÔNG liên quan gì tới "dùng được chưa".
  if (ps.status === SOURCE_STATUS.ERROR) ps.processingStatus = PROCESSING_STATUS_AXIS.ERROR;
  else if (SOURCE_TERMINAL_STATUSES.indexOf(ps.status) !== -1) ps.processingStatus = PROCESSING_STATUS_AXIS.DONE;
  else if (ps.status === SOURCE_STATUS.UPLOADING) ps.processingStatus = PROCESSING_STATUS_AXIS.IDLE;
  else ps.processingStatus = PROCESSING_STATUS_AXIS.PROCESSING;

  // verificationStatus: đã VERIFY (PHẦN D — bằng chứng thật, không phải render) được bao nhiêu.
  if (ps.verifiedPages <= 0) ps.verificationStatus = VERIFICATION_STATUS.UNVERIFIED;
  else if (total > 0 && ps.verifiedPages >= total && ps.failedPages.length === 0) ps.verificationStatus = VERIFICATION_STATUS.VERIFIED;
  else ps.verificationStatus = VERIFICATION_STATUS.PARTIAL;

  // availabilityStatus: có evidence THẬT dùng được ngay không (PHẦN VII: usableNow != fullyVerified).
  // done bên ngoài (isSourceUsableNow cần đọc doc.chunks, ps không có chunks) — set placeholder ở
  // đây dựa trên verifiedPages/extractedPages làm tín hiệu SỚM, rồi syncDerivedAvailability(doc)
  // phía dưới ghi đè bằng tín hiệu CHÍNH XÁC (dựa trên chunk thật) mỗi khi có doc trong tay.
  if (ps.verificationStatus === VERIFICATION_STATUS.VERIFIED) ps.availabilityStatus = AVAILABILITY_STATUS.AVAILABLE;
  else if (ps.extractedPages > 0 || ps.verifiedPages > 0) ps.availabilityStatus = AVAILABILITY_STATUS.PARTIAL;
  else ps.availabilityStatus = AVAILABILITY_STATUS.UNAVAILABLE;
  return ps;
}

/** Ghi đè availabilityStatus bằng tín hiệu CHÍNH XÁC: có ít nhất 1 chunk THẬT (không placeholder,
 * không lỗi, có nội dung) trong doc.chunks hay không — đây là nguồn sự thật duy nhất cho "usable
 * now", độc lập với con số processing (vd DOCX/TXT không có totalPages nhưng vẫn usable ngay). Gọi
 * SAU MỌI lần đổi doc.chunks (rebuildChunksFromEvidence/verifyTextSource/handleFiles) — xem các call
 * site của setSourceStatus() ở dưới. An toàn khi gọi trước khi doc.chunks tồn tại. */
function syncDerivedAvailability(doc) {
  const ps = doc && doc.processing;
  if (!ps) return;
  const usableNow = isSourceUsableNow(doc);
  if (ps.verificationStatus === VERIFICATION_STATUS.VERIFIED) ps.availabilityStatus = AVAILABILITY_STATUS.AVAILABLE;
  else ps.availabilityStatus = usableNow ? AVAILABILITY_STATUS.PARTIAL : AVAILABILITY_STATUS.UNAVAILABLE;
}

/** Đặt trạng thái + đồng bộ các field cũ (doc.status/doc.pageCoverage) để phần UI/code cũ không vỡ. */
function setSourceStatus(doc, status, patch) {
  const base = doc.processing || createSourceProcessingState({});
  const ps = Object.assign(base, patch || {}, { status });
  if (!Array.isArray(ps.failedPages)) ps.failedPages = [];
  recomputeSourceCoverage(ps);
  if (status === SOURCE_STATUS.READY && !ps.completedAt) ps.completedAt = Date.now();
  if (status !== SOURCE_STATUS.READY) ps.completedAt = null;
  doc.processing = ps;
  syncDerivedAvailability(doc); // PHẦN VII: availabilityStatus dựa trên chunk THẬT, không chỉ số processing
  // doc.status giữ 3 giá trị cũ cho code/UI cũ, nhưng 'ready' NAY chỉ ứng với READY thật sự.
  doc.status = status === SOURCE_STATUS.READY ? 'ready' : (status === SOURCE_STATUS.ERROR ? 'error' : 'loading');
  // pageCoverage = ảnh phản chiếu của phần RENDER (giữ tên cũ cho UI/test cũ), không phải "đã đọc".
  doc.pageCoverage = {
    totalPages: ps.totalPages, renderedPages: ps.renderedPages, failedPages: ps.failedPages.slice(),
    coveragePercent: ps.renderCoverage
  };
  return ps;
}

/** PHẦN D: chốt READY CHỈ khi có bằng chứng đầy đủ; thiếu 1 trang -> INCOMPLETE, không giả vờ. */
function finalizeSourceStatus(doc) {
  const ps = doc.processing;
  if (!ps) return null;
  const total = ps.totalPages || 0;
  const extracted = ps.extractionMethod === 'vision'
    ? (ps.renderedPages >= total && ps.extractedPages >= total)
    : ps.parsedPages >= total;
  const complete = total > 0 && extracted && ps.verifiedPages >= total && ps.failedPages.length === 0;
  return setSourceStatus(doc, complete ? SOURCE_STATUS.READY : SOURCE_STATUS.INCOMPLETE);
}

/** Doc cũ khôi phục từ IndexedDB (trước khi có lifecycle) — SUY RA trạng thái từ field cũ, KHÔNG
 * parse/vision lại (PHẦN J: đã READY thì dùng cache). */
function ensureSourceProcessingState(doc) {
  if (doc && doc.processing && doc.processing.status) return doc.processing;
  if (!doc) return createSourceProcessingState({});
  const legacyReady = !doc.status || doc.status === 'ready';
  const pc = doc.pageCoverage || null;
  const chunkPages = (doc.chunks || []).map((c) => c.page).filter((p) => p != null);
  const total = pc && pc.totalPages ? pc.totalPages : (chunkPages.length ? Math.max.apply(null, chunkPages) : 1);
  const method = doc.sourceType === 'image-pdf' ? 'vision' : 'text';
  doc.processing = createSourceProcessingState({
    status: legacyReady ? SOURCE_STATUS.READY : (doc.status === 'error' ? SOURCE_STATUS.ERROR : SOURCE_STATUS.INCOMPLETE),
    extractionMethod: method,
    extractionVersion: 1, // bản cũ -> version 1 để cache key phân biệt được (PHẦN T)
    totalPages: total,
    parsedPages: legacyReady ? total : 0,
    renderedPages: pc && pc.renderedPages != null ? pc.renderedPages : (legacyReady ? total : 0),
    extractedPages: legacyReady ? total : 0,
    verifiedPages: legacyReady ? total : 0,
    failedPages: pc && Array.isArray(pc.failedPages) ? pc.failedPages.slice() : [],
    completedAt: legacyReady ? (doc.updatedAt || Date.now()) : null
  });
  recomputeSourceCoverage(doc.processing);
  return doc.processing;
}

function isSourceReady(doc) {
  return ensureSourceProcessingState(doc).status === SOURCE_STATUS.READY;
}
function isSourceProcessing(doc) {
  const st = ensureSourceProcessingState(doc).status;
  return SOURCE_TERMINAL_STATUSES.indexOf(st) === -1;
}

/** PHẦN VII (kiến trúc mới): "usable" != "ready". TRUE nếu doc có ÍT NHẤT 1 evidence THẬT dùng
 * được ngay — không placeholder, không lỗi extraction, có nội dung thật. Đây là điều kiện DÙNG được
 * nguồn ngay lập tức (retrieval/gửi ảnh/gửi context), khác hẳn isSourceReady() (yêu cầu 100% coverage
 * đã verify). Nguồn ERROR mà chưa từng có 1 evidence nào -> KHÔNG usable (không có gì thật để dùng).
 */
function isSourceUsableNow(doc) {
  if (!doc) return false;
  const chunks = doc.chunks || [];
  return chunks.some((c) => !c[SOURCE_PLACEHOLDER_FLAG]
    && (!c.extractionStatus || c.extractionStatus === 'ok')
    && String(c.text || '').trim().length > 0);
}

/** PHẦN VII: alias tường minh cho ý nghĩa "đã xác minh TOÀN BỘ" — CHÍNH XÁC là isSourceReady(), giữ
 * tách riêng tên hàm để chỗ gọi nói rõ ý định (tránh nhầm READY với USABLE — mục LXII "NO FALSE READY"). */
function isSourceFullyVerified(doc) {
  return isSourceReady(doc);
}
/** Tóm tắt trạng thái mọi nguồn — dùng cho UI composer + gửi kèm request (PHẦN N/Q/S). */
function sourceReadinessSummary() {
  const docs = state.docs || [];
  const processing = docs.filter(isSourceProcessing);
  const incomplete = docs.filter((d) => ensureSourceProcessingState(d).status === SOURCE_STATUS.INCOMPLETE);
  const usableNow = docs.filter(isSourceUsableNow);
  return {
    total: docs.length,
    ready: docs.filter(isSourceReady).length,
    // PHẦN III/VII: "processing" KHÔNG còn có nghĩa "chưa dùng được" — chỉ có nghĩa "nền vẫn chạy".
    // usable: đã có evidence thật, dùng ngay được (kể cả khi vẫn đang processing nền).
    usable: usableNow.length,
    processing: processing.length,
    incomplete: incomplete.length,
    allReady: processing.length === 0,
    allUsable: docs.length > 0 && usableNow.length === docs.length,
    processingDocs: processing,
    unusableDocs: docs.filter((d) => !isSourceUsableNow(d)) // vẫn UPLOADING/PARSING, chưa có evidence nào
  };
}
/** Payload trạng thái nguồn gửi kèm MỌI request (PHẦN N: server biết nguồn đã READY hay chưa để
 * cấm AI kết luận "tài liệu không có thông tin"). Chỉ vài con số — không phải nội dung. */
function buildSourceStatusPayload() {
  return (state.docs || []).map((d) => {
    const ps = ensureSourceProcessingState(d);
    return {
      sourceId: String(d.id), name: d.name, status: ps.status,
      // PHẦN III/N: server PHẢI thấy cả 3 trục — không được suy "usable" từ status READY duy nhất
      // (mục LXII "NO FALSE READY": PARTIAL không bao giờ được server/prompt trình bày như FULL).
      availabilityStatus: ps.availabilityStatus, processingStatus: ps.processingStatus,
      verificationStatus: ps.verificationStatus, usableNow: isSourceUsableNow(d),
      extractionMethod: ps.extractionMethod, extractionVersion: ps.extractionVersion,
      totalPages: ps.totalPages, parsedPages: ps.parsedPages, renderedPages: ps.renderedPages,
      extractedPages: ps.extractedPages, verifiedPages: ps.verifiedPages,
      failedPages: ps.failedPages.slice(0, 20),
      renderCoverage: ps.renderCoverage, readCoverage: ps.readCoverage, verifiedCoverage: ps.verifiedCoverage
    };
  });
}

// FIX (race: gửi câu hỏi TRƯỚC KHI file đọc xong): handleFiles() trước đây gán ngay chunk placeholder
// "⏳ Đang đọc…" vào doc.chunks rồi mới await parse — nếu người dùng bấm gửi câu hỏi trong lúc file
// còn đang đọc (rất dễ xảy ra vì họ vừa upload xong là gõ luôn câu hỏi), retrieveContext() không có
// cách nào phân biệt được đây là placeholder hay nội dung thật, nên nó gửi thẳng CHUỖI "⏳ Đang đọc…"
// cho AI làm "nguồn tài liệu" — model nhận đúng như vậy nên trả lời "không nhận được nội dung trích
// dẫn" dù người dùng RÕ RÀNG đã tải nguồn lên trước đó. FIX: đánh dấu doc.status ('loading'/'ready'/
// 'error') và lưu Promise xử lý nguồn vào state.sourceProcessingPromises để nơi gửi câu hỏi await hết
// trước khi lấy contexts (xem waitForAllSourceProcessing()); đồng thời retrieveContext() tự loại doc chưa
// 'ready' để không bao giờ lọt placeholder vào nguồn gửi AI dù lỡ quên await ở đâu đó.
async function handleFiles(files) {
  // FIX P0: chờ storage khởi tạo xong (migration/load từ IndexedDB) trước khi đụng vào state.docs
  // và sourceCounter — tránh mất document vừa upload nếu người dùng thao tác quá nhanh lúc app
  // vừa mở (xem comment ở loadAll()).
  if (state.docsReadyPromise) { try { await state.docsReadyPromise; } catch (e) { /* đã tự xử lý lỗi trong loadAll() */ } }
  for (const file of files) {
    const ext = file.name.split('.').pop().toLowerCase();
    // PHẦN B5/B7/A14/A15: dùng fingerprint để nhận ra file GIỐNG HỆT đã có trong "Nguồn gần đây" ->
    // phục hồi thẳng (KHÔNG parse lại), tiết kiệm thời gian + đúng tinh thần "cache full source".
    const fingerprint = await computeFingerprint(file);
    const recentMatchIdx = state.recentSources.findIndex((d) => d.fingerprint === fingerprint);
    if (recentMatchIdx !== -1) {
      restoreRecentSource(state.recentSources[recentMatchIdx].id);
      continue;
    }
    // File đã đang active (upload trùng trong lúc đang mở) — không tạo bản sao thứ 2.
    if (state.docs.some((d) => d.fingerprint === fingerprint)) continue;
    const doc = {
      id: ++sourceCounter, name: file.name, ext, status: 'loading', fingerprint, updatedAt: Date.now(),
      // Chunk báo trạng thái PHẢI có cờ placeholder — retrieveContext()/buildContexts() loại tuyệt
      // đối theo cờ này, không dựa vào việc "đoán nội dung" (TEST 13).
      chunks: [{ id: 1, text: '⏳ Đang đọc…', [SOURCE_PLACEHOLDER_FLAG]: true }]
    };
    setSourceStatus(doc, SOURCE_STATUS.UPLOADING, createSourceProcessingState({ extractionMethod: ext === 'pdf' ? 'unknown' : 'text' }));
    state.docs.push(doc);
    renderSources();
    // 1 PROMISE DUY NHẤT bao TRỌN vòng đời: parse -> rasterize -> vision extract -> verify.
    const processingPromise = (async () => {
      try {
        setSourceStatus(doc, SOURCE_STATUS.PARSING);
        renderSources();
        if (ext === 'pdf') {
          const result = await parsePDF(file);
          if (result.isImageOnly) {
            doc.pageImages = result.pageImages;
            doc.sourceType = 'image-pdf';
            setSourceStatus(doc, SOURCE_STATUS.RASTERIZING, {
              extractionMethod: 'vision', totalPages: result.totalPages,
              parsedPages: 0, renderedPages: result.renderedPages,
              extractedPages: 0, verifiedPages: 0, failedPages: (result.failedPages || []).slice()
            });
            const failNote = (result.failedPages && result.failedPages.length)
              ? ` (lỗi ${result.failedPages.length} trang: ${result.failedPages.slice(0, 10).join(', ')}${result.failedPages.length > 10 ? '…' : ''})`
              : '';
            doc.chunks = [{
              id: 1, garbled: false, [SOURCE_PLACEHOLDER_FLAG]: true,
              text: result.pageImages.length
                ? `⏳ PDF scan/ảnh chụp — đã render ${result.renderedPages}/${result.totalPages} trang${failNote}, đang đọc bằng AI…`
                : '⚠️ PDF này là bản scan/ảnh chụp nhưng không render được trang nào.'
            }];
            renderSources();
            // AWAIT THẬT — không còn fire-and-forget (ROOT CAUSE, PHẦN B).
            await processPdfVisionEvidence(doc);
          } else {
            doc.sourceType = 'pdf';
            doc.chunks = chunkText(result.pages, { doc: doc.name, sourceId: doc.id });
            const parsedPages = result.pages.filter((p) => String(p.text || '').trim().length > 0).length;
            setSourceStatus(doc, SOURCE_STATUS.VERIFYING, {
              extractionMethod: 'text', totalPages: result.totalPages,
              parsedPages: result.totalPages, renderedPages: result.totalPages,
              extractedPages: parsedPages, verifiedPages: 0, failedPages: []
            });
            verifyTextSource(doc, result.totalPages);
          }
        } else {
          let text = '';
          if (ext === 'docx') text = await parseDocx(file);
          else text = await parseTxt(file);
          doc.sourceType = ext;
          doc.chunks = chunkText(text, { doc: doc.name, sourceId: doc.id });
          // DOCX/TXT không có khái niệm trang -> coi toàn văn bản là 1 "trang logic".
          setSourceStatus(doc, SOURCE_STATUS.VERIFYING, {
            extractionMethod: 'text', totalPages: 1, parsedPages: 1, renderedPages: 1,
            extractedPages: doc.chunks.length ? 1 : 0, verifiedPages: 0, failedPages: []
          });
          verifyTextSource(doc, 1);
        }
      } catch (e) {
        doc.chunks = [{ id: 1, text: '⚠️ Không đọc được nội dung file này.', [SOURCE_PLACEHOLDER_FLAG]: true }];
        setSourceStatus(doc, SOURCE_STATUS.ERROR, { lastError: String((e && e.message) || e) });
        console.error(e);
      }
      persistDocs();
      renderSources();
    })();
    state.sourceProcessingPromises.push(processingPromise);
    // Tự dọn khỏi mảng theo dõi khi xong (thành công lẫn lỗi), tránh mảng phình to vô hạn qua nhiều
    // lượt upload — waitForAllSourceProcessing() chỉ quan tâm các Promise CHƯA settle.
    processingPromise.finally(() => {
      const idx = state.sourceProcessingPromises.indexOf(processingPromise);
      if (idx !== -1) state.sourceProcessingPromises.splice(idx, 1);
      renderSources();
    });
  }
  // Nhiều file xử lý SONG SONG nhưng MỖI file có state riêng (PHẦN B) — nơi GỬI câu hỏi mới là nơi
  // phải chờ, qua waitForAllSourceProcessing().
}

/** PHẦN D (bằng chứng cho nguồn text): mỗi trang phải parse ra nội dung thật thì mới tính verified.
 * Trang trắng trong PDF là hợp lệ (không phải lỗi) nên vẫn tính verified, nhưng nếu KHÔNG trang nào
 * có nội dung thì source là INCOMPLETE — không được giả vờ đã đọc. */
function verifyTextSource(doc, totalPages) {
  const ps = doc.processing;
  const pagesWithText = new Set(doc.chunks.filter((c) => !c[SOURCE_PLACEHOLDER_FLAG] && String(c.text || '').trim()).map((c) => c.page));
  const anyText = doc.chunks.some((c) => !c[SOURCE_PLACEHOLDER_FLAG] && String(c.text || '').trim().length > 0);
  setSourceStatus(doc, SOURCE_STATUS.VERIFYING, {
    verifiedPages: anyText ? totalPages : 0,
    extractedPages: totalPages === 1 ? (anyText ? 1 : 0) : Math.max(ps ? ps.extractedPages : 0, pagesWithText.size),
    failedPages: anyText ? [] : [1]
  });
  if (anyText) {
    // Với PDF text-layer: extractedPages có thể < totalPages (trang trắng) — điều kiện READY của
    // nguồn text là parsedPages === totalPages, nên đồng bộ lại extractedPages ở đây.
    setSourceStatus(doc, SOURCE_STATUS.VERIFYING, { extractedPages: totalPages });
  }
  return finalizeSourceStatus(doc);
}

/** Chờ TOÀN BỘ vòng đời xử lý nguồn (parse + rasterize + vision + verify) trước khi dựng request.
 * Dùng allSettled để 1 file lỗi không chặn các file khác/không treo việc gửi câu hỏi. */
async function waitForAllSourceProcessing() {
  // Vòng lặp: 1 promise có thể sinh thêm promise khác (vd retry/resume sau F5) — chờ tới khi sạch,
  // BOUNDED để không bao giờ chờ vô hạn (PHẦN I: no infinite loop).
  for (let round = 0; round < 8 && state.sourceProcessingPromises.length; round++) {
    await Promise.allSettled(state.sourceProcessingPromises.slice());
  }
}

/** Gom ảnh trang PDF-chỉ-ảnh từ mọi doc 'ready' để gửi kèm request (xem parsePDF()/handleFiles()).
 * Giới hạn tổng số ảnh gửi đi (khớp MAX_SOURCE_IMAGES ở server) — đây là trần AN TOÀN kỹ thuật cho 1
 * REQUEST (băng thông/token), KHÔNG phải "PDF chỉ có N trang đầu tiên tồn tại" như comment cũ. Vì
 * parsePDF() giờ đã rasterize TOÀN BỘ trang (xem A10), hàm này chỉ còn nhiệm vụ CHỌN trang nào gửi
 * cho lượt hỏi hiện tại: ưu tiên trang được nhắc tới trực tiếp trong câu hỏi ("trang 37"), còn lại
 * trải đều theo toàn bộ tài liệu (không phải luôn lấy N trang ĐẦU) để nhiều lượt hỏi khác nhau dần
 * bao phủ hết PDF thay vì luôn chỉ thấy đúng 1 phần đầu cố định. */
const MAX_TOTAL_SOURCE_IMAGES = 18;
function extractPageHints(query) {
  const hints = new Set();
  const re = /trang\s*(\d+)/gi;
  let m;
  while ((m = re.exec(query || ''))) hints.add(Number(m[1]));
  return hints;
}
// FIX ROOT CAUSE #1 (bug "Đã có lỗi xảy ra. Vui lòng thử lại." khi hỏi trích nguồn 1 PDF scan dài
// còn dở vision-extraction): TRƯỚC ĐÂY chỉ giới hạn SỐ LƯỢNG ảnh gửi kèm (MAX_TOTAL_SOURCE_IMAGES
// = 18), không giới hạn TỔNG DUNG LƯỢNG — dù mỗi ảnh đã đổi PNG->JPEG (xem rasterizePdfPage()),
// 18 ảnh scan chữ dày đặc vẫn có thể cộng dồn vượt xa 8MB (giới hạn express.json ở server/app.js,
// và còn vượt trần cứng không thể nới của nền tảng hosting). Khi vượt, request bị chặn ở tầng
// body-parser TRƯỚC KHI vào tới route /api/chat — client chỉ nhận lỗi 413 chung chung (xem
// errorNormalize.js/i18n.js đã thêm mapping PAYLOAD_TOO_LARGE cho trường hợp này). NAY: chốt thêm
// 1 trần TỔNG DUNG LƯỢNG base64 — khi vượt, bớt dần ảnh từ CUỐI danh sách (ảnh ít ưu tiên nhất,
// vì các ảnh người dùng chỉ đích danh qua pageHints luôn được xếp lên đầu ở bước `picked` bên dưới)
// cho tới khi vừa trần, KHÔNG BAO GIỜ để 1 request 1 mình làm sập cả lượt hỏi.
// PHẦN A3/A6: ngân sách đến từ public/js/payloadBudget.js (khớp server). BỎ HẲN luật cũ "luôn giữ
// ít nhất 1 ảnh dù ảnh đó vượt trần" — mảng vượt ngân sách chắc chắn tạo 413 ở tầng sau, giữ lại
// không cứu được gì mà chỉ làm hỏng cả lượt hỏi.
const SOURCE_IMAGES_BYTE_BUDGET = (window.PayloadBudget && window.PayloadBudget.MAX_SOURCE_IMAGES_TOTAL_BYTES) || 2.6 * 1024 * 1024;
let lastSourceImageRejections = [];
function capImagesToByteBudget(images, maxBytes) {
  const PB = window.PayloadBudget;
  if (!PB) return (images || []).slice(0, 1);
  const res = PB.capImagesToByteBudget(images, { totalBytes: maxBytes || SOURCE_IMAGES_BYTE_BUDGET });
  lastSourceImageRejections = res.rejected || [];
  if (lastSourceImageRejections.length) {
    console.warn('[payload] trang nguồn bị bỏ khỏi lượt hỏi này:',
      lastSourceImageRejections.map((r) => ({ page: r.item && r.item.page, reason: r.reason })));
  }
  return res.kept;
}

function collectSourceImages(query = '') {
  const pageHints = extractPageHints(query);
  // PHẦN II.D/VIII (kiến trúc mới): TRƯỚC ĐÂY giới hạn vào isSourceReady() (100% verified) — nghĩa
  // là 1 PDF scan 134 trang phải đọc xong CẢ 134 trang mới được gửi dù trang đã render/có evidence
  // từ lâu. NAY: page ĐÃ render (doc.pageImages tồn tại — xem parsePDF()) là dùng được ngay, độc lập
  // với việc source đã fully-verified hay chưa — evidence THẬT (ảnh đã rasterize thật) không cần chờ
  // verify toàn bộ. Vẫn loại doc còn ERROR mà chưa từng render nổi trang nào (pageImages rỗng).
  const imagePdfDocs = state.docs.filter((doc) => doc.sourceType === 'image-pdf' && doc.pageImages && doc.pageImages.length);
  const out = [];
  imagePdfDocs.forEach((doc) => {
    // PHẦN A11: trang ĐÃ có vision evidence (text đã trích xong, xem processPdfVisionEvidence())
    // KHÔNG cần gửi lại ảnh gốc nữa — evidence text đi qua retrieveContext()/citation như PDF chữ
    // thường, rẻ hơn nhiều so với gửi lại base64 mỗi lượt hỏi. Chỉ gửi ảnh thô cho: trang CHƯA có
    // evidence, HOẶC trang người dùng chỉ đích danh (pageHints — có thể họ muốn AI tự nhìn lại ảnh
    // gốc thay vì tin evidence đã cache).
    const hasGoodEvidence = (page) => {
      const ev = doc.pageEvidence && doc.pageEvidence[page];
      return !!(ev && ev.ok && ev.extractedText);
    };
    const eligible = doc.pageImages.filter((img) => pageHints.has(img.page) || !hasGoodEvidence(img.page));
    const perDocBudget = Math.max(1, Math.floor(MAX_TOTAL_SOURCE_IMAGES / imagePdfDocs.length) || MAX_TOTAL_SOURCE_IMAGES);
    const picked = eligible.filter((img) => pageHints.has(img.page));
    if (picked.length < perDocBudget) {
      const remain = perDocBudget - picked.length;
      const already = new Set(picked.map((img) => img.page));
      const rest = eligible.filter((img) => !already.has(img.page));
      const step = Math.max(1, Math.floor(rest.length / remain) || 1);
      for (let i = 0; i < rest.length && picked.length < perDocBudget; i += step) picked.push(rest[i]);
    }
    picked.slice(0, perDocBudget).forEach((img) => out.push({ mediaType: img.mediaType, base64: img.base64, doc: doc.name, page: img.page }));
  });
  return capImagesToByteBudget(out.slice(0, MAX_TOTAL_SOURCE_IMAGES), SOURCE_IMAGES_BYTE_BUDGET);
}

/** PHẦN A6/A11: sau khi rasterize xong 1 doc PDF-chỉ-ảnh (parsePDF()), gọi vision đọc TỪNG BATCH
 * (khớp PDF_RASTER_BATCH_SIZE trang/lần — mục A6 "không nổ token 1 request") qua
 * /api/source/vision-extract, cache kết quả vào doc.pageEvidence rồi DỰNG LẠI doc.chunks bằng text
 * thật (có page/citation) thay cho ảnh — sau lần xử lý này, các câu hỏi về PDF dùng evidence text
 * (rẻ) thay vì gửi lại ảnh gốc mỗi lượt (xem collectSourceImages() ở trên). Chạy NỀN, KHÔNG chặn
 * upload/UI — 1 batch lỗi không huỷ các batch còn lại (mục A10: 1 trang lỗi ≠ cả PDF lỗi).
 */
// FIX ROOT CAUSE #2 (bug "đã xử lý X/Y trang nhưng vẫn không dùng được để trích nguồn"):
// TRƯỚC ĐÂY rebuildChunksFromEvidence() chỉ chạy 1 LẦN, SAU KHI vòng for xử lý HẾT mọi batch —
// nghĩa là trong lúc đang xử lý dở (vd 72/134), doc.chunks VẪN CÒN nguyên chunk placeholder
// "📄 PDF này là bản scan..." dù 72 trang ĐÃ có evidence thật, khiến retrieveContext() không có gì
// thật để trích dẫn (chỉ có 1 câu ghi chú chung chung) suốt cả quá trình xử lý (có thể rất lâu với
// PDF nhiều trang) — đúng triệu chứng "nguồn nói đã xử lý nhưng không trích được". NAY: rebuild
// SAU MỖI BATCH — tiến độ tới đâu, trích dẫn dùng được tới đó.
function rebuildChunksFromEvidence(doc) {
  const okPages = doc.pageImages.map((img) => img.page).filter((p) => doc.pageEvidence[p] && doc.pageEvidence[p].ok && doc.pageEvidence[p].extractedText);
  if (!okPages.length) return;
  const totalChunks = okPages.length;
  doc.chunks = okPages.map((p, idx) => {
    const ev = doc.pageEvidence[p];
    const extra = [
      ev.equations && ev.equations.length ? `Công thức: ${ev.equations.join('; ')}` : '',
      ev.diagrams && ev.diagrams.length ? `Hình vẽ: ${ev.diagrams.join('; ')}` : ''
    ].filter(Boolean).join('\n');
    return {
      id: idx + 1, chunkIndex: idx + 1, totalChunks, page: p, startPage: p, endPage: p,
      doc: doc.name, sourceId: doc.id, garbled: false,
      // PHẦN F: provenance đi kèm TỪNG evidence, không suy luận lại ở bất kỳ tầng nào phía sau.
      evidenceId: `${doc.id}:p${p}:v${SOURCE_EXTRACTION_VERSION}`,
      extractionMethod: 'vision', extractionStatus: 'ok',
      confidence: ev.confidence != null ? ev.confidence : null,
      text: extra ? `${ev.extractedText}\n${extra}` : ev.extractedText
    };
  });
}
// PHẦN I: retry BOUNDED và CHỈ trang lỗi (TEST 8). 1 trang hỏng KHÔNG bao giờ kéo cả PDF đọc lại.
const VISION_PAGE_MAX_ATTEMPTS = 2; // 1 lần đầu + tối đa 1 lần retry

/** Gọi vision cho ĐÚNG danh sách trang truyền vào, theo batch. Trả về số trang đọc thành công. */
async function runVisionBatches(doc, pages) {
  // PHẦN D: gom batch theo BYTE THẬT thay vì hằng số 8 trang. 8 trang scan chữ dày đặc vẫn có thể
  // vượt trần payload (413 cho cả batch), 8 trang nhẹ lại lãng phí lượt gọi. Trang tự nó vượt ngân
  // sách được đánh dấu lỗi RIÊNG trang đó, không kéo cả tài liệu.
  const PB = window.PayloadBudget;
  const plan = PB
    ? PB.planByteBatches(pages, {
      budgetBytes: PB.MAX_SOURCE_IMAGES_TOTAL_BYTES,
      maxPerBatch: PDF_RASTER_BATCH_SIZE,
      sizeOf: (img) => PB.base64WireBytes(img.base64) + 256
    })
    : (function chunkFallback() {
      // payloadBudget.js chưa nạp (rất hiếm): vẫn phải chia ĐỦ MỌI trang thành batch — bản fallback
      // chỉ lấy batch đầu sẽ làm mất trắng các trang còn lại mà không báo lỗi.
      const out = [];
      for (let i = 0; i < pages.length; i += PDF_RASTER_BATCH_SIZE) out.push(pages.slice(i, i + PDF_RASTER_BATCH_SIZE));
      return { batches: out, oversized: [] };
    })();
  plan.oversized.forEach((img) => {
    doc.pageEvidence[img.page] = {
      ok: false, page: img.page, attempts: VISION_PAGE_MAX_ATTEMPTS, reason: 'page_too_large'
    };
  });
  if (plan.oversized.length) { syncVisionProgress(doc); persistDocs(); renderSources(); }

  for (const batch of plan.batches) {
    try {
      const resp = await apiPost('/api/source/vision-extract', {
        pages: batch.map((img) => ({ page: img.page, mediaType: img.mediaType, base64: img.base64 }))
      });
      (resp && resp.results ? resp.results : []).forEach((r) => {
        const prev = doc.pageEvidence[r.page];
        const attempts = (prev && prev.attempts ? prev.attempts : 0) + 1;
        doc.pageEvidence[r.page] = r.ok
          ? {
            ok: true, page: r.page, attempts,
            extractedText: r.extractedText || '', equations: r.equations || [],
            diagrams: r.diagrams || [], confidence: r.confidence,
            extractionMethod: 'vision', extractionVersion: SOURCE_EXTRACTION_VERSION
          }
          : { ok: false, page: r.page, attempts, reason: r.reason || 'unknown' };
      });
      // PHẦN E: trang server TỪ CHỐI ở tầng validate — ghi đúng lý do, KHÔNG retry mù (retry cùng
      // dữ liệu sẽ bị từ chối y hệt) và KHÔNG để trang đó nằm im như thể chưa xử lý.
      (resp && Array.isArray(resp.rejected) ? resp.rejected : []).forEach((r) => {
        const page = r.page != null ? r.page : (batch[r.index] && batch[r.index].page);
        if (page == null) return;
        doc.pageEvidence[page] = { ok: false, page, attempts: VISION_PAGE_MAX_ATTEMPTS, reason: r.reason || 'rejected' };
      });
      // Trang nằm trong batch nhưng server không trả kết quả nào -> vẫn phải đếm attempt, nếu không
      // vòng retry bên dưới sẽ lặp vô hạn.
      batch.forEach((img) => {
        if (!doc.pageEvidence[img.page]) doc.pageEvidence[img.page] = { ok: false, page: img.page, attempts: 1, reason: 'missing_result' };
      });
    } catch (e) {
      console.error('[vision-extract] batch lỗi:', e);
      batch.forEach((img) => {
        const prev = doc.pageEvidence[img.page];
        const attempts = (prev && prev.attempts ? prev.attempts : 0) + 1;
        if (!prev || !prev.ok) doc.pageEvidence[img.page] = { ok: false, page: img.page, attempts, reason: 'network_error' };
      });
    }
    syncVisionProgress(doc);
    // Dựng lại doc.chunks NGAY SAU BATCH NÀY — tiến độ tới đâu, evidence dùng được tới đó (nhưng
    // source vẫn CHƯA READY cho tới khi verify đủ).
    rebuildChunksFromEvidence(doc);
    persistDocs();
    renderSources();
  }
}

function syncVisionProgress(doc) {
  const total = doc.pageImages ? doc.pageImages.length : 0;
  const okPages = Object.keys(doc.pageEvidence || {}).filter((p) => doc.pageEvidence[p] && doc.pageEvidence[p].ok);
  doc.visionProgress = { processed: Object.keys(doc.pageEvidence || {}).length, total, extracted: okPages.length };
  setSourceStatus(doc, doc.processing ? doc.processing.status : SOURCE_STATUS.EXTRACTING, {
    extractedPages: okPages.length
  });
}

/** PHẦN D: VERIFY từng trang — evidence phải (1) tồn tại, (2) ok, (3) đúng số trang, (4) đúng
 * extractionVersion hiện hành, (5) có nội dung THẬT hoặc là trang trắng đáng tin.
 *
 * Điểm (5) đáng nói: model vision đôi khi trả `ok:true` với extractedText RỖNG kèm confidence rất
 * thấp — đó không phải "trang trắng", đó là "tôi không đọc được". Phân biệt hai ca này bằng chính
 * confidence model tự khai: rỗng + confidence >= ngưỡng = trang trắng thật (hợp lệ); rỗng +
 * confidence thấp = đọc hỏng (vào failedPages). Ngưỡng cố tình để THẤP (0.2) vì trang scan mờ/chữ
 * viết tay vẫn đọc được nội dung dù model tự tin thấp — đánh trượt chúng sẽ chặn READY một cách oan uổng.
 * Trang đọc được nhưng confidence thấp KHÔNG bị coi là lỗi, chỉ được ghi vào lowConfidencePages để
 * hiển thị/manifest nói rõ, đúng tinh thần "trung thực về chất lượng nguồn". */
const VISION_MIN_CONFIDENCE = Number.isFinite(Number(window.VISION_MIN_CONFIDENCE))
  ? Number(window.VISION_MIN_CONFIDENCE) : 0.2;

function verifyVisionEvidence(doc) {
  const pages = (doc.pageImages || []).map((img) => img.page);
  const failed = [];
  const lowConfidence = [];
  let verified = 0;
  pages.forEach((p) => {
    const ev = doc.pageEvidence ? doc.pageEvidence[p] : null;
    const shapeOk = !!ev && ev.ok === true
      && (ev.page == null || Number(ev.page) === Number(p))
      && typeof ev.extractedText === 'string'
      && ev.extractionVersion === SOURCE_EXTRACTION_VERSION;
    if (!shapeOk) { failed.push(p); return; }
    const conf = Number.isFinite(Number(ev.confidence)) ? Number(ev.confidence) : 1;
    const hasContent = ev.extractedText.trim().length > 0
      || (ev.equations && ev.equations.length) || (ev.diagrams && ev.diagrams.length);
    if (!hasContent && conf < VISION_MIN_CONFIDENCE) { failed.push(p); return; }
    if (conf < VISION_MIN_CONFIDENCE) lowConfidence.push(p);
    verified++;
  });
  doc.lowConfidencePages = lowConfidence;
  setSourceStatus(doc, SOURCE_STATUS.VERIFYING, { verifiedPages: verified, failedPages: failed, lowConfidencePages: lowConfidence });
  return { verified, failed, lowConfidence };
}

/** PHẦN A6/A11/B: đọc TOÀN BỘ trang PDF scan bằng vision, cache theo trang, retry BOUNDED đúng
 * trang lỗi, rồi VERIFY. Hàm trả về Promise hoàn chỉnh cho CẢ document — nơi gọi PHẢI await.
 * Trang đã có evidence hợp lệ (từ cache/IndexedDB) KHÔNG BAO GIỜ được đọc lại (PHẦN H/TEST 6). */
async function processPdfVisionEvidence(doc) {
  if (!doc.pageImages || !doc.pageImages.length) { finalizeSourceStatus(doc); return doc.processing; }
  doc.pageEvidence = doc.pageEvidence || {};
  setSourceStatus(doc, SOURCE_STATUS.EXTRACTING, { extractionMethod: 'vision', totalPages: doc.pageImages.length });
  syncVisionProgress(doc);

  const needsWork = (img) => {
    const ev = doc.pageEvidence[img.page];
    if (!ev) return true;
    if (ev.ok && ev.extractionVersion === SOURCE_EXTRACTION_VERSION) return false; // CACHE HIT — không gọi lại
    return (ev.attempts || 0) < VISION_PAGE_MAX_ATTEMPTS;
  };

  // Vòng lặp BOUNDED: tối đa VISION_PAGE_MAX_ATTEMPTS lượt, mỗi lượt chỉ xử lý trang còn thiếu.
  for (let attempt = 0; attempt < VISION_PAGE_MAX_ATTEMPTS; attempt++) {
    const pending = doc.pageImages.filter(needsWork);
    if (!pending.length) break;
    await runVisionBatches(doc, pending);
  }

  setSourceStatus(doc, SOURCE_STATUS.VERIFYING);
  verifyVisionEvidence(doc);
  rebuildChunksFromEvidence(doc);
  finalizeSourceStatus(doc);
  persistDocs();
  renderSources();
  return doc.processing;
}
// =====================================================================================
// SourceUploadController — PHẦN B/FIX "Thả tài liệu vào đây" không thêm nguồn (audit 52 phần).
//
// CÁC ĐIỂM RỦI RO CỤ THỂ đã xác định trong event chain cũ (từng nơi tự xử lý khác nhau, không có
// pipeline chung — đúng vấn đề nêu ở PHẦN 1/2):
//   el('dropHint').onclick = () => el('fileInput').click();
//   el('fileInput').onchange = (e) => { handleFiles(e.target.files); closeAddSourcePanel(); e.target.value = ''; };
//   1) Chỉ gọi input.click() trần — một số trình duyệt/mobile không mở picker đáng tin cậy khi
//      input ẩn (display:none) hoặc gọi gián tiếp qua nhiều lớp handler (PHẦN 3 yêu cầu fallback
//      showPicker()).
//   2) closeAddSourcePanel() chạy VÔ ĐIỀU KIỆN ngay sau handleFiles() — không hề biết handleFiles
//      có thật sự nhận được file hợp lệ hay không (handleFiles là async, không được await). Panel
//      đóng dù file bị lỗi, khiến lỗi "biến mất" khỏi tầm nhìn user (PHẦN 6/41: không được silent
//      failure).
//   3) fileInput không có validate: bất kỳ phần mở rộng nào (kể cả .exe) đều bị đẩy thẳng vào
//      handleFiles() → tạo doc, thử parseTxt() trên file nhị phân, fail với lỗi khó hiểu — mà user
//      hoàn toàn không được thông báo lý do (không đúng PHẦN 40/41: phải phân loại lỗi + báo rõ).
//   4) e.target.value = '' được set NGAY sau lời gọi handleFiles() không-await — rủi ro thật với
//      FileList sống nếu handleFiles() có await trước khi kịp đọc xong files (PHẦN 4 yêu cầu rõ:
//      luôn copy FileList thành Array TRƯỚC khi làm bất cứ điều gì khác, kể cả khi hành vi cụ thể
//      của từng trình duyệt có khác nhau — đây là phòng ngừa, không phải chờ tái hiện được bug rồi
//      mới sửa).
//
// FIX: 1 controller trung tâm — mọi entry point (nút, dropzone sidebar, dropzone modal, drag&drop,
// mobile picker) đều đi qua CÙNG 1 pipeline:
//   acceptSourceFiles(files) → normalize (copy FileList→Array NGAY, không giữ tham chiếu sống)
//   → validateSourceFiles() (phân loại UNSUPPORTED_FILE/FILE_TOO_LARGE, báo lỗi rõ, không chặn các
//   file hợp lệ khác) → handleFiles() (đã tự dedupe theo fingerprint + đăng ký source ngay, xem
//   handleFiles() phía trên) → trả kết quả {accepted, rejected} để UI quyết định đóng panel (CHỈ khi
//   accepted.length > 0) hay giữ panel mở kèm cảnh báo. input.value chỉ reset SAU KHI đã copy xong
//   FileList thành mảng thường — xem test/source-upload-picker.test.js để có bằng chứng hành vi.
// =====================================================================================
const SOURCE_ALLOWED_EXT = ['pdf', 'docx', 'txt'];
const SOURCE_MAX_FILE_BYTES = 50 * 1024 * 1024; // 50MB — trần hợp lý phía client, khác trần bảo mật server
const SOURCE_UPLOAD_DEBUG = /[?&]debug=1\b/.test(location.search) || /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
function sourceUploadLog(...args) { if (SOURCE_UPLOAD_DEBUG) console.log('[source-upload]', ...args); }

/** PHẦN 3: fallback picker an toàn — showPicker() nếu trình duyệt hỗ trợ (một số trình duyệt/mobile
 * không mở picker đáng tin cậy với .click() khi gọi gián tiếp qua nhiều lớp handler), rơi về
 * .click() nếu không. Mọi entry point PHẢI gọi hàm này thay vì tự gọi fileInput.click() rải rác. */
function openSourceFilePicker(entry) {
  sourceUploadLog(`entry=${entry || 'unknown'}`);
  const input = el('fileInput');
  if (!input) return;
  try {
    if (typeof input.showPicker === 'function') { input.showPicker(); return; }
  } catch (e) { /* một số trình duyệt throw nếu gọi ngoài user-gesture hoặc chưa hỗ trợ — rơi xuống .click() */ }
  input.click();
}

/** Kiểm tra hợp lệ TỪNG file trước khi đưa vào handleFiles(): đúng định dạng + không vượt kích
 * thước. Trả {accepted:File[], rejected:{file,reason}[]} — KHÔNG throw, để 1 file lỗi không chặn
 * các file hợp lệ khác trong cùng lượt chọn. */
function validateSourceFiles(fileArray) {
  const accepted = [];
  const rejected = [];
  for (const file of fileArray) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!SOURCE_ALLOWED_EXT.includes(ext)) { rejected.push({ file, reason: 'UNSUPPORTED_FILE' }); continue; }
    if (file.size > SOURCE_MAX_FILE_BYTES) { rejected.push({ file, reason: 'FILE_TOO_LARGE' }); continue; }
    accepted.push(file);
  }
  return { accepted, rejected };
}

/** Pipeline chuẩn DUY NHẤT cho mọi nguồn upload (PHẦN 2). Nhận File[] hoặc FileList (đã được copy
 * thành mảng thường bởi caller — xem normalizeSourceFileList()), validate, rồi giao cho
 * handleFiles() (nơi đăng ký source ngay + dedupe theo fingerprint + bắt đầu ingest nền). */
async function acceptSourceFiles(fileArray, entry) {
  const files = Array.from(fileArray || []);
  sourceUploadLog(`files-selected count=${files.length}`, entry ? `entry=${entry}` : '');
  if (!files.length) return { accepted: [], rejected: [] };
  const { accepted, rejected } = validateSourceFiles(files);
  sourceUploadLog(`accepted count=${accepted.length}`, `rejected count=${rejected.length}`);
  if (rejected.length) {
    const names = rejected.map((r) => r.file.name).slice(0, 5).join(', ');
    alert(`Không thể thêm ${rejected.length} file (${names}${rejected.length > 5 ? '…' : ''}): chỉ hỗ trợ PDF/DOCX/TXT, tối đa 50MB mỗi file.`);
  }
  if (accepted.length) {
    try {
      await handleFiles(accepted);
    } catch (e) {
      console.error('[source-upload] SOURCE_REGISTER_ERROR', e);
      alert('Không thể thêm nguồn. Vui lòng thử lại.');
      return { accepted: [], rejected: [...rejected, ...accepted.map((file) => ({ file, reason: 'SOURCE_REGISTER_ERROR' }))] };
    }
  }
  return { accepted, rejected };
}

/** PHẦN 4: copy FileList thành Array THẬT SỰ ngay khi còn sống (trước khi input.value bị reset ở
 * bất kỳ đâu) — đây là fix cho root cause đã nêu ở trên. */
function normalizeSourceFileList(fileList) {
  return Array.from(fileList || []);
}

// --- Entry point 1: nút "+ Thêm nguồn" → mở panel (PHẦN B1, không đổi hành vi) ---
el('addSourceBtn').onclick = (e) => openAddSourcePanel(e.currentTarget);

// --- Entry point 2: click/drag&drop vùng "Thả tài liệu vào đây" ở sidebar ---
el('dropHint').addEventListener('click', () => openSourceFilePicker('sidebar-click'));
el('dropHint').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSourceFilePicker('sidebar-key'); }
});
['dragover', 'dragleave', 'drop'].forEach((evt) => {
  el('dropHint').addEventListener(evt, (e) => {
    e.preventDefault();
    el('dropHint').classList.toggle('dragover', evt === 'dragover');
    if (evt === 'drop' && e.dataTransfer && e.dataTransfer.files.length) {
      acceptSourceFiles(normalizeSourceFileList(e.dataTransfer.files), 'sidebar-drop');
    }
  });
});

// --- Entry point 3: <input type=file> dùng chung cho MỌI picker (sidebar + modal) ---
// FIX ROOT CAUSE: copy files thành mảng NGAY trong handler đồng bộ (trước khi có bất kỳ await nào
// chen vào), rồi mới gọi acceptSourceFiles() bất đồng bộ. Panel CHỈ đóng khi thật sự có ít nhất 1
// file được chấp nhận (PHẦN 6) — file không hợp lệ hoặc lỗi register thì GIỮ PANEL MỞ để user thấy
// lỗi và thử lại. input.value chỉ reset SAU KHI đã copy xong (PHẦN 4).
el('fileInput').onchange = (e) => {
  const files = normalizeSourceFileList(e.target.files);
  e.target.value = ''; // an toàn: files đã được copy thành mảng thường ở dòng trên, reset ở đây
                        // không còn nguy cơ làm rỗng dữ liệu đang được acceptSourceFiles() xử lý.
  acceptSourceFiles(files, 'file-input').then((result) => {
    if (result.accepted.length > 0) closeAddSourcePanel();
  });
};

// --- Entry point 4: dropzone bên trong modal "Thêm nguồn" — click/Enter/Space mở picker, kéo-thả
// file trực tiếp vào modal cũng hoạt động (PHẦN B1/B9, PHẦN 5). ---
if (el('addSourceDropZone')) {
  const dz = el('addSourceDropZone');
  dz.addEventListener('click', () => openSourceFilePicker('modal-click'));
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSourceFilePicker('modal-key'); } });
  ['dragover', 'dragleave', 'drop'].forEach((evt) => {
    dz.addEventListener(evt, (e) => {
      e.preventDefault();
      dz.classList.toggle('dragover', evt === 'dragover');
      if (evt === 'drop' && e.dataTransfer && e.dataTransfer.files.length) {
        acceptSourceFiles(normalizeSourceFileList(e.dataTransfer.files), 'modal-drop').then((result) => {
          if (result.accepted.length > 0) closeAddSourcePanel();
        });
      }
    });
  });
}
// PHẦN B10 (accessibility): đóng bằng nút ✕, click ra ngoài backdrop, hoặc phím Esc.
if (el('addSourceCloseBtn')) el('addSourceCloseBtn').onclick = closeAddSourcePanel;
if (el('addSourceOverlay')) {
  el('addSourceOverlay').addEventListener('click', (e) => { if (e.target.id === 'addSourceOverlay') closeAddSourcePanel(); });
  el('addSourceOverlay').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAddSourcePanel(); });
}

/* ================= Ảnh đính kèm ================= */
/**
 * ROOT CAUSE (preview ảnh không hiện trên mobile): bản cũ dựng preview bằng
 * `<img src="dataURL">` VÀ CHỈ gọi renderImagePreview() SAU KHI đã await xong 2 bước tuần tự —
 * FileReader.readAsDataURL(file) rồi window.chatImageStore.save() (ghi IndexedDB). Trên mobile,
 * ngay sau khi đóng file-picker/camera gốc của OS, WebKit (iOS Safari) có bug đã biết: tab vừa được
 * đưa từ nền trở lại có thể khiến transaction IndexedDB treo vô thời hạn (không resolve, không
 * reject) — vì loadImageFile() await tuần tự nên preview không bao giờ được render, không có lỗi,
 * không có gì xảy ra cả (đúng triệu chứng: "chọn ảnh xong nhưng preview không hiện"). Kèm theo đó,
 * ảnh chụp từ camera thường vài MB → base64 dài hàng triệu ký tự, một số mobile browser xử lý
 * data:-URI khổng lồ trong <img src> kém ổn định hơn hẳn desktop.
 *
 * FIX: tách hẳn 3 việc độc lập, không còn việc nào chặn việc nào:
 *   1) PREVIEW: dùng `URL.createObjectURL(file)` (blob:) — tạo NGAY, đồng bộ, render NGAY LẬP TỨC,
 *      không phụ thuộc FileReader hay IndexedDB.
 *   2) BASE64 (để gửi AI): đọc song song bằng FileReader, có timeout để không bao giờ treo vô hạn.
 *   3) PERSISTENCE (IndexedDB, để khôi phục sau F5): lưu song song, cũng có timeout; nếu lỗi/treo,
 *      preview và việc gửi ảnh của LƯỢT NÀY vẫn hoạt động bình thường — chỉ mất khả năng khôi phục
 *      sau reload cho riêng ảnh đó (đã có sẵn UI cảnh báo "legacy" cho trường hợp này, xem loadConversation()).
 * `imageLoadSeq` dùng để mọi Promise trễ (từ ảnh đã bị thay/xoá) tự nhận biết bị "hết hạn" và không
 * ghi đè state mới hơn (mục 11: race condition).
 */
let imageLoadSeq = 0;

function revokeImagePreviewUrl(url) {
  if (!url || typeof url !== 'string') return;
  if (!url.startsWith('blob:')) return; // chỉ revoke Object URL do chính app tạo ra, không đụng data:/khác
  try { URL.revokeObjectURL(url); } catch (_) { /* no-op */ }
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label || 'timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const m = String(reader.result || '').match(/^data:(.*?);base64,(.*)$/);
      if (!m) { reject(new Error('unexpected_reader_result')); return; }
      resolve({ mediaType: m[1], base64: m[2] });
    };
    reader.onerror = () => reject(reader.error || new Error('file_read_failed'));
    try { reader.readAsDataURL(file); } catch (e) { reject(e); }
  });
}

// Một số trình duyệt/OS mobile (đặc biệt Android với ảnh lấy qua content:// URI) có thể trả về
// file.type rỗng dù đây vẫn là ảnh hợp lệ — không được từ chối oan chỉ vì thiếu MIME, đoán thêm
// bằng phần mở rộng tên file trước khi từ chối hẳn.
const IMAGE_EXT_MEDIA_TYPE = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif', svg: 'image/svg+xml'
};
function guessImageMediaType(file) {
  if (file.type && file.type.startsWith('image/')) return file.type;
  const ext = (file.name || '').split('.').pop().toLowerCase();
  return IMAGE_EXT_MEDIA_TYPE[ext] || null;
}

el('attachBtn').onclick = () => el('imageInput').click();
el('imageInput').onchange = (e) => {
  loadImageFile(e.target.files[0]);
  e.target.value = '';
};

async function loadImageFile(file) {
  if (!file) return;
  const guessedMediaType = guessImageMediaType(file);
  if (!guessedMediaType) { alert('Chỉ hỗ trợ dán/đính kèm file ảnh.'); return; }
  // PHẦN G: MỘT chính sách MIME duy nhất với server. TRƯỚC ĐÂY giao diện nhận cả BMP/HEIC/HEIF/SVG
  // (bảng IMAGE_EXT_MEDIA_TYPE) rồi backend mới từ chối — người dùng chỉ thấy "lỗi" sau khi đã chờ.
  const PB = window.PayloadBudget;
  const kind = PB ? PB.classifyImageType(guessedMediaType) : 'accepted';
  if (kind === 'rejected' && guessedMediaType === 'image/svg+xml') {
    alert('Ảnh SVG không được hỗ trợ (không phải ảnh raster). Hãy xuất sang PNG/JPEG rồi đính kèm lại.');
    return;
  }
  if (kind === 'rejected') { alert('Định dạng ảnh này không được hỗ trợ (chỉ nhận PNG/JPEG/WEBP/GIF).'); return; }

  // Ảnh pending trước đó (chưa gửi) bị thay thế bởi ảnh mới này — dọn preview URL + record IndexedDB
  // cũ ngay, tránh rác "orphan" (mục 9). Tăng seq để mọi Promise dở dang của ảnh cũ tự bỏ qua khi
  // resolve trễ (mục 11).
  const oldPending = state.pendingImage;
  const seq = ++imageLoadSeq;
  if (oldPending) {
    revokeImagePreviewUrl(oldPending.previewUrl);
    if (oldPending.imageId) window.chatImageStore && window.chatImageStore.delete(oldPending.imageId).catch(() => {});
  }

  // BƯỚC 1 — PREVIEW: đồng bộ, tức thì, không chờ gì cả. Đây là fix chính cho bug mobile.
  let previewUrl;
  try {
    previewUrl = URL.createObjectURL(file);
  } catch (e) {
    console.error('[image] tạo Object URL thất bại:', e);
    alert('Không thể xem trước ảnh này, vui lòng thử ảnh khác.');
    return;
  }
  state.pendingImage = {
    seq, file, previewUrl,
    mediaType: guessedMediaType,
    base64: null,
    imageId: null,
    status: 'loading', // 'loading' -> 'ready' | 'error'
  };
  renderImagePreview();
  console.debug('[image] file selected', { type: file.type, size: file.size });

  if (!window.chatImageStore) {
    // Không có IndexedDB (private mode / trình duyệt cũ): vẫn cho xem trước & gửi trong phiên này,
    // chỉ không khôi phục được sau F5 — không chặn hẳn người dùng vì lý do đó (mục 6).
    console.warn('[image] IndexedDB không khả dụng — bỏ qua persistence, vẫn cho phép gửi trong phiên này.');
  }

  // BƯỚC 2 & 3 — chạy song song, có timeout để không bao giờ treo vô hạn (fix bug IndexedDB
  // treo trên iOS Safari sau khi quay lại từ photo picker).
  const base64Task = withTimeout(readFileAsBase64(file), 20000, 'read_timeout')
    .then((r) => ({ ok: true, value: r }))
    .catch((e) => ({ ok: false, error: e }));
  const rawSavePromise = window.chatImageStore
    ? window.chatImageStore.save(file, { mediaType: guessedMediaType })
    : Promise.reject(new Error('indexedDB_unavailable'));
  const saveTask = withTimeout(rawSavePromise, 12000, 'save_timeout')
    .then((id) => ({ ok: true, value: id }))
    .catch((e) => ({ ok: false, error: e }));

  const [base64Result, saveResult] = await Promise.all([base64Task, saveTask]);

  // PHẦN A5: ảnh máy ảnh điện thoại thường 3-8MB — nếu gửi nguyên trạng thì request chắc chắn 413.
  // Nén/thu nhỏ NGAY TRONG TRÌNH DUYỆT (hạ chất lượng trước, chỉ thu nhỏ khi buộc phải) cho tới khi
  // vừa ngân sách; HEIC/HEIF/AVIF/TIFF trình duyệt không decode được -> báo rõ, không gửi mù.
  if (PB && base64Result.ok) {
    const wire = PB.base64WireBytes(base64Result.value.base64);
    if (wire > PB.MAX_DIRECT_IMAGE_BYTES || kind === 'transcode_required') {
      const shrunk = await PB.compressImageToBudget(file, PB.MAX_DIRECT_IMAGE_BYTES);
      if (shrunk.ok) {
        base64Result.value = { mediaType: shrunk.mediaType, base64: shrunk.base64 };
      } else {
        base64Result.ok = false;
        base64Result.error = new Error(shrunk.reason === 'transcode_required'
          ? 'Định dạng ảnh này (HEIC/HEIF) cần chuyển sang PNG/JPEG trước khi gửi.'
          : 'Ảnh quá lớn và không thể nén đủ nhỏ. Hãy chụp/chọn ảnh nhỏ hơn.');
        base64Result.explicitMessage = true;
      }
    }
  }


  // save_timeout không có nghĩa là chatImageStore.save() đã thất bại thật — có thể nó chỉ chậm/từng
  // bị treo do bug WebKit rồi tự thông sau đó. Nếu sau này rawSavePromise VẪN resolve, gắn lại
  // imageId trễ cho đúng ảnh (theo seq) nếu còn đang pending, tránh mất khả năng khôi phục sau F5
  // (rủi ro còn sót lại: "IndexedDB fail → mất persistence" — nay chỉ mất khi rawSavePromise thật sự
  // không bao giờ resolve, chứ không mất oan vì timeout race). Nếu ảnh đã bị gửi/xoá/thay trước khi
  // lưu xong, record trễ này không còn được tham chiếu bởi bất kỳ đâu — xoá luôn, tránh rác "orphan
  // image" nằm vĩnh viễn trong IndexedDB (mục 9).
  if (!saveResult.ok) {
    rawSavePromise.then((lateId) => {
      if (state.pendingImage && state.pendingImage.seq === seq && !state.pendingImage.imageId) {
        state.pendingImage.imageId = lateId;
        console.debug('[image] IndexedDB saved (late, sau khi đã timeout)');
      } else if (window.chatImageStore) {
        window.chatImageStore.delete(lateId).catch(() => {});
      }
    }).catch(() => { /* thật sự lỗi/không bao giờ resolve — đã soft-fail từ trước, không còn gì để làm thêm */ });
  }

  // Ảnh này đã bị thay/xoá trong lúc đang xử lý — bỏ kết quả trễ, dọn dẹp record IndexedDB vừa lỡ
  // lưu (nếu có) để không rò rỉ dữ liệu không còn được tham chiếu (mục 11 + mục 9).
  if (state.pendingImage === null || state.pendingImage.seq !== seq) {
    if (saveResult.ok) window.chatImageStore && window.chatImageStore.delete(saveResult.value).catch(() => {});
    return;
  }

  if (!base64Result.ok) {
    console.error('[image] đọc base64 thất bại/timeout:', base64Result.error);
    state.pendingImage.status = 'error';
    state.pendingImage.errorMessage = base64Result.explicitMessage
      ? base64Result.error.message
      : 'Không đọc được ảnh này (định dạng không được hỗ trợ hoặc file lỗi). Vui lòng chọn ảnh khác.';
    if (saveResult.ok) window.chatImageStore && window.chatImageStore.delete(saveResult.value).catch(() => {});
    renderImagePreview();
    console.debug('[image] preview failed');
    return;
  }

  state.pendingImage.base64 = base64Result.value.base64;
  state.pendingImage.mediaType = base64Result.value.mediaType || guessedMediaType;

  if (saveResult.ok) {
    state.pendingImage.imageId = saveResult.value;
    console.debug('[image] IndexedDB saved');
  } else {
    console.warn('[image] lưu IndexedDB thất bại/timeout — ảnh vẫn gửi được ở lượt này, chỉ không khôi phục được sau F5:', saveResult.error);
  }

  state.pendingImage.status = 'ready';
  renderImagePreview();
  console.debug('[image] preview ready');
}

// ---------- Kéo-thả ảnh (drag & drop) từ máy thẳng vào khung soạn tin nhắn ----------
// Cho phép kéo 1 file ảnh từ Explorer/Finder (hoặc từ tab khác của trình duyệt) rồi thả trực tiếp
// vào khung chat để đính kèm làm ảnh đề bài — thêm một cách "tải ảnh từ máy" trực quan, song song với
// nút đính kèm (chọn file) và dán ảnh (Ctrl+V) đã có sẵn ở trên, dùng chung hàm loadImageFile().
const composerEl = el('composer');
let dragDepth = 0; // đếm số lần dragenter lồng nhau (do phần tử con) để tránh dropzone nhấp nháy khi kéo qua các con bên trong #composer
composerEl.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  composerEl.classList.add('composer-dragover');
});
composerEl.addEventListener('dragover', (e) => {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
composerEl.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) composerEl.classList.remove('composer-dragover');
});
composerEl.addEventListener('drop', (e) => {
  if (!e.dataTransfer) return;
  e.preventDefault();
  dragDepth = 0;
  composerEl.classList.remove('composer-dragover');
  const files = Array.from(e.dataTransfer.files || []);
  const imgFile = files.find((f) => f.type && f.type.startsWith('image/'));
  if (imgFile) loadImageFile(imgFile);
  else if (files.length) alert('Chỉ hỗ trợ kéo-thả file ảnh vào đây (muốn nạp PDF/DOCX/TXT làm nguồn tài liệu, dùng mục "Nguồn" ở thanh bên).');
});

// ---------- Dán ảnh (Ctrl+V / Cmd+V) thẳng vào khung chat để hỏi ----------
// Cho phép dán ảnh đã sao chép từ nơi khác (ảnh chụp màn hình, ảnh trong trình duyệt/Word/Zalo...)
// trực tiếp vào ô nhập câu hỏi mà không cần lưu ra file rồi bấm nút đính kèm — nếu clipboard có
// nhiều loại dữ liệu (vd vừa có ảnh vừa có văn bản mô tả), ưu tiên nhận ảnh và vẫn giữ nguyên phần
// văn bản đã gõ sẵn trong ô (không xoá nội dung câu hỏi đang có).
function handlePasteImage(e) {
  const items = (e.clipboardData || window.clipboardData) && (e.clipboardData || window.clipboardData).items;
  if (!items) return;
  for (const item of items) {
    if (item.kind === 'file' && item.type && item.type.startsWith('image/')) {
      e.preventDefault(); // tránh trình duyệt dán kèm tên file ngẫu nhiên vào ô văn bản
      loadImageFile(item.getAsFile());
      el('qInput').focus();
      break;
    }
  }
}
el('qInput').addEventListener('paste', handlePasteImage);
// Cũng lắng nghe trên toàn bộ khung soạn tin (không chỉ riêng textarea) — để dán ảnh vẫn hoạt động
// dù người dùng vừa bấm vào nút đính kèm/nút chế độ suy nghĩ (focus không còn ở #qInput).
el('composer').addEventListener('paste', handlePasteImage);

// Dựng DOM bằng createElement (không dùng innerHTML với URL nội suy) — an toàn hơn và cho phép gắn
// onload/onerror trên chính <img> để biết chắc preview có hiển thị được hay không (mục 3), thay vì
// giả định blob: URL luôn decode được (ảnh HEIC/định dạng lạ trên 1 số trình duyệt có thể không).
function renderImagePreview() {
  const wrap = el('imgPreviewWrap');
  const pending = state.pendingImage;
  el('attachBtn').classList.toggle('has-image', !!pending);
  wrap.innerHTML = '';
  if (!pending) return;

  const chip = document.createElement('div');
  chip.className = 'img-chip show' + (pending.status === 'loading' ? ' loading' : '') + (pending.status === 'error' ? ' error' : '');

  const img = document.createElement('img');
  img.alt = 'Ảnh đề bài';
  img.onload = () => { console.debug('[image] preview loaded'); };
  img.onerror = () => {
    // Blob URL không decode được (định dạng ảnh trình duyệt không hỗ trợ hiển thị, vd 1 số HEIC) —
    // không crash app, báo lỗi thân thiện, KHÔNG xoá pendingImage để người dùng còn thấy trạng thái
    // lỗi, và cho phép bấm ✕ chọn lại ảnh khác (mục 3 + mục 4).
    console.error('[image] preview render failed (không decode được ảnh)');
    if (state.pendingImage === pending) {
      pending.status = 'error';
      pending.errorMessage = pending.errorMessage || 'Trình duyệt không hiển thị được ảnh này (có thể do định dạng không được hỗ trợ). Vui lòng chọn ảnh khác.';
      renderImagePreview();
    }
  };
  img.src = pending.previewUrl;
  chip.appendChild(img);

  const label = document.createElement('span');
  label.className = 'chip-label';
  if (pending.status === 'error') label.textContent = pending.errorMessage || 'Không thể xem trước ảnh này.';
  else if (pending.status === 'loading') label.textContent = 'Đang xử lý ảnh…';
  else label.textContent = 'Ảnh đề bài đã đính kèm';
  chip.appendChild(label);

  const rmBtn = document.createElement('button');
  rmBtn.type = 'button';
  rmBtn.className = 'rm';
  rmBtn.textContent = '✕';
  rmBtn.onclick = () => {
    // Tăng seq để loại bỏ mọi kết quả FileReader/IndexedDB đang xử lý dở của ảnh này (mục 11), rồi
    // dọn preview URL + record IndexedDB (nếu đã lỡ lưu) — tránh rác "orphan image" (mục 9).
    imageLoadSeq++;
    revokeImagePreviewUrl(pending.previewUrl);
    if (pending.imageId && window.chatImageStore) window.chatImageStore.delete(pending.imageId).catch(() => {});
    state.pendingImage = null;
    renderImagePreview();
  };
  chip.appendChild(rmBtn);

  wrap.appendChild(chip);
}

/* ================= Truy hồi ngữ cảnh từ nguồn (SOURCE-COMPLETE / RETRIEVAL-COMPLETE — PHẦN A) =================
 * TRƯỚC: retrieveContext(query, 4) luôn cắt CỨNG còn 4 đoạn bất kể tài liệu dài bao nhiêu — ROOT
 * CAUSE khiến PDF nhiều trang chỉ có vài đoạn khớp từ khóa nhất được gửi cho AI, các bài nằm ở trang
 * khác/mục khác coi như KHÔNG TỒN TẠI (đúng triệu chứng mô tả ở mục A1: "giải từ bài 1.7 đến 1.11"
 * nhưng hệ thống chỉ gửi 1-4 đoạn rồi AI kết luận "không có đề bài"). Đổi `limit` số cứng thành 1 TRẦN
 * AN TOÀN kỹ thuật (DEFAULT_RETRIEVAL_CAP/SOURCE_COMPLETE_CAP — chỉ để tránh 1 tài liệu cực lớn làm
 * phình payload quá mức, KHÔNG phải để "đại diện" cho cả tài liệu), và hàm tự chọn 1 trong 3 chế độ:
 *   1) SOURCE-COMPLETE: câu hỏi xin "toàn bộ tài liệu" -> trả về TẤT CẢ chunk của các nguồn active.
 *   2) REQUIREMENT COVERAGE (mục A4): câu hỏi có NHIỀU yêu cầu cụ thể ("giải bài 1.7 đến 1.11") ->
 *      với TỪNG nhãn yêu cầu, gom mọi chunk có nhắc tới đúng nhãn đó (không chỉ "4 đoạn điểm cao
 *      nhất rồi dừng") — nhờ vậy 1 yêu cầu nằm ở trang 50 vẫn được lấy dù trang 1 khớp từ khóa hơn.
 *   3) Mặc định: vẫn ưu tiên đoạn khớp từ khóa cao nhất, nhưng KHÔNG cắt cứng ở 4 — lấy hết các đoạn
 *      có điểm > 0 tới trần DEFAULT_RETRIEVAL_CAP (cap này CAO hơn hẳn mức "vài đoạn" trước đây).
 * `limit` tham số cũ vẫn được chấp nhận (tương thích ngược) nhưng chỉ còn tác dụng NÂNG trần, không
 * còn tác dụng ép về đúng 1 số nhỏ như trước.
 */
const SOURCE_COMPLETE_CAP = 400;   // trần kỹ thuật (tránh phình payload/crash trình duyệt), không phải "limit nội dung"
const DEFAULT_RETRIEVAL_CAP = 40;  // trước đây mặc định là 4 — nay chỉ là trần AN TOÀN, không phải mức bình thường
// PHẦN H/P: trần KÝ TỰ cho toàn bộ contexts 1 request. Đây là thứ giữ token thấp — chúng ta index
// TOÀN BỘ nguồn 1 lần lúc upload, nhưng MỖI CÂU HỎI chỉ gửi đúng evidence cần thiết.
const RETRIEVAL_CHAR_BUDGET = 60000;        // ~18-20k token cho câu hỏi thường
const SOURCE_COMPLETE_CHAR_BUDGET = 120000; // chế độ "toàn bộ tài liệu" được nới, vẫn có trần
const PER_REQUIREMENT_EVIDENCE_CAP = 8;     // mỗi yêu cầu lấy tối đa ngần này evidence trước khi sang tầng 2
const NEIGHBOR_RADIUS = 1;                  // tầng 3: lấy chunk liền trước/liền sau

function isFullSourceRequest(query) {
  return /(toàn bộ|tất cả|cả\s+(tài liệu|pdf|file)|hết\s+(tài liệu|pdf|file)|full\s+(source|document|pdf))/i.test(query || '');
}

/* ---------- PHẦN O: NORMALIZE để hết false-negative ----------
 * retrieveContext() cũ dùng substring thô trên chuỗi chưa chuẩn hoá: "1,9" không khớp "1.9", dấu
 * gạch ngang – — − không khớp -, Unicode tổ hợp không khớp Unicode dựng sẵn. Hệ quả: chunk CHỨA
 * ĐÚNG bài 1.9 bị thua chunk chỉ chứa chữ "bài". Chuẩn hoá 1 lần, dùng chung mọi nơi. */
function normalizeForMatch(str) {
  let s = String(str == null ? '' : str);
  try { s = s.normalize('NFC'); } catch (e) { /* môi trường không hỗ trợ -> dùng nguyên bản */ }
  return s
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, '-')   // – — ‒ − ... -> -
    .replace(/[\u2018\u2019\u201C\u201D]/g, "'")
    .replace(/(\d)\s*,\s*(\d)/g, '$1.$2')      // "1,9" -> "1.9" (dạng số VN)
    .replace(/\s+/g, ' ')
    .trim();
}
function normalizeLabel(label) {
  return normalizeForMatch(label).replace(/\s+/g, '');
}

// Nhận diện các "yêu cầu" cụ thể trong câu hỏi (mục A4/PHẦN O): số bài dạng "1.9", khoảng
// "1.9 đến 1.11" / "1.9-1.11" / "câu 3 đến câu 8", hoặc liệt kê rời rạc "bài 1.7, 1.8, 1.9".
function extractRequirementLabels(query) {
  const labels = new Set();
  const q = normalizeForMatch(query);
  const rangeRe = /(?:bài|câu|ví dụ|exercise)?\s*(\d+(?:\.\d+)?)\s*(?:-|đến|tới|to)\s*(?:bài|câu)?\s*(\d+(?:\.\d+)?)/gi;
  let m;
  while ((m = rangeRe.exec(q))) {
    const a = m[1], b = m[2];
    if (a.includes('.') && b.includes('.')) {
      const aParts = a.split('.').map(Number);
      const bParts = b.split('.').map(Number);
      if (aParts[0] === bParts[0] && Number.isFinite(aParts[1]) && Number.isFinite(bParts[1]) && bParts[1] >= aParts[1] && (bParts[1] - aParts[1]) < 60) {
        for (let i = aParts[1]; i <= bParts[1]; i++) labels.add(`${aParts[0]}.${i}`);
        continue;
      }
    }
    const aNum = Number(a), bNum = Number(b);
    if (Number.isFinite(aNum) && Number.isFinite(bNum) && bNum >= aNum && (bNum - aNum) < 60 && Number.isInteger(aNum) && Number.isInteger(bNum)) {
      for (let i = aNum; i <= bNum; i++) labels.add(String(i));
      continue;
    }
    labels.add(a); labels.add(b);
  }
  const listRe = /(?:bài|câu|ví dụ|mục)\s*(\d+(?:\.\d+)?)/gi;
  while ((m = listRe.exec(q))) labels.add(m[1]);
  // Nhãn dạng "1.9" đứng một mình (không có từ "bài"/"câu" phía trước) vẫn là yêu cầu rõ ràng.
  const bareRe = /(?:^|[^\d.])(\d+\.\d+)(?![\d.])/g;
  while ((m = bareRe.exec(q))) labels.add(m[1]);
  return Array.from(labels);
}

/** Regex khớp nhãn yêu cầu trong text đã normalize.
 * Hai bẫy phải tránh CÙNG LÚC:
 *   - "1.1" KHÔNG được khớp bên trong "1.10" (khác bài hoàn toàn)  -> chặn chữ số ngay sau nhãn
 *   - "1.9" PHẢI khớp trong "Bài 1.9. Giải..."                     -> dấu chấm câu ngay sau nhãn là hợp lệ
 * Lookahead `(?!\.?\d)` giải quyết cả hai: cấm chữ số liền sau và cấm ".<chữ số>", nhưng cho phép
 * "." đứng cuối câu. Bản cũ dùng `([^\d.]|$)` nên trượt đúng trường hợp phổ biến nhất của đề Việt.
 */
function requirementRegex(label) {
  const esc = normalizeLabel(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\d.])${esc}(?!\\.?\\d)`);
}

/** PHẦN VIII (kiến trúc mới): gom evidence từ mọi nguồn USABLE NOW — không chỉ nguồn ĐÃ fully
 * verified (READY). Điều kiện là "source usable AND evidence valid" (mục VIII của audit), KHÔNG còn
 * `filter(isSourceReady)` đơn thuần — đó chính là root cause làm mất lợi thế evidence đã có trong
 * lúc nguồn còn processing nền (mục II.C). Vẫn loại TUYỆT ĐỐI chunk placeholder và chunk có
 * extractionStatus lỗi — evidence phải THẬT, không được suy đoán/giả vờ (TEST 13). */
function collectAvailableEvidence(query) {
  const qWords = (normalizeForMatch(query).match(/[\p{L}\p{N}.]+/gu) || []).filter((w) => w.length > 2);
  const usableDocs = (state.docs || []).filter(isSourceUsableNow);
  const out = [];
  usableDocs.forEach((doc) => {
    const ps = ensureSourceProcessingState(doc);
    (doc.chunks || []).forEach((ch) => {
      if (ch[SOURCE_PLACEHOLDER_FLAG]) return;                    // KHÔNG BAO GIỜ gửi placeholder cho AI
      if (ch.extractionStatus && ch.extractionStatus !== 'ok') return; // chunk lỗi -> loại
      const norm = normalizeForMatch(ch.text);
      let score = 0;
      qWords.forEach((w) => { if (norm.includes(w)) score += 1; });
      out.push({
        doc: doc.name, id: ch.id, text: ch.text, garbled: !!ch.garbled, score,
        page: ch.page != null ? ch.page : null,
        startPage: ch.startPage != null ? ch.startPage : null,
        endPage: ch.endPage != null ? ch.endPage : null,
        chunkIndex: ch.chunkIndex || null, totalChunks: ch.totalChunks || null,
        sourceId: doc.id,
        evidenceId: ch.evidenceId || `${doc.id}:c${ch.id}`,
        extractionMethod: ch.extractionMethod || ps.extractionMethod || 'text',
        extractionStatus: 'ok',
        _norm: norm
      });
    });
  });
  return out;
}
// Tên cũ giữ lại làm alias — vài chỗ (test cũ, code ngoài) có thể còn gọi collectReadyChunks(); hành
// vi bên trong giờ là "available now", KHÔNG còn nghĩa "chỉ nguồn 100% READY" (xem PHẦN VIII ở trên).
function collectReadyChunks(query) { return collectAvailableEvidence(query); }

function stripInternal(c) {
  const out = Object.assign({}, c);
  delete out._norm;
  delete out.score;
  return out;
}

/** PHẦN P: khi vượt trần ký tự, KHÔNG cắt bớt evidence (mất yêu cầu) mà rút gọn NỘI DUNG từng
 * evidence thành bản tóm gọn có đánh dấu truncated — server/AI vẫn thấy đủ trang/đủ yêu cầu. */
function fitToCharBudget(list, budget) {
  const total = list.reduce((a, c) => a + c.text.length, 0);
  if (total <= budget || !list.length) return list.map(stripInternal);
  const per = Math.max(240, Math.floor(budget / list.length));
  return list.map((c) => {
    const out = stripInternal(c);
    if (out.text.length > per) {
      out.text = out.text.slice(0, per) + '…';
      out.truncated = true; // validators/sourceCoverage sẽ coi đây là EXCERPT, không kết luận "nguồn không có"
    }
    return out;
  });
}

/* ================= Truy hồi ngữ cảnh từ nguồn — RETRIEVAL 3 TẦNG (PHẦN G/O) =================
 * TẦNG 1 — Exact requirement retrieval: mọi nhãn yêu cầu ("bài 1.9", "câu 3", "trang 72") PHẢI có
 *          evidence RIÊNG của nó. Đây là tầng ưu tiên cao nhất và luôn được xếp LÊN ĐẦU.
 * TẦNG 2 — semantic/keyword relevance cho phần còn lại của câu hỏi.
 * TẦNG 3 — neighbor context: chunk liền trước/liền sau các evidence tầng 1 (đề bài thường nằm vắt
 *          qua ranh giới chunk/trang).
 * Không có top-k mù (`slice(0,4)`), cũng KHÔNG gửi cả tài liệu mỗi lượt — trần là ngân sách ký tự.
 */
function retrieveContext(query, limit) {
  const all = collectAvailableEvidence(query);
  if (!all.length) return Object.assign([], { requirementLabels: [], matchedRequirementLabels: [], unmatchedRequirementLabels: [] });

  // Chế độ SOURCE-COMPLETE: người dùng xin "toàn bộ tài liệu" -> giữ ĐỦ số evidence (không bỏ sót
  // phần nào), nội dung được rút gọn theo ngân sách nếu quá lớn (PHẦN P).
  if (isFullSourceRequest(query)) {
    return Object.assign(fitToCharBudget(all.slice(0, SOURCE_COMPLETE_CAP), SOURCE_COMPLETE_CHAR_BUDGET),
      { requirementLabels: [], matchedRequirementLabels: [], unmatchedRequirementLabels: [] });
  }

  const picked = new Map();
  const keyOf = (c) => `${c.sourceId}:${c.id}`;
  const add = (c, tier, requirement) => {
    const k = keyOf(c);
    if (picked.has(k)) return;
    picked.set(k, Object.assign({}, c, { retrievalTier: tier, requirement: requirement || null }));
  };

  // ---------- TẦNG 1: exact requirement + trang được chỉ đích danh ----------
  // ROOT CAUSE THẬT (phát hiện từ báo lỗi thực tế — user hỏi "giải 1.9 đến 1.11", nguồn CÓ trang
  // thật nhưng KHÔNG chunk nào chứa literal "1.9" đúng dạng, ví dụ OCR/format khác đi). Bản cũ khi
  // TẦNG 1 rỗng cho 1 nhãn thì ÂM THẦM rơi xuống TẦNG 2 (keyword chung cho cả câu hỏi) — và TẦNG 2
  // có thể khớp một đoạn HOÀN TOÀN KHÁC chủ đề (vd "hệ thức Chasles" ở mục trước đó trong CÙNG bài,
  // trùng từ khoá "góc lượng giác") rồi model trình bày nhầm như thể đó là nội dung bài 1.9 — bịa
  // đúng nghĩa đen: gắn nhãn thật lên nội dung sai. NAY: mỗi nhãn được yêu cầu PHẢI tự báo cáo nó có
  // tìm thấy evidence THẬT hay không — không có evidence tier-1 riêng cho nhãn đó thì nhãn đó đi vào
  // `unmatchedRequirementLabels` và được gửi CÙNG payload để server/model biết KHÔNG được bịa.
  const requirementLabels = extractRequirementLabels(query);
  const matchedRequirementLabels = [];
  const unmatchedRequirementLabels = [];
  const pageHints = Array.from(extractPageHints(query));
  const tier1Keys = [];
  requirementLabels.forEach((label) => {
    const re = requirementRegex(label);
    let taken = 0;
    all.forEach((c) => {
      if (taken >= PER_REQUIREMENT_EVIDENCE_CAP) return;
      if (!re.test(c._norm)) return;
      add(c, 1, label); tier1Keys.push(keyOf(c)); taken++;
    });
    if (taken > 0) matchedRequirementLabels.push(label);
    else unmatchedRequirementLabels.push(label);
  });
  pageHints.forEach((p) => {
    all.forEach((c) => {
      if (c.page != null && Number(c.page) === Number(p)) { add(c, 1, `trang ${p}`); tier1Keys.push(keyOf(c)); }
    });
  });

  // ---------- TẦNG 3 (tính trước, chèn sau tầng 2): neighbor của evidence tầng 1 ----------
  const neighbors = [];
  const byKey = new Map(all.map((c) => [keyOf(c), c]));
  tier1Keys.forEach((k) => {
    const c = byKey.get(k);
    if (!c || c.chunkIndex == null) return;
    for (let d = 1; d <= NEIGHBOR_RADIUS; d++) {
      [c.chunkIndex - d, c.chunkIndex + d].forEach((idx) => {
        const n = all.find((x) => x.sourceId === c.sourceId && x.chunkIndex === idx);
        if (n) neighbors.push(n);
      });
    }
  });

  // ---------- TẦNG 2: semantic/keyword ----------
  // QUAN TRỌNG: tier2 vẫn được gửi (hữu ích khi câu hỏi không nêu số cụ thể, hoặc để model tham
  // khảo ngữ cảnh xung quanh) — nhưng KHÔNG BAO GIỜ được gắn nhãn `requirement` của 1 label cụ thể
  // nào (tham số thứ 3 của add() luôn là null ở đây), để server phân biệt rạch ròi "evidence THẬT
  // của bài X" (tier 1, có requirement=X) với "evidence liên quan chung chung" (tier 2/3, không gắn
  // với số bài nào) — model không có cớ để nhầm nội dung tier-2 là đúng bài đã hỏi.
  const scored = all.filter((c) => c.score > 0).sort((a, b) => b.score - a.score);
  // Không có đoạn nào khớp từ khoá (rất dễ xảy ra với so khớp từ khoá đơn giản) -> vẫn đưa evidence
  // để AI tự đánh giá, thay vì trả [] khiến AI kết luận "không có nguồn".
  const tier2 = scored.length ? scored : all;
  const cap = Number.isFinite(limit) && limit > DEFAULT_RETRIEVAL_CAP ? limit : DEFAULT_RETRIEVAL_CAP;
  const tier2Cap = Math.max(cap, picked.size + cap);
  tier2.forEach((c) => { if (picked.size < tier2Cap) add(c, 2, null); });
  neighbors.forEach((c) => { if (picked.size < SOURCE_COMPLETE_CAP) add(c, 3, null); });

  // Tầng 1 luôn đứng trước (PHẦN K: current query/source evidence ưu tiên tuyệt đối).
  const ordered = Array.from(picked.values()).sort((a, b) => a.retrievalTier - b.retrievalTier);
  const result = fitToCharBudget(ordered.slice(0, SOURCE_COMPLETE_CAP), RETRIEVAL_CHAR_BUDGET);
  // Gắn kèm trên chính mảng trả về (không đổi kiểu trả về, mọi call site cũ vẫn coi nó là mảng)
  // để 3 nơi gửi request đọc được mà không phải gọi lại extractRequirementLabels() lần 2.
  return Object.assign(result, { requirementLabels, matchedRequirementLabels, unmatchedRequirementLabels });
}

/* ---------- SOURCE MANIFEST (PHẦN E) — CHỈ SỐ LIỆU THẬT, KHÔNG "coverage 100%" hardcode ----------
 * Bản cũ in thẳng chuỗi "coverage 100% (toàn bộ nội dung đã parse...)" cho MỌI nguồn text, và với
 * PDF scan thì in số RENDER như thể là số ĐÃ ĐỌC. Đó là lời nói dối đi thẳng vào system prompt.
 * NAY mọi con số lấy từ doc.processing và trạng thái in ra đúng như máy trạng thái đang giữ. */
function buildSourceManifest() {
  const docs = state.docs || [];
  if (!docs.length) return '';
  const lines = ['SOURCE MANIFEST'];
  docs.forEach((d) => {
    const ps = ensureSourceProcessingState(d);
    const doc = d;
    if (ps.extractionMethod === 'vision') {
      lines.push(`- ${d.name}`);
      lines.push(`  type: pdf-image  sourceId: ${d.id}`);
      lines.push(`  pages: ${ps.totalPages}`);
      lines.push(`  rendered: ${ps.renderedPages}/${ps.totalPages}`);
      lines.push(`  visionExtracted: ${ps.extractedPages}/${ps.totalPages}`);
      lines.push(`  verified: ${ps.verifiedPages}/${ps.totalPages}`);
      if (ps.failedPages.length) lines.push(`  failedPages: ${ps.failedPages.slice(0, 20).join(',')}`);
      // Trang đọc được nhưng model tự khai độ tin cậy thấp: vẫn dùng, nhưng nói rõ để model biết
      // phần nào cần đối chiếu kỹ thay vì tin tuyệt đối.
      if (doc && doc.lowConfidencePages && doc.lowConfidencePages.length) {
        lines.push(`  lowConfidencePages: ${doc.lowConfidencePages.slice(0, 20).join(',')}`);
      }
      lines.push(`  status: ${ps.status}`);
      return;
    }
    lines.push(`- ${d.name}`);
    lines.push(`  type: ${d.ext === 'pdf' ? 'pdf-text' : (d.ext || 'text')}  sourceId: ${d.id}`);
    lines.push(`  pages: ${ps.totalPages}`);
    lines.push(`  parsed: ${ps.parsedPages}/${ps.totalPages}`);
    lines.push(`  verified: ${ps.verifiedPages}/${ps.totalPages}`);
    lines.push(`  chunks: ${(d.chunks || []).filter((c) => !c[SOURCE_PLACEHOLDER_FLAG]).length}`);
    if (ps.failedPages.length) lines.push(`  failedPages: ${ps.failedPages.slice(0, 20).join(',')}`);
    lines.push(`  status: ${ps.status}`);
  });
  return lines.join('\n');
}

/* ---------- PHẦN K/L: CHỌN HISTORY THEO MỨC LIÊN QUAN, KHÔNG NHỒI 20 LƯỢT MỖI REQUEST ----------
 * Mỗi câu hỏi là 1 TASK ĐỘC LẬP. Query hiện tại + evidence nguồn hiện tại luôn thắng history cũ.
 * Chỉ khi câu hỏi THẬT SỰ là lượt nối tiếp ("tiếp tục", "bước tiếp theo", "câu trên"...) thì history
 * mới được giữ mạnh hơn. */
const FOLLOW_UP_RE = /(tiếp tục|tiếp theo|nói tiếp|vừa rồi|vừa xong|câu (trên|vừa)|bài (trên|vừa)|phần (trên|vừa)|như trên|ở trên|bước (tiếp|sau)|giải thích (thêm|rõ)|chi tiết hơn|rõ hơn|làm rõ|continue|go on|previous|above)/i;
const MAX_FOLLOW_UP_MESSAGES = 8;       // ~4 lượt hỏi-đáp
const MAX_INDEPENDENT_MESSAGES = 2;     // ~1 lượt, và chỉ khi thật sự liên quan

function isFollowUpQuery(query) {
  const q = normalizeForMatch(query);
  if (!q) return true; // không có chữ (chỉ ảnh) -> giữ ngữ cảnh gần nhất cho an toàn
  return FOLLOW_UP_RE.test(q) || q.length <= 12;
}

function keywordOverlapRatio(a, b) {
  const wordsOf = (s) => new Set((normalizeForMatch(s).match(/[\p{L}\p{N}.]+/gu) || []).filter((w) => w.length > 2));
  const A = wordsOf(a), B = wordsOf(b);
  if (!A.size) return 0;
  let hit = 0;
  A.forEach((w) => { if (B.has(w)) hit++; });
  return hit / A.size;
}

/* PHẦN L: TRẦN BỘ NHỚ HISTORY PHÍA CLIENT.
 * Trước đây 5 chỗ khác nhau cùng viết `if (state.history.length > 20) ... slice(-20)` — 5 bản sao
 * của cùng một quyết định, sửa 1 chỗ là lệch 4 chỗ còn lại. Gom về đúng 1 hàm + 1 hằng số.
 * Con số hạ từ 20 xuống 12 tin nhắn (~6 lượt): thứ THỰC SỰ được gửi đi do selectRelevantHistory()
 * quyết định (query độc lập -> 0 lượt), nên giữ 20 lượt trong RAM chỉ là rác không ai dùng. */
const HISTORY_MEMORY_CAP = 12;
function trimHistoryMemory() {
  if (state.history.length > HISTORY_MEMORY_CAP) state.history = state.history.slice(-HISTORY_MEMORY_CAP);
}

function selectRelevantHistory(query, history) {
  const h = Array.isArray(history) ? history : [];
  if (!h.length) return [];
  if (isFollowUpQuery(query)) return h.slice(-MAX_FOLLOW_UP_MESSAGES);
  const recent = h.slice(-MAX_INDEPENDENT_MESSAGES);
  const related = recent.some((m) => keywordOverlapRatio(query, m.content) >= 0.3);
  // Query độc lập và KHÔNG liên quan lượt trước -> bỏ hẳn history (PHẦN K/TEST 9/TEST 16).
  return related ? recent : [];
}
function highlightSnippet(text, query) {
  const qWords = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length > 2);
  const clean = cleanExtractedText(text).replace(/\s+/g, ' ').trim();
  let snippet = clean.length > 260 ? clean.slice(0, 260) + '…' : clean;
  let out = snippet.replace(/</g, '&lt;');
  qWords.slice(0, 6).forEach((w) => {
    const re = new RegExp('(' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
    out = out.replace(re, '<span class="hl">$1</span>');
  });
  return out;
}

/* ================= Rendering ================= */
function extractThinking(text) {
  const m = text.match(/<thinking>([\s\S]*?)<\/thinking>/i);
  if (m) return { thinking: m[1].trim(), answer: text.replace(m[0], '').trim(), truncated: false };
  // LỖI GỐC (ảnh người dùng gửi): khi phản hồi bị CẮT NGANG ngay giữa khối <thinking>...</thinking>
  // (hết maxTokens trước khi model kịp đóng thẻ), regex trên không khớp vì thiếu </thinking> đóng —
  // trước đây rơi thẳng vào nhánh mặc định "answer: text.trim()" nên TOÀN BỘ nội dung nháp nội bộ
  // (kể cả các đoạn tự sửa sai như "chưa đúng hệ thức cần tìm... Xem lại hệ thức...") bị hiển thị
  // thẳng ra cho người dùng như thể đó là câu trả lời chính thức, rồi dừng đột ngột giữa câu.
  // FIX: phát hiện thẻ <thinking> đang MỞ nhưng CHƯA ĐÓNG — cắt bỏ toàn bộ phần từ đó trở đi (không
  // hiển thị nháp dở dang), và báo hiệu truncated:true để phần gọi hàm có thể thông báo cho người
  // dùng biết câu trả lời bị cắt do quá dài, thay vì âm thầm hiển thị thiếu.
  const openIdx = text.search(/<thinking>/i);
  if (openIdx !== -1) {
    return { thinking: null, answer: text.slice(0, openIdx).trim(), truncated: true };
  }
  return { thinking: null, answer: text.trim(), truncated: false };
}
function renderMath(container) {
  if (window.renderMathInElement) {
    try {
      renderMathInElement(container, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\[', right: '\\]', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\(', right: '\\)', display: false }
        ],
        throwOnError: false
      });
    } catch (e) { console.error(e); }
  }
}
// ROOT CAUSE (xem báo lỗi "⚠️ Không thể hiển thị hình minh họa (dữ liệu không hợp lệ)"): khối
// ```plot/```shape/```solid3d nằm NGAY TRONG văn bản trả lời (không đi qua route JSON có cấu trúc ở
// server), nên trước đây được parse bằng JSON.parse(body.trim()) THẲNG, không hề đi qua các lớp vá
// lỗi JSON-từ-AI mà server/utils/jsonSafe.js đã có sẵn cho MỌI JSON khác của AI (xuống dòng thật
// trong chuỗi, dấu " lạc, dấu \ LaTeX thiếu nhân đôi như "expressions":["\\frac{1}{2}x"]...). Với
// khối "plot" (biểu đồ hàm số) điều này đặc biệt hay gãy vì "expressions" chứa ký hiệu toán học/LaTeX
// nhiều hơn hẳn "shape" — 1 dấu \ hay 1 ký tự điều khiển thô lọt vào là JSON.parse ném lỗi ngay và
// toàn bộ hình bị bỏ qua, dù dữ liệu bên trong hoàn toàn cứu được. FIX: dùng đúng chuỗi vá lỗi tương
// tự parseJSONSafe() phía server (cổng vào khác — body đã tách sẵn khỏi rào ``` bởi regex bên dưới —
// nhưng cùng các lớp vá: control-char thô -> dấu " lạc -> dấu \ LaTeX thiếu -> JSON cụt cuối) thay vì
// bỏ cuộc ngay ở lần thử đầu tiên.
function parseDrawSpecSafe(raw) {
  const text = String(raw == null ? '' : raw).trim();
  try { return JSON.parse(text); } catch (e) { /* thử các lớp vá bên dưới */ }

  const escapeRawControlCharsInStrings = (s) => {
    let out = '', inString = false, escapedNext = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (!inString) { out += c; if (c === '"') inString = true; continue; }
      if (escapedNext) { out += c; escapedNext = false; continue; }
      if (c === '\\') { out += c; escapedNext = true; continue; }
      if (c === '"') { out += c; inString = false; continue; }
      const code = c.charCodeAt(0);
      if (code <= 0x1f) {
        if (c === '\n') out += '\\n';
        else if (c === '\r') out += '\\r';
        else if (c === '\t') out += '\\t';
        else out += '\\u' + code.toString(16).padStart(4, '0');
        continue;
      }
      out += c;
    }
    return out;
  };

  const escapeStrayQuotesInStrings = (s) => {
    let out = '', inString = false, i = 0;
    while (i < s.length) {
      const c = s[i];
      if (!inString) { out += c; if (c === '"') inString = true; i++; continue; }
      if (c === '\\') { out += c + (s[i + 1] || ''); i += 2; continue; }
      if (c === '"') {
        let j = i + 1;
        while (j < s.length && /\s/.test(s[j])) j++;
        const nextCh = s[j];
        const isRealClose = nextCh === undefined || ',}]:'.includes(nextCh);
        if (isRealClose) { out += c; inString = false; i++; continue; }
        out += '\\"'; i++; continue;
      }
      out += c; i++;
    }
    return out;
  };

  const fixBackslashes = (s) => s.replace(/\\([\s\S])([a-zA-Z]?)/g, (m, ch, next) => {
    if (ch === '"' || ch === '\\' || ch === '/' || ch === 'u') return m;
    if ('bfnrt'.includes(ch) && !next) return m;
    return '\\\\' + ch + next;
  });

  const closeTruncatedJSON = (s) => {
    let inString = false, escape = false;
    const stack = [];
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inString) {
        if (escape) { escape = false; continue; }
        if (c === '\\') { escape = true; continue; }
        if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { inString = true; continue; }
      if (c === '{' || c === '[') { stack.push(c); continue; }
      if (c === '}' || c === ']') { stack.pop(); continue; }
    }
    let out = s;
    if (inString) out += '"';
    out = out.replace(/,\s*$/, '');
    out = out.replace(/,?\s*"[^"\\]*"\s*:\s*$/, '');
    for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === '{' ? '}' : ']';
    return out;
  };

  let candidate = text;
  const stages = [escapeRawControlCharsInStrings, escapeStrayQuotesInStrings, fixBackslashes, closeTruncatedJSON];
  for (const fix of stages) {
    try { candidate = fix(candidate); return JSON.parse(candidate); } catch (e) { /* thử lớp kế tiếp */ }
  }
  return null;
}
// Nhận diện & chuyển bảng Markdown (| A | B |\n|---|---|\n| 1 | 2 |) thành <table> ngữ nghĩa
// (13.10 Smart Table Renderer). Chạy SAU khi DRAW/MATH đã bị thay bằng placeholder \u0000...\u0000
// nên nội dung ô bảng chứa công thức/hình vẽ vẫn an toàn (placeholder không có ký tự | & <).
// Escape & < thủ công cho từng ô (13.10: không tạo XSS từ dữ liệu AI) rồi mới cho phép **bold**/`code`
// đơn giản trong ô. Toàn bộ hàm bọc try/catch ở nơi gọi — bảng lỗi KHÔNG được làm chết cả câu trả lời
// (13.13), chỉ rớt về text/Markdown thô.
function parseMarkdownTables(text) {
  const tableBlocks = [];
  const splitRow = (line) => {
    let l = line.trim();
    if (l.startsWith('|')) l = l.slice(1);
    if (l.endsWith('|') && !l.endsWith('\\|')) l = l.slice(0, -1);
    return l.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  };
  const isSepRow = (line) => {
    if (!line || !line.includes('-')) return false;
    const cells = splitRow(line);
    return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));
  };
  const escCell = (s) => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.includes('|') && i + 1 < lines.length && isSepRow(lines[i + 1])) {
      const header = splitRow(line);
      const seps = splitRow(lines[i + 1]);
      // Cần >=2 cột (bảng so sánh) và số cột header/separator khớp nhau — nếu lệch, KHÔNG coi là
      // bảng hợp lệ, để nguyên văn bản (13.13: dữ liệu bảng lỗi -> fallback plain text, không crash).
      if (header.length >= 2 && header.length === seps.length) {
        const aligns = seps.map((s) => {
          const l = s.startsWith(':'), r = s.endsWith(':');
          return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
        });
        const rows = [];
        let j = i + 2;
        while (j < lines.length && lines[j].trim() !== '' && lines[j].includes('|')) {
          rows.push(splitRow(lines[j]));
          j++;
        }
        // Nếu separator không chỉ định căn lề, tự đoán căn phải cho cột toàn giá trị số (13.9).
        const numCol = header.map((_, ci) => rows.length > 0 && rows.every((r) => {
          const v = r[ci];
          return v === undefined || v === '' || /^-?[\d.,]+%?$/.test(v);
        }));
        const alignStyle = (ci) => {
          const a = aligns[ci] || (numCol[ci] ? 'right' : '');
          return a ? ` style="text-align:${a}"` : '';
        };
        const thead = '<thead><tr>' + header.map((h, ci) =>
          `<th${alignStyle(ci)}>${escCell(h)}</th>`).join('') + '</tr></thead>';
        const tbody = '<tbody>' + rows.map((r) => '<tr>' + header.map((_, ci) =>
          `<td${alignStyle(ci)}>${escCell(r[ci] || '')}</td>`).join('') + '</tr>').join('') + '</tbody>';
        tableBlocks.push(`<div class="table-wrapper"><table class="ai-table">${thead}${tbody}</table></div>`);
        out.push(`\u0000TABLE${tableBlocks.length - 1}\u0000`);
        i = j;
        continue;
      }
    }
    out.push(line);
    i++;
  }
  return { text: out.join('\n'), tableBlocks };
}
function renderMarkdownLite(text) {
  const drawBlocks = [];
  const mathBlocks = [];
  let working = text.replace(/```(plot|shape|solid3d|scene3d|scenepatch)\n?([\s\S]*?)```/g, (m, kind, body) => {
    const spec = parseDrawSpecSafe(body);
    drawBlocks.push({ kind, spec });
    return `\u0000DRAW${drawBlocks.length - 1}\u0000`;
  });
  // Bảo vệ các khối công thức LaTeX ($$...$$, \[...\], \(...\), $...$) khỏi bước tách xuống
  // dòng bên dưới (đổi mỗi \n đơn thành <br>) — nếu không, thẻ <br> bị chèn vào giữa công thức
  // nhiều dòng sẽ cắt đứt văn bản thành nhiều text-node, khiến KaTeX không tìm thấy trọn vẹn cặp
  // dấu phân cách mở/đóng và hiển thị nguyên mã LaTeX thay vì công thức đã render.
  working = working.replace(/\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$[^$\n]+?\$/g, (m) => {
    mathBlocks.push(m.replace(/\r?\n\s*/g, ' '));
    return `\u0000MATH${mathBlocks.length - 1}\u0000`;
  });
  let tableBlocks = [];
  try {
    const parsed = parseMarkdownTables(working);
    working = parsed.text;
    tableBlocks = parsed.tableBlocks;
  } catch (e) { console.error('[table] parse lỗi, fallback plain text:', e); }
  let html = working
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/```([\s\S]*?)```/g, (m, c) => `<pre><code>${c.trim()}</code></pre>`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[(\d+)\]/g, '<sup class="cref">[$1]</sup>')
    .split(/\n{2,}/).map((block) => {
      const h = block.match(/^##\s?(.+)$/);
      if (h) return `<h3>${h[1].trim()}</h3>`;
      return `<p>${block.replace(/\n/g, '<br>')}</p>`;
    }).join('');

  // tableBlocks[i] đã tự escape/dựng HTML sẵn (parseMarkdownTables) nhưng vẫn có thể chứa placeholder
  // \u0000MATHn\u0000 lồng bên trong (công thức trong ô bảng) — PHẢI thay bảng vào TRƯỚC bước thay
  // MATH bên dưới, nếu không placeholder MATH lồng trong bảng sẽ không bao giờ được khớp lại. Ưu tiên
  // khớp <p>\u0000TABLEn\u0000</p> trước (bảng đứng riêng 1 đoạn, ca phổ biến nhất) để tránh
  // <div>/<table> nằm lồng trong <p>; phần fallback bắt placeholder còn sót xen giữa đoạn văn.
  html = html.replace(/<p>\u0000TABLE(\d+)\u0000<\/p>/g, (m, i) => tableBlocks[+i] || '');
  html = html.replace(/\u0000TABLE(\d+)\u0000/g, (m, i) => tableBlocks[+i] || '');

  html = html.replace(/\u0000MATH(\d+)\u0000/g, (m, i) =>
    mathBlocks[+i].replace(/&/g, '&amp;').replace(/</g, '&lt;')
  );

  const draws = [];
  html = html.replace(/\u0000DRAW(\d+)\u0000/g, (m, i) => {
    const b = drawBlocks[+i];
    if (!b || !b.spec) return `<p style="color:#c0392b;font-size:12px;">${escapeHtml(t('error.drawInvalid'))}</p>`;
    const id = 'draw_' + Math.random().toString(36).slice(2, 9);
    draws.push({ id, kind: b.kind, spec: b.spec });
    // PHẦN L: scenepatch KHÔNG dựng container riêng — áp lên khối scene3d gần nhất phía trước.
    if (b.kind === 'scenepatch') return `\u0000PATCH${draws.length - 1}\u0000`;
    const cls = (b.kind === 'solid3d' || b.kind === 'scene3d') ? 'draw-wrap draw-wrap-3d' : 'draw-wrap draw-wrap-legacy';
    return `<div class="${cls}" id="${id}"></div>`;
  });
  // scenepatch không tạo container riêng — placeholder của nó có thể còn nằm trong 1 <p> rỗng, bỏ đi.
  html = html.replace(/<p>\u0000PATCH(\d+)\u0000<\/p>/g, '').replace(/\u0000PATCH(\d+)\u0000/g, '');
  return { html, draws };
}

/* ---------- Render khối vẽ trong câu trả lời ---------- */
// KIẾN TRÚC AI IMAGE-FIRST: frontend KHÔNG còn dựng bất kỳ hình minh hoạ 2D nào bằng SVG.
//   - Hình 2D TĨNH (hình học, đồ thị, mạch điện, flowchart, sơ đồ...) do backend tạo bằng AI image
//     provider và gửi xuống trong `visuals[]` -> renderVisualCard() dựng thẻ <img> thật.
//   - Scene 3D TƯƠNG TÁC vẫn do Three.js đảm nhiệm (solid3d.js / scene3d.js) — không đổi.
//   - Khối ```plot/```shape kiểu cũ (nếu model vẫn sinh ra theo thói quen) KHÔNG được render thành
//     SVG nữa: chỉ hiện một dòng ghi chú, hình thật đến từ thẻ hình AI phía dưới.
function renderDrawing(container, kind, spec) {
  if (!container) return;
  try {
    if (kind === 'solid3d') {
      // three.js lazy-load on-demand: khối 3D đầu tiên trong phiên phải CHỜ tải xong trước khi vẽ
      // được — hiện placeholder trong lúc chờ rồi vẽ ngay khi sẵn sàng.
      container.innerHTML = `<p style="font-size:12px;color:#6b7593;">${escapeHtml(t('loading.3dEngine'))}</p>`;
      ensureThree().then(() => {
        if (window.drawSolid3D) window.drawSolid3D(container, spec);
        else container.innerHTML = `<p style="font-size:12px;color:#c0392b;">${escapeHtml(t('error.load3d'))}</p>`;
      }).catch(() => {
        container.innerHTML = `<p style="font-size:12px;color:#c0392b;">${escapeHtml(t('error.load3dNetwork'))}</p>`;
      });
    } else if (kind === 'scene3d') {
      // scene3d dùng cùng lazy-load three.js với solid3d, nhưng renderer riêng (scene3d.js) hỗ trợ
      // compact JSON đa-object + patch + quality tiers + WebGL fallback.
      container.innerHTML = `<p style="font-size:12px;color:#6b7593;">${escapeHtml(t('loading.3dEngine'))}</p>`;
      ensureThree().then(() => {
        if (window.renderScene3D) window.renderScene3D(container, spec);
        else container.innerHTML = `<p style="font-size:12px;color:#c0392b;">${escapeHtml(t('error.load3d'))}</p>`;
      }).catch(() => {
        if (window.renderScene3D) window.renderScene3D(container, spec); // tự fallback text nếu WebGL không khả dụng
        else container.innerHTML = `<p style="font-size:12px;color:#c0392b;">${escapeHtml(t('error.load3dNetwork'))}</p>`;
      });
    } else {
      renderLegacy2dNotice(container);
    }
  } catch (e) {
    container.innerHTML = `<p style="color:#c0392b;font-size:12px;">${escapeHtml(t('error.drawFailed'))}</p>`;
    console.error(e);
  }
}

/**
 * renderLegacy2dNotice() — khối ```plot/```shape kiểu cũ. KHÔNG dựng SVG thay thế (đó chính là cơ
 * chế đã bị loại bỏ); chỉ nói rõ hình tĩnh nay là ảnh AI trong thẻ hình.
 */
function renderLegacy2dNotice(container) {
  if (!container) return;
  container.className = 'draw-wrap draw-wrap-legacy';
  const p = document.createElement('p');
  p.className = 'draw-legacy-note';
  p.textContent = t('error.legacyDrawBlock');
  container.innerHTML = '';
  container.appendChild(p);
}

// imageState (dùng khi mở lại conversation cũ, không dùng ở lượt gửi mới):
//   'legacy'  -> hadImage=true nhưng message cũ không có imageId (dữ liệu trước khi có fix này)
//   'missing' -> có imageId nhưng blob không còn trong IndexedDB (đã bị xoá/dọn dẹp)
function addUserMsg(text, imageUrl, imageState) {
  const row = document.createElement('div');
  row.className = 'msg-row msg-user';
  row.innerHTML = '<div class="bubble"></div>';
  const bubble = row.querySelector('.bubble');
  if (imageUrl) { const img = document.createElement('img'); img.src = imageUrl; bubble.appendChild(img); }
  else if (imageState === 'legacy' || imageState === 'missing') {
    const span = document.createElement('span');
    span.className = 'img-restore-warn';
    span.textContent = imageState === 'legacy'
      ? '⚠️ Ảnh cũ không có dữ liệu để khôi phục.'
      : '⚠️ Ảnh gốc của câu hỏi này không còn trong bộ nhớ cục bộ.';
    bubble.appendChild(span);
  } else if (!text) { const span = document.createElement('span'); span.textContent = '📷 Đã gửi kèm ảnh đề bài'; bubble.appendChild(span); }
  if (text) { const span = document.createElement('span'); span.textContent = text; bubble.appendChild(span); }
  threadEl.appendChild(row); scrollThreadToBottom(true);
}

// Khôi phục 1 ảnh đã lưu từ IndexedDB dựa trên imageId — trả về {mediaType, base64, url} sẵn sàng
// để gửi lên /api/chat (base64) VÀ hiển thị (url là Object URL mới, chỉ dùng trong phiên hiện tại,
// không bao giờ lưu lại xuống storage — mục 6). Trả về null nếu không tìm thấy/không phục hồi được.
async function restoreMessageImage(imageId) {
  if (!imageId || !window.chatImageStore) return null;
  try {
    const record = await window.chatImageStore.get(imageId);
    if (!record || !record.blob) return null;
    const base64 = await window.blobToBase64(record.blob);
    if (!base64) return null;
    return { mediaType: record.mediaType, base64, url: record.url, imageId };
  } catch (e) {
    console.error('Khôi phục ảnh từ IndexedDB thất bại:', e);
    return null;
  }
}
function addAiMsg(labelText) {
  const row = document.createElement('div');
  row.className = 'msg-row msg-ai';
  row.innerHTML = `<div class="label">${labelText || 'Trợ Giải'}</div><div class="content"><span class="typing"><span></span><span></span><span></span></span></div>`;
  threadEl.appendChild(row); scrollThreadToBottom();
  return row;
}

// ---------- Mục 14.4: badge nhỏ "📐 Toán học · 98%" gắn vào nhãn tin nhắn AI, không chiếm khu vực chat ----------
// subjectId==='general' kèm confidence 0 (server không đoán được, vd ảnh chưa có gì để đọc) -> KHÔNG
// hiển thị badge (14.9: không đoán bừa) thay vì hiển thị "📚 Môn học khác · 0%" gây hiểu lầm.
// 14.7: nếu có secondarySubjectId, badge hiển thị "🌍 Địa lý + 📐 Toán" (gộp cả 2 vào 1 pill duy nhất
// — 14.4/14.21 yêu cầu badge nhỏ gọn, KHÔNG dựng 2 pill riêng chiếm thêm diện tích).
function subjectBadgeHtml(subjectId, confidence, secondarySubjectId) {
  if (!subjectId || !window.getSubjectInfo) return '';
  if (subjectId === 'general' && !(confidence > 0)) return '';
  const info = window.getSubjectInfo(subjectId);
  const pct = confidence > 0 ? ` · ${Math.round(confidence * 100)}%` : '';
  const secInfo = secondarySubjectId ? window.getSubjectInfo(secondarySubjectId) : null;
  const label = secInfo ? `${info.icon} ${info.name} + ${secInfo.icon} ${secInfo.name}` : `${info.icon} ${info.name}`;
  // border-left dùng đúng --subject-<id> (mục 14.11: màu hỗ trợ nhận diện, không phụ thuộc HOÀN
  // TOÀN vào màu — icon + tên vẫn luôn hiển thị đầy đủ bằng chữ).
  return `<span class="subject-badge" data-subject="${subjectId}" style="border-left:3px solid var(--subject-${subjectId}, var(--rule))">${label}${pct}</span>`;
}
function setMsgSubjectBadge(row, subjectId, confidence, secondarySubjectId) {
  if (!row) return;
  const label = row.querySelector('.label');
  if (!label) return;
  const existing = label.querySelector('.subject-badge');
  if (existing) existing.remove();
  const html = subjectBadgeHtml(subjectId, confidence, secondarySubjectId);
  if (html) label.insertAdjacentHTML('beforeend', html);
}

function humanFileSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return (i === 0 ? Math.round(n) : n.toFixed(1)) + ' ' + units[i];
}

// Gói 1 file .docx vừa dựng xong ở CLIENT (docx.js) thành 1 TIN NHẮN trong khung chat — thay cho
// hành vi cũ là tự động kích hoạt tải xuống ngay lập tức. File vẫn được dựng bằng đúng cơ chế xoay
// tua/tự động chuyển provider AI (callWithFailover ở server) như trước, chỉ khác ở BƯỚC GIAO FILE cho
// người dùng: giờ xuất hiện như 1 tệp đính kèm ngay trong luồng hội thoại (giữ lại lịch sử, cuộn lên
// xem lại được), người dùng chủ động bấm "Tải xuống" khi cần thay vì bị trình duyệt tự mở hộp thoại
// lưu file ngay lập tức. object URL cố tình KHÔNG revoke để nút tải vẫn dùng được về sau.
// "summaryHtml" (tuỳ chọn): mô tả AI đã tạo NHỮNG GÌ trong file (vd danh sách mục đề cương) — hiện
// NGAY TRÊN thẻ file, thay cho dòng "✅ Đã tạo xong file" chung chung trước đây, để người dùng biết rõ
// nội dung trước khi quyết định tải về. Dựng thẳng từ spec JSON đã có sẵn, KHÔNG tốn thêm lượt gọi AI
// nào. "kind" giờ luôn là 'docx' (tính năng PPT đã bị gỡ bỏ hoàn toàn khỏi ứng dụng).
function appendFileMessage(kind, fileName, blob, summaryHtml) {
  const label = 'Đề cương .docx';
  const icon = '📄';
  const kindLabel = 'Word';
  const row = addAiMsg(label);
  const content = row.querySelector('.content');
  const url = URL.createObjectURL(blob);
  content.innerHTML = `
    ${summaryHtml || '<p style="margin:0 0 10px;">✅ Đã tạo xong file, sẵn sàng tải xuống bên dưới:</p>'}
    <div class="file-msg-card">
      <div class="file-msg-icon">${icon}</div>
      <div class="file-msg-meta">
        <div class="file-msg-name"></div>
        <div class="file-msg-sub">${kindLabel} · ${humanFileSize(blob.size)} · Tạo bởi AI</div>
      </div>
      <button class="file-msg-dl" type="button">${ICONS.download}<span>Tải xuống</span></button>
    </div>`;
  content.querySelector('.file-msg-name').textContent = fileName;
  content.querySelector('.file-msg-dl').onclick = () => {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  scrollThreadToBottom();
  return row;
}

// Tóm tắt NGẮN GỌN những gì AI đã soạn trong file đề cương .docx, dựng thẳng từ spec JSON (đã có sẵn
// từ /api/generate/outline) — không gọi thêm AI. Dùng làm "summaryHtml" cho appendFileMessage() ở nơi
// tạo file (gõ trực tiếp trong chat, xem handleOutlineOnlyTurn/renderOutlineAnswer), để câu trả lời
// luôn mô tả rõ nội dung file thay vì chỉ báo "đã xong".
function buildOutlineSummaryHtml(spec) {
  const esc = escapeHtml;
  const sections = spec.sections || [];
  const items = sections.map((sec) => `<li>${esc(sec.heading || '')}</li>`).join('');
  const exNote = Array.isArray(spec.exercises) && spec.exercises.length ? ` kèm bài tập ôn tập theo ${spec.exercises.length} mức độ` : '';
  return `
    <p style="margin:0 0 6px;">✅ Mình đã soạn xong đề cương <b>"${esc(spec.title || 'Đề cương')}"</b> gồm ${sections.length} phần${exNote}:</p>
    <ul class="gen-summary-list">${items}</ul>
    <p style="margin:8px 0 10px;">Bấm "Tải xuống" bên dưới để lưu file .docx về máy:</p>`;
}

// Hiển thị 1 thẻ LỖI ngay trong khung chat kèm nút "Thử lại" — thay cho alert() cũ (chặn cứng luồng,
// muốn thử lại phải tự bấm lại nút gốc hoặc gõ lại câu hỏi từ đầu). Dùng cho MỌI lỗi khi tạo file
// đề cương .docx/flashcard/mindmap (kể cả lỗi "AI trả về dữ liệu không hợp lệ" — nguyên nhân phổ
// biến nhất). retryFn là 1 hàm async KHÔNG THAM SỐ, đã đóng gói sẵn (qua closure ở nơi gọi) toàn bộ
// ngữ cảnh cần thiết để lặp lại ĐÚNG yêu cầu vừa thất bại.
function appendGenErrorMessage(label, message, retryFn) {
  const row = addAiMsg(label);
  const content = row.querySelector('.content');
  content.innerHTML = `
    <div class="gen-error-card">
      <p class="gen-error-text">⚠️ ${escapeHtml(message)}</p>
      <button class="gen-error-retry" type="button">${ICONS.refresh}<span>${escapeHtml(t('chat.retry'))}</span></button>
    </div>`;
  const btn = content.querySelector('.gen-error-retry');
  btn.onclick = async () => {
    btn.disabled = true;
    btn.innerHTML = `<span>${escapeHtml(t('chat.retrying'))}</span>`;
    row.remove(); // gỡ thẻ lỗi cũ — retryFn() tự thêm tin nhắn mới (thành công hoặc lỗi khác)
    await retryFn();
  };
  scrollThreadToBottom();
  return row;
}

/* ================= Đa cuộc trò chuyện + Lịch sử (giống Claude, phong cách hiện đại) ================= */
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function currentConversation() {
  return state.conversations.find((c) => c.id === state.currentConvId) || null;
}
function saveConversations() {
  // FIX: không ghi hội thoại rỗng (chưa có tin nhắn nào) xuống localStorage — hội thoại nháp mới
  // tạo chỉ tồn tại trong bộ nhớ tới khi người dùng thật sự gửi câu hỏi đầu tiên. Ngăn "Buổi học
  // mới" rỗng tích tụ trong Lịch sử mỗi lần mở app / bấm nút mà không gõ gì.
  lsSet(LS_KEYS.conversations, state.conversations.filter((c) => c.messages && c.messages.length > 0));
  lsSet(LS_KEYS.currentConv, state.currentConvId);
  updateChatMeta();
}

// Dòng metadata nhỏ dưới tiêu đề buổi học: chỉ hiện số liệu THẬT của đúng buổi học hiện tại (số lượt
// đã giải, số ghi chú đã lưu trong buổi này) — ẩn hoàn toàn nếu buổi học chưa có gì, không tự đoán
// môn/chủ đề nếu không chắc.
function updateChatMeta() {
  const metaEl = el('chatMeta');
  if (!metaEl) return;
  const conv = currentConversation();
  if (!conv || !conv.messages || !conv.messages.length) { metaEl.textContent = ''; return; }
  const solved = conv.messages.filter((m) => m.role === 'user').length;
  const notesInConv = conv.messages.filter((m) => m.role === 'ai' && m.userNote).length;
  const parts = [];
  if (solved) parts.push(t('chat.solvedCount', { n: solved }));
  if (notesInConv) parts.push(t('chat.notesCount', { n: notesInConv }));
  metaEl.textContent = parts.join(' · ');
}

function revokeThreadBlobImages() {
  // Dọn mọi Object URL (blob:) đang gắn trên các <img> trong khung chat hiện tại trước khi xoá DOM —
  // vừa dùng cho ảnh vừa gửi (previewUrl) vừa dùng cho ảnh khôi phục từ IndexedDB (restoreMessageImage),
  // cả 2 đều KHÔNG tự revoke trước đây → rò rỉ Object URL mỗi lần chuyển/tạo hội thoại (risk còn lại
  // sau lần fix trước). An toàn khi gọi nhiều lần / gọi khi threadEl rỗng.
  threadEl.querySelectorAll('img[src^="blob:"]').forEach((img) => revokeImagePreviewUrl(img.src));
}
window.addEventListener('pagehide', revokeThreadBlobImages);

function startNewConversation(silent) {
  const conv = { id: uid(), title: t('chat.newChatTitle'), createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  state.conversations.unshift(conv);
  if (state.conversations.length > MAX_STORED_CONVERSATIONS) state.conversations.length = MAX_STORED_CONVERSATIONS;
  state.currentConvId = conv.id;
  state.history = [];
  pendingTurn = null;
  revokeThreadBlobImages();
  threadEl.innerHTML = '';
  welcome();
  el('chatTitle').textContent = t('chat.newChatTitle');
  saveConversations();
  renderHistoryList();
  syncSendButtonForActiveConversation();
  if (!silent) closeSidebarOnMobile();
}
el('newChatBtn').onclick = () => startNewConversation(false);

async function loadConversation(id, silent) {
  const conv = state.conversations.find((c) => c.id === id);
  if (!conv) return;
  state.currentConvId = id;
  pendingTurn = null;
  revokeThreadBlobImages();
  threadEl.innerHTML = '';
  if (conv.messages.length === 0) { welcome(); }
  else {
    // FIX ROOT CAUSE #1 (mục 5): dựng lại đúng ảnh gốc từ IndexedDB theo imageId đã lưu, thay vì
    // luôn truyền null. Dùng vòng lặp for..of + await (không Promise.all) để GIỮ ĐÚNG THỨ TỰ hiển
    // thị tin nhắn trong luồng chat — số lượng ảnh/hội thoại nhỏ nên không đáng lo về hiệu năng.
    for (const msg of conv.messages) {
      if (msg.role === 'user') {
        if (msg.imageId) {
          const restored = await restoreMessageImage(msg.imageId);
          if (restored && restored.url) addUserMsg(msg.text, restored.url);
          else addUserMsg(msg.text, null, 'missing');
        } else if (msg.hadImage) {
          // Dữ liệu cũ trước khi có fix này: hadImage=true nhưng không có imageId để khôi phục.
          addUserMsg(msg.text, null, 'legacy');
        } else {
          addUserMsg(msg.text, null);
        }
      } else {
        renderStoredAiMessage(msg);
      }
    }
  }
  // dựng lại ngữ cảnh gửi API từ nội dung đã lưu
  state.history = [];
  conv.messages.forEach((msg) => {
    if (msg.role === 'user') state.history.push({ role: 'user', content: msg.text || '[Người dùng đã gửi ảnh đề bài để giải]' });
    else state.history.push({ role: 'assistant', content: msg.detail || msg.approach || '' });
  });
  trimHistoryMemory();
  el('chatTitle').textContent = conv.title;
  lsSet(LS_KEYS.currentConv, id);
  updateChatMeta();
  renderHistoryList();
  // PHẦN E/H: nếu conversation vừa mở đang có task chạy nền, phản ánh đúng lên nút Gửi/Dừng NGAY —
  // KHÔNG chờ tới khi task đó xong mới cập nhật (task không hề biết/quan tâm UI có đang xem nó hay
  // không, nhưng UI PHẢI tự hỏi lại đúng trạng thái mỗi lần được mở lên — PHẦN E "attach").
  syncSendButtonForActiveConversation();
  const activeTask = window.conversationTaskManager && window.conversationTaskManager.getActiveTask(id);
  if (activeTask && activeTask.text) {
    // Có nội dung đang stream dở cho conversation này — hiện tạm bằng streaming preview (PHẦN E: UI
    // "attach" vào task đang chạy) thay vì chỉ thấy màn hình trống tới khi task xong.
    const aiRow = addAiMsg(t('chat.continuing'));
    const contentEl = aiRow.querySelector('.content');
    const preview = startStreamingPreview(contentEl);
    preview.append(activeTask.text);
    const detach = window.conversationTaskManager.attach(id, (ev) => {
      if (ev.type === 'delta') preview.append(ev.chunk);
      else if (ev.type === 'statusMsg') preview.setStatus(ev.message, ev.state);
      else if (ev.type === 'done' || ev.type === 'error' || ev.type === 'cancelled') { detach(); }
    });
  }
  scrollThreadToBottom();
  if (!silent) closeSidebarOnMobile();
}

function deleteConversation(id) {
  const removed = state.conversations.find((c) => c.id === id);
  state.conversations = state.conversations.filter((c) => c.id !== id);
  saveConversations();
  // Mục 9 (cleanup): xoá luôn mọi ảnh IndexedDB gắn với conversation vừa xoá — mỗi ảnh chỉ được
  // 1 message reference (tạo mới mỗi lần gửi) nên xoá thẳng an toàn, không cần đếm reference chéo
  // conversation khác. Chạy nền, không chặn UI, lỗi bỏ qua an toàn (ảnh mồ côi không hại gì thêm).
  if (removed && window.chatImageStore) {
    const imageIds = new Set();
    (removed.messages || []).forEach((m) => { if (m.imageId) imageIds.add(m.imageId); });
    imageIds.forEach((imgId) => { window.chatImageStore.delete(imgId).catch(() => {}); });
  }
  if (state.currentConvId === id) {
    if (state.conversations.length) loadConversation(state.conversations[0].id, true);
    else startNewConversation(true);
  } else {
    renderHistoryList();
  }
}

// Mục 14.20 — MÔN CHỦ ĐẠO của cả cuộc trò chuyện (không phải môn của 1 tin nhắn lẻ): tổng hợp
// TOÀN BỘ tin nhắn AI trong hội thoại, mỗi tin nhắn đóng góp trọng số = subjectConfidence (môn phụ
// secondarySubjectId đóng góp nửa trọng số) — môn có tổng điểm cao nhất được coi là môn chủ đạo.
// Nhờ đó 1 cuộc hỏi-đáp được "xếp" đúng 1 môn lớn nhất thay vì mơ hồ khớp theo bất kỳ tin nhắn nào.
function computeDominantSubject(conv) {
  const scores = {};
  (conv.messages || []).forEach((m) => {
    if (m.role !== 'ai') return;
    const w = m.subjectConfidence > 0 ? m.subjectConfidence : 0.5;
    if (m.subjectId && m.subjectId !== 'general') scores[m.subjectId] = (scores[m.subjectId] || 0) + w;
    if (m.secondarySubjectId && m.secondarySubjectId !== 'general') {
      scores[m.secondarySubjectId] = (scores[m.secondarySubjectId] || 0) + w * 0.5;
    }
  });
  const ids = Object.keys(scores);
  if (!ids.length) return 'general';
  return ids.reduce((best, id) => (scores[id] > scores[best] ? id : best), ids[0]);
}

// Mỗi lần hội thoại có cập nhật (sau khi hỏi/trả lời xong) -> tính lại NGAY môn chủ đạo và lưu
// (14.20) trước khi ghi localStorage, để "Lịch sử" luôn tự động xếp đúng cuộc trò chuyện vào môn
// liên quan lớn nhất mà không cần bước thủ công nào thêm.
function touchConversation(conv) {
  conv.updatedAt = Date.now();
  conv.dominantSubjectId = computeDominantSubject(conv);
  saveConversations();
  renderHistoryList();
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'Vừa xong';
  if (s < 3600) return Math.floor(s / 60) + ' phút trước';
  if (s < 86400) return Math.floor(s / 3600) + ' giờ trước';
  if (s < 604800) return Math.floor(s / 86400) + ' ngày trước';
  return new Date(ts).toLocaleDateString('vi-VN');
}

function renderHistoryList() {
  const ul = el('historyList');
  const filterVal = state.historyFilterSubject || 'all';
  // FIX: bỏ hội thoại nháp rỗng (đang gõ, chưa gửi câu hỏi nào) khỏi Lịch sử — tránh thẻ "Buổi
  // học mới" ma xuất hiện ngay khi mở tab mới, trước khi người dùng kịp gõ gì.
  let sorted = state.conversations.filter((c) => c.messages && c.messages.length > 0).sort((a, b) => b.updatedAt - a.updatedAt);
  // Mục 14.20: lọc theo MÔN CHỦ ĐẠO (dominantSubjectId — xem computeDominantSubject) của cả hội
  // thoại, không còn khớp "có ít nhất 1 tin nhắn" như trước (14.16 cũ) — mỗi hội thoại giờ thuộc
  // đúng 1 danh mục lớn nhất, tránh lẫn vào nhiều môn không liên quan chính.
  if (filterVal !== 'all') {
    sorted = sorted.filter((conv) => (conv.dominantSubjectId || computeDominantSubject(conv)) === filterVal);
  }
  el('historyEmpty').style.display = sorted.length ? 'none' : 'block';
  ul.innerHTML = '';
  sorted.forEach((conv, idx) => {
    const li = document.createElement('li');
    li.className = 'hist-card' + (conv.id === state.currentConvId ? ' active' : '');
    // Vào khung hình so le nhẹ (xem @keyframes hist-card-in) — chỉ 8 thẻ đầu, tránh chờ lâu khi
    // danh sách dài; các thẻ sau vào ngay cùng lúc.
    li.style.setProperty('--i', Math.min(idx, 8));
    // PHẦN F/H: badge "đang chạy nền" cho MỌI conversation có task active — không chỉ conv đang mở.
    const isBgGenerating = conv.id !== state.currentConvId && window.conversationTaskManager && window.conversationTaskManager.isGenerating(conv.id);
    const genBadge = isBgGenerating ? `<span class="hist-generating-dot" title="${window.t ? window.t('chat.generating') : 'Đang trả lời...'}"></span>` : '';
    // Mục 14.20: icon môn chủ đạo ngay cạnh tiêu đề, để thấy ngay hội thoại này đã được "xếp" vào
    // danh mục nào mà không cần mở dropdown lọc.
    const domSubj = conv.dominantSubjectId || computeDominantSubject(conv);
    const domInfo = domSubj !== 'general' && window.getSubjectInfo ? window.getSubjectInfo(domSubj) : null;
    const domIcon = domInfo ? `<span class="hist-subject-ic" title="${escapeHtml(domInfo.name)}">${domInfo.icon}</span>` : '';
    li.innerHTML = `
      <div class="hist-main">
        <div class="hist-title">${genBadge}${domIcon}${(conv.title || t('chat.newChatTitle')).replace(/</g, '&lt;')}</div>
        <div class="hist-meta">${escapeHtml(t('chat.messages', { n: conv.messages.length }))} · ${timeAgo(conv.updatedAt)}</div>
      </div>
      <button class="hist-del" title="${escapeHtml(t('history.deleteChat'))}">${ICONS.trash}</button>
    `;
    li.querySelector('.hist-main').onclick = () => loadConversation(conv.id);
    li.querySelector('.hist-del').onclick = (e) => {
      e.stopPropagation();
      if (!confirm(t('history.deleteConfirm'))) return;
      // Co gọn mượt trước khi xoá thật, thay vì biến mất đột ngột (xem .hist-card--leaving trong CSS).
      li.classList.add('hist-card--leaving');
      li.addEventListener('transitionend', () => deleteConversation(conv.id), { once: true });
      setTimeout(() => { if (li.isConnected) deleteConversation(conv.id); }, 400); // an toàn nếu transitionend không bắn
    };
    ul.appendChild(li);
  });
}
function buildHistorySubjectFilter() {
  const sel = el('historySubjectFilter');
  if (!sel || !window.SUBJECTS) return;
  const opts = [{ id: 'all', name: t('history.all'), icon: '' }]
    .concat(window.SUBJECTS.filter((s) => s.id !== 'auto'));
  sel.innerHTML = opts.map((s) => `<option value="${s.id}">${s.icon ? s.icon + ' ' : ''}${s.name}</option>`).join('');
  sel.value = state.historyFilterSubject || 'all';
  sel.onchange = () => { state.historyFilterSubject = sel.value; renderHistoryList(); };
}
buildHistorySubjectFilter();

function autoTitleFromQuery(query) {
  const clean = (query || '').replace(/\s+/g, ' ').trim();
  return clean ? (clean.length > 46 ? clean.slice(0, 46) + '…' : clean) : 'Bài tập có ảnh đính kèm';
}

/* ================= Ghi chú =================
 * Ghi chú của người dùng được gắn trực tiếp vào tin nhắn AI (msg.userNote/msg.userNoteAt) thay vì
 * lưu ở 1 mảng tách rời — nhờ đó danh sách "Ghi chú" ở sidebar luôn suy ra được TỪ đúng cuộc trò
 * chuyện + đúng câu trả lời, và bấm vào 1 ghi chú có thể quay thẳng lại đúng vị trí đó.
 */
function collectAllNotes() {
  const list = [];
  state.conversations.forEach((conv) => {
    (conv.messages || []).forEach((m) => {
      if (m.role === 'ai' && m.userNote) {
        list.push({
          convId: conv.id,
          convTitle: conv.title || 'Cuộc trò chuyện',
          msgId: m.id,
          question: m.query || '(Bài tập có ảnh đính kèm)',
          note: m.userNote,
          createdAt: m.userNoteAt || conv.updatedAt || Date.now()
        });
      }
    });
  });
  return list.sort((a, b) => b.createdAt - a.createdAt);
}

function renderNotesList() {
  const ul = el('notesList');
  const notes = collectAllNotes();
  el('notesEmpty').style.display = notes.length ? 'none' : 'block';
  ul.innerHTML = '';
  notes.forEach((note) => {
    const li = document.createElement('li');
    li.className = 'note-card';
    li.title = 'Bấm để xem lại câu trả lời kèm ghi chú của bạn';
    li.innerHTML = `
      <div class="note-q"></div>
      <div class="note-a"></div>
      <div class="note-foot">
        <span class="note-conv"></span>
        <div class="note-foot-right"><span></span><button class="note-del" title="Xóa ghi chú">${ICONS.trash}</button></div>
      </div>
    `;
    li.querySelector('.note-q').textContent = note.question;
    const aEl = li.querySelector('.note-a');
    aEl.textContent = note.note.length > 220 ? note.note.slice(0, 220) + '…' : note.note;
    li.querySelector('.note-conv').textContent = note.convTitle;
    li.querySelector('.note-foot-right span').textContent = timeAgo(note.createdAt);
    li.querySelector('.note-del').onclick = (e) => {
      e.stopPropagation();
      deleteNote(note.convId, note.msgId);
    };
    li.onclick = () => goToNote(note);
    ul.appendChild(li);
  });
}

function deleteNote(convId, msgId) {
  const conv = state.conversations.find((c) => c.id === convId);
  const msg = conv && (conv.messages || []).find((m) => m.id === msgId);
  if (!msg) return;
  delete msg.userNote;
  delete msg.userNoteAt;
  saveConversations();
  renderNotesList();
  refreshNoteUIInThread(msgId);
}

// Sau khi lưu/xóa ghi chú từ nơi khác (vd danh sách Ghi chú ở sidebar), nếu đúng câu trả lời đó
// đang hiển thị sẵn trong khung chat hiện tại thì vẽ lại MỌI khối nút/ghim ghi chú của nó ngay lập
// tức — có thể có tới 2 khối cho cùng 1 msgObj: 1 ở phần "Hướng giải" (trước khi xem chi tiết) và
// 1 ở phần "Lời giải chi tiết", cả 2 đều phải đồng bộ vì cùng ghi/đọc chung msgObj.userNote.
function refreshNoteUIInThread(msgId) {
  const row = threadEl.querySelector(`[data-msg-id="${CSS.escape(String(msgId))}"]`);
  if (!row) return;
  row.querySelectorAll('.study-wrap').forEach((wrap) => { if (typeof wrap._repaint === 'function') wrap._repaint(); });
}

let activeNoteCtx = null;
function openNoteModal(msgObj, conv) {
  activeNoteCtx = { msgObj, conv };
  el('noteModalQ').textContent = msgObj.query || '(Bài tập có ảnh đính kèm)';
  el('noteModalInput').value = msgObj.userNote || '';
  el('noteModalDeleteBtn').classList.toggle('hide', !msgObj.userNote);
  el('noteOverlay').classList.add('show');
  setTimeout(() => el('noteModalInput').focus(), 60);
}
function closeNoteModal() {
  el('noteOverlay').classList.remove('show');
  activeNoteCtx = null;
}
el('noteCloseBtn').onclick = closeNoteModal;
el('noteModalCancelBtn').onclick = closeNoteModal;
el('noteOverlay').addEventListener('click', (e) => { if (e.target.id === 'noteOverlay') closeNoteModal(); });
el('noteModalSaveBtn').onclick = () => {
  if (!activeNoteCtx) return;
  const { msgObj, conv } = activeNoteCtx;
  const text = el('noteModalInput').value.trim();
  if (!text) { el('noteModalInput').focus(); return; }
  msgObj.userNote = text;
  msgObj.userNoteAt = Date.now();
  if (conv) touchConversation(conv); else saveConversations();
  renderNotesList();
  refreshNoteUIInThread(msgObj.id);
  closeNoteModal();
};
el('noteModalDeleteBtn').onclick = () => {
  if (!activeNoteCtx) return;
  const { msgObj, conv } = activeNoteCtx;
  delete msgObj.userNote;
  delete msgObj.userNoteAt;
  if (conv) touchConversation(conv); else saveConversations();
  renderNotesList();
  refreshNoteUIInThread(msgObj.id);
  closeNoteModal();
};

// Bấm 1 thẻ ghi chú đã lưu -> quay lại đúng cuộc trò chuyện + đúng câu trả lời của AI, cuộn tới
// và nhấp nháy nhẹ để dễ nhận ra, dữ liệu ghi chú của người dùng đã tự hiển thị sẵn ngay dưới câu
// trả lời đó (khối "Ghi chú của bạn" được vẽ lại mỗi lần message được render).
function goToNote(note) {
  closeSidebarOnMobile();
  const scrollToRow = () => {
    const row = threadEl.querySelector(`[data-msg-id="${CSS.escape(String(note.msgId))}"]`);
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('note-jump-highlight');
    setTimeout(() => row.classList.remove('note-jump-highlight'), 1600);
  };
  if (state.currentConvId !== note.convId) {
    loadConversation(note.convId, true);
    requestAnimationFrame(() => requestAnimationFrame(scrollToRow));
  } else {
    scrollToRow();
  }
}

/* ================= Danh mục công thức cốt lõi ================= */
function renderFormulaSubjectTabs() {
  const wrap = el('formulaSubjectTabs');
  wrap.innerHTML = (window.FORMULA_SUBJECTS || []).map((s) =>
    `<button class="fsubj-tab${s.key === state.formulaSubject ? ' active' : ''}" data-key="${s.key}">${s.icon} ${s.label}</button>`
  ).join('');
  wrap.querySelectorAll('.fsubj-tab').forEach((btn) => btn.onclick = () => {
    state.formulaSubject = btn.dataset.key;
    renderFormulaSubjectTabs();
    renderFormulaList();
  });
}
function renderFormulaList() {
  const grade = state.settings.grade;
  el('formulaGradeHint').textContent = (window.GRADE_LABELS[grade] || grade) + ' · chỉnh trong Cài đặt';
  const list = el('formulaList');
  const items = ((window.FORMULA_LIBRARY[state.formulaSubject] || {})[grade]) || [];
  if (!items.length) {
    list.innerHTML = `<div class="panel-empty">Chưa có dữ liệu công thức cho môn này ở ${(window.GRADE_LABELS[grade] || grade).toLowerCase()}. Hãy thử chọn môn hoặc khối lớp khác trong Cài đặt.</div>`;
    return;
  }
  list.innerHTML = items.map((it) => `
    <div class="formula-card">
      <div class="formula-name">${it.name.replace(/</g, '&lt;')}</div>
      <div class="formula-eq">$$${it.formula}$$</div>
      ${it.note ? `<div class="formula-note">${it.note.replace(/</g, '&lt;')}</div>` : ''}
    </div>
  `).join('');
  renderMath(list);
}

/* ================= Xây dựng khối UI cho 1 lượt AI (Hướng giải -> Lời giải chi tiết) =================
 * Trả về 1 wrapper duy nhất gồm (nếu có) khối "Ghi chú của bạn" đã ghim + hàng nút hành động.
 * wrapper._repaint() cho phép vẽ lại đúng khối này tại chỗ khi ghi chú được lưu/sửa/xóa, mà không
 * cần render lại toàn bộ câu trả lời (giữ nguyên vị trí cuộn, không nháy giao diện).
 *
 * buildStudyActions() vẽ 3 nút (Ghi chú/Flashcard/Mindmap) — ĐÃ LUÔN ĐƯỢC HIỂN THỊ ngay từ giai đoạn
 * "Hướng giải" (không còn phải đợi tới "Lời giải chi tiết" mới thấy), vì đây là các tính năng được
 * khuyến nghị dùng ngay khi có bất kỳ câu trả lời nào — người dùng có thể xuất flashcard/mindmap chỉ
 * từ phần Hướng giải mà không bắt buộc phải xem lời giải chi tiết trước. Khi gọi cho giai đoạn
 * Hướng giải, LUÔN truyền thêm extraClass 'approach-note-block' để fetchDetail() có thể tìm và gỡ
 * đúng khối này thay bằng khối đầy đủ của giai đoạn Lời giải chi tiết (tránh hiển thị lặp 2 hàng
 * nút) — xem fetchDetail().
 * KHÔNG còn nút tạo đề cương .docx ở đây — đề cương giờ CHỈ được soạn khi người dùng CHỦ ĐỘNG gõ yêu
 * cầu ngay trong khung chat (xem isOutlineRequest/handleOutlineOnlyTurn), không tự động gợi ý dưới
 * mỗi câu trả lời nữa. Slide PPT đã bị gỡ bỏ hoàn toàn khỏi ứng dụng.
 * buildNoteBlock() (chỉ đúng 1 nút Ghi chú) giờ CHỈ còn dùng cho các câu trả lời "1 lượt duy nhất"
 * không có nội dung bài toán để xuất flashcard/mindmap riêng (đề cương/mindmap được tạo trực tiếp từ
 * 1 lệnh gọi, đã có sẵn nút tải file/vẽ lại riêng của chúng). Cả 2 khối (nếu cùng tồn tại tạm thời)
 * đều đọc/ghi chung 1 msgObj.userNote nên luôn đồng bộ với nhau.
 */
function noteButtonHtml(hasNote) {
  return `<button class="study-btn note${hasNote ? ' has-note' : ''}" data-act="note">${ICONS.note}<span>${hasNote ? 'Sửa ghi chú' : 'Lưu ghi chú'}</span></button>`;
}
function notePinHtml(msgObj) {
  if (!msgObj || !msgObj.userNote) return '';
  return `<div class="note-pin">
      <div class="note-pin-head"><span>${ICONS.note}Ghi chú của bạn</span><span class="note-pin-time"></span></div>
      <div class="note-pin-text"></div>
    </div>`;
}
function fillNotePin(wrapper, msgObj) {
  if (!msgObj || !msgObj.userNote) return;
  wrapper.querySelector('.note-pin-text').textContent = msgObj.userNote;
  wrapper.querySelector('.note-pin-time').textContent = timeAgo(msgObj.userNoteAt || Date.now());
}

function paintStudyActions(wrapper, msgObj, answerText, aiRow) {
  const hasNote = !!(msgObj && msgObj.userNote);
  const scOpen = !!wrapper._scOpen;
  wrapper.innerHTML = `
    ${notePinHtml(msgObj)}
    <div class="study-actions">
      ${noteButtonHtml(hasNote)}
      <button class="study-btn primary" data-act="selfcheck">${ICONS.brain}<span>Tự kiểm tra</span></button>
      <button class="study-btn primary" data-act="similar">${ICONS.refresh}<span>Bài tương tự</span></button>
      <button class="study-btn" data-act="flash">${ICONS.cards}<span>Flashcard ôn tập</span></button>
      <button class="study-btn mindmap" data-act="mindmap">${ICONS.mindmap}<span>Mindmap trực quan</span></button>
    </div>
    <div class="selfcheck-panel"${scOpen ? '' : ' style="display:none;"'}></div>
    <div class="similar-panel" style="display:none;"></div>
  `;
  fillNotePin(wrapper, msgObj);
  wrapper.querySelector('[data-act="note"]').onclick = () => openNoteModal(msgObj, currentConversation());
  wrapper.querySelector('[data-act="flash"]').onclick = (e) => handleFlashcards(e.currentTarget, aiRow, answerText);
  wrapper.querySelector('[data-act="mindmap"]').onclick = (e) => handleMindmap(e.currentTarget, aiRow, answerText, msgObj);
  wrapper.querySelector('[data-act="selfcheck"]').onclick = (e) => toggleSelfCheck(e.currentTarget, wrapper, msgObj, answerText);
  wrapper.querySelector('[data-act="similar"]').onclick = (e) => handleSimilarProblem(e.currentTarget, wrapper, msgObj, answerText);
  if (scOpen) paintSelfCheckPanel(wrapper, msgObj, answerText);
}
function buildStudyActions(msgObj, answerText, aiRow, extraClass) {
  const wrapper = document.createElement('div');
  wrapper.className = extraClass ? `study-wrap ${extraClass}` : 'study-wrap';
  wrapper._repaint = () => paintStudyActions(wrapper, msgObj, answerText, aiRow);
  wrapper._repaint();
  return wrapper;
}

/* ================= Tự kiểm tra (Self-check) =================
 * Mục 3A: gọi endpoint RIÊNG /api/study/self-check — KHÔNG còn đi qua /api/chat (stage 'detail')
 * như trước (điều đó khiến 1 tác vụ chấm bài nhỏ chạy nguyên pipeline giải bài: adaptive budget của
 * detail, completeness check, continuation...). Payload gửi lên cũng TỐI THIỂU (chỉ problem/
 * referenceSolution/studentAttempt/language — không history, không rules, không contexts, không
 * approachText) đúng quy tắc token ở mục 3. Panel mở/đóng ngay tại chỗ (giữ trạng thái trên
 * wrapper._scOpen) để không phải render lại toàn bộ câu trả lời.
 */
function toggleSelfCheck(btn, wrapper, msgObj, answerText) {
  wrapper._scOpen = !wrapper._scOpen;
  btn.classList.toggle('active', wrapper._scOpen);
  const panel = wrapper.querySelector('.selfcheck-panel');
  panel.style.display = wrapper._scOpen ? '' : 'none';
  if (wrapper._scOpen) paintSelfCheckPanel(wrapper, msgObj, answerText);
}
function paintSelfCheckPanel(wrapper, msgObj, answerText) {
  const panel = wrapper.querySelector('.selfcheck-panel');
  const draft = wrapper._scDraft || '';
  const resultHtml = wrapper._scResult || '';
  panel.innerHTML = `
    <div class="sc-head">🧠 Tự kiểm tra</div>
    <div class="sc-hint">Bạn thử giải lại bài này theo cách hiểu của mình, AI sẽ chấm và chỉ ra chỗ sai.</div>
    <textarea class="sc-input" placeholder="Viết lời giải của bạn...">${draft.replace(/</g, '&lt;')}</textarea>
    <button class="sc-submit" type="button">Kiểm tra bài làm</button>
    <div class="sc-result"${resultHtml ? '' : ' style="display:none;"'}></div>
  `;
  const inputEl = panel.querySelector('.sc-input');
  inputEl.addEventListener('input', () => { wrapper._scDraft = inputEl.value; });
  const resultEl = panel.querySelector('.sc-result');
  if (resultHtml) { resultEl.innerHTML = wrapper._scResult; }
  panel.querySelector('.sc-submit').onclick = () => runSelfCheck(panel, wrapper, msgObj, answerText);
}
const SC_STATUS_LABEL = {
  correct: '✅ Đúng', minor_error: '⚠️ Sai một bước nhỏ', major_error: '❌ Sai', incomplete: '✏️ Chưa hoàn chỉnh'
};
async function runSelfCheck(panel, wrapper, msgObj, answerText) {
  const attempt = panel.querySelector('.sc-input').value.trim();
  if (!attempt) { panel.querySelector('.sc-input').focus(); return; }
  const submitBtn = panel.querySelector('.sc-submit');
  const resultEl = panel.querySelector('.sc-result');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Đang chấm bài…';
  resultEl.style.display = '';
  resultEl.innerHTML = '<div class="sc-loading">Đang đọc bài làm của bạn…</div>';
  const problemText = (msgObj && msgObj.query) ? msgObj.query : '(đề bài kèm ảnh ở phía trên)';
  try {
    // Mục 3A/3B: endpoint riêng, payload tối thiểu — server tự làm deterministic-first rồi mới
    // targeted-AI (xem studyTasks.js), có thể trả về ngay với aiCalls:0 nếu đáp số khớp/sai rõ ràng.
    const data = await apiPost('/api/study/self-check', {
      problem: problemText,
      referenceSolution: (answerText || '').slice(0, 4000),
      studentAttempt: attempt,
      language: state.settings.lang
    });
    resultEl.innerHTML = '';
    const label = SC_STATUS_LABEL[data.status] || data.status || '';
    const errorsHtml = (data.errors || []).map((e) => `<li><b>${(e.step || '').replace(/</g, '&lt;')}:</b> ${(e.issue || '').replace(/</g, '&lt;')}${e.correction ? ' → ' + e.correction.replace(/</g, '&lt;') : ''}</li>`).join('');
    const wrap = document.createElement('div');
    wrap.className = 'sc-verdict';
    wrap.innerHTML = `<div class="sc-status">${label}${Number.isFinite(data.score) ? ` — ${data.score}/100` : ''}</div>${errorsHtml ? `<ul class="sc-errors">${errorsHtml}</ul>` : ''}`;
    resultEl.appendChild(wrap);
    if (data.hint) renderAnswerBlock(resultEl, data.hint);
    wrapper._scResult = resultEl.innerHTML;
  } catch (e) {
    resultEl.innerHTML = '<div class="sc-error">Chưa chấm được bài lần này. Vui lòng thử lại.</div>';
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Kiểm tra bài làm';
  }
}

/* ================= Bài tương tự =================
 * Mục 3C: gọi endpoint RIÊNG /api/study/similar — KHÔNG còn dùng input.value + sendMessage() (điều
 * đó biến "1 bài tương tự" thành 1 bài toán MỚI chạy nguyên approach/detail/adaptive-budget/history/
 * drawing/completeness/continuation). Endpoint mới CHỈ sinh đề (server có thể trả lời bằng template
 * deterministic, 0 lệnh AI, cho dạng bài đơn giản — xem studyTasks.js). Hiển thị đề trước, ẨN đáp án,
 * người dùng chủ động bấm "Xem đáp án"; chỉ khi bấm "Giải bài này" mới thực sự chạy pipeline giải
 * bài đầy đủ qua sendMessage().
 */
async function handleSimilarProblem(btn, wrapper, msgObj, answerText) {
  const panel = wrapper.querySelector('.similar-panel');
  panel.style.display = '';
  panel.innerHTML = '<div class="sc-loading">Đang tạo bài tương tự…</div>';
  const problemText = (msgObj && msgObj.query) ? msgObj.query : '';
  try {
    const data = await apiPost('/api/study/similar', {
      problem: problemText,
      solutionMetadata: (answerText || '').slice(0, 1500),
      difficulty: 'same',
      language: state.settings.lang
    });
    panel.innerHTML = `
      <div class="sc-head">🔁 Bài tương tự</div>
      <div class="similar-problem"></div>
      <div class="similar-answer" style="display:none;"></div>
      <div class="similar-actions">
        <button class="sc-submit similar-show-answer" type="button">Xem đáp án</button>
        <button class="sc-submit similar-solve" type="button">Giải bài này</button>
      </div>
    `;
    renderAnswerBlock(panel.querySelector('.similar-problem'), data.problem || '');
    const answerEl = panel.querySelector('.similar-answer');
    answerEl.textContent = data.answer ? `Đáp số: ${data.answer}` : '';
    panel.querySelector('.similar-show-answer').onclick = (e) => {
      answerEl.style.display = answerEl.style.display === 'none' ? '' : 'none';
    };
    panel.querySelector('.similar-solve').onclick = () => {
      const input = el('qInput');
      input.value = data.problem || '';
      input.dispatchEvent(new Event('input'));
      scrollThreadToBottom();
      sendMessage();
    };
  } catch (e) {
    panel.innerHTML = '<div class="sc-error">Chưa tạo được bài tương tự lần này. Vui lòng thử lại.</div>';
  }
}

function paintNoteBlock(wrapper, msgObj) {
  const hasNote = !!(msgObj && msgObj.userNote);
  wrapper.innerHTML = `
    ${notePinHtml(msgObj)}
    <div class="study-actions">${noteButtonHtml(hasNote)}</div>
  `;
  fillNotePin(wrapper, msgObj);
  wrapper.querySelector('[data-act="note"]').onclick = () => openNoteModal(msgObj, currentConversation());
}
function buildNoteBlock(msgObj) {
  const wrapper = document.createElement('div');
  wrapper.className = 'study-wrap approach-note-block';
  wrapper._repaint = () => paintNoteBlock(wrapper, msgObj);
  wrapper._repaint();
  return wrapper;
}

/**
 * Tạo 1 vùng "xem trước trực tiếp" trong lúc AI đang stream câu trả lời — chỉ hiển thị văn bản
 * thô (đã escape an toàn, KHÔNG render Markdown/KaTeX) kèm con trỏ nhấp nháy, vì cố render
 * Markdown/công thức LaTeX từng phần dở dang khi văn bản chưa đầy đủ rất dễ vỡ giao diện (chính là
 * lỗi công thức LaTeX bị cắt bởi <br> đã sửa ở renderMarkdownLite). Sau khi stream xong, nơi gọi tự
 * gỡ bỏ vùng preview này và gọi renderAnswerBlock() để render bản đầy đủ, đẹp, có công thức.
 */
function startStreamingPreview(container) {
  const wrap = document.createElement('div');
  wrap.className = 'stage-block streaming-preview';
  const statusLine = document.createElement('div');
  statusLine.className = 'stream-status';
  statusLine.style.display = 'none';
  const pre = document.createElement('div');
  pre.className = 'stream-text typing-cursor';
  wrap.appendChild(statusLine);
  wrap.appendChild(pre);
  container.appendChild(wrap);
  let text = '';
  return {
    wrap,
    append(delta) {
      if (!delta) return;
      text += delta;
      statusLine.style.display = 'none';
      pre.style.display = '';
      pre.textContent = text;
    },
    setStatus(message, state) {
      statusLine.style.display = '';
      statusLine.textContent = message || '';
      // Mục 17: đánh dấu trực quan RECOVERING khác GENERATING — người dùng biết AI đang thử khôi
      // phục lại phần thiếu (không phải lỗi, cũng không phải đã xong), tránh hiểu nhầm là bị treo.
      statusLine.classList.toggle('is-recovering', state === 'RECOVERING');
    },
    getText: () => text
  };
}

/**
 * renderPartialWarning() — banner cảnh báo cho câu trả lời ở trạng thái PARTIAL (server đã dùng hết
 * mọi đường recovery mà nội dung vẫn chưa đầy đủ). Trước đây trường hợp này bị coi là lỗi và toàn bộ
 * phần đã sinh bị xoá; giờ phần đó được giữ lại + hiển thị rõ là chưa đầy đủ, để người học không mất
 * công đọc lại từ đầu và biết chính xác cần bấm gì để tiếp tục.
 */
function renderPartialWarning(container, data) {
  if (!container || !data || !data.partial) return;
  const box = document.createElement('div');
  box.className = 'partial-warning';
  const reasons = Array.isArray(data.incompleteReasons) ? data.incompleteReasons : [];
  const reasonText = reasons.length ? ' (' + reasons.join(', ') + ')' : '';
  box.textContent = 'Câu trả lời này CHƯA ĐẦY ĐỦ' + reasonText +
    '. Phần đã hiển thị vẫn chính xác và được giữ lại; bạn có thể yêu cầu AI viết tiếp phần còn thiếu.';
  container.appendChild(box);
}

/* ============================================================================================
 * MỤC 1.4 — HIỂN THỊ HÌNH MINH HOẠ: CARD + LIGHTBOX + TẢI PNG + OVERLAY SỐ LIỆU
 * ============================================================================================
 * renderVisuals() giữ NGUYÊN chữ ký cũ (container, visuals, status) để mọi nơi đang gọi không phải
 * sửa; phần thân tách thành các hàm con để test được từng mảnh:
 *   renderVisualCard()  -> renderVisualImage()
 *                       -> renderVisualCaption()
 *                       -> renderVisualOverlay()   (MỤC 1.3 — số liệu ĐÃ VERIFY, có nút ẩn/hiện)
 *                       -> renderVisualActions()   (Mở ảnh / Tải PNG)
 *   openVisualLightbox() (Esc đóng, click nền đóng, có nút tải ngay trong lightbox)
 *
 * An toàn: server CHỈ gửi ẢNH AI THẬT — `format:'data_url'|'image_url'` (đã qua magic-bytes ở
 * imageBinaryValidator + visualValidator). Client vẫn kiểm tra lại lần nữa trước khi nhúng
 * (isGeneratedImageVisual) và KHÔNG BAO GIỜ nhúng SVG/HTML làm nội dung hình. Mọi text đều gán
 * bằng textContent, không innerHTML.
 */

// === VISUAL_DOWNLOAD_BLOCK_START === (neo cho test/visual-upgrade.test.js: loadVisualModule() trích
// đúng khối hàm này để chạy trong sandbox DOM giả — không đổi/xoá dòng đánh dấu này khi sửa code.)
/** MIME thật (đã qua validate — server hoặc blob.type từ Content-Type đã kiểm) -> extension file. */
const VISUAL_EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

/**
 * Tên file tải: `<subject>-<visualId>.<ext>` — không chứa câu hỏi/dữ liệu nhạy cảm.
 *
 * MỤC 6 (đợt audit 2) — ROOT CAUSE: thuộc tính `download="..."` gán TRONG JS luôn THẮNG
 * `Content-Disposition` mà server trả về (kể cả khi server đã sửa đúng extension ở mục 6 phía
 * `safeFilename()` trong routes/visual.js) — nên nếu hàm này cứ hard-code `.png`, người dùng tải
 * JPEG/WebP thật vẫn nhận file mang tên `.png`: giả mạo định dạng dù BINARY bên trong là thật.
 * `mime` tham số 2 (tuỳ chọn) LUÔN phải là mime ĐÃ ĐƯỢC XÁC MINH (server Content-Type qua
 * validateImageBuffer, hoặc `blob.type` sau khi fetch — không phải đoán trước khi tải).
 * @param {object} v visual
 * @param {string} [mime] mime thật đã xác minh; thiếu -> mặc định 'png' (dùng làm gợi ý TRƯỚC khi tải xong).
 */
function visualDownloadName(v, mime) {
  const clean = (s, fallback) => String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || fallback;
  const ext = VISUAL_EXT_BY_MIME[String(mime || '').toLowerCase()] || 'png';
  return clean(v && v.subject, 'visual') + '-' + clean(v && v.visualId, 'image') + '.' + ext;
}

/**
 * visualProxySrc() — URL để HIỂN THỊ/TẢI một ảnh AI.
 * `data:` URI dùng thẳng. Link `https://` của provider PHẢI đi qua /api/visual/download: CSP của
 * app cố ý chỉ cho `img-src 'self' data: blob:` và `connect-src 'self'`, nới CSP cho domain provider
 * là đổi bề mặt bảo mật của cả app chỉ vì 1 tấm ảnh. Proxy có whitelist domain cứng (chống SSRF).
 * @param {object} v visual
 * @param {'inline'|'attachment'} disposition inline = hiển thị trong thẻ <img>, attachment = tải về.
 */
function visualProxySrc(v, disposition) {
  if (/^data:/i.test(v.url)) return v.url;
  // PHẦN B: ảnh lớn không còn nhúng base64 vào response — server trả tham chiếu nội bộ
  // `/api/visual/asset/<id>`. Đây là URL CÙNG-ORIGIN, không đi qua proxy download (proxy chỉ dành
  // cho link https của provider bên ngoài).
  if (/^\/api\/visual\/asset\//.test(String(v.url || ''))) {
    const params = ['subject=' + encodeURIComponent(v.subject || '')];
    if (disposition === 'inline') params.push('inline=1');
    return v.url + '?' + params.join('&');
  }
  return '/api/visual/download?url=' + encodeURIComponent(v.url)
    + '&subject=' + encodeURIComponent(v.subject || '')
    + '&visualId=' + encodeURIComponent(v.visualId || '')
    + (disposition === 'inline' ? '&inline=1' : '');
}

/** @returns {boolean} v là ẢNH THẬT do image model sinh. */
function isGeneratedImageVisual(v) {
  return !!(v && (v.format === 'data_url' || v.format === 'image_url' || v.format === 'asset_url')
    && typeof v.url === 'string' && /^(data:image\/|https:\/\/|\/api\/visual\/asset\/)/i.test(v.url));
}

/**
 * MỤC 17 — nút "Thử tạo lại": chỉ gọi lại PIPELINE ẢNH (POST /api/visual/retry), KHÔNG đụng vào
 * text answer đã có. Thành công -> thay nguyên khối card hiện tại bằng card ảnh AI thật; thất bại
 * -> báo lỗi ngắn gọn ngay trên nút, không throw, không phá layout.
 */
function makeVisualRetryButton(v, hostEl) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'visual-btn visual-btn-retry';
  btn.textContent = t('chat.visualRetry');
  btn.addEventListener('click', async () => {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = t('chat.visualGenerating');
    try {
      const res = await fetch('/api/visual/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visualId: v.visualId })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        btn.textContent = t('chat.visualRetryFailed');
        setTimeout(() => { btn.textContent = label; btn.disabled = false; }, 2500);
        return;
      }
      // Ảnh AI thật đã sinh được -> ghép lại thành visual đầy đủ và VẼ LẠI TOÀN BỘ card tại chỗ,
      // không chỉ thay <img> — card cũ (nếu là stub renderFailed) chưa có body/actions đúng dạng.
      const merged = {
        ...v, format: data.format, url: data.url, renderer: data.renderer,
        origin: data.origin, fidelity: data.fidelity, model: data.model,
        renderFailed: false
      };
      const newCard = renderVisualCard(merged);
      const oldCard = hostEl.closest ? hostEl.closest('.visual-card') : null;
      if (newCard && oldCard && oldCard.parentNode) oldCard.parentNode.replaceChild(newCard, oldCard);
    } catch (e) {
      btn.textContent = t('chat.visualRetryFailed');
      setTimeout(() => { btn.textContent = label; btn.disabled = false; }, 2500);
    }
  });
  return btn;
}

/**
 * MỤC 16/17 — card lỗi khi TOÀN BỘ visual pipeline thất bại nhưng đây là hình NGƯỜI DÙNG YÊU CẦU
 * TƯỜNG MINH hoặc NECESSARY (server phát 1 stub `{visualId, renderFailed:true}` — xem
 * visualPipeline.js mục 16/17). KHÔNG hiện "Sơ đồ thay thế" giả vờ — nói thẳng AI chưa tạo được
 * hình, kèm nút thử lại đúng theo mục 16 ("AI chưa tạo được hình này." + "Thử tạo lại").
 */
function renderVisualFailedCard(v) {
  const fig = document.createElement('figure');
  fig.className = 'visual-figure visual-card visual-card-failed';
  if (v.title) {
    const head = document.createElement('div');
    head.className = 'visual-card-head';
    head.textContent = v.title;
    fig.appendChild(head);
  }
  const msg = document.createElement('p');
  msg.className = 'visual-error-text';
  msg.textContent = t('chat.visualGenerationFailed');
  fig.appendChild(msg);
  // Không có provider ảnh: nói THẲNG cần cấu hình gì — hệ thống KHÔNG dựng hình thay thế.
  if (v.reason === 'no_image_provider') {
    const hint = document.createElement('p');
    hint.className = 'visual-error-hint';
    hint.textContent = t('chat.visualNoProvider');
    fig.appendChild(hint);
  }
  fig.appendChild(makeVisualRetryButton(v, fig));
  return fig;
}

/**
 * downloadVisualPNG() — tải ảnh về máy.
 * - `data:` URI  -> fetch -> blob -> createObjectURL -> <a download> (cùng cách đã dùng ở
 *   mmDownloadPNG cho mindmap, không viết lại kiểu khác).
 * - `https://`   -> đi qua /api/visual/download (CSP `connect-src 'self'` và CORS của provider đều
 *   chặn fetch thẳng; proxy có whitelist domain cứng, chống SSRF).
 */
async function downloadVisualPNG(v, btn) {
  if (!isGeneratedImageVisual(v)) return;
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = t('chat.visualDownloading'); }
  try {
    const res = await fetch(visualProxySrc(v, 'attachment'));
    if (!res.ok) throw new Error('download_failed');
    const blob = await res.blob();
    // MỤC 6 (đợt audit 2): dùng blob.type THẬT (từ Content-Type server đã validate byte thật ở
    // /api/visual/download, hoặc mime nhúng sẵn trong chính data: URI mà imageGenerationClient đã
    // verify) để đặt đúng extension — không còn hard-code .png bất kể binary là gì.
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = visualDownloadName(v, blob.type);
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 4000);
  } catch (e) {
    if (btn) btn.textContent = t('chat.visualDownloadFailed');
    setTimeout(() => { if (btn) { btn.textContent = label; btn.disabled = false; } }, 2500);
    return;
  }
  if (btn) { btn.textContent = label; btn.disabled = false; }
}

/**
 * downloadVisualHQ() — MỤC 2.2: tải bản 2048x2048. CHỈ chạy khi người dùng bấm tường minh nút này;
 * độ phân giải mặc định của hệ thống không đổi. Server vẫn áp cost-gate theo imageNecessity, nên
 * nút có thể bị từ chối (429) với hình chỉ ở mức "có cũng được" — khi đó báo thẳng, không lặng lẽ.
 */
async function downloadVisualHQ(v, btn) {
  if (!isGeneratedImageVisual(v)) return;
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = t('chat.visualDownloading'); }
  try {
    const res = await fetch('/api/visual/hq', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visualId: v.visualId })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok || !data.url) {
      const key = data.error === 'cost_gate_low_benefit' ? 'chat.visualHqRefused' : 'chat.visualDownloadFailed';
      if (btn) btn.textContent = t(key);
      setTimeout(() => { if (btn) { btn.textContent = label; btn.disabled = false; } }, 3000);
      return;
    }
    await downloadVisualPNG({ ...v, url: data.url, format: data.format || 'data_url' }, null);
  } catch (e) {
    if (btn) btn.textContent = t('chat.visualDownloadFailed');
    setTimeout(() => { if (btn) { btn.textContent = label; btn.disabled = false; } }, 2500);
    return;
  }
  if (btn) { btn.textContent = label; btn.disabled = false; }
}

/**
 * openVisualLightbox() — modal xem ảnh phóng to. Không dùng thư viện ngoài (dự án chưa có).
 * Esc đóng, click nền đóng, ảnh object-fit: contain, có nút tải PNG ngay trong lightbox.
 */
function openVisualLightbox(v) {
  if (!isGeneratedImageVisual(v)) return null;
  const prev = document.querySelector('.visual-lightbox');
  if (prev) prev.remove();

  const box = document.createElement('div');
  box.className = 'visual-lightbox';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', v.title || t('chat.visualOpen'));

  const inner = document.createElement('div');
  inner.className = 'visual-lightbox-inner';

  const img = document.createElement('img');
  img.className = 'visual-lightbox-img';
  img.alt = v.title || '';
  img.src = visualProxySrc(v, 'inline');
  inner.appendChild(img);

  const bar = document.createElement('div');
  bar.className = 'visual-lightbox-bar';
  const dl = document.createElement('button');
  dl.type = 'button';
  dl.className = 'visual-btn';
  dl.textContent = t('chat.visualDownload');
  dl.addEventListener('click', () => downloadVisualPNG(v, dl));
  const hq = document.createElement('button');
  hq.type = 'button';
  hq.className = 'visual-btn visual-btn-hq';
  hq.textContent = t('chat.visualDownloadHq');
  hq.addEventListener('click', () => downloadVisualHQ(v, hq));
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'visual-btn visual-btn-close';
  close.textContent = t('chat.visualClose');
  bar.appendChild(dl);
  bar.appendChild(hq);
  bar.appendChild(close);
  inner.appendChild(bar);
  box.appendChild(inner);

  const onKey = (e) => { if (e.key === 'Escape') destroy(); };
  function destroy() {
    document.removeEventListener('keydown', onKey);
    box.remove();
  }
  close.addEventListener('click', destroy);
  box.addEventListener('click', (e) => { if (e.target === box) destroy(); }); // click NỀN mới đóng
  document.addEventListener('keydown', onKey);

  document.body.appendChild(box);
  try { close.focus(); } catch (e) { /* môi trường không có focus — bỏ qua */ }
  return box;
}

/**
 * MỤC 16/21 — BUG CŨ: khi `format` là data_url/image_url nhưng ảnh KHÔNG LOAD ĐƯỢC (link hết hạn,
 * proxy lỗi, data URI hỏng), <img> chỉ hiện icon vỡ mặc định của trình duyệt bên trong khung —
 * đúng "khung trắng vô nghĩa" người dùng mô tả. Nay bắt onerror, thay body bằng thông báo lỗi rõ
 * ràng + nút "Thử tạo lại" (khi có visualId để gọi /api/visual/retry).
 */
function renderVisualImageError(v, holder) {
  holder.classList.add('visual-img-error');
  holder.innerHTML = '';
  const msg = document.createElement('p');
  msg.className = 'visual-error-text';
  msg.textContent = t('chat.visualImageLoadFailed');
  holder.appendChild(msg);
  if (v.visualId) holder.appendChild(makeVisualRetryButton(v, holder));
}

/** Thân hình dạng ẢNH AI. @returns {HTMLElement|null} */
function renderVisualImage(v) {
  if (!isGeneratedImageVisual(v)) return null;
  const holder = document.createElement('div');
  holder.className = 'visual-img-wrap';
  const img = document.createElement('img');
  img.className = 'visual-img';
  img.loading = 'lazy';
  img.alt = v.title || '';
  // Ảnh https của provider đi qua proxy (CSP img-src không mở cho domain bên thứ 3), data: dùng thẳng.
  img.src = visualProxySrc(v, 'inline');
  img.addEventListener('click', () => openVisualLightbox(v)); // click thẳng vào ảnh cũng phóng to
  img.addEventListener('error', () => renderVisualImageError(v, holder), { once: true });
  holder.appendChild(img);

  // MỤC 1.3: nhãn NEO THEO % lên chính ảnh, chỉ khi lời giải CÓ toạ độ thật (spec cung cấp
  // overlay.anchors). Không có toạ độ -> không neo gì cả, bảng chú thích dưới hình lo phần còn lại.
  const anchors = (v.overlay && Array.isArray(v.overlay.anchors)) ? v.overlay.anchors : [];
  if (anchors.length) {
    const layer = document.createElement('div');
    layer.className = 'visual-anchor-layer';
    anchors.forEach((a) => {
      const tag = document.createElement('span');
      tag.className = 'visual-anchor';
      tag.textContent = String(a.label);
      tag.style.left = a.xPct + '%';
      tag.style.top = a.yPct + '%';
      layer.appendChild(tag);
    });
    holder.appendChild(layer);
  }
  return holder;
}

/** Chú thích dưới hình. @returns {HTMLElement|null} */
function renderVisualCaption(v) {
  // BUG CŨ: khi v.caption rỗng, hàm này in lại y hệt v.title làm caption — nhưng v.title ĐÃ hiển
  // thị ở header phía trên card (renderVisualCard) rồi, nên người dùng thấy đúng 1 chuỗi lặp lại
  // 2-3 lần liền nhau trong cùng 1 card, trông như dữ liệu hỏng. Caption chỉ có giá trị khi nó
  // MANG THÊM THÔNG TIN ngoài title — nếu không có caption thật, không hiển thị gì thêm ở đây.
  const caption = String(v.caption || '').trim();
  const title = String(v.title || '').trim();
  if (!caption || caption === title) return null;
  const cap = document.createElement('figcaption');
  cap.textContent = title && caption !== title ? title + ' — ' + caption : caption;
  return cap;
}

/**
 * MỤC 1.3 — OVERLAY SỐ LIỆU ĐÃ XÁC THỰC.
 * Ảnh AI KHÔNG còn được yêu cầu tự vẽ số/công thức (mục 1.2), nên số duy nhất người học nhìn thấy
 * phải đến từ đây: `v.overlay` lấy thẳng từ spec đã verify ở server, KHÔNG gọi thêm AI nào.
 * PHẦN 14: overlay phải TOGGLE được.
 * @returns {HTMLElement|null}
 */
function renderVisualOverlay(v) {
  const o = v && v.overlay;
  if (!o) return null;
  const numbers = Array.isArray(o.numbers) ? o.numbers : [];
  const equations = Array.isArray(o.equations) ? o.equations : [];
  const labels = Array.isArray(o.labels) ? o.labels : [];
  if (!numbers.length && !equations.length && !labels.length) return null;

  const wrap = document.createElement('div');
  wrap.className = 'visual-overlay';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'visual-btn visual-overlay-toggle';
  toggle.setAttribute('aria-expanded', 'true');
  toggle.textContent = t('chat.visualHideAnnotations');

  const body = document.createElement('div');
  body.className = 'visual-overlay-body';

  if (numbers.length) {
    const list = document.createElement('ul');
    list.className = 'visual-overlay-list';
    numbers.forEach((n) => {
      const li = document.createElement('li');
      li.textContent = String(n.symbol) + ' = ' + String(n.value) + (n.unit ? ' ' + n.unit : '');
      list.appendChild(li);
    });
    body.appendChild(list);
  }
  if (equations.length) {
    const eq = document.createElement('ul');
    eq.className = 'visual-overlay-list visual-overlay-eq';
    equations.forEach((e) => {
      const li = document.createElement('li');
      li.textContent = String(e);
      eq.appendChild(li);
    });
    body.appendChild(eq);
  }
  if (labels.length) {
    const p = document.createElement('p');
    p.className = 'visual-overlay-labels';
    p.textContent = t('chat.visualPoints') + ': ' + labels.join(', ');
    body.appendChild(p);
  }

  const src = document.createElement('p');
  src.className = 'visual-overlay-source';
  src.textContent = t('chat.visualAnnotationsSource');
  body.appendChild(src);

  toggle.addEventListener('click', () => {
    const hidden = wrap.classList.toggle('is-collapsed');
    toggle.setAttribute('aria-expanded', hidden ? 'false' : 'true');
    toggle.textContent = hidden ? t('chat.visualShowAnnotations') : t('chat.visualHideAnnotations');
  });

  wrap.appendChild(toggle);
  wrap.appendChild(body);
  return wrap;
}

/**
 * Hàng nút thao tác. Mọi hình đều là ảnh AI thật -> luôn có "Mở ảnh" (lightbox) + "Tải PNG".
 * Payload không phải ảnh thật -> không có nút nào (và renderVisualCard cũng không dựng card).
 * @returns {HTMLElement|null}
 */
function renderVisualActions(v) {
  if (!isGeneratedImageVisual(v)) return null;
  const bar = document.createElement('div');
  bar.className = 'visual-actions';

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'visual-btn';
  open.textContent = t('chat.visualOpen');
  open.addEventListener('click', () => openVisualLightbox(v));

  const dl = document.createElement('button');
  dl.type = 'button';
  dl.className = 'visual-btn';
  dl.textContent = t('chat.visualDownload');
  dl.addEventListener('click', () => downloadVisualPNG(v, dl));

  bar.appendChild(open);
  bar.appendChild(dl);
  return bar;
}

/** Một card hình hoàn chỉnh. @returns {HTMLElement|null} null khi payload không phải ảnh AI thật. */
function renderVisualCard(v) {
  if (!v) return null;
  if (v.renderFailed) return renderVisualFailedCard(v); // stub lỗi kèm nút thử lại.
  // Chỉ ẢNH AI THẬT mới được dựng thành card. Không có nhánh SVG nào ở đây nữa: payload lạ ->
  // không hiển thị gì, text answer vẫn nguyên vẹn.
  const body = renderVisualImage(v);
  if (!body) return null;

  const fig = document.createElement('figure');
  fig.className = 'visual-figure visual-card visual-card-image';

  if (v.title) {
    const head = document.createElement('div');
    head.className = 'visual-card-head';
    head.textContent = v.title;
    fig.appendChild(head);
  }
  fig.appendChild(body);

  const cap = renderVisualCaption(v);
  if (cap) fig.appendChild(cap);

  const overlay = renderVisualOverlay(v);
  if (overlay) fig.appendChild(overlay);

  const actions = renderVisualActions(v);
  if (actions) fig.appendChild(actions);

  // Hình do người dùng YÊU CẦU TƯỜNG MINH được nêu rõ, tách khỏi hình hệ thống tự quyết định tạo.
  if (v.necessity === 'USER_REQUESTED' || v.overrodeNever) {
    const note = document.createElement('p');
    note.className = 'visual-origin-note';
    note.textContent = v.overrodeNever
      ? 'Đã tạo hình theo yêu cầu của bạn, dù cài đặt đang tắt hình minh hoạ.'
      : 'Hình được tạo theo yêu cầu của bạn.';
    fig.appendChild(note);
  }
  return fig;
}

/**
 * renderVisuals() — gắn hình minh hoạ vào 1 khối câu trả lời. CHỮ KÝ GIỮ NGUYÊN.
 *
 * PHẦN 16: `status==='pending'` hiện "Đang tạo hình minh hoạ…" — KHÔNG để trống (trống trông y hệt
 * lỗi). PHẦN 32: `status==='failed'` KHÔNG BAO GIỜ hiển thị như lỗi câu trả lời — chỉ 1 dòng ghi chú.
 */
function renderVisuals(container, visuals, status) {
  if (!container) return;
  // Dọn placeholder loading của lượt trước (nếu có) trước khi vẽ kết quả thật.
  container.querySelectorAll('.visual-loading').forEach((el) => el.remove());

  if (status === 'pending') {
    const wait = document.createElement('div');
    wait.className = 'visual-note visual-loading';
    wait.textContent = t('chat.visualGenerating');
    container.appendChild(wait);
    return;
  }
  // MỤC 2.7: KHÔNG BAO GIỜ hiện "không thể tạo hình" khi thực tế đã có ít nhất 1 visual hợp lệ.
  // Trạng thái 'failed' chỉ đúng khi mảng visuals thật sự rỗng; nếu pipeline trả 'failed' kèm visual
  // (vd một nhánh fallback vẫn dựng được) thì thông báo lỗi là SAI và làm người dùng bỏ qua hình đã có.
  const hasVisual = Array.isArray(visuals) && visuals.length > 0;
  if (status === 'failed' && !hasVisual) {
    const note = document.createElement('div');
    note.className = 'visual-note';
    note.textContent = t('chat.visualFailed');
    container.appendChild(note);
    return;
  }
  if (!hasVisual) return;
  visuals.forEach((v) => {
    const card = renderVisualCard(v);
    if (card) container.appendChild(card);
  });
}

function renderAnswerBlock(container, rawText) {
  const { thinking, answer, truncated } = extractThinking(rawText);
  if (thinking) {
    const details = document.createElement('details');
    details.className = 'thinking-block';
    details.innerHTML = `<summary>${escapeHtml(t('chat.thinkingProcess'))}</summary><div class="think-body"></div>`;
    details.querySelector('.think-body').textContent = thinking;
    container.appendChild(details);
  }
  const answerWrap = document.createElement('div');
  const { html, draws } = renderMarkdownLite(answer);
  answerWrap.innerHTML = html;
  container.appendChild(answerWrap);
  boxCommonMistakes(answerWrap);
  // Câu trả lời bị cắt ngang giữa chừng (hết maxTokens) — báo rõ cho người dùng thay vì để họ tưởng
  // lời giải đã xong (xem giải thích ở extractThinking()).
  if (truncated) {
    const warn = document.createElement('div');
    warn.className = 'truncated-notice';
    warn.textContent = t('chat.truncated');
    container.appendChild(warn);
  }
  renderMath(container);
  // PHẦN L: scenepatch áp lên khối scene3d GẦN NHẤT phía trước nó trong cùng câu trả lời (thứ tự tài
  // liệu == thứ tự draws[] vì cả hai được ghi lại khi quét text tuần tự ở renderMarkdownLite()).
  let lastScene3dEl = null;
  draws.forEach((d) => {
    if (d.kind === 'scenepatch') {
      if (lastScene3dEl && window.applyScenePatchToContainer) window.applyScenePatchToContainer(lastScene3dEl, d.spec);
      return;
    }
    const el2 = document.getElementById(d.id);
    renderDrawing(el2, d.kind, d.spec);
    if (d.kind === 'scene3d') lastScene3dEl = el2;
  });
  return answer;
}

/**
 * Tìm tiêu đề "## Lỗi sai thường gặp" (nếu AI có đưa vào câu trả lời) và bọc riêng nó cùng toàn bộ
 * nội dung phía sau (tới tiêu đề <h3> tiếp theo hoặc hết câu trả lời) vào 1 khung cảnh báo màu cam
 * nổi bật — thay vì chỉ là một tiêu đề "##" trông giống hệt "Tóm tắt đề bài"/"Kết luận". Mục này
 * quan trọng cho việc ôn tập nên cần dễ nhận ra ngay bằng mắt, không lẫn vào các mục khác.
 */
function boxCommonMistakes(root) {
  const heading = Array.from(root.querySelectorAll('h3')).find((h) =>
    /lỗi\s*sai\s*thường\s*gặp/i.test(h.textContent || '')
  );
  if (!heading) return;
  const box = document.createElement('div');
  box.className = 'mistakes-box';
  const title = document.createElement('div');
  title.className = 'mistakes-box-title';
  title.innerHTML = `${ICONS.warning || '⚠️'}<span>${heading.textContent}</span>`;
  box.appendChild(title);
  heading.replaceWith(box);
  // Di chuyển mọi phần tử ngay sau vị trí cũ của heading (tới <h3> tiếp theo hoặc hết) vào trong khung.
  let node = box.nextSibling;
  while (node && !(node.nodeType === 1 && node.tagName === 'H3')) {
    const next = node.nextSibling;
    box.appendChild(node);
    node = next;
  }
}

// Dòng đánh dấu "có dùng web bổ sung" mà AI được yêu cầu tự thêm vào cuối câu trả lời khi thực sự
// có tra cứu web để bù phần tài liệu còn thiếu (xem buildSourcePolicyBlock trong promptBuilder.js).
// Tách riêng dòng này khỏi nội dung chính (để không lẫn vào phần lập luận) và lưu lại làm 1 trường
// riêng trên message — dùng để hiển thị TÁCH BIỆT với nguồn tài liệu trong khối "Nguồn tham khảo",
// đúng yêu cầu "phải phân biệt rõ nguồn nội bộ và nguồn Internet".
// MỤC (đợt audit 4, nâng cấp cơ chế trích nguồn) — TRƯỚC ĐÂY chỉ bắt ĐÚNG 1 dòng "🌐 ..." đầu tiên
// (flag /m không /g): nếu AI dùng web để đối chiếu NHIỀU nguồn khác nhau trong cùng 1 câu trả lời
// (thường gặp ở "Suy nghĩ sâu"/đối chiếu đa mô hình — mỗi model có thể tra 1 trang khác nhau), mọi
// dòng nguồn TỪ THỨ 2 TRỞ ĐI bị coi là văn bản thường và không hiện trong khối "Nguồn web bổ sung" —
// người dùng THẤY có tra web nhưng KHÔNG biết đã tra ở đâu ngoài dòng đầu. NAY: bắt TOÀN BỘ (flag
// /g), giữ đúng thứ tự xuất hiện, loại trùng lặp (model lặp lại đúng 1 câu ở 2 chỗ vẫn chỉ hiện 1
// lần). Trả về MẢNG (không phải chuỗi đơn) để renderCitations() liệt kê riêng từng nguồn — đúng yêu
// cầu "khi trích nguồn phải nói rõ lấy từ nguồn nào", áp dụng cho CẢ 3 chế độ (Nhanh/Sâu/đối chiếu
// đa hướng) vì cả 3 đều đi qua đúng 1 hàm này (xem promptBuilder.js#webRule để biết định dạng AI
// phải tuân theo: mỗi nguồn thật sự dùng ra đúng 1 dòng "🌐 Nguồn: <tên trang> — <ý ngắn>").
const WEB_SOURCE_LINE_RE = /^[ \t]*🌐.*$/gm;
function extractWebSourceNote(text) {
  if (!text) return { clean: text, webNote: null };
  const matches = text.match(WEB_SOURCE_LINE_RE);
  if (!matches || !matches.length) return { clean: text, webNote: null };
  let clean = text;
  const notes = [];
  for (const line of matches) {
    clean = clean.replace(line, '');
    const note = line.replace(/^[ \t]*🌐\s*/, '').trim();
    if (note) notes.push(note);
  }
  clean = clean.replace(/\n{3,}/g, '\n\n').trim();
  const dedup = [...new Set(notes)];
  // webNote nay là MẢNG (hoặc null nếu rỗng) — renderCitations() chuẩn hoá cho cả 2 dạng (mảng mới
  // lẫn chuỗi đơn cũ, để tương thích ngược với lịch sử hội thoại đã lưu TRƯỚC bản nâng cấp này).
  return { clean, webNote: dedup.length ? dedup : null };
}

// Đối chiếu đúng những đoạn context nào AI THỰC SỰ trích dẫn bằng [n] trong answerText (chỉ tính
// [n] khớp đúng chỉ số 1..contexts.length — bỏ qua các cặp ngoặc vuông chứa số khác ngữ cảnh, vd
// ký hiệu khoảng trong LaTeX). Dùng chung cho cả renderCitations() và badge đối chiếu đa hướng, để
// 2 nơi không lệch heuristic nhau.
function getUsedContexts(contexts, answerText, citationMap) {
  const citedNums = new Set();
  if (answerText) {
    const re = /\[(\d+)\]/g;
    let m;
    while ((m = re.exec(answerText))) citedNums.add(Number(m[1]));
  }

  // Vấn đề #1: KHÔNG còn suy ra số citation từ vị trí mảng phía client (`i + 1`). Server nay gộp các
  // đoạn trích TRÙNG NHAU để tiết kiệm token, nên mảng nó gửi cho model KHÁC mảng `contexts` ở đây —
  // dùng `i + 1` sẽ hiển thị SAI đoạn (prompt nói [4] là đoạn X, client vẽ ra đoạn Y). `citationMap`
  // do server trả về là nguồn sự thật duy nhất: citeNo -> chỉ số gốc trong mảng của client.
  if (Array.isArray(citationMap) && citationMap.length) {
    return citationMap
      .filter((entry) => citedNums.has(entry.citeNo))
      .map((entry) => {
        const idx = Array.isArray(entry.originalIndexes) ? entry.originalIndexes[0] : undefined;
        const c = (contexts || [])[idx];
        if (!c) return null;
        // PHẦN F: provenance do SERVER gửi về (doc/page/evidenceId) thắng mọi suy luận phía client —
        // nếu server nói [5] là trang 72 thì client hiển thị đúng trang 72, không đoán lại theo mảng.
        const merged = Object.assign({}, c, {
          doc: entry.doc || c.doc,
          page: entry.page != null ? entry.page : c.page,
          startPage: entry.startPage != null ? entry.startPage : c.startPage,
          endPage: entry.endPage != null ? entry.endPage : c.endPage,
          evidenceId: entry.evidenceId || c.evidenceId || null,
          extractionMethod: entry.extractionMethod || c.extractionMethod || null
        });
        return { c: merged, num: entry.citeNo };
      })
      .filter(Boolean);
  }

  // Fallback (response cũ/không có citationMap): giữ đúng hành vi trước đây.
  return (contexts || [])
    .map((c, i) => ({ c, num: i + 1 }))
    .filter((x) => citedNums.has(x.num));
}

// contexts: mảng đoạn trích đã GỬI cho AI ở lượt này (ứng viên) — KHÔNG phải tất cả đều thực sự
// được dùng. answerText: câu trả lời cuối cùng đã nhận được, dùng để biết đoạn [n] nào AI THỰC SỰ
// trích dẫn (chỉ hiển thị đúng những đoạn đó — không hiển thị 1 nguồn chỉ vì nó tồn tại trong danh
// sách ứng viên, đúng yêu cầu "nguồn phải là tài liệu thực sự được AI sử dụng"). webNote: dòng
// "🌐 ..." đã tách ra từ extractWebSourceNote(), nếu có, hiển thị ở mục riêng "Nguồn web bổ sung".
function renderCitations(container, contexts, query, answerText, webNote, citationMap) {
  const used = getUsedContexts(contexts, answerText, citationMap);
  // Chuẩn hoá: webNote có thể là MẢNG (định dạng mới, xem extractWebSourceNote) hoặc CHUỖI ĐƠN
  // (dữ liệu lịch sử đã lưu từ TRƯỚC bản nâng cấp này) — luôn quy về 1 mảng đã lọc rỗng để phần hiển
  // thị bên dưới không cần phân biệt 2 dạng.
  const webNotes = Array.isArray(webNote) ? webNote.filter(Boolean) : (webNote ? [webNote] : []);

  if (!used.length && !webNotes.length) {
    // Có tài liệu đã tải lên nhưng KHÔNG đoạn nào thực sự được dùng cho câu hỏi này — nêu rõ thay
    // vì im lặng, đúng yêu cầu "phải thể hiện đúng rằng không tìm thấy thông tin phù hợp".
    if (contexts && contexts.length) {
      const note = document.createElement('div');
      note.className = 'citations citations-empty';
      note.innerHTML = '<div class="cite-title">Nguồn tham khảo</div>' +
        '<div class="cite-note">Không tìm thấy thông tin phù hợp trong tài liệu đã tải lên cho câu hỏi này — câu trả lời dựa trên kiến thức chuẩn.</div>';
      container.appendChild(note);
    }
    return;
  }

  const citeWrap = document.createElement('div');
  citeWrap.className = 'citations';
  let html = '';
  if (used.length) {
    html += '<div class="cite-title">Tài liệu đã tải lên đã dùng</div>' +
      used.map(({ c, num }) => {
        // Đoạn bị "vỡ font" khi trích xuất (thường là công thức toán dựng bằng glyph không có
        // ToUnicode) — hiển thị ghi chú thay vì đổ nguyên chuỗi ký tự rác lên màn hình, đây chính
        // là phần hiển thị "khó chịu" trong nguồn tham khảo trước đây.
        const body = c.garbled
          ? '<i>Đoạn này chứa công thức/ký hiệu đặc biệt mà trình duyệt không trích xuất được thành văn bản rõ ràng — nội dung vẫn được dùng làm căn cứ, vui lòng đối chiếu trực tiếp trang tương ứng trong tài liệu gốc.</i>'
          : highlightSnippet(c.text, query);
        // PHẦN A9: citation khớp đúng trang khi chunk có metadata trang (PDF) — "trang X" hoặc
        // "trang X-Y" nếu chunk trải dài nhiều trang (hiện tại mỗi chunk chỉ nằm trong 1 trang, xem
        // chunkText(), nhưng vẫn xử lý startPage!==endPage để không vỡ nếu logic chunk đổi sau này).
        const pageLabel = c.page != null
          ? (c.startPage != null && c.endPage != null && c.startPage !== c.endPage
            ? ` · trang ${c.startPage}-${c.endPage}` : ` · trang ${c.page}`)
          : '';
        return `<div class="cite"><b>[${num}] ${escapeHtml(c.doc)}${pageLabel} · đoạn ${escapeHtml(String(c.id))}</b><br>${body}</div>`;
      }).join('');
  }
  if (webNote) {
    const esc = String(webNote).replace(/</g, '&lt;');
    html += `<div class="cite-title cite-title-web">Nguồn web bổ sung</div><div class="cite cite-web">🌐 ${esc}</div>`;
  }
  citeWrap.innerHTML = html;
  container.appendChild(citeWrap);
  renderMath(citeWrap);
}

// Vẽ lại mindmap ĐÃ LƯU của CHÍNH msg này (nếu có) ngay dưới cùng của aiRow — dùng cho câu trả lời
// bài toán bình thường (có Hướng giải/Lời giải chi tiết) mà người dùng từng bấm "Mindmap trực quan"
// ở dưới. Tách riêng hàm để gọi được ở cả 2 nhánh (có/không có "Lời giải chi tiết") mà không lặp code.
function attachSavedMindmapIfAny(aiRow, msg) {
  if (!msg.mindmapSpec) return;
  const wrap = document.createElement('div');
  wrap.className = 'mindmap-wrap';
  aiRow.appendChild(wrap);
  renderMindmap(wrap, msg.mindmapSpec);
}

// Render lại đầy đủ 1 message AI đã lưu (khi mở lại cuộc trò chuyện cũ)
function renderStoredAiMessage(msg) {
  const isPureMindmap = msg.mindmapOnly && msg.mindmapSpec;
  const aiRow = addAiMsg(msg.outlineSpec ? 'Đề cương' : isPureMindmap ? 'Mindmap' : 'Trợ Giải');
  if (msg.id) aiRow.dataset.msgId = msg.id;
  const contentEl = aiRow.querySelector('.content');
  contentEl.innerHTML = '';
  setMsgSubjectBadge(aiRow, msg.subjectId, msg.subjectConfidence, msg.secondarySubjectId);

  // Tin nhắn đề cương trực tiếp (xem handleOutlineOnlyTurn) — 1 câu trả lời duy nhất, không có
  // giai đoạn "Hướng giải"/"Lời giải chi tiết" nào để dựng lại, chỉ cần vẽ lại đúng spec đã lưu.
  if (msg.outlineSpec) {
    renderOutlineAnswer(contentEl, msg.outlineSpec, msg, aiRow);
    return;
  }

  // Tương tự cho mindmap trực tiếp (xem handleMindmapOnlyTurn) — vẽ lại sơ đồ từ spec đã lưu, không
  // gọi lại API. CHỈ áp dụng nhánh tắt này khi msg.mindmapOnly === true (tin nhắn CHỈ có mindmap,
  // không có Hướng giải/Lời giải riêng) — trước đây điều kiện chỉ kiểm tra msg.mindmapSpec, nên 1
  // câu trả lời bài toán bình thường có gắn thêm mindmap (qua nút "Mindmap trực quan") sẽ lọt vào
  // đúng nhánh này và MẤT toàn bộ Hướng giải/Lời giải chi tiết khi mở lại — đây chính là gốc của lỗi
  // "mở mindmap môn này lại ra môn khác" (msgObj của câu trả lời bài toán trước đây còn không có
  // mindmapSpec vì handleMindmap() cũ không lưu lại được, nên nhánh này coi như "không có mindmap"
  // và rơi xuống nhánh bên dưới — nay đã lưu đúng nên phải phân biệt rõ 2 trường hợp).
  if (isPureMindmap) {
    const wrap = document.createElement('div');
    wrap.className = 'mindmap-wrap';
    contentEl.appendChild(wrap);
    renderMindmap(wrap, msg.mindmapSpec);
    contentEl.appendChild(buildNoteBlock(msg));
    return;
  }

  const approachWrap = document.createElement('div');
  approachWrap.className = 'stage-block stage-approach';
  contentEl.appendChild(approachWrap);
  renderAnswerBlock(approachWrap, msg.approach || '');
  renderVisuals(approachWrap, msg.approachVisuals, msg.approachVisualStatus);
  renderCitations(approachWrap, msg.contexts, msg.query, msg.approach || '', msg.approachWebNote, msg.approachCitationMap);

  if (msg.detail) {
    appendDetailSection(contentEl, msg, aiRow);
  } else {
    // Luôn hiển thị đủ các nút chức năng (Ghi chú/Flashcard/Mindmap) ngay từ giai đoạn
    // Hướng giải — xem giải thích đầy đủ ở đầu buildStudyActions().
    contentEl.appendChild(buildStudyActions(msg, msg.approach || '', aiRow, 'approach-note-block'));
    const btnWrap = document.createElement('div');
    btnWrap.className = 'detail-btn-wrap';
    btnWrap.innerHTML = `<button class="detail-btn">${ICONS.compass}<span>${escapeHtml(t('chat.detailBtn'))}</span></button>`;
    // FIX ROOT CAUSE #1 (mục 7): trước đây luôn truyền `null` làm ảnh, khiến request "Xem cách giải
    // chi tiết" sau F5 KHÔNG BAO GIỜ còn ảnh gốc dù message có imageId. Nay khôi phục ảnh từ
    // IndexedDB (nếu có) TRƯỚC khi gọi fetchDetail() — nút hiện trạng thái chờ ngắn trong lúc đó.
    btnWrap.querySelector('.detail-btn').onclick = (e) => handleDetailClickWithRestore(e.currentTarget, aiRow, contentEl, msg);
    contentEl.appendChild(btnWrap);
  }
  // Nếu câu trả lời này từng được vẽ mindmap riêng (nút "Mindmap trực quan") thì vẽ lại ĐÚNG sơ đồ
  // đã lưu của chính msg này — an toàn gọi cả khi msg.mindmapSpec chưa có (hàm tự bỏ qua).
  attachSavedMindmapIfAny(aiRow, msg);
}

function appendDetailSection(contentEl, msg, aiRow) {
  const sep = document.createElement('div');
  sep.className = 'stage-divider';
  sep.innerHTML = '<span>Lời giải chi tiết</span>';
  contentEl.appendChild(sep);

  const detailWrap = document.createElement('div');
  detailWrap.className = 'stage-block stage-detail';
  contentEl.appendChild(detailWrap);
  const answerPlain = renderAnswerBlock(detailWrap, msg.detail || '');
  renderVisuals(detailWrap, msg.detailVisuals, msg.detailVisualStatus);
  renderCitations(detailWrap, msg.contexts, msg.query, msg.detail || '', msg.detailWebNote, msg.detailCitationMap);

  if (msg.crossChecked) {
    const badge = document.createElement('div');
    badge.className = 'crosscheck-badge';
    const providers = Array.isArray(msg.providers) && msg.providers.length ? msg.providers : null;
    const modelsPart = providers
      ? `✔️ Đã đối chiếu ${providers.length} lượt giải độc lập (${providers.join(', ')})`
      : '✔️ Đã đối chiếu 2 hướng giải độc lập';
    const reconcilePart = msg.reconciledBy ? ` — tổng hợp bởi ${msg.reconciledBy}` : '';
    // Phản ánh ĐÚNG nguồn thực sự được dùng ở câu trả lời cuối (có [n] trích tài liệu và/hoặc dòng
    // ghi chú web bổ sung) — thay vì suy đoán chỉ từ việc CÓ gửi context hay không (trước đây: có
    // context là ghi "đối chiếu với nguồn tài liệu" dù AI có thể không dùng đoạn nào trong đó).
    const usedDocs = getUsedContexts(msg.contexts, msg.detail || '').length > 0;
    const usedWeb = !!msg.detailWebNote;
    let sourcePart = '';
    if (usedDocs && usedWeb) sourcePart = ' + đối chiếu tài liệu & tìm kiếm web bổ sung';
    else if (usedDocs) sourcePart = ' + đối chiếu với nguồn tài liệu';
    else if (usedWeb) sourcePart = ' + xác minh công thức qua tìm kiếm web';
    badge.innerHTML = modelsPart + reconcilePart + sourcePart;
    contentEl.appendChild(badge);
  }

  contentEl.appendChild(buildStudyActions(msg, answerPlain, aiRow));
}

/* ================= Gửi câu hỏi (2 giai đoạn: Hướng giải -> Lời giải chi tiết) ================= */
el('qInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
el('qInput').addEventListener('input', function () { this.style.height = 'auto'; this.style.height = Math.min(this.scrollHeight, 150) + 'px'; });
el('sendBtn').onclick = sendMessage;

/* ================= PHẦN D/F — VOICE INPUT (microphone) =================
   Luồng ĐẦY ĐỦ, không có nhánh nào gọi thêm AI:
       click #micBtn
         -> voiceInput.start()  (trình duyệt tự xin quyền microphone nếu chưa có)
         -> Web Speech API nhận dạng NGAY TRONG TRÌNH DUYỆT
         -> transcript được GHÉP vào #qInput (không xoá nội dung đang gõ — PHẦN 24)
         -> dispatch 'input' để auto-resize + mọi listener hiện có chạy như khi gõ tay (PHẦN 19)
         -> NGƯỜI DÙNG tự bấm "Giải bài" (PHẦN 15/25: KHÔNG tự động gửi)
   Không có audio nào rời khỏi máy người dùng, không có request nào tới /api/chat từ bước này. */
(function setupVoiceInput() {
  const micBtn = el('micBtn');
  const statusBox = el('voiceStatus');
  const statusText = el('voiceStatusText');
  const interimEl = el('voiceInterim');
  if (!micBtn) return;

  const tr = (key, fallback) => (typeof window.t === 'function' ? window.t(key) : fallback) || fallback;

  function showStatus(kind, message) {
    if (!statusBox) return;
    statusBox.classList.remove('error', 'unsupported');
    if (kind) statusBox.classList.add(kind);
    if (statusText) statusText.textContent = message || '';
    if (message) statusBox.classList.add('show'); else statusBox.classList.remove('show');
  }

  function clearInterim() { if (interimEl) interimEl.textContent = ''; }

  function setButtonState(st) {
    micBtn.classList.remove('recording', 'processing', 'mic-error');
    if (st === 'recording') micBtn.classList.add('recording');
    else if (st === 'processing') micBtn.classList.add('processing');
    else if (st === 'error') micBtn.classList.add('mic-error');
    micBtn.setAttribute('aria-pressed', st === 'recording' ? 'true' : 'false');
    micBtn.setAttribute(
      'aria-label',
      st === 'recording' ? tr('voice.micStopAria', 'Dừng ghi âm') : tr('voice.micAria', 'Nhập câu hỏi bằng giọng nói')
    );
  }

  // Trình duyệt không hỗ trợ -> DISABLE nút + báo rõ ràng. Không throw, không crash (PHẦN 16/23).
  if (!window.voiceInput || !window.voiceInput.isSupported()) {
    micBtn.disabled = true;
    micBtn.title = tr('voice.unsupported', 'Trình duyệt này không hỗ trợ nhập bằng giọng nói.');
    micBtn.setAttribute('aria-disabled', 'true');
    return;
  }

  const ERROR_KEY = {
    'not-allowed': 'voice.errNotAllowed',
    'service-not-allowed': 'voice.errNotAllowed',
    'no-speech': 'voice.errNoSpeech',
    'audio-capture': 'voice.errAudioCapture',
    network: 'voice.errNetwork',
    unsupported: 'voice.unsupported'
  };

  /**
   * PHẦN 24: KHÔNG BAO GIỜ xoá nội dung người dùng đang gõ. Quy tắc ghép rõ ràng:
   *   - #qInput rỗng            -> transcript trở thành nội dung.
   *   - #qInput đã có nội dung  -> nối vào CUỐI, tự thêm đúng MỘT khoảng trắng nếu cần.
   * Ví dụ: "Giải phương trình " + "hai x cộng ba bằng bảy"
   *     -> "Giải phương trình hai x cộng ba bằng bảy"
   */
  function appendTranscript(text) {
    const input = el('qInput');
    if (!input || !text) return;
    const current = input.value || '';
    if (!current) input.value = text;
    else input.value = /\s$/.test(current) ? current + text : current + ' ' + text;
    // PHẦN 19: phát 'input' để auto-resize textarea + mọi listener khác chạy y như khi gõ tay.
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    // Đưa con trỏ về cuối để người dùng sửa tiếp ngay.
    try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) { /* noop */ }
  }

  function startListening() {
    clearInterim();
    let lang;
    try {
      lang = window.voiceInput.resolveRecognitionLang(state && state.settings ? state.settings.lang : undefined);
    } catch (e) { lang = undefined; }

    window.voiceInput.start({
      lang,
      onPartial: (partial) => { if (interimEl) interimEl.textContent = partial; },
      onResult: (finalText) => {
        // CHỈ đưa text vào ô nhập. KHÔNG gọi sendMessage() ở đây (PHẦN 15/25).
        appendTranscript(finalText);
      },
      onError: (code) => {
        clearInterim();
        showStatus('error', tr(ERROR_KEY[code] || 'voice.errGeneric', 'Không nhận dạng được giọng nói.'));
      },
      onEnd: () => {
        clearInterim();
        if (window.voiceInput.getState() !== 'error') showStatus(null, '');
      }
    });
  }

  micBtn.addEventListener('click', () => {
    try {
      const st = window.voiceInput.getState();
      if (st === 'recording' || st === 'processing') { window.voiceInput.stop(); return; }
      if (st === 'error') window.voiceInput.resetError();
      startListening();
    } catch (e) {
      // Lớp phòng thủ cuối: không bao giờ để lỗi microphone làm hỏng app (PHẦN 23).
      showStatus('error', tr('voice.errGeneric', 'Không nhận dạng được giọng nói.'));
    }
  });

  // Esc dừng ghi âm (PHẦN 18). Dùng capture=false và CHỈ xử lý khi đang ghi, nên không đụng tới
  // các handler Esc sẵn có (đóng lightbox/popover).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const st = window.voiceInput.getState();
    if (st === 'recording' || st === 'processing') {
      e.stopPropagation();
      window.voiceInput.abort();
    }
  });

  window.voiceInput.subscribe((st) => {
    setButtonState(st);
    if (st === 'recording') showStatus(null, tr('voice.listening', 'Đang nghe…') + ' · ' + tr('voice.stopHint', 'Bấm lại hoặc nhấn Esc để dừng'));
    else if (st === 'processing') showStatus(null, tr('voice.processing', 'Đang xử lý giọng nói…'));
    else if (st === 'idle') { clearInterim(); showStatus(null, ''); }
  });

  setButtonState('idle');
})();

function finalizePendingTurnIfAny() {
  // Nếu lượt trước đó chỉ mới có "Hướng giải" mà người dùng chưa bấm xem chi tiết,
  // vẫn lưu tạm hướng giải vào ngữ cảnh để AI không bị mất mạch khi hỏi tiếp câu khác.
  if (!pendingTurn) return;
  state.history.push({ role: 'user', content: pendingTurn.query || '[Người dùng đã gửi ảnh đề bài để giải]' });
  state.history.push({ role: 'assistant', content: pendingTurn.approachRaw || '' });
  trimHistoryMemory();
  pendingTurn = null;
}

async function sendMessage() {
  const input = el('qInput');
  const query = input.value.trim();
  const image = state.pendingImage;
  if (!query && !image) return;
  // Race condition (mục 11): người dùng bấm gửi ngay khi ảnh vừa chọn còn đang xử lý (FileReader/
  // IndexedDB chưa xong) hoặc ảnh bị lỗi (không decode được) — KHÔNG được gửi thiếu base64.
  if (image && image.status === 'loading') { alert(t('error.imageProcessing')); return; }
  if (image && image.status === 'error') { alert(image.errorMessage || t('error.imageUnusable')); return; }
  // PHẦN F: chặn double-submit CHỈ khi CHÍNH conversation đang mở đã có task chạy — KHÔNG còn chặn
  // toàn app (trước đây sendBtn.disabled là cờ TOÀN CỤC, chặn gửi ở MỌI conversation cùng lúc).
  const activeConvForGuard = currentConversation();
  if (activeConvForGuard && window.conversationTaskManager && window.conversationTaskManager.isGenerating(activeConvForGuard.id)) return;
  input.value = ''; input.style.height = 'auto';

  // FIX PHẦN 9: TRƯỚC ĐÂY scheduleRecommend(query) được gọi TỰ ĐỘNG cho MỌI câu hỏi (kể cả 1 bài
  // toán bình thường không hề liên quan tới "đề xuất ôn tập") — tốn thêm 1 lượt gọi AI+web search
  // cho gần như mọi lượt hỏi, dù người dùng không hề yêu cầu. NAY: chỉ nhớ câu hỏi gần nhất
  // (lastQueryForRecommend, KHÔNG gọi AI/web gì cả) để dùng khi người dùng THỰC SỰ chủ động yêu
  // cầu — bấm mở khung "Đề xuất ôn tập" (xem openRecommendPanel()) hoặc hỏi thẳng xin đề/tài liệu
  // ôn tập (nhánh examOnly bên dưới, đã có isExamOnlyRequest() nhận diện ý định rõ ràng).
  if (query) lastQueryForRecommend = query;

  // Nếu người dùng CHỈ đang xin đề/bài tập ôn tập (không kèm 1 bài toán cụ thể cần giải), theo yêu
  // cầu: KHÔNG cần AI giải gì cả — chỉ cần khung "Đề xuất ôn tập" ở trên hiện ra là đủ.
  const examOnly = !!query && !image && isExamOnlyRequest(query);
  // Nếu người dùng đang xin SOẠN ĐỀ CƯƠNG (tóm tắt/hệ thống hóa kiến thức) — theo yêu cầu rework:
  // KHÔNG chia thành 2 giai đoạn "Hướng giải" -> (bấm) -> "Lời giải chi tiết" như 1 bài toán thông
  // thường. Toàn bộ được xử lý trong 1 LƯỢT GỌI AI DUY NHẤT (handleOutlineOnlyTurn), trả về ĐÚNG 1
  // câu trả lời (đề cương hiển thị ngay trong khung chat) KÈM file .docx tải được ngay bên dưới —
  // không có bước "Xem cách giải chi tiết" nào ở giữa.
  const outlineOnly = !examOnly && !!query && !image && isOutlineRequest(query);
  // Tương tự đề cương: nếu người dùng đang chủ động xin VẼ MINDMAP/SƠ ĐỒ TÓM TẮT (không phải giải 1
  // bài toán cụ thể) — xử lý trong 1 lượt duy nhất (handleMindmapOnlyTurn), hiển thị sơ đồ trực quan
  // ngay trong khung chat, không qua 2 giai đoạn Hướng giải/Lời giải chi tiết.
  const mindmapOnly = !examOnly && !outlineOnly && !!query && !image && isMindmapRequest(query);

  el('sendBtn').disabled = true;
  statusEl.textContent = image ? t('chat.statusReadingProblem') : (examOnly ? t('chat.statusFindingDocs') : (outlineOnly ? t('chat.statusOutline') : (mindmapOnly ? t('chat.statusMindmap') : t('chat.statusApproach'))));

  finalizePendingTurnIfAny();

  addUserMsg(query, image ? image.previewUrl : null);
  state.pendingImage = null; renderImagePreview();

  const conv = currentConversation();
  // FIX ROOT CAUSE #1: lưu imageId (tham chiếu tới IndexedDB) thay vì chỉ hadImage:true — đây là
  // dữ liệu duy nhất còn giữ lại được sau F5 để khôi phục đúng ảnh gốc (xem loadConversation()).
  const userMsgObj = { role: 'user', text: query, hadImage: !!image, imageId: image ? image.imageId : null };
  conv.messages.push(userMsgObj);
  if (conv.messages.filter((m) => m.role === 'user').length === 1) conv.title = autoTitleFromQuery(query || '[Ảnh đề bài]');

  if (examOnly) {
    // FIX PHẦN 9: đây LÀ trường hợp "explicit recommendation intent" (isExamOnlyRequest() đã nhận
    // diện người dùng đang xin đề/tài liệu ôn tập, không phải giải 1 bài cụ thể) — gọi thẳng, không
    // cần đợi người dùng bấm thêm nút nào khác.
    if (query) { scheduleRecommend(query); recommendFetchedForQuery = query; }
    const aiMsgObj = { id: uid(), role: 'ai', query, approach: '', detail: null, contexts: [], crossChecked: false };
    const aiRow = addAiMsg('Trợ Giải');
    const contentEl = aiRow.querySelector('.content');
    const note = 'Mình đã tìm các đề/bài tập ôn tập liên quan ở khung <strong>📚 Đề xuất ôn tập</strong> bên phải màn hình — bạn xem thử nhé! Nếu muốn giải cụ thể 1 bài, cứ dán hẳn đề bài vào đây.';
    aiMsgObj.approach = note;
    contentEl.innerHTML = `<p>${note}</p>`;
    conv.messages.push(aiMsgObj);
    touchConversation(conv);
    el('sendBtn').disabled = false;
    statusEl.textContent = t('chat.statusReady');
    scrollThreadToBottom();
    return;
  }

  if (outlineOnly) {
    await handleOutlineOnlyTurn(query, conv);
    return;
  }

  if (mindmapOnly) {
    await handleMindmapOnlyTurn(query, conv);
    return;
  }

  // PHẦN II.B/IV (kiến trúc mới): KHÔNG còn await toàn bộ vòng đời nguồn trước khi dựng request —
  // đó là root cause khiến 1 câu hỏi đơn giản phải chờ CẢ PDF scan 134 trang đọc xong. retrieveContext()
  // bên dưới tự lấy evidence THẬT đang có qua collectAvailableEvidence() (PHẦN VIII), dùng được ngay
  // cả khi nguồn còn đang enrich nền. waitForAllSourceProcessing() vẫn tồn tại cho nơi THỰC SỰ cần
  // full coverage (vd export toàn bộ tài liệu) — không dùng làm hàng rào mặc định cho mọi câu hỏi nữa.
  const contexts = retrieveContext(query);
  // imageId gắn thêm vào chính aiMsgObj (không chỉ userMsgObj) — để fetchDetail()/renderStoredAiMessage()
  // sau F5 tra được ảnh cần khôi phục ngay từ message AI mà không phải dò ngược message user liền trước.
  const aiMsgObj = {
    id: uid(), role: 'ai', query, approach: '', detail: null, contexts, crossChecked: false, imageId: image ? image.imageId : null,
    // PHẦN F/PHẦN N BỔ SUNG: lưu lại NGAY tại thời điểm retrieveContext() chạy — lượt "Giải chi
    // tiết" (stage=detail) tái dùng đúng `msgObj.contexts` đã lưu này (không gọi lại
    // retrieveContext()), nên phải giữ requirementLabels cùng lúc, không tính lại/đoán lại.
    requirementLabels: contexts.requirementLabels || [],
    matchedRequirementLabels: contexts.matchedRequirementLabels || [],
    unmatchedRequirementLabels: contexts.unmatchedRequirementLabels || []
  };
  const aiRow = addAiMsg('Hướng giải');
  aiRow.dataset.msgId = aiMsgObj.id;
  const contentEl = aiRow.querySelector('.content');
  conv.messages.push(aiMsgObj);
  touchConversation(conv);

  contentEl.innerHTML = '';
  const preview = startStreamingPreview(contentEl);

  // PHẦN E/F/G: đăng ký task theo conversationId (không phải biến toàn cục) — cho phép sang Chat B
  // gửi tiếp trong lúc Chat A vẫn đang stream (bị chặn hoàn toàn ở kiến trúc cũ vì disable sendBtn
  // toàn cục). PHẦN AJ/AK: chốt ngôn ngữ của request NGAY tại đây — settingsSnapshot là 1 bản SAO
  // (không phải tham chiếu) nên nếu người dùng đổi Settings > Language giữa chừng, request ĐANG
  // CHẠY này vẫn tiếp tục đúng ngôn ngữ cũ tới khi xong (không rebuild theo state.settings sống).
  const settingsSnapshot = { ...state.settings };
  const langLock = {
    requestLanguage: settingsSnapshot.lang,
    uiLanguageAtStart: window.languageStore ? window.languageStore.getUILanguage() : null,
    answerLanguage: settingsSnapshot.lang,
    explanationLanguage: settingsSnapshot.lang
  };
  const ctm = window.conversationTaskManager;
  const taskHandle = ctm ? ctm.beginTask(conv.id, { langLock }) : null;
  const taskSignal = taskHandle ? taskHandle.signal : undefined;
  if (taskHandle) await taskHandle.whenReady; // PHẦN F: nếu vượt concurrency limit, chờ tới lượt (queue) trước khi thực sự gọi AI
  setChatStreaming(true, conv.id);
  try {
    const data = await streamViaProviderRouter('/api/chat', {
      query, deepThinking: state.deepThinking, crossCheck: state.crossCheck, stage: 'approach',
      image: image ? { mediaType: image.mediaType, base64: image.base64 } : null,
      sourceImages: collectSourceImages(query),
      rules: state.rules, contexts, settings: settingsSnapshot,
      // PHẦN K/L: chỉ gửi history THỰC SỰ liên quan (query độc lập -> gần như 0 lượt), và báo số
      // lượt gốc để server log được historyTurnsRaw vs historyTurnsSent (PHẦN S).
      history: selectRelevantHistory(query, state.history),
      historyTurnsRaw: state.history.length,
      sourceManifest: buildSourceManifest(),
      sourceStatus: buildSourceStatusPayload(),
      // PHẦN F BỔ SUNG: nhãn nào KHÔNG có evidence thật — model bị cấm bịa nội dung thay thế cho
      // đúng những nhãn này (xem buildRequirementIntegrityBlock() ở promptBuilder.js).
      requirementLabels: aiMsgObj.requirementLabels,
      unmatchedRequirementLabels: aiMsgObj.unmatchedRequirementLabels
    }, {
      onDelta: (piece) => { if (taskHandle) ctm.appendDelta(taskHandle.task.requestId, piece); preview.append(piece); scrollThreadToBottom(); },
      onStatus: (msg, st) => { if (taskHandle) ctm.setStatus(taskHandle.task.requestId, msg, st); preview.setStatus(msg, st); },
      signal: taskSignal
    });
    if (taskHandle) ctm.completeTask(taskHandle.task.requestId, data);
    const rawFull = data.text || preview.getText() || t('chat.noResponse');
    // Tách dòng "🌐 ..." (nếu AI có dùng web bổ sung — hiện giai đoạn Hướng giải chưa được cấp công
    // cụ web nên hiếm khi xảy ra, nhưng vẫn xử lý nhất quán với giai đoạn Giải chi tiết) ra khỏi nội
    // dung chính, lưu riêng để hiển thị TÁCH BIỆT khỏi nguồn tài liệu trong khối "Nguồn tham khảo".
    const { clean: raw, webNote: approachWebNote } = extractWebSourceNote(rawFull);
    aiMsgObj.approach = raw;
    aiMsgObj.approachWebNote = approachWebNote;
    aiMsgObj.approachProvider = data.provider || null;
    // Vấn đề #1: lưu citationMap để lần render lại từ lịch sử cũng resolve [n] đúng đoạn (nếu không,
    // mở lại hội thoại cũ sẽ quay về suy ra theo vị trí mảng và hiển thị sai đoạn).
    aiMsgObj.approachCitationMap = Array.isArray(data.citationMap) ? data.citationMap : null;
    // Mục 14.16: lưu subjectId vào metadata tin nhắn (dùng để lọc History theo môn); mục 14.4: hiển
    // thị badge ngay trên nhãn tin nhắn AI vừa nhận được kết quả.
    aiMsgObj.subjectId = data.subjectId || 'general';
    aiMsgObj.subjectConfidence = Number.isFinite(data.subjectConfidence) ? data.subjectConfidence : 0;
    aiMsgObj.secondarySubjectId = data.secondarySubjectId || null;
    aiMsgObj.approachVisuals = Array.isArray(data.visuals) ? data.visuals : [];
    aiMsgObj.approachVisualStatus = data.visualStatus || null;
    setMsgSubjectBadge(aiRow, aiMsgObj.subjectId, aiMsgObj.subjectConfidence, aiMsgObj.secondarySubjectId);
    touchConversation(conv);

    contentEl.innerHTML = '';
    const approachWrap = document.createElement('div');
    approachWrap.className = 'stage-block stage-approach';
    contentEl.appendChild(approachWrap);
    renderAnswerBlock(approachWrap, raw);
    renderVisuals(approachWrap, aiMsgObj.approachVisuals, aiMsgObj.approachVisualStatus);
    renderPartialWarning(approachWrap, data);
    renderCitations(approachWrap, contexts, query, raw, approachWebNote, data.citationMap);
    // Luôn hiển thị đủ các nút chức năng (Ghi chú/Flashcard/Mindmap) ngay từ giai đoạn
    // Hướng giải — xem giải thích đầy đủ ở đầu buildStudyActions().
    contentEl.appendChild(buildStudyActions(aiMsgObj, raw, aiRow, 'approach-note-block'));

    const btnWrap = document.createElement('div');
    btnWrap.className = 'detail-btn-wrap';
    btnWrap.innerHTML = `<button class="detail-btn">${ICONS.compass}<span>${escapeHtml(t('chat.detailBtn'))}</span></button>`;
    contentEl.appendChild(btnWrap);
    const detailBtn = btnWrap.querySelector('.detail-btn');

    pendingTurn = { query, image, approachRaw: raw, msgObj: aiMsgObj };
    detailBtn.onclick = () => fetchDetail(detailBtn, aiRow, contentEl, aiMsgObj, image);
  } catch (e) {
    if (taskHandle) ctm.failTask(taskHandle.task.requestId, e);
    // mục 4: người dùng chủ động bấm "Dừng" — không phải lỗi, hiển thị nhẹ nhàng, không tô đỏ.
    if (isCancelledError(e)) {
      contentEl.innerHTML = `<p style="color:var(--muted);font-style:italic;">${escapeHtml(t('chat.stopped'))}</p>`;
      console.info('Chat request cancelled by user.');
    } else {
      const msg = (e && e.message) || t('error.connectServer');
      // escape HTML thô sơ rồi mới chèn — thông báo lỗi có thể chứa nội dung từ phản hồi API bên
      // ngoài (OpenAI/Gemini/...), không nên tin tưởng tuyệt đối khi ghép vào innerHTML.
      const escaped = msg.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
      contentEl.innerHTML = `<p style="color:#c0392b;white-space:pre-wrap;">⚠️ ${escaped}</p>`;
      console.error(e);
    }
  } finally {
    // PHẦN H: nếu người dùng đã chuyển sang conversation khác trong lúc chờ, KHÔNG đụng nút Gửi/Dừng
    // hiện tại (setChatStreaming tự kiểm tra conv.id !== conversation đang mở) — chỉ đồng bộ lại nút
    // khi conversation VỪA XONG task cũng chính là conversation đang được xem.
    setChatStreaming(false, conv.id);
    if (currentConversation() && currentConversation().id === conv.id) {
      el('sendBtn').disabled = false;
      statusEl.textContent = t('chat.statusReady');
      scrollThreadToBottom();
    } else {
      renderHistoryList(); // PHẦN H: cập nhật badge "đang chạy nền"/thời gian cập nhật cho conv vừa xong ở nền
    }
  }
}

// Wrapper dùng riêng cho message đã lưu (mở lại sau F5): msg.image chưa có sẵn trong RAM, phải
// khôi phục từ IndexedDB trước. Nếu msg không có imageId (không có ảnh hoặc dữ liệu cũ/legacy),
// restoreMessageImage() trả về null và fetchDetail() chạy như bình thường (không ảnh).
async function handleDetailClickWithRestore(btn, aiRow, contentEl, msg) {
  if (!msg.imageId) { fetchDetail(btn, aiRow, contentEl, msg, null); return; }
  btn.disabled = true;
  const originalHtml = btn.innerHTML;
  btn.innerHTML = `<span class="typing"><span></span><span></span><span></span></span><span>${escapeHtml(t('chat.restoringImage'))}</span>`;
  const restoredImage = await restoreMessageImage(msg.imageId);
  if (!restoredImage) {
    // Ảnh không còn trong IndexedDB (đã bị xoá/dọn dẹp) — báo rõ, KHÔNG crash, vẫn cho giải tiếp
    // chỉ bằng text đã có (approach/query) như hành vi trước đây, tránh chặn đứng người dùng.
    btn.innerHTML = originalHtml;
    btn.disabled = false;
    alert(t('error.imageGone'));
    fetchDetail(btn, aiRow, contentEl, msg, null);
    return;
  }
  btn.innerHTML = originalHtml;
  fetchDetail(btn, aiRow, contentEl, msg, restoredImage);
}

async function fetchDetail(btn, aiRow, contentEl, msgObj, image) {
  btn.disabled = true;
  // FIX PHẦN G (response isolation): trước đây `conv` được lấy bằng currentConversation() SAU khi
  // await xong — nếu người dùng đã chuyển sang conversation khác trong lúc chờ, touchConversation()
  // sẽ vô tình đánh dấu NHẦM conversation đang xem là "vừa cập nhật" thay vì conversation THỰC SỰ sở
  // hữu msgObj này. Chốt đúng chủ sở hữu NGAY TỪ ĐẦU, dùng lại ownerConv xuyên suốt hàm.
  const ownerConv = currentConversation();
  const { deepThinking, crossCheck } = state;
  // Nhãn/trạng thái ở bước này theo cờ "Đối chiếu đa hướng" — đây là cờ thực sự quyết định server
  // có chạy nhiều lượt giải song song + tổng hợp hay không (xem chat.js); "Suy nghĩ sâu" chỉ ảnh
  // hưởng nội dung suy luận NỘI BỘ của từng lượt gọi, không đổi số lượt gọi hay luồng UI ở đây.
  btn.innerHTML = `<span class="typing"><span></span><span></span><span></span></span><span>${crossCheck ? t('chat.crossChecking') : t('chat.solvingDetail')}</span>`;
  statusEl.textContent = crossCheck ? t('chat.statusCrossCheck') : t('chat.statusDetail');

  const preview = startStreamingPreview(contentEl);
  if (crossCheck) preview.setStatus(t('chat.crossChecking'));

  // PHẦN AJ/AK: chốt ngôn ngữ NGAY từ đầu (bản sao settings, không phải tham chiếu sống) + đăng ký
  // task theo conversationId thực sự sở hữu msgObj (ownerConv), không phải conversation đang mở.
  const settingsSnapshot = { ...state.settings };
  const langLock = {
    requestLanguage: settingsSnapshot.lang, uiLanguageAtStart: window.languageStore ? window.languageStore.getUILanguage() : null,
    answerLanguage: settingsSnapshot.lang, explanationLanguage: settingsSnapshot.lang
  };
  const ctm = window.conversationTaskManager;
  const taskHandle = (ctm && ownerConv) ? ctm.beginTask(ownerConv.id, { langLock }) : null;
  if (taskHandle) await taskHandle.whenReady;
  if (ownerConv) setChatStreaming(true, ownerConv.id);
  try {
    const data = await streamViaProviderRouter('/api/chat', {
      query: msgObj.query, deepThinking, crossCheck, stage: 'detail', approachText: msgObj.approach,
      image: image ? { mediaType: image.mediaType, base64: image.base64 } : null,
      sourceImages: collectSourceImages(msgObj.query),
      rules: state.rules, contexts: msgObj.contexts, settings: settingsSnapshot,
      history: selectRelevantHistory(msgObj.query, state.history),
      historyTurnsRaw: state.history.length,
      sourceManifest: buildSourceManifest(),
      sourceStatus: buildSourceStatusPayload(),
      requirementLabels: msgObj.requirementLabels || [],
      unmatchedRequirementLabels: msgObj.unmatchedRequirementLabels || []
    }, {
      onDelta: (piece) => { if (taskHandle) ctm.appendDelta(taskHandle.task.requestId, piece); preview.append(piece); scrollThreadToBottom(); },
      onStatus: (msg, st) => { if (taskHandle) ctm.setStatus(taskHandle.task.requestId, msg, st); preview.setStatus(msg, st); },
      signal: taskHandle ? taskHandle.signal : undefined
    });
    if (taskHandle) ctm.completeTask(taskHandle.task.requestId, data);
    const rawFull = data.text || preview.getText() || t('chat.noResponse');
    // Tách dòng "🌐 ..." (đánh dấu có dùng web bổ sung — chỉ có thể xảy ra ở chế độ "Đối chiếu đa
    // hướng", nơi lượt tổng hợp được cấp công cụ web search) ra khỏi nội dung chính, lưu riêng
    // (msgObj.detailWebNote) để hiển thị TÁCH BIỆT khỏi nguồn tài liệu — xem renderCitations().
    const { clean: raw, webNote: detailWebNote } = extractWebSourceNote(rawFull);
    msgObj.detail = raw;
    msgObj.detailWebNote = detailWebNote;
    msgObj.crossChecked = !!data.crossChecked;
    msgObj.providers = Array.isArray(data.providers) ? data.providers : null;
    msgObj.reconciledBy = data.reconciledBy || null;
    msgObj.provider = data.provider || null;
    msgObj.detailCitationMap = Array.isArray(data.citationMap) ? data.citationMap : null;
    msgObj.detailPartial = !!data.partial;
    // PHẦN 20/32: hình chỉ là phần BỔ SUNG — không có/không tạo được thì lời giải vẫn đầy đủ.
    msgObj.detailVisuals = Array.isArray(data.visuals) ? data.visuals : [];
    msgObj.detailVisualStatus = data.visualStatus || null;
    msgObj.detailIncompleteReasons = Array.isArray(data.incompleteReasons) ? data.incompleteReasons : [];
    // Cập nhật lại subject sau bước "giải chi tiết" (có thể chính xác hơn approach, đặc biệt khi
    // approach chỉ có ảnh chưa detect được — xem resolveSubject() phía server).
    msgObj.subjectId = data.subjectId || msgObj.subjectId || 'general';
    msgObj.subjectConfidence = Number.isFinite(data.subjectConfidence) ? data.subjectConfidence : (msgObj.subjectConfidence || 0);
    msgObj.secondarySubjectId = data.secondarySubjectId || msgObj.secondarySubjectId || null;
    setMsgSubjectBadge(aiRow, msgObj.subjectId, msgObj.subjectConfidence, msgObj.secondarySubjectId);

    preview.wrap.remove();
    btn.closest('.detail-btn-wrap').remove();
    // Gỡ khối "Ghi chú" tạm ở giai đoạn Hướng giải — từ giờ đã có khối ghi chú đầy đủ (kèm
    // Flashcard/Mindmap) ngay dưới Lời giải chi tiết, dùng chung đúng msgObj nên không mất ghi chú đã lưu.
    const approachNoteBlock = contentEl.querySelector('.approach-note-block');
    if (approachNoteBlock) approachNoteBlock.remove();
    appendDetailSection(contentEl, msgObj, aiRow);
    renderPartialWarning(contentEl, data);

    state.history.push({ role: 'user', content: msgObj.query || '[Người dùng đã gửi ảnh đề bài để giải]' });
    state.history.push({ role: 'assistant', content: raw });
    trimHistoryMemory();
    if (pendingTurn && pendingTurn.msgObj === msgObj) pendingTurn = null;

    // FIX PHẦN G: dùng ownerConv (chốt từ đầu hàm) thay vì currentConversation() đọc lại sau await.
    if (ownerConv) touchConversation(ownerConv);
  } catch (e) {
    if (taskHandle) ctm.failTask(taskHandle.task.requestId, e);
    preview.wrap.remove();
    btn.disabled = false;
    // mục 4: người dùng chủ động bấm "Dừng" — không phải lỗi thật, tránh alert() gây khó chịu.
    if (isCancelledError(e)) {
      btn.innerHTML = `${ICONS.compass}<span>${escapeHtml(t('chat.detailBtn'))}</span>`;
      console.info('Chat request cancelled by user.');
    } else {
      btn.innerHTML = `${ICONS.compass}<span>${escapeHtml(t('chat.detailBtnRetry'))}</span>`;
      alert((e && e.message) || t('error.detailFailed'));
      console.error(e);
    }
  } finally {
    if (ownerConv) setChatStreaming(false, ownerConv.id);
    if (!currentConversation() || (ownerConv && currentConversation().id !== ownerConv.id)) renderHistoryList();
    statusEl.textContent = t('chat.statusReady');
    scrollThreadToBottom();
  }
}

/* ================= Đề cương trực tiếp: 1 lượt duy nhất (không tách Hướng giải/Lời giải chi tiết) =================
 * Kích hoạt khi isOutlineRequest(query) nhận diện người dùng đang xin SOẠN ĐỀ CƯƠNG chứ không phải
 * giải 1 bài toán cụ thể. Khác hẳn luồng sendMessage() bình thường (2 giai đoạn, cần bấm "Xem cách
 * giải chi tiết"), ở đây chỉ có ĐÚNG 1 lệnh gọi tới POST /api/generate/outline: kết quả JSON nhận về
 * được dùng để (1) hiển thị NGAY 1 câu trả lời duy nhất trong khung chat và (2) dựng sẵn file .docx
 * kèm theo ngay bên dưới câu trả lời đó — người dùng bấm 1 nút là file được gửi vào khung chat, không
 * cần mở modal riêng hay quay lại giải bài trước. Vẫn tái sử dụng buildOutlineDocxBlob() đã có sẵn để
 * đảm bảo file .docx tạo ra giống hệt cấu trúc/định dạng như đường tạo đề cương thủ công (từ 1 câu
 * trả lời đã giải).
 */
async function handleOutlineOnlyTurn(query, conv) {
  // PHẦN II.B/IV (kiến trúc mới): KHÔNG còn await toàn bộ vòng đời nguồn trước khi dựng request —
  // đó là root cause khiến 1 câu hỏi đơn giản phải chờ CẢ PDF scan 134 trang đọc xong. retrieveContext()
  // bên dưới tự lấy evidence THẬT đang có qua collectAvailableEvidence() (PHẦN VIII), dùng được ngay
  // cả khi nguồn còn đang enrich nền. waitForAllSourceProcessing() vẫn tồn tại cho nơi THỰC SỰ cần
  // full coverage (vd export toàn bộ tài liệu) — không dùng làm hàng rào mặc định cho mọi câu hỏi nữa.
  const contexts = retrieveContext(query);
  const aiMsgObj = { id: uid(), role: 'ai', query, approach: '', detail: null, contexts: [], crossChecked: false, outlineSpec: null };
  const aiRow = addAiMsg('Đề cương');
  aiRow.dataset.msgId = aiMsgObj.id;
  const contentEl = aiRow.querySelector('.content');
  conv.messages.push(aiMsgObj);
  touchConversation(conv);

  try {
    const includeExercises = /bài tập|luyện tập|kèm.*(bài|câu)/.test(query.toLowerCase());
    const sourceContent = contexts.length
      ? query + '\n\nNguồn tài liệu liên quan đã nạp:\n' + contexts.map((c, i) => `[${i + 1}] (${c.doc}) ${c.text}`).join('\n')
      : query;
    const spec = await apiPost('/api/generate/outline', { content: sourceContent, includeExercises, sourceImages: collectSourceImages(query) });

    aiMsgObj.outlineSpec = spec;
    aiMsgObj.approach = outlineSpecToPlainText(spec); // dùng làm ngữ cảnh (state.history) cho câu hỏi tiếp theo

    contentEl.innerHTML = '';
    renderOutlineAnswer(contentEl, spec, aiMsgObj, aiRow);
    touchConversation(conv);

    state.history.push({ role: 'user', content: query });
    state.history.push({ role: 'assistant', content: aiMsgObj.approach });
    trimHistoryMemory();
  } catch (e) {
    const msg = (e && e.message) || 'Không soạn được đề cương, vui lòng thử lại.';
    contentEl.innerHTML = `
      <div class="gen-error-card">
        <p class="gen-error-text">⚠️ ${escapeHtml(msg)}</p>
        <button class="gen-error-retry" type="button">${ICONS.refresh}<span>${escapeHtml(t('chat.retry'))}</span></button>
      </div>`;
    contentEl.querySelector('.gen-error-retry').onclick = () => {
      aiRow.remove();
      const idx = conv.messages.indexOf(aiMsgObj);
      if (idx !== -1) conv.messages.splice(idx, 1);
      handleOutlineOnlyTurn(query, conv);
    };
    console.error(e);
  } finally {
    el('sendBtn').disabled = false;
    statusEl.textContent = t('chat.statusReady');
    scrollThreadToBottom();
  }
}

// Chuyển spec đề cương (JSON) thành văn bản thuần — dùng làm state.history (ngữ cảnh hội thoại cho
// AI ở lượt hỏi tiếp theo) và khi cần copy nhanh, KHÔNG dùng để hiển thị (xem renderOutlineAnswer).
function outlineSpecToPlainText(spec) {
  if (!spec) return '';
  const lines = [];
  if (spec.title) lines.push(spec.title);
  if (spec.overview) lines.push(spec.overview);
  (spec.sections || []).forEach((sec) => {
    lines.push('## ' + (sec.heading || ''));
    (sec.definitions || []).forEach((d) => lines.push(`- ${d.term}: ${d.definition}`));
    (sec.formulas || []).forEach((f) => lines.push(`- ${f.name}: ${f.expression}${f.note ? ' (' + f.note + ')' : ''}`));
    (sec.keypoints || []).forEach((k) => lines.push(`- ${k}`));
  });
  return lines.join('\n');
}

// Hiển thị 1 spec đề cương (đến từ /api/generate/outline) thành 1 khối câu trả lời hoàn chỉnh trong
// khung chat + nút tải file .docx đi kèm ngay bên dưới. Dùng chung cho cả lượt tạo mới
// (handleOutlineOnlyTurn) LẪN khi mở lại cuộc trò chuyện cũ (renderStoredAiMessage) nên KHÔNG gọi lại
// API — spec đã có sẵn trong msgObj.outlineSpec, chỉ dựng lại giao diện + file từ đúng dữ liệu đó.
function renderOutlineAnswer(contentEl, spec, msgObj, aiRow) {
  const esc = escapeHtml;
  const wrap = document.createElement('div');
  wrap.className = 'stage-block outline-answer';

  let html = `<h3 class="outline-title">${esc(spec.title || 'Đề cương')}</h3>`;
  if (spec.overview) html += `<p class="outline-overview">${esc(spec.overview)}</p>`;

  (spec.sections || []).forEach((sec) => {
    html += `<div class="outline-section"><h4>${esc(sec.heading || '')}</h4>`;
    if ((sec.definitions || []).length) {
      html += '<ul class="outline-defs">' +
        sec.definitions.map((d) => `<li><b>${esc(d.term)}:</b> ${esc(d.definition)}</li>`).join('') + '</ul>';
    }
    if ((sec.formulas || []).length) {
      html += '<div class="outline-formulas">' + sec.formulas.map((f) => `
        <div class="outline-formula">
          <div class="outline-formula-name">${esc(f.name)}</div>
          <div class="outline-formula-expr">$$${f.expression}$$</div>
          ${f.note ? `<div class="outline-formula-note">${esc(f.note)}</div>` : ''}
        </div>`).join('') + '</div>';
    }
    if ((sec.keypoints || []).length) {
      html += '<ul class="outline-keypoints">' + sec.keypoints.map((k) => `<li>${esc(k)}</li>`).join('') + '</ul>';
    }
    html += '</div>';
  });

  if (Array.isArray(spec.exercises) && spec.exercises.length) {
    html += '<div class="outline-exercises"><h4>Bài tập ôn tập theo mức độ</h4>';
    spec.exercises.forEach((lvl) => {
      html += `<div class="outline-exlevel"><div class="outline-exlevel-title">${esc(lvl.level || '')}</div><ol>` +
        (lvl.items || []).map((it) => `<li>${esc(it.question)}<div class="outline-exhint">Đáp án: ${esc(it.answer)}</div></li>`).join('') +
        '</ol></div>';
    });
    html += '</div>';
  }

  if (spec.sourceNote) html += `<div class="outline-source-note">📎 ${esc(spec.sourceNote)}</div>`;

  wrap.innerHTML = html;
  contentEl.appendChild(wrap);
  renderMath(wrap);

  const fileWrap = document.createElement('div');
  fileWrap.className = 'outline-file-wrap';
  fileWrap.innerHTML = `<button class="outline-download-btn" type="button">${ICONS.outline}<span>Xuất file .docx đề cương này</span></button><span class="outline-file-hint">File sẽ được gửi vào khung chat, bấm "Tải xuống" trên tin nhắn để lưu về máy.</span>`;
  const dlBtn = fileWrap.querySelector('.outline-download-btn');
  const buildAndSend = async () => {
    const original = dlBtn.innerHTML;
    dlBtn.disabled = true;
    dlBtn.innerHTML = '<span>Đang tạo file…</span>';
    try {
      const { blob, fileName } = await buildOutlineDocxBlob(spec);
      appendFileMessage('docx', fileName, blob, buildOutlineSummaryHtml(spec));
    } catch (e) {
      console.error(e);
      appendGenErrorMessage('Đề cương .docx', (e && e.message) || 'Không tạo được file .docx, vui lòng thử lại.', buildAndSend);
    } finally {
      dlBtn.disabled = false;
      dlBtn.innerHTML = original;
    }
  };
  dlBtn.onclick = buildAndSend;
  contentEl.appendChild(fileWrap);
  contentEl.appendChild(buildNoteBlock(msgObj));
}

/* ================= Đề cương: dựng file .docx thật bằng docx.js (thư viện tải qua CDN) =================
 * spec đến từ POST /api/generate/outline (xem server/utils/promptBuilder.js#buildOutlineSystemPrompt
 * để biết đúng schema). Công thức toán ở "expression" là LaTeX thuần (không có $) — docx.js không tự
 * render LaTeX thành ký hiệu toán học native của Word, nên hiển thị dưới dạng văn bản in nghiêng,
 * font Cambria Math, kèm khối nền nhạt để dễ phân biệt với văn bản thường — vẫn đọc được rõ ràng,
 * đúng nội dung công thức, chỉ không phải khối phương trình OMML có thể bấm sửa như gõ tay trong Word.
 */
// Dựng file .docx thật ở client bằng docx.js, trả về {blob, fileName} thay vì tự tải xuống ngay
// (hành vi cũ) — mọi nơi gọi hàm này giờ gói kết quả thành 1 tin nhắn trong khung chat qua
// appendFileMessage(), xem chi tiết lý do ở comment của appendFileMessage().
async function buildOutlineDocxBlob(spec) {
  try { await ensureDocx(); } catch (e) { /* rơi xuống check window.docx bên dưới để báo lỗi đúng nội dung */ }
  if (!window.docx) throw new Error('Không tải được thư viện tạo file .docx (docx.js) — kiểm tra kết nối mạng hoặc trình chặn quảng cáo rồi thử lại.');
  const {
    Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle
  } = docx;
  const PRIMARY = '2955FF', MUTED = '6B7593', INK = '0E1524';

  const children = [];

  children.push(new Paragraph({
    text: spec.title || 'Đề cương',
    heading: HeadingLevel.TITLE,
    alignment: AlignmentType.CENTER,
    spacing: { after: 120 }
  }));
  if (spec.overview) {
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 320 },
      children: [new TextRun({ text: spec.overview, italics: true, color: MUTED, size: 21 })]
    }));
  }

  (spec.sections || []).forEach((sec) => {
    children.push(new Paragraph({
      text: sec.heading || '',
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 260, after: 120 },
      border: { bottom: { color: PRIMARY, space: 4, style: BorderStyle.SINGLE, size: 6 } }
    }));

    if ((sec.definitions || []).length) {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 120, after: 80 },
        children: [new TextRun({ text: 'Định nghĩa', color: PRIMARY })]
      }));
      sec.definitions.forEach((d) => {
        children.push(new Paragraph({
          bullet: { level: 0 },
          spacing: { after: 60 },
          children: [
            new TextRun({ text: (d.term || '') + ': ', bold: true }),
            new TextRun({ text: d.definition || '' })
          ]
        }));
      });
    }

    if ((sec.formulas || []).length) {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 140, after: 80 },
        children: [new TextRun({ text: 'Công thức quan trọng', color: PRIMARY })]
      }));
      sec.formulas.forEach((f) => {
        if (f.name) {
          children.push(new Paragraph({
            spacing: { before: 60, after: 20 },
            children: [new TextRun({ text: f.name, bold: true, size: 21, color: INK })]
          }));
        }
        children.push(new Paragraph({
          spacing: { after: f.note ? 20 : 80 },
          indent: { left: 260 },
          shading: { fill: 'F3F5F9' },
          children: [new TextRun({ text: f.expression || '', italics: true, font: 'Cambria Math', size: 24 })]
        }));
        if (f.note) {
          children.push(new Paragraph({
            spacing: { after: 80 },
            indent: { left: 260 },
            children: [new TextRun({ text: f.note, color: MUTED, size: 19 })]
          }));
        }
      });
    }

    if ((sec.keypoints || []).length) {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 140, after: 80 },
        children: [new TextRun({ text: 'Lưu ý quan trọng', color: PRIMARY })]
      }));
      sec.keypoints.forEach((k) => {
        children.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 50 }, text: k }));
      });
    }
  });

  const exercises = spec.exercises || [];
  if (exercises.length) {
    children.push(new Paragraph({
      text: 'Bài tập luyện tập',
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 320, after: 120 },
      border: { bottom: { color: PRIMARY, space: 4, style: BorderStyle.SINGLE, size: 6 } }
    }));
    exercises.forEach((lvl) => {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 140, after: 80 },
        children: [new TextRun({ text: lvl.level || '', color: PRIMARY })]
      }));
      (lvl.items || []).forEach((it, i) => {
        children.push(new Paragraph({
          spacing: { after: 60 },
          children: [new TextRun({ text: `${i + 1}. ${it.question || ''}` })]
        }));
      });
    });

    // Đáp số/gợi ý gom riêng thành phụ lục cuối tài liệu, để phần bài tập ở trên gọn gàng như một đề
    // ôn tập thật (không lộ đáp án ngay dưới mỗi câu).
    children.push(new Paragraph({
      text: 'Phụ lục: Đáp số / Gợi ý',
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 320, after: 120 },
      border: { bottom: { color: PRIMARY, space: 4, style: BorderStyle.SINGLE, size: 6 } }
    }));
    exercises.forEach((lvl) => {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 120, after: 70 },
        children: [new TextRun({ text: lvl.level || '', color: PRIMARY })]
      }));
      (lvl.items || []).forEach((it, i) => {
        children.push(new Paragraph({
          spacing: { after: 50 },
          children: [
            new TextRun({ text: `${i + 1}. `, bold: true }),
            new TextRun({ text: it.answer || '(không có)', color: INK })
          ]
        }));
      });
    });
  }

  if (spec.sourceNote) {
    children.push(new Paragraph({
      spacing: { before: 360 },
      border: { top: { color: 'E2E4EA', space: 8, style: BorderStyle.SINGLE, size: 4 } },
      children: [new TextRun({ text: 'Nguồn: ' + spec.sourceNote, italics: true, color: MUTED, size: 18 })]
    }));
  }

  const doc = new Document({
    sections: [{ properties: {}, children }],
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } }
  });

  const blob = await Packer.toBlob(doc);
  const fname = (spec.title || 'de-cuong').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60) || 'de-cuong';
  return { blob, fileName: fname + '.docx' };
}

// Flashcard giờ hiện ra ở KHUNG NỔI #flashcardPanel (popup bên trái màn hình) — dùng CHUNG cơ chế
// mở/đóng/nút-mở-lại với khung "Đề xuất ôn tập" (#recommendPanel), thay vì nhúng thẻ ngay dưới câu
// trả lời (aiRow) như trước. Mỗi lần bấm "Flashcard ôn tập", panel tự mở và vẽ đè lên bộ thẻ cũ (nếu
// có) bằng bộ thẻ vừa tạo — aiRow chỉ còn dùng để giữ nguyên chữ ký hàm gọi từ paintStudyActions().
async function handleFlashcards(btn, aiRow, answerText) {
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span>Đang tạo thẻ…</span>';
  try {
    const data = await apiPost('/api/generate/flashcards', { content: answerText });
    // Nếu đang có 1 bộ thẻ vừa tạo trước đó mà chưa được lưu (chưa đóng khung / chưa quay lại danh
    // sách) thì lưu nó lại trước khi thay bằng bộ mới — tránh mất bộ thẻ cũ khi tạo liên tiếp.
    commitActiveFlashcardSet();
    const topic = answerText.length > 70 ? answerText.slice(0, 70) + '…' : answerText;
    state.activeFlashcardSet = { id: uid(), topic, cards: data.cards || [], createdAt: Date.now(), saved: false };
    openFlashcardPanel();
    el('flashcardTopic').textContent = topic;
    renderFlashcards(el('flashcardBody'), state.activeFlashcardSet.cards, { showBack: true });
  } catch (e) {
    console.error(e);
    alert((e && e.message) || 'Không tạo được flashcard, vui lòng thử lại.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

function renderFlashcards(wrap, cards, { showBack = false } = {}) {
  if (!cards.length) { wrap.innerHTML = '<div class="rec-empty">Không tạo được thẻ ôn tập.</div>'; return; }
  let idx = 0, showingAnswer = false;
  wrap.innerHTML = `
    <div class="flash-wrap">
      <div class="flash-head">
        ${showBack ? '<button class="flash-back" title="Quay lại danh sách bộ thẻ đã lưu">‹ Danh sách</button>' : ''}
        <span>${cards.length} thẻ</span>
        <div class="flash-nav"><button data-nav="prev">‹</button><button data-nav="next">›</button></div>
      </div>
      <div class="flash-card"><span class="qlabel">Hỏi</span><div class="txt"></div></div>
      <div class="flash-progress"></div>
    </div>
  `;
  const card = wrap.querySelector('.flash-card');
  const txt = wrap.querySelector('.txt');
  const qlabel = wrap.querySelector('.qlabel');
  const progress = wrap.querySelector('.flash-progress');
  if (showBack) {
    // Quay lại danh sách = coi như đã "xong" với bộ thẻ đang xem -> lưu nó vào thư viện (nếu là
    // bộ vừa tạo, chưa lưu). Với bộ thẻ mở từ danh sách (đã lưu sẵn), commitActiveFlashcardSet()
    // không làm gì (an toàn gọi lại nhiều lần).
    wrap.querySelector('.flash-back').onclick = () => { commitActiveFlashcardSet(); renderFlashcardLibrary(); };
  }
  function render() {
    const c = cards[idx];
    txt.textContent = showingAnswer ? c.a : c.q;
    qlabel.textContent = showingAnswer ? 'Đáp án' : 'Hỏi';
    card.classList.toggle('showing-a', showingAnswer);
    progress.textContent = `Thẻ ${idx + 1}/${cards.length} · bấm vào thẻ để lật`;
    // LỖI GỐC: chỉ set textContent nên công thức LaTeX ($...$) hiển thị nguyên văn thay vì được
    // KaTeX render thành ký hiệu toán học (renderMath chưa từng được gọi ở đây). FIX: gọi renderMath
    // trên .txt sau mỗi lần đổi mặt thẻ/chuyển thẻ, giống cách renderMath() đã dùng cho khung chat.
    renderMath(txt);
  }
  card.onclick = () => { showingAnswer = !showingAnswer; render(); };
  wrap.querySelector('[data-nav="prev"]').onclick = () => { idx = (idx - 1 + cards.length) % cards.length; showingAnswer = false; render(); };
  wrap.querySelector('[data-nav="next"]').onclick = () => { idx = (idx + 1) % cards.length; showingAnswer = false; render(); };
  render();
}

// Chuyển bộ thẻ đang tạo (activeFlashcardSet, chưa lưu) vào thư viện flashcardSets + localStorage.
// An toàn gọi nhiều lần: không có gì để lưu, hoặc đã lưu rồi thì bỏ qua luôn (không tạo bản trùng).
function commitActiveFlashcardSet() {
  const active = state.activeFlashcardSet;
  if (!active || active.saved || !active.cards.length) return;
  state.flashcardSets.unshift({ id: active.id, topic: active.topic, cards: active.cards, createdAt: active.createdAt });
  if (state.flashcardSets.length > MAX_STORED_FLASHCARD_SETS) state.flashcardSets.length = MAX_STORED_FLASHCARD_SETS;
  lsSet(LS_KEYS.flashcardSets, state.flashcardSets);
  active.saved = true;
  state.flashcardLibraryPage = 0; // bộ vừa lưu chèn lên đầu danh sách -> quay về trang 1 để thấy ngay
}

function deleteFlashcardSet(id) {
  state.flashcardSets = state.flashcardSets.filter((s) => s.id !== id);
  lsSet(LS_KEYS.flashcardSets, state.flashcardSets);
  renderFlashcardLibrary();
}

// Khung "Flashcard ôn tập" mở qua nút biểu tượng trên topbar (không phải qua 1 câu trả lời cụ thể)
// -> hiện danh sách mọi bộ thẻ đã tạo trước đó (giống cách khung "Đề xuất ôn tập" liệt kê link),
// bấm vào 1 bộ để mở lại đúng bộ thẻ đó. Danh sách có thể dài (tối đa MAX_STORED_FLASHCARD_SETS
// bộ) nên chia trang FLASHCARD_SETS_PER_PAGE bộ/trang thay vì đổ hết ra 1 lần.
function renderFlashcardLibrary(resetPage) {
  if (resetPage) state.flashcardLibraryPage = 0;
  el('flashcardTopic').textContent = '';
  const wrap = el('flashcardBody');
  if (!state.flashcardSets.length) {
    state.flashcardLibraryPage = 0;
    wrap.innerHTML = '<div class="rec-empty">Chưa có bộ flashcard nào được lưu. Bấm "Flashcard ôn tập" dưới 1 câu trả lời để tạo bộ thẻ đầu tiên, bộ thẻ sẽ tự lưu vào đây khi bạn đóng khung này.</div>';
    return;
  }
  const totalPages = Math.max(1, Math.ceil(state.flashcardSets.length / FLASHCARD_SETS_PER_PAGE));
  // Kẹp lại trang hiện tại về khoảng hợp lệ — vd sau khi xóa hết bộ thẻ ở trang cuối cùng.
  state.flashcardLibraryPage = Math.min(Math.max(state.flashcardLibraryPage, 0), totalPages - 1);
  const page = state.flashcardLibraryPage;
  const start = page * FLASHCARD_SETS_PER_PAGE;
  const pageSets = state.flashcardSets.slice(start, start + FLASHCARD_SETS_PER_PAGE);

  const listHtml = pageSets.map((set) => `
    <div class="rec-card flash-set-card" data-id="${set.id}">
      <div class="rec-card-title"></div>
      <div class="rec-card-note"></div>
      <button class="note-del" title="Xóa bộ thẻ">${ICONS.trash}</button>
    </div>`).join('');
  const pagerHtml = totalPages > 1 ? `
    <div class="flash-pager">
      <button data-page="prev" ${page === 0 ? 'disabled' : ''} title="Trang trước">‹</button>
      <span>Trang ${page + 1}/${totalPages}</span>
      <button data-page="next" ${page === totalPages - 1 ? 'disabled' : ''} title="Trang sau">›</button>
    </div>` : '';
  wrap.innerHTML = listHtml + pagerHtml;

  wrap.querySelectorAll('.flash-set-card').forEach((cardEl) => {
    const set = state.flashcardSets.find((s) => s.id === cardEl.dataset.id);
    if (!set) return;
    cardEl.querySelector('.rec-card-title').textContent = set.topic || '(Không có tiêu đề)';
    cardEl.querySelector('.rec-card-note').textContent = `${set.cards.length} thẻ · ${timeAgo(set.createdAt)}`;
    cardEl.querySelector('.note-del').onclick = (e) => { e.stopPropagation(); deleteFlashcardSet(set.id); };
    cardEl.onclick = () => {
      el('flashcardTopic').textContent = set.topic;
      renderFlashcards(wrap, set.cards, { showBack: true });
    };
  });
  if (totalPages > 1) {
    wrap.querySelector('[data-page="prev"]').onclick = () => { state.flashcardLibraryPage--; renderFlashcardLibrary(); };
    wrap.querySelector('[data-page="next"]').onclick = () => { state.flashcardLibraryPage++; renderFlashcardLibrary(); };
  }
}

/* ================= Mindmap trực quan (sơ đồ tư duy) =================
 * Vẽ hoàn toàn bằng SVG thuần ở client (radial layout tự tính toán, không dùng thư viện ngoài) từ
 * spec JSON server trả về (xem server/utils/promptBuilder.js#buildMindmapSystemPrompt): chủ đề trung
 * tâm ở giữa, các nhánh chính toả tròn xung quanh theo màu riêng, nhánh con/cháu toả tiếp ra ngoài
 * theo đúng góc của nhánh cha (thuật toán "radial tidy tree" đơn giản: mỗi node được cấp 1 khoảng góc
 * tỉ lệ với số lá bên dưới nó). Có phóng to/thu nhỏ/kéo để xem + tải ảnh PNG, không cần thư viện
 * ngoài nào khác ngoài Canvas API sẵn có của trình duyệt.
 */
const MINDMAP_PALETTE = {
  blue: '#2955ff', green: '#16a34a', orange: '#ea580c', purple: '#9333ea', pink: '#db2777',
  teal: '#0d9488', red: '#dc2626', yellow: '#ca8a04', indigo: '#4f46e5', cyan: '#0891b2'
};
const MINDMAP_PALETTE_ORDER = Object.keys(MINDMAP_PALETTE);

async function handleMindmap(btn, aiRow, answerText, msgObj) {
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span>Đang vẽ mindmap…</span>';
  try {
    const spec = await apiPost('/api/generate/mindmap', { content: answerText });
    let existing = aiRow.querySelector('.mindmap-wrap');
    if (existing) existing.remove();
    const wrap = document.createElement('div');
    wrap.className = 'mindmap-wrap';
    aiRow.appendChild(wrap);
    renderMindmap(wrap, spec);
    wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    // GỐC CỦA LỖI ĐÃ SỬA: trước đây spec chỉ được vẽ vào DOM, KHÔNG được ghi lại vào msgObj/lưu
    // xuống localStorage — nên khi mở lại cuộc trò chuyện (hoặc chuyển qua môn khác rồi quay lại),
    // renderStoredAiMessage() không có dữ liệu đúng của message này để vẽ lại, dẫn tới hiện sai/lẫn
    // mindmap giữa các câu trả lời (vd môn Toán lại hiện mindmap môn Anh). Giờ lưu đúng vào msgObj
    // của CHÍNH câu trả lời đang thao tác rồi ghi xuống storage ngay.
    if (msgObj) {
      msgObj.mindmapSpec = spec;
      const conv = currentConversation();
      if (conv) touchConversation(conv);
    }
  } catch (e) {
    console.error(e);
    alert((e && e.message) || 'Không tạo được mindmap, vui lòng thử lại.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

// Đo bề rộng chữ thật (canvas 2D) để tự động xuống dòng nhãn node cho vừa khung, tránh chữ tràn ra
// ngoài hoặc node quá to so với nội dung ngắn.
let _mmMeasureCtx = null;
function mmTextWidth(text, fontPx, bold) {
  if (!_mmMeasureCtx) _mmMeasureCtx = document.createElement('canvas').getContext('2d');
  _mmMeasureCtx.font = `${bold ? '700' : '600'} ${fontPx}px 'Inter', 'Be Vietnam Pro', Arial, sans-serif`;
  return _mmMeasureCtx.measureText(text).width;
}
function mmWrapLabel(text, fontPx, bold, maxWidth, maxLines) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (mmTextWidth(test, fontPx, bold) > maxWidth && cur) {
      lines.push(cur);
      cur = w;
      if (lines.length === maxLines - 1) break;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  const used = lines.reduce((n, l) => n + l.split(' ').length, 0);
  if (used < words.length && lines.length) lines[lines.length - 1] += '…';
  return lines.slice(0, maxLines);
}

function mmCountLeaves(node) {
  if (!node.children || !node.children.length) return 1;
  return node.children.reduce((sum, c) => sum + mmCountLeaves(c), 0);
}

// Bố cục radial: gán (x,y,angle,depth) cho gốc + toàn bộ cây bằng cách chia đều góc 360° theo tỉ lệ
// số lá, rồi đẩy các node ra xa dần theo bán kính tăng theo cấp.
function mmLayout(spec) {
  const RADIUS = [0, 205, 375, 520];
  const root = { label: spec.title || 'Chủ đề', depth: 0, x: 0, y: 0, angle: 0, children: spec.branches || [] };
  function walk(node, angleStart, angleEnd, depth, parentColor, branchColor) {
    const angle = (angleStart + angleEnd) / 2;
    const r = RADIUS[Math.min(depth, RADIUS.length - 1)];
    node.depth = depth;
    node.angle = angle;
    node.x = depth === 0 ? 0 : Math.cos(angle) * r;
    node.y = depth === 0 ? 0 : Math.sin(angle) * r;
    node.color = depth === 1 ? (MINDMAP_PALETTE[node.color] || MINDMAP_PALETTE_ORDER0()) : (branchColor || null);
    const kids = node.children || [];
    if (kids.length) {
      const leafCounts = kids.map(mmCountLeaves);
      const total = leafCounts.reduce((a, b) => a + b, 0) || 1;
      let a = angleStart;
      const span = angleEnd - angleStart;
      kids.forEach((child, i) => {
        const childSpan = span * (leafCounts[i] / total);
        walk(child, a, a + childSpan, depth + 1, node.color, depth === 1 ? node.color : branchColor);
        a += childSpan;
      });
    }
  }
  function MINDMAP_PALETTE_ORDER0() { return MINDMAP_PALETTE[MINDMAP_PALETTE_ORDER[0]]; }
  walk(root, -Math.PI / 2, Math.PI * 1.5, 0, null, null);
  return root;
}

function mmFlatten(node, out) {
  out.push(node);
  (node.children || []).forEach((c) => mmFlatten(c, out));
  return out;
}

// Vị trí HIỂN THỊ thực tế của 1 node = vị trí bố cục gốc (n.x, n.y, do mmLayout tính) CỘNG với độ
// lệch người dùng đã tự kéo (n.dx, n.dy — mặc định 0, chỉ khác 0 sau khi kéo node bằng chuột/ngón
// tay, xem mmWireNodeDrag()). Tách riêng 2 giá trị này thay vì ghi đè thẳng lên n.x/n.y để mmLayout
// luôn có thể chạy lại (vd khi mở lại 1 mindmap đã lưu) mà không làm mất vị trí người dùng đã chỉnh.
function mmNodePos(n) { return { x: n.x + (n.dx || 0), y: n.y + (n.dy || 0) }; }
// Đường nối cha->con: đường cong mềm (cubic bezier) toả theo hướng góc — dùng CHUNG cho cả lần vẽ
// đầu tiên lẫn mỗi lần cập nhật lại khi 1 trong 2 đầu (cha/con) bị kéo sang vị trí khác.
function mmEdgePath(parent, child) {
  const p = mmNodePos(parent), c = mmNodePos(child);
  const dx = c.x - p.x, dy = c.y - p.y;
  const c1x = p.x + dx * 0.42, c1y = p.y + dy * 0.12;
  const c2x = p.x + dx * 0.58, c2y = p.y + dy * 0.88;
  return `M ${p.x} ${p.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${c.x} ${c.y}`;
}

function renderMindmap(container, spec) {
  const branches = (spec && spec.branches) || [];
  if (!branches.length) {
    container.innerHTML = '<div class="set-empty">Không tạo được mindmap từ nội dung này.</div>';
    return;
  }
  const root = mmLayout(spec);
  const allNodes = mmFlatten(root, []);
  // Giữ lại độ lệch đã kéo từ lần vẽ trước (nếu spec này đã từng được kéo chỉnh vị trí và lưu lại
  // — n.dx/n.dy được gán thẳng lên object gốc trong spec.branches nên vẫn còn khi render lại).
  allNodes.forEach((n) => { if (typeof n.dx !== 'number') n.dx = 0; if (typeof n.dy !== 'number') n.dy = 0; });

  // Kích thước từng node theo cấp (gốc to nhất, nhỏ dần ra ngoài) + tự xuống dòng nhãn.
  const SIZE_BY_DEPTH = [
    { font: 16.5, padX: 22, padY: 15, maxW: 200, maxLines: 3, bold: true },
    { font: 13.5, padX: 16, padY: 11, maxW: 150, maxLines: 3, bold: true },
    { font: 12, padX: 13, padY: 9, maxW: 128, maxLines: 3, bold: false },
    { font: 11, padX: 11, padY: 8, maxW: 110, maxLines: 3, bold: false }
  ];
  allNodes.forEach((n) => {
    const cfg = SIZE_BY_DEPTH[Math.min(n.depth, SIZE_BY_DEPTH.length - 1)];
    n.lines = mmWrapLabel(n.label, cfg.font, cfg.bold, cfg.maxW, cfg.maxLines);
    const textW = Math.max(...n.lines.map((l) => mmTextWidth(l, cfg.font, cfg.bold)), 20);
    n.w = textW + cfg.padX * 2;
    n.h = n.lines.length * (cfg.font * 1.28) + cfg.padY * 2;
    n.cfg = cfg;
  });

  // viewBox bao trọn mọi node (tính theo VỊ TRÍ HIỂN THỊ THỰC TẾ — tức đã cộng dx/dy — để node đã
  // bị kéo ra xa không bị cắt mất khỏi khung nhìn).
  let minX = 0, maxX = 0, minY = 0, maxY = 0;
  allNodes.forEach((n) => {
    const p = mmNodePos(n);
    minX = Math.min(minX, p.x - n.w / 2); maxX = Math.max(maxX, p.x + n.w / 2);
    minY = Math.min(minY, p.y - n.h / 2); maxY = Math.max(maxY, p.y + n.h / 2);
  });
  const PAD = 40;
  minX -= PAD; minY -= PAD; maxX += PAD; maxY += PAD;
  const vbW = maxX - minX, vbH = maxY - minY;

  const esc = escapeHtml;
  const isDark = document.body.classList.contains('dark') || document.documentElement.classList.contains('dark');

  const edgesSvg = [];
  // Song song với edgesSvg (chuỗi HTML) — giữ tham chiếu {parent, child} theo ĐÚNG THỨ TỰ để sau khi
  // chèn vào DOM, có thể ghép (zip theo index) từng <path> với đúng cặp node của nó, phục vụ cập
  // nhật lại đường nối mỗi khi 1 node bị kéo (xem mmWireNodeDrag()).
  const edgeMeta = [];
  function walkEdges(node) {
    (node.children || []).forEach((child) => {
      const color = child.depth === 1 ? child.color : (child.color || '#94a1bf');
      const width = child.depth === 1 ? 3.2 : child.depth === 2 ? 2.2 : 1.5;
      const opacity = child.depth === 1 ? 0.9 : child.depth === 2 ? 0.55 : 0.4;
      edgesSvg.push(`<path d="${mmEdgePath(node, child)}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" opacity="${opacity}"/>`);
      edgeMeta.push({ parent: node, child });
      walkEdges(child);
    });
  }
  walkEdges(root);

  const nodesSvg = allNodes.map((n) => {
    const cfg = n.cfg;
    const rx = n.depth === 0 ? n.h / 2 : 12;
    let fill, stroke, textColor;
    if (n.depth === 0) {
      fill = isDark ? '#141f38' : '#0e1524';
      stroke = 'none';
      textColor = '#ffffff';
    } else if (n.depth === 1) {
      fill = n.color;
      stroke = 'none';
      textColor = '#ffffff';
    } else {
      fill = isDark ? 'rgba(255,255,255,.06)' : '#ffffff';
      stroke = n.color;
      textColor = isDark ? '#e7ecf7' : '#0e1524';
    }
    const lineH = cfg.font * 1.28;
    const startY = -((n.lines.length - 1) * lineH) / 2;
    const tspans = n.lines.map((l, i) => `<tspan x="${n.x}" y="${n.y + startY + i * lineH}">${esc(l)}</tspan>`).join('');
    return `<g class="mm-node" data-depth="${n.depth}" transform="translate(${n.dx},${n.dy})">
      <rect x="${n.x - n.w / 2}" y="${n.y - n.h / 2}" width="${n.w}" height="${n.h}" rx="${rx}"
        fill="${fill}" stroke="${stroke}" stroke-width="${stroke === 'none' ? 0 : 1.6}"/>
      <text text-anchor="middle" dominant-baseline="middle" fill="${textColor}"
        style="font-size:${cfg.font}px;font-weight:${cfg.bold ? 700 : 600};font-family:'Inter','Be Vietnam Pro',Arial,sans-serif;">${tspans}</text>
    </g>`;
  }).join('');

  container.innerHTML = `
    <div class="mm-head">
      <span>${ICONS.mindmap}<b>Mindmap trực quan</b></span>
      <div class="mm-toolbar">
        <button data-mm="out" title="Thu nhỏ">${ICONS.zoomOut}</button>
        <button data-mm="fit" title="Canh vừa khung nhìn (giữ nguyên các khối đã kéo)">${ICONS.fit}</button>
        <button data-mm="in" title="Phóng to">${ICONS.zoomIn}</button>
        <button data-mm="reset" title="Về vị trí gốc (cả khối đã kéo)">${ICONS.refresh}</button>
        <button data-mm="full" title="Toàn màn hình">${ICONS.expand}</button>
        <button data-mm="dl" title="Tải ảnh PNG">${ICONS.download}</button>
      </div>
    </div>
    <div class="mm-stage">
      <div class="mm-pan">
        <svg class="mm-svg" viewBox="${minX} ${minY} ${vbW} ${vbH}" xmlns="http://www.w3.org/2000/svg">
          <g class="mm-edges">${edgesSvg.join('')}</g>
          <g class="mm-nodes">${nodesSvg}</g>
        </svg>
      </div>
    </div>
    <div class="mm-hint">Kéo nền để di chuyển · kéo từng khối để sắp xếp lại · lăn chuột/chụm 2 ngón để phóng to · bấm 1 khối để sửa/thêm/xóa nhánh · bấm tải ảnh để lưu về máy</div>
  `;

  mmWireInteractions(container, spec, allNodes, edgeMeta);
}

// Kéo-thả (pan) + phóng to/thu nhỏ (zoom) bằng CSS transform thuần trên <div class="mm-pan">, không
// phụ thuộc thư viện ngoài. Toàn màn hình dùng Fullscreen API sẵn có của trình duyệt (fallback: class
// CSS phủ kín màn hình nếu trình duyệt không hỗ trợ). Tải PNG: serialize SVG hiện tại -> vẽ vào
// <canvas> ở độ phân giải x2 (nét hơn) -> xuất file .png tải thẳng về máy, không cần server.
function mmWireInteractions(container, spec, allNodes, edgeMeta) {
  const stage = container.querySelector('.mm-stage');
  const pan = container.querySelector('.mm-pan');
  const svgEl = container.querySelector('.mm-svg');
  // scale/tx/ty: giá trị ĐANG HIỂN THỊ (được nội suy dần mỗi khung hình về phía targetScale/tx/ty
  // bên dưới) — tách 2 bộ giá trị này ra để phóng to/thu nhỏ có cảm giác trượt mượt thay vì nhảy
  // khấc ngay lập tức mỗi lần cuộn chuột/chụm ngón/bấm nút, đồng thời vẫn cộng dồn ĐÚNG khi người
  // dùng thao tác liên tiếp nhanh (tính điểm đích mới dựa trên target hiện tại, không dựa trên giá
  // trị đang nội suy dở nên không bị "trễ nhịp" so với thao tác).
  let scale = 1, tx = 0, ty = 0;
  let targetScale = 1, targetTx = 0, targetTy = 0;
  let zoomRafId = null;
  function apply() { pan.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`; }
  function zoomTick() {
    const k = 0.3; // hệ số nội suy mỗi khung hình
    scale += (targetScale - scale) * k;
    tx += (targetTx - tx) * k;
    ty += (targetTy - ty) * k;
    apply();
    if (Math.abs(targetScale - scale) > 0.001 || Math.abs(targetTx - tx) > 0.3 || Math.abs(targetTy - ty) > 0.3) {
      zoomRafId = requestAnimationFrame(zoomTick);
    } else {
      scale = targetScale; tx = targetTx; ty = targetTy; apply();
      zoomRafId = null;
    }
  }
  function animateTo(nextScale, nextTx, nextTy) {
    targetScale = nextScale; targetTx = nextTx; targetTy = nextTy;
    if (!zoomRafId) zoomRafId = requestAnimationFrame(zoomTick);
  }
  function setScale(next, cx, cy) {
    next = Math.min(3, Math.max(0.35, next));
    const rect = stage.getBoundingClientRect();
    const px = (cx != null ? cx - rect.left : rect.width / 2);
    const py = (cy != null ? cy - rect.top : rect.height / 2);
    const nextTx = targetTx - (px - targetTx) * (next / targetScale - 1);
    const nextTy = targetTy - (py - targetTy) * (next / targetScale - 1);
    animateTo(next, nextTx, nextTy);
  }
  container.querySelector('[data-mm="in"]').onclick = () => setScale(targetScale * 1.25);
  container.querySelector('[data-mm="out"]').onclick = () => setScale(targetScale / 1.25);
  // "Canh vừa khung nhìn": chỉ đưa pan/zoom về mặc định — viewBox của SVG đã tự tính để bao trọn
  // đúng toàn bộ sơ đồ hiện tại (xem renderMindmap), nên scale=1/tx=ty=0 nghĩa là vừa khít khung
  // nhìn — KHÔNG đụng tới vị trí các khối đã kéo, khác với nút "Về vị trí gốc" bên cạnh.
  container.querySelector('[data-mm="fit"]').onclick = () => { closeFloating(); animateTo(1, 0, 0); };
  container.querySelector('[data-mm="reset"]').onclick = () => {
    closeFloating();
    animateTo(1, 0, 0);
    // "Về vị trí gốc" đưa CẢ những khối đã bị kéo lệch quay lại đúng vị trí bố cục ban đầu, không
    // chỉ reset phóng to/kéo toàn khung — đúng như tên nút, tránh gây khó hiểu khi bấm mà khối vẫn
    // còn nằm sai chỗ.
    allNodes.forEach((n) => { n.dx = 0; n.dy = 0; });
    nodeEls.forEach((g) => g.setAttribute('transform', 'translate(0,0)'));
    edgeEls.forEach((edgeEl, i) => edgeEl.setAttribute('d', mmEdgePath(edgeMeta[i].parent, edgeMeta[i].child)));
    saveMindmapPositions();
  };
  // Toàn màn hình kiểu CSS thuần (position:fixed phủ kín viewport) thay vì Fullscreen API của trình
  // duyệt — nhất quán hơn trên mobile/Safari (nơi Fullscreen API hay bị hạn chế hoặc ẩn thanh công
  // cụ), và vẫn giữ được toolbar/nút bấm hiển thị bình thường khi phóng to.
  container.querySelector('[data-mm="full"]').onclick = () => {
    closeFloating(); // đổi kích thước khung nhìn -> vị trí thanh công cụ/ô sửa (tính theo toạ độ màn hình) sẽ sai, đóng lại cho chắc
    container.classList.toggle('mm-fullscreen');
    document.body.classList.toggle('mm-lock-scroll', container.classList.contains('mm-fullscreen'));
  };
  document.addEventListener('keydown', function escClose(e) {
    if (e.key === 'Escape' && container.classList.contains('mm-fullscreen')) {
      container.classList.remove('mm-fullscreen');
      document.body.classList.remove('mm-lock-scroll');
    }
  });

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    closeFloating();
    setScale(targetScale * (e.deltaY < 0 ? 1.12 : 0.89), e.clientX, e.clientY);
  }, { passive: false });

  // Kéo (1 ngón/chuột) + CHỤM 2 NGÓN để phóng to/thu nhỏ (pinch-to-zoom) — dùng chung Pointer Events
  // API cho cả chuột lẫn đa điểm chạm trên điện thoại. Trước đây chỉ có 'wheel' (chuột) và kéo 1
  // ngón được nối, nên trên điện thoại chụm 2 ngón không có tác dụng gì dù trong phần hint có nhắc
  // tới — đây chính là lỗi "không phóng to thu nhỏ được trên điện thoại".
  const activePointers = new Map();
  let lastX = 0, lastY = 0;
  let pinchStartDist = 0, pinchStartScale = 1, pinchMidX = 0, pinchMidY = 0;
  const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const mid2 = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  stage.addEventListener('pointerdown', (e) => {
    closeFloating();
    stage.setPointerCapture(e.pointerId);
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.size === 1) {
      lastX = e.clientX; lastY = e.clientY;
      stage.classList.add('dragging');
    } else if (activePointers.size === 2) {
      stage.classList.remove('dragging');
      const [a, b] = [...activePointers.values()];
      pinchStartDist = dist2(a, b) || 1;
      pinchStartScale = targetScale;
      const m = mid2(a, b);
      pinchMidX = m.x; pinchMidY = m.y;
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!activePointers.has(e.pointerId)) return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.size >= 2) {
      const [a, b] = [...activePointers.values()];
      const m = mid2(a, b);
      // Trung điểm 2 ngón di chuyển -> kéo (pan) theo, giữ đúng cảm giác "chụm ở đâu, dính ở đó".
      // Đồng bộ luôn target=hiện-tại để pan bằng ngón tay là THAO TÁC TRỰC TIẾP (không bị làm mượt
      // trễ nhịp), chỉ riêng phần zoom (setScale bên dưới) mới nội suy mượt.
      tx += m.x - pinchMidX; ty += m.y - pinchMidY;
      targetTx = tx; targetTy = ty;
      pinchMidX = m.x; pinchMidY = m.y;
      const d = dist2(a, b) || 1;
      setScale(pinchStartScale * (d / pinchStartDist), m.x, m.y);
    } else if (activePointers.size === 1) {
      tx += e.clientX - lastX; ty += e.clientY - lastY;
      targetTx = tx; targetTy = ty;
      lastX = e.clientX; lastY = e.clientY;
      apply();
    }
  });
  function endPointer(e) {
    activePointers.delete(e.pointerId);
    if (activePointers.size === 1) {
      const [p] = [...activePointers.values()];
      lastX = p.x; lastY = p.y;
      stage.classList.add('dragging');
    } else {
      stage.classList.remove('dragging');
    }
  }
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => stage.addEventListener(ev, endPointer));

  // === Kéo TỪNG KHỐI (node) riêng lẻ để tự sắp xếp lại bố cục, tách biệt với kéo-cả-sơ-đồ ở trên ===
  // nodeEls/edgeEls đúng thứ tự với allNodes/edgeMeta vì cả 2 đều được dựng bằng .map()/push() theo
  // đúng thứ tự đó khi render HTML (xem renderMindmap) — ghép theo index là an toàn.
  const nodeEls = [...container.querySelectorAll('.mm-nodes > .mm-node')];
  const edgeEls = [...container.querySelectorAll('.mm-edges > path')];
  function updateEdgesFor(node) {
    edgeMeta.forEach((edge, i) => {
      if (edge.parent === node || edge.child === node) edgeEls[i].setAttribute('d', mmEdgePath(edge.parent, edge.child));
    });
  }
  // Chuyển toạ độ con trỏ (pixel màn hình) sang đúng toạ độ user-space của SVG — getScreenCTM() đã
  // tự tính gộp cả viewBox lẫn transform CSS (pan/zoom) đang áp trên .mm-pan, nên không cần tự quy
  // đổi tay theo scale/tx/ty hiện tại (dễ sai khi đang phóng to/thu nhỏ).
  function toSvgPoint(e) {
    const pt = svgEl.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    return pt.matrixTransform(svgEl.getScreenCTM().inverse());
  }
  // === Chỉnh sửa nội dung trực tiếp: bấm 1 khối -> chọn (hiện thanh công cụ nổi Sửa/Thêm/Xóa cạnh
  // khối đó), bấm "Sửa" -> chữ biến thành ô nhập đè lên đúng vị trí node. Dùng chung 1 phần tử
  // <textarea>/<div> gắn vào <body> với position:fixed và toạ độ lấy từ getBoundingClientRect() của
  // khối SVG đang chọn — luôn khớp đúng vị trí hiển thị THỰC TẾ dù đang phóng to/kéo lệch/toàn màn
  // hình cỡ nào, không cần tự quy đổi tay theo scale/pan hiện tại. ============================
  let selectedEl = null, floatToolbar = null, editBox = null;

  function closeFloating() {
    if (floatToolbar) { floatToolbar.remove(); floatToolbar = null; }
    if (editBox) commitEdit();
    if (selectedEl) { selectedEl.classList.remove('mm-selected'); selectedEl = null; }
  }

  function refresh() {
    // Vẽ lại toàn bộ sơ đồ từ đúng spec vừa sửa — n.dx/n.dy vẫn giữ nguyên vì được gán thẳng lên
    // CHÍNH object node bên trong spec.branches (không bị mất khi dựng lại), rồi lưu ngay xuống
    // cuộc trò chuyện để refresh trang không mất nội dung vừa sửa/thêm/xóa.
    renderMindmap(container, spec);
    saveMindmapPositions();
  }

  function findParent(node) {
    const edge = edgeMeta.find((e) => e.child === node);
    return edge ? edge.parent : null;
  }

  function countDescendants(node) {
    return (node.children || []).reduce((n, c) => n + 1 + countDescendants(c), 0);
  }

  function commitEdit() {
    if (!editBox) return;
    const { node, textarea } = editBox;
    editBox = null;
    const val = textarea.value.trim();
    if (val) node.label = val;
    textarea.remove();
    refresh();
  }

  function cancelEdit() {
    if (!editBox) return;
    const { textarea } = editBox;
    editBox = null;
    textarea.remove();
  }

  function openEdit(g, node) {
    if (floatToolbar) { floatToolbar.remove(); floatToolbar = null; }
    g.classList.add('mm-selected');
    selectedEl = g;
    const rect = g.getBoundingClientRect();
    const ta = document.createElement('textarea');
    ta.className = 'mm-edit-box';
    ta.value = node.label || '';
    ta.style.left = rect.left + 'px';
    ta.style.top = rect.top + 'px';
    ta.style.width = Math.max(rect.width, 100) + 'px';
    ta.style.height = Math.max(rect.height, 36) + 'px';
    document.body.appendChild(ta);
    editBox = { node, textarea: ta };
    ta.focus();
    ta.select();
    ta.addEventListener('pointerdown', (e) => e.stopPropagation());
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ta.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); closeFloating(); }
    });
    ta.addEventListener('blur', () => commitEdit());
  }

  function openToolbar(g, node) {
    closeFloating();
    g.classList.add('mm-selected');
    selectedEl = g;
    const rect = g.getBoundingClientRect();
    const bar = document.createElement('div');
    bar.className = 'mm-node-toolbar';
    bar.style.left = (rect.left + rect.width / 2) + 'px';
    bar.style.top = rect.top + 'px';
    const canDelete = node.depth > 0;
    bar.innerHTML = `
      <button data-a="edit" title="Sửa nội dung">${ICONS.pencil}</button>
      <button data-a="add" title="Thêm nhánh con">${ICONS.plus}</button>
      ${canDelete ? `<button data-a="del" title="Xóa nhánh này">${ICONS.trash}</button>` : ''}
    `;
    document.body.appendChild(bar);
    floatToolbar = bar;
    bar.addEventListener('pointerdown', (e) => e.stopPropagation());
    bar.querySelector('[data-a="edit"]').onclick = () => openEdit(g, node);
    bar.querySelector('[data-a="add"]').onclick = () => {
      if (!node.children) node.children = [];
      const child = { label: 'Nhánh mới', children: [] };
      node.children.push(child);
      container._mmPendingEdit = child; // xem đoạn kiểm tra ở cuối hàm mmWireInteractions
      // Thanh công cụ nổi được gắn vào <body> (ngoài container) nên KHÔNG tự mất khi refresh() thay
      // nội dung container — phải tự tay dọn ở đây, nếu không sẽ để sót 1 thanh công cụ "ma" trên
      // màn hình sau khi sơ đồ đã được vẽ lại.
      bar.remove(); floatToolbar = null;
      refresh();
    };
    const delBtn = bar.querySelector('[data-a="del"]');
    if (delBtn) {
      delBtn.onclick = () => {
        const parent = findParent(node);
        if (!parent) return;
        const extra = countDescendants(node);
        if (extra > 0 && !confirm(`Xóa nhánh "${node.label}" sẽ xóa luôn ${extra} nhánh con bên trong. Tiếp tục?`)) return;
        parent.children = (parent.children || []).filter((c) => c !== node);
        closeFloating();
        refresh();
      };
    }
  }

  // Dọn listener chọn-ngoài-vùng của lần render TRƯỚC (nếu có) trước khi gắn cái mới — refresh()
  // gọi lại renderMindmap -> mmWireInteractions nhiều lần trong 1 phiên chỉnh sửa, nếu không dọn sẽ
  // chồng chất nhiều listener trên document theo thời gian.
  if (container._mmDocHandler) document.removeEventListener('pointerdown', container._mmDocHandler);
  function onDocPointerDown(e) {
    if (floatToolbar && floatToolbar.contains(e.target)) return;
    if (editBox && editBox.textarea.contains(e.target)) return;
    if (selectedEl && selectedEl.contains(e.target)) return;
    closeFloating();
  }
  container._mmDocHandler = onDocPointerDown;
  document.addEventListener('pointerdown', onDocPointerDown);

  nodeEls.forEach((g, i) => {
    const node = allNodes[i];
    let dragging = false, last = null, moved = false, startClientX = 0, startClientY = 0;
    g.addEventListener('pointerdown', (e) => {
      e.stopPropagation(); // chặn không cho .mm-stage nhận cùng sự kiện -> tránh vừa kéo khối vừa kéo (pan) cả sơ đồ
      g.setPointerCapture(e.pointerId);
      dragging = true;
      moved = false;
      startClientX = e.clientX; startClientY = e.clientY;
      last = toSvgPoint(e);
      g.classList.add('mm-node-dragging');
    });
    g.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      if (Math.hypot(e.clientX - startClientX, e.clientY - startClientY) > 4) moved = true;
      const pt = toSvgPoint(e);
      node.dx += pt.x - last.x;
      node.dy += pt.y - last.y;
      last = pt;
      g.setAttribute('transform', `translate(${node.dx},${node.dy})`);
      updateEdgesFor(node);
    });
    function endDrag() {
      if (!dragging) return;
      dragging = false;
      g.classList.remove('mm-node-dragging');
      if (moved) {
        saveMindmapPositions();
      } else {
        // Không di chuyển đáng kể -> đây là BẤM CHỌN (không phải kéo) -> hiện thanh Sửa/Thêm/Xóa.
        openToolbar(g, node);
      }
    }
    g.addEventListener('pointerup', endDrag);
    g.addEventListener('pointercancel', endDrag);
  });

  container.querySelector('[data-mm="dl"]').onclick = () => mmDownloadPNG(svgEl, spec.title || 'mindmap');

  // Nếu vừa bấm "Thêm nhánh con" ở lần render TRƯỚC (xem openToolbar ở trên), tự động vào chế độ
  // sửa NGAY cho đúng node mới tạo đó ở lần render này — tìm lại bằng đúng tham chiếu object (child
  // vẫn là cùng 1 object xuyên suốt các lần renderMindmap vì mmLayout chỉ gán thêm thuộc tính lên
  // object có sẵn trong spec.branches, không tạo bản sao).
  if (container._mmPendingEdit) {
    const pending = container._mmPendingEdit;
    container._mmPendingEdit = null;
    const idx = allNodes.indexOf(pending);
    if (idx !== -1) openEdit(nodeEls[idx], allNodes[idx]);
  }
}

// Lưu lại độ lệch (dx/dy) vừa kéo vào cuộc trò chuyện hiện tại. n.dx/n.dy được gán thẳng lên đúng
// object node bên trong spec.branches — cùng 1 tham chiếu với object đã lưu trong
// state.conversations (xem handleMindmapOnlyTurn) — nên chỉ cần gọi lại saveConversations() là đủ
// để vị trí vừa kéo còn nguyên sau khi tải lại trang. An toàn gọi cả khi mindmap hiện tại không
// thuộc tin nhắn nào đã lưu (vd tạo qua nút "Mindmap trực quan" dưới 1 lời giải) — chỉ đơn giản lưu
// lại đúng trạng thái state.conversations hiện có, không gây lỗi gì thêm.
function saveMindmapPositions() {
  try { saveConversations(); } catch (e) { /* bỏ qua an toàn nếu chưa sẵn sàng */ }
}

async function mmDownloadPNG(svgEl, title) {
  const clone = svgEl.cloneNode(true);
  const vb = svgEl.viewBox.baseVal;
  const bg = document.body.classList.contains('dark') ? '#0b1220' : '#ffffff';
  clone.setAttribute('style', `background:${bg}`);
  const xml = new XMLSerializer().serializeToString(clone);
  const svg64 = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  const img = new Image();
  await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = svg64; });
  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = vb.width * scale;
  canvas.height = vb.height * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  canvas.toBlob((blob) => {
    if (!blob) return;
    const fname = (title || 'mindmap').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60) || 'mindmap';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fname + '.png';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }, 'image/png');
}

/* ================= Mindmap trực tiếp từ chat: 1 lượt duy nhất =================
 * Kích hoạt khi isMindmapRequest(query) nhận diện người dùng đang chủ động xin vẽ mindmap/sơ đồ tóm
 * tắt (không phải giải 1 bài toán cụ thể) — cùng triết lý với handleOutlineOnlyTurn(): 1 lượt gọi AI
 * duy nhất tới POST /api/generate/mindmap, hiển thị NGAY sơ đồ trực quan trong khung chat, không có
 * bước "Xem cách giải chi tiết" nào ở giữa. Ngoài ra, nút "Mindmap trực quan" ở buildStudyActions vẫn
 * luôn có sẵn sau MỌI lời giải chi tiết để người dùng tự bấm vẽ khi cần, không bắt buộc phải gõ đúng
 * mẫu câu này.
 */
function isMindmapRequest(text) {
  const t = (text || '').toLowerCase().trim();
  if (!t || t.length > 200) return false;
  const hasProblemSignal = /[=]|\\frac|\btính\b|\bgiải\b(?!\s*(thích|nghĩa))|\bchứng minh\b|\brút gọn\b|\btìm x\b|\btìm y\b|\bcho tam giác\b|\bcho hình\b|\bcho hàm số\b|\bcho phương trình\b|\bcho biết\b/.test(t);
  if (hasProblemSignal) return false;
  return /(mindmap|mind map|sơ đồ tư duy|sơ đồ tóm tắt|vẽ sơ đồ|tóm tắt.*(bằng|dạng|thành).*sơ đồ|hệ thống hóa.*sơ đồ)/.test(t);
}

async function handleMindmapOnlyTurn(query, conv) {
  // PHẦN II.B/IV (kiến trúc mới): KHÔNG còn await toàn bộ vòng đời nguồn trước khi dựng request —
  // đó là root cause khiến 1 câu hỏi đơn giản phải chờ CẢ PDF scan 134 trang đọc xong. retrieveContext()
  // bên dưới tự lấy evidence THẬT đang có qua collectAvailableEvidence() (PHẦN VIII), dùng được ngay
  // cả khi nguồn còn đang enrich nền. waitForAllSourceProcessing() vẫn tồn tại cho nơi THỰC SỰ cần
  // full coverage (vd export toàn bộ tài liệu) — không dùng làm hàng rào mặc định cho mọi câu hỏi nữa.
  const contexts = retrieveContext(query);
  // mindmapOnly: true đánh dấu đây là tin nhắn CHỈ có mindmap (không có Hướng giải/Lời giải chi
  // tiết riêng) — dùng để renderStoredAiMessage() phân biệt với trường hợp mindmap được vẽ THÊM vào
  // 1 câu trả lời bài toán bình thường qua nút "Mindmap trực quan" (xem handleMindmap), tránh nhầm
  // giữa 2 loại khi mở lại cuộc trò chuyện (mindmap của môn này lại hiện ra ở môn khác).
  const aiMsgObj = { id: uid(), role: 'ai', query, approach: '', detail: null, contexts: [], crossChecked: false, mindmapSpec: null, mindmapOnly: true };
  const aiRow = addAiMsg('Mindmap');
  aiRow.dataset.msgId = aiMsgObj.id;
  const contentEl = aiRow.querySelector('.content');
  conv.messages.push(aiMsgObj);
  touchConversation(conv);

  try {
    const sourceContent = contexts.length
      ? query + '\n\nNguồn tài liệu liên quan đã nạp:\n' + contexts.map((c, i) => `[${i + 1}] (${c.doc}) ${c.text}`).join('\n')
      : query;
    const spec = await apiPost('/api/generate/mindmap', { content: sourceContent, sourceImages: collectSourceImages(query) });

    aiMsgObj.mindmapSpec = spec;
    aiMsgObj.approach = mindmapSpecToPlainText(spec);

    contentEl.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'mindmap-wrap';
    contentEl.appendChild(wrap);
    renderMindmap(wrap, spec);
    contentEl.appendChild(buildNoteBlock(aiMsgObj));
    touchConversation(conv);

    state.history.push({ role: 'user', content: query });
    state.history.push({ role: 'assistant', content: aiMsgObj.approach });
    trimHistoryMemory();
  } catch (e) {
    const msg = (e && e.message) || 'Không tạo được mindmap, vui lòng thử lại.';
    const escaped = escapeHtml(msg).replace(/\n/g, '<br>');
    contentEl.innerHTML = `<p style="color:#c0392b;white-space:pre-wrap;">⚠️ ${escaped}</p>`;
    console.error(e);
  } finally {
    el('sendBtn').disabled = false;
    statusEl.textContent = t('chat.statusReady');
    scrollThreadToBottom();
  }
}

function mindmapSpecToPlainText(spec) {
  if (!spec) return '';
  const lines = [spec.title || ''];
  function walk(node, depth) {
    (node.children || []).forEach((c) => {
      lines.push('  '.repeat(depth) + '- ' + c.label);
      walk(c, depth + 1);
    });
  }
  walk({ children: spec.branches || [] }, 0);
  return lines.join('\n');
}

/* ================= Study Dashboard (màn hình trống) =================
 * Thay cho khối chào hỏi dạng văn bản thuần trước đây — đây là "Bạn đang học gì hôm nay" thật sự:
 * action card khởi động nhanh 1 kiểu bài (chỉ điền sẵn gợi ý vào ô nhập, KHÔNG tự gửi), "Gần đây bạn
 * học" (lấy thẳng từ state.conversations) và "Ôn lại hôm nay" (đếm thật từ ghi chú/flashcard đã lưu).
 * Mọi số liệu đều lấy từ dữ liệu thật đang có trong state — mục nào không có dữ liệu thì ẨN, không
 * bịa ra số 0 hay placeholder giả (đúng nguyên tắc "không fake dữ liệu học tập").
 */
// Quick Actions phân theo learning intent: GIẢI BÀI / HỌC / LUYỆN / ÔN — mỗi nhóm 1 nhãn nhỏ,
// KHÔNG tạo UI phức tạp, chỉ nhóm trực quan trong cùng lưới hiện có.
const STUDY_STARTER_GROUPS = [
  {
    group: 'Giải bài', items: [
      { icon: '📐', label: 'Toán', starter: 'Giải giúp mình bài Toán sau:\n' },
      { icon: '🧪', label: 'Hóa', starter: 'Giải giúp mình bài Hóa sau:\n' },
      { icon: '⚡', label: 'Vật lý', starter: 'Giải giúp mình bài Vật lý sau:\n' }
    ]
  },
  { group: 'Học', items: [{ icon: '📖', label: 'Giải thích lý thuyết', starter: 'Giải thích giúp mình lý thuyết về: ' }] },
  { group: 'Luyện', items: [{ icon: '📝', label: 'Luyện tập', starter: null, action: 'practice' }] },
  { group: 'Ôn', items: [{ icon: '🧠', label: 'Ôn tập nhanh', starter: 'Tóm tắt nhanh giúp mình kiến thức trọng tâm về: ' }] }
];

function welcome() {
  const row = document.createElement('div');
  row.className = 'msg-row msg-ai';

  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = 'Trợ Giải';
  row.appendChild(label);

  const dash = document.createElement('div');
  dash.className = 'study-dashboard';

  const hero = document.createElement('div');
  hero.className = 'sd-hero';
  hero.innerHTML = '<h2>Chào bạn 👋</h2><p>Hôm nay mình học gì?</p>';
  dash.appendChild(hero);

  // "Tiếp tục học" — buổi học gần nhất còn dữ liệu, đứng NGAY dưới lời chào, trước Quick Actions.
  const mostRecent = [...state.conversations]
    .filter((c) => (c.messages || []).length > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (mostRecent) {
    const cl = document.createElement('div');
    cl.className = 'sd-section sd-continue';
    cl.innerHTML = '<h3>Tiếp tục học</h3>';
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'sd-continue-card';
    const solvedCount = mostRecent.messages.filter((m) => m.role === 'user').length;
    card.innerHTML = `
      <span class="sd-continue-title"></span>
      <span class="sd-continue-meta">Đang học · ${solvedCount} lượt hỏi · ${timeAgo(mostRecent.updatedAt)}</span>
      <span class="sd-continue-btn">Tiếp tục →</span>
    `;
    card.querySelector('.sd-continue-title').textContent = mostRecent.title || 'Buổi học';
    card.onclick = () => loadConversation(mostRecent.id);
    cl.appendChild(card);
    dash.appendChild(cl);
  }

  const grid = document.createElement('div');
  grid.className = 'sd-actions-groups';
  STUDY_STARTER_GROUPS.forEach((g) => {
    const gWrap = document.createElement('div');
    gWrap.className = 'sd-action-group';
    const gLabel = document.createElement('span');
    gLabel.className = 'sd-action-group-label';
    gLabel.textContent = g.group;
    gWrap.appendChild(gLabel);
    const gRow = document.createElement('div');
    gRow.className = 'sd-actions';
    g.items.forEach((s) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sd-action';
      btn.innerHTML = `<span class="sd-action-ic" aria-hidden="true">${s.icon}</span><span>${s.label}</span>`;
      btn.onclick = () => {
        if (s.action === 'practice') { openPracticeSetup(); return; }
        const input = el('qInput');
        input.value = s.starter;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        input.dispatchEvent(new Event('input'));
      };
      gRow.appendChild(btn);
    });
    gWrap.appendChild(gRow);
    grid.appendChild(gWrap);
  });
  dash.appendChild(grid);

  // "Gần đây bạn học" — chỉ hiện khi thật sự có cuộc trò chuyện đã lưu (bỏ buổi vừa hiện ở "Tiếp tục học")
  const recentConvs = [...state.conversations]
    .filter((c) => (c.messages || []).length > 0 && (!mostRecent || c.id !== mostRecent.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 4);
  if (recentConvs.length) {
    const sec = document.createElement('div');
    sec.className = 'sd-section';
    sec.innerHTML = '<h3>Gần đây bạn học</h3>';
    const list = document.createElement('div');
    list.className = 'sd-recent-list';
    recentConvs.forEach((conv) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'sd-recent-item';
      item.innerHTML = `<span class="sd-recent-title"></span><span class="sd-recent-time"></span>`;
      item.querySelector('.sd-recent-title').textContent = conv.title || 'Cuộc trò chuyện';
      item.querySelector('.sd-recent-time').textContent = timeAgo(conv.updatedAt);
      item.onclick = () => loadConversation(conv.id);
      list.appendChild(item);
    });
    sec.appendChild(list);
    dash.appendChild(sec);
  }

  // "Ôn lại hôm nay" — chỉ hiện các mục thật sự có dữ liệu (ghi chú / flashcard đã lưu)
  const noteCount = collectAllNotes().length;
  const flashCount = state.flashcardSets.length;
  if (noteCount > 0 || flashCount > 0) {
    const sec = document.createElement('div');
    sec.className = 'sd-section';
    sec.innerHTML = '<h3>Ôn lại hôm nay</h3>';
    const list = document.createElement('div');
    list.className = 'sd-review-list';
    if (noteCount > 0) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'sd-review-item';
      item.innerHTML = `<span class="sd-review-ic">${ICONS.note}</span><span>${noteCount} ghi chú đã lưu</span>`;
      item.onclick = () => openSidebarTab('notes');
      list.appendChild(item);
    }
    if (flashCount > 0) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'sd-review-item';
      item.innerHTML = `<span class="sd-review-ic">${ICONS.cards}</span><span>${flashCount} bộ flashcard đã lưu</span>`;
      item.onclick = () => { toggleFlashcardPanel(); };
      list.appendChild(item);
    }
    sec.appendChild(list);
    dash.appendChild(sec);
  }

  if (state.docs.length) {
    const chip = document.createElement('div');
    chip.className = 'sd-source-chip';
    chip.textContent = `📎 Đang dùng ${state.docs.length} nguồn tài liệu cho câu trả lời`;
    dash.appendChild(chip);
  }

  const content = document.createElement('div');
  content.className = 'content';
  content.appendChild(dash);
  row.appendChild(content);
  threadEl.appendChild(row);
}

// Mở 1 tab bên sidebar theo id (dùng lại đúng cơ chế click nút tab hiện có, tránh trùng logic) và
// mở khung sidebar trên mobile (sidebar mặc định ẩn ở màn hình hẹp).
function openSidebarTab(tabId) {
  const tabBtn = document.querySelector(`.sbtab[data-tab="${tabId}"]`);
  if (tabBtn) tabBtn.click();
  if (window.innerWidth <= 760) { el('sidebar').classList.add('open'); el('sidebarOverlay').classList.add('show'); }
}

/* ================= Đề xuất ôn tập (khung bên phải) =================
   Mỗi khi gửi câu hỏi, gọi POST /api/recommend để lấy danh sách link gợi ý các trang tài liệu/bài
   tập uy tín rồi hiển thị ở khung nổi bên phải màn hình. REWORK (lần 2): server (xem comment đầu
   file server/routes/recommend.js) giờ dùng AI + tìm kiếm web THẬT xoay tua qua mọi provider đã
   cấu hình hỗ trợ web search (không cố định phải là Claude), có fallback về link Google tĩnh khi
   AI thất bại. Vì lượt gọi AI này có thể mất vài giây, khung KHÔNG còn tự động mở (popup) mỗi lần
   gửi câu hỏi nữa — request chạy NGẦM, kết quả lặng lẽ nạp vào khung kèm 1 dấu chấm báo (badge)
   nhỏ trên nút mở; người dùng chủ động bấm nút để xem. Nếu câu hỏi CHỈ xin đề (không kèm bài toán
   cụ thể), sendMessage() ở trên vẫn bỏ qua bước gọi AI giải bài như trước. */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// FIX P2/L (audit XSS): escapeHtml() chỉ escape ký tự đặc biệt HTML — KHÔNG chặn được URL kiểu
// `javascript:...`/`data:text/html,...` bị đặt vào thuộc tính href/src (escapeHtml không đổi các
// URL này vì chúng không chứa <, >, ", '). Server (recommend.js#sanitizeAiLinks) đã lọc chỉ giữ
// http/https trước khi trả về, nhưng frontend vẫn cần validate ĐỘC LẬP (defense-in-depth) cho MỌI
// nơi nhét URL runtime (AI trả về, nguồn/source, mindmap...) vào DOM — không tin tưởng ngầm định 1
// lớp lọc duy nhất. Trả về '#' (vô hại) nếu URL không phải http/https hợp lệ.
function sanitizeUrl(u) {
  try {
    const parsed = new URL(String(u), window.location.href);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
  } catch (e) { /* URL không hợp lệ -> rơi xuống trả về '#' bên dưới */ }
  return '#';
}

// Heuristic: câu hỏi CHỈ xin đề/bài tập ôn tập (không kèm 1 bài toán cụ thể cần giải) — ưu tiên
// AN TOÀN theo hướng "nếu còn nghi ngờ có bài toán thật thì vẫn giải bình thường" (false negative
// ở đây vô hại — vẫn giải + vẫn có khung đề xuất; false positive mới đáng ngại vì sẽ bỏ qua không
// giải 1 bài người dùng thực sự cần).
// LƯU Ý: KHÔNG nhận diện "đề cương" ở đây — "đề cương" là xin TÓM TẮT/HỆ THỐNG kiến thức (đã có cơ
// chế riêng ở isOutlineRequest() bên dưới, xem handleOutlineOnlyTurn()), khác hẳn "đề thi/đề ôn tập"
// (xin 1 bộ đề/bài tập để tự làm) — gộp chung 2 khái niệm này khiến yêu cầu xin đề cương trước đây
// chỉ nhận được link ở khung "Đề xuất ôn tập" mà không hề có đề cương nào được soạn ra cả.
function isExamOnlyRequest(text) {
  const t = (text || '').toLowerCase().trim();
  if (!t || t.length > 150) return false; // câu dài thường là đã dán nguyên đề bài -> luôn giải
  const hasProblemSignal = /[=]|\\frac|\btính\b|\bgiải\b|\bchứng minh\b|\brút gọn\b|\btìm x\b|\btìm y\b|\bcho tam giác\b|\bcho hình\b|\bcho hàm số\b|\bcho phương trình\b|\bcho biết\b/.test(t);
  if (hasProblemSignal) return false;
  const examSignal = /(đề\s*(thi|kiểm tra|ôn tập|ôn thi)|bài tập ôn tập|tài liệu ôn tập|nguồn (đề|bài tập)|bài tập tương tự)/;
  const askSignal = /\b(cho|tìm|gợi ý|xin|có|kiếm|đưa)\b/;
  return examSignal.test(t) && askSignal.test(t);
}

// Heuristic: câu hỏi xin SOẠN ĐỀ CƯƠNG / tóm tắt-hệ thống hóa lý thuyết (không phải 1 bài toán cụ
// thể cần giải từng bước). Cùng triết lý AN TOÀN với isExamOnlyRequest(): còn nghi ngờ có bài toán
// thật (có dấu "=", có "tính/giải/chứng minh/tìm x"...) thì KHÔNG nhận diện, cứ để luồng giải bài
// bình thường xử lý — false negative ở đây vô hại (vẫn giải bình thường, người dùng luôn có thể gõ
// thẳng yêu cầu soạn đề cương sau khi có lời giải chi tiết); false positive mới đáng ngại.
function isOutlineRequest(text) {
  const t = (text || '').toLowerCase().trim();
  if (!t || t.length > 200) return false;
  const hasProblemSignal = /[=]|\\frac|\btính\b|\bgiải\b(?!\s*(thích|nghĩa))|\bchứng minh\b|\brút gọn\b|\btìm x\b|\btìm y\b|\bcho tam giác\b|\bcho hình\b|\bcho hàm số\b|\bcho phương trình\b|\bcho biết\b/.test(t);
  if (hasProblemSignal) return false;
  const outlineSignal = /(đề cương|soạn.*(tóm tắt|đề cương)|(tóm tắt|tổng hợp|hệ thống hóa|khái quát)\s*(lại\s*)?(lý thuyết|kiến thức|công thức|nội dung|chương|bài))/;
  return outlineSignal.test(t);
}

let recommendAbortController = null;
// FIX PHẦN 9: 2 biến theo dõi để scheduleRecommend() CHỈ chạy khi có ý định rõ ràng (explicit) —
// không tự động chạy trong luồng giải bài bình thường. lastQueryForRecommend chỉ LƯU chuỗi câu hỏi
// (không gọi AI/web gì); recommendFetchedForQuery đánh dấu câu hỏi nào đã thực sự fetch rồi để
// tránh gọi lại trùng lặp khi người dùng mở/đóng panel nhiều lần cho cùng 1 câu hỏi.
let lastQueryForRecommend = null;
let recommendFetchedForQuery = null;
// Đưa 2 nút mở "Đề xuất ôn tập" / "Flashcard ôn tập" lên thanh trên cùng (topbar), cạnh nút đổi
// giao diện sáng/tối + Cài đặt AI — thay cho 2 nút tròn nổi (pill) trước đây chỉ hiện SAU KHI đóng
// panel. Giờ luôn có mặt sẵn trong topbar và hoạt động theo kiểu "bật/tắt" (bấm lần nữa để đóng),
// không cần đợi trạng thái đóng/mở như cơ chế reopen-btn cũ.
// mở panel = coi như người dùng đã "xem" kết quả mới nhất -> xoá luôn dấu chấm báo (badge) nếu có.
function openRecommendPanel() {
  el('recommendPanel').classList.add('open');
  el('recommendTopBtn').classList.remove('has-badge');
  // FIX PHẦN 9: đây là hành động BẤM NÚT chủ động của người dùng ("user bấm tính năng
  // recommendation") — lúc này mới thực sự gọi AI/web search, và chỉ khi chưa fetch cho đúng câu
  // hỏi gần nhất (tránh gọi lại trùng lặp nếu người dùng đóng/mở panel nhiều lần).
  if (lastQueryForRecommend && recommendFetchedForQuery !== lastQueryForRecommend) {
    recommendFetchedForQuery = lastQueryForRecommend;
    scheduleRecommend(lastQueryForRecommend);
  }
}
function closeRecommendPanel() { el('recommendPanel').classList.remove('open'); }
function toggleRecommendPanel() {
  if (el('recommendPanel').classList.contains('open')) closeRecommendPanel(); else openRecommendPanel();
}
el('recommendCloseBtn').onclick = closeRecommendPanel;
el('recommendTopBtn').onclick = toggleRecommendPanel;

// Khung "Flashcard ôn tập" — cùng cơ chế bật/tắt với #recommendPanel ở trên (xem handleFlashcards()
// phía trên). openFlashcardPanel() chỉ mở khung, KHÔNG tự vẽ nội dung (người gọi tự quyết định vẽ
// bộ thẻ vừa tạo hay danh sách đã lưu). Bấm nút biểu tượng trên topbar (toggleFlashcardPanel, không
// đi kèm 1 câu trả lời cụ thể) LUÔN mở ra danh sách các bộ thẻ đã lưu trước đó (renderFlashcardLibrary),
// giống cách khung "Đề xuất ôn tập" liệt kê các link đã tìm được — bấm vào 1 bộ để dùng lại bộ đó.
// Đóng khung (nút ✕ hoặc bấm lại icon để tắt) sẽ tự LƯU bộ thẻ vừa tạo (nếu có, chưa lưu) vào danh
// sách này, nên không cần thao tác lưu thủ công nào khác.
function openFlashcardPanel() { el('flashcardPanel').classList.add('open'); }
function closeFlashcardPanel() { commitActiveFlashcardSet(); el('flashcardPanel').classList.remove('open'); }
function toggleFlashcardPanel() {
  if (el('flashcardPanel').classList.contains('open')) { closeFlashcardPanel(); return; }
  openFlashcardPanel();
  renderFlashcardLibrary(true); // mở lại từ đầu -> luôn về trang 1
}
el('flashcardCloseBtn').onclick = closeFlashcardPanel;
el('flashcardTopBtn').onclick = toggleFlashcardPanel;

// REWORK (lần 2): route giờ gọi AI + tìm kiếm web thật (xem comment đầu server/routes/recommend.js)
// nên có thể mất vài giây — nhưng vì request chạy NGẦM (không tự mở panel), trạng thái "đang tìm"
// bên dưới chỉ hiển thị cho người dùng nào chủ động mở panel SỚM, trước khi kết quả kịp về.
function renderRecommendLoading() {
  el('recommendBody').innerHTML = '<div class="rec-empty">🔎 Đang tìm tài liệu liên quan…</div>';
}
function renderRecommendError(msg) {
  el('recommendBody').innerHTML = `<div class="rec-empty">⚠️ ${escapeHtml(msg)}</div>`;
}
function renderRecommendResults(topic, links) {
  el('recommendTopic').textContent = topic || '';
  if (!links || !links.length) {
    el('recommendBody').innerHTML = '<div class="rec-empty">Chưa có gợi ý trang tài liệu cho câu hỏi này.</div>';
    return;
  }
  const note = '<div class="rec-fallback-note">🔎 Bấm 1 trang bên dưới để mở link liên quan.</div>';
  el('recommendBody').innerHTML = note + links.map((l) => `
    <a class="rec-card" href="${escapeHtml(sanitizeUrl(l.url))}" target="_blank" rel="noopener noreferrer">
      <div class="rec-card-domain">${escapeHtml(l.domain || '')}</div>
      <div class="rec-card-title">${escapeHtml(l.title || l.url)}</div>
      ${l.note ? `<div class="rec-card-note">${escapeHtml(l.note)}</div>` : ''}
    </a>`).join('');
}
// Báo "có gợi ý mới" cho người dùng — CHỈ hiện dấu chấm nếu panel đang ĐÓNG (nếu panel đang mở sẵn,
// người dùng đã thấy nội dung vừa cập nhật ngay trong khung, không cần thêm dấu hiệu nào khác).
function markRecommendUpdated() {
  if (!el('recommendPanel').classList.contains('open')) el('recommendTopBtn').classList.add('has-badge');
}
// scheduleRecommend() giờ chạy NGẦM: KHÔNG gọi openRecommendPanel() nữa (xem comment đầu mục này) —
// chỉ cập nhật nội dung khung (dù đang ẩn hay hiện) rồi báo badge nếu panel đang đóng.
async function scheduleRecommend(query) {
  el('recommendTopic').textContent = query.length > 70 ? query.slice(0, 70) + '…' : query;
  renderRecommendLoading();
  if (recommendAbortController) recommendAbortController.abort();
  const controller = new AbortController();
  recommendAbortController = controller;
  try {
    const res = await fetch('/api/recommend', {
      method: 'POST', headers: apiHeaders(), body: JSON.stringify({ query }), signal: controller.signal
    });
    let data; try { data = await res.json(); } catch (e) { data = null; }
    if (controller.signal.aborted) return;
    if (!res.ok) { renderRecommendError((data && data.error) || 'Không tìm được tài liệu liên quan.'); markRecommendUpdated(); return; }
    renderRecommendResults(data.topic, data.links);
    markRecommendUpdated();
  } catch (e) {
    if (controller.signal.aborted || e.name === 'AbortError') return;
    renderRecommendError('Không thể kết nối máy chủ để tìm tài liệu liên quan.');
    markRecommendUpdated();
  }
}

loadAll();
// Đánh dấu app.js đã chạy hết tới đây (không bị ReferenceError chết giữa chừng) — cho phép
// handler window.onerror trong index.html biết KHÔNG cần hiện màn hình lỗi khởi động nữa.
window.__appBooted = true;
