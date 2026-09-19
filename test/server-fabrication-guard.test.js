'use strict';
/* ============================================================================================
 * TEST PHÍA SERVER — CHỐNG BỊA ĐỀ BÀI CÓ SỐ THỨ TỰ CỤ THỂ
 * ============================================================================================
 * Canh 3 lớp phòng vệ ở server sau khi client báo cáo unmatchedRequirementLabels:
 *   (1) buildRequirementIntegrityBlock() — cấm cứng trong system prompt
 *   (2) detectFabricatedRequirementLabels()/validateSolutionCompleteness() — bắt được nếu model
 *       vẫn lỡ vi phạm, gắn HARD reason
 *   (3) buildResumePrompt()/buildMinimalContinuationContext() — continuation phải THU HỒI, không
 *       "viết tiếp" nội dung sai
 */

const { buildRequirementIntegrityBlock, buildChatSystemPrompt } = require('../server/utils/promptBuilder');
const { detectFabricatedRequirementLabels, validateSolutionCompleteness } = require('../server/utils/completenessCheck');
const { buildResumePrompt, buildMinimalContinuationContext } = require('../server/utils/continuation');
const { validateChatBody } = require('../server/utils/validators');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ok  - ' + msg); }
  else { failed++; console.log('  FAIL - ' + msg); }
}

// Đúng câu trả lời THẬT đã bị bịa trong báo lỗi của người dùng — dùng nguyên văn tinh thần để test
// không trở thành fixture "quá dễ" so với sản phẩm thật.
const FABRICATED_ANSWER = `## Lời giải

### Giải bài 1.9 (Xác định số đo góc lượng giác theo chiều quay và hệ thức Chasles)
* Bước 1: Ôn lại định nghĩa số đo góc lượng giác (Ou, Ov) với tia đầu Ou và tia cuối Ov.
* Bước 2: Sử dụng công thức tổng quát của góc lượng giác khi biết một số đo cơ bản α:
sđ(Ou, Ov) = α + k360° (k ∈ ℤ)
* Bước 3: Áp dụng hệ thức Chasles đối với ba tia bất kì Ou, Ov, Ow:
sđ(Ou, Ov) + sđ(Ov, Ow) = sđ(Ou, Ow) + k360° (k ∈ ℤ)

Vậy ta có kết quả như trên.`;

const HONEST_ANSWER = `## Lời giải

Mình chưa tìm thấy đúng nội dung bài 1.9 trong phần đã trích xuất của tài liệu bạn đã tải lên. Các đoạn liên quan gần nhất mà mình tìm được là về hệ thức Chasles (trang 38-39), nhưng đó KHÔNG PHẢI nguyên văn bài 1.9. Bạn vui lòng kiểm tra lại nguồn hoặc cho mình biết chính xác đề bài.`;

console.log('\n== (1) system prompt: cấm cứng bịa cho nhãn không có evidence ==');
{
  const block = buildRequirementIntegrityBlock(['1.9', '1.10', '1.11']);
  ok(/TUYỆT ĐỐI KHÔNG/.test(block) && /"1.9"/.test(block) && /"1.11"/.test(block),
    'block liệt kê đúng 3 nhãn và cấm cứng bịa');
  ok(/GẮN SỐ THẬT LÊN NỘI DUNG BỊA/.test(block), 'block gọi đúng tên hành vi cấm — không mơ hồ');
  ok(buildRequirementIntegrityBlock([]) === '', 'không có nhãn nào -> không chèn khối thừa (tiết kiệm token)');
  ok(buildRequirementIntegrityBlock(undefined) === '', 'undefined -> không crash, trả rỗng');

  const systemPromptApproach = buildChatSystemPrompt({
    deepThinking: false, image: null, rules: [], contexts: [], settings: {}, stage: 'approach',
    problemText: 'giải các bài từ 1.9 đến 1.11', subjectId: 'math',
    unmatchedRequirementLabels: ['1.9', '1.10', '1.11']
  });
  ok(systemPromptApproach.indexOf('"1.9"') !== -1, 'buildChatSystemPrompt (đường chạy THẬT trong chat.js) thực sự chèn block vào system prompt cho stage approach');

  const systemPromptDetail = buildChatSystemPrompt({
    deepThinking: false, image: null, rules: [], contexts: [], settings: {}, stage: 'detail', approachText: 'x',
    problemText: 'giải các bài từ 1.9 đến 1.11', subjectId: 'math',
    unmatchedRequirementLabels: ['1.9']
  });
  ok(systemPromptDetail.indexOf('"1.9"') !== -1, 'block cũng có mặt ở stage detail (nơi lời giải đầy đủ thực sự được viết)');
}

console.log('\n== (2) completeness: BẮT ĐƯỢC đúng câu trả lời bịa thật, KHÔNG báo động giả với câu trả lời trung thực ==');
{
  // Fixture đúng nguyên văn báo lỗi thật: model chỉ trình bày (bịa) cho bài 1.9, KHÔNG đả động gì
  // tới 1.10/1.11 — nên chỉ '1.9' được phát hiện là fabrication; 1.10/1.11 đơn giản là chưa được
  // trả lời (vấn đề khác: missing_coverage / requirement_without_evidence, không phải fabrication).
  const fabricated = detectFabricatedRequirementLabels(FABRICATED_ANSWER, ['1.9', '1.10', '1.11']);
  ok(fabricated.length === 1 && fabricated[0] === '1.9', `phát hiện ĐÚNG DUY NHẤT '1.9' bị bịa — đúng như fixture thật (nhận ${JSON.stringify(fabricated)})`);

  const honest = detectFabricatedRequirementLabels(HONEST_ANSWER, ['1.9', '1.10', '1.11']);
  ok(honest.length === 0, `câu trả lời TRUNG THỰC (thừa nhận chưa tìm thấy) -> KHÔNG bị gắn cờ oan (nhận ${JSON.stringify(honest)})`);

  const noUnmatched = detectFabricatedRequirementLabels(FABRICATED_ANSWER, []);
  ok(noUnmatched.length === 0, 'không có nhãn unmatched nào -> không có gì để phát hiện (tránh false-positive khi mọi thứ đều có evidence)');

  const res = validateSolutionCompleteness(FABRICATED_ANSWER, {
    stage: 'detail', problemText: 'giải các bài từ 1.9 đến 1.11', finishReason: 'stop',
    unmatchedRequirementLabels: ['1.9', '1.10', '1.11']
  });
  ok(res.severity === 'HARD' && res.reasons.indexOf('fabricated_exercise_under_unmatched_label') !== -1,
    `validateSolutionCompleteness gắn HARD reason cho câu trả lời bịa (nhận severity=${res.severity}, reasons=${JSON.stringify(res.reasons)})`);
  ok(res.fabricatedRequirementLabels.length === 1 && res.fabricatedRequirementLabels[0] === '1.9',
    `trả về đúng danh sách nhãn đã bị bịa để continuation dùng (nhận ${JSON.stringify(res.fabricatedRequirementLabels)})`);
  ok(res.status === 'INCOMPLETE', 'HARD -> status INCOMPLETE, không được coi là COMPLETE dù finishReason=stop');

  const res2 = validateSolutionCompleteness(HONEST_ANSWER, {
    stage: 'detail', problemText: 'giải các bài từ 1.9 đến 1.11', finishReason: 'stop',
    unmatchedRequirementLabels: ['1.9', '1.10', '1.11']
  });
  ok(res2.reasons.indexOf('fabricated_exercise_under_unmatched_label') === -1,
    'validateSolutionCompleteness KHÔNG báo động giả với câu trả lời trung thực (thừa nhận chưa tìm thấy)');
}

console.log('\n== (3) continuation: THU HỒI công khai, không "viết tiếp" nội dung sai ==');
{
  const prompt = buildResumePrompt({ priorTail: FABRICATED_ANSWER.slice(-400), fabricatedRequirementLabels: ['1.9', '1.10', '1.11'] });
  ok(/CẢNH BÁO NGHIÊM TRỌNG/.test(prompt), 'buildResumePrompt cảnh báo nghiêm trọng khi có fabrication');
  ok(!/Viết tiếp ĐÚNG từ chỗ đang thiếu/.test(prompt), 'KHÔNG dùng hướng dẫn "viết tiếp" mặc định — sẽ củng cố nội dung sai');
  ok(/KHÔNG được viết tiếp theo hướng cũ/.test(prompt), 'yêu cầu rõ ràng KHÔNG viết tiếp theo hướng cũ');
  ok(/cải chính/.test(prompt), 'yêu cầu viết đoạn cải chính công khai');

  const normalPrompt = buildResumePrompt({ priorTail: 'abc', reasons: ['truncated_tail'] });
  ok(/Viết tiếp ĐÚNG từ chỗ đang thiếu/.test(normalPrompt), 'trường hợp KHÔNG fabrication vẫn dùng hướng dẫn "viết tiếp" bình thường (không phá behavior cũ)');

  const ctx = buildMinimalContinuationContext({
    messages: [{ role: 'user', content: 'giải 1.9 đến 1.11' }],
    priorText: FABRICATED_ANSWER,
    completeness: {
      reasons: ['fabricated_exercise_under_unmatched_label'],
      fabricatedRequirementLabels: ['1.9', '1.10', '1.11'],
      missingCoverage: [], citationValidation: null, drawingCanonicalErrors: []
    }
  });
  const userTurn = ctx.messages[ctx.messages.length - 1];
  ok(userTurn.role === 'user' && /CẢNH BÁO NGHIÊM TRỌNG/.test(userTurn.content),
    'buildMinimalContinuationContext (đường chạy THẬT trong resumableStream.js) truyền đúng fabricatedRequirementLabels vào prompt cải chính');
}

console.log('\n== validators: nhận unmatchedRequirementLabels, tự làm sạch ==');
{
  const body = validateChatBody({
    query: 'giải 1.9 đến 1.11',
    contexts: [],
    requirementLabels: ['1.9', '1.10', '1.11'],
    unmatchedRequirementLabels: ['1.9', '1.10', '1.11'],
    settings: {}
  });
  ok(body.unmatchedRequirementLabels.length === 3, 'validators giữ đúng unmatchedRequirementLabels');
  ok(body.requirementLabels.length === 3, 'validators giữ đúng requirementLabels');

  const big = Array.from({ length: 100 }, (_, i) => `${i}.${i}`);
  const bodyClip = validateChatBody({ query: 'x', contexts: [], unmatchedRequirementLabels: big, settings: {} });
  ok(bodyClip.unmatchedRequirementLabels.length === 30, `mảng quá dài bị cắt về trần an toàn 30 (nhận ${bodyClip.unmatchedRequirementLabels.length})`);

  const bodyMissing = validateChatBody({ query: 'x', contexts: [], settings: {} });
  ok(Array.isArray(bodyMissing.unmatchedRequirementLabels) && bodyMissing.unmatchedRequirementLabels.length === 0,
    'không gửi field -> mặc định mảng rỗng, không crash (tương thích ngược với client cũ)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
