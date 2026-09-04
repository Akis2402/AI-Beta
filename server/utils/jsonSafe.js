'use strict';

// ============================================================================================
// Tách từ server/routes/generate.js (không đổi logic) để dùng chung cho MỌI route cần AI trả JSON
// có cấu trúc — trước đây chỉ /api/generate/* dùng, giờ /api/recommend (tìm link tài liệu qua AI +
// web search thật, xem server/routes/recommend.js) cũng cần đúng cơ chế vá lỗi JSON này.
// ============================================================================================

/**
 * Escape các ký tự điều khiển THÔ (raw control byte — xuống dòng, tab, carriage-return, 0x00-0x1F)
 * xuất hiện NGUYÊN VĂN bên trong 1 chuỗi JSON (tức đứng giữa 2 dấu " của 1 string, không có dấu \
 * đứng trước). Theo chuẩn JSON, chuỗi KHÔNG được chứa ký tự điều khiển thô — chúng BẮT BUỘC phải
 * được viết dưới dạng escape (\n, \t, \r, \u00XX...). NGUYÊN NHÂN GỐC THỰC SỰ của phần lớn lỗi
 * "AI trả về dữ liệu không hợp lệ": các trường văn bản dài, nhiều câu khiến model rất hay tự XUỐNG
 * DÒNG THẬT giữa các câu thay vì viết đúng escape "\n" như đã yêu cầu trong system prompt — dù chỉ
 * 1 ký tự điều khiển thô "lọt" vào cũng khiến JSON.parse ném lỗi "Bad control character in string
 * literal" NGAY LẬP TỨC. Lớp vá dấu \ bên dưới (vốn chỉ xử lý các lệnh LaTeX thiếu \\) KHÔNG xử lý
 * được lỗi này — vì đây không phải vấn đề về dấu \, mà là thiếu hẳn dấu \ trước 1 ký tự điều khiển.
 *
 * Cách vá: quét từng ký tự, tự theo dõi trạng thái "đang ở trong 1 chuỗi JSON" (dựa vào dấu " chưa
 * bị \ đứng trước ngay trước nó) — CHỈ escape ký tự điều khiển khi đang ở TRONG chuỗi (khoảng trắng/
 * xuống dòng NGOÀI chuỗi, dùng để format JSON cho dễ đọc, vốn vô hại với JSON.parse nên giữ nguyên).
 */
function escapeRawControlCharsInStrings(text) {
  let out = '';
  let inString = false;
  let escapedNext = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!inString) {
      out += c;
      if (c === '"') inString = true;
      continue;
    }
    if (escapedNext) {
      out += c;
      escapedNext = false;
      continue;
    }
    if (c === '\\') { out += c; escapedNext = true; continue; }
    if (c === '"') { out += c; inString = false; continue; }
    const code = c.charCodeAt(0);
    if (code <= 0x1f) {
      if (c === '\n') out += '\\n';
      else if (c === '\r') out += '\\r';
      else if (c === '\t') out += '\\t';
      else out += '\\u' + code.toString(16).padStart(4, '0');
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * Escape dấu " xuất hiện Ở GIỮA nội dung 1 chuỗi JSON (model tự trích dẫn 1 cụm từ trong câu, hoặc
 * viết đơn vị đo bằng dấu " (inch/tấc), mà QUÊN escape thành \") — nguyên nhân RẤT phổ biến khác
 * (ngoài ký tự điều khiển thô) khiến JSON của AI bị coi là "không hợp lệ": bất kỳ dấu " nào không
 * được escape sẽ bị JSON.parse hiểu nhầm là dấu ĐÓNG chuỗi ngay lập tức — toàn bộ phần còn lại của
 * chuỗi (và cấu trúc JSON phía sau) bị lệch hoàn toàn, dẫn tới lỗi "Unexpected token"/"Expected ','"
 * mà không lớp vá control-char hay vá dấu \ (LaTeX) nào ở trên xử lý được, vì bản chất không phải
 * lỗi thiếu \, mà là 1 dấu " thật sự không nên có mặt ở vị trí đó.
 *
 * Heuristic vá (cách các thư viện "sửa JSON hỏng từ LLM" hay dùng): quét từng dấu ", khi đang ở
 * TRONG 1 chuỗi và gặp 1 dấu " tưởng như đóng chuỗi, "nhìn trước" (bỏ qua khoảng trắng) — CHỈ coi là
 * dấu đóng chuỗi THẬT nếu ký tự kế tiếp là 1 trong các ký tự CHỈ CÓ THỂ đứng ngay sau khi 1 chuỗi
 * JSON thực sự kết thúc ( , ] } : hoặc hết chuỗi); ngược lại (ký tự kế tiếp là chữ/số/dấu câu khác)
 * coi đây là dấu " nằm giữa nội dung — escape nó thành \" và tiếp tục coi như vẫn đang ở trong chuỗi.
 */
function escapeStrayQuotesInStrings(text) {
  let out = '';
  let inString = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (!inString) {
      out += c;
      if (c === '"') inString = true;
      i++;
      continue;
    }
    if (c === '\\') {
      out += c + (text[i + 1] || '');
      i += 2;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      const nextCh = text[j];
      const isRealClose = nextCh === undefined || ',}]:'.includes(nextCh);
      if (isRealClose) {
        out += c;
        inString = false;
        i++;
        continue;
      }
      out += '\\"'; // dấu " lạc giữa chuỗi — escape, KHÔNG thoát khỏi chuỗi
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Lớp vá CUỐI CÙNG — "đóng" JSON bị CẮT NGANG giữa chừng (model dừng đột ngột khi hết maxTokens
 * trước khi kịp viết xong toàn bộ JSON — hay gặp ở nội dung dài như đề cương nhiều mục/phần). JSON
 * cụt luôn thiếu dấu đóng chuỗi/ngoặc ở cuối — TUYỆT ĐỐI không thể vá bằng regex ở các
 * lớp trên (chúng chỉ sửa cú pháp SAI, không thể "đoán" ra phần bị THIẾU). Cách xử lý: quét toàn bộ
 * chuỗi để xác định (a) có đang dở dang giữa 1 chuỗi JSON không, (b) danh sách ngoặc { [ đang MỞ
 * theo đúng thứ tự lồng nhau — rồi tự đóng lại: đóng nốt chuỗi dở dang (nếu có), bỏ dấu phẩy/thuộc
 * tính dở dang cuối cùng (nếu có), rồi đóng lần lượt mọi ngoặc còn mở theo đúng thứ tự trong ra
 * ngoài. Kết quả là 1 JSON hợp lệ nhưng THIẾU phần nội dung bị cắt (chấp nhận được, còn hơn báo lỗi
 * trắng), và ở mức maxTokens đã đủ rộng rãi ở nơi gọi trường hợp này sẽ hiếm khi xảy ra.
 */
function closeTruncatedJSON(text) {
  let inString = false;
  let escape = false;
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{' || c === '[') { stack.push(c); continue; }
    if (c === '}' || c === ']') { stack.pop(); continue; }
  }
  let out = text;
  if (inString) out += '"'; // đóng nốt chuỗi đang dở dang
  out = out.replace(/,\s*$/, ''); // bỏ dấu phẩy thừa cuối (phần tử/thuộc tính kế tiếp bị cắt mất)
  out = out.replace(/,?\s*"[^"\\]*"\s*:\s*$/, ''); // bỏ 1 "key": dở dang chưa kịp có giá trị
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === '{' ? '}' : ']';
  return out;
}

/**
 * Parse JSON trả về từ AI — có nhiều lớp phòng thủ nối tiếp nhau vì đây là NGUYÊN NHÂN GỐC phổ biến
 * nhất của lỗi "AI trả về dữ liệu không hợp lệ" mà người dùng gặp phải. Mỗi lớp xử lý ĐÚNG 1 nhóm
 * nguyên nhân khác nhau — áp dụng TUẦN TỰ, thử parse lại sau MỖI lớp, chỉ đi tiếp lớp sau khi lớp
 * trước không đủ:
 *
 * 1. Cắt bỏ mọi văn bản THỪA trước/sau khối JSON (rào ```json ... ```, câu dẫn/kết) — lấy đúng đoạn
 *    từ dấu "{" ĐẦU TIÊN tới dấu "}" CUỐI CÙNG.
 * 2. Thử parse trực tiếp.
 * 3. Vá ký tự điều khiển thô (xuống dòng thật... trong chuỗi) — xem escapeRawControlCharsInStrings.
 * 4. Vá dấu " lạc giữa chuỗi (model quên escape) — xem escapeStrayQuotesInStrings.
 * 5. Vá dấu \ thiếu nhân đôi (LaTeX \frac, \sqrt, \Delta...) — xem comment chi tiết tại chỗ áp dụng.
 * 6. Vá JSON bị CẮT NGANG do hết maxTokens — xem closeTruncatedJSON. Đây là lớp CUỐI, chỉ dùng khi
 *    mọi lớp trên đều không đủ, vì nó có thể làm mất phần nội dung bị cắt (chấp nhận được, còn hơn
 *    báo lỗi trắng cho người dùng).
 * 7. Vẫn lỗi sau tất cả các lớp trên — thực sự không parse được, báo lỗi rõ ràng.
 */
function parseJSONSafe(raw) {
  let cleaned = String(raw || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/```\s*$/, '')
    .trim();

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  } else if (firstBrace >= 0) {
    // Không tìm thấy dấu "}" cuối hợp lệ — rất có thể JSON bị CẮT NGANG ngay trước khi kịp đóng bất
    // kỳ ngoặc nào (hết maxTokens giữa chừng) — vẫn lấy từ "{" đầu tiên trở đi để lớp vá cuối
    // (closeTruncatedJSON) có cơ hội tự đóng lại thay vì bỏ cuộc ngay tại đây.
    cleaned = cleaned.slice(firstBrace);
  }

  // Vá dấu \ thiếu nhân đôi (LaTeX \frac, \sqrt, \Delta...). KHÔNG thể chỉ đơn giản "giữ nguyên
  // \b \f \n \r \t \u vì chúng là escape hợp lệ" — vì chính các chữ cái b/f/n/r/t đó lại là chữ cái
  // ĐẦU của rất nhiều lệnh LaTeX phổ biến (\frac, \boxed, \nabla, \rightarrow, \tan/\times/\theta)
  // nên 1 dấu \ đơn trước b/f/n/r/t vẫn RẤT có thể là LaTeX bị "nuốt" mất 1 ký tự thành escape sai,
  // không phải escape thật. Chỉ giữ nguyên khi \b/\f/\n/\r/\t KHÔNG có chữ cái nào theo ngay sau
  // (tức đúng là 1 escape đơn lẻ, không phải mở đầu 1 từ dài hơn).
  const fixBackslashes = (text) =>
    text.replace(/\\([\s\S])([a-zA-Z]?)/g, (m, ch, next) => {
      if (ch === '"' || ch === '\\' || ch === '/' || ch === 'u') return m;
      if ('bfnrt'.includes(ch) && !next) return m;
      return '\\\\' + ch + next;
    });

  // Áp dụng TUẦN TỰ từng lớp vá lên bản đã vá TRƯỚC ĐÓ (không phải bản gốc), vì các nguyên nhân
  // thường xuất hiện CÙNG LÚC trong 1 phản hồi (vd vừa có xuống dòng thật, vừa có LaTeX thiếu \\,
  // vừa bị cắt cụt cuối) — thử parse lại sau MỖI lớp, dừng ngay khi thành công.
  let candidate = cleaned;
  const stages = [escapeRawControlCharsInStrings, escapeStrayQuotesInStrings, fixBackslashes, closeTruncatedJSON];
  for (const fix of stages) {
    try {
      candidate = fix(candidate);
      return JSON.parse(candidate);
    } catch (e) { /* thử lớp vá kế tiếp trên bản đã tích lũy đến đây */ }
  }

  const err = new Error('AI trả về dữ liệu không hợp lệ, vui lòng thử lại.');
  err.status = 502;
  throw err;
}

module.exports = { parseJSONSafe };
