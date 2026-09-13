'use strict';

const { recordAttemptFor } = require('./tokenTelemetry');

// ---------- Điều phối AI Rotation: Provider → API Keys → Models → Execution Targets ----------
// KHÔNG coi "AI = API Key" hay "AI = Model". Mỗi tổ hợp (API Key × Model) là 1 Execution Target độc
// lập (xem executionTargets.js) — rotation xoay công bằng qua các target đó (xem rotationManager.js:
// getEligibleTargets/orderByRotation/markSuccess/markFailure, health theo 3 tầng Key/Model/Target).
// File này chỉ còn ORCHESTRATION (thứ tự thử, failover, đua tốc độ, đối chiếu đa hướng) — không tự
// quản lý health/cooldown nữa (tách trách nhiệm rõ ràng, đúng mục 21 của yêu cầu gốc).
//
// ---------- Tự động nhận diện provider mới — KHÔNG cần sửa file này ----------
// Ngoài 3 provider "lõi" (Claude/GPT/Gemini), mọi provider khai trong server/config/extraProviders.js
// đều được tự động quét và thêm vào registry nếu biến môi trường API key tương ứng đã có giá trị
// trong .env. getActiveProviders() luôn đọc lại (không cache) — đổi .env + khởi động lại server là
// có hiệu lực ngay.
//
// ---------- Deep Thinking / Multi-direction (crossCheck) ----------
// 2 tính năng này là chỉ thị TẦNG PROMPT/ROUTE (xem chat.js, promptBuilder.js) — KHÔNG phải capability
// riêng của model nào, mọi model đều "hỗ trợ" được. File này KHÔNG lọc/route theo 2 cờ đó — chỉ
// capability THẬT (web search — supportsWebSearch) mới ảnh hưởng việc chọn target (mục 6).

const { getAllExecutionTargets, listAutoDiscoveryDefs } = require('./executionTargets');
const {
  getEligibleTargets, orderByRotation, shuffle, markSuccess, markFailure, getHealthSnapshot, isTargetSlow,
  // Vấn đề #1 (vòng 3): đặt "vé xoay" toàn cục lấy bằng atomic INCR ở đầu request.
  setGlobalRotationSlot
} = require('./rotationManager');
// ---------- mục 3/9/21: model discovery orchestration ----------
// aiProviders.js chỉ ĐIỀU PHỐI (gọi warmDiscovery cho mọi provider/khóa cần auto-discovery TRƯỚC
// khi build execution target) — modelDiscovery.js giữ toàn bộ logic gọi API liệt kê model/chọn
// model/cache; executionTargets.js chỉ lắp ráp target từ cache đã có (mục 3, tách trách nhiệm).
const { warmDiscovery, invalidateModelCache } = require('./modelDiscovery');
const rotationStore = require('./rotationStore');
// Lọc khối <thinking>/<think> (nháp suy luận nội bộ) khỏi MỌI văn bản forward ra ngoài — xem giải
// thích đầy đủ nguyên nhân gốc + phạm vi áp dụng ở đầu file thinkingFilter.js.
const { stripThinkingTags, createStreamingThinkingFilter } = require('./thinkingFilter');
// Lọc "nhãn phân loại an toàn nội bộ bị lộ ra làm câu trả lời" — xem đầu safetyLeakFilter.js.
const { createSafetyLineFilter } = require('./safetyLeakFilter');
// Observability (mục LVIII): log requestId/provider/model/targetId/stage/latency/status/error class
// cho MỖI lần gọi 1 execution target — không log secret (logger tự redact). `requestId` là optional
// (args.requestId, do chat.js gán) — nếu không có, field đó vắng mặt trong log, không throw.
const { log, classifyErrorForLog } = require('./logger');
function logAttempt({ requestId, stage, target, latency, status, err, usage, answerBudget, reasoningBudget, providerMaxTokens, finishReason, retry, recovery, estimatedOutputTokens }) {
  log({
    requestId, stage, status,
    provider: target && target.providerKey,
    model: target && target.modelId,
    targetId: target && target.id,
    latency,
    errorClass: err ? classifyErrorForLog(err) : undefined
  });
  // PHẦN B mục 11: telemetry PER ATTEMPT. Không log API key/nội dung — recordAttemptFor() chỉ nhận
  // số đếm và nhãn. No-op nếu route chưa đăng ký recorder cho requestId này (đường gọi legacy/test).
  recordAttemptFor(requestId, {
    stage,
    provider: target && target.providerKey,
    model: target && target.modelId,
    targetId: target && target.id,
    latencyMs: latency,
    status: status === 'success' ? 'success' : (status === 'empty' ? 'empty' : 'error'),
    usage, answerBudget, reasoningBudget, providerMaxTokens, finishReason,
    retry: !!retry, recovery: !!recovery, estimatedOutputTokens
  });
}

// ---------- NGÂN SÁCH THỜI GIAN TỔNG cho chế độ "Đối chiếu đa hướng" ----------
// NGUYÊN NHÂN GỐC của lỗi timeout ở chế độ đối chiếu đa hướng (giai đoạn giải chi tiết): pipeline
// này gồm NHIỀU lượt gọi AI CỘNG DỒN — vòng 1 (song song), rồi thử lại TUẦN TỰ từng target lỗi, rồi
// có thể thêm 1 lượt dự phòng, rồi lượt TỔNG HỢP cuối — mỗi lượt có thể tốn tới REQUEST_TIMEOUT_MS
// (mặc định 30s) TRƯỚC KHI coi là lỗi. Cộng dồn tuần tự, tổng thời gian dễ dàng vượt quá thời gian
// tối đa mà nền tảng hosting (vd Vercel) cho phép 1 serverless function chạy — hàm bị nền tảng HỦY
// GIỮA CHỪNG (không phải lỗi ở AI) và người dùng thấy "mất kết nối"/"timeout".
// FIX: gán 1 ngân sách thời gian TỔNG dùng chung cho toàn bộ quá trình thu thập lượt giải (không
// tính lượt tổng hợp cuối) — mọi lượt gọi/thử lại phải tự co timeout của mình lại theo ngân sách còn
// lại, và khi ngân sách gần hết, hệ thống NGỪNG thử thêm, dùng ngay số lượt đã thu thập được (tối
// thiểu 1) để tổng hợp thay vì cố thử thêm rồi bị nền tảng hủy toàn bộ request.
const CROSS_CHECK_BUDGET_MS = Number(process.env.CROSS_CHECK_BUDGET_MS) || 45000;
// ---------- Giới hạn số AI call của Đối chiếu đa hướng (KHÔNG phụ thuộc số execution target) ----------
// TRƯỚC ĐÂY: vòng 1 gọi TẤT CẢ target eligible SONG SONG — có bao nhiêu (API key × model) đã cấu
// hình thì gọi bấy nhiêu. Với nhiều khóa/nhiều model (vd 3 key × 5 model = 15 target), 1 câu hỏi ở
// chế độ Sâu có thể tốn TỚI 15 lệnh gọi AI cùng lúc — rủi ro chi phí/rate-limit nghiêm trọng, tăng
// tuyến tính theo số target chứ không phải theo nhu cầu thực (đối chiếu 2-3 góc nhìn là đủ).
// FIX: giới hạn cứng số candidate ở vòng 1 bằng CROSS_CHECK_MAX_CANDIDATES (mặc định 3), ưu tiên ĐA
// DẠNG PROVIDER (pickDiverseCandidates — mỗi hãng khác nhau góp 1 candidate trước, chỉ lấy trùng
// hãng khi không đủ lựa chọn) thay vì random/thứ tự rotation thô — đối chiếu chéo giữa các HÃNG khác
// nhau có giá trị hơn nhiều so với 2 model cùng 1 hãng. Retry cho target lỗi cũng giới hạn ĐÚNG 1
// lượt thử thay thế mỗi slot lỗi (không lặp qua toàn bộ target còn lại) — tổng số lệnh gọi tối đa cả
// pipeline luôn bị chặn trần ở khoảng `2 × CROSS_CHECK_MAX_CANDIDATES + 1`, KHÔNG BAO GIỜ tỷ lệ thuận
// với tổng số execution target đã cấu hình (xem test/cross-check-limit.test.js).
const CROSS_CHECK_MAX_CANDIDATES = Number(process.env.CROSS_CHECK_MAX_CANDIDATES) || 3;
const { createRequestDeadline, safeCallTimeout, MIN_CALL_TIMEOUT_MS } = require('./requestDeadline');
// PHẦN J: throughput đo thật theo từng model/provider — thay hằng số 60 tok/s dùng chung.
const { recordThroughput } = require('./throughputStats');
// Vấn đề #4: hiệu chỉnh tỷ lệ ký tự/token từ số token THẬT provider báo về.
const tokenCounter = require('./tokenCounter');
const { estimateTokens } = require('./adaptiveBudget');

// ============================================================================================
// B10 — TELEMETRY TOKEN: cachedTokens / cacheSavedTokens (đo hiệu quả THẬT của A1)
// ============================================================================================
// Anthropic trả `cache_read_input_tokens` / `cache_creation_input_tokens` trong `usage`. Trước đây
// 2 field này bị BỎ QUA hoàn toàn, nên không có cách nào biết prompt caching có thật sự hoạt động
// hay không (chỉ ước lượng lý thuyết). Nay đọc và cộng dồn theo từng request.
//
// cacheSavedTokens: token đọc từ cache được tính giá ~10% so với input thường, nên phần TIẾT KIỆM
// thực tế ≈ 90% số token đã đọc từ cache. Hệ số nằm ở đúng 1 chỗ này để dễ chỉnh nếu giá đổi.
const CACHE_READ_DISCOUNT = 0.9;

function emptyUsageAccumulator() {
  return { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, cacheSavedTokens: 0, calls: 0 };
}

function accumulateUsage(acc, usage) {
  if (!acc || !usage) return acc;
  acc.calls += 1;
  acc.inputTokens += Number(usage.inputTokens) || 0;
  acc.outputTokens += Number(usage.outputTokens) || 0;
  acc.cachedTokens += Number(usage.cachedTokens) || 0;
  acc.cacheCreationTokens += Number(usage.cacheCreationTokens) || 0;
  acc.cacheSavedTokens = Math.round(acc.cachedTokens * CACHE_READ_DISCOUNT);
  return acc;
}

/**
 * Chọn tối đa `limit` target từ danh sách đã rotation-order, ƯU TIÊN đa dạng provider (mỗi hãng góp
 * 1 target trước khi lấy hãng thứ 2 cùng loại) — đối chiếu chéo giữa các HÃNG khác nhau (Claude vs
 * GPT vs Gemini...) có giá trị phát hiện sai sót cao hơn nhiều so với 2 model cùng 1 hãng.
 * @param {Array} orderedTargets Đã qua eligibleInRotationOrder() (đã lọc health + capability).
 * @param {number} limit
 * @returns {Array}
 */
function pickDiverseCandidates(orderedTargets, limit) {
  const result = [];
  const usedProviders = new Set();
  for (const t of orderedTargets) {
    if (result.length >= limit) break;
    if (!usedProviders.has(t.providerKey)) {
      result.push(t);
      usedProviders.add(t.providerKey);
    }
  }
  if (result.length < limit) {
    for (const t of orderedTargets) {
      if (result.length >= limit) break;
      if (!result.includes(t)) result.push(t);
    }
  }
  return result;
}

/**
 * Tạo 1 "đồng hồ đếm ngược" ngân sách thời gian — CHỈ dùng làm fallback khi caller KHÔNG truyền
 * `deadline` từ bên ngoài (mục 4). Ưu tiên tuyệt đối: nếu caller (chat.js) đã có 1 global request
 * deadline, PHẢI truyền xuống qua tham số `deadline` — các hàm dưới đây không được tự gọi
 * createDeadline() khi đã nhận được deadline của caller (tránh nhiều đồng hồ độc lập).
 * @deprecated dùng createRequestDeadline() từ requestDeadline.js cho code mới; giữ lại tên này để
 *   tương thích ngược cho nơi gọi cũ/test cũ.
 */
function createDeadline(budgetMs = CROSS_CHECK_BUDGET_MS) {
  return createRequestDeadline(budgetMs);
}

/**
 * Trả về danh sách execution target đã có API key hợp lệ trong .env NGAY TẠI THỜI ĐIỂM GỌI (không
 * cache) — mọi thay đổi .env có hiệu lực ngay sau khi khởi động lại server mà không cần sửa code.
 * Mỗi phần tử = 1 cặp (API Key × Model), có `.label/.supportsWebSearch/.call()/.callStream()` —
 * chữ ký giữ NGUYÊN như "provider" cũ để chat.js/generate.js/recommend.js không cần sửa gì.
 */
function getActiveProviders() {
  return getAllExecutionTargets();
}

/**
 * ensureProvidersReady(): warm model discovery cache cho MỌI provider đang có API key nhưng KHÔNG
 * dùng legacy explicit modelEnv (mục 2/9) — PHẢI gọi (await) hàm này TRƯỚC getActiveProviders() ở
 * mọi route thật (chat.js/generate.js/recommend.js/study.js) để auto-discovery có hiệu lực.
 *
 * KHÔNG throw: discovery lỗi ở 1 provider không được làm hỏng các provider khác (mục 9) — mỗi
 * (provider, khóa API) được warm ĐỘC LẬP qua Promise.allSettled; provider nào discovery thất bại
 * và không có cache cũ thì đơn giản không sinh execution target nào (đã xử lý trong modelDiscovery/
 * executionTargets), request vẫn tiếp tục chạy với các provider còn lại.
 *
 * Cache có TTL (modelDiscovery.js) nên các request sau không phải chờ gọi API discovery lại (mục 8).
 * @returns {Promise<void>}
 */
async function ensureProvidersReady() {
  // Vấn đề #3: nạp trạng thái rotation/cooldown dùng chung (nếu ROTATION_STORE_* được cấu hình) —
  // best-effort, không bao giờ throw, không chặn request nếu store chậm/lỗi.
  await rotationStore.hydrate().catch(() => false);
  // Vấn đề #1 (vòng 3): đặt trước "vé xoay" toàn cục bằng atomic INCR — đây là chỗ DUY NHẤT trong
  // vòng đời request còn là async trước khi rotation phải quyết định, nên là chỗ đúng để làm việc này.
  const slot = await rotationStore.reserveRotationSlot().catch(() => null);
  setGlobalRotationSlot(slot);
  const defs = listAutoDiscoveryDefs();
  if (!defs.length) return;
  await Promise.allSettled(
    defs.flatMap((def) =>
      def.apiKeys.map((apiKey) => warmDiscovery(def.baseKey, apiKey, def.discoveryProvider, def.discoveryConfig))
    )
  );
}

/**
 * Sau lỗi "model không khả dụng" (404/deprecated) ở runtime thật (mục 21): buộc discovery lại ở
 * lượt request TIẾP THEO cho đúng (provider, khóa) đó thay vì tiếp tục coi model cũ là hợp lệ tới
 * hết TTL cache. KHÔNG rebuild target giữa chừng của request đang chạy (rotationManager đã cooldown
 * đúng target/model đó rồi — đủ để failover an toàn NGAY LƯỢT NÀY); cache invalidation chỉ đảm bảo
 * lượt SAU sẽ discovery lại thay vì lặp lại đúng model hỏng đó.
 */
function invalidateModelIfNeeded(target, classification) {
  if (!target || target.usingLegacyOverride) return; // legacy override do người dùng tự khai — không tự ý discovery lại
  if (classification && classification.scope === 'model') {
    invalidateModelCache(target.providerKey, target.apiKeyOverride);
  }
}

/** Health hiện tại của mọi execution target — dùng cho admin/debug (mục 25), không lộ khóa thật. */
function getRotationHealth() {
  return getHealthSnapshot(getAllExecutionTargets());
}

/**
 * Lọc + sắp thứ tự target sẵn sàng thử, theo capability yêu cầu (mục 6) rồi theo rotation công bằng
 * (mục 4/21). Dùng chung cho callWithFailover/streamWithFailover (nơi cần thử TUẦN TỰ, công bằng).
 */
function eligibleInRotationOrder(providers, { preferWebSearch = false, requireVision = false } = {}) {
  const eligible = getEligibleTargets(providers, { requireVision });
  const ordered = orderByRotation(eligible);
  if (!preferWebSearch) return ordered;
  const withSearch = ordered.filter((p) => p.supportsWebSearch);
  const withoutSearch = ordered.filter((p) => !p.supportsWebSearch);
  return [...withSearch, ...withoutSearch];
}

/**
 * Thu thập nhiều lượt giải ĐỘC LẬP song song cho chế độ "Đối chiếu đa hướng" (giai đoạn giải chi
 * tiết), có ngân sách thời gian TỔNG dùng chung (xem CROSS_CHECK_BUDGET_MS ở trên). Chạy TẤT CẢ các
 * lượt thử lại SONG SONG với nhau (Promise.allSettled lồng Promise.allSettled) — giảm mạnh thời gian
 * chờ tệ nhất khi có từ 2 target lỗi trở lên.
 *
 * @param {Array} providers Danh sách execution target đang hoạt động (từ getActiveProviders()).
 * @param {{system:string, variantSystem:string, messages:Array, maxTokens:number, onStatus?:Function,
 *   deadline?:object}} args `deadline` (mục 4): nếu caller (chat.js) đã có 1 global request deadline,
 *   PHẢI truyền vào đây — hàm này sẽ KHÔNG tự tạo đồng hồ riêng nữa, dùng chung đúng đồng hồ đó.
 *   Nếu không truyền (gọi trực tiếp/test cũ), fallback về đồng hồ CROSS_CHECK_BUDGET_MS riêng như cũ.
 * @returns {Promise<{candidates:Array<{label:string,text:string}>, deadline:object}>}
 */
// ============================================================================================
// B2 ROOT CAUSE (đã xác nhận bằng code, KHÔNG phải giả thuyết) — `reasoningBudget` BỊ RƠI MẤT
// ============================================================================================
// chat.js LUÔN truyền `reasoningBudget: budgetOf('candidate').reasoningBudget` vào hàm này (2 chỗ:
// nhánh streaming và nhánh JSON). Nhưng chữ ký CŨ của hàm KHÔNG hề destructure field đó, và cả 3
// điểm gọi `p.call(...)` bên trong (round 1, retry, survivor) đều không forward nó xuống execution
// target. Hệ quả: MỌI candidate cross-check chạy với reasoningBudget = undefined -> mỗi client rơi
// về nhánh legacy (`nativeThinkingBudget(maxTokens)` với Anthropic, tức reasoning ĂN VÀO answer
// budget đúng như lỗi gốc mà reasoningPolicy.js sinh ra để sửa; Gemini/OpenAI thì không nhận được
// cấu hình reasoning tường minh nào). Đây chính là "reasoningBudget tính xong nhưng không truyền
// xuống provider client thật" mà B1 cảnh báo — và nó xảy ra ở ĐÚNG nhánh tốn token nhất.
//
// FIX: nhận `reasoningBudget` trong chữ ký và forward NGUYÊN VẸN vào cả 3 điểm gọi. Client nào
// không hỗ trợ reasoning native sẽ tự bỏ qua field này (PHẦN 29) nên việc truyền luôn là an toàn.
async function gatherCrossCheckCandidates(providers, { system, variantSystem, messages, maxTokens, reasoningBudget, onStatus, deadline: parentDeadline, requestId, deepThinking, requireVision = false, signal, maxCandidates = CROSS_CHECK_MAX_CANDIDATES }) {
  const deadline = parentDeadline || createDeadline();
  const notify = typeof onStatus === 'function' ? onStatus : () => {};
  // B10: usage THẬT cộng dồn cho toàn bộ vòng thu thập candidate (kể cả retry/survivor).
  const usage = emptyUsageAccumulator();
  // mục 4: client đã hủy TRƯỚC KHI kịp gọi provider nào -> không tốn 1 lệnh gọi AI nào, trả candidates rỗng ngay.
  if (signal && signal.aborted) return { candidates: [], deadline, usage };
  // Mục 5: KHÔNG dùng Math.max(MIN, remaining) làm timeout — nếu ngân sách còn lại dưới sàn tối
  // thiểu, safeCallTimeout() trả về null và caller PHẢI bỏ qua lệnh gọi đó (coi như hết ngân sách),
  // không được ép timeout dài hơn thời gian thực sự còn lại.
  const timeoutFor = (base) => safeCallTimeout(base, deadline);

  // ---------- Vòng 1: TỐI ĐA maxCandidates target, ưu tiên đa dạng provider ----------
  // PHẦN 10 FIX: maxCandidates nay CÓ THỂ nhỏ hơn CROSS_CHECK_MAX_CANDIDATES khi caller (chat.js)
  // đã đánh giá risk=LOW qua crossCheckPolicy() — bài đơn giản không cần đủ 3 candidate mới đối
  // chiếu được, 2 candidate vẫn cho phép so khớp (candidatesAgree) mà tốn ít lệnh gọi AI hơn. Risk
  // MEDIUM/HIGH vẫn giữ nguyên CROSS_CHECK_MAX_CANDIDATES đầy đủ (không giảm khi thực sự cần).
  const round1Order = pickDiverseCandidates(eligibleInRotationOrder(providers, { requireVision }), Math.max(2, Math.min(maxCandidates, CROSS_CHECK_MAX_CANDIDATES)));
  const firstRound = await Promise.allSettled(
    round1Order.map((p) => {
      const t = timeoutFor(30000);
      if (t === null) return Promise.reject(new Error('Hết ngân sách thời gian request trước khi kịp gọi provider này.'));
      const startedAt = Date.now();
      const meta = {};
      return p.call({ system: variantSystem, messages, maxTokens, reasoningBudget, timeoutMs: t, deepThinking, signal, meta })
        .then((text) => { accumulateUsage(usage, meta.usage); logAttempt({ requestId, stage: 'cross_check_round1', target: p, latency: Date.now() - startedAt, status: 'success', usage: meta.usage, answerBudget: maxTokens, reasoningBudget, providerMaxTokens: meta.providerMaxTokens, finishReason: meta.finishReason, estimatedOutputTokens: estimateTokens(text) }); return text; })
        .catch((err) => { logAttempt({ requestId, stage: 'cross_check_round1', target: p, latency: Date.now() - startedAt, status: 'error', err }); throw err; });
    })
  );

  // Mọi text ở bước THU THẬP candidate này đi tiếp vào prompt của lượt TỔNG HỢP cuối (không hiển
  // thị trực tiếp cho người dùng ở bước này) — nhưng vẫn strip <thinking>/<think> ngay tại đây để
  // lượt tổng hợp không bị "loãng" ngữ cảnh bởi nháp suy luận của từng lượt giải độc lập.
  const candidates = [];
  const failedProviders = [];
  // PHẦN 14 FIX: theo dõi scope lỗi round 1 theo target.id — nếu là 'invalid_request' (payload sai),
  // KHÔNG thử lại bằng target khác vì lỗi chắc chắn lặp lại y hệt (tốn thêm 1 lệnh gọi AI vô ích).
  const invalidRequestTargetIds = new Set();
  firstRound.forEach((r, i) => {
    if (r.status === 'rejected') {
      const classification = markFailure(round1Order[i], r.reason);
      if (classification.scope === 'invalid_request') invalidRequestTargetIds.add(round1Order[i].id);
    } else markSuccess(round1Order[i]);
    const text = r.status === 'fulfilled' ? stripThinkingTags(r.value) : '';
    if (text) candidates.push({ label: round1Order[i].label, text });
    else failedProviders.push(round1Order[i]);
  });

  // ---------- Thử lại các target lỗi — GIỚI HẠN ĐÚNG 1 lượt thay thế mỗi slot lỗi (không lặp qua
  // toàn bộ target còn lại — giữ tổng số lệnh gọi bị chặn trần, không tỷ lệ thuận số target) ----------
  const retryableFailedProviders = failedProviders.filter((p) => !invalidRequestTargetIds.has(p.id));
  if (retryableFailedProviders.length && !deadline.expired()) {
    notify('Đang thử lại các nhà cung cấp gặp lỗi…');
    // ---------- B7: KHÔNG được trao CÙNG 1 target thay thế cho NHIỀU slot lỗi ----------
    // BUG CŨ: mỗi slot lỗi tự tính `others` từ cùng một pool rồi lấy `others[0]` — 2 slot lỗi thì
    // CẢ HAI cùng nhận đúng target D (fan-out vô ích: 2 lệnh gọi AI trùng hệt nhau, và nếu D cũng
    // hỏng thì hỏng gấp đôi). Ngoài ra `others[0] || failed` còn gọi lại CHÍNH target vừa bị
    // markFailure (đang cooldown) — đúng thứ B7 cấm.
    // NAY: `claimedRetryIds` được điền ĐỒNG BỘ (trước mọi `await`) nên mỗi slot lỗi nhận một target
    // KHÁC NHAU; hết target khả dụng -> bỏ qua slot đó, giữ số candidate hợp lệ hiện có.
    const claimedRetryIds = new Set(round1Order.map((p) => p.id));
    const retryOutcomes = await Promise.allSettled(
      retryableFailedProviders.map(async (failed) => {
        const others = eligibleInRotationOrder(
          providers.filter((p) => p.id !== failed.id && !claimedRetryIds.has(p.id)),
          { requireVision }
        );
        const replacement = others[0]; // ĐÚNG 1 ứng viên thay thế, không loop toàn bộ pool
        if (!replacement) throw new Error('Không còn execution target nào khác để thử lại — giữ nguyên các candidate đã thu thập được.');
        claimedRetryIds.add(replacement.id);
        const t = timeoutFor(20000);
        if (deadline.expired() || t === null) throw new Error('Hết ngân sách thời gian request — bỏ qua thử lại.');
        const startedAt = Date.now();
        try {
          const retryMeta = {};
          const text = stripThinkingTags(await replacement.call({ system: variantSystem, messages, maxTokens, reasoningBudget, timeoutMs: t, deepThinking, signal, meta: retryMeta }));
          accumulateUsage(usage, retryMeta.usage);
          logAttempt({ requestId, stage: 'cross_check_retry', target: replacement, latency: Date.now() - startedAt, status: text ? 'success' : 'empty', usage: retryMeta.usage, answerBudget: maxTokens, reasoningBudget, finishReason: retryMeta.finishReason, retry: true, estimatedOutputTokens: estimateTokens(text || '') });
          if (text) { markSuccess(replacement); return { label: replacement.label, text }; }
        } catch (e) {
          logAttempt({ requestId, stage: 'cross_check_retry', target: replacement, latency: Date.now() - startedAt, status: 'error', err: e, answerBudget: maxTokens, reasoningBudget, retry: true });
          markFailure(replacement, e);
        }
        throw new Error('Không còn target nào khả dụng để thử lại trong ngân sách thời gian cho phép.');
      })
    );
    retryOutcomes.forEach((r) => { if (r.status === 'fulfilled') candidates.push(r.value); });
  }

  // ---------- Vẫn chưa đủ 2 lượt để đối chiếu chéo: dùng chính target còn sống làm thêm 1 lượt ----------
  const survivorTimeout = timeoutFor(15000);
  if (candidates.length === 1 && !deadline.expired() && survivorTimeout !== null) {
    const survivor = providers.find((p) => candidates[0].label === p.label) || providers[0];
    // FIX P1/G (audit): TRƯỚC ĐÂY temperature:0.4 bị áp CỨNG cho MỌI provider ở lượt "góc nhìn khác"
    // này, kể cả Gemini — trái best-practice của Gemini (đặc biệt Gemini 3, khuyến nghị dùng
    // temperature mặc định/provider-safe thay vì ép thấp một cách mù quáng). Chỉ áp temperature cố
    // định cho provider KHÔNG PHẢI Gemini; Gemini dùng default của chính model (không set field này).
    const survivorTemperature = survivor.providerKey === 'gemini' ? undefined : 0.4;
    try {
      const survivorMeta = {};
      const extra = stripThinkingTags(await survivor.call({ system, messages, maxTokens, reasoningBudget, temperature: survivorTemperature, timeoutMs: survivorTimeout, deepThinking, signal, meta: survivorMeta }));
      accumulateUsage(usage, survivorMeta.usage);
      if (extra) { markSuccess(survivor); candidates.push({ label: survivor.label + ' (góc nhìn khác)', text: extra }); }
    } catch (e) { markFailure(survivor, e); /* không còn cách nào khác trong ngân sách — dùng đúng 1 lượt hiện có */ }
  }

  return { candidates, deadline, usage };
}

/**
 * Gọi LẦN LƯỢT các execution target theo thứ tự rotation công bằng (mục 4/21) cho tới khi có 1 lượt
 * thành công — không có target "mặc định" cố định nào luôn được thử trước; qua nhiều request liên
 * tiếp mọi target đều lần lượt được ưu tiên thử trước (xem rotationManager.orderByRotation). Nếu
 * target được chọn báo lỗi (API key sai, hết hạn mức, lỗi 5xx, timeout mạng...), hàm TỰ ĐỘNG chuyển
 * sang thử target tiếp theo — người dùng không thấy lỗi trừ khi TẤT CẢ target đều lỗi.
 * Dùng cho lượt TỔNG HỢP ở chế độ Sâu (chỉ cần 1 kết quả chắc chắn, không cần nhanh nhất).
 *
 * @param {Array} providers Danh sách execution target đang hoạt động (từ getActiveProviders()).
 * @param {object} args Tham số truyền cho call() của target: {system, messages, maxTokens, temperature, webSearch, fast, timeoutMs}.
 * @param {{preferWebSearch?: boolean, deadline?: object}} [opts] `deadline` (mục 4/6): global request
 *   deadline truyền từ chat.js — nếu có, dùng CHUNG đồng hồ đó thay vì tự tạo FAILOVER_BUDGET_MS riêng.
 * @returns {Promise<{text:string, provider:object, tried:Array}>}
 */
// ---------- NGÂN SÁCH THỜI GIAN TỔNG cho callWithFailover ----------
// NGUYÊN NHÂN GỐC của "chờ rất lâu mới biết TẤT CẢ target đều lỗi": trước đây mỗi target được thử
// TUẦN TỰ với ĐẦY ĐỦ timeoutMs riêng (mặc định ~30s) — với 3 target đã cấu hình, trường hợp xấu nhất
// (cả 3 đều lỗi/quá tải) người dùng phải chờ tới ~90s mới thấy thông báo lỗi.
// FIX: áp dụng ngân sách thời gian TỔNG dùng chung cho toàn bộ vòng thử — timeout của MỖI target tự
// co lại theo ngân sách còn lại, và khi ngân sách gần hết (đã thử được ít nhất 1 target), hệ thống
// NGỪNG thử thêm và báo lỗi ngay thay vì kéo dài vô thời hạn theo số target đã cấu hình.
// CHỈ dùng làm fallback khi KHÔNG có deadline của caller (mục 4) — xem opts.deadline ở trên.
const FAILOVER_BUDGET_MS = Number(process.env.FAILOVER_BUDGET_MS) || 65000;

async function callWithFailover(providers, args, { preferWebSearch = false, requireVision = false, deadline: parentDeadline } = {}) {
  if (!providers || !providers.length) {
    const err = new Error('Chưa có nhà cung cấp AI nào được cấu hình (thiếu API key trong .env).');
    err.status = 500;
    throw err;
  }
  if (args && args.signal && args.signal.aborted) {
    const err = new Error('Yêu cầu đã bị hủy.');
    err.status = 499; err.code = 'CANCELLED'; err.cancelled = true;
    throw err;
  }

  const order = eligibleInRotationOrder(providers, { preferWebSearch, requireVision });
  const deadline = parentDeadline || createDeadline(FAILOVER_BUDGET_MS);
  const tried = [];
  let lastClassification;
  for (const p of order) {
    if (deadline.expired() && tried.length) break; // đã thử ít nhất 1 target và cạn ngân sách — dừng, báo lỗi ngay
    // Mục 5: KHÔNG ép timeout lên MIN_CALL_TIMEOUT_MS nếu remaining < MIN — bỏ qua target này thay vì
    // gọi với timeout dài hơn thời gian thực sự còn lại của deadline.
    const callTimeout = safeCallTimeout(args.timeoutMs || 30000, deadline);
    if (callTimeout === null) {
      if (tried.length) break; // đã thử ít nhất 1 target, hết ngân sách an toàn — dừng, báo lỗi ngay
      tried.push({ label: p.label, error: 'Không còn đủ ngân sách thời gian request để gọi an toàn.' });
      continue; // chưa thử target nào — vẫn thử nốt các target khác trong order (may đủ maxTokens nhỏ nếu khác nguyên nhân), nhưng KHÔNG ép timeout dài hơn deadline
    }
    const attemptStartedAt = Date.now();
    try {
      // mục 1 (completion-first): meta là kênh phụ để client (anthropic/openai/gemini/compatible)
      // trả finish_reason/stop_reason THẬT ra ngoài mà KHÔNG đổi kiểu trả về (vẫn Promise<string>) —
      // tránh phải sửa mọi nơi đang destructure kết quả p.call() như 1 chuỗi.
      const meta = {};
      const text = stripThinkingTags(await p.call({ ...args, timeoutMs: callTimeout, meta }));
      const failoverLatency = Date.now() - attemptStartedAt;
      logAttempt({ requestId: args.requestId, stage: args.telemetryStage || 'failover', target: p, latency: failoverLatency, status: text ? 'success' : 'empty', usage: meta.usage, answerBudget: args.maxTokens, reasoningBudget: args.reasoningBudget, providerMaxTokens: meta.providerMaxTokens, finishReason: meta.finishReason, recovery: !!args.telemetryRecovery, estimatedOutputTokens: estimateTokens(text || '') });
      if (text) {
        markSuccess(p, failoverLatency);
        const realOutNs = meta.usage && Number(meta.usage.outputTokens);
        if (Number.isFinite(realOutNs) && realOutNs > 0) tokenCounter.recordUsage(p.providerKey, { text, tokens: realOutNs });
        recordThroughput(p, {
          outputTokens: Number.isFinite(realOutNs) && realOutNs > 0 ? realOutNs : estimateTokens(text),
          elapsedMs: failoverLatency
        });
        return { text, provider: p, tried, finishReason: meta.finishReason || null, interrupted: false, latencyMs: failoverLatency, usage: meta.usage || null };
      }
      tried.push({ label: p.label, error: 'Phản hồi rỗng' });
    } catch (err) {
      // mục 4: bị hủy (client disconnect/bấm Dừng) — KHÔNG coi là lỗi provider, dừng failover ngay,
      // không thử target khác (mọi target khác cũng sẽ abort ngay lập tức vì DÙNG CHUNG 1 signal).
      if (err && err.cancelled) throw err;
      const classification = markFailure(p, err);
      invalidateModelIfNeeded(p, classification);
      lastClassification = classification;
      logAttempt({ requestId: args.requestId, stage: args.telemetryStage || 'failover', target: p, latency: Date.now() - attemptStartedAt, status: 'error', err, answerBudget: args.maxTokens, reasoningBudget: args.reasoningBudget, recovery: !!args.telemetryRecovery });
      // P0 mục 2: KHÔNG BAO GIỜ lộ err.message thô (có thể chứa chi tiết billing/nội bộ của provider)
      // ra danh sách `tried` (field này đi thẳng vào response client qua errorHandler.js) — luôn dùng
      // sanitizedMessage đã được errorClassifier.js chuẩn hóa, bất kể loại lỗi (không chỉ billing).
      tried.push({ label: p.label, error: classification.sanitizedMessage });
      // PHẦN 14 FIX: lỗi 'invalid_request' (payload/schema sai — vd 400/404/422) sẽ lặp lại Y HỆT ở
      // MỌI target khác (không phải lỗi của key/model, mà là lỗi của chính request đang gửi) — thử
      // tiếp target khác chỉ tốn thêm lệnh gọi AI vô ích, không bao giờ thành công. Dừng NGAY, không
      // retry toàn pool.
      if (classification.scope === 'invalid_request') break;
      // KHÔNG throw ngay — tự động thử target tiếp theo (failover).
    }
  }

  const err = new Error(
    'Tất cả nhà cung cấp AI đã cấu hình đều gặp lỗi khi trả lời.' +
    (lastClassification ? ' Lỗi gần nhất: ' + lastClassification.sanitizedMessage : '')
  );
  err.status = 502;
  err.code = 'PROVIDER_ERROR';
  err.triedProviders = tried;
  throw err;
}

// ---------- PHẦN 9: FAST MODE — SINGLE CALL BEFORE RACE ----------
// TRƯỚC ĐÂY: callFastest() luôn đua >= 2 target (Math.max(2, ...)) BẤT KỂ raceSize truyền vào là
// gì — mọi request "Nhanh" đều đốt 2 lệnh gọi AI kể cả khi target đầu tiên trả lời tức thì. NAY:
// mặc định CHỈ 1 lệnh gọi (single call). Chỉ đua thêm 1 target khi thực sự cần latency thấp:
//   - opts.latencyCritical === true (caller yêu cầu rõ ràng), HOẶC
//   - target ứng viên chính có lịch sử chậm (isTargetSlow(), EMA latency > ngưỡng), HOẶC
//   - lượt gọi ĐANG chạy vượt quá T_FAST_RACE_THRESHOLD_MS mà chưa xong (đua "cứu viện" giữa chừng).
// "one good call beats several speculative calls" (mục 15/24.5).
const T_FAST_RACE_THRESHOLD_MS = Number(process.env.T_FAST_RACE_THRESHOLD_MS) || 3500;

// Telemetry THẬT (không phải log-only) — dùng trong test để chứng minh default = 1 call (mục PHẦN 9,
// PHẦN 22 mục 9/10). Không lộ API key/prompt/response, chỉ đếm số lượt.
const fastModeStats = { singleCallFast: 0, racedCallFast: 0, raceSavedLatencyMs: 0, raceWastedCalls: 0 };
function getFastModeStats() { return { ...fastModeStats }; }
function _resetFastModeStatsForTest() {
  fastModeStats.singleCallFast = 0; fastModeStats.racedCallFast = 0;
  fastModeStats.raceSavedLatencyMs = 0; fastModeStats.raceWastedCalls = 0;
}

/**
 * Gọi 1 target, trả {text, provider} hoặc throw — dùng chung cho single-call và race attempts.
 * Ghi nhận latency thật vào rotationManager (markSuccess(p, latencyMs)) để nuôi isTargetSlow().
 */
function attemptTarget(p, raceArgs, tried, requestId) {
  const startedAt = Date.now();
  const meta = {};
  return p.call({ ...raceArgs, meta })
    // strip <thinking>/<think>: text ở đây được trả THẲNG cho người dùng — xem đầu thinkingFilter.js.
    .then((text) => {
      const visible = stripThinkingTags(text);
      if (!visible) throw new Error('Phản hồi rỗng');
      const latency = Date.now() - startedAt;
      logAttempt({ requestId, stage: 'fast', target: p, latency, status: 'success' });
      markSuccess(p, latency);
      recordThroughput(p, { outputTokens: estimateTokens(visible), elapsedMs: latency });
      return { text: visible, provider: p, _latencyMs: latency, finishReason: meta.finishReason || null };
    })
    .catch((err) => {
      logAttempt({ requestId, stage: 'fast', target: p, latency: Date.now() - startedAt, status: 'error', err });
      const classification = markFailure(p, err);
      invalidateModelIfNeeded(p, classification);
      // P0 mục 2: luôn dùng sanitizedMessage (không chỉ cho lỗi billing) — xem giải thích ở
      // callWithFailover() phía trên.
      tried.push({ label: p.label, error: classification.sanitizedMessage });
      // PHẦN 14 FIX: đánh dấu scope lên err để callFastest() biết mà KHÔNG đua/fallback thêm khi
      // lỗi là 'invalid_request' (payload sai — lặp lại y hệt ở mọi target khác, đua/fallback thêm
      // chỉ tốn thêm lệnh gọi AI vô ích).
      err._scope = classification.scope;
      throw err;
    });
}

/**
 * "Chế độ Nhanh" — mặc định 1 lệnh gọi AI (mục PHẦN 9). Chỉ đua thêm 1 target khi latency-critical,
 * target chính có lịch sử chậm, hoặc lượt gọi hiện tại vượt ngưỡng T_FAST_RACE_THRESHOLD_MS.
 *
 * @param {Array} providers Danh sách execution target đang hoạt động.
 * @param {object} args Tham số truyền cho call() của target (nên kèm `fast:true` để dùng model nhẹ/nhanh).
 * @param {{raceSize?: number, deadline?: object, latencyCritical?: boolean}} [opts] `deadline` (mục
 *   4/6): giới hạn timeoutMs của lệnh gọi. `latencyCritical`: buộc đua ngay từ đầu (vd UI đã đợi
 *   lâu ở lượt trước). `raceSize` giữ để backward-compat (nếu caller cũ truyền raceSize<=1, không
 *   bao giờ ép đua — khác hành vi cũ luôn ép tối thiểu 2).
 * @returns {Promise<{text:string, provider:object, tried:Array}>}
 */
async function callFastest(providers, args, { raceSize, deadline, requireVision = false, latencyCritical = false } = {}) {
  if (!providers || !providers.length) {
    const err = new Error('Chưa có nhà cung cấp AI nào được cấu hình (thiếu API key trong .env).');
    err.status = 500;
    throw err;
  }
  if (args && args.signal && args.signal.aborted) {
    const err = new Error('Yêu cầu đã bị hủy.');
    err.status = 499; err.code = 'CANCELLED'; err.cancelled = true;
    throw err;
  }
  const eligible = getEligibleTargets(providers, { requireVision });
  if (!eligible.length) {
    return callWithFailover(providers, args, { deadline, requireVision });
  }
  if (eligible.length === 1) {
    return callWithFailover(eligible, args, { deadline, requireVision });
  }

  // Mục 6: nếu có deadline chung, co timeoutMs của MỌI lệnh gọi trong nhóm đua theo ngân sách còn
  // lại — không để 1 lệnh đua chạy dài hơn thời gian thực sự còn của request.
  const raceArgs = deadline
    ? { ...args, timeoutMs: safeCallTimeout(args.timeoutMs || 30000, deadline) || 1 }
    : args;

  const order = shuffle(eligible);
  const primary = order[0];
  const rest = order.slice(1);
  const tried = [];

  // raceSize<=1 explicit từ caller = không bao giờ đua, kể cả khi chậm/latencyCritical (tôn trọng
  // ý caller rõ ràng — vd 1 test cũ hoặc use-case chỉ muốn tuyệt đối 1 lệnh gọi).
  const racingAllowed = !(typeof raceSize === 'number' && raceSize <= 1);
  const primarySlow = racingAllowed && isTargetSlow(primary, T_FAST_RACE_THRESHOLD_MS);
  const raceImmediately = racingAllowed && (latencyCritical || primarySlow) && rest.length > 0;

  async function fallbackToRemaining(afterErr) {
    // PHẦN 14 FIX: lỗi 'invalid_request' lặp lại y hệt ở MỌI target (lỗi của chính request, không
    // phải của key/model cụ thể) — thử thêm target khác trong `rest` chỉ tốn thêm lệnh gọi AI vô
    // ích và chắc chắn thất bại giống hệt. Dừng ngay, không fallback toàn pool. `afterErr` có thể là
    // AggregateError (từ Promise.any khi cả nhóm đua đều lỗi) — kiểm tra cả `.errors[]`.
    const errorList = (afterErr && Array.isArray(afterErr.errors)) ? afterErr.errors : [afterErr];
    if (errorList.some((e) => e && e._scope === 'invalid_request')) {
      const err = new Error('Yêu cầu không hợp lệ.');
      err.status = 400;
      err.code = 'PROVIDER_ERROR';
      err.triedProviders = tried;
      throw err;
    }
    if (rest.length) {
      try { return await callWithFailover(rest, raceArgs, { deadline, requireVision }); }
      catch (e) { /* rơi xuống báo lỗi chung bên dưới */ }
    }
    const err = new Error('Tất cả nhà cung cấp AI đã cấu hình đều gặp lỗi khi trả lời.');
    err.status = 502;
    err.code = 'PROVIDER_ERROR';
    err.triedProviders = tried;
    throw err;
  }

  const primaryPromise = attemptTarget(primary, raceArgs, tried, args && args.requestId);

  if (raceImmediately) {
    // Latency-critical hoặc target chính có lịch sử chậm -> đua ngay từ đầu (không chờ threshold).
    fastModeStats.racedCallFast += 1;
    try {
      const result = await Promise.any([primaryPromise, attemptTarget(rest[0], raceArgs, tried, args && args.requestId)]);
      return { ...result, tried };
    } catch (e) { return fallbackToRemaining(e); }
  }

  if (!racingAllowed || !rest.length) {
    try { const r = await primaryPromise; fastModeStats.singleCallFast += 1; return { ...r, tried }; }
    catch (e) { return fallbackToRemaining(e); }
  }

  // Mặc định: 1 lệnh gọi. Chỉ đua "cứu viện" nếu lệnh chính CHƯA xong sau T_FAST_RACE_THRESHOLD_MS.
  let settled = false;
  const timeoutSignal = new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), T_FAST_RACE_THRESHOLD_MS);
    if (t.unref) t.unref();
  });
  const primaryOutcome = primaryPromise.then(
    (r) => { settled = true; return { kind: 'ok', r }; },
    (e) => { settled = true; return { kind: 'err', e }; }
  );

  const first = await Promise.race([primaryOutcome, timeoutSignal]);

  if (first !== 'timeout') {
    fastModeStats.singleCallFast += 1;
    if (first.kind === 'ok') return { ...first.r, tried };
    return fallbackToRemaining(first.e);
  }

  // Primary vượt ngưỡng nhưng vẫn có thể xong hợp lệ — đua thêm 1 target song song thay vì bỏ nó dở
  // dang (đã tốn tiền/latency rồi, hủy giữa chừng còn lãng phí hơn).
  fastModeStats.racedCallFast += 1;
  const raceStartedAt = Date.now();
  try {
    const result = await Promise.any([primaryPromise, attemptTarget(rest[0], raceArgs, tried, args && args.requestId)]);
    // raceSavedLatencyMs: phần thời gian tiết kiệm được so với việc CHỜ TIẾP primary sau ngưỡng —
    // đo bằng chênh lệch giữa lúc race bắt đầu (đã qua threshold) và lúc có kết quả thắng cuộc.
    fastModeStats.raceSavedLatencyMs += Math.max(0, Date.now() - raceStartedAt);
    // Trong 1 nhóm đua 2 target, đúng 1 lệnh sẽ KHÔNG được dùng (thắng/thua) — token của lệnh đó
    // là chi phí thật đã trả cho latency thấp hơn (đánh đổi có chủ đích, không phải lãng phí ẩn).
    fastModeStats.raceWastedCalls += 1;
    return { ...result, tried };
  } catch (e) { return fallbackToRemaining(e); }
}

/**
 * Bản streaming của callWithFailover(): thử LẦN LƯỢT các execution target theo thứ tự rotation công
 * bằng, phát từng đoạn văn bản (delta) qua onDelta ngay khi nhận được từ target ĐANG thử — giống
 * hiệu ứng "gõ chữ" trực tiếp trên giao diện thay vì đợi trả lời xong toàn bộ rồi mới hiển thị.
 *
 * Failover CHỈ áp dụng trước khi target hiện tại phát ra delta đầu tiên (lỗi kết nối/xác thực/quá
 * tải xảy ra ngay khi mở stream) — một khi đã có ít nhất 1 đoạn văn bản được gửi tới người dùng, hệ
 * thống "cam kết" với target đó tới cùng dù nó có lỗi giữa chừng (không thể lặng lẽ đổi target khi
 * người dùng đã thấy 1 phần câu trả lời trên màn hình — sẽ gây rối loạn nội dung, mục 17). Nếu lỗi
 * giữa chừng như vậy xảy ra, những gì đã stream được vẫn được coi là kết quả cuối cùng.
 *
 * @param {Array} providers Danh sách execution target đang hoạt động (từ getActiveProviders()).
 * @param {object} args Tham số truyền cho callStream() của target.
 * @param {Function} onDelta Callback nhận từng đoạn văn bản mới.
 * @param {{preferWebSearch?: boolean, deadline?: object}} [opts] `deadline` (mục 4/6): nếu có, co
 *   timeoutMs của mỗi target thử theo ngân sách còn lại thay vì dùng nguyên args.timeoutMs.
 * @returns {Promise<{text:string, provider:object, tried:Array}>}
 */
async function streamWithFailover(providers, args, onDelta, { preferWebSearch = false, requireVision = false, deadline } = {}) {
  if (!providers || !providers.length) {
    const err = new Error('Chưa có nhà cung cấp AI nào được cấu hình (thiếu API key trong .env).');
    err.status = 500;
    throw err;
  }
  if (args && args.signal && args.signal.aborted) {
    const err = new Error('Yêu cầu đã bị hủy.');
    err.status = 499; err.code = 'CANCELLED'; err.cancelled = true;
    throw err;
  }

  const order = eligibleInRotationOrder(providers, { preferWebSearch, requireVision });

  const tried = [];
  let lastClassification;
  for (const p of order) {
    if (typeof p.callStream !== 'function') { tried.push({ label: p.label, error: 'Không hỗ trợ streaming' }); continue; }
    if (deadline) {
      const t = safeCallTimeout(args.timeoutMs || 30000, deadline);
      if (t === null) { tried.push({ label: p.label, error: 'Không còn đủ ngân sách thời gian request để gọi an toàn.' }); continue; }
      args = { ...args, timeoutMs: t };
    }
    // committed chỉ bật khi có ÍT NHẤT 1 đoạn văn bản THẬT (ngoài khối <thinking>/<think>) đã
    // forward ra ngoài qua onDelta — KHÔNG bật chỉ vì đã nhận raw piece từ target. Nhờ vậy nếu 1
    // target chỉ mới stream xong (hoặc lỗi giữa chừng) trong lúc TOÀN BỘ những gì nhận được vẫn còn
    // nằm trong khối thinking (chưa có gì hiển thị cho người dùng), hệ thống vẫn coi là AN TOÀN để
    // failover sang target khác.
    let committed = false;
    // PHẦN B FIX (ROOT CAUSE #1): giữ CHÍNH XÁC phần text ĐÃ được forward tới người dùng ở lượt này.
    // TRƯỚC ĐÂY khi provider chết giữa stream, hàm này trả về `{ text: '', ..., partialError }` —
    // text RỖNG! Toàn bộ phần đã sinh chỉ còn tồn tại trong biến `full` của closure onDelta ở
    // chat.js, và `partialError` thì KHÔNG CÓ NƠI NÀO ĐỌC (caller chỉ destructure
    // `{provider, finishReason}`). Hệ quả dây chuyền:
    //   (a) caller không biết lượt gọi đã bị NGẮT -> finishReason=null -> completeness phải đoán mò;
    //   (b) target vừa chết KHÔNG được markFailure -> không cooldown -> vẫn eligible -> rotation có
    //       thể trao lại ĐÚNG target đó cho lượt continuation -> chết y hệt -> lặp tới khi cạn
    //       reserve -> phát "error" với thông điệp "Câu trả lời chưa đầy đủ sau khi đã thử khôi
    //       phục — không thể coi là hoàn thành." (chính lỗi người dùng báo).
    // NAY: text đã sinh được TRẢ VỀ đầy đủ, kèm cờ `interrupted` để caller chuyển sang RESUME MODE,
    // và target chết bị markFailure để rotation chắc chắn đưa lượt tiếp theo sang target KHÁC.
    let attemptText = '';
    // Ghép 2 lớp lọc streaming theo đúng thứ tự: (1) bỏ khối <thinking>/<think> trước, (2) trên
    // phần "đã ra khỏi thinking" đó mới lọc tiếp các dòng nhãn phân loại an toàn bị lộ. `committed`
    // CHỈ bật ở lớp lọc CUỐI CÙNG — nhờ vậy nếu 1 target trả về response mà toàn bộ nội dung "thấy
    // được" chỉ là nhãn kiểu "User Safety: unsafe" (không có câu trả lời thật nào), dòng đó bị lớp
    // lọc thứ 2 âm thầm loại bỏ, committed vẫn là false, và hệ thống tự động failover sang target
    // khác — thay vì hiển thị nhãn "unsafe" đó cho người dùng như thể đó là câu trả lời.
    const safetyFilter = createSafetyLineFilter((visible) => {
      committed = true;
      attemptText += visible;
      onDelta(visible);
    });
    const filter = createStreamingThinkingFilter((visible) => safetyFilter.feed(visible));
    const attemptStartedAt = Date.now();
    try {
      const meta = {};
      const text = await p.callStream({
        ...args,
        meta,
        onDelta: (piece) => filter.feed(piece)
      });
      filter.flush();
      safetyFilter.flush();
      const visibleText = stripThinkingTags(text);
      if (visibleText || committed) {
        const latency = Date.now() - attemptStartedAt;
        logAttempt({ requestId: args.requestId, stage: args.telemetryStage || 'stream', target: p, latency, status: 'success', usage: meta.usage, answerBudget: args.maxTokens, reasoningBudget: args.reasoningBudget, providerMaxTokens: meta.providerMaxTokens, finishReason: meta.finishReason, recovery: !!args.telemetryRecovery, estimatedOutputTokens: estimateTokens(visibleText || '') });
        // PHẦN J FIX: TRƯỚC ĐÂY đường streaming gọi `markSuccess(p)` KHÔNG kèm latency, nên toàn bộ
        // telemetry latency/throughput không bao giờ học được gì từ đường code chạy NHIỀU NHẤT
        // (mọi request thật đều là streaming). Nay ghi cả latency (cho isTargetSlow) và throughput
        // token/giây thực đo (cho adaptive budget — xem throughputStats.js).
        markSuccess(p, latency);
        // Ưu tiên số token THẬT (meta.usage) cho cả throughput lẫn hiệu chỉnh tokenizer; chỉ rơi về
        // ước lượng theo ký tự khi provider không trả usage.
        const realOut = meta.usage && Number(meta.usage.outputTokens);
        if (Number.isFinite(realOut) && realOut > 0) {
          tokenCounter.recordUsage(p.providerKey, { text: visibleText || attemptText, tokens: realOut });
        }
        recordThroughput(p, {
          outputTokens: Number.isFinite(realOut) && realOut > 0 ? realOut : estimateTokens(visibleText || attemptText),
          elapsedMs: latency
        });
        return {
          text: visibleText, provider: p, tried, finishReason: meta.finishReason || null,
          interrupted: false, latencyMs: latency, usage: meta.usage || null
        };
      }
      logAttempt({ requestId: args.requestId, stage: 'stream', target: p, latency: Date.now() - attemptStartedAt, status: 'empty' });
      markFailure(p, new Error('Phản hồi rỗng (chỉ chứa nhãn phân loại an toàn nội bộ bị lộ, không có câu trả lời thật)'));
      tried.push({ label: p.label, error: 'Phản hồi rỗng (chỉ chứa nhãn phân loại an toàn nội bộ bị lộ, không có câu trả lời thật — xem safetyLeakFilter.js)' });
    } catch (err) {
      if (committed) {
        // ---------- CASE 2 (PHẦN B): provider lỗi SAU KHI đã gửi delta ----------
        // KHÔNG coi là FAILED, KHÔNG bỏ phần đã sinh, KHÔNG regenerate từ đầu. Đóng 2 lớp lọc để
        // lấy nốt phần đang nằm trong buffer (trước đây bị mất trắng: nhánh catch không hề gọi
        // filter.flush()/safetyFilter.flush(), nên đoạn văn bản cuối còn đệm trong bộ lọc thinking
        // bị bỏ đi cùng lỗi), rồi trả checkpoint để caller chuyển sang RESUME MODE.
        try { filter.flush(); safetyFilter.flush(); } catch (e) { /* bộ lọc đã đóng — bỏ qua */ }
        logAttempt({ requestId: args.requestId, stage: 'stream', target: p, latency: Date.now() - attemptStartedAt, status: 'partial_error', err });
        // Người dùng hủy giữa chừng thì KHÔNG phải lỗi provider — không cooldown, không resume.
        if (err && err.cancelled) {
          return { text: attemptText, provider: p, tried, interrupted: false, cancelled: true, finishReason: null };
        }
        // markFailure ở ĐÂY là mấu chốt để RESUME đi sang target KHÁC: nó áp cooldown đúng tầng
        // (key/model/target theo errorClassifier) nên getEligibleTargets() ở lượt resume không còn
        // trả về target vừa chết. Thiếu dòng này (như bản trước) là lý do vòng recovery cứ gọi lại
        // đúng provider đã chết và luôn thất bại.
        const partialClassification = markFailure(p, err);
        invalidateModelIfNeeded(p, partialClassification);
        return {
          text: attemptText,
          provider: p,
          tried,
          interrupted: true,
          partialError: err,
          errorScope: partialClassification.scope,
          sanitizedMessage: partialClassification.sanitizedMessage,
          finishReason: null // bị ngắt: provider CHƯA gửi stop_reason -> không được giả định 'stop'
        };
      }
      // mục 4: bị hủy (client disconnect/bấm Dừng) trước khi kịp phát delta nào — dừng ngay, không
      // thử target khác (mọi target khác cũng dùng chung signal, cũng sẽ abort ngay lập tức).
      if (err && err.cancelled) throw err;
      logAttempt({ requestId: args.requestId, stage: args.telemetryStage || 'stream', target: p, latency: Date.now() - attemptStartedAt, status: 'error', err, answerBudget: args.maxTokens, reasoningBudget: args.reasoningBudget, recovery: !!args.telemetryRecovery });
      const classification = markFailure(p, err);
      invalidateModelIfNeeded(p, classification);
      lastClassification = classification;
      // P0 mục 2: luôn dùng sanitizedMessage (không chỉ cho lỗi billing).
      tried.push({ label: p.label, error: classification.sanitizedMessage });
      // PHẦN 14 FIX: 'invalid_request' lặp lại y hệt ở mọi target — dừng ngay, không thử tiếp
      // (giống callWithFailover() ở trên, cùng lý do).
      if (classification.scope === 'invalid_request') break;
      // Chưa phát ra delta THẬT nào (có thể đã nhận vài piece nhưng toàn bộ vẫn đang nằm trong khối
      // thinking) — an toàn để tự động thử target tiếp theo (failover).
    }
  }

  const err = new Error(
    'Tất cả nhà cung cấp AI đã cấu hình đều gặp lỗi khi trả lời.' +
    (lastClassification ? ' Lỗi gần nhất: ' + lastClassification.sanitizedMessage : '')
  );
  err.status = 502;
  err.code = 'PROVIDER_ERROR';
  err.triedProviders = tried;
  throw err;
}

module.exports = {
  getActiveProviders, ensureProvidersReady, getRotationHealth, callWithFailover, callFastest, streamWithFailover, shuffle,
  createDeadline, gatherCrossCheckCandidates, CROSS_CHECK_BUDGET_MS, CROSS_CHECK_MAX_CANDIDATES, pickDiverseCandidates,
  safeCallTimeout, MIN_CALL_TIMEOUT_MS,
  getFastModeStats, _resetFastModeStatsForTest, T_FAST_RACE_THRESHOLD_MS,
  emptyUsageAccumulator, accumulateUsage, CACHE_READ_DISCOUNT
};
