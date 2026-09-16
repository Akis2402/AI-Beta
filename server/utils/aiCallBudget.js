'use strict';

// ============================================================================================
// PHẦN D + DY + DZ — NGÂN SÁCH LỆNH GỌI AI, MỖI LỆNH GỌI PHẢI CÓ LÝ DO
// ============================================================================================
// Trước đây hệ thống đếm TOKEN nhưng không đếm SỐ LỆNH GỌI. Hai thứ đó không thay thế được nhau: một
// request "đơn giản" vẫn có thể lặng lẽ chạy classify -> caption -> answer -> judge -> reconcile, mỗi
// lệnh gọi đều nhỏ, tổng lại là 5 lần trả tiền cho một câu hỏi đáng lẽ 1 lần.
//
// Module này KHÔNG chặn lệnh gọi một cách mù quáng — nó buộc mọi lệnh gọi phải khai báo MỤC ĐÍCH và
// ghi lại lệnh nào vượt baseline. Lệnh gọi không có lý do chính đáng sẽ hiện ra trong telemetry thay
// vì lẩn trong tổng token.

/** Baseline theo intent — số lệnh gọi AI "đúng" cho một request bình thường. */
const BASELINE = {
  PLAIN_TEXT: 1,        // 1 answer
  SOURCE_QUERY: 1,      // 1 answer (evidence đã có sẵn từ phase chuẩn bị nguồn)
  WEB_QUERY: 1,
  YOUTUBE_QUERY: 1,
  IMAGE_REFERENCE: 1,
  IMAGE_ONLY: 1         // 1 image generation, KHÔNG caption model (PHẦN AE)
};

/** Mục đích hợp lệ. Tên lạ = lập trình viên đang thêm một lệnh gọi không ai xét duyệt. */
const PURPOSE = {
  ANSWER: 'answer',
  CONTINUATION: 'continuation',
  RECONCILE: 'reconcile',
  CROSS_CHECK: 'cross_check',
  IMAGE_GENERATION: 'image_generation',
  SOURCE_VISION: 'source_vision',
  CAPTION: 'caption',
  CLASSIFY: 'classify',
  JUDGE: 'judge',
  RERANK: 'rerank',
  SUMMARIZE: 'summarize'
};

/** Mục đích chỉ được phép khi có ĐIỀU KIỆN cụ thể, không bao giờ mặc định (PHẦN BS/BT/EA/AE). */
const CONDITIONAL_PURPOSES = new Set([
  PURPOSE.CONTINUATION, PURPOSE.RECONCILE, PURPOSE.CAPTION,
  PURPOSE.CLASSIFY, PURPOSE.JUDGE, PURPOSE.RERANK, PURPOSE.SUMMARIZE
]);

function createCallBudget({ intent = 'PLAIN_TEXT', maxCalls = 8 } = {}) {
  const baseline = BASELINE[intent] != null ? BASELINE[intent] : 1;
  const calls = [];

  /**
   * @param {string} purpose  một trong PURPOSE
   * @param {{reason?:string, provider?:string, model?:string}} [meta]
   *   `reason` BẮT BUỘC với các purpose có điều kiện — nếu thiếu, telemetry đánh dấu `unjustified`
   *   để lộ ra trong log thay vì im lặng trôi qua.
   * @returns {{allowed:boolean, index:number, overBudget:boolean, unjustified:boolean}}
   */
  function record(purpose, meta = {}) {
    const unjustified = CONDITIONAL_PURPOSES.has(purpose) && !meta.reason;
    const entry = {
      purpose,
      reason: meta.reason || null,
      provider: meta.provider || null,
      model: meta.model || null,
      unjustified
    };
    calls.push(entry);
    return {
      allowed: calls.length <= maxCalls,
      index: calls.length,
      overBudget: calls.length > baseline,
      unjustified
    };
  }

  function snapshot() {
    const byPurpose = {};
    calls.forEach((c) => { byPurpose[c.purpose] = (byPurpose[c.purpose] || 0) + 1; });
    return {
      aiCallIntent: intent,
      aiCallBaseline: baseline,
      aiCallCount: calls.length,
      aiCallsByPurpose: byPurpose,
      aiCallsOverBaseline: Math.max(0, calls.length - baseline),
      aiCallsUnjustified: calls.filter((c) => c.unjustified).length,
      aiCallPurposes: calls.map((c) => c.purpose)
    };
  }

  return { record, snapshot, get count() { return calls.length; }, baseline };
}

module.exports = { createCallBudget, BASELINE, PURPOSE, CONDITIONAL_PURPOSES };
