'use strict';

// ============================================================================================
// PROMPT V5 — PHẦN O (ADAPTIVE SOURCE TOKEN BUDGET) + PHẦN P (PER-SOURCE BUDGET) + PHẦN AS
// (SOURCE FAIRNESS) + PHẦN Q (REQUIREMENT COVERAGE — KHÔNG CẮT NGỮ CẢNH KHỚP YÊU CẦU TƯỜNG MINH)
// ============================================================================================
// TRƯỚC: `validators.js` chỉ có 1 TRẦN BẢO MẬT duy nhất (SECURITY_MAX_CONTEXTS=300 context,
// SECURITY_MAX_CONTEXT_LEN=4000 ký tự/context) — trần đó tồn tại để chặn DoS (client cố tình nhồi
// hàng chục nghìn context), KHÔNG phải để quyết định "câu hỏi này cần bao nhiêu ngữ cảnh". Hệ quả:
// câu "Đáp án câu 1 là gì?" và câu "Đối chiếu 1.9 đến 1.20 giữa PDF, bài báo và transcript" đi qua
// ĐÚNG một mức trần như nhau — client đã retrieve sao thì server gửi nguyên vào prompt vậy.
//
// Module này thêm MỘT TẦNG THẤP HƠN, adaptive, ĐỨNG TRƯỚC citeNo (buildCitationIndex) để số trích
// dẫn cuối cùng luôn khớp đúng với những gì thực sự được gửi — không có gì bị "cắt sau khi đã đánh
// số [3]" khiến câu trả lời trích dẫn một citation không tồn tại trong prompt.
//
// NGUYÊN TẮC (PHẦN CW/CX): khi phải cắt, KHÔNG BAO GIỜ đụng tới context khớp một nhãn yêu cầu tường
// minh (`requirementLabels` — PHẦN F "chống bịa bài có số thứ tự cụ thể"), và khi có ≥2 nguồn khác
// nhau đang active, MỖI nguồn vẫn giữ tối thiểu 1 context (PHẦN AS: không để 1 nguồn = 0% khi câu hỏi
// cần đối chiếu). Nói cách khác: fairness/coverage LUÔN thắng ngân sách khi 2 thứ xung đột — module
// này ưu tiên "đủ" hơn "đúng số ký tự mục tiêu", đúng thứ tự ưu tiên PHẦN ER (1. user query, 2. ảnh
// người dùng chọn, 3. exact source evidence, 4. citation cần, 5. history liên quan...).

// PHẦN O: bảng baseline theo ký tự — KHÔNG dùng 1 số cố định (vd 60k) cho mọi query.
const TIERS = [
  { name: 'MICRO', charBudget: 10000 },
  { name: 'SHORT', charBudget: 14000 },
  { name: 'MEDIUM', charBudget: 18000 },
  { name: 'LONG', charBudget: 26000 },
  { name: 'VERY_COMPLEX', charBudget: 32000 }
];

/**
 * Phân loại độ khó bằng TÍN HIỆU DETERMINISTIC có sẵn — KHÔNG gọi AI để "hỏi câu này khó không"
 * (PHẦN BE/BL: routing/complexity phải deterministic, không AI-on-AI).
 * @param {{query?:string, requirementLabels?:string[], unmatchedRequirementLabels?:string[], sourceCount?:number}} args
 * @returns {{tier:string, charBudget:number, score:number}}
 */
function classifyDifficulty({ query = '', requirementLabels = [], unmatchedRequirementLabels = [], sourceCount = 1 } = {}) {
  let score = 0;
  const qlen = String(query || '').length;
  if (qlen > 300) score += 2; else if (qlen > 120) score += 1;

  const reqCount = requirementLabels.length;
  if (reqCount >= 5) score += 3; else if (reqCount >= 3) score += 2; else if (reqCount >= 1) score += 1;

  if (sourceCount >= 3) score += 2; else if (sourceCount === 2) score += 1;

  // Nhãn CHƯA khớp evidence (unmatchedRequirementLabels) là tín hiệu mơ hồ/khó retrieval — cần thêm
  // ngữ cảnh xung quanh để model tự định vị, không phải cắt chặt.
  if (unmatchedRequirementLabels.length) score += 1;

  const idx = Math.max(0, Math.min(TIERS.length - 1, score));
  return { tier: TIERS[idx].name, charBudget: TIERS[idx].charBudget, score };
}

/**
 * Cắt `contexts` (đã được client retrieve + server lọc provenance) về đúng ngân sách ký tự thích ứng.
 * Gọi TRƯỚC buildCitationIndex() — citeNo phải khớp với đúng tập context thật sự được gửi.
 *
 * @param {Array<{text:string, doc?:string, id?:number, sourceId?:string|null, retrievalTier?:number|null}>} contexts
 * @param {{charBudget:number, requirementLabels?:string[], tierName?:string}} opts
 * @returns {{contexts:Array, dropped:Array<{doc:string, id:number, sourceId:string|null, reason:string}>,
 *   withinBudgetAlready:boolean, totalChars:number, budget:number}}
 */
function planSourceContexts(contexts, opts = {}) {
  const list = Array.isArray(contexts) ? contexts : [];
  const totalChars = list.reduce((a, c) => a + ((c && c.text) ? c.text.length : 0), 0);
  const budget = Number.isFinite(opts.charBudget) ? opts.charBudget : Infinity;

  // PHẦN CW: đã trong ngân sách -> KHÔNG đụng gì. "Adaptive" nghĩa là chỉ can thiệp khi thật sự dư,
  // không phải nén mọi request cho bằng được.
  if (!list.length || totalChars <= budget) {
    return { contexts: list, dropped: [], withinBudgetAlready: true, totalChars, budget };
  }

  const requirementLabels = (opts.requirementLabels || []).map((l) => String(l || '').toLowerCase()).filter(Boolean);
  const matchesRequirement = (text) => {
    const lower = String(text || '').toLowerCase();
    return requirementLabels.some((label) => lower.includes(label));
  };

  // PHẦN Q: context khớp 1 nhãn yêu cầu tường minh -> PROTECTED, không bao giờ bị bước này loại.
  const protectedItems = [];
  const candidateItems = [];
  list.forEach((c) => {
    (matchesRequirement(c && c.text) ? protectedItems : candidateItems).push(c);
  });

  const protectedChars = protectedItems.reduce((a, c) => a + c.text.length, 0);
  const remaining = Math.max(0, budget - protectedChars);

  // PHẦN P/AS: chia ngân sách còn lại THEO NGUỒN — chia đều theo số nguồn trước (sàn công bằng),
  // không phải theo tổng ký tự mỗi nguồn đóng góp (nếu không, nguồn nào client retrieve nhiều hơn sẽ
  // luôn thắng, đúng lỗi PHẦN AS cảnh báo: "không để 1 nguồn chiếm 100% context budget").
  const bySource = new Map();
  candidateItems.forEach((c) => {
    const key = (c && (c.sourceId || c.doc)) || 'default';
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push(c);
  });
  const sourceKeys = [...bySource.keys()];
  const equalShare = sourceKeys.length ? Math.floor(remaining / sourceKeys.length) : 0;

  const dropped = [];
  const kept = [...protectedItems];
  sourceKeys.forEach((key) => {
    const items = bySource.get(key);
    // Giữ theo TIER retrieval trước (exact > neighbor > semantic — PHẦN N/tier thấp hơn = ưu tiên
    // cao hơn), giữ nguyên thứ tự client gửi (đã là thứ tự relevance) khi cùng tier.
    const ordered = [...items].sort((a, b) => (a.retrievalTier ?? 99) - (b.retrievalTier ?? 99));
    let used = 0;
    ordered.forEach((c) => {
      const len = (c.text || '').length;
      // PHẦN AS: LUÔN giữ context ĐẦU TIÊN của mỗi nguồn active, kể cả khi tự nó đã vượt phần chia —
      // "nguồn = 0%" tệ hơn "vượt ngân sách mục tiêu 1 chút".
      if (used === 0 || used + len <= equalShare) {
        kept.push(c);
        used += len;
      } else {
        dropped.push({ doc: c.doc || '', id: c.id, sourceId: c.sourceId || null, reason: 'source_budget_exceeded' });
      }
    });
  });

  // Giữ đúng thứ tự GỐC (không phải thứ tự vừa duyệt theo nguồn) — buildCitationIndex chạy sau, và
  // citeNo nên theo đúng thứ tự client đã gửi để không gây khó hiểu.
  const keptSet = new Set(kept);
  const finalContexts = list.filter((c) => keptSet.has(c));

  return { contexts: finalContexts, dropped, withinBudgetAlready: false, totalChars, budget };
}

module.exports = { TIERS, classifyDifficulty, planSourceContexts };
