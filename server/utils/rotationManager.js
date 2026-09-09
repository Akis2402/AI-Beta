'use strict';

// ---------- AIRotationManager: service tập trung cho rotation/health/cooldown ----------
// Toàn bộ logic "target nào đang khả dụng, target nào phải xoay tiếp" tập trung ở ĐÚNG 1 nơi (mục
// 21) — aiProviders.js chỉ còn orchestration (thứ tự thử, failover, đua tốc độ), không tự quản lý
// health nữa.
//
// 3 tầng health (mục 7-9):
//   keyHealth[keyId]     — ảnh hưởng MỌI target dùng khóa API đó (bất kể model)
//   modelHealth[modelId] — ảnh hưởng MỌI target dùng model đó (bất kể khóa/provider... modelId đã
//                           gồm providerKey nên không lẫn model trùng tên giữa 2 hãng khác nhau)
//   targetHealth[id]     — chỉ ảnh hưởng đúng 1 cặp Key+Model cụ thể
// getEligibleTargets() loại 1 target nếu BẤT KỲ tầng nào trong 3 tầng trên đang cooldown/invalid.
//
// State là in-memory (module-scope Map) theo quyết định đã chốt — best-effort per-instance, không
// giả định global qua nhiều serverless instance (xem giới hạn ghi trong báo cáo cuối).

const { classify } = require('./errorClassifier');

const keyHealth = new Map(); // keyId -> {cooldownUntil, invalid, requests, failures}
const modelHealth = new Map(); // modelId -> {cooldownUntil, requests, failures}
const targetHealth = new Map(); // targetId -> {cooldownUntil, requests, failures, lastUsedAt}

// ---------- FAIR ROTATION: least-recently-used trên "số thứ tự chọn" toàn cục (PHẦN K) ----------
// NGUYÊN NHÂN GỐC của bất công bằng rotation (đã sửa ở bản này): TRƯỚC ĐÂY rotation dùng 1 con trỏ
// số nguyên `rotationCursor` + `lastSignature` = chữ ký của TẬP TARGET ELIGIBLE hiện tại. Tập
// eligible thay đổi MỖI KHI có target vào/ra cooldown (chuyện xảy ra liên tục trong vận hành thật:
// 429, timeout, model overload...). Signature khác đi => `rotationCursor = 0` => vòng xoay bị RESET
// về đầu danh sách, tức T1 lại được ưu tiên thử trước. Với 4 target T1..T4, chỉ cần T2 chớp nhoáng
// vào cooldown rồi ra là T1 được ưu tiên 2 lần liên tiếp; nếu cooldown xảy ra thường xuyên, T1 gần
// như luôn đi đầu và T3/T4 bị "đói" — đúng kịch bản mục K cấm ("Khi T2 quay lại: KHÔNG reset cursor
// về T1").
//
// NAY: mỗi target có 1 mốc `lastSelectedSeq` lấy từ 1 bộ đếm TĂNG ĐƠN ĐIỆU toàn cục. Thứ tự thử =
// sắp tăng dần theo mốc đó (target chưa từng được chọn đi trước nhất). Trạng thái này gắn theo
// TARGET ID, KHÔNG gắn theo tập eligible — nên:
//   - tập eligible đổi (cooldown vào/ra) KHÔNG làm mất/reset thứ tự công bằng đã tích luỹ;
//   - target vừa hết cooldown có mốc CŨ NHẤT nên được ưu tiên trở lại (bù đúng phần bị bỏ lỡ),
//     thay vì phải chờ hết 1 vòng mới tới lượt;
//   - khi mọi target đều khoẻ, hành vi trùng khớp round-robin thuần: R1→T1, R2→T2, ... R5→T1.
// Không dùng random thuần ở đường failover (shuffle() chỉ còn dùng cho callFastest — đua tốc độ).
let selectionSeq = 0;
const selectionState = new Map(); // targetId -> lastSelectedSeq (số càng nhỏ = càng lâu chưa dùng)

/**
 * noteSelection(): ghi nhận 1 target VỪA THỰC SỰ được dùng cho 1 lượt gọi (thành công hay thất bại
 * đều tính — đã "tiêu" 1 lượt ưu tiên của nó). Được gọi từ orderByRotation() cho phần tử đứng đầu
 * (target sẽ được thử trước) VÀ từ markSuccess/markFailure cho target thực sự được gọi (có thể khác
 * phần tử đầu khi failover phải đi sâu hơn trong danh sách) — nhờ vậy LRU phản ánh đúng thực tế.
 */
function noteSelection(target) {
  if (!target || !target.id) return;
  selectionSeq += 1;
  selectionState.set(target.id, selectionSeq);
}

/** Chỉ dùng cho test — xoá sạch trạng thái rotation/health giữa các kịch bản độc lập. */
function _resetRotationStateForTest() {
  selectionSeq = 0;
  selectionState.clear();
  keyHealth.clear();
  modelHealth.clear();
  targetHealth.clear();
}

/** Ảnh chụp thứ tự ưu tiên hiện tại (debug/telemetry PHẦN Q) — không chứa khóa API. */
function getRotationPositions(targets) {
  return (targets || []).map((t) => ({
    targetId: t.id,
    lastSelectedSeq: selectionState.has(t.id) ? selectionState.get(t.id) : null
  }));
}

function ensureHealth(map, id) {
  if (!map.has(id)) map.set(id, { cooldownUntil: 0, invalid: false, requests: 0, failures: 0 });
  return map.get(id);
}

function isAvailable(entry) {
  if (!entry) return true;
  if (entry.invalid) return false;
  return !entry.cooldownUntil || entry.cooldownUntil <= Date.now();
}

/**
 * Lọc target: bỏ target bị disable qua .env (không áp dụng ở đây — enable/disable từng target cụ
 * thể là việc của admin config, chưa có UI trong scope này), bỏ target đang cooldown/invalid ở BẤT
 * KỲ tầng nào (key/model/target), và bỏ target không đủ capability yêu cầu (mục 6).
 *
 * @param {Array} targets Toàn bộ execution target đã cấu hình.
 * @param {{requireWebSearch?:boolean, requireVision?:boolean}} [requirements] mục 10: requireVision
 *   loại target mà model ĐÃ BIẾT (qua discovery) là không hỗ trợ vision — target chưa rõ capability
 *   (model.capabilities.supportsVision === undefined, vd legacy override không qua discovery) vẫn
 *   được coi là eligible (không chặn nhầm khi không có đủ thông tin, mục 10 "chọn fallback gần nhất").
 * @returns {Array} Target còn đủ điều kiện tham gia rotation.
 */
function getEligibleTargets(targets, requirements = {}) {
  return targets.filter((t) => {
    if (requirements.requireWebSearch && !t.supportsWebSearch) return false;
    if (requirements.requireVision && t.capabilities && t.capabilities.supportsVision === false) return false;
    if (!isAvailable(keyHealth.get(t.keyId))) return false;
    if (!isAvailable(modelHealth.get(t.modelId))) return false;
    if (!isAvailable(targetHealth.get(t.id))) return false;
    return true;
  });
}

/**
 * Sắp thứ tự thử: round-robin công bằng bắt đầu từ cursor hiện tại (không phải luôn từ đầu danh
 * sách) — qua nhiều request liên tiếp, mọi target đều lần lượt được ưu tiên thử trước, đúng tinh
 * thần "không có target mặc định cố định" của hệ thống cũ, nhưng có tính công bằng cao hơn random
 * thuần (random có thể để 1 target bị "đói" nhiều vòng liên tục do xui rủi).
 *
 * @param {Array} eligibleTargets
 * @returns {Array} Cùng các phần tử, thứ tự đã xoay theo cursor.
 */
function orderByRotation(eligibleTargets) {
  if (!eligibleTargets || eligibleTargets.length <= 1) return eligibleTargets || [];
  // Sắp theo mốc chọn gần nhất TĂNG DẦN (chưa từng chọn = -1 -> đi đầu). Tie-break bằng vị trí gốc
  // trong danh sách để thứ tự luôn TIỀN ĐỊNH (deterministic) khi nhiều target cùng mốc — nhờ vậy với
  // 4 target mới toanh, lượt đầu tiên ra đúng [T1,T2,T3,T4] chứ không phụ thuộc thứ tự Map.
  const ordered = eligibleTargets
    .map((t, idx) => ({ t, idx, seq: selectionState.has(t.id) ? selectionState.get(t.id) : -1 }))
    .sort((a, b) => (a.seq - b.seq) || (a.idx - b.idx))
    .map((e) => e.t);
  // Chỉ phần tử ĐẦU được ghi nhận ở đây (đó là target sẽ được thử trước). Nếu failover phải đi sâu
  // hơn, markSuccess/markFailure của target thực sự được gọi sẽ tự ghi nhận thêm (xem noteSelection).
  noteSelection(ordered[0]);
  return ordered;
}

/** Xáo trộn ngẫu nhiên (Fisher–Yates) — dùng cho callFastest() (đua tốc độ, không cần round-robin). */
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// EMA alpha cho latency — đủ nhạy để phản ánh xu hướng gần đây nhưng không bị 1 outlier chi phối
// (mục PHẦN 9: "target gần đây liên tục chậm" cần tín hiệu ỔN ĐỊNH, không phải 1 lần chậm ngẫu nhiên).
const LATENCY_EMA_ALPHA = 0.3;

/**
 * markSuccess() nay CÓ THỂ nhận latencyMs (mục PHẦN 9) để cập nhật avgLatencyMs (EMA) của target —
 * đây là tín hiệu THẬT (không phải log-only) dùng bởi callFastest() để quyết định có cần đua thêm
 * 1 target hay không (isTargetSlow()). Gọi không kèm latencyMs vẫn hợp lệ (backward compatible).
 */
function markSuccess(target, latencyMs) {
  noteSelection(target); // LRU: target này vừa tiêu 1 lượt ưu tiên thật (PHẦN K)
  const t = ensureHealth(targetHealth, target.id);
  t.requests += 1;
  t.cooldownUntil = 0;
  t.lastUsedAt = Date.now();
  if (typeof latencyMs === 'number' && latencyMs >= 0) {
    t.avgLatencyMs = typeof t.avgLatencyMs === 'number'
      ? Math.round(t.avgLatencyMs * (1 - LATENCY_EMA_ALPHA) + latencyMs * LATENCY_EMA_ALPHA)
      : latencyMs;
  }
  // Thành công không tự động "chữa" cooldown ở tầng key/model — cooldown ở 2 tầng đó tự hết hạn
  // theo thời gian (cooldownUntil), tránh 1 lượt thành công đơn lẻ xoá sạch tín hiệu lỗi hàng loạt
  // vừa ghi nhận trước đó (vd 1 request lọt qua đúng lúc key đang phục hồi giữa 2 lượt 429).
}

/**
 * isTargetSlow() (mục PHẦN 9): true nếu target có lịch sử latency EMA vượt ngưỡng, hoặc chưa có đủ
 * lịch sử (unknown = coi như KHÔNG chậm — không phạt oan target mới/ít dữ liệu).
 */
function isTargetSlow(target, thresholdMs) {
  if (!target) return false;
  const t = targetHealth.get(target.id);
  if (!t || typeof t.avgLatencyMs !== 'number') return false;
  return t.avgLatencyMs > thresholdMs;
}

/**
 * Ghi nhận lỗi cho 1 target: phân loại lỗi (errorClassifier) rồi áp cooldown ở ĐÚNG tầng tương ứng.
 * @param {object} target
 * @param {Error} err
 * @returns {{scope:string, isBilling:boolean, sanitizedMessage:string}} Kết quả phân loại — nơi gọi
 *   dùng `sanitizedMessage`/`isBilling` để không lộ lỗi billing/provider nguyên văn ra người dùng.
 */
function markFailure(target, err) {
  const result = classify(err);
  const now = Date.now();
  // LRU: 1 lượt gọi THẤT BẠI vẫn là 1 lượt đã tiêu — nếu không ghi nhận, target lỗi sẽ mãi mãi có
  // mốc "cũ nhất" và luôn được thử đầu tiên ngay khi hết cooldown, lặp lại lỗi trước mọi target khác.
  noteSelection(target);

  if (result.scope === 'key') {
    const k = ensureHealth(keyHealth, target.keyId);
    k.failures += 1;
    k.invalid = result.invalid;
    if (!result.invalid) k.cooldownUntil = now + result.cooldownMs;
  } else if (result.scope === 'model') {
    const m = ensureHealth(modelHealth, target.modelId);
    m.failures += 1;
    m.cooldownUntil = now + result.cooldownMs;
  } else if (result.scope === 'target') {
    const t = ensureHealth(targetHealth, target.id);
    t.failures += 1;
    t.cooldownUntil = now + result.cooldownMs;
  }
  // scope === 'invalid_request': không cooldown gì — lỗi do request, xoay target khác không ích gì
  // nhưng cũng không nên chặn target đó cho các request khác (request khác có thể hợp lệ).

  return result;
}

/** Bản chụp health hiện tại — dùng cho admin/debug (mục 25), KHÔNG bao giờ chứa khóa API thật. */
function getHealthSnapshot(targets) {
  return targets.map((t) => {
    const k = keyHealth.get(t.keyId);
    const m = modelHealth.get(t.modelId);
    const th = targetHealth.get(t.id);
    const now = Date.now();
    return {
      target: t.label,
      keyMasked: t.keyId, // đã là id nội bộ (vd "gemini#2"), không phải khóa thật — an toàn hiển thị
      model: t.modelName,
      keyHealthy: isAvailable(k),
      modelHealthy: isAvailable(m),
      targetHealthy: isAvailable(th),
      keyCooldownRemainingMs: k && k.cooldownUntil > now ? k.cooldownUntil - now : 0,
      requests: (th && th.requests) || 0,
      failures: (th && th.failures) || 0
    };
  });
}

module.exports = {
  getEligibleTargets, orderByRotation, shuffle, markSuccess, markFailure, getHealthSnapshot, isTargetSlow,
  noteSelection, getRotationPositions, _resetRotationStateForTest
};
