'use strict';
/* ================= server/utils/visionExtract.js =================
 * Hàm THUẦN (không I/O, không phụ thuộc express) dùng chung bởi server/routes/sourceVision.js
 * (PHẦN A6/A11) — tách riêng để unit-test được mà không cần dựng Express server/gọi AI thật.
 */

const VISION_EXTRACT_SYSTEM = [
  'Bạn là công cụ TRÍCH XUẤT NỘI DUNG từ 1 trang tài liệu dạng ảnh (scan/chụp) — KHÔNG giải bài,',
  'KHÔNG bình luận, CHỈ mô tả lại đúng những gì thấy trên trang.',
  '',
  'Trả về ĐÚNG 1 khối JSON hợp lệ (không kèm text nào khác, không dùng markdown code fence), có dạng:',
  '{"extractedText":"...", "equations":["..."], "diagrams":["..."], "confidence":0.0}',
  '',
  '- extractedText: chép lại TOÀN BỘ chữ/số đọc được trên trang, giữ đúng thứ tự đọc tự nhiên',
  '  (đề bài, số thứ tự bài, ghi chú lề...). Nếu trang trống hoặc không đọc được, để chuỗi rỗng.',
  '- equations: liệt kê các công thức/phương trình toán học xuất hiện trên trang (dạng LaTeX nếu có',
  '  thể, hoặc mô tả ký hiệu gần đúng nhất).',
  '- diagrams: mô tả NGẮN GỌN từng hình vẽ/biểu đồ/sơ đồ trên trang (vd "hình tam giác ABC vuông tại',
  '  A, có đường cao AH"). Mảng rỗng nếu trang không có hình.',
  '- confidence: số từ 0 đến 1, ước lượng mức tin cậy của chính bạn về độ đầy đủ/chính xác của',
  '  extractedText (vd ảnh mờ/nghiêng/chữ viết tay khó đọc → confidence thấp).',
  '',
  'TUYỆT ĐỐI KHÔNG bịa thêm nội dung không có trên trang. Nếu không chắc 1 đoạn, vẫn chép lại nhưng',
  'hạ confidence xuống thấp thay vì bỏ qua.'
].join('\n');

/** Parse JSON trả về từ model vision — chịu được model lỡ bọc ```json ... ``` dù đã dặn không dùng.
 * Trả về null nếu KHÔNG parse được / không đúng shape — caller (route) phải coi đó là trang lỗi
 * (ok:false), KHÔNG được giả vờ đã trích xuất thành công (mục A10). */
function parseVisionJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      extractedText: typeof parsed.extractedText === 'string' ? parsed.extractedText : '',
      equations: Array.isArray(parsed.equations) ? parsed.equations.filter((x) => typeof x === 'string').slice(0, 60) : [],
      diagrams: Array.isArray(parsed.diagrams) ? parsed.diagrams.filter((x) => typeof x === 'string').slice(0, 30) : [],
      confidence: Number.isFinite(Number(parsed.confidence)) ? Math.max(0, Math.min(1, Number(parsed.confidence))) : 0.5
    };
  } catch (e) {
    return null;
  }
}

module.exports = { VISION_EXTRACT_SYSTEM, parseVisionJson };
