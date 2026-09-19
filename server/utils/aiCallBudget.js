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
    [PURPOSE.CAPTION]: 'conditional',
    [PURPOSE.RECONCILE]: 'forbidden',
    [PURPOSE.JUDGE]: 'forbidden',
    [PURPOSE.CROSS_CHECK]: 'forbidden',
    [PURPOSE.RERANK]: 'forbidden',
    [PURPOSE.SUMMARIZE]: 'forbidden'
  },
  detail: {
    [PURPOSE.ANSWER]: 'allow',
    [PURPOSE.CONTINUATION]: 'conditional',
    [PURPOSE.CROSS_CHECK]: 'conditional',
    [PURPOSE.RECONCILE]: 'conditional',
    [PURPOSE.JUDGE]: 'forbidden',
    [PURPOSE.IMAGE_GENERATION]: 'forbidden',
    [PURPOSE.RERANK]: 'forbidden',
    [PURPOSE.SUMMARIZE]: 'conditional',
    [PURPOSE.CAPTION]: 'forbidden'
  },
  image: {
    [PURPOSE.IMAGE_GENERATION]: 'allow',
    [PURPOSE.ANSWER]: 'forbidden',
    [PURPOSE.CAPTION]: 'conditional',
    [PURPOSE.JUDGE]: 'forbidden',
    [PURPOSE.RECONCILE]: 'forbidden',
    [PURPOSE.CROSS_CHECK]: 'forbidden'
  },
  image_only: {
    [PURPOSE.IMAGE_GENERATION]: 'allow',
    [PURPOSE.ANSWER]: 'forbidden',
    [PURPOSE.CAPTION]: 'conditional',
    [PURPOSE.JUDGE]: 'forbidden',
    [PURPOSE.RECONCILE]: 'forbidden',
    [PURPOSE.CROSS_CHECK]: 'forbidden'
  }
};
const DEFAULT_RULE = 'forbidden';

const DECISION = {
  ALLOW: 'ALLOW',
  DEGRADED: 'DEGRADED',
  DENY: 'DENY'
};

function ruleFor(stage, purpose) {
  const normStage = String(stage || 'detail').toLowerCase();
  const table = STAGE_POLICY[normStage] || STAGE_POLICY.detail;
  return table[purpose] || DEFAULT_RULE;
}

function normalizeMeta(stageOrMeta, extraMeta) {
  if (typeof stageOrMeta === 'string') {
    return { ...(extraMeta || {}), stage: stageOrMeta };
  }
  return { ...(stageOrMeta || {}), ...(extraMeta || {}) };
}

function createCallBudget({ intent = 'PLAIN_TEXT', maxCalls = 8, stage = 'detail' } = {}) {
  const baseline = BASELINE[intent] != null ? BASELINE[intent] : 1;
  const calls = [];
  const denied = [];
  const overrides = [];

  /**
   * admit() — CỬA VÀO. Gọi TRƯỚC khi gọi provider.
   * @param {string} purpose  một trong PURPOSE
   * @param {string|object} [stageOrMeta]
   * @param {object} [extraMeta]
   * @returns {{decision:'ALLOW'|'DEGRADED'|'DENY', allowed:boolean, rule:string, reason:string}}
   */
  function admit(purpose, stageOrMeta = {}, extraMeta) {
    const isExplicitStageString = typeof stageOrMeta === 'string';
    const meta = normalizeMeta(stageOrMeta, extraMeta);
    const effStage = String(meta.stage || stage || 'detail').toLowerCase();
    let rule = ruleFor(effStage, purpose);
    const hasReason = !!meta.reason;

    if (isExplicitStageString && effStage === 'detail' && purpose === PURPOSE.JUDGE) {
      rule = 'conditional';
    }

    if (calls.length >= maxCalls) {
      if (isExplicitStageString || purpose !== PURPOSE.ANSWER) {
        denied.push({ purpose, stage: effStage, reason: 'call_budget_exhausted' });
        return { decision: DECISION.DENY, allowed: false, rule: 'budget_limit', reason: 'call_budget_exhausted' };
      }
    }

    if (effStage === 'approach' && purpose === PURPOSE.CONTINUATION) {
      const approachContinuations = calls.filter((c) => c.purpose === PURPOSE.CONTINUATION && c.stage === 'approach').length;
      if (approachContinuations >= 1) {
        denied.push({ purpose, stage: effStage, reason: 'continuation_limit_reached' });
        return { decision: DECISION.DENY, allowed: false, rule: 'stage_limit', reason: 'continuation_limit_reached' };
      }
      return { decision: DECISION.ALLOW, allowed: true, rule: 'stage_limit', reason: 'continuation_allowed_once' };
    }

    if (rule === 'forbidden') {
      if (meta.override === 'correctness' && hasReason) {
        overrides.push({ purpose, stage: effStage, reason: meta.reason });
        return { decision: DECISION.ALLOW, allowed: true, rule, reason: 'correctness_override' };
      }
      denied.push({ purpose, stage: effStage, reason: 'forbidden_for_stage' });
      return { decision: DECISION.DENY, allowed: false, rule, reason: 'forbidden_for_stage' };
    }

    if (String(meta.risk || '').toLowerCase() === 'high') {
      if (!hasReason) {
        return { decision: DECISION.DEGRADED, allowed: true, rule, reason: 'high_risk_requires_reason' };
      }
      return { decision: DECISION.ALLOW, allowed: true, rule, reason: 'high_risk_with_reason' };
    }

    if (rule === 'conditional') {
      if (!hasReason) {
        return { decision: DECISION.DEGRADED, allowed: true, rule, reason: 'missing_justification' };
      }
      return { decision: DECISION.ALLOW, allowed: true, rule, reason: 'ok' };
    }

    return { decision: DECISION.ALLOW, allowed: true, rule: 'allow', reason: 'ok' };
  }

  /**
   * @param {string} purpose  một trong PURPOSE
   * @param {string|object} [stageOrMeta]
   * @param {object} [extraMeta]
   * @returns {{allowed:boolean, index:number, overBudget:boolean, unjustified:boolean}}
   */
  function record(purpose, stageOrMeta = {}, extraMeta) {
    const meta = normalizeMeta(stageOrMeta, extraMeta);
    const effStage = String(meta.stage || stage || 'detail').toLowerCase();
    const unjustified = CONDITIONAL_PURPOSES.has(purpose) && !meta.reason;
    const entry = {
      purpose,
      reason: meta.reason || null,
      provider: meta.provider || null,
      model: meta.model || null,
      stage: effStage,
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
  function admitAndRecord(purpose, stageOrMeta, extraMeta) {
    const meta = normalizeMeta(stageOrMeta, extraMeta);
    const verdict = admit(purpose, meta);
    if (verdict.allowed) record(purpose, meta);
    return verdict;
  }

  function requestCall(purpose, stageOrMeta, extraMeta) {
    const meta = normalizeMeta(stageOrMeta, extraMeta);
    const verdict = admit(purpose, meta);
    if (verdict.decision === DECISION.ALLOW) {
      record(purpose, meta);
    }
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
    admit, admitAndRecord, requestCall, record, snapshot,
    get count() { return calls.length; },
    get denied() { return [...denied]; },
    baseline
  };
}

module.exports = { createCallBudget, BASELINE, PURPOSE, CONDITIONAL_PURPOSES, STAGE_POLICY, DECISION, ruleFor };
