'use strict';

// ============================================================================================
// STABLE CITATION INDEX — điều kiện tiên quyết để BẬT được context dedupe (Vấn đề #1)
// ============================================================================================
// TẠI SAO `tePlan.dedupedContexts` là dead code trong mọi bản trước:
//   Số citation `[n]` KHÔNG phải là 1 danh tính, nó là VỊ TRÍ TRONG MẢNG, được sinh ở 3 nơi độc lập:
//     - promptBuilder.js  : `contexts.map((c, i) => \`[${i + 1}] ...\`)`
//     - citationValidator : coi hợp lệ khi `1 <= n <= contexts.length`
//     - public/js/app.js  : `getUsedContexts()` map `[n]` về `contexts[n - 1]` của MẢNG PHÍA CLIENT
//   Nên chỉ cần server bỏ 1 context trùng là MỌI số sau nó bị dịch: prompt nói [5] là đoạn X, client
//   lại hiển thị [5] là đoạn Y, và validator có thể coi [7] hợp lệ trong khi prompt chỉ còn 6 đoạn.
//   Đó là lý do dedupe bị để lại dạng "đã tính nhưng không dùng" thay vì bật lên.
//
// CÁCH SỬA: tách DANH TÍNH khỏi VỊ TRÍ. Mỗi context nhận đúng 1 `citeNo` ỔN ĐỊNH, gán MỘT LẦN cho
// cả request. Bản trùng bị gộp vào bản giữ lại, và citeNo của bản bị gộp được lưu làm ALIAS — nếu
// model có tình cờ trích số cũ, nó vẫn resolve đúng về đoạn đã gộp thay vì thành "citation bịa".
//
// Nhờ đó cả 3 nơi trên dùng CÙNG một nguồn sự thật:
//   - prompt in ra `c.citeNo` (không phải i+1)
//   - validator kiểm tra theo TẬP citeNo hợp lệ (không phải khoảng 1..length)
//   - client dùng `citationMap` do server trả về (không tự suy ra từ mảng của mình)

const { fingerprint, jaccardSimilarity } = require('./tokenEconomy');

// Ngưỡng gộp đoạn "gần trùng". Mặc định 0.9 — CAO hơn ngưỡng dedupe chung (0.85) một cách có chủ ý:
// gộp nguồn là thao tác KHÔNG hoàn tác được về mặt trích dẫn (gộp sai = câu trả lời dẫn nguồn sai),
// nên ở đây ta thà bỏ sót vài đoạn trùng (chỉ tốn thêm token) hơn là gộp nhầm 2 đoạn khác nội dung.
// Cấu hình được qua .env cho ai muốn đánh đổi khác: CITATION_NEAR_DUP_THRESHOLD=0.95 (thận trọng hơn)
// hoặc 0.85 (tiết kiệm token hơn). Luôn bị kẹp trong [0.75, 1] để không thể vô tình gộp bừa.
const NEAR_DUP_THRESHOLD = Math.min(1, Math.max(0.75,
  Number(process.env.CITATION_NEAR_DUP_THRESHOLD) || 0.9
));

/**
 * Điểm "chất lượng bằng chứng" — khi 2 đoạn trùng nhau, giữ bản có metadata tốt hơn.
 */
function evidenceScore(c) {
  return (c.doc ? 2 : 0) + (c.id != null ? 1 : 0) + (c.truncated ? -1 : 0) + Math.min(1, String(c.text || '').length / 2000);
}

/**
 * buildCitationIndex() — gán citeNo ổn định + gộp đoạn trùng/gần trùng.
 *
 * @param {Array<{doc?:string, id?:number, text:string, truncated?:boolean}>} contexts Mảng gốc từ
 *   client (validateChatBody đã làm sạch).
 * @returns {{
 *   effectiveContexts: Array,   // mảng gửi cho model, mỗi phần tử có .citeNo
 *   citationMap: Array<{citeNo:number, originalIndexes:number[], doc:string, id:number}>,
 *   validCiteNos: number[],     // tập số citation model được phép dùng
 *   aliasOf: object,            // citeNo bị gộp -> citeNo còn lại (để resolve số cũ)
 *   duplicatesMerged: number
 * }}
 */
function buildCitationIndex(contexts) {
  const list = Array.isArray(contexts) ? contexts : [];
  if (!list.length) {
    return { effectiveContexts: [], citationMap: [], validCiteNos: [], aliasOf: {}, duplicatesMerged: 0 };
  }

  // citeNo được gán theo THỨ TỰ GỐC (1-based) và KHÔNG BAO GIỜ đổi sau đó — kể cả khi phần tử phía
  // trước bị gộp đi. Vì vậy tập citeNo có thể KHÔNG liên tục (vd [1],[2],[4]) — điều đó hoàn toàn ổn
  // và chính là thứ cho phép dedupe an toàn; validator/client đọc theo TẬP, không theo khoảng.
  const withNo = list.map((c, i) => ({ ...c, citeNo: i + 1, _origIndex: i }));

  const kept = [];
  const aliasOf = {};
  let duplicatesMerged = 0;

  for (const item of withNo) {
    const fp = fingerprint(item.text);
    let dupIdx = kept.findIndex((k) => k._fp === fp);
    if (dupIdx === -1) {
      dupIdx = kept.findIndex((k) => jaccardSimilarity(k.text, item.text) >= NEAR_DUP_THRESHOLD);
    }

    if (dupIdx === -1) {
      kept.push({ ...item, _fp: fp, originalIndexes: [item._origIndex] });
      continue;
    }

    duplicatesMerged += 1;
    const winner = kept[dupIdx];
    // Gộp: giữ citeNo NHỎ HƠN làm số chính thức (số xuất hiện trước trong tài liệu người dùng), và
    // ghi số còn lại thành alias.
    const loserNo = Math.max(winner.citeNo, item.citeNo);
    const keepNo = Math.min(winner.citeNo, item.citeNo);
    aliasOf[loserNo] = keepNo;

    // Nếu bản mới có bằng chứng tốt hơn, dùng NỘI DUNG của nó nhưng vẫn giữ citeNo nhỏ.
    const better = evidenceScore(item) > evidenceScore(winner) ? item : winner;
    kept[dupIdx] = {
      ...better,
      citeNo: keepNo,
      _fp: winner._fp,
      originalIndexes: [...new Set([...(winner.originalIndexes || []), item._origIndex])].sort((a, b) => a - b)
    };
  }

  const effectiveContexts = kept.map((k) => {
    const out = { ...k };
    delete out._fp;
    delete out._origIndex;
    return out;
  });

  return {
    effectiveContexts,
    citationMap: effectiveContexts.map((c) => ({
      citeNo: c.citeNo,
      originalIndexes: c.originalIndexes || [],
      doc: c.doc || '',
      id: c.id != null ? c.id : 1
    })),
    validCiteNos: effectiveContexts.map((c) => c.citeNo),
    aliasOf,
    duplicatesMerged
  };
}

/**
 * resolveCiteNo() — chuẩn hoá 1 số citation model sinh ra về citeNo chính thức (theo alias nếu có).
 * @returns {number|null} null nếu số đó không tương ứng nguồn nào.
 */
function resolveCiteNo(n, { validCiteNos = [], aliasOf = {} } = {}) {
  const num = Number(n);
  if (!Number.isFinite(num)) return null;
  if (validCiteNos.includes(num)) return num;
  const aliased = aliasOf[num];
  if (aliased != null && validCiteNos.includes(aliased)) return aliased;
  return null;
}

module.exports = { buildCitationIndex, resolveCiteNo, NEAR_DUP_THRESHOLD };
