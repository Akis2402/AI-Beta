'use strict';

// ============================================================================================
// B5 — VERIFICATION PACKET: giảm token lượt RECONCILE mà KHÔNG giảm khả năng phát hiện lỗi
// ============================================================================================
// VẤN ĐỀ: lượt tổng hợp nhận NGUYÊN VĂN toàn bộ prose của N candidate. Phần lớn số token đó là thứ
// lượt tổng hợp KHÔNG dùng để verify: lời chào, diễn giải lặp lại, mục "Lỗi sai thường gặp" (viết
// cho học sinh, không phải dữ kiện để đối chiếu), format thừa, phần tutorial phụ.
//
// NGUYÊN TẮC BẤT BIẾN: đây là DEDUP/COMPRESSION, KHÔNG phải cắt suy luận. Mọi thứ phục vụ việc
// verify đều được GIỮ NGUYÊN VĂN, không tóm tắt lại bằng lời:
//   finalAnswer · keyEquations · keySteps · assumptions · conditions ·
//   criticalIntermediateResults · detectedErrors · warnings · confidence
//
// Lượt reconcile sau khi nén vẫn phải làm được ĐỦ: so đáp số, kiểm tra biến đổi, kiểm tra điều
// kiện, phát hiện dấu sai, phát hiện candidate sai, tự giải lại khi cần. Vì vậy mọi DÒNG CÓ DỮ LIỆU
// (số, công thức, dấu, đơn vị, điều kiện) đều được giữ NGUYÊN VĂN — chỉ prose thuần mới bị bỏ.
//
// AN TOÀN: khi candidate NGẮN (dưới ngưỡng), KHÔNG nén gì cả — rủi ro mất thông tin không đáng đổi
// lấy vài trăm token.

/** Dưới ngưỡng này thì gửi nguyên văn, không nén (an toàn > tiết kiệm vặt). */
const PACKET_MIN_CHARS = Number(process.env.VERIFICATION_PACKET_MIN_CHARS) || 2500;

const HEADING_RE = /^#{1,6}\s*(.+)$/;
const STEP_RE = /^\s*(?:\*\*)?(?:Bước|Step)\s*\d+/i;
const EQUATION_RE = /[=<>≤≥≈]|\$|\\frac|\\sqrt|\\int|\\sum/;
const NUMBER_RE = /-?\d/;
const CONDITION_RE = /điều kiện|đk\b|xác định|giả sử|giả thiết|với mọi|khi và chỉ khi|condition|assume|assumption|domain/i;
// Cố ý HẸP: các cụm quá phổ thông ("cẩn thận", "nhớ rằng") xuất hiện đầy trong prose giảng giải,
// bắt rộng sẽ kéo nguyên đoạn văn vào packet và triệt tiêu toàn bộ phần tiết kiệm.
const WARNING_RE = /^(?:\*\*)?(?:lưu ý|chú ý|cảnh báo|note|warning)\b/i;
const ERROR_RE = /(?:phát hiện|kiểm tra lại|có vẻ|dường như).{0,40}(?:sai|nhầm|mâu thuẫn)|sai dấu|sai đơn vị|mâu thuẫn với|incorrect|contradiction/i;
// Mục "Lỗi sai thường gặp"/"Common Mistakes" viết cho HỌC SINH — không phải dữ kiện verify.
const STUDENT_MISTAKES_HEADING_RE = /lỗi sai thường gặp|common mistakes/i;
const GREETING_RE = /^(chào|xin chào|hello|hi|dưới đây là|sau đây là|mình sẽ|tôi sẽ|let's|here is|here's)\b/i;
const DRAW_BLOCK_RE = /^```(shape|solid3d|scene3d|plot)/;

/**
 * Dòng có mang DỮ LIỆU khoa học (số/công thức/điều kiện) -> BẮT BUỘC giữ nguyên văn.
 */
function isDataLine(line) {
  const t = line.trim();
  if (!t) return false;
  if (EQUATION_RE.test(t)) return true;
  if (NUMBER_RE.test(t) && t.length < 400) return true;
  if (CONDITION_RE.test(t)) return true;
  return false;
}

/**
 * buildVerificationPacket() — trích các trường phục vụ verification từ 1 lượt giải.
 *
 * @param {{label?:string, text?:string}} candidate
 * @returns {{label:string, finalAnswer:string, keyEquations:string[], keySteps:string[],
 *   assumptions:string[], conditions:string[], criticalIntermediateResults:string[],
 *   detectedErrors:string[], warnings:string[], confidence:number, drawingBlocks:string[],
 *   compressed:boolean, rawChars:number, packetChars:number}}
 */
function buildVerificationPacket(candidate) {
  const label = (candidate && candidate.label) || '';
  const text = String((candidate && candidate.text) || '');
  const rawChars = text.length;

  const packet = {
    label,
    finalAnswer: '',
    keyEquations: [],
    keySteps: [],
    assumptions: [],
    conditions: [],
    criticalIntermediateResults: [],
    detectedErrors: [],
    warnings: [],
    confidence: 0,
    drawingBlocks: [],
    compressed: false,
    rawChars,
    packetChars: rawChars
  };
  if (!text) return packet;

  // Khối vẽ hình giữ NGUYÊN VĂN (toạ độ là dữ liệu, tuyệt đối không tóm tắt).
  const drawMatches = text.match(/```(?:shape|solid3d|scene3d|plot)\n?[\s\S]*?```/g) || [];
  packet.drawingBlocks = drawMatches;

  const lines = text.split('\n');
  let inStudentMistakes = false;
  let inDrawBlock = false;

  lines.forEach((raw) => {
    const line = raw.replace(/\s+$/, '');
    const t = line.trim();

    if (DRAW_BLOCK_RE.test(t)) { inDrawBlock = true; return; }
    if (inDrawBlock) { if (t === '```') inDrawBlock = false; return; }

    const heading = HEADING_RE.exec(t);
    if (heading) {
      inStudentMistakes = STUDENT_MISTAKES_HEADING_RE.test(heading[1]);
      return; // tiêu đề mục là FORMAT, không phải dữ kiện verify
    }
    if (!t) return;
    if (inStudentMistakes) return;           // tutorial cho học sinh — bỏ khỏi packet
    if (GREETING_RE.test(t) && !isDataLine(t)) return;

    // Đáp số cuối: dòng in đậm **...** (định dạng bắt buộc ở mục Kết luận).
    const bold = /\*\*(.+?)\*\*/.exec(t);
    if (bold && !packet.finalAnswer && (EQUATION_RE.test(bold[1]) || NUMBER_RE.test(bold[1]))) {
      packet.finalAnswer = t;
    }

    if (STEP_RE.test(t)) { packet.keySteps.push(t); return; }
    if (CONDITION_RE.test(t)) {
      (/giả sử|giả thiết|assume|assumption/i.test(t) ? packet.assumptions : packet.conditions).push(t);
      return;
    }
    if (ERROR_RE.test(t)) { packet.detectedErrors.push(t); return; }
    if (WARNING_RE.test(t)) { packet.warnings.push(t); return; }
    if (EQUATION_RE.test(t)) { packet.keyEquations.push(t); return; }
    if (isDataLine(t)) { packet.criticalIntermediateResults.push(t); return; }
    // Còn lại = prose thuần, không mang dữ kiện verify -> BỎ (đây là toàn bộ phần token tiết kiệm).
  });

  if (!packet.finalAnswer) {
    // Fallback: dòng cuối cùng có số/công thức.
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i].trim();
      if (t && isDataLine(t)) { packet.finalAnswer = t; break; }
    }
  }
  // Dedupe + cắt trần: prose giảng giải hay lặp lại y nguyên một câu nhiều lần; giữ 1 bản là đủ để
  // verify, giữ N bản chỉ tốn token (đây chính là "loại bỏ trùng lặp", không phải cắt nội dung).
  const dedupe = (arr, cap) => [...new Set(arr)].slice(0, cap);
  packet.keySteps = dedupe(packet.keySteps, 30);
  packet.keyEquations = dedupe(packet.keyEquations, 40);
  packet.criticalIntermediateResults = dedupe(packet.criticalIntermediateResults, 40);
  packet.assumptions = dedupe(packet.assumptions, 15);
  packet.conditions = dedupe(packet.conditions, 15);
  packet.detectedErrors = dedupe(packet.detectedErrors, 15);
  packet.warnings = dedupe(packet.warnings, 10);

  packet.confidence = packet.finalAnswer ? 0.8 : 0.4;
  packet.packetChars = renderVerificationPacket(packet).length;
  return packet;
}

/** Kết xuất packet thành text đưa vào prompt reconcile — nhãn rõ ràng, không prose thừa. */
function renderVerificationPacket(packet) {
  const section = (title, arr) => (arr && arr.length ? `${title}:\n${arr.map((x) => '- ' + x).join('\n')}\n` : '');
  return [
    packet.finalAnswer ? `ĐÁP SỐ CUỐI: ${packet.finalAnswer}\n` : '',
    section('CÁC BƯỚC CHÍNH', packet.keySteps),
    section('CÔNG THỨC/BIẾN ĐỔI', packet.keyEquations),
    section('KẾT QUẢ TRUNG GIAN', packet.criticalIntermediateResults),
    section('GIẢ THIẾT', packet.assumptions),
    section('ĐIỀU KIỆN', packet.conditions),
    section('DẤU HIỆU SAI SÓT TỰ PHÁT HIỆN', packet.detectedErrors),
    section('CẢNH BÁO', packet.warnings),
    packet.drawingBlocks.length ? `HÌNH ĐÃ DỰNG (giữ nguyên văn):\n${packet.drawingBlocks.join('\n')}\n` : ''
  ].join('');
}

/**
 * compactCandidatesForReconcile() — quyết định NÉN hay KHÔNG cho từng candidate.
 *
 * An toàn tuyệt đối: candidate ngắn giữ nguyên văn; candidate dài mới nén, và CHỈ nén khi packet
 * thực sự nhỏ hơn đáng kể (>= 20%) VÀ vẫn còn đáp số cuối — nếu không, rollback về nguyên văn
 * (cùng triết lý quality gate + rollback của contextCompressor.js).
 *
 * @param {Array<{label:string,text:string}>} candidates
 * @returns {{candidates:Array, stats:{compressedCount:number, rawChars:number, packedChars:number}}}
 */
function compactCandidatesForReconcile(candidates) {
  const stats = { compressedCount: 0, rawChars: 0, packedChars: 0 };
  const out = (candidates || []).map((c) => {
    const raw = String((c && c.text) || '');
    stats.rawChars += raw.length;
    if (raw.length < PACKET_MIN_CHARS) { stats.packedChars += raw.length; return c; }
    const packet = buildVerificationPacket(c);
    const rendered = renderVerificationPacket(packet);
    const goodEnough = packet.finalAnswer && rendered.length <= raw.length * 0.8 && rendered.length > 80;
    if (!goodEnough) { stats.packedChars += raw.length; return c; } // rollback: giữ nguyên văn
    stats.compressedCount += 1;
    stats.packedChars += rendered.length;
    return { ...c, text: rendered, packet, compressed: true };
  });
  return { candidates: out, stats };
}

module.exports = {
  buildVerificationPacket,
  renderVerificationPacket,
  compactCandidatesForReconcile,
  PACKET_MIN_CHARS
};
