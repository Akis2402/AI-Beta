'use strict';

// ---------- CITATION VALIDATION Ở BACKEND (mục 7) ----------
// TRƯỚC ĐÂY: không có validator nào — citation kiểu [n] do model tự sinh được tin tưởng tuyệt đối,
// kể cả khi n vượt quá số lượng context thực sự có (model "bịa" 1 nguồn không tồn tại). Frontend chỉ
// hiển thị nguyên văn, không đối chiếu ngược lại số lượng context đã gửi.
//
// validateCitations() là NGUỒN SỰ THẬT DUY NHẤT cho việc 1 citation có hợp lệ hay không — chỉ dựa
// trên 1 quy tắc xác định (deterministic), KHÔNG dùng heuristic/LLM để "đoán" — đúng tinh thần ưu
// tiên kiến trúc deterministic của yêu cầu gốc.

const CITATION_RE = /\[(\d{1,3})\]/g;

/**
 * @param {string} text Response text (đã strip <thinking>).
 * @param {Array} contexts Danh sách context đã gửi cho model (1-indexed trong prompt — context thứ
 *   i tương ứng citation [i]). Chỉ cần `contexts.length`, không cần nội dung.
 * @returns {{valid:boolean, invalidCitations:number[], usedContextIds:number[], allCitations:number[]}}
 */
function validateCitations(text, contexts) {
  const n = Array.isArray(contexts) ? contexts.length : 0;
  const clean = String(text || '');
  const all = new Set();
  let m;
  CITATION_RE.lastIndex = 0;
  while ((m = CITATION_RE.exec(clean))) {
    all.add(Number(m[1]));
    if (all.size > 200) break; // pathological guard
  }

  const allCitations = [...all].sort((a, b) => a - b);
  const usedContextIds = allCitations.filter((id) => id >= 1 && id <= n);
  const invalidCitations = allCitations.filter((id) => id < 1 || id > n);

  return { valid: invalidCitations.length === 0, invalidCitations, usedContextIds, allCitations };
}

/**
 * Không cho AI tự bịa tên tài liệu/URL/domain không có trong contexts thật — phát hiện các mẫu URL/
 * domain xuất hiện trong response mà KHÔNG khớp bất kỳ context nào đã cấp (mục 7 cuối). Đây là
 * heuristic BỔ SUNG (không thay thế validateCitations) — chỉ áp dụng khi response thực sự chứa
 * dạng URL, tránh false-positive với văn bản toán học thông thường.
 * @param {string} text
 * @param {Array<{text?:string, url?:string, sourceId?:string, doc?:string}>} contexts
 * @returns {{fabricatedUrls:string[]}}
 */
function detectFabricatedSources(text, contexts) {
  const clean = String(text || '');
  const urlRe = /https?:\/\/[^\s)"'\]]+/g;
  const knownUrls = new Set((contexts || []).map((c) => c.url).filter(Boolean));
  const found = clean.match(urlRe) || [];
  const fabricatedUrls = [...new Set(found)].filter((u) => !knownUrls.has(u));
  return { fabricatedUrls };
}

module.exports = { validateCitations, detectFabricatedSources, CITATION_RE };
