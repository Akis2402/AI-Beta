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
    // Không có thông tin trạng thái (client cũ chưa gửi sourceStatus) -> KHÔNG loại: giữ hành vi
    // tương thích ngược, chỉ những nguồn ĐƯỢC KHAI BÁO là chưa xong mới bị loại.
    if (st && st.status !== 'READY') {
      dropped.push({ reason: `source_not_ready:${st.status}`, doc: (c && c.doc) || '', id: c && c.id });
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
  filterUsableContexts,
  summarizeSourceReadiness,
  countRetrievedPages,
  sourceVersionSignature,
  PLACEHOLDER_PATTERNS
};
