'use strict';

// ============================================================================================
// Bộ lọc "nhãn tự phân loại an toàn nội bộ bị lộ ra làm câu trả lời" — DÙNG CHUNG cho mọi nhà
// cung cấp AI, cùng tinh thần với thinkingFilter.js (chặn ở ĐÚNG 1 điểm forward duy nhất).
//
// NGUYÊN NHÂN GỐC (bug "x + 2 = 0" -> "User Safety: unsafe / Safety Categories: Profanity"):
// Một số model "reasoning" nguồn mở phục vụ qua các provider tương thích OpenAI (đặc biệt dòng
// openai/gpt-oss-* chạy qua Groq, hoặc model được OpenRouter tự động định tuyến tới khi dùng
// 'openrouter/auto') có 1 bước TỰ PHÂN LOẠI AN TOÀN nội bộ (kiểu Llama-Guard) SONG SONG với việc
// sinh câu trả lời. Bình thường bước này chỉ là nội bộ, không lộ ra ngoài. Nhưng khi:
//   (a) bước phân loại chạy lỗi/quá nhạy (false positive) với 1 đề bài HOÀN TOÀN vô hại như
//       "x + 2 = 0", và
//   (b) hạ tầng của provider không tách hẳn được channel phân loại này ra khỏi channel nội dung
//       cuối (khác với channel "reasoning/analysis" mà `reasoning_format: 'hidden'`/
//       `reasoning: {exclude:true}` trong extraProviders.js đã xử lý được),
// thì model trả về NGUYÊN VĂN nhãn phân loại (vd "User Safety: unsafe\nSafety Categories:
// Profanity") NHƯ THỂ đó là toàn bộ nội dung `message.content`/`delta.content` — không có gì để
// server phân biệt với 1 câu trả lời thật, nên nó bị hiển thị thẳng cho người dùng như thể AI vừa
// "buộc tội" đề bài của họ là phản cảm.
//
// FIX (2 lớp, áp dụng ĐỒNG NHẤT cho mọi provider qua thinkingFilter.js#stripThinkingTags và
// aiProviders.js#streamWithFailover — xem chú thích ở 2 nơi đó):
//   1) Lọc bỏ các DÒNG khớp đúng khuôn nhãn phân loại đã biết (không đụng tới phần còn lại của
//      câu trả lời nếu model lỡ in kèm nhãn này ở cuối 1 câu trả lời thật).
//   2) Nếu sau khi lọc, TOÀN BỘ nội dung chỉ còn rỗng (tức bản thân response CHỈ LÀ nhãn phân loại,
//      không có câu trả lời thật nào) — coi đây là "response rỗng"/lỗi provider để kích hoạt
//      FAILOVER sang provider khác (cơ chế failover đã có sẵn trong aiProviders.js), thay vì lặng
//      lẽ hiển thị 1 kết quả trống hoặc (tệ hơn) hiển thị nhãn "unsafe" cho người dùng.
// ============================================================================================

// "User Safety: unsafe", "Response Safety: safe", "Prompt Safety: unsafe", có thể kèm markdown
// đậm (**User Safety:** unsafe) hoặc gạch đầu dòng.
const LABEL_LINE_RE =
  /^\s*(?:[-*]\s*)?\**\s*(user|response|prompt|assistant|model)\s+safety\s*\**\s*:\s*\**\s*(safe|unsafe)\s*\**\s*$/i;

// "Safety Categories: Profanity", "Harm Category: Violence", có thể liệt kê nhiều nhãn.
const CATEGORY_LINE_RE = /^\s*(?:[-*]\s*)?\**\s*(safety|harm)\s+categor(?:y|ies)\s*\**\s*:\s*.+$/i;

// Khuôn mã hạng mục kiểu Llama Guard thô (S1..S13, có thể liệt kê nhiều mã cách nhau bằng dấu phẩy).
const GUARD_CODE_LINE_RE = /^\s*S(?:[1-9]|1[0-3])(?:\s*,\s*S(?:[1-9]|1[0-3]))*\s*$/;

function isLeakedSafetyLine(line) {
  const t = String(line || '').trim();
  if (!t) return false;
  return LABEL_LINE_RE.test(t) || CATEGORY_LINE_RE.test(t) || GUARD_CODE_LINE_RE.test(t);
}

/** Bản KHÔNG streaming: loại bỏ mọi dòng khớp khuôn nhãn phân loại an toàn đã biết, giữ nguyên
 * các dòng còn lại (kể cả khi nhãn chỉ lộ ra ở cuối 1 câu trả lời thật). */
function stripLeakedSafetyLabels(text) {
  const raw = String(text || '');
  if (!raw) return '';
  const kept = raw.split('\n').filter((line) => !isLeakedSafetyLine(line));
  return kept.join('\n').trim();
}

/** true nếu response GỐC có chứa ít nhất 1 dòng nhãn phân loại VÀ sau khi lọc không còn lại nội
 * dung thật nào — tức toàn bộ response chỉ là nhãn phân loại bị lộ, không phải câu trả lời. Dùng
 * để phân biệt "provider từ chối/lỗi thật" (cần failover) với "model lỡ in thêm nhãn cuối 1 câu
 * trả lời hợp lệ" (chỉ cần lọc dòng, không cần failover). */
function isOnlyLeakedSafetyLabels(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  const hadLabel = raw.split('\n').some((line) => isLeakedSafetyLine(line));
  return hadLabel && !stripLeakedSafetyLabels(raw);
}

/**
 * Bản STREAMING: trả về { feed(piece), flush() } — giữ lại đúng 1 dòng CHƯA hoàn chỉnh (chưa gặp
 * '\n') trong buffer chờ chunk kế tiếp, mỗi khi có 1 dòng hoàn chỉnh thì kiểm tra khuôn nhãn phân
 * loại rồi mới quyết định forward qua onVisible hay âm thầm loại bỏ — độ trễ thêm tối đa ~1 dòng,
 * không ảnh hưởng cảm giác "gõ chữ" trực tiếp của UI.
 */
function createSafetyLineFilter(onVisible) {
  let buf = '';

  function flushCompleteLines() {
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx + 1); // giữ ký tự '\n' để không phá định dạng đoạn văn
      buf = buf.slice(idx + 1);
      if (!isLeakedSafetyLine(line)) onVisible(line);
    }
  }

  return {
    feed(piece) {
      buf += piece;
      flushCompleteLines();
    },
    flush() {
      if (buf) {
        if (!isLeakedSafetyLine(buf)) onVisible(buf);
        buf = '';
      }
    }
  };
}

module.exports = { stripLeakedSafetyLabels, isOnlyLeakedSafetyLabels, createSafetyLineFilter };
