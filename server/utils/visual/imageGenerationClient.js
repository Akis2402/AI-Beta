'use strict';

// ============================================================================================
// PHẦN 29 — API / PROVIDER SAFETY cho image generation
// ============================================================================================
// Image provider TÁCH HẲN khỏi text provider registry (aiProviders.js/executionTargets.js):
//   - không gửi API key sai provider
//   - không gửi text request sang image endpoint (và ngược lại)
//   - không gửi unsupported parameters
//   - lỗi của image API KHÔNG BAO GIỜ được phép làm hỏng text API (mọi lỗi ở đây đều trả về
//     {ok:false}, không throw ra ngoài pipeline chính — xem visualPipeline.js)
//
// Nếu không cấu hình provider ảnh nào -> isConfigured()=false -> router trả blocked='no_image_provider'
// renderer (PHẦN 19) hoặc bỏ hình. KHÔNG có provider ảnh KHÔNG PHẢI là lỗi.

const { createLinkedAbort, makeCancelledError } = require('../abortLink');

// ============================================================================================
// SDK CHÍNH CHỦ CHO GEMINI + OPENAI (thay REST thuần) — theo yêu cầu 09/2026.
// ============================================================================================
// CHỈ 2 provider này đổi sang SDK ('@google/genai' cho Gemini, 'openai' cho OpenAI). Grok/xAI và
// OpenRouter KHÔNG có SDK chính chủ cho ảnh (chúng dùng endpoint tương thích OpenAI) nên GIỮ NGUYÊN
// đường REST qua callOpenAICompatibleImage() — không có lý do kỹ thuật để đổi, và đổi sẽ chỉ tăng
// bề mặt lỗi không cần thiết (B9.5/mục IV của master prompt: không đổi chỉ vì "cho giống").
//
// require() ĐƯỢC GỌI TRỄ (bên trong hàm, bọc try/catch) — TUYỆT ĐỐI không require ở top-level:
//   - Nếu package chưa `npm install` (vd trong CI/sandbox không có mạng), module này vẫn phải
//     require() được bình thường — mọi provider KHÁC (Grok/OpenRouter/gemini-interactions) và toàn
//     bộ phần còn lại của app KHÔNG được phép sập theo chỉ vì thiếu 1 optional dependency.
//   - Khi thiếu SDK, provider tương ứng trả {ok:false, reason:'sdk_not_installed'} — RETRYABLE (đúng
//     nghĩa "lỗi kỹ thuật riêng của 1 provider", xem NON_RETRYABLE_REASONS bên dưới) -> failover sang
//     provider kế tiếp, không làm hỏng cả request.
function loadGeminiSdk() {
  try { return require('@google/genai'); } catch (e) { return null; }
}
function loadOpenAiSdk() {
  try {
    const mod = require('openai');
    return mod && mod.default ? mod.default : mod;
  } catch (e) { return null; }
}

/**
 * raceAbort() — reject ngay khi `signal` abort (timeout nội bộ HOẶC huỷ từ bên ngoài), BẤT KỂ SDK
 * của Google/OpenAI có thật sự lắng nghe AbortSignal truyền vào request options hay không. Đây là
 * lưới an toàn ĐỘC LẬP với việc SDK có hỗ trợ đúng chuẩn không — timeout/cancel LUÔN được tôn trọng.
 */
function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(Object.assign(new Error('aborted'), { aborted: true }));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('aborted'), { aborted: true }));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); }
    );
  });
}

/** Rút status HTTP từ lỗi SDK (cả @google/genai lẫn openai đều có thể đặt ở vị trí khác nhau tuỳ
 *  version) — khoan dung nhiều field thay vì tin đúng 1 tên field. */
function statusFromSdkError(e) {
  return (e && (e.status || e.statusCode || e.httpStatus || (e.response && e.response.status))) || 0;
}
/** Nhận diện lỗi bị chặn vì nội dung (safety/policy) từ exception của SDK — dùng chung logic đã có
 *  ở nhánh REST (content_blocked = KHÔNG retryable, mọi provider sẽ chặn y hệt). */
function isSdkContentBlockedError(e) {
  const msg = String((e && (e.code || e.type || e.message)) || '');
  return /safety|policy|content_polic|blocked|moderation/i.test(msg);
}
// MỤC 1/2 (đợt audit 2) — 1 NGUỒN SỰ THẬT DUY NHẤT cho việc "binary này có phải ảnh thật không".
// Trước đây verifyImageBytes() ở file này tự viết bảng magic-bytes RIÊNG và có 1 nhánh thoát hiểm
// tin claimedMime khi không nhận diện được chữ ký — nay xoá hẳn nhánh đó, dùng validator dùng
// chung với routes/visual.js (download/retry/hq) và live-image-check.js.
const { validateImageBase64, validateImageBuffer, detectSignatureFromBuffer } = require('./imageBinaryValidator');

// MỤC 3/8 (đợt audit 2) — Trần dung lượng khi TỰ TẢI url ảnh về để validate byte thật (không phải
// trần của route proxy /api/visual/download, đây là bước validate NGAY LÚC SINH ảnh).
const URL_VALIDATE_MAX_BYTES = 12 * 1024 * 1024;

// ============================================================================================
// MỤC 2.1 + 2.1a — REGISTRY PROVIDER ẢNH THEO CAPABILITY, KHÓA KẾ THỪA TỪ PROVIDER TEXT
// ============================================================================================
// ROOT CAUSE A (đã xác nhận): bản cũ chỉ đọc GEMINI_IMAGE_API_KEY/OPENAI_IMAGE_API_KEY và CỐ Ý
// không tái dùng khóa text. Ý định ban đầu ("tránh vô tình phát sinh chi phí ảnh") là hợp lý về
// mặt chi phí nhưng SAI về mặt sản phẩm: người dùng đã cắm GEMINI_API_KEY cho text, thấy hệ thống
// nói "cần hình minh họa", rồi nhận đúng một dòng "Không thể tạo hình minh họa" mà KHÔNG có bất kỳ
// gợi ý nào rằng họ phải khai báo thêm một biến môi trường thứ hai. isConfigured() trả false ->
// chooseVisualRenderer() không bao giờ chọn 'image_generation' -> cả hệ thống chỉ còn SVG.
//
// KIẾN TRÚC MỚI:
//   - Mỗi provider ảnh là MỘT PHẦN TỬ trong IMAGE_PROVIDER_DEFS (giữ đúng nguyên tắc B9.5: thêm
//     provider thứ N chỉ cần thêm 1 phần tử, không đẻ nhánh if/else).
//   - Khóa được phân giải theo thứ tự: <PROVIDER>_IMAGE_API_KEY (override riêng cho ảnh) ->
//     khóa TEXT của chính provider đó. Không cần khai báo thêm biến nào nếu khóa text đã đủ quyền.
//   - Thứ tự thử KẾ THỪA thứ tự ưu tiên của provider TEXT, để hành vi rotation của ảnh nhất quán
//     với text. Có thể override bằng IMAGE_PROVIDER_ORDER.
//   - CHỈ provider THẬT SỰ có API sinh ảnh công khai mới được đưa vào registry. Anthropic/DeepSeek/
//     Mistral/Groq hiện KHÔNG có endpoint text-to-image — tuyệt đối không ép chúng vào danh sách chỉ
//     vì chúng có khóa text, vì như vậy là gọi vào endpoint không tồn tại và tiêu một lượt failover
//     vô ích.
//
// ĐỌC ENV TẠI THỜI ĐIỂM GỌI, không cache vào const lúc require: test và môi trường serverless đều
// có thể đổi process.env sau khi module đã được nạp (bản cũ cache nên không test được).

const IMAGE_TIMEOUT_MS = Number(process.env.IMAGE_GENERATION_TIMEOUT_MS) || 20000;

const { rememberInteraction, getInteraction, getLatestInteraction } = require('./imageInteractionStore');

/** Khóa text có thể là danh sách nhiều khóa ngăn cách bằng dấu phẩy (xem parseMultiEnv). Lấy khóa đầu. */
function firstKeyOf(raw) {
  return String(raw || '').split(',').map((k) => k.trim()).filter(Boolean)[0] || '';
}

/**
 * Phân giải khóa cho một provider ảnh.
 * @returns {{key:string, source:'image_specific'|'text_reuse'|null}}
 */
function resolveImageKey(def) {
  if (def.name === 'gemini-image') {
    const interKey = firstKeyOf(process.env.GEMINI_INTERACTIONS_IMAGE_API_KEY);
    if (interKey) return { key: interKey, source: 'image_specific' };
  }
  const own = firstKeyOf(process.env[def.imageKeyEnv]);
  if (own) return { key: own, source: 'image_specific' };
  for (const env of def.textKeyEnvs || []) {
    const shared = firstKeyOf(process.env[env]);
    if (shared) return { key: shared, source: 'text_reuse' };
  }
  return { key: '', source: null };
}

// ---------- REGISTRY ----------
// `order` = vị trí trong thứ tự ưu tiên provider TEXT của repo (xem server/config/extraProviders.js
// và server/utils/executionTargets.js): Gemini và OpenAI là provider gốc, Grok/xAI và OpenRouter
// đến từ EXTRA_PROVIDERS theo đúng thứ tự khai báo ở đó.
const IMAGE_PROVIDER_DEFS = [
  {
    name: 'gemini-image', order: 10,
    imageKeyEnv: 'GEMINI_IMAGE_API_KEY', textKeyEnvs: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    modelEnv: 'GEMINI_IMAGE_MODEL', defaultModel: 'gemini-3.1-flash-image',
    maxPromptTokens: 2000, costClass: 'IMAGE_COST_LOW', qualityClass: 'standard', latencyClass: 'fast',
    call: (opts) => callGeminiImage(opts)
  },
  {
    name: 'gemini-interactions-image', order: 12,
    imageKeyEnv: 'GEMINI_INTERACTIONS_IMAGE_API_KEY', textKeyEnvs: [],
    modelEnv: 'GEMINI_INTERACTIONS_IMAGE_MODEL', defaultModel: 'gemini-3.1-flash-image',
    maxPromptTokens: 2000, costClass: 'IMAGE_COST_LOW', qualityClass: 'standard', latencyClass: 'fast',
    call: (opts) => callGeminiInteractionsImage(opts)
  },
  {
    // MỤC (đợt audit 4) — `quality:'high'` chỉ hợp lệ cho họ model GPT-Image (gpt-image-1/1-mini/
    // 1.5/2/2.5-*), KHÔNG hợp lệ cho dall-e-2 (dall-e-2 không nhận tham số này). Vì OPENAI_IMAGE_MODEL
    // mặc định trỏ vào 1 model GPT-Image, extraBody an toàn theo mặc định; nếu người vận hành tự đổi
    // sang 'dall-e-2' qua .env, dùng DALLE2_MODEL_RE bên dưới để KHÔNG gửi field lạ vào request.
    name: 'openai-image', order: 20,
    imageKeyEnv: 'OPENAI_IMAGE_API_KEY', textKeyEnvs: ['OPENAI_API_KEY'],
    modelEnv: 'OPENAI_IMAGE_MODEL', defaultModel: 'gpt-image-1',
    maxPromptTokens: 4000, costClass: 'IMAGE_COST_HIGH', qualityClass: 'high', latencyClass: 'slow',
    extraBody: (model) => (/^dall-e-2$/i.test(model) ? {} : { quality: 'high' }),
    call: (opts) => callOpenAIImage(opts)
  },
  {
    // xAI phục vụ sinh ảnh qua endpoint TƯƠNG THÍCH OpenAI (/v1/images/generations) nên dùng chung
    // adapter — không nhân bản code parse cho từng hãng.
    // MỤC (đợt audit 5, 09/2026) — ROOT CAUSE MỚI, CÙNG DẠNG LỖI CŨ: 'grok-imagine-image-quality'
    // (đặt làm mặc định ở đợt audit 4, dựa trên tài liệu 05/2026) đã bị xAI THAY THẾ bằng
    // 'grok-imagine-image-2.0' — dòng "Grok Imagine Image 2.0" ra mắt 07/08/2026, xác nhận qua tài
    // liệu chính thức docs.x.ai (mục Image Generation) hiện hành. Đây CHÍNH XÁC là kiểu lỗi đã ghi ở
    // đợt audit 4: tên model cũ bị hãng ngừng phục vụ -> request trả 4xx "model not found" -> ảnh
    // KHÔNG BAO GIỜ ra được dù khóa API hợp lệ 100%, bất kể failover có chạy đúng hay không (lỗi nằm
    // ở CHÍNH tên model gửi đi, không phải ở cơ chế thử/failover). Cùng key text, cùng endpoint
    // OpenAI-compatible, chỉ đổi tên model. Vẫn có thể ghi đè qua GROK_IMAGE_MODEL nếu hãng đổi tên
    // tiếp (đây là lý do vì sao model KHÔNG được hard-code sâu hơn 1 chỗ — xem B9.5).
    name: 'grok-image', order: 30,
    imageKeyEnv: 'GROK_IMAGE_API_KEY', textKeyEnvs: ['GROK_API_KEY', 'XAI_API_KEY'],
    modelEnv: 'GROK_IMAGE_MODEL', defaultModel: 'grok-imagine-image-2.0',
    maxPromptTokens: 2000, costClass: 'IMAGE_COST_MEDIUM', qualityClass: 'high', latencyClass: 'fast',
    call: (opts) => callOpenAICompatibleImage(opts, 'https://api.x.ai/v1/images/generations')
  },
  {
    // OpenRouter chỉ PROXY tới model của hãng khác: không có model ảnh mặc định nào đúng cho mọi tài
    // khoản. Vì vậy provider này CHỈ được bật khi người vận hành chỉ định tường minh model ảnh —
    // `requiresExplicitModel`. Bật mù sẽ gửi request tới một model không tồn tại và đốt một lượt
    // failover.
    name: 'openrouter-image', order: 40, requiresExplicitModel: true,
    imageKeyEnv: 'OPENROUTER_IMAGE_API_KEY', textKeyEnvs: ['OPENROUTER_API_KEY'],
    modelEnv: 'OPENROUTER_IMAGE_MODEL', defaultModel: '',
    maxPromptTokens: 4000, costClass: 'IMAGE_COST_MEDIUM', qualityClass: 'standard', latencyClass: 'slow',
    call: (opts) => callOpenAICompatibleImage(opts, 'https://openrouter.ai/api/v1/images/generations')
  }
];

/** Thứ tự thử ảnh. Mặc định kế thừa thứ tự provider text; IMAGE_PROVIDER_ORDER ghi đè nếu cần. */
function providerOrderOverride() {
  return String(process.env.IMAGE_PROVIDER_ORDER || '')
    .split(',').map((x) => x.trim()).filter(Boolean);
}

function isConfigured() {
  return listImageProviders().length > 0;
}

/** Tên provider ảnh sẽ được thử ĐẦU TIÊN. CHỈ trả về TÊN — không bao giờ lộ khóa (mục 2.8). */
function activeProviderName() {
  const list = listImageProviders();
  return list.length ? list[0].name : null;
}

// ============================================================================================
// A4 — FAILOVER GIỮA CÁC IMAGE PROVIDER (ĐÚNG 1 LẦN, KHÔNG LOOP)
// ============================================================================================
// BUG CŨ: `GEMINI_IMAGE_KEY ? callGeminiImage(...) : callOpenAIImage(...)` — cấu hình CẢ HAI khóa
// thì chỉ Gemini được thử; Gemini lỗi 5xx là bỏ luôn, không đụng tới OpenAI dù khóa đã sẵn. Không
// nhất quán với triết lý failover đã có cho text provider (aiProviders.js).
//
// NAY: danh sách provider có CAPABILITY (B9.5 — thêm provider thứ 3 chỉ cần thêm 1 phần tử, không
// đẻ thêm nhánh if/else), thử theo thứ tự ưu tiên, và CHỈ thử provider kế tiếp khi lỗi thuộc nhóm
// RETRYABLE. Tổng số lệnh gọi luôn <= số provider đã cấu hình, KHÔNG có vòng lặp ẩn nào (SECTION D).

// Phân biệt 2 LOẠI lỗi khác bản chất:
// (a) Lỗi NỘI DUNG prompt (content) — dùng CHUNG cho mọi provider vì prompt giống nhau, provider
//     nào cũng sẽ chặn/huỷ y hệt -> KHÔNG đáng thử tiếp, chỉ tốn thêm 1 lệnh gọi vô ích.
// (b) Lỗi CẤU HÌNH/KỸ THUẬT của RIÊNG 1 provider (auth sai, model ID sai, schema request sai,
//     JSON trả về dị dạng...) — KHÔNG dùng chung: mỗi provider có key/model/endpoint/cơ chế xác
//     thực khác nhau, lỗi ở Gemini không nói lên gì về OpenAI -> LUÔN đáng thử provider kế tiếp.
// BUG CŨ (đã sửa): coi mọi 4xx (trừ 429) là "lỗi input dùng chung" — SAI, vì phần lớn 4xx thực tế
// (400 sai tên model, 401/403 quyền/billing/region, 404 sai endpoint) là lỗi (b), riêng của 1
// provider. Vì vậy nay dùng DENYLIST: chỉ liệt kê đúng 2 case (a)/"không nên tiếp tục" là KHÔNG
// retryable; MỌI lý do khác đều retryable.
const NON_RETRYABLE_REASONS = new Set([
  'content_blocked', // (a) lỗi nội dung dùng chung — provider nào cũng chặn y hệt
  'cancelled'         // người dùng huỷ / hết hạn mức thời gian — không nên tiếp tục gọi thêm
]);
function isRetryableReason(reason) {
  if (!reason) return false;
  return !NON_RETRYABLE_REASONS.has(reason);
}
// ============================================================================================
// QUYẾT ĐỊNH CÓ CHỦ Ý — KHÔNG retry CÙNG 1 provider trước khi failover (đợt audit 4)
// ============================================================================================
// Đã CÂN NHẮC thêm "thử lại chính provider đó 1 lần" cho các lỗi tạm thời (5xx/429/JSON dị dạng/
// model trả text thay vì ảnh) trước khi chuyển provider khác — nhưng đây là VI PHẠM TRỰC TIẾP bất
// biến đã viết ở đầu file "Tổng số lệnh gọi luôn <= số provider đã cấu hình, KHÔNG có vòng lặp ẩn
// nào" (SECTION D) và làm HỎNG bộ test failover hiện có (`image-provider-failover.test.js` khẳng
// định CHÍNH XÁC 1 lệnh gọi/provider cho mọi lý do retryable, kể cả 'notext'/5xx). Bất biến đó tồn
// tại có chủ đích: trần chi phí + độ trễ DỰ ĐOÁN ĐƯỢC (đúng bằng số provider đã cấu hình, không phụ
// thuộc số retry ẩn) — quan trọng trên nền tảng serverless có deadline cứng. "Luôn generate ra được"
// nên đạt bằng CÁCH KHÁC không phá bất biến này: (1) failover sang provider KHÁC ngay lập tức khi
// lỗi retryable (đã có sẵn — mỗi provider vẫn được thử ĐÚNG 1 LẦN), (2) sửa đúng ROOT CAUSE khiến
// một provider luôn thất bại (model ID lỗi thời — xem 'grok-image' bên dưới), (3) tăng chất lượng
// prompt/tham số ảnh (xem IMAGE_QUALITY_BOOST ở visualSpecBuilder.js, và `quality` ở registry dưới)
// để GIẢM tỉ lệ bị model từ chối/trả sai ngay từ lượt gọi đầu tiên, thay vì bù bằng gọi lại.

// B9.15 — IMAGE COST POLICY. Deterministic renderer không đi qua file này nên luôn LOW (0 cost API).
const IMAGE_COST = { LOW: 'IMAGE_COST_LOW', MEDIUM: 'IMAGE_COST_MEDIUM', HIGH: 'IMAGE_COST_HIGH' };
/**
 * classifyImageCost() — phân loại chi phí 1 lệnh gọi image API theo provider + kích thước yêu cầu.
 * @param {{provider?:string, size?:string, renderer?:string}} opts
 * @returns {'IMAGE_COST_LOW'|'IMAGE_COST_MEDIUM'|'IMAGE_COST_HIGH'}
 */
function classifyImageCost({ provider, size = '1024x1024', renderer } = {}) {
  if (renderer && renderer !== 'image_generation') return IMAGE_COST.LOW; // không gọi API ảnh = 0 chi phí
  const pixels = (() => {
    const m = /^(\d+)x(\d+)$/.exec(String(size || ''));
    return m ? Number(m[1]) * Number(m[2]) : 1024 * 1024;
  })();
  if (provider === 'gemini-image') return pixels > 1024 * 1024 ? IMAGE_COST.MEDIUM : IMAGE_COST.LOW;
  return pixels >= 1024 * 1024 ? IMAGE_COST.HIGH : IMAGE_COST.MEDIUM;
}

// ============================================================================================
// MỤC (đợt audit 6) — QUALITY MODES + ASPECT-RATIO → SIZE THẬT (mục X/XI yêu cầu audit).
// ============================================================================================
// FAST/STANDARD/HIGH/ULTRA quyết định CẠNH DÀI của ảnh (không phải chỉ 1 hằng số 1024/512 như bản
// cũ). USER_REQUESTED mặc định STANDARD (không phải ULTRA — mục X: "không dùng 4K mặc định vì tốn
// tiền và chậm"); `degrade==='low'` (ngân sách thời gian cạn) hạ xuống FAST bất kể quality gốc.
const IMAGE_QUALITY_LONG_EDGE = { fast: 512, standard: 1024, high: 1536, ultra: 2048 };
function resolveQualityMode(requested, degrade) {
  if (degrade === 'low') return 'fast';
  const q = String(requested || 'standard').toLowerCase();
  return IMAGE_QUALITY_LONG_EDGE[q] ? q : 'standard';
}
const ASPECT_WH_RATIO = {
  '1:1': [1, 1], '16:9': [16, 9], '9:16': [9, 16], '4:3': [4, 3], '3:4': [3, 4], '3:2': [3, 2], '2:3': [2, 3]
};
/**
 * sizeForRequest() — cạnh dài theo quality mode, cạnh ngắn theo aspect ratio thật (làm tròn bội 64
 * vì hầu hết model image yêu cầu kích thước chia hết cho 1 số nhỏ).
 * @returns {{size:string, aspectRatio:string, quality:string}} size dạng "WxH".
 */
function sizeForRequest({ aspectRatio = '1:1', quality = 'standard', degrade } = {}) {
  const q = resolveQualityMode(quality, degrade);
  const longEdge = IMAGE_QUALITY_LONG_EDGE[q];
  const [rw, rh] = ASPECT_WH_RATIO[aspectRatio] || ASPECT_WH_RATIO['1:1'];
  const round64 = (n) => Math.max(64, Math.round(n / 64) * 64);
  let w, h;
  if (rw >= rh) { w = longEdge; h = round64(longEdge * (rh / rw)); }
  else { h = longEdge; w = round64(longEdge * (rw / rh)); }
  return { size: `${w}x${h}`, aspectRatio, quality: q };
}
/** openaiSizeFor() — gpt-image-1 CHỈ chấp nhận 3 giá trị cố định; ánh xạ theo hướng gần đúng nhất
 *  (không gửi WxH tuỳ ý, provider sẽ trả lỗi tham số). */
function openaiSizeFor(aspectRatio) {
  const [rw, rh] = ASPECT_WH_RATIO[aspectRatio] || ASPECT_WH_RATIO['1:1'];
  if (rw === rh) return '1024x1024';
  return rw > rh ? '1536x1024' : '1024x1536';
}
/** geminiImageSizeLabel() — nhãn image_size mà Interactions API hiểu ('512'|'1K'|'2K'|'4K'). */
function geminiImageSizeLabel(quality) {
  return { fast: '512', standard: '1K', high: '2K', ultra: '4K' }[quality] || '1K';
}

// ============================================================================================
// MỤC XXII (đợt audit 6) — SELF-HEALING PROVIDER: circuit breaker riêng cho image provider.
// ============================================================================================
// ROOT CAUSE: listImageProviders() TRƯỚC ĐÂY luôn thử theo đúng 1 thứ tự `order` cố định — nếu
// provider ưu tiên #1 đang lỗi liên tục (model bị rút, hết quota...), MỌI request vẫn tốn 1 lượt
// gọi thất bại vào nó trước khi failover, tăng latency và phí gọi API vô ích. Nay: 3 lần fail LIÊN
// TIẾP -> hạ ưu tiên tạm thời (đẩy xuống cuối danh sách thử) trong COOLDOWN_MS; hết cooldown thì
// trở lại vị trí gốc. State giữ TRONG TIẾN TRÌNH (module-level Map, không cần store ngoài) — đúng
// mức cần thiết cho 1 serverless instance; khác instance có bảng riêng, tự phục hồi độc lập, không
// cần đồng bộ chéo (không giống rotationManager của text vốn cần fairness liên-instance).
const CIRCUIT_FAIL_THRESHOLD = Number(process.env.IMAGE_CIRCUIT_FAIL_THRESHOLD) || 3;
const CIRCUIT_COOLDOWN_MS = Number(process.env.IMAGE_CIRCUIT_COOLDOWN_MS) || 5 * 60 * 1000;
const circuitState = new Map(); // providerName -> {consecutiveFailures, downUntil, lastFailure, lastSuccess}

function getCircuit(name) {
  if (!circuitState.has(name)) circuitState.set(name, { consecutiveFailures: 0, downUntil: 0, lastFailure: 0, lastSuccess: 0 });
  return circuitState.get(name);
}
/** recordProviderResult() — cập nhật circuit SAU mỗi lệnh gọi thật (không gọi cho lệnh bị skip). */
function recordProviderResult(name, ok) {
  const c = getCircuit(name);
  if (ok) { c.consecutiveFailures = 0; c.downUntil = 0; c.lastSuccess = Date.now(); return; }
  c.consecutiveFailures += 1;
  c.lastFailure = Date.now();
  if (c.consecutiveFailures >= CIRCUIT_FAIL_THRESHOLD) c.downUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
}
/** isCircuitOpen() — true nghĩa là provider đang trong cooldown, nên hạ ưu tiên (KHÔNG loại hẳn —
 *  nếu mọi provider khác cũng down, vẫn phải còn cơ hội thử lại provider này). */
function isCircuitOpen(name) {
  const c = circuitState.get(name);
  return !!(c && c.downUntil && c.downUntil > Date.now());
}
/** circuitSnapshot() — dùng cho /api/visual/status (mục XXIII), KHÔNG lộ gì nhạy cảm. */
function circuitSnapshot() {
  const out = {};
  for (const [name, c] of circuitState.entries()) {
    out[name] = {
      state: isCircuitOpen(name) ? 'open' : 'closed',
      consecutiveFailures: c.consecutiveFailures,
      downUntil: c.downUntil || null,
      lastFailure: c.lastFailure || null,
      lastSuccess: c.lastSuccess || null
    };
  }
  return out;
}

/**
 * listImageProviders() — provider ảnh KHẢ DỤNG, đã sắp theo thứ tự ưu tiên.
 * Một provider chỉ vào danh sách khi: (a) phân giải được khóa, và (b) xác định được model.
 * @returns {Array<object>}
 */
function listImageProviders() {
  // Công tắc TẮT HẲN: cần thiết vì khóa ảnh nay kế thừa khóa text, nên người vận hành phải có một
  // cách tường minh để nói "tôi có khóa text nhưng KHÔNG muốn tiêu tiền sinh ảnh".
  if (/^(0|false|off|no)$/i.test(String(process.env.IMAGE_GENERATION_ENABLED || '').trim())) return [];
  const override = providerOrderOverride();
  const out = [];
  for (const def of IMAGE_PROVIDER_DEFS) {
    const { key, source } = resolveImageKey(def);
    if (!key) continue;
    const model = String(process.env[def.modelEnv] || def.defaultModel || '').trim();
    if (!model) continue; // vd OpenRouter chưa chỉ định model ảnh -> không bật (requiresExplicitModel)
    out.push({
      name: def.name,
      model,
      apiKey: key,            // DÙNG NỘI BỘ. Không bao giờ đi vào log/telemetry/response (mục 2.8).
      keySource: source,      // 'image_specific' | 'text_reuse' — chỉ để quan sát, không chứa khóa.
      supportsTextToImage: true,
      maxPromptTokens: def.maxPromptTokens,
      costClass: def.costClass,
      qualityClass: def.qualityClass,
      latencyClass: def.latencyClass,
      order: def.order,
      // extraBody: field bổ sung AN TOÀN THEO TỪNG PROVIDER (vd quality:'high' cho GPT-Image) — chỉ
      // def nào khai báo mới có, giữ nguyên hành vi provider khác (mục "thêm provider không sửa code
      // provider cũ" — B9.5).
      call: (opts) => def.call({
        ...opts, apiKey: key, model,
        extraBody: typeof def.extraBody === 'function' ? def.extraBody(model) : (def.extraBody || null)
      })
    });
  }
  if (override.length) {
    // Thứ tự do người vận hành chỉ định thắng; provider không được nêu tên vẫn giữ ở cuối theo
    // thứ tự kế thừa từ text (không âm thầm loại bỏ provider đã cấu hình).
    out.sort((a, b) => {
      const ia = override.indexOf(a.name);
      const ib = override.indexOf(b.name);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      return a.order - b.order;
    });
  } else {
    out.sort((a, b) => a.order - b.order);
  }
  return out;
}

/**
 * activePromptCharLimit() — MỤC 2.1: hạn mức ký tự CỨNG của provider sẽ được thử ĐẦU TIÊN.
 * Lấy mức chặt nhất trong các provider đã cấu hình để prompt luôn hợp lệ kể cả khi failover sang
 * provider thứ 2 (không dựng lại prompt giữa chừng).
 * @returns {number} 0 khi chưa cấu hình provider nào.
 */
function activePromptCharLimit() {
  const providers = listImageProviders();
  if (!providers.length) return 0;
  return providers.reduce((min, p) => Math.min(min, Number(p.maxPromptTokens) || Infinity), Infinity);
}

/**
 * generateImage() — sinh 1 ảnh từ prompt ĐÃ ĐƯỢC DỰNG TỪ SPEC (PHẦN 17: prompt tối thiểu).
 * KHÔNG BAO GIỜ throw: mọi lỗi trả về {ok:false, reason} để caller giữ nguyên text answer.
 *
 * @param {{prompt:string, timeoutMs?:number, signal?:AbortSignal, size?:string}} opts
 * @returns {Promise<{ok:boolean, format?:'data_url', url?:string, model?:string, reason?:string,
 *   latencyMs:number, promptChars:number}>}
 */
async function generateImage({ prompt, timeoutMs = IMAGE_TIMEOUT_MS, signal, size = '1024x1024', aspectRatio = '1:1', quality = 'standard', deadlineAt }) {
  if (String(process.env.PUTER_VISUAL_MODE || '').toLowerCase() === 'client_primary') {
    throw new Error('server_image_generation_forbidden_in_client_primary');
  }
  const startedAt = Date.now();
  const base = { latencyMs: 0, promptChars: String(prompt || '').length, providersTried: [] };
  if (!prompt || prompt.length < 10) return { ...base, ok: false, reason: 'empty_prompt', latencyMs: 0 };
  if (!isConfigured()) return { ...base, ok: false, reason: 'no_image_provider', latencyMs: 0 };

  const providers = listImageProviders();
  const providersTried = [];
  let last = { ok: false, reason: 'no_image_provider' };

  // MỤC 35 — CHI PHÍ PHẢI ĐOÁN TRƯỚC ĐƯỢC: tổng số lệnh gọi API ảnh của MỘT lượt generateImage()
  // bị chặn cứng, không phụ thuộc vào việc cấu hình có bao nhiêu provider. Trước đây vòng lặp chạy
  // hết `providers.length` — thêm provider thứ 6 vào .env là âm thầm nhân 6 chi phí xấu nhất của
  // mỗi lần tạo hình. Vòng đời (lifecycle) vẫn là 1; đây là trần cho SỐ LỆNH GỌI, hai thứ khác nhau.
  const maxAttempts = Math.max(1, Number(process.env.IMAGE_MAX_PROVIDER_ATTEMPTS) || providers.length);

  for (let i = 0; i < providers.length; i++) {
    if (providersTried.length >= maxAttempts) {
      last = { ok: false, reason: last.reason && last.reason !== 'no_image_provider' ? last.reason : 'provider_attempt_cap' };
      break;
    }
    const p = providers[i];
    if (signal && signal.aborted) { last = { ok: false, reason: 'cancelled' }; break; }
    // Còn đủ thời gian trong deadline còn lại mới được thử provider kế tiếp (A4.1).
    const remaining = Number.isFinite(deadlineAt) ? deadlineAt - Date.now() : timeoutMs;
    if (i > 0 && remaining < 1500) { last = { ...last, reason: last.reason || 'visual_deadline' }; break; }
    const callTimeout = Math.max(1000, Math.min(timeoutMs, Number.isFinite(deadlineAt) ? remaining : timeoutMs));

    providersTried.push(p.name);
    try {
      last = await p.call({ prompt, timeoutMs: callTimeout, signal, size, aspectRatio, quality });
    } catch (e) {
      // Kể cả huỷ (abort) cũng KHÔNG throw lên trên — text answer không được phụ thuộc vào ảnh.
      last = { ok: false, reason: (e && e.cancelled) ? 'cancelled' : 'provider_error' };
    }
    // MỤC XXII: cancelled không tính là lỗi PROVIDER (người dùng/hệ thống huỷ, không phải provider
    // hỏng) -> không đốt vào circuit breaker của provider đó.
    if (last.reason !== 'cancelled') recordProviderResult(p.name, last.ok);
    if (last.ok) {
      return {
        ...base, ...last, providersTried,
        costClass: classifyImageCost({ provider: p.name, size }),
        latencyMs: Date.now() - startedAt
      };
    }
    // Lỗi input hoặc người dùng huỷ -> KHÔNG thử provider khác (A4.1: chỉ RETRYABLE mới failover).
    if (!isRetryableReason(last.reason)) break;
  }

  return { ...base, ...last, ok: false, providersTried, latencyMs: Date.now() - startedAt };
}

// ============================================================================================
// RỦI RO #1 — CHƯA KIỂM CHỨNG VỚI IMAGE PROVIDER THẬT: GIẢM THIỂU BẰNG PARSER KHOAN DUNG
// ============================================================================================
// Chưa có khóa ảnh thật để chạy end-to-end, nên điều DUY NHẤT kiểm soát được là: parser không được
// GIÒN. Mọi biến thể shape đã tài liệu hoá (và các biến thể đặt tên thường gặp giữa các version
// v1beta/v1, camelCase/snake_case) đều được chấp nhận; mọi shape LẠ đều rơi êm về
// 'no_image_in_response' (RETRYABLE -> thử provider còn lại -> hết provider là trạng thái failed),
// KHÔNG BAO GIỜ throw, không bao giờ coi "có response" là thành công (B9.8).
//
// Khi có khóa thật, chạy `npm run live-image-check` để đối chiếu shape thực tế với parser này.

/**
 * ROOT CAUSE (mục 34/25) — VALIDATE MIME + MAGIC BYTES.
 * Không được tin field `mimeType` mù quáng: nếu provider (hoặc 1 shape lạ chưa tài liệu hoá) nhét
 * text/JSON/HTML vào field đáng lẽ chứa ảnh mà field mime bị thiếu, hệ thống cũ sẽ MẶC ĐỊNH
 * 'image/png' rồi coi là thành công. Nay: (a) nếu CÓ mime, nó phải bắt đầu bằng 'image/'; (b) luôn
 * đối chiếu vài byte đầu (đã decode) với signature nhị phân thật của PNG/JPEG/WEBP/GIF — đây là
 * bằng chứng không thể giả mạo bằng cách gắn nhãn mime sai.
 */
/**
 * detectImageSignature() — GIỮ TÊN CŨ cho mọi call-site hiện có, nay chỉ là lớp mỏng gọi
 * imageBinaryValidator (1 nguồn sự thật duy nhất, xem file đó).
 * @param {string} b64
 * @returns {string|null} mime THỰC TẾ suy ra từ byte, hoặc null nếu không khớp signature nào.
 */
function detectImageSignature(b64) {
  try {
    const head = Buffer.from(String(b64 || '').slice(0, 32), 'base64');
    const sig = detectSignatureFromBuffer(head);
    return sig ? sig.mime : null;
  } catch (e) {
    return null;
  }
}

/**
 * Kiểm chứng b64 CÓ THẬT SỰ LÀ ẢNH không, bất kể provider gắn nhãn mime là gì.
 *
 * ROOT CAUSE ĐÃ SỬA (đợt audit 2): bản cũ có nhánh thoát hiểm PASS khi không nhận diện được chữ ký
 * nhưng claimedMime bắt đầu bằng 'image/'. Đây là lỗ hổng: claimedMime chỉ là NHÃN provider tự
 * khai, không phải bằng chứng. Nay: KHÔNG nhận diện được chữ ký nhị phân thật -> LUÔN trả null
 * (FAIL), bất kể claimedMime nói gì. Không còn ngoại lệ nào.
 *
 * @returns {string|null} mime đáng tin (LUÔN là chữ ký byte thật, không bao giờ là nhãn provider
 *   tự khai), null nếu không xác định được binary là ảnh thật.
 */
function verifyImageBytes(b64, claimedMime) {
  const r = validateImageBase64(b64, claimedMime);
  return r.valid ? r.detectedMime : null;
}

/** Trích base64 + mime từ MỌI biến thể inline-data của Gemini đã biết. */
function extractGeminiInline(data) {
  const candidates = Array.isArray(data && data.candidates) ? data.candidates : [];
  for (const cand of candidates) {
    const content = cand && (cand.content || cand.Content);
    const parts = (content && (content.parts || content.Parts)) || [];
    for (const part of parts) {
      const inline = part && (part.inlineData || part.inline_data);
      const b64 = inline && (inline.data || inline.bytesBase64Encoded);
      if (!b64) continue;
      const claimed = inline.mimeType || inline.mime_type || null;
      const verifiedMime = verifyImageBytes(b64, claimed);
      if (!verifiedMime) continue; // field tồn tại nhưng KHÔNG PHẢI ảnh thật -> bỏ qua, thử part khác.
      return { b64, mime: verifiedMime };
    }
  }
  // Một số bản trả thẳng ở cấp gốc (predictions[] của Vertex-style endpoint).
  const preds = Array.isArray(data && data.predictions) ? data.predictions : [];
  for (const pr of preds) {
    const b64 = pr && (pr.bytesBase64Encoded || pr.b64_json);
    if (!b64) continue;
    const verifiedMime = verifyImageBytes(b64, pr.mimeType || null);
    if (!verifiedMime) continue;
    return { b64, mime: verifiedMime };
  }
  return null;
}

/** Lý do model TỪ CHỐI (safety/recitation) — KHÔNG retryable, thử provider khác cũng bị chặn y hệt. */
function geminiBlockReason(data) {
  const fb = data && (data.promptFeedback || data.prompt_feedback);
  const blocked = fb && (fb.blockReason || fb.block_reason);
  if (blocked) return 'content_blocked';
  const finish = (((data && data.candidates) || [])[0] || {}).finishReason;
  if (finish && /SAFETY|RECITATION|BLOCK|PROHIBITED/i.test(String(finish))) return 'content_blocked';
  return null;
}

/**
 * callGeminiImage() — SDK chính chủ '@google/genai' (thay REST thuần trước đây).
 *
 * ROOT CAUSE giữ nguyên như bản REST cũ (mục 34): model image-preview của Gemini
 * (gemini-2.5-flash-image và họ *-image-generation) ĐÒI HỎI `responseModalities` tường minh trong
 * config, thiếu trường này model có xu hướng trả TEXT (từ chối/giải thích) thay vì sinh ảnh. SDK
 * dùng ĐÚNG payload đó qua tham số `config` của `ai.models.generateContent()` — không đổi ý định
 * kiến trúc, chỉ đổi phương tiện gửi request (SDK tự lo header/auth/serialize thay vì tự tay
 * fetch()). Luôn xin CẢ 'TEXT' lẫn 'IMAGE' vì một số version model bắt buộc phải có TEXT trong
 * danh sách modality (parser extractGeminiInline() đã bỏ qua phần TEXT nên không ảnh hưởng output).
 *
 * Response object của SDK giữ NGUYÊN shape camelCase `candidates[].content.parts[].inlineData` như
 * JSON REST gốc (SDK chỉ là lớp mỏng auth+serialize, không đổi contract dữ liệu) — nên tái dùng được
 * y nguyên extractGeminiInline()/geminiBlockReason() đã viết cho nhánh REST, không cần viết lại
 * parser riêng cho SDK (1 nguồn sự thật duy nhất cho việc đọc response Gemini).
 */
async function callGeminiImage({ prompt, timeoutMs, signal, apiKey, model, aspectRatio }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const linked = createLinkedAbort(timeoutMs, signal);
  try {
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        ...(aspectRatio ? { imageConfig: { aspectRatio } } : {})
      }
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: linked.signal
    });
    let data;
    try { data = await res.json(); } catch (e) {
      if (!res.ok) return { ok: false, reason: 'http_' + res.status };
      return { ok: false, reason: 'malformed_response' };
    }
    if (!res.ok) {
      const blocked = data && geminiBlockReason(data);
      if (blocked) return { ok: false, reason: blocked };
      return { ok: false, reason: 'http_' + res.status };
    }
    if (!data) return { ok: false, reason: 'malformed_response' };
    const blocked = geminiBlockReason(data);
    if (blocked) return { ok: false, reason: blocked };
    const inline = extractGeminiInline(data);
    if (!inline || !isLikelyBase64(inline.b64)) return { ok: false, reason: 'no_image_in_response' };
    return { ok: true, format: 'data_url', url: `data:${inline.mime};base64,${inline.b64}`, model };
  } catch (e) {
    if (e && (e.aborted || e.name === 'AbortError')) return { ok: false, reason: 'provider_timeout' };
    return { ok: false, reason: 'provider_error' };
  } finally {
    linked.cleanup();
  }
}

// ============================================================================================
// gemini-interactions-image — REST thuần vào Interactions API (POST /v1beta/interactions).
// ============================================================================================
// Response THẬT (đã xác nhận qua doc chính thức 09/2026) là 1 timeline `steps[]`, KHÔNG phải
// `candidates[]` như generateContent: mỗi step có `type` ('model_output'/'thought'/...) và
// `content[]` gồm các block {type:'text', text} hoặc {type:'image', data, mime_type}. Ảnh cuối
// cùng nằm ở step type='model_output'. Parser dưới đây CHỈ đọc đúng shape này — KHÔNG tái dùng
// extractGeminiInline() (dành cho generateContent, đọc candidates[].content.parts[].inlineData —
// field khác tên, cấu trúc khác lồng).
// Vẫn giữ đúng bất biến chung của file: verify byte ảnh thật (verifyImageBytes), không tin nhãn
// mime provider tự khai, KHÔNG BAO GIỜ coi "có response" là thành công.
function extractInteractionsImage(data) {
  const steps = Array.isArray(data && data.steps) ? data.steps : [];
  for (const step of steps) {
    if (!step || step.type !== 'model_output') continue;
    const blocks = Array.isArray(step.content) ? step.content : [];
    for (const block of blocks) {
      if (!block || block.type !== 'image') continue;
      const b64 = block.data;
      if (!b64 || !isLikelyBase64(b64)) continue;
      const verifiedMime = verifyImageBytes(b64, block.mime_type || block.mimeType || null);
      if (!verifiedMime) continue; // block tồn tại nhưng không phải ảnh thật -> thử block khác.
      return { b64, mime: verifiedMime };
    }
  }
  return null;
}

/** Lý do TỪ CHỐI ở Interactions API — hình dạng lỗi safety chưa tài liệu hoá đầy đủ, khoan dung
 *  bằng cách nhận diện qua vài field/nội dung thường gặp thay vì 1 field cố định. */
function interactionsBlockReason(data) {
  const err = data && data.error;
  if (err && /safety|policy|blocked|prohibited/i.test(String(err.status || err.message || ''))) {
    return 'content_blocked';
  }
  const steps = Array.isArray(data && data.steps) ? data.steps : [];
  for (const step of steps) {
    if (step && /safety|blocked|prohibited/i.test(String(step.type || ''))) return 'content_blocked';
  }
  return null;
}

async function callGeminiInteractionsImage(opts = {}) {
  const { prompt, timeoutMs, signal, apiKey, model, aspectRatio, quality, previousInteractionId } = opts;
  const url = 'https://generativelanguage.googleapis.com/v1beta/interactions';
  const linked = createLinkedAbort(timeoutMs, signal);
  try {
    // MỤC IV (đợt audit 6) — ROOT CAUSE: request CŨ chỉ gửi {model, input} và PHÓ MẶC model "tự
    // hiểu" phải trả ảnh — đúng chống-chỉ-định mà audit yêu cầu sửa. Nay khai báo TƯỜNG MINH
    // response_format với type:'image' + aspect_ratio + image_size, đúng cấu trúc tài liệu hoá.
    const body = {
      model,
      input: [{ type: 'text', text: prompt }],
      ...(previousInteractionId ? { previous_interaction_id: previousInteractionId } : {}),
      response_format: {
        type: 'image',
        aspect_ratio: aspectRatio || '1:1',
        image_size: geminiImageSizeLabel(quality || 'standard')
      }
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: linked.signal
    });
    let data;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      const blocked = data && interactionsBlockReason(data);
      if (blocked) return { ok: false, reason: blocked };
      return { ok: false, reason: 'http_' + res.status };
    }
    if (!data) return { ok: false, reason: 'malformed_response' };
    const blocked = interactionsBlockReason(data);
    if (blocked) return { ok: false, reason: blocked };
    const found = extractInteractionsImage(data);
    if (!found) return { ok: false, reason: 'no_image_in_response' };
    const interactionId = data.id || data.interaction_id || data.name || null;
    if (interactionId) {
      rememberInteraction(interactionId, { interactionId, provider: 'gemini-interactions-image', model });
    }
    return { ok: true, format: 'data_url', url: `data:${found.mime};base64,${found.b64}`, model, interactionId };
  } finally {
    linked.cleanup();
  }
}

/**
 * assertImageModelSupported() — Section 41: Model Deprecation Guard
 */
function assertImageModelSupported(model) {
  const m = String(model || '').toLowerCase();
  if (m === 'gemini-2.5-flash-image') {
    return {
      supported: true,
      deprecated: true,
      suggestedModel: 'gemini-3.1-flash-image',
      warning: 'gemini-2.5-flash-image is deprecated; please migrate to gemini-3.1-flash-image'
    };
  }
  return {
    supported: true,
    deprecated: false,
    suggestedModel: model,
    warning: null
  };
}

/** Chặn trường hợp provider trả chuỗi rác/thông báo lỗi vào đúng field đáng lẽ chứa ảnh. */
function isLikelyBase64(s) {
  // Độ dài KHÔNG phải tiêu chí phân biệt (fixture test dùng chuỗi rất ngắn, ảnh thật thì rất dài);
  // thứ phân biệt là BẢNG KÝ TỰ: prose trả nhầm vào field ảnh luôn có khoảng trắng/dấu tiếng Việt.
  if (typeof s !== 'string' || s.length < 4) return false;
  return /^[A-Za-z0-9+/\r\n=]+$/.test(s.slice(0, 512));
}

/**
 * Adapter DÙNG CHUNG cho mọi provider nói giao thức /v1/images/generations của OpenAI
 * (OpenAI, xAI/Grok, OpenRouter). Mục 2.1a điểm 7: thêm provider mới chỉ cần trỏ vào endpoint của
 * nó, KHÔNG đụng vào code của provider khác.
 * @param {object} opts {prompt, timeoutMs, signal, size, apiKey, model}
 * @param {string} endpoint URL đầy đủ của endpoint images/generations
 */
async function callOpenAICompatibleImage({ prompt, timeoutMs, signal, size, aspectRatio, apiKey, model, extraBody }, endpoint) {
  const linked = createLinkedAbort(timeoutMs, signal);
  try {
    // MỤC XI — gpt-image-1 chỉ nhận 3 giá trị size CỐ ĐỊNH (không nhận WxH tuỳ ý như size tính từ
    // sizeForRequest()); dùng aspectRatio để chọn giá trị hợp lệ GẦN ĐÚNG nhất thay vì luôn vuông.
    const openaiSize = aspectRatio ? openaiSizeFor(aspectRatio) : (size || '1024x1024');
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      // extraBody (vd {quality:'high'}) được GỘP CHỨ KHÔNG GHI ĐÈ field lõi (model/prompt/size/n) —
      // caller (listImageProviders) đã tự đảm bảo field đúng cho đúng provider/model, xem mục
      // "extraBody: field bổ sung AN TOÀN THEO TỪNG PROVIDER" ở registry phía trên.
      body: JSON.stringify({ model, prompt, size: openaiSize, n: 1, ...(extraBody || {}) }),
      signal: linked.signal
    });
    if (!res.ok) return { ok: false, reason: 'http_' + res.status };
    let data;
    try { data = await res.json(); } catch (e) { return { ok: false, reason: 'malformed_response' }; }
    // Bị từ chối vì nội dung -> không retryable (provider khác cũng chặn tương tự).
    if (data && data.error && /safety|policy|content/i.test(String(data.error.type || data.error.code || ''))) {
      return { ok: false, reason: 'content_blocked' };
    }
    const item = (Array.isArray(data && data.data) ? data.data : [])[0];
    if (!item) return { ok: false, reason: 'no_image_in_response' };
    const b64 = item.b64_json || item.b64Json;
    if (b64) {
      const claimed = item.output_format ? `image/${item.output_format}` : 'image/png';
      const verifiedMime = verifyImageBytes(b64, claimed);
      if (verifiedMime) return { ok: true, format: 'data_url', url: `data:${verifiedMime};base64,${b64}`, model };
      return { ok: false, reason: 'invalid_image_bytes' };
    }
    // URL phải là http(s) thật — không nhận data:/javascript:/chuỗi rác (ranh giới an toàn).
    if (typeof item.url === 'string' && /^https?:\/\//i.test(item.url)) {
      // ==========================================================================================
      // MỤC 3/8 (đợt audit 2) — ROOT CAUSE: trước đây "provider trả URL http(s) hợp lệ cú pháp" ĐÃ
      // được coi là ok:true, thật ra chưa hề biết URL đó có TRẢ VỀ ẢNH THẬT hay không (URL hết hạn,
      // URL trả trang lỗi HTML, hoặc chuyển hướng ra ngoài whitelist khi client bấm tải). Hệ quả:
      // renderer='generated_image' + origin='ai_generated' được gắn cho một thứ CHƯA HỀ được xác
      // minh — vi phạm đúng bất biến ở mục 7 của yêu cầu audit này. NAY: validate NGAY tại đây,
      // BẰNG CHÍNH request sẽ dùng để phục vụ client (cùng 1 URL, đọc thật body, so magic bytes) —
      // chỉ trả ok:true sau khi ĐÃ CÓ BẰNG CHỨNG nhị phân, không còn "success" chỉ vì cú pháp URL đẹp.
      try {
        const vRes = await fetch(item.url, { signal: linked.signal });
        if (!vRes.ok) return { ok: false, reason: 'image_url_fetch_failed:' + vRes.status };
        const len = Number(vRes.headers.get('content-length') || 0);
        if (len && len > URL_VALIDATE_MAX_BYTES) return { ok: false, reason: 'image_url_too_large' };
        const buf = Buffer.from(await vRes.arrayBuffer());
        if (buf.length > URL_VALIDATE_MAX_BYTES) return { ok: false, reason: 'image_url_too_large' };
        const validated = validateImageBuffer(buf, vRes.headers.get('content-type'));
        if (!validated.valid) return { ok: false, reason: 'invalid_image_bytes' };
        // urlVerified: true — báo hiệu URL đã được đọc thật, không phải đoán từ cú pháp. Client vẫn
        // tải qua /api/visual/download (proxy SSRF-whitelist) để không phải nới CSP; route đó VẪN
        // tự validate lại byte của chính nó (mục 5) — 2 lớp độc lập, không lớp nào thay thế lớp kia.
        return {
          ok: true, format: 'image_url', url: item.url, model,
          urlVerified: true, verifiedMime: validated.detectedMime
        };
      } catch (e) {
        return { ok: false, reason: (e && e.cancelled) ? 'cancelled' : 'image_url_verify_error' };
      }
    }
    return { ok: false, reason: 'no_image_in_response' };
  } finally {
    linked.cleanup();
  }
}

/** Giữ tên cũ cho mọi call-site/test hiện có — REST thuần, dùng khi cần gọi thẳng endpoint OpenAI
 *  không qua SDK (vd script debug). Provider 'openai-image' trong registry KHÔNG dùng hàm này nữa —
 *  xem callOpenAIImageSdk() bên dưới. */
function callOpenAIImage(opts) {
  return callOpenAICompatibleImage(opts, 'https://api.openai.com/v1/images/generations');
}

/**
 * callOpenAIImageSdk() — SDK chính chủ 'openai' (thay REST thuần cho riêng provider 'openai-image').
 * Giữ NGUYÊN toàn bộ logic đọc/kiểm chứng response đã có ở callOpenAICompatibleImage() (b64_json,
 * verifyImageBytes, xác minh URL bằng cách tải thật rồi so magic bytes — mục 3/8 đợt audit 2) — chỉ
 * đổi PHƯƠNG TIỆN gửi request (SDK tự lo header Authorization/Content-Type/serialize).
 */
async function callOpenAIImageSdk({ prompt, timeoutMs, signal, size, aspectRatio, apiKey, model, extraBody }) {
  const linked = createLinkedAbort(timeoutMs, signal);
  try {
    const OpenAI = loadOpenAiSdk();
    if (!OpenAI) return { ok: false, reason: 'sdk_not_installed' };
    // Truyền tường minh `fetch: global.fetch` (đọc TẠI THỜI ĐIỂM GỌI, không cache) — tài liệu SDK
    // 'openai' hỗ trợ chính thức tham số này. Lợi ích kép: (1) test hiện có stub global.fetch vẫn
    // chặn được đúng lệnh gọi HTTP dù đi qua SDK, không cần viết lại toàn bộ bộ test theo cơ chế
    // mock khác; (2) môi trường serverless (Vercel) có sẵn fetch native, không cần polyfill thêm.
    const client = new OpenAI({ apiKey, timeout: timeoutMs, fetch: global.fetch });
    // MỤC XI — gpt-image-1 chỉ nhận 3 giá trị size CỐ ĐỊNH, dùng aspectRatio để chọn giá trị hợp lệ
    // GẦN ĐÚNG nhất thay vì luôn vuông (giống hệt nhánh REST cũ).
    const openaiSize = aspectRatio ? openaiSizeFor(aspectRatio) : (size || '1024x1024');
    const requestBody = { model, prompt, size: openaiSize, n: 1, ...(extraBody || {}) };
    let response;
    try {
      response = await raceAbort(
        client.images.generate(requestBody, { signal: linked.signal }),
        linked.signal
      );
    } catch (e) {
      if (e && e.aborted) return { ok: false, reason: 'provider_timeout' };
      if (isSdkContentBlockedError(e)) return { ok: false, reason: 'content_blocked' };
      const status = statusFromSdkError(e);
      if (status) return { ok: false, reason: 'http_' + status };
      return { ok: false, reason: 'provider_error' };
    }
    if (!response) return { ok: false, reason: 'malformed_response' };
    const item = (Array.isArray(response.data) ? response.data : [])[0];
    if (!item) return { ok: false, reason: 'no_image_in_response' };
    const b64 = item.b64_json || item.b64Json;
    if (b64) {
      const claimed = item.output_format ? `image/${item.output_format}` : 'image/png';
      const verifiedMime = verifyImageBytes(b64, claimed);
      if (verifiedMime) return { ok: true, format: 'data_url', url: `data:${verifiedMime};base64,${b64}`, model };
      return { ok: false, reason: 'invalid_image_bytes' };
    }
    // URL phải là http(s) thật — không nhận data:/javascript:/chuỗi rác (ranh giới an toàn), và phải
    // được XÁC MINH BẰNG CÁCH TẢI THẬT (không tin cú pháp URL đẹp là đủ — xem mục 3/8 đợt audit 2).
    if (typeof item.url === 'string' && /^https?:\/\//i.test(item.url)) {
      try {
        const vRes = await fetch(item.url, { signal: linked.signal });
        if (!vRes.ok) return { ok: false, reason: 'image_url_fetch_failed:' + vRes.status };
        const len = Number(vRes.headers.get('content-length') || 0);
        if (len && len > URL_VALIDATE_MAX_BYTES) return { ok: false, reason: 'image_url_too_large' };
        const buf = Buffer.from(await vRes.arrayBuffer());
        if (buf.length > URL_VALIDATE_MAX_BYTES) return { ok: false, reason: 'image_url_too_large' };
        const validated = validateImageBuffer(buf, vRes.headers.get('content-type'));
        if (!validated.valid) return { ok: false, reason: 'invalid_image_bytes' };
        return {
          ok: true, format: 'image_url', url: item.url, model,
          urlVerified: true, verifiedMime: validated.detectedMime
        };
      } catch (e) {
        return { ok: false, reason: (e && e.cancelled) ? 'cancelled' : 'image_url_verify_error' };
      }
    }
    return { ok: false, reason: 'no_image_in_response' };
  } finally {
    linked.cleanup();
  }
}

module.exports = {
  generateImage, isConfigured, activeProviderName, IMAGE_TIMEOUT_MS,
  listImageProviders, classifyImageCost, isRetryableReason, IMAGE_COST, activePromptCharLimit,
  extractGeminiInline, geminiBlockReason, isLikelyBase64, detectImageSignature, verifyImageBytes,
  assertImageModelSupported,
  // Mục 2.1a: registry mở rộng + phân giải khóa — export để test kiểm chứng trực tiếp.
  IMAGE_PROVIDER_DEFS, resolveImageKey, callOpenAICompatibleImage, callOpenAIImage, callOpenAIImageSdk,
  callGeminiImage, callGeminiInteractionsImage, extractInteractionsImage, interactionsBlockReason,
  // Mục X/XI (đợt audit 6): quality mode + aspect-ratio -> size thật.
  sizeForRequest, openaiSizeFor, geminiImageSizeLabel, resolveQualityMode, IMAGE_QUALITY_LONG_EDGE,
  // Mục XXII (đợt audit 6): self-healing circuit breaker theo provider.
  recordProviderResult, isCircuitOpen, circuitSnapshot
};
