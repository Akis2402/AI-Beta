'use strict';

// ---------- Registry hợp nhất các nhà cung cấp AI ----------
// KHÔNG có một mô hình AI "mặc định"/"chính" nào được ưu tiên cố định — cả chế độ "Nhanh" lẫn
// "Suy nghĩ sâu" đều chọn nhà cung cấp một cách NGẪU NHIÊN trong số các provider đã cấu hình khóa
// API, và mỗi lượt gọi API đều có TỰ ĐỘNG CHUYỂN SANG PROVIDER KHÁC (failover) nếu provider được
// chọn báo lỗi (khóa API sai/hết hạn, quá tải, bug tạm thời, phản hồi quá chậm...).
//
// ---------- Tự động nhận diện provider mới — KHÔNG cần sửa file này ----------
// Ngoài 3 provider "lõi" (Claude/GPT/Gemini) khai báo trực tiếp bên dưới, mọi provider khai báo
// trong server/config/extraProviders.js đều được tự động quét và thêm vào registry nếu biến môi
// trường API key tương ứng đã có giá trị trong .env — xem chi tiết cách bật/thêm ở file đó.
// getActiveProviders() luôn đọc lại danh sách này ở MỖI request (không cache), nên chỉ cần điền
// khóa API vào .env rồi khởi động lại server (hoặc deploy lại) là provider mới có hiệu lực ngay,
// không cần sửa gì ở registry hay ở chat.js.
//
// ---------- Tăng tốc độ phản hồi ----------
// - Mỗi client có timeout riêng (REQUEST_TIMEOUT_MS trong .env, mặc định 30s) — provider phản hồi
//   quá chậm bị hủy và coi là lỗi, kích hoạt failover ngay thay vì bắt người dùng chờ vô thời hạn.
// - Chế độ Nhanh dùng callFastest(): gọi ĐỒNG THỜI vài provider ngẫu nhiên và lấy kết quả của
//   provider trả lời TRƯỚC TIÊN (đua tốc độ) — nhanh hơn hẳn so với chờ tuần tự từng provider.
// - Mỗi provider có thể khai báo model "nhanh" riêng (tham số fast:true khi gọi call()) — dùng
//   model nhẹ/rẻ hơn cho chế độ Nhanh, giữ model đầy đủ cho chế độ Suy nghĩ sâu (ưu tiên độ chính
//   xác hơn tốc độ ở bước đối chiếu công thức).

const { callClaude, callClaudeStream } = require('./anthropicClient');
const { callOpenAI, callOpenAIStream, MODEL: OPENAI_DEFAULT_MODEL } = require('./openaiClient');
const { callGemini, callGeminiStream, MODEL: GEMINI_DEFAULT_MODEL } = require('./geminiClient');
const { createOpenAICompatibleClient } = require('./openaiCompatibleClient');
const ANTHROPIC_DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const { EXTRA_PROVIDERS } = require('../config/extraProviders');
// Lọc khối <thinking>/<think> (nháp suy luận nội bộ) khỏi MỌI văn bản forward ra ngoài — xem giải
// thích đầy đủ nguyên nhân gốc + phạm vi áp dụng ở đầu file thinkingFilter.js.
const { stripThinkingTags, createStreamingThinkingFilter } = require('./thinkingFilter');
// Lọc "nhãn phân loại an toàn nội bộ bị lộ ra làm câu trả lời" (vd "User Safety: unsafe/Safety
// Categories: Profanity" cho 1 đề bài vô hại) — xem nguyên nhân gốc + cách fix đầy đủ ở đầu file
// safetyLeakFilter.js. stripThinkingTags() (thinkingFilter.js) đã gọi lớp lọc này cho MỌI đường
// JSON không streaming; createSafetyLineFilter riêng dưới đây chỉ cần thêm cho đường STREAM (vì
// stream cần lọc theo từng dòng khi text đổ về, không thể đợi có đủ text rồi mới strip 1 lần).
const { createSafetyLineFilter } = require('./safetyLeakFilter');

const WEB_SEARCH_TOOL_ANTHROPIC = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }];

// ---------- NGÂN SÁCH THỜI GIAN TỔNG cho chế độ "Đối chiếu đa hướng" ----------
// NGUYÊN NHÂN GỐC của lỗi timeout ở chế độ đối chiếu đa hướng (giai đoạn giải chi tiết): pipeline
// này gồm NHIỀU lượt gọi AI CỘNG DỒN — vòng 1 (song song), rồi thử lại TUẦN TỰ từng provider lỗi,
// rồi có thể thêm 1 lượt dự phòng, rồi lượt TỔNG HỢP cuối — mỗi lượt có thể tốn tới
// REQUEST_TIMEOUT_MS (mặc định 30s) TRƯỚC KHI coi là lỗi. Cộng dồn tuần tự, tổng thời gian dễ dàng
// vượt quá thời gian tối đa mà nền tảng hosting (vd Vercel) cho phép 1 serverless function chạy —
// hàm bị nền tảng HỦY GIỮA CHỪNG (không phải lỗi ở AI) và người dùng thấy "mất kết nối"/"timeout".
// FIX: gán 1 ngân sách thời gian TỔNG dùng chung cho toàn bộ quá trình thu thập lượt giải (không
// tính lượt tổng hợp cuối) — mọi lượt gọi/thử lại phải tự co timeout của mình lại theo ngân sách
// còn lại, và khi ngân sách gần hết, hệ thống NGỪNG thử thêm, dùng ngay số lượt đã thu thập được
// (tối thiểu 1) để tổng hợp thay vì cố thử thêm rồi bị nền tảng hủy toàn bộ request.
// Đặt CROSS_CHECK_BUDGET_MS trong .env thấp hơn maxDuration của vercel.json (trừ hao ~10-15s cho
// lượt tổng hợp cuối + độ trễ mạng) để không bao giờ chạm giới hạn cứng của nền tảng.
const CROSS_CHECK_BUDGET_MS = Number(process.env.CROSS_CHECK_BUDGET_MS) || 45000;
const MIN_CALL_TIMEOUT_MS = 4000; // sàn tối thiểu — không co timeout xuống mức vô nghĩa (luôn lỗi ngay)

/** Tạo 1 "đồng hồ đếm ngược" ngân sách thời gian dùng chung cho cả pipeline đối chiếu đa hướng. */
function createDeadline(budgetMs = CROSS_CHECK_BUDGET_MS) {
  const start = Date.now();
  return {
    remaining: () => Math.max(0, budgetMs - (Date.now() - start)),
    expired: () => Date.now() - start >= budgetMs
  };
}

/**
 * Thu thập nhiều lượt giải ĐỘC LẬP song song cho chế độ "Đối chiếu đa hướng" (giai đoạn giải chi
 * tiết), có ngân sách thời gian TỔNG dùng chung (xem CROSS_CHECK_BUDGET_MS ở trên). So với cách làm
 * cũ (thử lại provider lỗi TUẦN TỰ, từng provider một, từng ứng viên một), hàm này chạy TẤT CẢ các
 * lượt thử lại SONG SONG với nhau (Promise.allSettled lồng Promise.allSettled) — giảm mạnh thời
 * gian chờ tệ nhất khi có từ 2 provider lỗi trở lên.
 *
 * @param {Array} providers Danh sách provider đang hoạt động (từ getActiveProviders()).
 * @param {{system:string, variantSystem:string, messages:Array, maxTokens:number, onStatus?:Function}} args
 * @returns {Promise<{candidates:Array<{label:string,text:string}>, deadline:object}>}
 */
async function gatherCrossCheckCandidates(providers, { system, variantSystem, messages, maxTokens, onStatus }) {
  const deadline = createDeadline();
  const notify = typeof onStatus === 'function' ? onStatus : () => {};
  const timeoutFor = (base) => Math.max(MIN_CALL_TIMEOUT_MS, Math.min(base, deadline.remaining()));

  // ---------- Vòng 1: mọi provider giải 1 lượt ĐỘC LẬP SONG SONG ----------
  const firstRound = await Promise.allSettled(
    providers.map((p) => p.call({ system: variantSystem, messages, maxTokens, timeoutMs: timeoutFor(30000) }))
  );

  // Mọi text ở bước THU THẬP candidate này đi tiếp vào prompt của lượt TỔNG HỢP cuối (không hiển
  // thị trực tiếp cho người dùng ở bước này) — nhưng vẫn strip <thinking>/<think> ngay tại đây để
  // lượt tổng hợp không bị "loãng" ngữ cảnh bởi nháp suy luận của từng lượt giải độc lập.
  const candidates = [];
  const failedProviders = [];
  firstRound.forEach((r, i) => {
    const text = r.status === 'fulfilled' ? stripThinkingTags(r.value) : '';
    if (text) candidates.push({ label: providers[i].label, text });
    else failedProviders.push(providers[i]);
  });

  // ---------- Thử lại các provider lỗi — SONG SONG với nhau (không còn tuần tự) ----------
  if (failedProviders.length && !deadline.expired()) {
    notify('Đang thử lại các nhà cung cấp gặp lỗi…');
    const retryOutcomes = await Promise.allSettled(
      failedProviders.map(async (failed) => {
        const others = shuffle(providers.filter((p) => p.key !== failed.key));
        const retryOrder = others.length ? others : [failed];
        for (const p of retryOrder) {
          if (deadline.expired()) break;
          try {
            const text = stripThinkingTags(await p.call({ system: variantSystem, messages, maxTokens, timeoutMs: timeoutFor(20000) }));
            if (text) return { label: p.label, text };
          } catch (e) { /* thử ứng viên kế tiếp trong retryOrder */ }
        }
        throw new Error('Không còn provider nào khả dụng để thử lại trong ngân sách thời gian cho phép.');
      })
    );
    retryOutcomes.forEach((r) => { if (r.status === 'fulfilled') candidates.push(r.value); });
  }

  // ---------- Vẫn chưa đủ 2 lượt để đối chiếu chéo: dùng chính provider còn sống làm thêm 1 lượt ----------
  if (candidates.length === 1 && !deadline.expired()) {
    const survivor = providers.find((p) => candidates[0].label.startsWith(p.label)) || providers[0];
    try {
      const extra = stripThinkingTags(await survivor.call({ system, messages, maxTokens, temperature: 0.4, timeoutMs: timeoutFor(15000) }));
      if (extra) candidates.push({ label: survivor.label + ' (góc nhìn khác)', text: extra });
    } catch (e) { /* không còn cách nào khác trong ngân sách — dùng đúng 1 lượt hiện có */ }
  }

  return { candidates, deadline };
}

// ---------- ĐA DẠNG HOÁ: 1 provider có thể khai NHIỀU API key + NHIỀU model ----------
// Trước đây mỗi provider (kể cả lõi) chỉ đọc ĐÚNG 1 khóa API từ 1 biến môi trường (vd
// ANTHROPIC_API_KEY) và tối đa 2 model cố định (model "đầy đủ" + model "nhanh"). Với người dùng có
// nhiều khóa API của CÙNG 1 hãng (vd 3 khóa Gemini free-tier khác nhau để né giới hạn hạn mức/phút
// của từng khóa) hoặc muốn thử nhiều model khác nhau của cùng 1 hãng cho đa dạng câu trả lời, cách
// duy nhất trước đây là chỉnh sửa code.
//
// FIX: mọi biến môi trường *_API_KEY / *_MODEL / *_MODEL_FAST giờ CHO PHÉP khai NHIỀU giá trị,
// phân tách bằng dấu phẩy HOẶC xuống dòng, ví dụ:
//   GEMINI_API_KEY=AIzaKey1,AIzaKey2,AIzaKey3
//   GEMINI_MODEL=gemini-3.6-flash,gemini-3.6-pro
// parseMultiEnv() tách chuỗi đó ra thành mảng. buildKeyedVariants() sau đó biến MỖI khóa API thành
// 1 "provider ảo" RIÊNG trong registry (label kèm số thứ tự #1/#2/... nếu có từ 2 khóa trở lên) —
// nhờ vậy shuffle()/callWithFailover()/callFastest() đã có sẵn coi mỗi khóa là 1 ứng viên độc lập:
// khóa nào bị lỗi (hết hạn mức/sai/quá tải) tự động failover sang khóa/hãng khác mà không cần biết
// đó là cùng 1 hãng. Ở mỗi lượt gọi, model dùng cho provider ảo đó được CHỌN NGẪU NHIÊN trong danh
// sách model đã khai (nếu chỉ khai 1 model, luôn dùng đúng model đó — hành vi y hệt trước đây,
// không phá vỡ cấu hình cũ chỉ có 1 khóa/1 model).
function parseMultiEnv(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function pickRandomOrUndefined(list) {
  return list.length ? list[Math.floor(Math.random() * list.length)] : undefined;
}

/**
 * @param {{baseKey:string, baseLabel:string, apiKeyEnv:string, modelEnv:string, fastModelEnv:string,
 *   supportsWebSearch:boolean, call:Function, callStream:Function}} def
 * @returns {Array} 0 provider (chưa cấu hình khóa nào) hoặc 1 provider ảo cho MỖI khóa API đã khai.
 */
function buildKeyedVariants({ baseKey, baseLabel, apiKeyEnv, modelEnv, fastModelEnv, defaultModel, supportsWebSearch, call, callStream }) {
  const apiKeys = parseMultiEnv(process.env[apiKeyEnv]);
  if (!apiKeys.length) return [];
  const models = parseMultiEnv(process.env[modelEnv]);
  const fastModels = parseMultiEnv(process.env[fastModelEnv]);
  const modelHint = models.length > 1 ? ` · ${models.length} model` : (models[0] || defaultModel ? ` (${models[0] || defaultModel})` : '');

  return apiKeys.map((apiKeyOverride, i) => ({
    key: apiKeys.length > 1 ? `${baseKey}_${i + 1}` : baseKey,
    label: `${baseLabel}${apiKeys.length > 1 ? ` #${i + 1}` : ''}${modelHint}`,
    // Đã lọc theo apiKeys.length ở trên nên MỌI provider ảo sinh ra ở đây đều "đã cấu hình".
    configured: () => true,
    supportsWebSearch,
    call: (args) => call({ ...args, apiKeyOverride, modelOverride: pickRandomOrUndefined(models), fastModelOverride: pickRandomOrUndefined(fastModels) }),
    callStream: (args) => callStream({ ...args, apiKeyOverride, modelOverride: pickRandomOrUndefined(models), fastModelOverride: pickRandomOrUndefined(fastModels) })
  }));
}

const CORE_DEFS = [
  {
    baseKey: 'anthropic',
    baseLabel: 'Claude',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    modelEnv: 'ANTHROPIC_MODEL',
    fastModelEnv: 'ANTHROPIC_MODEL_FAST',
    defaultModel: ANTHROPIC_DEFAULT_MODEL,
    supportsWebSearch: true,
    call: ({ webSearch, ...rest }) => callClaude({ ...rest, tools: webSearch ? WEB_SEARCH_TOOL_ANTHROPIC : undefined }),
    callStream: ({ webSearch, ...rest }) => callClaudeStream({ ...rest, tools: webSearch ? WEB_SEARCH_TOOL_ANTHROPIC : undefined })
  },
  {
    baseKey: 'openai',
    baseLabel: 'GPT',
    apiKeyEnv: 'OPENAI_API_KEY',
    modelEnv: 'OPENAI_MODEL',
    fastModelEnv: 'OPENAI_MODEL_FAST',
    defaultModel: OPENAI_DEFAULT_MODEL,
    supportsWebSearch: true,
    call: callOpenAI,
    callStream: callOpenAIStream
  },
  {
    baseKey: 'gemini',
    baseLabel: 'Gemini',
    apiKeyEnv: 'GEMINI_API_KEY',
    modelEnv: 'GEMINI_MODEL',
    fastModelEnv: 'GEMINI_MODEL_FAST',
    defaultModel: GEMINI_DEFAULT_MODEL,
    supportsWebSearch: true,
    call: callGemini,
    callStream: callGeminiStream
  }
];

// Xây registry cho các provider "bổ sung" khai báo trong extraProviders.js — mỗi entry dùng chung
// 1 client tương thích OpenAI Chat Completions (createOpenAICompatibleClient), không hỗ trợ web
// search (đa số API tương thích OpenAI của bên thứ ba không có tool tìm kiếm tích hợp). Mỗi cfg chỉ
// cần TẠO 1 client dùng chung — apiKeyOverride/modelOverride/fastModelOverride được truyền riêng ở
// từng lượt gọi (xem buildKeyedVariants) nên 1 client vẫn phục vụ được nhiều khóa API khác nhau.
const EXTRA_DEFS = EXTRA_PROVIDERS.map((cfg) => {
  const client = createOpenAICompatibleClient(cfg);
  return {
    baseKey: cfg.key,
    baseLabel: cfg.label,
    apiKeyEnv: cfg.apiKeyEnv,
    modelEnv: cfg.modelEnv,
    fastModelEnv: cfg.fastModelEnv,
    supportsWebSearch: false,
    call: client.call,
    callStream: client.callStream
  };
});

const ALL_DEFS = [...CORE_DEFS, ...EXTRA_DEFS];

/**
 * Trả về danh sách provider (mỗi khóa API = 1 provider ảo, xem buildKeyedVariants) đã có API key
 * hợp lệ trong .env NGAY TẠI THỜI ĐIỂM GỌI (không cache) — mọi thay đổi .env có hiệu lực ngay sau
 * khi khởi động lại server mà không cần sửa code.
 */
function getActiveProviders() {
  return ALL_DEFS.flatMap(buildKeyedVariants);
}

/** Xáo trộn ngẫu nhiên 1 mảng (Fisher–Yates) — dùng để không có provider nào luôn được thử trước. */
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Gọi LẦN LƯỢT các provider theo thứ tự NGẪU NHIÊN (đảo thứ tự mỗi lần gọi hàm này) cho tới khi
 * có 1 lượt thành công — không có provider "mặc định" cố định nào luôn được thử trước, nên về lâu
 * dài mọi nhà cung cấp đã cấu hình đều có cơ hội được chọn công bằng như nhau. Nếu provider được
 * chọn báo lỗi (API key sai, hết hạn mức, lỗi 5xx, timeout mạng...), hàm TỰ ĐỘNG chuyển sang thử
 * provider tiếp theo trong danh sách — người dùng không thấy lỗi trừ khi TẤT CẢ provider đều lỗi.
 * Dùng cho lượt TỔNG HỢP ở chế độ Sâu (chỉ cần 1 kết quả chắc chắn, không cần nhanh nhất).
 *
 * @param {Array} providers Danh sách provider đang hoạt động (từ getActiveProviders()).
 * @param {object} args Tham số truyền cho call() của provider: {system, messages, maxTokens, temperature, webSearch, fast, timeoutMs}.
 * @param {{preferWebSearch?: boolean}} [opts]
 * @returns {Promise<{text:string, provider:object, tried:Array}>}
 */
async function callWithFailover(providers, args, { preferWebSearch = false } = {}) {
  if (!providers || !providers.length) {
    const err = new Error('Chưa có nhà cung cấp AI nào được cấu hình (thiếu API key trong .env).');
    err.status = 500;
    throw err;
  }

  let order = shuffle(providers);
  if (preferWebSearch) {
    const withSearch = order.filter((p) => p.supportsWebSearch);
    const withoutSearch = order.filter((p) => !p.supportsWebSearch);
    order = [...withSearch, ...withoutSearch];
  }

  const tried = [];
  let lastErr;
  for (const p of order) {
    try {
      // strip <thinking>/<think>: text ở đây được trả THẲNG cho người dùng (JSON response) —
      // xem giải thích nguyên nhân gốc ở đầu thinkingFilter.js.
      const text = stripThinkingTags(await p.call(args));
      if (text) return { text, provider: p, tried };
      tried.push({ label: p.label, error: 'Phản hồi rỗng' });
    } catch (err) {
      lastErr = err;
      tried.push({ label: p.label, error: (err && err.message) || String(err) });
      // KHÔNG throw ngay — tự động thử provider tiếp theo (failover).
    }
  }

  const err = new Error(
    'Tất cả nhà cung cấp AI đã cấu hình đều gặp lỗi khi trả lời.' +
    (lastErr ? ' Lỗi gần nhất: ' + lastErr.message : '')
  );
  err.status = 502;
  err.triedProviders = tried;
  throw err;
}

/**
 * "Đua tốc độ": gọi ĐỒNG THỜI tối đa `raceSize` provider ngẫu nhiên (mặc định 2, hoặc ít hơn nếu
 * không đủ provider) và lấy kết quả của provider trả lời THÀNH CÔNG ĐẦU TIÊN — nhanh hơn hẳn so
 * với callWithFailover() (vốn chờ tuần tự) vì không phải đợi 1 provider chậm/timeout mới thử tiếp.
 * Nếu tất cả provider trong nhóm đua đều lỗi, tự động mở rộng đua sang các provider còn lại (nếu
 * có) trước khi báo lỗi. Dùng cho chế độ Nhanh — nơi tốc độ phản hồi quan trọng hơn việc tiết kiệm
 * 1 lệnh gọi API thừa.
 *
 * @param {Array} providers Danh sách provider đang hoạt động.
 * @param {object} args Tham số truyền cho call() của provider (nên kèm `fast:true` để dùng model nhẹ/nhanh).
 * @param {{raceSize?: number}} [opts]
 * @returns {Promise<{text:string, provider:object, tried:Array}>}
 */
async function callFastest(providers, args, { raceSize = 2 } = {}) {
  if (!providers || !providers.length) {
    const err = new Error('Chưa có nhà cung cấp AI nào được cấu hình (thiếu API key trong .env).');
    err.status = 500;
    throw err;
  }
  if (providers.length === 1) {
    return callWithFailover(providers, args);
  }

  const order = shuffle(providers);
  const group = order.slice(0, Math.max(2, Math.min(raceSize, order.length)));
  const rest = order.slice(group.length);
  const tried = [];

  async function raceGroup(list) {
    const attempts = list.map(
      (p) =>
        p
          .call(args)
          // strip <thinking>/<think>: text ở đây được trả THẲNG cho người dùng — xem đầu
          // thinkingFilter.js.
          .then((text) => {
            const visible = stripThinkingTags(text);
            if (!visible) throw new Error('Phản hồi rỗng');
            return { text: visible, provider: p };
          })
          .catch((err) => {
            tried.push({ label: p.label, error: (err && err.message) || String(err) });
            throw err; // để Promise.any bỏ qua provider này và chờ provider còn lại trong nhóm
          })
    );
    return Promise.any(attempts);
  }

  try {
    const result = await raceGroup(group);
    return { ...result, tried };
  } catch (firstGroupErr) {
    // Cả nhóm đua đầu đều lỗi — thử tiếp các provider còn lại (nếu có) trước khi bỏ cuộc.
    if (rest.length) {
      try {
        const result = await raceGroup(rest);
        return { ...result, tried };
      } catch (secondGroupErr) { /* rơi xuống báo lỗi chung bên dưới */ }
    }
    const err = new Error('Tất cả nhà cung cấp AI đã cấu hình đều gặp lỗi khi trả lời.');
    err.status = 502;
    err.triedProviders = tried;
    throw err;
  }
}

/**
 * Bản streaming của callWithFailover(): thử LẦN LƯỢT các provider theo thứ tự NGẪU NHIÊN, phát
 * từng đoạn văn bản (delta) qua onDelta ngay khi nhận được từ provider ĐANG thử — giống hiệu ứng
 * "gõ chữ" trực tiếp trên giao diện thay vì đợi trả lời xong toàn bộ rồi mới hiển thị.
 *
 * Failover CHỈ áp dụng trước khi provider hiện tại phát ra delta đầu tiên (lỗi kết nối/xác thực/
 * quá tải xảy ra ngay khi mở stream) — một khi đã có ít nhất 1 đoạn văn bản được gửi tới người
 * dùng, hệ thống "cam kết" với provider đó tới cùng dù nó có lỗi giữa chừng (không thể lặng lẽ đổi
 * provider khi người dùng đã thấy 1 phần câu trả lời trên màn hình — sẽ gây rối loạn nội dung).
 * Nếu lỗi giữa chừng như vậy xảy ra, những gì đã stream được vẫn được coi là kết quả cuối cùng.
 *
 * @param {Array} providers Danh sách provider đang hoạt động (từ getActiveProviders()).
 * @param {object} args Tham số truyền cho callStream() của provider.
 * @param {Function} onDelta Callback nhận từng đoạn văn bản mới.
 * @param {{preferWebSearch?: boolean}} [opts]
 * @returns {Promise<{text:string, provider:object, tried:Array}>}
 */
async function streamWithFailover(providers, args, onDelta, { preferWebSearch = false } = {}) {
  if (!providers || !providers.length) {
    const err = new Error('Chưa có nhà cung cấp AI nào được cấu hình (thiếu API key trong .env).');
    err.status = 500;
    throw err;
  }

  let order = shuffle(providers);
  if (preferWebSearch) {
    const withSearch = order.filter((p) => p.supportsWebSearch);
    const withoutSearch = order.filter((p) => !p.supportsWebSearch);
    order = [...withSearch, ...withoutSearch];
  }

  const tried = [];
  let lastErr;
  for (const p of order) {
    if (typeof p.callStream !== 'function') { tried.push({ label: p.label, error: 'Không hỗ trợ streaming' }); continue; }
    // committed chỉ bật khi có ÍT NHẤT 1 đoạn văn bản THẬT (ngoài khối <thinking>/<think>) đã
    // forward ra ngoài qua onDelta — KHÔNG bật chỉ vì đã nhận raw piece từ provider. Nhờ vậy nếu
    // 1 provider chỉ mới stream xong (hoặc lỗi giữa chừng) trong lúc TOÀN BỘ những gì nhận được
    // vẫn còn nằm trong khối thinking (chưa có gì hiển thị cho người dùng), hệ thống vẫn coi là
    // AN TOÀN để failover sang provider khác — trước đây (chưa lọc) sẽ bị coi là "đã hiển thị 1
    // phần" một cách sai lệch, chặn mất cơ hội failover dù người dùng chưa thấy gì thật sự.
    let committed = false;
    // Ghép 2 lớp lọc streaming theo đúng thứ tự: (1) bỏ khối <thinking>/<think> trước, (2) trên
    // phần "đã ra khỏi thinking" đó mới lọc tiếp các dòng nhãn phân loại an toàn bị lộ. `committed`
    // CHỈ bật ở lớp lọc CUỐI CÙNG (sau khi qua cả 2 lớp) — nhờ vậy nếu 1 provider trả về response
    // mà toàn bộ nội dung "thấy được" chỉ là nhãn kiểu "User Safety: unsafe" (không có câu trả lời
    // thật nào), dòng đó bị lớp lọc thứ 2 âm thầm loại bỏ, committed vẫn là false, và hệ thống tự
    // động failover sang provider khác — thay vì hiển thị nhãn "unsafe" đó cho người dùng như thể
    // đó là câu trả lời (xem bug gốc + giải thích đầy đủ ở đầu safetyLeakFilter.js).
    const safetyFilter = createSafetyLineFilter((visible) => { committed = true; onDelta(visible); });
    const filter = createStreamingThinkingFilter((visible) => safetyFilter.feed(visible));
    try {
      const text = await p.callStream({
        ...args,
        onDelta: (piece) => filter.feed(piece)
      });
      filter.flush();
      safetyFilter.flush();
      const visibleText = stripThinkingTags(text);
      if (visibleText || committed) return { text: visibleText, provider: p, tried };
      tried.push({ label: p.label, error: 'Phản hồi rỗng (chỉ chứa nhãn phân loại an toàn nội bộ bị lộ, không có câu trả lời thật — xem safetyLeakFilter.js)' });
    } catch (err) {
      if (committed) {
        // Đã stream được 1 phần cho người dùng thấy — không thể lùi lại đổi provider khác giữa
        // chừng, đành coi phần đã có là kết quả cuối (tốt hơn là hủy bỏ mọi thứ đã hiển thị).
        return { text: '', provider: p, tried, partialError: err };
      }
      lastErr = err;
      tried.push({ label: p.label, error: (err && err.message) || String(err) });
      // Chưa phát ra delta THẬT nào (có thể đã nhận vài piece nhưng toàn bộ vẫn đang nằm trong
      // khối thinking) — an toàn để tự động thử provider tiếp theo (failover).
    }
  }

  const err = new Error(
    'Tất cả nhà cung cấp AI đã cấu hình đều gặp lỗi khi trả lời.' +
    (lastErr ? ' Lỗi gần nhất: ' + lastErr.message : '')
  );
  err.status = 502;
  err.triedProviders = tried;
  throw err;
}

module.exports = {
  getActiveProviders, callWithFailover, callFastest, streamWithFailover, shuffle,
  createDeadline, gatherCrossCheckCandidates, CROSS_CHECK_BUDGET_MS
};
