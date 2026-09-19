'use strict';
/* ============================================================================================
 * TEST PROVENANCE PHÍA SERVER (PHẦN R — TEST 11, 12, 13, 14) + PHẦN F/N/T
 * ============================================================================================
 * Ba câu hỏi bộ test này canh giữ:
 *   1. "[5]" trong câu trả lời resolve về ĐÚNG evidence nào — trang nào, file nào? (TEST 11)
 *   2. Citation trỏ vào nguồn/trang không tồn tại có bị TỪ CHỐI không? (TEST 12)
 *   3. Placeholder và evidence của nguồn chưa đọc xong có bị chặn trước khi chạm prompt không?
 *      (TEST 13) — và model có bị cấm nói "tài liệu không có thông tin" không? (TEST 14)
 */

const { buildCitationIndex } = require('../server/utils/citationIndex');
const { validateCitations, validateCitationProvenance } = require('../server/utils/citationValidator');
const sourceProvenance = require('../server/utils/sourceProvenance');
const { claimsSourceAbsenceWhileIncomplete, validateSolutionCompleteness } = require('../server/utils/completenessCheck');
const { buildSourceReadinessBlock } = require('../server/utils/promptBuilder');
const { validateChatBody } = require('../server/utils/validators');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ok  - ' + msg); }
  else { failed++; console.log('  FAIL - ' + msg); }
}

const READY_STATUS = [{
  sourceId: '1', name: 'Toan11.pdf', status: 'READY', extractionMethod: 'vision', extractionVersion: 2,
  totalPages: 134, parsedPages: 134, renderedPages: 134, extractedPages: 134, verifiedPages: 134,
  failedPages: [], renderCoverage: 100, readCoverage: 100, verifiedCoverage: 100
}];

function ctx(over) {
  return Object.assign({
    doc: 'Toan11.pdf', sourceId: '1', id: 1, chunkIndex: 1, totalChunks: 200,
    page: 10, startPage: 10, endPage: 10, evidenceId: '1:p10',
    extractionMethod: 'vision', extractionStatus: 'ok', text: 'nội dung mặc định'
  }, over || {});
}

console.log('\n== TEST 11: citation trỏ trang 72 PHẢI resolve đúng trang 72 ==');
{
  const contexts = [
    ctx({ id: 1, page: 5, evidenceId: '1:p5', text: 'Trang 5: mở đầu chương một.' }),
    ctx({ id: 2, page: 40, evidenceId: '1:p40', text: 'Trang 40: định nghĩa cấp số cộng.' }),
    ctx({ id: 3, page: 60, evidenceId: '1:p60', text: 'Trang 60: ví dụ minh hoạ dãy số.' }),
    ctx({ id: 4, page: 71, evidenceId: '1:p71', text: 'Trang 71: bài tập vận dụng số một.' }),
    ctx({ id: 5, page: 72, evidenceId: '1:p72', text: 'Trang 72: Bài 1.9 giải phương trình lượng giác.' })
  ];
  const idx = buildCitationIndex(contexts);
  const entry5 = idx.citationMap.find((m) => m.citeNo === 5);
  ok(!!entry5, 'citationMap có mục cho [5]');
  ok(entry5.page === 72, `TEST 11: [5] resolve về ĐÚNG trang 72 (nhận ${entry5 && entry5.page})`);
  ok(entry5.doc === 'Toan11.pdf' && String(entry5.sourceId) === '1',
    'TEST 11: citationMap mang đủ file + sourceId, không chỉ số thứ tự');
  ok(entry5.evidenceId === '1:p72' && entry5.extractionMethod === 'vision',
    'TEST 11/PHẦN F: provenance đầy đủ (evidenceId + phương pháp trích xuất) đi kèm citeNo');
  ok(entry5.chunkIndex != null && entry5.totalChunks != null, 'TEST 11: có chunkIndex/totalChunks để truy nguyên vị trí đoạn');

  const prov = validateCitationProvenance('Theo tài liệu [5] ta có kết quả.', {
    contexts: idx.effectiveContexts, validCiteNos: idx.validCiteNos, aliasOf: idx.aliasOf, sourceStatus: READY_STATUS
  });
  ok(prov.valid && prov.resolved.length === 1 && prov.resolved[0].page === 72,
    'TEST 11: validator resolve [5] -> {doc, sourceId, page 72, evidenceId} chính xác');
}

console.log('\n== TEST 12: citation vào nguồn/trang không tồn tại phải bị TỪ CHỐI ==');
{
  const contexts = [ctx({ id: 1, page: 10 }), ctx({ id: 2, page: 11, evidenceId: '1:p11' })];
  const idx = buildCitationIndex(contexts);
  const r1 = validateCitations('Kết quả lấy từ [9].', idx.effectiveContexts, { validCiteNos: idx.validCiteNos, aliasOf: idx.aliasOf });
  ok(!r1.valid && r1.invalidCitations.indexOf(9) !== -1, 'TEST 12: [9] không tương ứng evidence nào -> bị đánh dấu invalid');

  // Trang vượt quá tổng số trang thật của nguồn -> provenance không hợp lệ dù citeNo nằm trong tập.
  const badPage = buildCitationIndex([ctx({ id: 1, page: 999, evidenceId: '1:p999' })]);
  const r2 = validateCitationProvenance('Xem [1].', {
    contexts: badPage.effectiveContexts, validCiteNos: badPage.validCiteNos, aliasOf: badPage.aliasOf,
    sourceStatus: READY_STATUS
  });
  ok(!r2.valid && r2.unresolved.indexOf(1) !== -1,
    'TEST 12: citation trỏ trang 999 trong tài liệu 134 trang -> validator TỪ CHỐI');

  // Evidence thuộc nguồn CHƯA READY -> không được dùng làm căn cứ.
  const notReady = [Object.assign({}, READY_STATUS[0], { status: 'EXTRACTING', extractedPages: 100, verifiedPages: 100 })];
  const r3 = validateCitationProvenance('Xem [1].', {
    contexts: badPage.effectiveContexts.map((c) => Object.assign({}, c, { page: 10 })),
    validCiteNos: badPage.validCiteNos, aliasOf: badPage.aliasOf, sourceStatus: notReady
  });
  ok(!r3.valid && r3.notReadySources.indexOf(1) !== -1,
    'TEST 12: citation vào evidence của nguồn CHƯA READY -> bị từ chối');

  // Chunk lỗi (extractionStatus != ok) cũng không được trích dẫn.
  const brokenIdx = buildCitationIndex([ctx({ id: 1, extractionStatus: 'failed' })]);
  const r4 = validateCitationProvenance('Xem [1].', {
    contexts: brokenIdx.effectiveContexts, validCiteNos: brokenIdx.validCiteNos, aliasOf: brokenIdx.aliasOf,
    sourceStatus: READY_STATUS
  });
  ok(!r4.valid && r4.placeholderCitations.indexOf(1) !== -1, 'TEST 12: citation vào chunk LỖI -> bị từ chối');
}

console.log('\n== TEST 13: placeholder KHÔNG BAO GIỜ được vào prompt ==');
{
  const contexts = [
    ctx({ id: 1, text: '⏳ Đang đọc…' }),
    ctx({ id: 2, text: '⚠️ Không đọc được nội dung file này.' }),
    ctx({ id: 3, text: '⏳ PDF scan — đang đọc bằng AI…' }),
    ctx({ id: 4, text: 'Bài 1.9. Giải phương trình đã cho theo công thức nghiệm.' })
  ];
  const { usable, dropped } = sourceProvenance.filterUsableContexts(contexts, READY_STATUS);
  ok(usable.length === 1 && usable[0].id === 4, `TEST 13: chỉ nội dung THẬT đi tiếp (giữ ${usable.length}/4)`);
  ok(dropped.length === 3 && dropped.every((d) => d.reason === 'placeholder'), 'TEST 13: 3 placeholder bị chặn, có ghi lý do');
  ok(sourceProvenance.isPlaceholderContext({ text: 'nội dung thật', extractionStatus: 'pending' }),
    'TEST 13: chunk có extractionStatus != ok cũng bị coi là không dùng được');
  // Không được loại oan: 1 trang tài liệu dài tình cờ chứa chữ "đang xử lý" vẫn là nội dung thật.
  const longReal = ctx({ id: 5, text: 'Bài toán về dây chuyền đang xử lý nguyên liệu. '.repeat(20) });
  ok(!sourceProvenance.isPlaceholderContext(longReal), 'TEST 13: KHÔNG loại oan đoạn dài chứa cụm từ trùng hợp');

  // Evidence của nguồn chưa từng có evidence nào (usableNow=false hoặc fallback theo status cũ khi
  // client chưa gửi usableNow) vẫn bị chặn tại cổng vào — nhưng nguồn PARTIAL đã CÓ evidence thật
  // (usableNow=true) thì KHÔNG bị chặn nữa (PHẦN VII/VIII, sửa cùng đợt với client).
  const notReady = [Object.assign({}, READY_STATUS[0], { status: 'INCOMPLETE' })];
  const f2 = sourceProvenance.filterUsableContexts([ctx({ id: 4, text: 'nội dung thật' })], notReady);
  ok(f2.usable.length === 0 && /source_not_usable/.test(f2.dropped[0].reason),
    'TEST 13/PHẦN B: nguồn chưa từng có evidence (không usableNow) không được xuất hiện như nguồn hoàn chỉnh');

  const partialUsable = [Object.assign({}, READY_STATUS[0], {
    status: 'INCOMPLETE', verifiedPages: 100, availabilityStatus: 'PARTIAL', usableNow: true
  })];
  const f2b = sourceProvenance.filterUsableContexts([ctx({ id: 4, text: 'nội dung thật' })], partialUsable);
  ok(f2b.usable.length === 1,
    'TEST 13/PHẦN B (mới): nguồn INCOMPLETE nhưng usableNow=true -> evidence VẪN đi qua (progressive ingestion)');

  // Client cũ chưa gửi sourceStatus -> KHÔNG loại (tương thích ngược).
  const f3 = sourceProvenance.filterUsableContexts([ctx({ id: 4, text: 'nội dung thật' })], []);
  ok(f3.usable.length === 1, 'tương thích ngược: client chưa gửi sourceStatus thì không loại evidence');
}

console.log('\n== TEST 14: nguồn chưa đọc xong -> cấm nói "tài liệu không có thông tin" ==');
{
  const incomplete = { hasSources: true, allReady: false, summaryLine: 'Toan11.pdf: EXTRACTING (100/134 trang đã đọc xong)' };
  ok(claimsSourceAbsenceWhileIncomplete('Rất tiếc, trong tài liệu không có thông tin về bài này.', incomplete),
    'TEST 14: phát hiện câu khẳng định thiếu nguồn khi nguồn chưa đọc xong');
  ok(claimsSourceAbsenceWhileIncomplete('Mình không tìm thấy thông tin trong tài liệu bạn gửi.', incomplete),
    'TEST 14: bắt được cả biến thể "không tìm thấy thông tin trong tài liệu"');
  ok(!claimsSourceAbsenceWhileIncomplete('Trong tài liệu không có thông tin này.', { hasSources: true, allReady: true }),
    'TEST 14: nguồn ĐÃ READY thì câu đó hợp lệ, không bị gắn cờ');

  const res = validateSolutionCompleteness(
    'Bước 1: đọc đề.\nTrong tài liệu không có thông tin về phần này nên mình dùng kiến thức chuẩn.\nVậy đáp số là 5.',
    { stage: 'detail', problemText: 'Giải bài toán', sourceReadiness: incomplete, finishReason: 'stop' }
  );
  ok((res.reasons || []).indexOf('source_absence_claim_while_incomplete') !== -1
    || (res.softReasons || []).indexOf('source_absence_claim_while_incomplete') !== -1,
  'TEST 14: completeness check ghi nhận lỗi source_absence_claim_while_incomplete');

  const block = buildSourceReadinessBlock(incomplete);
  ok(/TUYỆT ĐỐI KHÔNG/.test(block) && /chưa được đọc hoàn tất/.test(block),
    'TEST 14: system prompt có ràng buộc CỨNG cấm kết luận "tài liệu không có"');
  ok(buildSourceReadinessBlock({ hasSources: false }) === '', 'không có nguồn -> không chèn khối thừa (tiết kiệm token)');
  const readyBlock = buildSourceReadinessBlock({ hasSources: true, allReady: true });
  ok(/đã được đọc và xác minh XONG/.test(readyBlock), 'nguồn READY -> prompt nói rõ đã đọc xong 100%');
}

console.log('\n== PHẦN T: cache key phải đổi khi evidence/phiên bản trích xuất đổi ==');
{
  const a = sourceProvenance.sourceVersionSignature(READY_STATUS);
  const b = sourceProvenance.sourceVersionSignature([Object.assign({}, READY_STATUS[0], { verifiedPages: 120 })]);
  const c = sourceProvenance.sourceVersionSignature([Object.assign({}, READY_STATUS[0], { extractionVersion: 3 })]);
  ok(a !== b, 'coverage đổi -> chữ ký nguồn đổi -> cache cũ không bị dùng nhầm');
  ok(a !== c, 'extractionVersion đổi -> chữ ký nguồn đổi (PHẦN T)');
  ok(sourceProvenance.sourceVersionSignature([]) === '', 'không có nguồn -> chữ ký rỗng, không rác cache key');
}

console.log('\n== PHẦN S: đếm đúng thứ THỰC SỰ gửi đi ==');
{
  const contexts = [ctx({ id: 1, page: 10 }), ctx({ id: 2, page: 10 }), ctx({ id: 3, page: 72 })];
  ok(sourceProvenance.countRetrievedPages(contexts) === 2,
    'retrievedPages đếm số TRANG PHÂN BIỆT thực sự có trong request (2), không phải số chunk (3)');
  const summary = sourceProvenance.summarizeSourceReadiness([
    Object.assign({}, READY_STATUS[0]),
    { sourceId: '2', name: 'b.pdf', status: 'EXTRACTING', totalPages: 66, verifiedPages: 33 }
  ]);
  ok(!summary.allReady && summary.readyCount === 1, 'summarizeSourceReadiness: 1 nguồn xong, 1 nguồn chưa');
  ok(summary.coveragePercent === Math.round((134 + 33) / (134 + 66) * 100),
    `sourceCoverage tính trên số trang THẬT (nhận ${summary.coveragePercent}%)`);
}

console.log('\n== validators: nhận trạng thái nguồn + provenance, và tự làm sạch ==');
{
  const body = validateChatBody({
    query: 'giải bài 1.9',
    contexts: [{ doc: 'a.pdf', id: 1, text: 'Bài 1.9…', page: 72, sourceId: '1', evidenceId: '1:p72', extractionMethod: 'vision', extractionStatus: 'ok', retrievalTier: 1 }],
    sourceStatus: [{ sourceId: '1', name: 'a.pdf', status: 'READY', totalPages: 134, verifiedPages: 134, extractionVersion: 2, extractionMethod: 'vision' }],
    historyTurnsRaw: 20,
    settings: {}
  });
  ok(body.contexts[0].evidenceId === '1:p72' && body.contexts[0].extractionMethod === 'vision',
    'validators giữ nguyên provenance của evidence');
  ok(body.sourceStatus.length === 1 && body.sourceStatus[0].status === 'READY', 'validators nhận sourceStatus');
  ok(body.historyTurnsRaw === 20, 'validators nhận historyTurnsRaw cho telemetry');

  const dirty = validateChatBody({
    query: 'x',
    contexts: [{ doc: 'a.pdf', id: 1, text: 'abc', extractionMethod: 'HACK', extractionStatus: 'HACK' }],
    sourceStatus: [{ sourceId: '1', status: 'TOTALLY_READY_TRUST_ME', totalPages: -5 }],
    settings: {}
  });
  ok(dirty.contexts[0].extractionMethod === 'unknown' && dirty.contexts[0].extractionStatus === 'ok',
    'giá trị lạ bị quy về giá trị an toàn, không tin dữ liệu client mù quáng');
  ok(dirty.sourceStatus[0].status === 'INCOMPLETE' && dirty.sourceStatus[0].totalPages === 0,
    'trạng thái nguồn bịa -> quy về INCOMPLETE (fail-safe: thà chặt hơn là tin nhầm READY)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
