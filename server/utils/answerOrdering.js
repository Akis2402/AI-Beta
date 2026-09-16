'use strict';

// ============================================================================================
// MỤC 3 — ANSWER ORDERING INTEGRITY
// ============================================================================================
// ROOT CAUSE (đã xác nhận bằng đọc code): hệ thống có `createSeamDedupe()` chống LẶP KÝ TỰ ở điểm
// nối và `joinContinuation()` chỉ làm đúng một việc là `a + '\n' + b`. Không có bất kỳ tầng nào
// hiểu "## Kết luận" là gì. Vì vậy khi lượt continuation trả về ĐÚNG nội dung còn thiếu (Bước 4),
// nó bị nối mù quáng vào CUỐI chuỗi — tức là sau phần Kết luận đã được sinh ra ở lượt trước:
//
//     ## Kết luận
//     ...
//     ---
//     Bước 4 (tiếp): ...
//
// Đây không phải lỗi của model: model được yêu cầu "viết tiếp phần còn thiếu" và nó đã làm đúng.
// Lỗi nằm ở chỗ hệ thống giả định "viết tiếp" == "nối vào cuối".
//
// NGUYÊN TẮC THIẾT KẾ:
//   1. HOÀN TOÀN DETERMINISTIC. Không thêm một lệnh gọi AI nào chỉ để sắp xếp lại (mục 3.6).
//   2. DI CHUYỂN NGUYÊN KHỐI. Không bao giờ cắt giữa câu, giữa công thức LaTeX, giữa khối mã hay
//      giữa bảng markdown (mục 3.5).
//   3. CHỈ SỬA KHI CHẮC CHẮN. Nếu không nhận ra cấu trúc, trả lại NGUYÊN VĂN đầu vào. Một câu trả
//      lời đúng bị xáo trộn còn tệ hơn một câu trả lời sai thứ tự (mục 3.10).
//   4. Citation/nguồn/ghi chú nằm sau Kết luận là HỢP LỆ — không đụng tới.

// ---------- Nhận diện heading ----------
// Chấp nhận cả heading markdown (`## Kết luận`), heading in đậm (`**Kết luận**`), và dạng nhãn
// trần đầu dòng (`Bước 4:`) vì model sinh ra cả ba kiểu tuỳ provider.
const STEP_RE = /^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*(?:bước|buoc|step)\s*(\d+)\s*(?:\*\*)?\s*[:.)\u2014-]?/i;
const CONCLUSION_RE = /^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*(?:kết\s*luận|ket\s*luan|conclusion|tổng\s*kết|kết\s*quả\s*cuối|đáp\s*số|dap\s*so|answer\s*:|final\s+answer)\b/i;
const RESULT_RE = /^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*(?:kết\s*quả|ket\s*qua|result)\b/i;
const NOTE_RE = /^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*(?:ghi\s*chú|luu\s*ý|lưu\s*ý|chú\s*ý|nguồn|tài\s*liệu|tham\s*khảo|citation|references?|notes?|source)\b/i;
const HEADING_RE = /^\s*(?:#{1,6}\s+\S|(?:\*\*)[^*]{2,60}(?:\*\*)\s*:?\s*$)/;
const SEPARATOR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

/** Nhãn "(tiếp)"/"(continued)" mà lượt continuation hay tự thêm vào tiêu đề. */
const CONTINUED_SUFFIX_RE = /\s*[（(]\s*(?:tiếp(?:\s*theo)?|continued|cont\.?)\s*[)）]\s*/gi;

/** Chuẩn hoá tiêu đề để so khớp NGỮ NGHĨA (mục 3.11) — bỏ dấu #, **, số thứ tự, "(tiếp)", dấu câu. */
function normalizeHeading(line) {
  return String(line || '')
    .replace(CONTINUED_SUFFIX_RE, ' ')
    .replace(/^[\s#*>-]+/, '')
    .replace(/[*:_`]+/g, '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Phân loại một dòng heading thành vai trò trong cấu trúc lời giải.
 * @returns {{role:'step'|'conclusion'|'result'|'note'|'section', stepNumber:number|null}}
 */
function classifyHeadingLine(line) {
  const stepMatch = STEP_RE.exec(line);
  if (stepMatch) return { role: 'step', stepNumber: Number(stepMatch[1]) };
  if (CONCLUSION_RE.test(line)) return { role: 'conclusion', stepNumber: null };
  if (RESULT_RE.test(line)) return { role: 'result', stepNumber: null };
  if (NOTE_RE.test(line)) return { role: 'note', stepNumber: null };
  return { role: 'section', stepNumber: null };
}

/**
 * Cắt văn bản thành các KHỐI theo heading, đồng thời bảo vệ tuyệt đối vùng không được đụng tới.
 *
 * Vùng bảo vệ (mục 3.5):
 *   - khối mã ``` ... ```
 *   - LaTeX display $$ ... $$  và  \[ ... \]
 *   - bảng markdown (nhiều dòng liên tiếp bắt đầu bằng '|')
 * Mọi dòng nằm trong vùng bảo vệ KHÔNG BAO GIỜ được coi là heading, kể cả khi nó trông giống
 * ("# Bước 1" bên trong một khối mã Python vẫn chỉ là comment).
 *
 * @param {string} text
 * @returns {Array<{role:string, stepNumber:number|null, heading:string|null, headingKey:string, text:string}>}
 */
function splitIntoBlocks(text) {
  const lines = String(text || '').split('\n');
  const blocks = [];
  let current = { role: 'preamble', stepNumber: null, heading: null, headingKey: '', lines: [] };

  let inFence = false;
  let inDisplayMath = false;

  const push = () => {
    if (current.lines.length || current.heading) {
      blocks.push({
        role: current.role,
        stepNumber: current.stepNumber,
        heading: current.heading,
        headingKey: current.headingKey,
        text: current.lines.join('\n')
      });
    }
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) { inFence = !inFence; current.lines.push(line); continue; }
    if (inFence) { current.lines.push(line); continue; }

    // $$ mở/đóng có thể nằm ngay trên dòng riêng; đếm số lần xuất hiện để xử lý cả "$$...$$" 1 dòng.
    const dollarCount = (line.match(/\$\$/g) || []).length;
    if (/^\s*\\\[/.test(line)) inDisplayMath = true;
    if (inDisplayMath) {
      current.lines.push(line);
      // Khối display math đóng bằng `\]` HOẶC bằng `$$` — thiếu vế thứ hai thì mọi thứ sau một dòng
      // `$$` sẽ bị nuốt vào cùng một khối và không heading nào phía sau được nhận ra nữa.
      if (/\\\]/.test(line) || dollarCount % 2 === 1) inDisplayMath = false;
      continue;
    }
    if (dollarCount % 2 === 1) {
      inDisplayMath = !inDisplayMath;
      current.lines.push(line);
      continue;
    }

    const isTableRow = /^\s*\|/.test(line);
    const isHeadingLike = !isTableRow
      && (HEADING_RE.test(line) || STEP_RE.test(line) || CONCLUSION_RE.test(line)
        || RESULT_RE.test(line) || NOTE_RE.test(line));

    if (isHeadingLike) {
      push();
      const info = classifyHeadingLine(line);
      current = {
        role: info.role, stepNumber: info.stepNumber,
        heading: line, headingKey: normalizeHeading(line), lines: [line]
      };
      continue;
    }
    current.lines.push(line);
  }
  push();
  return blocks;
}

/** Gộp lại thành text, gỡ dải phân cách mồ côi do việc di chuyển khối để lại. */
function joinBlocks(blocks) {
  const text = blocks.map((b) => b.text.replace(/\s+$/, '')).filter((t) => t !== '').join('\n\n');
  return text
    .split('\n')
    .filter((l, i, arr) => !(SEPARATOR_RE.test(l) && (i === arr.length - 1 || !arr.slice(i + 1).some((x) => x.trim()))))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * normalizeFinalAnswerOrder() — điểm vào DUY NHẤT.
 *
 * Gọi ĐÚNG MỘT LẦN, sau khi vòng continuation đã dừng hẳn (completeness COMPLETE hoặc hết recovery
 * budget), ngay trước khi trả `text` cho caller. KHÔNG gọi trong lúc đang stream từng delta — làm
 * vậy sẽ phá hiệu ứng gõ chữ.
 *
 * Hai việc được làm, theo đúng thứ tự:
 *   (1) GỠ TRÙNG SECTION theo NGỮ NGHĨA (mục 3.11): lượt continuation sinh lại một heading đã có
 *       (vd "## Bước 2" lần thứ hai) mà seam dedupe không bắt được vì không trùng ký tự đủ dài.
 *       Chỉ gỡ khi khối sau KHÔNG mang thêm nội dung so với khối trước (tránh xoá nhầm phần bổ sung).
 *   (2) ĐƯA KẾT LUẬN VỀ CUỐI (mục 3.4): mọi khối "giải bài" (Bước X / heading giải thích / Kết quả)
 *       nằm SAU khối kết luận đều được chuyển lên TRƯỚC nó, giữ nguyên thứ tự tương đối giữa chúng.
 *       Ghi chú/nguồn/citation nằm sau kết luận thì GIỮ NGUYÊN (mục 3.10).
 *
 * @param {string} text Final answer sau toàn bộ continuation.
 * @returns {{text:string, changed:boolean, moved:number, deduped:number, reason:string}}
 */
function normalizeFinalAnswerOrder(text) {
  const raw = String(text || '');
  const unchanged = (reason) => ({ text: raw, changed: false, moved: 0, deduped: 0, reason });
  if (!raw.trim()) return unchanged('empty');

  let blocks;
  try { blocks = splitIntoBlocks(raw); } catch (e) { return unchanged('split_failed'); }
  if (!blocks.length) return unchanged('no_blocks');

  // ---------- (1) Gỡ section trùng theo ngữ nghĩa ----------
  const seen = new Map(); // headingKey -> index của khối đầu tiên
  const keep = [];
  let deduped = 0;
  blocks.forEach((b) => {
    if (!b.headingKey) { keep.push(b); return; }
    const firstIdx = seen.get(b.headingKey);
    if (firstIdx === undefined) {
      seen.set(b.headingKey, keep.length);
      keep.push(b);
      return;
    }
    const prev = keep[firstIdx];
    const prevBody = prev.text.slice(String(prev.heading || '').length).trim();
    const curBody = b.text.slice(String(b.heading || '').length).trim();
    // Bản sau KHÔNG dài hơn -> là bản lặp, bỏ. Bản sau DÀI HƠN HẲN -> có thể là phần viết tiếp thật
    // của cùng section, giữ lại và GỘP vào khối đầu để không tạo hai heading trùng tên.
    if (curBody.length > prevBody.length + 40) {
      prev.text = `${prev.text.replace(/\s+$/, '')}\n${curBody}`;
      deduped += 1;
    } else {
      deduped += 1;
    }
  });

  // ---------- (2) Đưa kết luận về cuối ----------
  const conclusionIdx = keep.findIndex((b) => b.role === 'conclusion');
  let moved = 0;
  let ordered = keep;
  if (conclusionIdx !== -1 && conclusionIdx < keep.length - 1) {
    const before = keep.slice(0, conclusionIdx);
    const conclusion = keep[conclusionIdx];
    const after = keep.slice(conclusionIdx + 1);
    // Chỉ các khối GIẢI BÀI mới bị kéo lên. 'note'/'preamble' (citation, nguồn, ghi chú) ở lại sau.
    const solutionAfter = after.filter((b) => b.role === 'step' || b.role === 'result'
      || (b.role === 'section' && !!b.heading));
    const trailing = after.filter((b) => !solutionAfter.includes(b));
    if (solutionAfter.length) {
      moved = solutionAfter.length;
      ordered = [...before, ...solutionAfter, conclusion, ...trailing];
    }
  }

  // ---------- (3) Sắp lại các "Bước N" bị lệch số thứ tự ----------
  // Chỉ áp dụng khi MỌI khối step đều có số và tập số không trùng nhau — nếu có bất kỳ dấu hiệu mơ
  // hồ nào thì không đụng (nguyên tắc 3: chỉ sửa khi chắc chắn).
  const stepIdxs = ordered.map((b, i) => (b.role === 'step' ? i : -1)).filter((i) => i !== -1);
  if (stepIdxs.length > 1) {
    const nums = stepIdxs.map((i) => ordered[i].stepNumber);
    const distinct = new Set(nums).size === nums.length;
    const sortedNums = [...nums].sort((a, b) => a - b);
    const isSorted = nums.every((n, k) => n === sortedNums[k]);
    const contiguous = stepIdxs.every((v, k) => k === 0 || v === stepIdxs[k - 1] + 1);
    if (distinct && !isSorted && contiguous) {
      const sortedBlocks = stepIdxs.map((i) => ordered[i]).sort((a, b) => a.stepNumber - b.stepNumber);
      stepIdxs.forEach((i, k) => { ordered[i] = sortedBlocks[k]; });
      moved += 1;
    }
  }

  const out = joinBlocks(ordered);
  const changed = out !== raw.trim();
  if (!changed) return unchanged('already_ordered');
  return { text: out, changed: true, moved, deduped, reason: 'reordered' };
}

/**
 * looksLikeOutOfOrderContinuation() — dùng cho tầng STREAM (mục 3.7).
 *
 * Trong lúc stream ta KHÔNG thể sắp xếp lại (chữ đã hiện trên màn hình rồi). Việc duy nhất làm được
 * là nhận ra SỚM rằng đoạn sắp tới sẽ đặt sai chỗ, để caller quyết định buffer thay vì emit ngay.
 *
 * @param {string} priorText Phần đã phát ra cho người dùng.
 * @param {string} incomingHead Vài trăm ký tự đầu của lượt continuation.
 * @returns {boolean}
 */
function looksLikeOutOfOrderContinuation(priorText, incomingHead) {
  const prior = String(priorText || '');
  const head = String(incomingHead || '');
  if (!prior.trim() || !head.trim()) return false;
  const priorHasConclusion = splitIntoBlocks(prior).some((b) => b.role === 'conclusion');
  if (!priorHasConclusion) return false;
  const firstLine = head.split('\n').find((l) => l.trim()) || '';
  const info = classifyHeadingLine(firstLine);
  // Kết luận đã có mà đoạn tới lại mở một Bước/Kết quả mới -> chắc chắn sai vị trí.
  return info.role === 'step' || info.role === 'result';
}

module.exports = {
  normalizeFinalAnswerOrder,
  looksLikeOutOfOrderContinuation,
  splitIntoBlocks,
  classifyHeadingLine,
  normalizeHeading,
  joinBlocks
};
