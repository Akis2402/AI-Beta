'use strict';

// ---------- Mục 3/3A/3B/3C/3D: TỰ KIỂM TRA + BÀI TƯƠNG TỰ — KHÔNG CHẠY FULL SOLVER ----------
// File này thay thế hoàn toàn việc "self-check"/"similar" đi qua buildChatSystemPrompt + pipeline
// /api/chat (candidate/reconcile/completeness/continuation/adaptive-budget-của-detail). 2 chiến
// lược riêng, nhỏ gọn, KHÔNG đụng gì tới aiProviders ngoài 1 lệnh gọi callWithFailover() đơn giản
// (không webSearch, không deepThinking, không crossCheck — mục 3D).

// ---------- Tầng 1 (mục 3A): deterministic/local — không gọi AI nếu có thể kết luận chắc chắn ----------
function normalizeAnswerString(s) {
  return String(s || '')
    .replace(/\$/g, '')
    .replace(/\\left|\\right/g, '')
    .replace(/\s+/g, '')
    .replace(/[.,;:]+$/g, '')
    .toLowerCase()
    .replace(/^=+/, '');
}

// Trích đáp số cuối cùng từ 1 lời giải: ưu tiên nội dung in đậm **...** cuối cùng (đúng format
// buildChatSystemPrompt yêu cầu ở mục "Kết luận"), fallback dòng có "đáp số"/"kết luận"/"answer".
function extractFinalAnswer(text) {
  if (!text) return null;
  const boldMatches = [...String(text).matchAll(/\*\*([^*]{1,200})\*\*/g)];
  if (boldMatches.length) return boldMatches[boldMatches.length - 1][1].trim();
  const lineMatch = String(text).match(/(đáp số|kết luận|answer|final answer)\s*[:：]?\s*(.+)/i);
  if (lineMatch) return lineMatch[2].trim();
  return null;
}

/**
 * Cố gắng kết luận CHẮC CHẮN bằng so sánh chuỗi/số học đơn giản, không cần AI.
 * @returns {null|{status:'correct'|'major_error', score:number, note:string}} null = không đủ chắc chắn, phải qua Tầng 2.
 */
function deterministicSelfCheck({ referenceSolution, studentAttempt }) {
  const refAnswer = extractFinalAnswer(referenceSolution);
  if (!refAnswer) return null; // không trích được đáp án chuẩn -> không thể so deterministic

  const attemptTrim = String(studentAttempt || '').trim();
  // Chỉ áp dụng deterministic khi bài làm CHỈ LÀ 1 đáp số ngắn gọn (không phải cả 1 lời giải có lập
  // luận) — nếu học sinh viết cả quá trình, việc "đúng lập luận hay không" không thể suy ra từ so
  // sánh chuỗi, PHẢI qua Tầng 2 (mục 3A: "Không gọi AI nếu có thể kết luận chắc chắn", ngược lại vẫn
  // phải gọi AI khi cần đánh giá lập luận).
  if (attemptTrim.length > 60 || /\n/.test(attemptTrim)) return null;

  const normRef = normalizeAnswerString(refAnswer);
  const normAttempt = normalizeAnswerString(attemptTrim);
  if (!normRef || !normAttempt) return null;

  if (normRef === normAttempt) {
    return { status: 'correct', score: 100, note: 'Đáp số khớp với đáp án chuẩn.' };
  }

  // Thử so sánh dạng SỐ (cho phép sai khác định dạng: "1/2" vs "0.5", khoảng trắng...) trước khi kết
  // luận sai hẳn — chỉ kết luận SAI deterministic khi cả 2 bên đều parse được thành số hữu hạn và
  // khác nhau rõ ràng; nếu không parse được số, để Tầng 2 xử lý (tránh false negative với biểu thức).
  const numRef = Number(normRef.replace(',', '.'));
  const numAttempt = Number(normAttempt.replace(',', '.'));
  if (Number.isFinite(numRef) && Number.isFinite(numAttempt)) {
    if (Math.abs(numRef - numAttempt) < 1e-9) {
      return { status: 'correct', score: 100, note: 'Đáp số khớp với đáp án chuẩn (đã quy đổi định dạng số).' };
    }
    return { status: 'major_error', score: 0, note: `Đáp số chưa đúng. Đáp án đúng: ${refAnswer}.` };
  }
  return null; // biểu thức không phải số đơn thuần (căn, phân số dạng chữ...) -> để AI (Tầng 2) đánh giá
}

// ---------- Mục 3B: solution fingerprint — không gửi mù toàn bộ referenceSolution ----------
// Nếu solution đã dài, nén xuống {answer, method, criticalSteps} thay vì gửi nguyên văn — Tầng 2 chỉ
// cần đủ để CHẤM, không cần đọc lại toàn bộ lập luận gốc.
const FINGERPRINT_INLINE_MAX = 500; // solution ngắn hơn ngưỡng này thì gửi thẳng, không cần nén thêm

function buildSolutionFingerprint(referenceSolution) {
  const text = String(referenceSolution || '').trim();
  if (!text) return { answer: null, raw: '' };
  if (text.length <= FINGERPRINT_INLINE_MAX) return { answer: extractFinalAnswer(text), raw: text };

  const answer = extractFinalAnswer(text);
  // criticalSteps: giữ lại các dòng "Bước n" / gạch đầu dòng công thức — bỏ phần diễn giải dài dòng.
  const stepLines = text
    .split('\n')
    .filter((l) => /^\s*(bước\s*\d+|step\s*\d+|[-*])/i.test(l))
    .map((l) => l.trim().slice(0, 160))
    .slice(0, 8);
  return { answer, criticalSteps: stepLines, raw: '' };
}

// ---------- Tầng 2 (mục 3A): targeted AI verification — KHÔNG giải lại toàn bộ bài ----------
function buildSelfCheckPrompt({ problem, referenceSolution, studentAttempt, language }) {
  const fp = buildSolutionFingerprint(referenceSolution);
  const refBlock = fp.raw
    ? `Lời giải đúng (chỉ để chấm, không chép lại nguyên văn):\n${fp.raw}`
    : `Thông tin đáp án chuẩn (đã rút gọn, chỉ để chấm — KHÔNG phải toàn bộ lời giải gốc):\n- Đáp số: ${fp.answer || '(không xác định được, tự đánh giá theo đề)'}\n${(fp.criticalSteps || []).length ? '- Các bước/chốt quan trọng:\n' + fp.criticalSteps.map((s) => '  ' + s).join('\n') : ''}`;

  const langLine = language === 'English'
    ? 'Trả lời (mọi giá trị chuỗi trong JSON) bằng TIẾNG ANH.'
    : 'Trả lời (mọi giá trị chuỗi trong JSON) bằng TIẾNG VIỆT.';

  const system = `Bạn là một gia sư chấm bài NGẮN GỌN. Nhiệm vụ DUY NHẤT: so sánh bài làm của học sinh với đáp án chuẩn, đánh giá lập luận, KHÔNG giải lại toàn bộ bài trừ khi học sinh sai từ đầu.
${langLine}
CHỈ trả lời đúng 1 JSON hợp lệ, không thêm chữ nào khác, đúng schema:
{"status":"correct|minor_error|major_error|incomplete","score":0,"errors":[{"step":"...","issue":"...","correction":"..."}],"hint":"..."}
QUY TẮC:
1. Nếu bài làm ĐÚNG hoàn toàn: "errors" để mảng rỗng, "hint" là 1 câu khen ngắn, KHÔNG viết lại lời giải.
2. Nếu sai 1-2 bước: chỉ nêu ĐÚNG bước sai trong "errors" (mỗi lỗi 1 object ngắn gọn), KHÔNG viết lại toàn bộ bài.
3. Chỉ khi học sinh sai TỪ ĐẦU hoặc bỏ trống mới được đưa hướng sửa ngắn trong "hint" (không quá 3 câu, không phải lời giải đầy đủ).
4. "score" là số nguyên 0-100 phản ánh mức đúng.`;

  const user = `Đề bài:\n${problem}\n\n${refBlock}\n\nBài làm của học sinh:\n${studentAttempt}`;
  return { system, user };
}

function buildSimilarPrompt({ problem, solutionMetadata, difficulty, language }) {
  const diffLabel = { easier: 'DỄ HƠN một chút', same: 'ĐỘ KHÓ TƯƠNG ĐƯƠNG', harder: 'KHÓ HƠN một chút' }[difficulty] || 'ĐỘ KHÓ TƯƠNG ĐƯƠNG';
  const langLine = language === 'English'
    ? 'Trả lời (mọi giá trị chuỗi trong JSON) bằng TIẾNG ANH.'
    : 'Trả lời (mọi giá trị chuỗi trong JSON) bằng TIẾNG VIỆT.';
  const system = `Bạn CHỈ tạo ra ĐÚNG 1 bài tập tương tự — TUYỆT ĐỐI KHÔNG giải bài đó (không lập luận từng bước).
${langLine}
CHỈ trả lời đúng 1 JSON hợp lệ, không thêm chữ nào khác, đúng schema:
{"problem":"đề bài tương tự đầy đủ","given":"tóm tắt dữ kiện đã cho, ngắn gọn","question":"yêu cầu cần tìm, ngắn gọn","difficulty":"easier|same|harder","answer":"CHỈ đáp số cuối cùng, không kèm lời giải"}
QUY TẮC:
1. Cùng DẠNG BÀI, cùng kiến thức/phương pháp với đề gốc, chỉ đổi số liệu/dữ kiện/ngữ cảnh — không đổi sang dạng bài khác.
2. Độ khó: ${diffLabel} so với đề gốc.
3. "answer" CHỈ là đáp số, KHÔNG được trình bày các bước giải.`;
  const metaLine = solutionMetadata ? `\n\nGợi ý về phương pháp/đáp số của bài gốc (chỉ để bám đúng dạng, không lặp lại nguyên văn):\n${solutionMetadata}` : '';
  const user = `Đề bài gốc:\n${problem}${metaLine}`;
  return { system, user };
}

// ---------- Mục 3C: similarity generator DETERMINISTIC cho các dạng bài đơn giản ----------
// Nhận diện "ax + b = c" (phương trình bậc nhất 1 ẩn) bằng regex — dạng phổ biến nhất không cần AI.
// Không nhận diện được thì trả về null để caller fallback sang gọi AI (buildSimilarPrompt ở trên).
function tryDeterministicSimilarLinearEquation(problem) {
  const text = String(problem || '');
  const m = text.match(/(-?\d+(?:[.,]\d+)?)\s*x\s*([+-]\s*\d+(?:[.,]\d+)?)\s*=\s*(-?\d+(?:[.,]\d+)?)/i);
  if (!m) return null;
  const a = parseFloat(m[1].replace(',', '.'));
  const b = parseFloat(m[2].replace(/\s+/g, '').replace(',', '.'));
  const c = parseFloat(m[3].replace(',', '.'));
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c) || a === 0) return null;

  // Sinh số liệu MỚI (khác đề gốc) nhưng giữ nghiệm là số "đẹp" để bài vẫn hợp lý.
  const newA = a === 1 ? 1 : (Math.abs(a) > 1 ? a + (a > 0 ? 1 : -1) : a);
  const newX = Math.round((Math.random() * 10 - 5)) || 3; // nghiệm mục tiêu, tránh 0
  let newB = Math.round((Math.random() * 8 - 4));
  if (newB === 0) newB = 2; // tránh sinh ra "+ 0" xấu trong đề hiển thị
  const newC = newA * newX + newB;
  const bStr = newB >= 0 ? `+ ${newB}` : `- ${Math.abs(newB)}`;
  const newProblem = `${newA}x ${bStr} = ${newC}`;
  return {
    problem: newProblem,
    given: `Phương trình bậc nhất một ẩn: ${newProblem}`,
    question: 'Giải phương trình, tìm x.',
    difficulty: 'same',
    answer: `x = ${newX}`,
    generatedBy: 'deterministic-template'
  };
}

module.exports = {
  normalizeAnswerString,
  extractFinalAnswer,
  deterministicSelfCheck,
  buildSolutionFingerprint,
  buildSelfCheckPrompt,
  buildSimilarPrompt,
  tryDeterministicSimilarLinearEquation
};
