'use strict';

// ============================================================================================
// MỤC 2.2 (backlog v6.22, .70) — OUTPUT REDUNDANCY METRICS (quan sát chất lượng, KHÔNG chặn response)
// ============================================================================================
// Hậu kiểm tất định (0 lệnh gọi AI, 0 token) đếm 2 số trên câu trả lời cuối:
//   branchCount           : số "nhánh giải" trình bày (Cách 1/Cách 2, Phương pháp N, Method N, Approach N...)
//   repeatedEquationCount : số lần một phương trình đã xuất hiện Ở LẦN THỨ 2 TRỞ ĐI (tổng occ-1)
// Chỉ để LOG (`output_redundancy`) — chưa có tín hiệu cho thấy cần chặn/viết lại, nên không đổi response.
// Heuristic theo mẫu chữ, KHÔNG phải hiểu toán học: 2 biểu thức tương đương về đại số nhưng viết khác
// nhau được tính là khác nhau (đúng hướng an toàn: đếm thiếu chứ không đếm nhầm).

const BRANCH_RE = /^\s*(?:#{1,6}\s*|[-*+]\s+|\d+[.)]\s+)?(?:\*\*|__)?\s*(?:cách|phương pháp|hướng(?:\s+giải)?|c[aá]ch\s+giải|method|approach|solution|way)\s*(?:số\s*)?(\d{1,2}|[ivx]{1,4})\b/i;
const MIN_EQ_LEN = 5;

function normalizeEquation(s) {
  return String(s)
    .replace(/\\(?:left|right|,|;|!|quad|qquad|displaystyle|text)\b/g, '')
    .replace(/[\s{}$]/g, '')
    .replace(/[.,;:]+$/, '')
    .toLowerCase();
}

function extractEquations(text) {
  const out = [];
  const src = String(text || '');
  // Khối $$...$$ và \[...\] (có thể nhiều dòng), rồi $...$ và \(...\) trong dòng.
  const patterns = [/\$\$([\s\S]+?)\$\$/g, /\\\[([\s\S]+?)\\\]/g, /\\\(([\s\S]+?)\\\)/g, /(?<!\$)\$(?!\$)([^$\n]+?)\$(?!\$)/g];
  let rest = src;
  for (const re of patterns) {
    rest = rest.replace(re, (_, body) => { if (body.includes('=')) out.push(body); return ' '; });
  }
  // Dòng toán thuần văn bản (không LaTeX): có '=' và ký tự toán, không phải câu dài.
  for (const line of rest.split('\n')) {
    const t = line.trim().replace(/^[-*+>]\s+/, '');
    if (t.includes('=') && t.length <= 120 && /[0-9a-z)\]]\s*=\s*[-0-9a-z(\\]/i.test(t) && !/[.!?]\s+\p{L}{3,}\s+\p{L}{3,}/u.test(t) && (t.match(/\p{L}{4,}/gu) || []).length <= 2) out.push(t);
  }
  return out;
}

/**
 * @param {string} text câu trả lời cuối
 * @returns {{branchCount:number, repeatedEquationCount:number, equationCount:number, uniqueEquationCount:number}}
 */
function measureOutputRedundancy(text) {
  const t = String(text || '');
  const branches = new Set();
  let unnamed = 0;
  for (const line of t.split('\n')) {
    const m = BRANCH_RE.exec(line);
    if (m) branches.add(m[1].toLowerCase()); else if (/^\s*#{1,6}\s*(?:cách|method|approach)\b/i.test(line)) unnamed++;
  }
  const counts = new Map();
  let total = 0;
  for (const eq of extractEquations(t)) {
    const n = normalizeEquation(eq);
    if (n.length < MIN_EQ_LEN) continue;
    total++;
    counts.set(n, (counts.get(n) || 0) + 1);
  }
  let repeated = 0;
  for (const c of counts.values()) if (c > 1) repeated += c - 1;
  return { branchCount: branches.size + unnamed, repeatedEquationCount: repeated, equationCount: total, uniqueEquationCount: counts.size };
}

module.exports = { measureOutputRedundancy, extractEquations, normalizeEquation };
