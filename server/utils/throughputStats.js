'use strict';

// ---------- THROUGHPUT TELEMETRY THẬT (PHẦN J) ----------
// NGUYÊN NHÂN GỐC (bản trước): adaptiveBudget.js dùng 1 HẰNG SỐ duy nhất
// `THROUGHPUT_TOKENS_PER_SEC = 60` cho MỌI provider/model để suy ra "trong khoảng thời gian còn lại
// của deadline, model kịp sinh bao nhiêu token" (timeRemainingBudget). Hằng số đó quyết định trực
// tiếp maxTokens của lượt gọi, nên sai lệch của nó gây ra 2 lỗi ngược nhau, cả hai đều thấy được
// trong vận hành thật:
//   - Provider NHANH (vd 110 tok/s) bị ước lượng THẤP => maxTokens bị co lại quá mức => câu trả lời
//     bị cắt vì finish_reason=length dù thời gian thực tế vẫn còn dư => continuation không cần thiết.
//   - Provider CHẬM (vd 30 tok/s) bị ước lượng CAO => maxTokens quá lớn so với thời gian thật =>
//     lượt gọi bị timeoutMs (đã co theo deadline) cắt NGANG GIỮA STREAM => interrupted.
//
// Module này giữ thống kê throughput ĐO THẬT (EMA) theo 2 chiều:
//   - theo MODEL cụ thể: `${providerKey}::${modelId}` (chính xác nhất)
//   - theo PROVIDER: `${providerKey}` (fallback khi model đó chưa có đủ mẫu — vẫn tốt hơn hằng số chung)
// và chỉ trả về ước lượng khi đã có tối thiểu MIN_SAMPLES mẫu, tránh để 1 lượt đo nhiễu (cold start,
// mạng chập) làm lệch hẳn budget của các request sau.

const DEFAULT_TOKENS_PER_SEC = Number(process.env.THROUGHPUT_TOKENS_PER_SEC) || 60;
// Chặn trên/chặn dưới chống sai số (PHẦN J: "Có upper/lower bound chống sai số"). Một lượt gọi rất
// ngắn (vd 30 token trong 120ms nhờ cache của hãng) có thể cho ra 250 tok/s — không đại diện cho 1
// lượt sinh 4000 token; ngược lại 1 lượt bị nghẽn mạng cho ra 3 tok/s cũng không đại diện.
const MIN_TOKENS_PER_SEC = 12;
const MAX_TOKENS_PER_SEC = 220;
const EMA_ALPHA = 0.25;
const MIN_SAMPLES = 2;
// Mẫu quá nhỏ không đủ tin cậy để nói về throughput của 1 câu trả lời dài (phần lớn thời gian là
// TTFT — time to first token — chứ không phải tốc độ sinh token).
const MIN_SAMPLE_TOKENS = 80;
const MIN_SAMPLE_MS = 400;

const stats = new Map(); // key -> { emaTokensPerSec, samples, lastAt }

function keyOfModel(target) {
  if (!target) return null;
  if (target.modelId) return `m:${target.modelId}`;
  if (target.providerKey && target.modelName) return `m:${target.providerKey}::${target.modelName}`;
  return null;
}
function keyOfProvider(target) {
  if (!target || !target.providerKey) return null;
  return `p:${target.providerKey}`;
}

function clampRate(rate) {
  return Math.max(MIN_TOKENS_PER_SEC, Math.min(MAX_TOKENS_PER_SEC, rate));
}

function bump(key, rate) {
  if (!key) return;
  const prev = stats.get(key);
  if (!prev) {
    stats.set(key, { emaTokensPerSec: rate, samples: 1, lastAt: Date.now() });
    return;
  }
  stats.set(key, {
    emaTokensPerSec: prev.emaTokensPerSec * (1 - EMA_ALPHA) + rate * EMA_ALPHA,
    samples: prev.samples + 1,
    lastAt: Date.now()
  });
}

/**
 * Ghi nhận 1 lượt gọi THÀNH CÔNG có đo được số token sinh ra và thời gian trôi qua.
 * Bỏ qua mẫu quá nhỏ (không đại diện) thay vì làm nhiễu EMA.
 * @param {object} target Execution target (cần .modelId/.providerKey).
 * @param {{outputTokens:number, elapsedMs:number}} sample
 */
function recordThroughput(target, { outputTokens, elapsedMs } = {}) {
  const tokens = Number(outputTokens);
  const ms = Number(elapsedMs);
  if (!Number.isFinite(tokens) || !Number.isFinite(ms)) return;
  if (tokens < MIN_SAMPLE_TOKENS || ms < MIN_SAMPLE_MS) return;
  const rate = clampRate(tokens / (ms / 1000));
  bump(keyOfModel(target), rate);
  bump(keyOfProvider(target), rate);
}

/**
 * Ước lượng throughput (token/giây) cho 1 target cụ thể — model trước, rồi provider, rồi hằng số
 * mặc định. KHÔNG BAO GIỜ trả về 0/âm/NaN (giá trị đó sẽ làm budget về 0 và mọi lượt gọi vô nghĩa).
 * @param {object} [target]
 * @returns {number}
 */
function getThroughput(target) {
  const mk = keyOfModel(target);
  const m = mk && stats.get(mk);
  if (m && m.samples >= MIN_SAMPLES) return clampRate(m.emaTokensPerSec);
  const pk = keyOfProvider(target);
  const p = pk && stats.get(pk);
  if (p && p.samples >= MIN_SAMPLES) return clampRate(p.emaTokensPerSec);
  return DEFAULT_TOKENS_PER_SEC;
}

/**
 * Throughput ĐẠI DIỆN cho 1 tập target (dùng khi tính budget TRƯỚC KHI biết target nào sẽ thắng
 * rotation — chat.js tính budget trước, streamWithFailover mới chọn target). Lấy trung vị thay vì
 * trung bình để 1 target cực chậm/cực nhanh không kéo lệch toàn bộ.
 * @param {Array} targets
 * @returns {number}
 */
function getRepresentativeThroughput(targets) {
  const list = (targets || []).map((t) => getThroughput(t)).filter((n) => Number.isFinite(n) && n > 0);
  if (!list.length) return DEFAULT_TOKENS_PER_SEC;
  list.sort((a, b) => a - b);
  const mid = Math.floor(list.length / 2);
  const median = list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
  return clampRate(median);
}

/** Snapshot cho telemetry/debug (PHẦN Q) — không chứa khóa API, chỉ id model/provider nội bộ. */
function snapshot() {
  const out = {};
  stats.forEach((v, k) => {
    out[k] = { tokensPerSec: Math.round(v.emaTokensPerSec), samples: v.samples };
  });
  return out;
}

function _resetForTest() { stats.clear(); }

module.exports = {
  recordThroughput, getThroughput, getRepresentativeThroughput, snapshot, _resetForTest,
  DEFAULT_TOKENS_PER_SEC, MIN_TOKENS_PER_SEC, MAX_TOKENS_PER_SEC
};
