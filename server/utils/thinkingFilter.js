'use strict';

// ============================================================================================
// Bộ lọc "ẩn nháp suy luận nội bộ khỏi người dùng" — DÙNG CHUNG cho mọi nhà cung cấp AI.
//
// NGUYÊN NHÂN GỐC của lỗi "khung Hướng giải / chế độ Suy nghĩ sâu hiện ra nháp suy luận thô thay
// vì câu trả lời" (vd "Here's a thinking process...", "User Safety: safe/Response Safety: safe"):
// promptBuilder.js#buildDeepThinkingBlock() yêu cầu model viết nháp suy luận trong khối
// <thinking>...</thinking> trước khi chốt câu trả lời chính thức khi "Suy nghĩ sâu" bật — khối
// này CHỈ là nháp nội bộ, KHÔNG PHẢI câu trả lời, không được hiển thị cho người dùng. Nhưng trước
// đây MỌI nơi forward văn bản ra ngoài (streamWithFailover/callWithFailover/callFastest trong
// aiProviders.js) đều chuyển thẳng RAW text nhận được từ provider ra sự kiện SSE "delta"/JSON
// response NGAY LẬP TỨC, không hề lọc khối <thinking> ra — kể cả ở lượt STREAM cuối cùng mà người
// dùng trực tiếp đọc. Kết quả: khi model tuân thủ đúng và mở thẻ <thinking>, hoặc khi một model
// nguồn mở tự ý dùng quy ước thẻ suy luận quen thuộc của riêng nó (vd <think>...</think> — không
// có "ing", quy ước phổ biến ở các model "reasoning" như DeepSeek-R1/QwQ...) dù system prompt
// không yêu cầu, toàn bộ nháp đó bị stream sống ra màn hình người dùng y hệt câu trả lời thật.
//
// FIX: chặn ở ĐÚNG 1 điểm forward duy nhất — bên trong aiProviders.js (streamWithFailover cho
// luồng stream + callWithFailover/callFastest/gatherCrossCheckCandidates cho luồng JSON thường)
// — nên áp dụng ĐỒNG NHẤT cho MỌI provider (Claude/GPT/Gemini/Grok/DeepSeek/Mistral/Groq/
// OpenRouter...), không cần sửa riêng từng file client.
//
// LƯU Ý: đây là lớp phòng vệ cho khối <thinking>/<think> có THẺ RÕ RÀNG. Với các model "reasoning"
// tự sinh nháp suy luận dạng VĂN XUÔI THUẦN, không hề bọc trong bất kỳ thẻ nào (vd gpt-oss của
// Groq khi không cấu hình `reasoning_format`) — filter dạng thẻ này KHÔNG bắt được, vì không có
// gì để nhận diện là "khối cần ẩn" giữa dòng văn xuôi bình thường. Trường hợp đó phải chặn ở TẦNG
// THAM SỐ GỌI API (yêu cầu provider tự tách/ẩn phần suy luận trước khi trả về) — xem
// server/config/extraProviders.js (trường `extraBody`, vd `reasoning_format: 'hidden'` cho Groq)
// và server/utils/openaiCompatibleClient.js.
//
// LỚP PHÒNG VỆ THỨ 2 — NHÃN PHÂN LOẠI AN TOÀN NỘI BỘ BỊ LỘ (bug "x + 2 = 0" -> hiện ra "User
// Safety: unsafe / Safety Categories: Profanity" thay vì lời giải): xem chi tiết nguyên nhân gốc +
// cách fix ở đầu server/utils/safetyLeakFilter.js. stripThinkingTags() dưới đây gọi CHUNG cả 2 lớp
// lọc (thẻ <thinking>/<think> VÀ nhãn phân loại an toàn) vì mọi nơi forward text ra ngoài trong
// aiProviders.js đều đã đi qua đúng 1 hàm này — thêm lớp lọc thứ 2 tại đây tự động áp dụng cho toàn
// bộ provider mà không cần sửa thêm chỗ nào khác.
// ============================================================================================

const { stripLeakedSafetyLabels } = require('./safetyLeakFilter');

const OPEN_TAGS = ['<thinking>', '<think>'];
const CLOSE_TAGS = { '<thinking>': '</thinking>', '<think>': '</think>' };
const MAX_OPEN_TAG_LEN = Math.max(...OPEN_TAGS.map((t) => t.length)); // 10 ký tự ("<thinking>")

/** Bản KHÔNG streaming: dùng cho text đã có đầy đủ (kết quả call() JSON thường, hoặc full text
 * sau khi 1 lượt stream đã kết thúc) — loại bỏ mọi khối <thinking>/<think> hoàn chỉnh còn sót,
 * RỒI loại bỏ mọi dòng nhãn phân loại an toàn nội bộ bị lộ (xem safetyLeakFilter.js). */
function stripThinkingTags(text) {
  const withoutThinking = String(text || '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '');
  return stripLeakedSafetyLabels(withoutThinking);
}

/**
 * Bản STREAMING: trả về { feed(piece), flush() } — feed() gọi mỗi khi nhận 1 đoạn delta thô từ
 * provider, tự quyết định phần nào AN TOÀN để forward ra ngoài qua onVisible (phần NẰM NGOÀI khối
 * thinking), giữ lại phần còn nghi ngờ (có thể là 1 thẻ bị cắt ngang giữa 2 chunk mạng) chờ chunk
 * kế tiếp mới quyết định tiếp — tuyệt đối KHÔNG forward nhầm 1 phần thẻ ra ngoài do xử lý vội.
 * Gọi flush() khi provider báo đã stream xong để đẩy nốt phần văn bản thường còn treo lại trong
 * buffer (chỉ trùng 1 phần đầu thẻ mở nhưng chưa bao giờ đủ thành thẻ thật).
 */
function createStreamingThinkingFilter(onVisible) {
  let buf = '';
  let inThinking = false;
  let closeTag = null;

  function findEarliestOpenTag(s) {
    const lower = s.toLowerCase();
    let best = null;
    for (const tag of OPEN_TAGS) {
      const idx = lower.indexOf(tag);
      if (idx !== -1 && (best === null || idx < best.idx)) best = { idx, tag };
    }
    return best;
  }

  function process() {
    for (;;) {
      if (!inThinking) {
        const found = findEarliestOpenTag(buf);
        if (!found) {
          // Không thấy thẻ mở nào — giữ lại phần đuôi CÓ THỂ là 1 thẻ mở bị cắt ngang giữa chunk,
          // phát ra phần còn lại (chắc chắn là văn bản thường).
          const keep = Math.min(buf.length, MAX_OPEN_TAG_LEN - 1);
          const safe = buf.slice(0, buf.length - keep);
          if (safe) onVisible(safe);
          buf = buf.slice(buf.length - keep);
          return;
        }
        if (found.idx > 0) onVisible(buf.slice(0, found.idx));
        buf = buf.slice(found.idx + found.tag.length);
        inThinking = true;
        closeTag = CLOSE_TAGS[found.tag];
        continue;
      }
      const closeIdx = buf.toLowerCase().indexOf(closeTag);
      if (closeIdx === -1) {
        // Vẫn đang trong khối thinking — không có gì để hiện ra ngoài; chỉ giữ lại đuôi ngắn
        // phòng trường hợp thẻ đóng bị cắt ngang giữa 2 chunk.
        const keep = Math.min(buf.length, closeTag.length - 1);
        buf = buf.slice(buf.length - keep);
        return;
      }
      buf = buf.slice(closeIdx + closeTag.length);
      inThinking = false;
      closeTag = null;
      continue;
    }
  }

  return {
    feed(piece) {
      buf += piece;
      process();
    },
    flush() {
      // Kết thúc stream mà KHÔNG đang dở dang trong khối thinking: phần buffer còn treo chỉ có
      // thể là văn bản thường trùng 1 phần đầu thẻ mở nhưng chưa bao giờ đủ thành thẻ thật -> an
      // toàn để phát nốt. Nếu ĐANG dở dang trong khối thinking mà stream kết thúc luôn (model
      // quên đóng thẻ) — coi phần còn lại vẫn là nháp, KHÔNG phát ra (an toàn hơn lỡ lộ nháp dở).
      if (!inThinking && buf) { onVisible(buf); buf = ''; }
    }
  };
}

module.exports = { stripThinkingTags, createStreamingThinkingFilter };
