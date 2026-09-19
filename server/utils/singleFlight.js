'use strict';

// ============================================================================================
// PHẦN CB + CC + CD — SINGLE-FLIGHT / CHỐNG CACHE STAMPEDE
// ============================================================================================
// Kịch bản thật: một PDF vừa upload, hai code path cùng cần trang 21; hoặc 5 request đồng thời cùng
// hỏi về một URL chưa có trong cache. Không có single-flight thì mỗi bên tự gọi vision/fetch một lần
// — tốn tiền N lần cho đúng MỘT kết quả, và tệ hơn: N kết quả có thể khác nhau.
//
// Lưu ý phạm vi (trung thực): đây là single-flight TRONG MỘT TIẾN TRÌNH. Trên serverless nhiều
// instance, hai instance vẫn có thể cùng chạy — muốn chặn cross-instance phải dùng khoá ở KV, và đó
// là đánh đổi latency mà lớp này cố ý không trả.

const inFlight = new Map();
const stats = { hits: 0, misses: 0 };

/**
 * @param {string} key   khoá phải bao trùm MỌI thứ ảnh hưởng kết quả (nếu không sẽ trả nhầm dữ liệu)
 * @param {() => Promise<any>} fn
 * @returns {Promise<any>}
 */
function run(key, fn) {
  const k = String(key);
  if (inFlight.has(k)) {
    stats.hits += 1;
    return inFlight.get(k);
  }
  stats.misses += 1;
  // Promise được chia sẻ cho mọi caller; xoá khỏi map khi settle để lần sau vẫn chạy thật.
  const p = (async () => fn())().finally(() => { inFlight.delete(k); });
  inFlight.set(k, p);
  return p;
}

/** Scope riêng cho từng loại tác vụ để khoá không đụng nhau (vision/web/youtube/embedding). */
function scoped(namespace) {
  return (key, fn) => run(`${namespace}::${key}`, fn);
}

function getStats() { return { ...stats, inFlight: inFlight.size }; }
function _resetForTest() { inFlight.clear(); stats.hits = 0; stats.misses = 0; }

module.exports = { run, scoped, getStats, _resetForTest };
