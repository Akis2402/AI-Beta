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

// ============================================================================================
// MỤC 6 — ADMISSION CONTROLLER THẬT (ALLOW / DEGRADED / DENY), KHÔNG CHỈ GHI TELEMETRY
// ============================================================================================
// Bản trước chỉ có `record()`: lệnh gọi ĐÃ XẢY RA rồi mới được ghi lại, kèm cờ `overBudget` mà không
// ai đọc. Tức là module mang tên "ngân sách lệnh gọi" nhưng chưa bao giờ TỪ CHỐI một lệnh gọi nào.
//
// Nay mỗi lệnh gọi phải đi qua `admit(purpose, {stage, risk, reason})` TRƯỚC khi gọi provider:
//
//   CALL REQUEST -> PURPOSE -> STAGE -> RISK -> REMAINING CALL BUDGET -> ALLOW | DEGRADED | DENY
//
// Ma trận stage × purpose dưới đây là hợp đồng viết thẳng ra, không phải luật ngầm rải trong route:
//   'allow'       — được phép, không cần lý do.
//   'conditional' — được phép NHƯNG phải khai `reason`; thiếu reason -> DEGRADED (vẫn chạy, bị đánh
//                   dấu `unjustified` để lộ ra trong log thay vì lẩn vào tổng token).
//   'forbidden'   — DENY. Nơi gọi PHẢI tôn trọng: không gọi provider.
//
// Ngoại lệ correctness: `admit(..., {override:'correctness', reason})` cho phép vượt một purpose bị
// cấm, nhưng bị ghi `overrides` và BẮT BUỘC có reason — đúng tinh thần mục 6 ("ngoại lệ phải log rõ
// lý do"), không phải một cửa hậu im lặng.
const STAGE_POLICY = {
  approach: {
    [PURPOSE.ANSWER]: 'allow',
    [PURPOSE.CONTINUATION]: 'conditional',
    [PURPOSE.IMAGE_GENERATION]: 'allow',
    [PURPOSE.JUDGE]: 'conditional',
    [PURPOSE.RECONCILE]: 'forbidden',
    [PURPOSE.CROSS_CHECK]: 'forbidden',
    [PURPOSE.RERANK]: 'forbidden',
    [PURPOSE.SUMMARIZE]: 'forbidden',
    [PURPOSE.CAPTION]: 'forbidden'
  },
  detail: {
    [PURPOSE.ANSWER]: 'allow',
    [PURPOSE.CONTINUATION]: 'conditional',
    [PURPOSE.CROSS_CHECK]: 'conditional',
    [PURPOSE.RECONCILE]: 'conditional',
    [PURPOSE.JUDGE]: 'forbidden',        // mục 24/32: Detail không gọi visual judge
    [PURPOSE.IMAGE_GENERATION]: 'forbidden', // mục 23/31: Detail không sinh ảnh
    [PURPOSE.RERANK]: 'forbidden',
    [PURPOSE.SUMMARIZE]: 'conditional',
    [PURPOSE.CAPTION]: 'forbidden'
  },
  image_only: {
    [PURPOSE.IMAGE_GENERATION]: 'allow',
    [PURPOSE.ANSWER]: 'conditional',
    [PURPOSE.CAPTION]: 'conditional',    // chỉ khi IMAGE_CAPTION_MODEL=1 (mục 36)
    [PURPOSE.JUDGE]: 'forbidden',
    [PURPOSE.RECONCILE]: 'forbidden',
    [PURPOSE.CROSS_CHECK]: 'forbidden'
  }
};
const DEFAULT_RULE = 'conditional';

function ruleFor(stage, purpose) {
  const table = STAGE_POLICY[String(stage || 'detail').toLowerCase()] || STAGE_POLICY.detail;
  return table[purpose] || DEFAULT_RULE;
}

function createCallBudget({ intent = 'PLAIN_TEXT', maxCalls = 8, stage = 'detail' } = {}) {
  const baseline = BASELINE[intent] != null ? BASELINE[intent] : 1;
  const calls = [];
  const denied = [];
  const overrides = [];

  /**
   * admit() — CỬA VÀO. Gọi TRƯỚC khi gọi provider.
   * @param {string} purpose  một trong PURPOSE
   * @param {{stage?:string, risk?:string, reason?:string, override?:string}} [meta]
   * @returns {{decision:'ALLOW'|'DEGRADED'|'DENY', allowed:boolean, rule:string, reason:string}}
   */
  function admit(purpose, meta = {}) {
    const effStage = meta.stage || stage;
    const rule = ruleFor(effStage, purpose);
    const hasReason = !!meta.reason;

    if (rule === 'forbidden') {
      if (meta.override === 'correctness' && hasReason) {
        overrides.push({ purpose, stage: effStage, reason: meta.reason });
        return { decision: 'ALLOW', allowed: true, rule, reason: 'correctness_override' };
      }
      denied.push({ purpose, stage: effStage, reason: 'forbidden_for_stage' });
      return { decision: 'DENY', allowed: false, rule, reason: 'forbidden_for_stage' };
    }

    // Hết ngân sách lệnh gọi CỨNG -> DENY cho mọi purpose không phải ANSWER. Lượt ANSWER là thứ
    // người dùng thực sự hỏi: chặn nó để "tiết kiệm" chính là biến lỗi ngân sách thành câu trả lời
    // cụt — điều mục 0 cấm tuyệt đối.
    if (calls.length >= maxCalls && purpose !== PURPOSE.ANSWER) {
      denied.push({ purpose, stage: effStage, reason: 'call_budget_exhausted' });
      return { decision: 'DENY', allowed: false, rule, reason: 'call_budget_exhausted' };
    }

    if (rule === 'conditional' && !hasReason) {
      return { decision: 'DEGRADED', allowed: true, rule, reason: 'missing_justification' };
    }
    // RISK cao ở purpose có điều kiện: vẫn cho chạy nhưng đánh dấu để telemetry thấy được.
    if (rule === 'conditional' && String(meta.risk || '').toUpperCase() === 'HIGH' && calls.length > baseline) {
      return { decision: 'DEGRADED', allowed: true, rule, reason: 'over_baseline_high_risk' };
    }
    return { decision: 'ALLOW', allowed: true, rule, reason: 'ok' };
  }

  /**
   * @param {string} purpose  một trong PURPOSE
   * @param {{reason?:string, provider?:string, model?:string, stage?:string}} [meta]
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
      stage: meta.stage || stage,
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

  /** admit() + record() trong một bước, cho call-site chỉ cần biết "có được gọi không". */
  function admitAndRecord(purpose, meta = {}) {
    const verdict = admit(purpose, meta);
    if (verdict.allowed) record(purpose, meta);
    return verdict;
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
      aiCallPurposes: calls.map((c) => c.purpose),
      aiCallsDenied: denied.length,
      aiCallDeniedPurposes: denied.map((d) => `${d.purpose}:${d.reason}`),
      aiCallOverrides: overrides.length
    };
  }

  return {
    admit, admitAndRecord, record, snapshot,
    get count() { return calls.length; },
    get denied() { return [...denied]; },
    baseline
  };
}

module.exports = { createCallBudget, BASELINE, PURPOSE, CONDITIONAL_PURPOSES, STAGE_POLICY, ruleFor };
