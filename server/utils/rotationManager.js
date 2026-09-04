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

// ---------- Round-robin cursor ----------
// Đảm bảo rotation xoay CÔNG BẰNG qua từng target theo đúng ví dụ mục 4 (Request1→T1, Request2→T2,
// ...), thay vì random thuần (random có thể lặp lại cùng 1 target nhiều lần liên tiếp). Cursor được
// giữ theo "chữ ký" của tập target hiện tại (danh sách id nối lại) — nếu tập target đổi (thêm/bớt
// key/model qua .env), cursor tự reset về 0 một cách tự nhiên vì signature khác đi.
let rotationCursor = 0;
let lastSignature = '';

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
 * @param {{requireWebSearch?:boolean}} [requirements]
 * @returns {Array} Target còn đủ điều kiện tham gia rotation.
 */
function getEligibleTargets(targets, requirements = {}) {
  return targets.filter((t) => {
    if (requirements.requireWebSearch && !t.supportsWebSearch) return false;
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
  if (!eligibleTargets.length) return eligibleTargets;
  const signature = eligibleTargets.map((t) => t.id).sort().join('|');
  if (signature !== lastSignature) {
    rotationCursor = 0;
    lastSignature = signature;
  }
  const start = rotationCursor % eligibleTargets.length;
  rotationCursor = (rotationCursor + 1) % eligibleTargets.length;
  return [...eligibleTargets.slice(start), ...eligibleTargets.slice(0, start)];
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

function markSuccess(target) {
  const t = ensureHealth(targetHealth, target.id);
  t.requests += 1;
  t.cooldownUntil = 0;
  t.lastUsedAt = Date.now();
  // Thành công không tự động "chữa" cooldown ở tầng key/model — cooldown ở 2 tầng đó tự hết hạn
  // theo thời gian (cooldownUntil), tránh 1 lượt thành công đơn lẻ xoá sạch tín hiệu lỗi hàng loạt
  // vừa ghi nhận trước đó (vd 1 request lọt qua đúng lúc key đang phục hồi giữa 2 lượt 429).
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
  getEligibleTargets, orderByRotation, shuffle, markSuccess, markFailure, getHealthSnapshot
};
