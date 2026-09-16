'use strict';

/* ============================================================================================
 * server/utils/sourceProvenance.js — PHẦN C/F/N
 * ============================================================================================
 * Ba việc, và CHỈ ba việc (deterministic, không heuristic LLM):
 *
 *  1. CHẶN PLACEHOLDER (PHẦN C / TEST 13). Client đã gắn cờ placeholder cho mọi chunk báo trạng thái
 *     ("⏳ Đang đọc…", "⚠️ Không đọc được…"), nhưng server KHÔNG được tin mỗi cờ đó: 1 client cũ
 *     (tab chưa reload) vẫn có thể gửi đúng chuỗi ấy như nội dung nguồn thật. Nên ở đây có thêm 1
 *     lớp nhận diện theo NỘI DUNG. Placeholder lọt vào prompt là lý do trực tiếp khiến model trả
 *     lời "không nhận được nội dung trích dẫn" dù người dùng đã tải nguồn.
 *
 *  2. CHẶN EVIDENCE CỦA NGUỒN CHƯA READY (PHẦN B/N). Nguồn đang EXTRACTING/INCOMPLETE chỉ đọc được
 *     một phần — dùng nó như nguồn hoàn chỉnh sẽ cho ra câu "tài liệu không có phần này" SAI.
 *
 *  3. TÓM TẮT ĐỘ SẴN SÀNG để prompt/telemetry dùng chung một nguồn sự thật.
 */

const PLACEHOLDER_PATTERNS = [
  /^\s*⏳/,
  /^\s*⚠️/,
  /đang đọc/i,
  /đang xử lý/i,
  /không đọc được nội dung file/i,
  /chưa render được trang nào/i
];

/** @returns {boolean} true nếu đoạn này là THÔNG BÁO TRẠNG THÁI, không phải nội dung nguồn. */
function isPlaceholderContext(c) {
  if (!c) return true;
  if (c.extractionStatus && c.extractionStatus !== 'ok') return true;
  if (c.placeholder === true) return true;
  const text = String(c.text || '').trim();
  if (!text) return true;
  // Chỉ coi là placeholder khi đoạn NGẮN và khớp mẫu — 1 trang tài liệu thật có thể tình cờ chứa
  // chữ "đang xử lý" ở giữa nội dung, không được loại oan cả trang.
  if (text.length > 400) return false;
  return PLACEHOLDER_PATTERNS.some((re) => re.test(text));
}

/** Chuẩn hoá danh sách trạng thái nguồn thành Map theo sourceId (dạng chuỗi). */
function indexSourceStatus(sourceStatus) {
  const map = new Map();
  (Array.isArray(sourceStatus) ? sourceStatus : []).forEach((s) => {
    if (s && s.sourceId) map.set(String(s.sourceId), s);
    if (s && s.name) map.set(`name:${s.name}`, s);
  });
  return map;
}

/** Nguồn có usable evidence để dùng NGAY hay không — PHẦN VII/VIII (progressive ingestion): khác
 * hẳn "đã READY" (100% verified). Ưu tiên field mới `usableNow` do client gửi (PHẦN N); client cũ
 * (trước bản nâng cấp) không có field này -> fallback về status === 'READY' để KHÔNG đột ngột đổi
 * hành vi cho client chưa nâng cấp (không có cách nào khác để biết nguồn có evidence hay chưa). */
function isSourceUsableFromStatus(st) {
  if (!st) return true; // không có thông tin trạng thái -> giữ hành vi cũ, không loại oan
  if (typeof st.usableNow === 'boolean') return st.usableNow;
  return st.status === 'READY';
}

/**
 * Lọc contexts trước khi chúng chạm tới citation index/prompt.
 * @returns {{usable:Array, dropped:Array<{reason:string, doc:string, id:*}>}}
 */
function filterUsableContexts(contexts, sourceStatus) {
  const statusMap = indexSourceStatus(sourceStatus);
  const usable = [];
  const dropped = [];
  (Array.isArray(contexts) ? contexts : []).forEach((c) => {
    if (isPlaceholderContext(c)) {
      dropped.push({ reason: 'placeholder', doc: (c && c.doc) || '', id: c && c.id });
      return;
    }
    const st = statusMap.get(String(c.sourceId)) || statusMap.get(`name:${c.doc}`);
    // PHẦN VIII (ROOT CAUSE — audit mục II.C song sinh phía server): TRƯỚC ĐÂY yêu cầu status ===
    // 'READY' để giữ context, nghĩa là evidence THẬT của 1 nguồn đang xử lý nền (vd 72/134 trang đã
    // đọc) bị vứt bỏ TOÀN BỘ ở đây dù client đã gửi lên đúng đắn — hai tầng gating (client cũ +
    // server cũ) cộng lại khiến "instant availability" ở client vô nghĩa vì server luôn lọc sạch.
    // NAY: chỉ loại khi nguồn THỰC SỰ không có evidence nào usable (isSourceUsableFromStatus false).
    if (!isSourceUsableFromStatus(st)) {
      dropped.push({ reason: `source_not_usable:${st.status}`, doc: (c && c.doc) || '', id: c && c.id });
      return;
    }
    usable.push(c);
  });
  return { usable, dropped };
}

/**
 * @returns {{hasSources:boolean, allReady:boolean, notReady:Array, readyCount:number,
 *   coveragePercent:number, summaryLine:string}}
 */
function summarizeSourceReadiness(sourceStatus) {
  const list = Array.isArray(sourceStatus) ? sourceStatus : [];
  if (!list.length) {
    return { hasSources: false, allReady: true, notReady: [], readyCount: 0, coveragePercent: 0, summaryLine: '' };
  }
  const notReady = list.filter((s) => s.status !== 'READY');
  const totalPages = list.reduce((a, s) => a + (s.totalPages || 0), 0);
  const verified = list.reduce((a, s) => a + (s.verifiedPages || 0), 0);
  const coveragePercent = totalPages > 0 ? Math.round((verified / totalPages) * 100) : 0;
  const summaryLine = notReady.length
    ? notReady.map((s) => `${s.name || s.sourceId}: ${s.status} (${s.verifiedPages || 0}/${s.totalPages || 0} trang đã đọc xong)`).join('; ')
    : '';
  return {
    hasSources: true,
    allReady: notReady.length === 0,
    notReady,
    readyCount: list.length - notReady.length,
    coveragePercent,
    summaryLine
  };
}

/** Số trang PHÂN BIỆT thực sự có mặt trong các evidence gửi đi (telemetry PHẦN S). */
function countRetrievedPages(contexts) {
  const pages = new Set();
  (Array.isArray(contexts) ? contexts : []).forEach((c) => {
    if (c && c.page != null) pages.add(`${c.sourceId || c.doc}#${c.page}`);
  });
  return pages.size;
}

/** Fingerprint phiên bản trích xuất của toàn bộ nguồn — đổi extraction version/coverage thì cache
 * cũ KHÔNG được dùng lại (PHẦN T). */
function sourceVersionSignature(sourceStatus) {
  return (Array.isArray(sourceStatus) ? sourceStatus : [])
    .map((s) => `${s.sourceId}|${s.status}|v${s.extractionVersion}|${s.verifiedPages}/${s.totalPages}`)
    .sort()
    .join(',');
}

module.exports = {
  isPlaceholderContext,
  isSourceUsableFromStatus,
  filterUsableContexts,
  summarizeSourceReadiness,
  countRetrievedPages,
  sourceVersionSignature,
  PLACEHOLDER_PATTERNS
};
