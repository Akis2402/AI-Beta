'use strict';

// ============================================================================================
// PHẦN 25 — TẦNG 3: MODEL JUDGE cho case BORDERLINE
// ============================================================================================
// Nguyên tắc của PHẦN 25: "KHÔNG tạo một reasoning loop khổng lồ chỉ để quyết định có tạo ảnh hay
// không. Visual decision phải dùng structured classifier/heuristics trước. Chỉ những case
// borderline mới dùng model judgement bổ sung."
//
// Vì vậy module này được thiết kế để RẺ TỚI MỨC TỐI ĐA:
//   - chỉ được gọi khi decisionEngine.needsModelJudgement() === true (vùng ±BORDERLINE_BAND quanh ngưỡng)
//   - prompt tĩnh, ngắn (~90 token) + đúng 1 dòng câu hỏi -> cache prefix tốt
//   - maxTokens rất nhỏ, KHÔNG bật deepThinking (đây là phân loại nhị phân, không phải suy luận)
//   - KHÔNG BAO GIỜ streaming, KHÔNG BAO GIỜ web search
//   - có timeout riêng, rất ngắn; hết hạn -> giữ nguyên quyết định heuristic
//   - KHÔNG BAO GIỜ throw: mọi lỗi -> trả null -> pipeline dùng kết quả heuristic như cũ
//
// Đo trên bộ chuẩn (test/visual-decision-corpus.test.js): sau khi hiệu chỉnh ngưỡng, chỉ ~4% số câu
// rơi vào vùng borderline, nên chi phí trung bình của tầng này gần như bằng 0.

const JUDGE_TIMEOUT_MS = Number(process.env.VISUAL_JUDGE_TIMEOUT_MS) || 6000;
const JUDGE_MAX_TOKENS = Number(process.env.VISUAL_JUDGE_MAX_TOKENS) || 120;

// PREFIX TĨNH — không chứa gì phụ thuộc request, để provider prompt caching dùng lại được nguyên vẹn.
const JUDGE_SYSTEM = [
  'Bạn là bộ phân loại. Nhiệm vụ DUY NHẤT: quyết định một hình minh họa có làm câu trả lời cho học',
  'sinh TỐT HƠN ĐÁNG KỂ hay không.',
  'Trả lời "useful": true CHỈ KHI hình thể hiện được thứ mà chữ diễn đạt kém: quan hệ không gian,',
  'hình dạng, cấu trúc, sơ đồ mạch/quá trình, đồ thị.',
  'Trả lời "useful": false nếu câu hỏi chỉ cần công thức, phép tính, định nghĩa, hoặc nếu hình chỉ',
  'lặp lại điều mà chữ đã nói rõ.',
  'CHỈ in ra JSON, không giải thích, không markdown:',
  '{"useful":true|false,"confidence":0..1,"visualType":"geometry_diagram|mathematical_plot|physics_diagram|circuit_diagram|flowchart|chemistry_structure|biology_diagram|map_diagram|concept_illustration|no_visual"}'
].join('\n');

/**
 * parseJudgeVerdict() — bóc JSON từ output model một cách phòng thủ (model có thể bọc ```json).
 * @returns {{useful:boolean, confidence:number, visualType:string}|null}
 */
function parseJudgeVerdict(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```json|```/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj;
  try { obj = JSON.parse(match[0]); } catch (e) { return null; }
  if (typeof obj.useful !== 'boolean') return null;
  const confidence = Number(obj.confidence);
  return {
    useful: obj.useful,
    confidence: Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? confidence : 0.5,
    visualType: typeof obj.visualType === 'string' && obj.visualType !== 'no_visual' ? obj.visualType : null
  };
}

/**
 * createVisualJudge() — dựng hàm `judge` để truyền vào visualPipeline.
 *
 * @param {{callFn:Function, deadline?:object, signal?:AbortSignal, requestId?:string,
 *   logger?:object}} cfg `callFn(args) => Promise<{text}>` — chat.js truyền callWithFailover đã
 *   bind sẵn providers, nên module này KHÔNG cần biết gì về rotation/provider.
 * @returns {Function|null} null nếu không có callFn (tắt tầng 3 một cách có chủ đích).
 */
function createVisualJudge({ callFn, deadline, signal, requestId, logger } = {}) {
  if (typeof callFn !== 'function') return null;

  return async function judge({ question, subject, decision }) {
    // Không còn đủ thời gian cho cả tầng 3 lẫn việc dựng hình -> bỏ qua, giữ heuristic.
    if (deadline && typeof deadline.remaining === 'function' && deadline.remaining() < JUDGE_TIMEOUT_MS + 2000) {
      return null;
    }
    if (signal && signal.aborted) return null;

    const userLine = [
      `Môn: ${subject || 'không xác định'}.`,
      `Câu hỏi: ${String(question || '').slice(0, 400)}`,
      decision && decision.visualType && decision.visualType !== 'no_visual'
        ? `Gợi ý loại hình từ bộ phân loại: ${decision.visualType}.`
        : ''
    ].filter(Boolean).join('\n');

    try {
      const res = await callFn({
        system: JUDGE_SYSTEM,
        messages: [{ role: 'user', content: userLine }],
        maxTokens: JUDGE_MAX_TOKENS,
        // KHÔNG deepThinking: đây là phân loại nhị phân. Bật reasoning ở đây là đốt token vô ích.
        fast: true,
        timeoutMs: JUDGE_TIMEOUT_MS,
        requestId,
        signal
      });
      const verdict = parseJudgeVerdict(res && res.text);
      if (logger) logger.log({ stage: 'visual_judge', useful: verdict ? verdict.useful : null, confidence: verdict ? verdict.confidence : null });
      return verdict;
    } catch (e) {
      // Tầng 3 lỗi KHÔNG BAO GIỜ ảnh hưởng tới câu trả lời — chỉ đơn giản là mất phần tinh chỉnh.
      if (logger) logger.log({ stage: 'visual_judge', error: e && e.message });
      return null;
    }
  };
}

module.exports = { createVisualJudge, parseJudgeVerdict, JUDGE_SYSTEM, JUDGE_TIMEOUT_MS, JUDGE_MAX_TOKENS };
