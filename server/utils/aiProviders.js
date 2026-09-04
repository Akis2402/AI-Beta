'use strict';

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

const { getAllExecutionTargets } = require('./executionTargets');
const {
  getEligibleTargets, orderByRotation, shuffle, markSuccess, markFailure, getHealthSnapshot
} = require('./rotationManager');
// Lọc khối <thinking>/<think> (nháp suy luận nội bộ) khỏi MỌI văn bản forward ra ngoài — xem giải
// thích đầy đủ nguyên nhân gốc + phạm vi áp dụng ở đầu file thinkingFilter.js.
const { stripThinkingTags, createStreamingThinkingFilter } = require('./thinkingFilter');
// Lọc "nhãn phân loại an toàn nội bộ bị lộ ra làm câu trả lời" — xem đầu safetyLeakFilter.js.
const { createSafetyLineFilter } = require('./safetyLeakFilter');
// Observability (mục LVIII): log requestId/provider/model/targetId/stage/latency/status/error class
// cho MỖI lần gọi 1 execution target — không log secret (logger tự redact). `requestId` là optional
// (args.requestId, do chat.js gán) — nếu không có, field đó vắng mặt trong log, không throw.
const { log, classifyErrorForLog } = require('./logger');
function logAttempt({ requestId, stage, target, latency, status, err }) {
  log({
    requestId, stage, status,
    provider: target && target.providerKey,
    model: target && target.modelId,
    targetId: target && target.id,
    latency,
    errorClass: err ? classifyErrorForLog(err) : undefined
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
const { createRequestDeadline, safeCallTimeout, MIN_CALL_TIMEOUT_MS } = require('./requestDeadline');

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

/** Health hiện tại của mọi execution target — dùng cho admin/debug (mục 25), không lộ khóa thật. */
function getRotationHealth() {
  return getHealthSnapshot(getAllExecutionTargets());
}

/**
 * Lọc + sắp thứ tự target sẵn sàng thử, theo capability yêu cầu (mục 6) rồi theo rotation công bằng
 * (mục 4/21). Dùng chung cho callWithFailover/streamWithFailover (nơi cần thử TUẦN TỰ, công bằng).
 */
function eligibleInRotationOrder(providers, { preferWebSearch = false } = {}) {
  const eligible = getEligibleTargets(providers, {});
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
async function gatherCrossCheckCandidates(providers, { system, variantSystem, messages, maxTokens, onStatus, deadline: parentDeadline, requestId, deepThinking }) {
  const deadline = parentDeadline || createDeadline();
  const notify = typeof onStatus === 'function' ? onStatus : () => {};
  // Mục 5: KHÔNG dùng Math.max(MIN, remaining) làm timeout — nếu ngân sách còn lại dưới sàn tối
  // thiểu, safeCallTimeout() trả về null và caller PHẢI bỏ qua lệnh gọi đó (coi như hết ngân sách),
  // không được ép timeout dài hơn thời gian thực sự còn lại.
  const timeoutFor = (base) => safeCallTimeout(base, deadline);

  // ---------- Vòng 1: mọi target eligible giải 1 lượt ĐỘC LẬP SONG SONG ----------
  const round1Order = eligibleInRotationOrder(providers);
  const firstRound = await Promise.allSettled(
    round1Order.map((p) => {
      const t = timeoutFor(30000);
      if (t === null) return Promise.reject(new Error('Hết ngân sách thời gian request trước khi kịp gọi provider này.'));
      const startedAt = Date.now();
      return p.call({ system: variantSystem, messages, maxTokens, timeoutMs: t, deepThinking })
        .then((text) => { logAttempt({ requestId, stage: 'cross_check_round1', target: p, latency: Date.now() - startedAt, status: 'success' }); return text; })
        .catch((err) => { logAttempt({ requestId, stage: 'cross_check_round1', target: p, latency: Date.now() - startedAt, status: 'error', err }); throw err; });
    })
  );

  // Mọi text ở bước THU THẬP candidate này đi tiếp vào prompt của lượt TỔNG HỢP cuối (không hiển
  // thị trực tiếp cho người dùng ở bước này) — nhưng vẫn strip <thinking>/<think> ngay tại đây để
  // lượt tổng hợp không bị "loãng" ngữ cảnh bởi nháp suy luận của từng lượt giải độc lập.
  const candidates = [];
  const failedProviders = [];
  firstRound.forEach((r, i) => {
    if (r.status === 'rejected') markFailure(round1Order[i], r.reason);
    else markSuccess(round1Order[i]);
    const text = r.status === 'fulfilled' ? stripThinkingTags(r.value) : '';
    if (text) candidates.push({ label: round1Order[i].label, text });
    else failedProviders.push(round1Order[i]);
  });

  // ---------- Thử lại các target lỗi — SONG SONG với nhau (không tuần tự) ----------
  if (failedProviders.length && !deadline.expired()) {
    notify('Đang thử lại các nhà cung cấp gặp lỗi…');
    const retryOutcomes = await Promise.allSettled(
      failedProviders.map(async (failed) => {
        const others = eligibleInRotationOrder(providers.filter((p) => p.id !== failed.id));
        const retryOrder = others.length ? others : [failed];
        for (const p of retryOrder) {
          const t = timeoutFor(20000);
          if (deadline.expired() || t === null) break; // hết ngân sách an toàn — không ép gọi thêm
          const startedAt = Date.now();
          try {
            const text = stripThinkingTags(await p.call({ system: variantSystem, messages, maxTokens, timeoutMs: t, deepThinking }));
            logAttempt({ requestId, stage: 'cross_check_retry', target: p, latency: Date.now() - startedAt, status: text ? 'success' : 'empty' });
            if (text) { markSuccess(p); return { label: p.label, text }; }
          } catch (e) { logAttempt({ requestId, stage: 'cross_check_retry', target: p, latency: Date.now() - startedAt, status: 'error', err: e }); markFailure(p, e); /* thử ứng viên kế tiếp trong retryOrder */ }
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
    try {
      const extra = stripThinkingTags(await survivor.call({ system, messages, maxTokens, temperature: 0.4, timeoutMs: survivorTimeout, deepThinking }));
      if (extra) { markSuccess(survivor); candidates.push({ label: survivor.label + ' (góc nhìn khác)', text: extra }); }
    } catch (e) { markFailure(survivor, e); /* không còn cách nào khác trong ngân sách — dùng đúng 1 lượt hiện có */ }
  }

  return { candidates, deadline };
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

async function callWithFailover(providers, args, { preferWebSearch = false, deadline: parentDeadline } = {}) {
  if (!providers || !providers.length) {
    const err = new Error('Chưa có nhà cung cấp AI nào được cấu hình (thiếu API key trong .env).');
    err.status = 500;
    throw err;
  }

  const order = eligibleInRotationOrder(providers, { preferWebSearch });
  const deadline = parentDeadline || createDeadline(FAILOVER_BUDGET_MS);
  const tried = [];
  let lastErr;
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
      // strip <thinking>/<think>: text ở đây được trả THẲNG cho người dùng (JSON response) — xem
      // giải thích nguyên nhân gốc ở đầu thinkingFilter.js.
      const text = stripThinkingTags(await p.call({ ...args, timeoutMs: callTimeout }));
      logAttempt({ requestId: args.requestId, stage: 'failover', target: p, latency: Date.now() - attemptStartedAt, status: text ? 'success' : 'empty' });
      if (text) { markSuccess(p); return { text, provider: p, tried }; }
      tried.push({ label: p.label, error: 'Phản hồi rỗng' });
    } catch (err) {
      const classification = markFailure(p, err);
      lastErr = err;
      logAttempt({ requestId: args.requestId, stage: 'failover', target: p, latency: Date.now() - attemptStartedAt, status: 'error', err });
      // Không lộ nguyên văn lỗi billing/provider ra danh sách `tried` (có thể được log/hiển thị debug).
      tried.push({ label: p.label, error: classification.isBilling ? classification.sanitizedMessage : ((err && err.message) || String(err)) });
      // KHÔNG throw ngay — tự động thử target tiếp theo (failover).
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
 * "Đua tốc độ": gọi ĐỒNG THỜI tối đa `raceSize` target ngẫu nhiên (mặc định 2, hoặc ít hơn nếu
 * không đủ target) và lấy kết quả của target trả lời THÀNH CÔNG ĐẦU TIÊN — nhanh hơn hẳn so với
 * callWithFailover() (vốn chờ tuần tự) vì không phải đợi 1 target chậm/timeout mới thử tiếp. Nếu
 * tất cả target trong nhóm đua đều lỗi, tự động mở rộng đua sang các target còn lại (nếu có) trước
 * khi báo lỗi. Dùng cho chế độ Nhanh — nơi tốc độ phản hồi quan trọng hơn việc tiết kiệm 1 lệnh gọi
 * API thừa (random, không cần round-robin công bằng — đua tốc độ tự nhiên đã phân tải qua nhiều target).
 *
 * @param {Array} providers Danh sách execution target đang hoạt động.
 * @param {object} args Tham số truyền cho call() của target (nên kèm `fast:true` để dùng model nhẹ/nhanh).
 * @param {{raceSize?: number, deadline?: object}} [opts] `deadline` (mục 4/6): truyền xuống
 *   callWithFailover() khi phải fallback, và giới hạn timeoutMs của từng lệnh gọi trong nhóm đua.
 * @returns {Promise<{text:string, provider:object, tried:Array}>}
 */
async function callFastest(providers, args, { raceSize = 2, deadline } = {}) {
  if (!providers || !providers.length) {
    const err = new Error('Chưa có nhà cung cấp AI nào được cấu hình (thiếu API key trong .env).');
    err.status = 500;
    throw err;
  }
  const eligible = getEligibleTargets(providers, {});
  if (!eligible.length) {
    return callWithFailover(providers, args, { deadline });
  }
  if (eligible.length === 1) {
    return callWithFailover(eligible, args, { deadline });
  }

  // Mục 6: nếu có deadline chung, co timeoutMs của MỌI lệnh gọi trong nhóm đua theo ngân sách còn
  // lại — không để 1 lệnh đua chạy dài hơn thời gian thực sự còn của request.
  const raceArgs = deadline
    ? { ...args, timeoutMs: safeCallTimeout(args.timeoutMs || 30000, deadline) || 1 }
    : args;

  const order = shuffle(eligible);
  const group = order.slice(0, Math.max(2, Math.min(raceSize, order.length)));
  const rest = order.slice(group.length);
  const tried = [];

  async function raceGroup(list) {
    const attempts = list.map((p) => {
      const startedAt = Date.now();
      return p
        .call(raceArgs)
        // strip <thinking>/<think>: text ở đây được trả THẲNG cho người dùng — xem đầu thinkingFilter.js.
        .then((text) => {
          const visible = stripThinkingTags(text);
          if (!visible) throw new Error('Phản hồi rỗng');
          logAttempt({ requestId: args.requestId, stage: 'fast_race', target: p, latency: Date.now() - startedAt, status: 'success' });
          markSuccess(p);
          return { text: visible, provider: p };
        })
        .catch((err) => {
          logAttempt({ requestId: args.requestId, stage: 'fast_race', target: p, latency: Date.now() - startedAt, status: 'error', err });
          const classification = markFailure(p, err);
          tried.push({ label: p.label, error: classification.isBilling ? classification.sanitizedMessage : ((err && err.message) || String(err)) });
          throw err; // để Promise.any bỏ qua target này và chờ target còn lại trong nhóm
        });
    });
    return Promise.any(attempts);
  }

  try {
    const result = await raceGroup(group);
    return { ...result, tried };
  } catch (firstGroupErr) {
    // Cả nhóm đua đầu đều lỗi — thử tiếp các target còn lại (nếu có) trước khi bỏ cuộc.
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
async function streamWithFailover(providers, args, onDelta, { preferWebSearch = false, deadline } = {}) {
  if (!providers || !providers.length) {
    const err = new Error('Chưa có nhà cung cấp AI nào được cấu hình (thiếu API key trong .env).');
    err.status = 500;
    throw err;
  }

  const order = eligibleInRotationOrder(providers, { preferWebSearch });

  const tried = [];
  let lastErr;
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
    // Ghép 2 lớp lọc streaming theo đúng thứ tự: (1) bỏ khối <thinking>/<think> trước, (2) trên
    // phần "đã ra khỏi thinking" đó mới lọc tiếp các dòng nhãn phân loại an toàn bị lộ. `committed`
    // CHỈ bật ở lớp lọc CUỐI CÙNG — nhờ vậy nếu 1 target trả về response mà toàn bộ nội dung "thấy
    // được" chỉ là nhãn kiểu "User Safety: unsafe" (không có câu trả lời thật nào), dòng đó bị lớp
    // lọc thứ 2 âm thầm loại bỏ, committed vẫn là false, và hệ thống tự động failover sang target
    // khác — thay vì hiển thị nhãn "unsafe" đó cho người dùng như thể đó là câu trả lời.
    const safetyFilter = createSafetyLineFilter((visible) => { committed = true; onDelta(visible); });
    const filter = createStreamingThinkingFilter((visible) => safetyFilter.feed(visible));
    const attemptStartedAt = Date.now();
    try {
      const text = await p.callStream({
        ...args,
        onDelta: (piece) => filter.feed(piece)
      });
      filter.flush();
      safetyFilter.flush();
      const visibleText = stripThinkingTags(text);
      if (visibleText || committed) {
        logAttempt({ requestId: args.requestId, stage: 'stream', target: p, latency: Date.now() - attemptStartedAt, status: 'success' });
        markSuccess(p); return { text: visibleText, provider: p, tried };
      }
      logAttempt({ requestId: args.requestId, stage: 'stream', target: p, latency: Date.now() - attemptStartedAt, status: 'empty' });
      markFailure(p, new Error('Phản hồi rỗng (chỉ chứa nhãn phân loại an toàn nội bộ bị lộ, không có câu trả lời thật)'));
      tried.push({ label: p.label, error: 'Phản hồi rỗng (chỉ chứa nhãn phân loại an toàn nội bộ bị lộ, không có câu trả lời thật — xem safetyLeakFilter.js)' });
    } catch (err) {
      if (committed) {
        // Đã stream được 1 phần cho người dùng thấy — không thể lùi lại đổi target khác giữa
        // chừng, đành coi phần đã có là kết quả cuối (tốt hơn là hủy bỏ mọi thứ đã hiển thị).
        logAttempt({ requestId: args.requestId, stage: 'stream', target: p, latency: Date.now() - attemptStartedAt, status: 'partial_error', err });
        return { text: '', provider: p, tried, partialError: err };
      }
      logAttempt({ requestId: args.requestId, stage: 'stream', target: p, latency: Date.now() - attemptStartedAt, status: 'error', err });
      const classification = markFailure(p, err);
      lastErr = err;
      tried.push({ label: p.label, error: classification.isBilling ? classification.sanitizedMessage : ((err && err.message) || String(err)) });
      // Chưa phát ra delta THẬT nào (có thể đã nhận vài piece nhưng toàn bộ vẫn đang nằm trong khối
      // thinking) — an toàn để tự động thử target tiếp theo (failover).
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
  getActiveProviders, getRotationHealth, callWithFailover, callFastest, streamWithFailover, shuffle,
  createDeadline, gatherCrossCheckCandidates, CROSS_CHECK_BUDGET_MS, safeCallTimeout, MIN_CALL_TIMEOUT_MS
};
