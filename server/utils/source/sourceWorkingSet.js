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

/** PHẦN Q: nhãn yêu cầu nào đã có bằng chứng THẬT (khớp trong text), nhãn nào chưa. */
function coverageMatrix(evidence, requirementLabels) {
  const labels = [...(requirementLabels || [])];
  const rows = labels.map((label) => {
    const hit = (evidence || []).find((e) => e && typeof e.text === 'string' && e.text.includes(label));
    return { label, covered: !!hit, sourceId: hit ? (hit.sourceId || null) : null, evidenceId: hit ? (hit.evidenceId || null) : null };
  });
  return { rows, covered: rows.filter((r) => r.covered).length, total: rows.length };
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

module.exports = { createWorkingSet, expandWorkingSet, coverageMatrix, coversAllRequirements, createReuseTracker };
