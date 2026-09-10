'use strict';

// ============================================================================================
// LOSS-AWARE SEMANTIC CONTEXT COMPRESSION (PHẦN D / E / F)
// ============================================================================================
// MỤC TIÊU: giảm 10–20% INPUT token ở những request thực sự có ngữ cảnh dư thừa, mà KHÔNG mất
// thông tin ngữ nghĩa quan trọng và KHÔNG hề ảnh hưởng ngân sách OUTPUT (xem PHẦN E — output budget
// tính theo ĐỘ PHỨC TẠP BÀI, hoàn toàn độc lập với việc input được nén bao nhiêu).
//
// TRIẾT LÝ (rất khác với "cắt 10% text bất kỳ"):
//   Chỉ nén TOKEN LÃNG PHÍ — instruction/boilerplate lặp lại, label trang trí, prose đã hoàn thành,
//   history không còn liên quan, metadata trùng. TUYỆT ĐỐI KHÔNG đụng tới: đề bài gốc, yêu cầu người
//   dùng, ràng buộc, SỐ LIỆU, công thức, biến, đáp số, đơn vị, giả thiết, citation, drawing canonical
//   state, code, bước đang dở.
//
// KIẾN TRÚC TẦNG (PHẦN F) — mỗi item ngữ cảnh được gán đúng 1 tier, tier quyết định mức nén tối đa
// được phép áp lên nó:
//   TIER 0 — IMMUTABLE CORE  : đề bài gốc, yêu cầu, ràng buộc, chỉ thị an toàn. Chỉ normalize
//                              khoảng trắng (không đổi 1 ký tự nội dung nào).
//   TIER 1 — ACTIVE STATE    : biến, phương trình, kết quả trung gian, bước đang dở, drawing state,
//                              citation đang dùng. Normalize rất nhẹ, bảo toàn nguyên văn dữ liệu.
//   TIER 2 — RELEVANT HISTORY: trao đổi còn liên quan trực tiếp -> nén prose, GIỮ mọi dòng có dữ liệu.
//   TIER 3 — OLD HISTORY     : đã hoàn thành/không còn ảnh hưởng -> nén mạnh (chỉ giữ dòng dữ liệu).
//   TIER 4 — REDUNDANT META  : boilerplate/label/mô tả trùng lặp -> loại bỏ.
//
// QUALITY GATE (PHẦN D.4): sau khi nén, so sánh TẬP HỢP các "hạt ngữ nghĩa" (số, công thức LaTeX,
// phép gán biến, đơn vị, nhãn ý a/b/c, citation [n], id khối vẽ) trước/sau. Thiếu bất kỳ hạt nào ở
// tier được coi là phải-bảo-toàn => ROLLBACK đúng item đó về nguyên văn (không rollback toàn bộ, để
// phần nén an toàn vẫn có hiệu lực).
//
// KHÔNG NÉN 2 LẦN (PHẦN D.6): mỗi item nén xong được đóng dấu `compressedFrom` = fingerprint của
// nguyên văn; gặp lại item đã có dấu -> bỏ qua, không nén tiếp (tránh xói mòn tích luỹ qua nhiều
// lượt continuation trong cùng 1 request).

const { estimateTokens } = require('./adaptiveBudget');
const { fingerprint } = require('./tokenEconomy');

// ---------- Ngưỡng kích hoạt (PHẦN D.2) ----------
// Ngữ cảnh đã NGẮN thì không nén: rủi ro mất ngữ nghĩa không được bù lại bởi lợi ích token, và
// "nén" vài chục token chỉ làm phức tạp pipeline mà không tiết kiệm gì đáng kể.
const COMPRESSION_MIN_TOKENS = Number(process.env.COMPRESSION_MIN_TOKENS) || 1200;
// Mục tiêu nén THÍCH ỨNG theo độ dài (PHẦN D.3/D.5) — càng dư càng nén mạnh, nhưng đây là TARGET,
// không phải hạn mức bắt buộc: nén an toàn được bao nhiêu thì lấy bấy nhiêu.
const TARGET_RATIO_NORMAL = 0.10;
const TARGET_RATIO_HEAVY = 0.15;
const TARGET_RATIO_MAX = 0.20;
const HEAVY_CONTEXT_TOKENS = 4000;
const VERY_HEAVY_CONTEXT_TOKENS = 9000;

const TIER = Object.freeze({
  IMMUTABLE_CORE: 0, ACTIVE_STATE: 1, RELEVANT_HISTORY: 2, OLD_HISTORY: 3, REDUNDANT_META: 4
});

const IMPORTANCE = Object.freeze({
  CRITICAL: 'CRITICAL', HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW', REDUNDANT: 'REDUNDANT'
});

// ---------- Nhận diện "dòng có dữ liệu" — KHÔNG BAO GIỜ bị loại ----------
// Bất kỳ dòng khớp 1 trong các mẫu này đều được giữ NGUYÊN VĂN ở mọi tier (kể cả TIER 3): chứa số,
// công thức, phép gán biến, đơn vị, nhãn ý, citation, hoặc thuộc 1 khối code/vẽ.
const DATA_LINE_PATTERNS = [
  /\d/,                                   // bất kỳ chữ số nào (số liệu, đáp số, toạ độ, đơn vị đo)
  /[=<>≤≥≠±∈∩∪→⇒⇔]/,                      // quan hệ toán học/phép gán
  /\$/,                                   // LaTeX inline/khối
  /\\\(|\\\[|\\frac|\\sqrt|\\int|\\sum/,  // LaTeX dạng lệnh
  /```/,                                  // ranh giới khối code/vẽ
  /\[\d+\]/,                              // citation [n]
  /^\s*(#{1,6}\s|[-*+]\s|\d+[).]\s|[a-jA-J][).]\s)/, // heading/bullet/nhãn ý (cấu trúc đánh số)
  // ĐO THẬT (scripts/measure-tokens.js) phát hiện: dùng /\b(vậy|...)\b/ khớp NHẦM prose tiếng Việt
  // thông thường — "như vậy", "vì vậy", "vậy nên" xuất hiện dày đặc trong văn diễn giải, khiến GẦN
  // NHƯ MỌI dòng prose bị coi là dòng dữ liệu và compaction không tiết kiệm được gì (đo được 0%).
  // Các từ này chỉ mang nghĩa "dòng kết luận/đáp số" khi đứng ĐẦU DÒNG; còn "Vậy S = 6" thì đã có
  // chữ số + dấu "=" nên luôn được giữ bởi các mẫu phía trên rồi.
  /^\s*(vậy|kết luận|đáp số|đáp án|yêu cầu|điều kiện|giả thiết|constraint|assumption)\b/i,
  /(điều kiện|giả thiết|ràng buộc|constraint|assumption)\s*:/i,
  // Đơn vị đo PHẢI gắn với 1 con số mới mang dữ liệu. KHÔNG dùng danh sách đơn vị 1 ký tự "trần"
  // (m/g/A/N/V/W/J...) vì `\bm\b`-kiểu pattern khớp nhầm rất nhiều từ tiếng Việt bình thường, khiến
  // MỌI dòng prose bị coi là "dòng dữ liệu" và compression không bao giờ có hiệu lực (đúng lỗi đã
  // phát hiện khi đo thực tế: compressionRatio = 0%). Dòng có số đã được /\d/ ở trên bắt hết rồi.
  /\d\s*(cm|mm|km|kg|mol|°C|°|độ|giây|phút|giờ|m\/s|km\/h|N|J|W|V|A|Ω|Pa|%)\b/
];

function isDataLine(line) {
  return DATA_LINE_PATTERNS.some((re) => re.test(line));
}

// Chỉ những dòng PROSE THẬT SỰ DÀI mới là ứng viên bị loại. Dòng ngắn có thể là tiêu đề/chuyển ý —
// loại đi tiết kiệm rất ít token nhưng dễ làm đứt mạch đọc của model.
const PROSE_MIN_CHARS = Number(process.env.COMPRESSION_PROSE_MIN_CHARS) || 70;

const GREETING_RE = /^(chào|hi|hello|cảm ơn|thanks|thank you|ok(ay)?|dạ|vâng|ừ|uh|được|tốt)[\s!.,…]*$/i;

// ---------- Boilerplate/label trang trí (TIER 4) ----------
// Những dòng chỉ mang chức năng TRÌNH BÀY, không mang thông tin: đường kẻ ngang, "----", nhãn rỗng,
// dòng chỉ có dấu câu. Loại bỏ hoàn toàn an toàn.
const DECORATIVE_LINE_RE = /^\s*([-=*_~#]{3,}|[.·•]{2,})\s*$/;

/**
 * normalizeWhitespaceSafe(): LOSSLESS về ngữ nghĩa — chỉ bỏ khoảng trắng cuối dòng, gộp 3+ dòng
 * trống liên tiếp thành 2, và bỏ dòng trang trí. KHÔNG đổi bất kỳ ký tự nội dung nào, KHÔNG gộp
 * dòng, KHÔNG đụng vào bên trong khối code/vẽ (thụt lề trong JSON/code có ý nghĩa).
 * @param {string} text
 * @returns {string}
 */
function normalizeWhitespaceSafe(text) {
  if (!text) return text || '';
  const lines = String(text).split('\n');
  const out = [];
  let insideFence = false;
  let blankRun = 0;
  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      insideFence = !insideFence;
      out.push(raw.replace(/\s+$/, ''));
      blankRun = 0;
      continue;
    }
    if (insideFence) { out.push(raw); continue; } // trong khối code/vẽ: giữ nguyên 100%
    const trimmedRight = raw.replace(/\s+$/, '');
    if (!trimmedRight) {
      blankRun += 1;
      if (blankRun <= 1) out.push('');
      continue;
    }
    blankRun = 0;
    if (DECORATIVE_LINE_RE.test(trimmedRight)) continue;
    out.push(trimmedRight);
  }
  return out.join('\n').trim();
}

/**
 * dedupeRepeatedLines(): loại các DÒNG CHỈ THỊ/BOILERPLATE lặp lại y nguyên trong cùng 1 khối văn
 * bản (vd cùng 1 câu nhắc "không được bịa" xuất hiện ở 2 block prompt khác nhau) — giữ lần XUẤT
 * HIỆN ĐẦU TIÊN. CHỈ áp dụng cho dòng KHÔNG chứa dữ liệu (isDataLine=false) và đủ dài để chắc chắn
 * là 1 câu chỉ thị chứ không phải nhãn ngắn trùng nhau một cách hợp lệ.
 */
function dedupeRepeatedLines(text, { minChars = 40 } = {}) {
  if (!text) return text || '';
  const lines = String(text).split('\n');
  const seen = new Set();
  const out = [];
  let insideFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) { insideFence = !insideFence; out.push(line); continue; }
    if (insideFence) { out.push(line); continue; }
    const norm = line.trim().toLowerCase().replace(/\s+/g, ' ');
    if (norm.length >= minChars && !isDataLine(line)) {
      if (seen.has(norm)) continue; // câu chỉ thị đã xuất hiện — bỏ bản lặp
      seen.add(norm);
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * compressProsePreservingData(): loại các ĐOẠN PROSE ĐÃ HOÀN THÀNH không mang dữ liệu, giữ toàn bộ
 * dòng dữ liệu + cấu trúc đánh số. `aggressive` (TIER 3) hạ ngưỡng độ dài prose và bỏ luôn dòng
 * prose ngắn hơn; TIER 2 chỉ bỏ prose dài.
 *
 * QUAN TRỌNG: không bao giờ cắt GIỮA 1 dòng và không bao giờ đụng vào nội dung trong khối ```...```
 * (LaTeX/JSON/bảng/drawing state nằm nguyên vẹn).
 */
function compressProsePreservingData(text, { aggressive = false } = {}) {
  if (!text) return text || '';
  const minChars = aggressive ? 45 : PROSE_MIN_CHARS;
  const lines = String(text).split('\n');
  const out = [];
  let insideFence = false;
  let droppedRun = 0;
  for (const line of lines) {
    if (/^\s*```/.test(line)) { insideFence = !insideFence; out.push(line); droppedRun = 0; continue; }
    if (insideFence) { out.push(line); continue; }
    const t = line.trim();
    if (!t) { out.push(line); continue; }
    const droppable = !isDataLine(line) && t.length >= minChars;
    if (droppable) {
      droppedRun += 1;
      // Đánh dấu MỘT LẦN cho mỗi cụm prose bị bỏ: model cần biết "chỗ này đã trình bày rồi" để
      // không viết lại, nhưng không cần biết nguyên văn nó đã viết gì.
      if (droppedRun === 1) out.push('[…phần diễn giải đã hoàn thành ở trên…]');
      continue;
    }
    droppedRun = 0;
    out.push(line);
  }
  return out.join('\n');
}

// ============================================================================================
// QUALITY GATE (PHẦN D.4)
// ============================================================================================
// Trích các "hạt ngữ nghĩa" PHẢI được bảo toàn. Dùng tập hợp (Set) chứ không so chuỗi — nén hợp lệ
// được phép đổi thứ tự/khoảng trắng, nhưng KHÔNG được làm mất 1 con số/công thức/biến/nhãn nào.

const NUMBER_RE = /-?\d+(?:[.,]\d+)?/g;
const LATEX_RE = /\$[^$\n]{1,200}\$|\\\[[\s\S]{1,400}?\\\]|\\\([\s\S]{1,200}?\\\)/g;
const ASSIGN_RE = /\b([A-Za-z][A-Za-z0-9_]{0,3})\s*=\s*(-?\d+(?:[.,]\d+)?|[A-Za-z0-9^{}\\/+*().-]{1,20})/g;
const CITATION_RE = /\[\d{1,3}\]/g;
const DRAWING_ID_RE = /"id"\s*:\s*"([^"]{1,40})"/g;
const COVERAGE_LABEL_RE = /(^|\n)\s*(?:ý\s*)?([a-jA-J]|\d{1,2})\s*[).:]/g;
const UNIT_RE = /\b\d+(?:[.,]\d+)?\s*(cm|mm|km|kg|mol|°C|°|độ|giây|phút|giờ|m\/s|km\/h|N|J|W|V|A|Ω|Pa|%)\b/g;
const UNFINISHED_RE = /(Bước\s*\d+\s*[:.]?\s*$)/gim;

function collectMatches(text, re) {
  const set = new Set();
  const s = String(text || '');
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(s))) {
    set.add((m[0] || '').trim().toLowerCase().replace(/\s+/g, ' '));
    if (set.size > 4000) break; // chặn pathological input
    if (m.index === re.lastIndex) re.lastIndex += 1; // chống vòng lặp vô hạn với match rỗng
  }
  return set;
}

/**
 * semanticGrains(): "dấu vân tay ngữ nghĩa" của 1 đoạn ngữ cảnh — mọi thứ mà compression KHÔNG được
 * phép làm mất theo PHẦN D ("KHÔNG được nén/cắt: số liệu, công thức, biến, đáp số, điều kiện, units,
 * citation facts, drawing canonical state, unfinished step...").
 */
function semanticGrains(text) {
  return {
    numbers: collectMatches(text, NUMBER_RE),
    latex: collectMatches(text, LATEX_RE),
    assignments: collectMatches(text, ASSIGN_RE),
    citations: collectMatches(text, CITATION_RE),
    drawingIds: collectMatches(text, DRAWING_ID_RE),
    labels: collectMatches(text, COVERAGE_LABEL_RE),
    units: collectMatches(text, UNIT_RE),
    unfinished: collectMatches(text, UNFINISHED_RE)
  };
}

function missingGrains(before, after) {
  const missing = {};
  Object.keys(before).forEach((k) => {
    const lost = [];
    before[k].forEach((g) => { if (!after[k].has(g)) lost.push(g); });
    if (lost.length) missing[k] = lost;
  });
  return missing;
}

/**
 * qualityGate(): true nếu bản nén BẢO TOÀN mọi hạt ngữ nghĩa cần thiết.
 * @param {string} original
 * @param {string} compressed
 * @returns {{ok:boolean, missing:object}}
 */
function qualityGate(original, compressed) {
  const missing = missingGrains(semanticGrains(original), semanticGrains(compressed));
  return { ok: Object.keys(missing).length === 0, missing };
}

// ============================================================================================
// IMPORTANCE SCORING (PHẦN D.1)
// ============================================================================================
/**
 * scoreImportance(): xếp 1 item ngữ cảnh vào 5 mức. `isCore` (đề bài/yêu cầu/an toàn) luôn CRITICAL.
 * @param {{text:string, role?:string, isCore?:boolean, ageIndex?:number, totalItems?:number}} item
 * @param {{problemKeywords?:Set<string>, seenFingerprints?:Set<string>}} [ctx]
 * @returns {string} một trong IMPORTANCE
 */
function scoreImportance(item, ctx = {}) {
  const text = String((item && item.text) || '');
  const trimmed = text.trim();
  if (item && item.isCore) return IMPORTANCE.CRITICAL;
  if (!trimmed) return IMPORTANCE.REDUNDANT;

  // Trùng lặp với item đã thấy -> REDUNDANT (đây chính là "duplicate context/repeated passages").
  if (ctx.seenFingerprints) {
    const fp = fingerprint(trimmed);
    if (ctx.seenFingerprints.has(fp)) return IMPORTANCE.REDUNDANT;
    ctx.seenFingerprints.add(fp);
  }

  if (GREETING_RE.test(trimmed) || trimmed.length < 8) return IMPORTANCE.REDUNDANT;

  // Có drawing state / code / công thức LaTeX / phép gán biến -> ACTIVE STATE, phải bảo toàn.
  if (/```(shape|solid3d|plot)/.test(text)) return IMPORTANCE.CRITICAL;
  if (/\$[^$\n]+\$/.test(text) || ASSIGN_RE.test(text)) {
    ASSIGN_RE.lastIndex = 0;
    return IMPORTANCE.HIGH;
  }
  ASSIGN_RE.lastIndex = 0;

  // Liên quan tới đề bài hiện tại -> giữ ưu tiên cao hơn history vô thưởng vô phạt.
  if (ctx.problemKeywords && ctx.problemKeywords.size) {
    const words = new Set(
      trimmed.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length >= 4)
    );
    let hit = 0;
    words.forEach((w) => { if (ctx.problemKeywords.has(w)) hit += 1; });
    const overlap = words.size ? hit / words.size : 0;
    if (overlap >= 0.18) return IMPORTANCE.HIGH;
    if (overlap >= 0.06) return IMPORTANCE.MEDIUM;
    return IMPORTANCE.LOW;
  }
  return IMPORTANCE.MEDIUM;
}

function keywordsOf(str) {
  return new Set(
    String(str || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length >= 4)
  );
}

// ============================================================================================
// ĐỘNG CƠ NÉN CHÍNH
// ============================================================================================
/**
 * targetRatioFor(): mục tiêu nén thích ứng theo tổng tải input (PHẦN D.3/D.5).
 * @param {number} totalTokens
 * @returns {number} 0 nếu không nên nén.
 */
function targetRatioFor(totalTokens) {
  if (!Number.isFinite(totalTokens) || totalTokens < COMPRESSION_MIN_TOKENS) return 0;
  if (totalTokens >= VERY_HEAVY_CONTEXT_TOKENS) return TARGET_RATIO_MAX;
  if (totalTokens >= HEAVY_CONTEXT_TOKENS) return TARGET_RATIO_HEAVY;
  return TARGET_RATIO_NORMAL;
}

/** Mức nén tối đa CHO PHÉP theo tier — tier càng thấp càng được bảo vệ (PHẦN F). */
function compressItemByTier(text, tier, { aggressive = false } = {}) {
  switch (tier) {
    case TIER.IMMUTABLE_CORE:
      return normalizeWhitespaceSafe(text); // lossless
    case TIER.ACTIVE_STATE:
      return normalizeWhitespaceSafe(text); // lossless — dữ liệu đang hoạt động, không bỏ dòng nào
    case TIER.RELEVANT_HISTORY:
      return compressProsePreservingData(dedupeRepeatedLines(normalizeWhitespaceSafe(text)), { aggressive: false });
    case TIER.OLD_HISTORY:
      return compressProsePreservingData(dedupeRepeatedLines(normalizeWhitespaceSafe(text)), { aggressive: true });
    case TIER.REDUNDANT_META:
      return ''; // loại bỏ hoàn toàn
    default:
      return normalizeWhitespaceSafe(text);
  }
}

/**
 * semanticCompressContext() — API chính (PHẦN D).
 *
 * @param {{items:Array<{id?:string, text:string, tier:number, role?:string, isCore?:boolean,
 *   compressedFrom?:string}>, problemText?:string, force?:boolean, totalInputTokens?:number}} input
 *   items: danh sách item ngữ cảnh ĐÃ được caller gán tier (xem assignTiers()/chat.js).
 *   totalInputTokens: TỔNG tải input của CẢ request (system prompt + contexts + đề bài + history) —
 *     quyết định CÓ NÊN nén hay không (PHẦN D.2) được lấy theo tổng này, không phải theo riêng phần
 *     `items` nén được. Lý do: 1 request có system prompt + nguồn rất nặng nhưng history ngắn vẫn là
 *     request "dư thừa ngữ cảnh" đáng nén; ngược lại nếu tổng đã nhẹ thì không nén dù history dài.
 *     Không truyền -> lấy tổng token của chính `items` (hành vi độc lập, dùng cho test).
 *   force: bỏ qua ngưỡng COMPRESSION_MIN_TOKENS (chỉ dùng cho test/nội bộ).
 * @returns {{items:Array, stats:{rawTokens:number, compressedTokens:number, compressionRatio:number,
 *   targetRatio:number, applied:boolean, rolledBack:Array, skippedAlreadyCompressed:number,
 *   droppedItems:number, byTier:object}}}
 */
function semanticCompressContext({ items, problemText = '', force = false, totalInputTokens } = {}) {
  const list = Array.isArray(items) ? items : [];
  const rawTokens = list.reduce((s, it) => s + estimateTokens(it.text), 0);
  const weighTokens = Number.isFinite(totalInputTokens) ? totalInputTokens : rawTokens;
  const targetRatio = force ? TARGET_RATIO_NORMAL : targetRatioFor(weighTokens);

  const stats = {
    rawTokens,
    totalInputTokens: weighTokens,
    compressedTokens: rawTokens,
    compressionRatio: 0,
    totalCompressionRatio: 0,
    targetRatio,
    targetSavingTokens: 0,
    achievedSavingTokens: 0,
    applied: false,
    rolledBack: [],
    skippedAlreadyCompressed: 0,
    droppedItems: 0,
    lossyItems: 0,
    byTier: {}
  };

  // PHẦN D.2: ngữ cảnh đã ngắn -> KHÔNG nén vô lý (không phải "cắt cho đủ 10%").
  if (!targetRatio) return { items: list, stats };

  const problemKeywords = keywordsOf(problemText);
  const seenFingerprints = new Set();

  // ---------- Bước 1: chấm điểm + gán tier hiệu lực, chưa nén gì ----------
  const prepared = [];
  for (const item of list) {
    const original = String(item.text || '');
    // PHẦN D.6: đã nén rồi -> không nén lại (chống xói mòn tích luỹ qua nhiều lượt continuation).
    if (item.compressedFrom) {
      stats.skippedAlreadyCompressed += 1;
      prepared.push({ item, original, locked: true });
      continue;
    }

    const importance = scoreImportance({ ...item, text: original }, { problemKeywords, seenFingerprints });

    // Importance nâng/hạ mức bảo vệ: tier là VỊ TRÍ trong hội thoại, importance là GIÁ TRỊ nội dung
    // — lấy mức bảo vệ CAO HƠN của cả hai, nên 1 lượt rất cũ nhưng chứa drawing state vẫn được đối
    // xử như ACTIVE STATE (không bao giờ nén mạnh hơn mức mà 1 trong 2 tín hiệu cho phép).
    let effectiveTier = item.tier;
    if (importance === IMPORTANCE.CRITICAL) effectiveTier = Math.min(effectiveTier, TIER.ACTIVE_STATE);
    else if (importance === IMPORTANCE.HIGH) effectiveTier = Math.min(effectiveTier, TIER.RELEVANT_HISTORY);
    else if (importance === IMPORTANCE.LOW && item.tier >= TIER.RELEVANT_HISTORY) {
      effectiveTier = Math.max(effectiveTier, TIER.OLD_HISTORY);
    }

    prepared.push({ item, original, importance, effectiveTier, locked: false });
  }

  // ---------- Bước 2: pass LOSSLESS cho MỌI item (luôn an toàn, luôn áp dụng) ----------
  // Khoảng trắng cuối dòng, dòng trống thừa, dòng trang trí: 100% là token lãng phí, không phải
  // thông tin. Không cần quality gate vì không ký tự nội dung nào bị đổi.
  for (const p of prepared) {
    if (p.locked) { p.text = p.original; continue; }
    p.text = normalizeWhitespaceSafe(p.original);
  }

  const losslessTokens = prepared.reduce((s, p) => s + estimateTokens(p.text), 0);
  // Mục tiêu tiết kiệm tính trên TỔNG input của request (PHẦN D.3) — trần là targetRatio, KHÔNG
  // vượt (PHẦN T: "Nếu 20% gây mất chất lượng => adaptive xuống 15% hoặc 10%" — nén quá mức mục tiêu
  // là rủi ro chất lượng không được yêu cầu, nên dừng đúng lúc đạt mục tiêu).
  stats.targetSavingTokens = Math.round(weighTokens * targetRatio);
  let saved = rawTokens - losslessTokens;

  // ---------- Bước 3: pass LOSSY theo thứ tự GIÁ TRỊ THẤP NHẤT TRƯỚC, dừng khi đạt mục tiêu ----------
  // Đây chính là "loss-aware": chỉ tiêu tới đâu cần tới đó, và luôn tiêu vào phần rẻ nhất trước.
  // TIER 0 (đề bài/yêu cầu/an toàn) và TIER 1 (active state) KHÔNG BAO GIỜ vào pass này.
  const lossyOrder = prepared
    .filter((p) => !p.locked && p.effectiveTier >= TIER.RELEVANT_HISTORY)
    .map((p, idx) => ({ p, idx }))
    .sort((a, b) => (b.p.effectiveTier - a.p.effectiveTier) || (a.idx - b.idx));

  for (const { p } of lossyOrder) {
    if (saved >= stats.targetSavingTokens) break; // ĐÃ ĐỦ mục tiêu — không nén thêm, giữ nguyên phần còn lại
    if (p.effectiveTier === TIER.REDUNDANT_META) {
      saved += estimateTokens(p.text);
      p.text = '';
      p.dropped = true;
      continue;
    }
    if (p.importance === IMPORTANCE.REDUNDANT) {
      saved += estimateTokens(p.text);
      p.text = '';
      p.dropped = true;
      continue;
    }
    const before = estimateTokens(p.text);
    const candidate = compressItemByTier(p.text, p.effectiveTier);
    // ---------- QUALITY GATE + ROLLBACK (PHẦN D.4) ----------
    const gate = qualityGate(p.text, candidate);
    if (!gate.ok) {
      stats.rolledBack.push({ id: p.item.id || null, tier: p.effectiveTier, missing: Object.keys(gate.missing) });
      continue; // giữ nguyên bản lossless — KHÔNG giữ bản nén đã làm mất dữ liệu
    }
    p.text = candidate;
    p.lossy = true;
    stats.lossyItems += 1;
    saved += before - estimateTokens(candidate);
  }

  // ---------- Bước 4: xuất kết quả ----------
  const out = [];
  for (const p of prepared) {
    if (p.locked) { out.push(p.item); continue; }
    if (!String(p.text).trim()) { stats.droppedItems += 1; continue; }
    const tierKey = `tier${p.effectiveTier}`;
    stats.byTier[tierKey] = stats.byTier[tierKey] || { rawTokens: 0, compressedTokens: 0, items: 0 };
    stats.byTier[tierKey].rawTokens += estimateTokens(p.original);
    stats.byTier[tierKey].compressedTokens += estimateTokens(p.text);
    stats.byTier[tierKey].items += 1;
    out.push({
      ...p.item,
      text: p.text,
      importance: p.importance,
      effectiveTier: p.effectiveTier,
      compressedFrom: fingerprint(p.original)
    });
  }

  stats.compressedTokens = out.reduce((s, it) => s + estimateTokens(it.text), 0);
  stats.achievedSavingTokens = Math.max(0, rawTokens - stats.compressedTokens);
  // compressionRatio = mức nén TRÊN PHẦN NÉN ĐƯỢC (items truyền vào).
  stats.compressionRatio = rawTokens > 0 ? 1 - stats.compressedTokens / rawTokens : 0;
  // totalCompressionRatio = mức nén TRÊN TỔNG INPUT của request — đây là con số mà PHẦN D/Q/T nói
  // tới khi đặt mục tiêu 10–20% (xem telemetry compressionRatio ở chat.js).
  stats.totalCompressionRatio = weighTokens > 0 ? stats.achievedSavingTokens / weighTokens : 0;
  stats.applied = stats.achievedSavingTokens > 0;
  return { items: out, stats };
}

/**
 * assignTiers(): gán tier cho lịch sử hội thoại theo VỊ TRÍ (PHẦN F) — 2 lượt gần nhất là ACTIVE
 * STATE (mạch hội thoại đang diễn ra), phần giữa là RELEVANT_HISTORY, phần cũ nhất là OLD_HISTORY.
 * @param {Array<{role:string, content:string}>} history
 * @returns {Array<{id:string, text:string, tier:number, role:string}>}
 */
function assignTiers(history) {
  const list = Array.isArray(history) ? history : [];
  const n = list.length;
  return list.map((h, i) => {
    const fromEnd = n - 1 - i;
    let tier;
    if (fromEnd < 2) tier = TIER.ACTIVE_STATE;
    else if (fromEnd < 6) tier = TIER.RELEVANT_HISTORY;
    else tier = TIER.OLD_HISTORY;
    return { id: `h${i}`, text: h.content, tier, role: h.role };
  });
}

/**
 * compressSourceExcerpts() — Vấn đề #2: nâng mức nén cho request có NHIỀU ĐOẠN TRÍCH NGUỒN.
 *
 * Vì sao cần riêng hàm này: đo thật (scripts/measure-tokens.js) cho thấy scenario STANDARD chỉ đạt
 * 7.9% dù mục tiêu 15% — lý do là history ở đó chỉ chiếm ~13% tổng input, phần còn lại là system
 * prompt (chỉ thị an toàn/định dạng — KHÔNG được nén sâu) và ĐOẠN TRÍCH NGUỒN. Nguồn là chỗ duy nhất
 * còn dư thật: các excerpt được client cắt ra từ CÙNG 1 tài liệu thường mang theo header/footer trang
 * LẶP LẠI y nguyên ở mọi đoạn ("Chương 3 — Hình học phẳng", "Trang 42/150", tên sách...). Những dòng
 * đó là metadata trình bày, không phải nội dung học thuật.
 *
 * NGUYÊN TẮC AN TOÀN (khác hẳn nén history):
 *   - KHÔNG BAO GIỜ loại bỏ 1 excerpt (dù trùng lặp) — việc gộp nguồn là việc của citationIndex.js,
 *     nơi có xử lý citeNo/alias. Ở đây chỉ nén NỘI DUNG BÊN TRONG từng excerpt.
 *   - Chỉ loại dòng xuất hiện y nguyên ở >= 2 excerpt VÀ không chứa dữ liệu (isDataLine=false) VÀ
 *     ngắn (<= 80 ký tự — header/footer thật, không phải 1 câu định lý dài).
 *   - Excerpt bị đánh dấu `truncated` (đã bị cắt ở validators) được nén NHẸ HƠN: nó vốn đã thiếu,
 *     không nên bớt thêm.
 *   - Mọi excerpt đều qua quality gate; fail -> rollback về lossless.
 *
 * @param {Array<{text:string, doc?:string, truncated?:boolean, citeNo?:number}>} contexts
 * @returns {{contexts:Array, rawTokens:number, compressedTokens:number, droppedBoilerplateLines:number,
 *   rolledBack:number}}
 */
function compressSourceExcerpts(contexts) {
  const list = Array.isArray(contexts) ? contexts : [];
  const rawTokens = list.reduce((n, c) => n + estimateTokens(c.text), 0);
  if (list.length < 2) {
    // 1 excerpt duy nhất: không có gì để so "lặp giữa các đoạn", chỉ normalize lossless.
    const out = list.map((c) => ({ ...c, text: normalizeWhitespaceSafe(c.text) }));
    return {
      contexts: out, rawTokens,
      compressedTokens: out.reduce((n, c) => n + estimateTokens(c.text), 0),
      droppedBoilerplateLines: 0, rolledBack: 0
    };
  }

  // Đếm số excerpt mà mỗi dòng xuất hiện trong đó (theo tài liệu — header của sách A không nên ảnh
  // hưởng tới excerpt của sách B).
  const seenIn = new Map(); // `${doc} ${normLine}` -> số excerpt chứa nó
  list.forEach((c) => {
    const doc = c.doc || '';
    const uniqueLines = new Set(
      String(c.text || '').split('\n').map((l) => l.trim()).filter(Boolean)
    );
    uniqueLines.forEach((l) => {
      const k = doc + '\u0000' + l.toLowerCase().replace(/\s+/g, ' ');
      seenIn.set(k, (seenIn.get(k) || 0) + 1);
    });
  });

  let droppedBoilerplateLines = 0;
  let rolledBack = 0;

  const out = list.map((c) => {
    const original = String(c.text || '');
    const lossless = normalizeWhitespaceSafe(original);
    if (c.truncated) return { ...c, text: lossless }; // excerpt vốn đã bị cắt -> chỉ lossless

    const doc = c.doc || '';
    let dropped = 0;
    const kept = [];
    let insideFence = false;
    for (const line of lossless.split('\n')) {
      if (/^\s*```/.test(line)) { insideFence = !insideFence; kept.push(line); continue; }
      if (insideFence) { kept.push(line); continue; }
      const t = line.trim();
      if (!t) { kept.push(line); continue; }
      const k = doc + '\u0000' + t.toLowerCase().replace(/\s+/g, ' ');
      const repeats = seenIn.get(k) || 0;
      const isBoilerplate = repeats >= 2 && t.length <= 80 && !isDataLine(line);
      if (isBoilerplate) { dropped += 1; continue; }
      kept.push(line);
    }

    const candidate = kept.join('\n').trim();
    const gate = qualityGate(original, candidate);
    if (!gate.ok || !candidate) { rolledBack += 1; return { ...c, text: lossless }; }
    droppedBoilerplateLines += dropped;
    return { ...c, text: candidate };
  });

  return {
    contexts: out, rawTokens,
    compressedTokens: out.reduce((n, c) => n + estimateTokens(c.text), 0),
    droppedBoilerplateLines, rolledBack
  };
}

/**
 * compressSystemPrompt(): TIER 4 cho system prompt — chỉ loại boilerplate/dòng chỉ thị LẶP LẠI y
 * nguyên và khoảng trắng dư. Nội dung chỉ thị xuất hiện LẦN ĐẦU không bao giờ bị bỏ (đó là
 * "model/provider instructions thực sự cần thiết" mà PHẦN D cấm nén), và luôn qua quality gate.
 * @param {string} systemPrompt
 * @returns {{text:string, rawTokens:number, compressedTokens:number, rolledBack:boolean}}
 */
function compressSystemPrompt(systemPrompt) {
  const original = String(systemPrompt || '');
  const rawTokens = estimateTokens(original);
  if (!original) return { text: original, rawTokens: 0, compressedTokens: 0, rolledBack: false };
  const candidate = dedupeRepeatedLines(normalizeWhitespaceSafe(original), { minChars: 40 });
  const gate = qualityGate(original, candidate);
  const text = gate.ok ? candidate : normalizeWhitespaceSafe(original);
  return { text, rawTokens, compressedTokens: estimateTokens(text), rolledBack: !gate.ok };
}

module.exports = {
  TIER, IMPORTANCE,
  COMPRESSION_MIN_TOKENS, TARGET_RATIO_NORMAL, TARGET_RATIO_HEAVY, TARGET_RATIO_MAX,
  normalizeWhitespaceSafe, dedupeRepeatedLines, compressProsePreservingData,
  semanticGrains, qualityGate, missingGrains, isDataLine,
  scoreImportance, targetRatioFor, semanticCompressContext, assignTiers, compressSystemPrompt,
  compressSourceExcerpts
};
