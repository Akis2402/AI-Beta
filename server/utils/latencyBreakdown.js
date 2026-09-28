'use strict';

// ============================================================================================
// MỤC 2.1 (backlog v6.22, .25/.26/.47-.49/.81/.82/.72) — LATENCY PHASE BREAKDOWN
// ============================================================================================
// Nguyên liệu thô đã có (reqLogger.elapsed(), worker_pool_admit, logAttempt().latency) nhưng chưa ai
// gộp thành 1 dòng. Module này gộp, KHÔNG thêm dashboard/UI (ngoài phạm vi P1 này).
//
//   queueWaitMs   : từ lúc xin slot Global Worker Pool tới lúc được admit (0 nếu admit ngay)
//   preProviderMs : từ admit tới lúc lệnh gọi provider ĐẦU TIÊN bắt đầu (validate/nén/route/prompt)
//   providerRunMs : thời gian tường (wall-clock) có ÍT NHẤT 1 lệnh gọi provider đang chạy — hợp các
//                   khoảng [start,end]; cross-check gọi song song KHÔNG bị cộng dồn thành số ảo
//   postProcessMs : từ lệnh gọi provider CUỐI kết thúc tới khi response kết thúc (validate/visual/ghi)
//   totalMs       : toàn bộ request
// Khoảng provider lấy từ logAttempt() của aiProviders.js (đúng 1 điểm nghẽn: mọi attempt thành
// công/lỗi đều đi qua đó, kèm `latency` thật) nên không phải sửa từng điểm gọi p.call/p.callStream.

const trackers = new Map(); // requestId -> tracker

function createTracker({ now = Date.now } = {}) {
  const t0 = now();
  let queueStart = null; let queueWaitMs = 0; let admitAt = null;
  const spans = [];
  return {
    markQueueStart() { queueStart = now(); },
    markAdmitted() { admitAt = now(); queueWaitMs = queueStart == null ? 0 : admitAt - queueStart; },
    /** Ghi 1 attempt provider vừa KẾT THÚC bây giờ, kéo dài `latencyMs`. */
    recordProviderSpan(latencyMs, endAt = now()) {
      const l = Number(latencyMs);
      if (!Number.isFinite(l) || l < 0) return;
      spans.push([endAt - l, endAt]);
    },
    summarize(endAt = now()) {
      const sorted = spans.slice().sort((a, b) => a[0] - b[0]);
      let busy = 0; let curS = null; let curE = null;
      for (const [s, e] of sorted) {
        if (curS === null) { curS = s; curE = e; }
        else if (s <= curE) curE = Math.max(curE, e);
        else { busy += curE - curS; curS = s; curE = e; }
      }
      if (curS !== null) busy += curE - curS;
      const firstStart = sorted.length ? sorted[0][0] : null;
      const lastEnd = sorted.length ? Math.max(...sorted.map((x) => x[1])) : null;
      const totalMs = endAt - t0;
      const from = admitAt == null ? t0 : admitAt;
      return {
        queueWaitMs,
        preProviderMs: firstStart == null ? null : Math.max(0, firstStart - from),
        providerRunMs: busy,
        providerCalls: sorted.length,
        postProcessMs: lastEnd == null ? null : Math.max(0, endAt - lastEnd),
        totalMs
      };
    }
  };
}

function begin(requestId, opts) { const t = createTracker(opts); if (requestId) trackers.set(requestId, t); return t; }
function get(requestId) { return requestId ? trackers.get(requestId) || null : null; }
/** No-op nếu request không đăng ký tracker (đường gọi legacy/test) — giống recordAttemptFor(). */
function recordProviderSpan(requestId, latencyMs) { const t = get(requestId); if (t) t.recordProviderSpan(latencyMs); }
function finish(requestId) { const t = get(requestId); if (!t) return null; trackers.delete(requestId); return t.summarize(); }

module.exports = { createTracker, begin, get, recordProviderSpan, finish };
