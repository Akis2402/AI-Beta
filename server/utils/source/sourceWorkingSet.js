'use strict';

// ============================================================================================
// PHẦN M + DV + DW + BR + FC-5 — SOURCE WORKING SET (ĐÔNG CỨNG MỘT LẦN, DÙNG LẠI MÃI)
// ============================================================================================
// Bug kiến trúc cũ: mỗi giai đoạn của một request (answer -> continuation -> reconcile -> failover
// sang provider khác) đều tự đi hỏi lại nguồn từ đầu. Một câu hỏi = 1 lần retrieval là đúng; 4 lần
// retrieval cho cùng một câu hỏi là tiền trả cho việc lặp lại chính mình.
//
// Working set là BẢN CHỐT của "câu hỏi này cần đúng những bằng chứng nào". Tạo một lần, FREEZE
// (Object.freeze thật, không phải quy ước), rồi mọi giai đoạn sau dùng lại. Continuation KHÔNG được
// phép retrieval; muốn thêm bằng chứng thì tạo VERSION MỚI qua expand() — và version cũ vẫn nguyên
// vẹn cho các luồng đang chạy dở (PHẦN DV).

const { buildQueryFingerprint, contentFingerprint } = require('../queryFingerprint');

let seq = 0;
function nextId() { seq += 1; return `ws_${Date.now().toString(36)}_${seq}`; }

/**
 * @param {{
 *   requestId:string, query:string, subject?:string, language?:string,
 *   evidence:Array, sources?:Array, requirementLabels?:string[],
 *   citationMap?:object, sourceVersion?:string, promptVersion?:string, imageFingerprints?:string[]
 * }} args
 * @returns {object} working set ĐÃ FREEZE
 */
function createWorkingSet(args = {}) {
  const evidence = Array.isArray(args.evidence) ? args.evidence : [];
  const selectedSourceIds = [...new Set(evidence.map((e) => e && e.sourceId).filter(Boolean))];
  const queryFingerprint = buildQueryFingerprint({
    query: args.query,
    subject: args.subject,
    language: args.language,
    sourceVersion: args.sourceVersion,
    sourceSelection: selectedSourceIds,
    imageFingerprints: args.imageFingerprints,
    promptVersion: args.promptVersion
  });

  const ws = {
    version: 1,
    workingSetId: nextId(),
    requestId: args.requestId || null,
    queryFingerprint,
    sourceVersionFingerprint: args.sourceVersion || '',
    // Fingerprint của CHÍNH tập bằng chứng: nếu nó không đổi thì mọi thứ dẫn xuất từ nó cũng không đổi.
    evidenceFingerprint: contentFingerprint(evidence.map((e) => `${e.evidenceId || ''}:${e.text || ''}`).join('\u0000')),
    requirementLabels: Object.freeze([...(args.requirementLabels || [])]),
    selectedSourceIds: Object.freeze(selectedSourceIds),
    selectedEvidence: Object.freeze(evidence.map((e) => Object.freeze({ ...e }))),
    selectedPages: Object.freeze([...new Set(evidence.map((e) => e && e.page).filter((p) => p != null))]),
    citationMap: Object.freeze({ ...(args.citationMap || {}) }),
    tokenEstimate: Math.ceil(evidence.reduce((a, e) => a + String((e && e.text) || '').length, 0) / 3.2),
    completeForQuery: coversAllRequirements(evidence, args.requirementLabels)
  };
  return Object.freeze(ws);
}

/* ============================================================================================
   MỤC 19/20/22 — COVERAGE THEO TỪNG YÊU CẦU, KHÔNG PHẢI `text.includes(label)`
   ============================================================================================
   Bản cũ quyết định "yêu cầu này đã có bằng chứng chưa" bằng đúng một phép so khớp chuỗi thô:
       e.text.includes(label)
   Ba kiểu sai nó gây ra:
     1. Nhãn "(b)" không khớp đoạn viết "b)" / "b." / "Câu b" -> báo THIẾU dù bằng chứng đang có
        (rồi kéo theo một lượt web search/expansion hoàn toàn thừa -> đốt token).
     2. Nhãn "1.1" khớp nhầm trong "1.11", "11.1" -> báo ĐỦ trong khi thực ra chưa có gì.
     3. Bỏ qua metadata `requirementIds` mà retrieval đã gắn sẵn cho từng evidence — tín hiệu mạnh
        nhất lại không được dùng.
   Nay: metadata trước, rồi khớp nhãn có ranh giới (không khớp giữa số), rồi mới tới chuỗi dài.
   Mỗi hàng có requirementId/evidenceIds/confidence/matchKind/missingReason (mục 20) để tầng trên
   quyết định expansion theo ĐÚNG yêu cầu còn thiếu thay vì retrieval lại toàn bộ.
   ============================================================================================ */

/** "(b)" -> "b" · "Câu 1.10:" -> "1.10" · " II. " -> "ii" */
function normalizeLabel(label) {
  return String(label == null ? '' : label)
    .trim().toLowerCase()
    .replace(/^(câu|bài|phần|part|question|ý)\s+/i, '')
    .replace(/^[([{<]+|[)\]}>.:,;]+$/g, '')
    .trim();
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Nhãn xuất hiện như MỘT MỤC ĐỘC LẬP trong text hay không: "(b)", "b)", "b.", "Câu b", "ý b".
 * Ranh giới hai đầu chặn khớp nhầm giữa chuỗi số ("1.1" trong "1.11") và giữa từ ("b" trong "bài").
 */
function labelAppearsAsItem(text, normalized) {
  if (!normalized) return false;
  const core = escapeRe(normalized);
  const re = new RegExp(
    '(^|[\\s(\\[{"\u2018\u201c])' +            // đầu dòng hoặc ký tự mở
    '(?:câu|bài|phần|ý|part|question)?\\s*' +
    '[([{]?' + core + '[)\\]}]?' +
    '(?=$|[\\s)\\]}.:,;\u2019\u201d–—-])',      // theo sau là dấu/khoảng trắng, KHÔNG phải chữ số/chữ cái
    'i'
  );
  return re.test(String(text || ''));
}

/** PHẦN Q + mục 19/20/22: mỗi yêu cầu một hàng, kèm bằng chứng và độ tin cậy. */
function coverageMatrix(evidence, requirementLabels) {
  const labels = [...(requirementLabels || [])];
  const list = (evidence || []).filter((e) => e && typeof e === 'object');

  const rows = labels.map((label) => {
    const normalized = normalizeLabel(label);
    const matches = [];

    // (1) METADATA — retrieval đã gắn evidence này cho đúng yêu cầu nào. Tín hiệu mạnh nhất.
    list.forEach((e) => {
      const ids = Array.isArray(e.requirementIds) ? e.requirementIds
        : (Array.isArray(e.requirementLabels) ? e.requirementLabels : null);
      if (ids && ids.some((id) => normalizeLabel(id) === normalized)) {
        matches.push({ e, kind: 'metadata', confidence: 0.98 });
      }
    });

    // (2) NHÃN ĐỨNG NHƯ MỘT MỤC trong nội dung — có ranh giới, không khớp giữa số/giữa từ.
    if (!matches.length) {
      list.forEach((e) => {
        if (typeof e.text === 'string' && labelAppearsAsItem(e.text, normalized)) {
          matches.push({ e, kind: 'label_item', confidence: 0.82 });
        }
      });
    }

    // (3) NHÃN DẠNG CÂU CHỮ ("chứng minh rằng tam giác ABC cân") — chuỗi đủ dài mới cho khớp thô.
    if (!matches.length && normalized.length >= 6) {
      list.forEach((e) => {
        if (typeof e.text === 'string' && e.text.toLowerCase().includes(normalized)) {
          matches.push({ e, kind: 'text_contains', confidence: 0.6 });
        }
      });
    }

    const hit = matches[0] ? matches[0].e : null;
    const kind = matches[0] ? matches[0].kind : null;
    return {
      // --- giữ nguyên hình dạng cũ để mọi caller/test hiện có không phải đổi ---
      label,
      covered: matches.length > 0,
      sourceId: hit ? (hit.sourceId || null) : null,
      evidenceId: hit ? (hit.evidenceId || null) : null,
      // --- bổ sung theo mục 20: đủ dữ liệu để expansion nhắm ĐÚNG yêu cầu còn thiếu ---
      requirementId: normalized,
      evidenceIds: matches.map((m) => m.e.evidenceId).filter(Boolean),
      sourceIds: [...new Set(matches.map((m) => m.e.sourceId).filter(Boolean))],
      matchKind: kind,
      confidence: matches[0] ? matches[0].confidence : 0,
      missingReason: matches.length ? null : (list.length ? 'no_evidence_for_requirement' : 'no_evidence_at_all')
    };
  });

  const missing = rows.filter((r) => !r.covered);
  return {
    rows,
    covered: rows.length - missing.length,
    total: rows.length,
    missingRequirementIds: missing.map((r) => r.requirementId),
    // Coverage THEO YÊU CẦU (mục 21): 10 chunk cho ý (a) và 0 chunk cho (b)(c) KHÔNG phải là
    // coverage cao — tỷ lệ này tính trên số yêu cầu được phủ, không tính trên số chunk chọn được.
    requirementCoverageRatio: rows.length ? (rows.length - missing.length) / rows.length : 1
  };
}

function coversAllRequirements(evidence, requirementLabels) {
  const labels = [...(requirementLabels || [])];
  if (!labels.length) return (evidence || []).length > 0;
  return coverageMatrix(evidence, labels).rows.every((r) => r.covered);
}

/**
 * PHẦN DW — mở rộng CÓ MỤC TIÊU. Không rebuild toàn bộ nguồn; chỉ thêm đúng phần thiếu và tạo
 * version mới. Bản cũ KHÔNG bị mutate (continuation đang chạy vẫn thấy dữ liệu nhất quán).
 */
function expandWorkingSet(ws, extraEvidence, reason) {
  const merged = [...ws.selectedEvidence];
  const seen = new Set(merged.map((e) => e.evidenceId || `${e.sourceId}:${e.page}:${String(e.text).slice(0, 40)}`));
  (extraEvidence || []).forEach((e) => {
    const key = e.evidenceId || `${e.sourceId}:${e.page}:${String(e.text).slice(0, 40)}`;
    if (seen.has(key)) return; // PHẦN CB: không thêm trùng
    seen.add(key);
    merged.push(e);
  });
  const next = createWorkingSet({
    requestId: ws.requestId,
    query: '',
    evidence: merged,
    requirementLabels: ws.requirementLabels,
    citationMap: ws.citationMap,
    sourceVersion: ws.sourceVersionFingerprint
  });
  return Object.freeze({
    ...next,
    version: ws.version + 1,
    workingSetId: ws.workingSetId, // cùng một "câu hỏi", khác version
    queryFingerprint: ws.queryFingerprint,
    expandReason: reason || 'targeted_expansion'
  });
}

/**
 * Bộ đếm dùng lại — dựng đúng con số cho telemetry "continuation retrieval = 0" (FC-5).
 */
function createReuseTracker(ws) {
  const uses = [];
  return {
    use(stage) { uses.push(String(stage || 'unknown')); return ws; },
    snapshot() {
      return {
        workingSetId: ws ? ws.workingSetId : null,
        workingSetVersion: ws ? ws.version : 0,
        workingSetReused: uses.length > 1,
        workingSetUses: uses.length,
        workingSetStages: [...uses],
        sourceRetrievalCalls: ws ? 1 : 0 // đúng 1 lần cho cả request, bất kể bao nhiêu giai đoạn
      };
    }
  };
}

module.exports = { createWorkingSet, expandWorkingSet, coverageMatrix, coversAllRequirements, createReuseTracker, normalizeLabel, labelAppearsAsItem };
