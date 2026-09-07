'use strict';

// ---------- SOURCE COVERAGE THEO REQUIREMENT (mục 9/10/11) ----------
// TRƯỚC ĐÂY: `const hasWebSearch = true;` hardcode ở chat.js — bật web cho MỌI lượt tổng hợp bất kể
// tài liệu người dùng đã đủ hay chưa, và không có bước nào thực sự đo "đủ" theo TỪNG YÊU CẦU của đề
// bài (chỉ có 1 ngưỡng keyword-overlap duy nhất, hoặc không có gì).
//
// Module này:
//  1. Không coi context nhận từ client là "toàn bộ nguồn" — nó là 1 SELECTED/COMPRESSED CONTEXT
//     (excerpt), có thể đã bị clip (xem validators.js: field `truncated`). Nếu có khả năng bị clip,
//     KHÔNG được kết luận "source không đủ" một cách chắc chắn — luôn để ngỏ khả năng thiếu.
//  2. Soi coverage theo TỪNG YÊU CẦU tách từ đề bài (dùng lại extractCoverageList), không chỉ 1 con
//     số keyword-overlap tổng (mục 10 cấm dùng "keyword overlap >= 55%" làm tiêu chí DUY NHẤT) — yêu
//     cầu nào có nhắc tới công thức/định lý/định nghĩa phải có overlap CAO HƠN mới coi là đủ.

const { extractCoverageList } = require('./completenessCheck');

const FORMULA_HINT_RE = /(công thức|định lý|định lí|định nghĩa|diện tích|thể tích|chu vi|phương trình|đạo hàm|tích phân|hệ số|định luật)/i;
const OVERLAP_THRESHOLD = 0.35;
const FORMULA_OVERLAP_THRESHOLD = 0.6;

function keywordsOf(str) {
  return new Set(
    String(str || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3)
  );
}

function overlapRatio(needle, hay) {
  if (!needle.size) return 0;
  let hit = 0;
  needle.forEach((w) => { if (hay.has(w)) hit++; });
  return hit / needle.size;
}

/**
 * @param {{problemText:string, contexts:Array<{text:string, truncated?:boolean}>}} args
 * @returns {{
 *   complete:boolean, missing:string[], webRequired:boolean, possiblyExcerpt:boolean,
 *   perRequirement:Array<{label:string, ratio:number, covered:boolean}>
 * }}
 */
function analyzeSourceCoverage({ problemText, contexts }) {
  const list = extractCoverageList(problemText);
  const requirements = list.length ? list : ['(yêu cầu chính của đề bài)'];

  // Không có context nào — chắc chắn phải cần kiến thức chuẩn/web cho toàn bộ (mục 11: webRequired=true).
  if (!contexts || !contexts.length) {
    return { complete: false, missing: requirements, webRequired: true, possiblyExcerpt: false, perRequirement: [] };
  }

  const combinedContext = contexts.map((c) => c.text).join('\n');
  const contextKeywords = keywordsOf(combinedContext);
  // mục 9: nếu BẤT KỲ context nào đã bị clip, coi context hiện có chỉ là EXCERPT — không đủ căn cứ để
  // kết luận "source đủ" một cách chắc chắn dù coverage đo được có vẻ cao.
  const possiblyExcerpt = contexts.some((c) => c.truncated);

  let perRequirement;
  if (list.length) {
    perRequirement = list.map((label) => {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`${escaped}\\s*[).]\\s*([^\\n]{0,240})`, 'i');
      const m = problemText.match(re);
      const segment = m ? m[1] : problemText;
      const segKeywords = keywordsOf(segment);
      const ratio = overlapRatio(segKeywords, contextKeywords);
      const needsFormula = FORMULA_HINT_RE.test(segment);
      // mục 25: keyword overlap cao nhưng yêu cầu này có nhắc công thức mà overlap chưa đủ CAO ->
      // vẫn coi là THIẾU (không chỉ dựa 1 ngưỡng chung).
      const covered = ratio >= OVERLAP_THRESHOLD && !(needsFormula && ratio < FORMULA_OVERLAP_THRESHOLD);
      return { label, ratio, covered, needsFormula };
    });
  } else {
    const ratio = overlapRatio(keywordsOf(problemText), contextKeywords);
    perRequirement = [{ label: requirements[0], ratio, covered: ratio >= OVERLAP_THRESHOLD, needsFormula: false }];
  }

  const missing = perRequirement.filter((r) => !r.covered).map((r) => r.label);
  const complete = missing.length === 0 && !possiblyExcerpt;
  const webRequired = missing.length > 0 || possiblyExcerpt;

  return { complete, missing, webRequired, possiblyExcerpt, perRequirement };
}

module.exports = { analyzeSourceCoverage, OVERLAP_THRESHOLD, FORMULA_OVERLAP_THRESHOLD };
