'use strict';

// ============================================================================================
// PHẦN D + DY + DZ + MỤC 6 — ADMISSION CONTROLLER THẬT CHO LỆNH GỌI AI
// ============================================================================================
// Trước đây hệ thống đếm TOKEN nhưng không đếm SỐ LỆNH GỌI. Hai thứ đó không thay thế được nhau: một
// request "đơn giản" vẫn có thể lặng lẽ chạy classify -> caption -> answer -> judge -> reconcile, mỗi
// lệnh gọi đều nhỏ, tổng lại là 5 lần trả tiền cho một câu hỏi đáng lẽ 1 lần.
//
// MỤC 6 yêu cầu module này thôi chỉ GHI CHÉP mà phải THỰC SỰ QUYẾT ĐỊNH:
//
//   CALL REQUEST -> CHECK PURPOSE -> CHECK STAGE -> CHECK RISK -> CHECK REMAINING BUDGET
//                -> ALLOW / DENY / DEGRADED
//
// Ma trận STAGE_POLICY dưới đây là NGUỒN SỰ THẬT DUY NHẤT cho câu hỏi "stage này được phép gọi
// purpose gì". Trước bản vá này, record() chỉ gắn cờ `unjustified`/`overBudget` để LỘ RA trong log —
// không có gì THỰC SỰ NGĂN 1 lệnh gọi 'reconcile' hay 'image_generation' chạy ở stage 'approach'.
// Nay `admit()` trả `ALLOW`/`DEGRADED`/`DENY` và caller (chat.js) BẮT BUỘC phải throw khi nhận DENY —
// test AC-DENY khoá bất biến này bằng cách gọi thẳng module, không qua chat.js, để không phụ thuộc
// độ đầy đủ của việc wiring.

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

const DECISION = { ALLOW: 'ALLOW', DEGRADED: 'DEGRADED', DENY: 'DENY' };

/**
 * Ma trận stage x purpose ĐÚNG NHƯ MỤC 6 của yêu cầu:
 *   APPROACH: answer=allowed, continuation=tightly limited, reconcile/judge/rerank/summarize=forbidden,
 *             caption=forbidden nếu deterministic đủ, image_generation=allowed (PHẦN 21: approach là
 *             nơi DUY NHẤT được auto-generate visual).
 *   DETAIL:   answer=allowed, continuation/cross_check/reconcile/judge=conditional, image=forbidden.
 *   IMAGE:    image_generation=allowed, caption=forbidden nếu deterministic đủ.
 * `conditional` nghĩa là ALLOW nhưng chỉ khi meta.reason có mặt — thiếu reason -> DEGRADED (không
 * chặn cứng, nhưng bị hạ cấp + lộ ra telemetry, đúng tinh thần "ngoại lệ phải log rõ lý do").
 */
const STAGE_POLICY = {
  approach: {
    [PURPOSE.ANSWER]: 'allowed',
    [PURPOSE.IMAGE_GENERATION]: 'allowed',
    [PURPOSE.SOURCE_VISION]: 'allowed',
    [PURPOSE.CONTINUATION]: 'limited', // tightly limited — xem maxContinuationsPerStage
    [PURPOSE.RECONCILE]: 'forbidden',
    [PURPOSE.CROSS_CHECK]: 'forbidden',
    [PURPOSE.JUDGE]: 'forbidden',
    [PURPOSE.RERANK]: 'forbidden',
    [PURPOSE.SUMMARIZE]: 'forbidden',
    [PURPOSE.CAPTION]: 'conditional',
    [PURPOSE.CLASSIFY]: 'conditional'
  },
  detail: {
    [PURPOSE.ANSWER]: 'allowed',
    [PURPOSE.CONTINUATION]: 'conditional',
    [PURPOSE.CROSS_CHECK]: 'conditional',
    [PURPOSE.RECONCILE]: 'conditional',
    [PURPOSE.JUDGE]: 'conditional',
    [PURPOSE.RERANK]: 'conditional',
    [PURPOSE.SUMMARIZE]: 'conditional',
    [PURPOSE.CAPTION]: 'conditional',
    [PURPOSE.CLASSIFY]: 'conditional',
    [PURPOSE.IMAGE_GENERATION]: 'forbidden', // mục 23/26: Detail không được generate image
    [PURPOSE.SOURCE_VISION]: 'allowed'
  },
  image: {
    [PURPOSE.IMAGE_GENERATION]: 'allowed',
    [PURPOSE.CAPTION]: 'conditional', // forbidden nếu deterministic caption đủ -> caller phải nêu reason
    [PURPOSE.ANSWER]: 'forbidden',
    [PURPOSE.RECONCILE]: 'forbidden',
    [PURPOSE.CROSS_CHECK]: 'forbidden'
  },
  // stage nội bộ khác (candidate/reconcile/reconcileLight) dùng chung policy 'detail' — chúng là
  // các lượt gọi PHỤC VỤ đúng 1 request detail, không phải stage độc lập người dùng chọn.
  candidate: null, reconcile: null, reconcileLight: null
};
STAGE_POLICY.candidate = STAGE_POLICY.detail;
STAGE_POLICY.reconcile = STAGE_POLICY.detail;
STAGE_POLICY.reconcileLight = STAGE_POLICY.detail;

const DEFAULT_MAX_CONTINUATIONS_APPROACH = 1; // "tightly limited" — approach hiếm khi cần viết tiếp

function createCallBudget({ intent = 'PLAIN_TEXT', maxCalls = 8, stage = 'detail' } = {}) {
  const baseline = BASELINE[intent] != null ? BASELINE[intent] : 1;
  const calls = [];
  const continuationsByStage = new Map();

  /**
   * admit() — MỤC 6: CALL REQUEST -> purpose -> stage -> risk -> remaining budget -> quyết định.
   * Đây là hàm caller PHẢI gọi TRƯỚC khi thực hiện lệnh gọi AI (không phải sau, khác với record()
   * cũ vốn chỉ ghi lại SAU KHI đã gọi xong). Không throw — trả quyết định để caller tự xử lý, vì một
   * số nơi gọi (vd continuation khi provider vừa chết giữa chừng) cần fallback thay vì crash cả
   * request; chat.js quyết định throw hay không dựa trên `decision`.
   *
   * @param {string} purpose một trong PURPOSE
   * @param {string} callStage stage CỦA LỆNH GỌI NÀY (không phải stage tổng của request — 1 request
   *   detail có thể có lệnh continuation cũng ở stage 'detail', nhưng reconcile lại dùng policy riêng)
   * @param {{reason?:string, provider?:string, model?:string, risk?:'low'|'medium'|'high'}} [meta]
   * @returns {{decision:'ALLOW'|'DEGRADED'|'DENY', reason:string, index:number}}
   */
  function admit(purpose, callStage, meta = {}) {
    const policy = STAGE_POLICY[callStage] || STAGE_POLICY.detail;
    const rule = policy[purpose];

    // 1. CHECK PURPOSE + STAGE — luật cấm cứng theo ma trận, không có ngoại lệ.
    if (rule === 'forbidden') {
      return { decision: DECISION.DENY, reason: `${purpose}_forbidden_at_stage_${callStage}`, index: calls.length };
    }
    if (rule === undefined) {
      // Purpose không có trong ma trận của stage này = chưa ai xét duyệt cho tổ hợp này -> DENY an
      // toàn thay vì mặc định ALLOW (mục 6: \"không có lý do chính đáng thì không được gọi\").
      return { decision: DECISION.DENY, reason: `${purpose}_not_authorized_at_stage_${callStage}`, index: calls.length };
    }

    // 2. CHECK RISK — high risk mà không kèm lý do -> DEGRADED (không chặn cứng, nhưng hạ cấp +
    // buộc lộ ra telemetry). Ví dụ: reconcile ở risk 'high' (candidate bất đồng nhiều) không có
    // reason vẫn được coi là thiếu minh bạch.
    if (meta.risk === 'high' && !meta.reason) {
      return { decision: DECISION.DEGRADED, reason: `${purpose}_high_risk_no_reason`, index: calls.length };
    }

    // 3. 'limited' (approach continuation) — trần cứng riêng, KHÔNG dùng chung maxCalls tổng.
    if (rule === 'limited') {
      const used = continuationsByStage.get(callStage) || 0;
      if (used >= DEFAULT_MAX_CONTINUATIONS_APPROACH) {
        return { decision: DECISION.DENY, reason: `${purpose}_continuation_limit_reached_at_stage_${callStage}`, index: calls.length };
      }
    }

    // 4. 'conditional' — ALLOW chỉ khi có reason; thiếu reason -> DEGRADED (không chặn, nhưng đánh
    // dấu unjustified để lộ ra telemetry, giữ đúng hành vi record() cũ cho các call site chưa kịp
    // cập nhật để truyền reason).
    if (rule === 'conditional' && !meta.reason) {
      return { decision: DECISION.DEGRADED, reason: `${purpose}_conditional_no_reason`, index: calls.length };
    }

    // 5. CHECK REMAINING CALL BUDGET — trần cứng tổng số lệnh gọi của cả request.
    if (calls.length >= maxCalls) {
      return { decision: DECISION.DENY, reason: `call_budget_exhausted_${calls.length}/${maxCalls}`, index: calls.length };
    }

    return { decision: DECISION.ALLOW, reason: 'ok', index: calls.length };
  }

  /**
   * @param {string} purpose  một trong PURPOSE
   * @param {{reason?:string, provider?:string, model?:string}} [meta]
   *   `reason` BẮT BUỘC với các purpose có điều kiện — nếu thiếu, telemetry đánh dấu `unjustified`
   *   để lộ ra trong log thay vì im lặng trôi qua.
   * @returns {{allowed:boolean, index:number, overBudget:boolean, unjustified:boolean}}
   */
  function record(purpose, meta = {}) {
    const unjustified = CONDITIONAL_PURPOSES.has(purpose) && !meta.reason;
    const callStage = meta.stage || stage;
    const entry = {
      purpose,
      stage: callStage,
      reason: meta.reason || null,
      provider: meta.provider || null,
      model: meta.model || null,
      unjustified
    };
    calls.push(entry);
    if ((STAGE_POLICY[callStage] || STAGE_POLICY.detail)[purpose] === 'limited') {
      continuationsByStage.set(callStage, (continuationsByStage.get(callStage) || 0) + 1);
    }
    return {
      allowed: calls.length <= maxCalls,
      index: calls.length,
      overBudget: calls.length > baseline,
      unjustified
    };
  }

  /** Gọi liền admit() rồi record() nếu ALLOW/DEGRADED — 1 điểm gọi duy nhất cho caller mới. */
  function requestCall(purpose, callStage, meta = {}) {
    const decision = admit(purpose, callStage, meta);
    if (decision.decision === DECISION.DENY) return decision;
    const rec = record(purpose, { ...meta, stage: callStage });
    return { ...decision, ...rec };
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

  return { admit, record, requestCall, snapshot, get count() { return calls.length; }, baseline };
}

/** Ném khi admit() trả DENY và caller chọn chặn cứng thay vì tự xử lý fallback. */
class AiCallDeniedError extends Error {
  constructor(decision) {
    super(`AI call denied: ${decision.reason}`);
    this.name = 'AiCallDeniedError';
    this.code = 'AI_CALL_DENIED';
    this.decision = decision;
  }
}

module.exports = {
  createCallBudget, BASELINE, PURPOSE, CONDITIONAL_PURPOSES,
  DECISION, STAGE_POLICY, AiCallDeniedError, DEFAULT_MAX_CONTINUATIONS_APPROACH
};
