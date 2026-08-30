'use strict';

const express = require('express');
const router = express.Router();
const { getActiveProviders, callWithFailover } = require('../utils/aiProviders');
const {
  buildPPTSystemPrompt, buildFlashcardSystemPrompt, buildOutlineSystemPrompt,
  buildMindmapSystemPrompt, MINDMAP_COLOR_KEYS
} = require('../utils/promptBuilder');
const { validateGenerateBody, validateOutlineBody } = require('../utils/validators');

/**
 * Escape các ký tự điều khiển THÔ (raw control byte — xuống dòng, tab, carriage-return, 0x00-0x1F)
 * xuất hiện NGUYÊN VĂN bên trong 1 chuỗi JSON (tức đứng giữa 2 dấu " của 1 string, không có dấu \
 * đứng trước). Theo chuẩn JSON, chuỗi KHÔNG được chứa ký tự điều khiển thô — chúng BẮT BUỘC phải
 * được viết dưới dạng escape (\n, \t, \r, \u00XX...). NGUYÊN NHÂN GỐC THỰC SỰ của phần lớn lỗi
 * "AI trả về dữ liệu không hợp lệ" ở /api/generate/outline: các trường văn bản dài, nhiều câu
 * (overview, definition, note, sourceNote...) khiến model rất hay tự XUỐNG DÒNG THẬT giữa các câu
 * thay vì viết đúng escape "\n" như đã yêu cầu trong system prompt — dù chỉ 1 ký tự điều khiển thô
 * "lọt" vào cũng khiến JSON.parse ném lỗi "Bad control character in string literal" NGAY LẬP TỨC.
 * Lớp vá dấu \ bên dưới (vốn chỉ xử lý các lệnh LaTeX thiếu \\) KHÔNG xử lý được lỗi này — vì đây
 * không phải vấn đề về dấu \, mà là thiếu hẳn dấu \ trước 1 ký tự điều khiển — nên trước đây mọi
 * trường hợp này đều rơi thẳng xuống nhánh lỗi cuối cùng dù nội dung JSON thực chất chỉ sai định
 * dạng nhẹ, hoàn toàn có thể tự vá được.
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
 * trước khi kịp viết xong toàn bộ JSON — hay gặp ở nội dung dài như PPT nhiều slide/đề cương nhiều
 * mục). JSON cụt luôn thiếu dấu đóng chuỗi/ngoặc ở cuối — TUYỆT ĐỐI không thể vá bằng regex ở các
 * lớp trên (chúng chỉ sửa cú pháp SAI, không thể "đoán" ra phần bị THIẾU). Cách xử lý: quét toàn bộ
 * chuỗi để xác định (a) có đang dở dang giữa 1 chuỗi JSON không, (b) danh sách ngoặc { [ đang MỞ
 * theo đúng thứ tự lồng nhau — rồi tự đóng lại: đóng nốt chuỗi dở dang (nếu có), bỏ dấu phẩy/thuộc
 * tính dở dang cuối cùng (nếu có), rồi đóng lần lượt mọi ngoặc còn mở theo đúng thứ tự trong ra
 * ngoài. Kết quả là 1 JSON hợp lệ nhưng THIẾU phần nội dung bị cắt — chấp nhận được (còn hơn báo lỗi
 * trắng), và ở mức maxTokens đã tăng đáng kể (xem router bên dưới) trường hợp này sẽ hiếm khi xảy ra.
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
 * Parse JSON trả về từ AI cho các endpoint /api/generate/* (ppt-outline, flashcards, outline,
 * mindmap) — có nhiều lớp phòng thủ nối tiếp nhau vì đây là NGUYÊN NHÂN GỐC phổ biến nhất của lỗi
 * "AI trả về dữ liệu không hợp lệ" mà người dùng gặp phải. Mỗi lớp xử lý ĐÚNG 1 nhóm nguyên nhân
 * khác nhau — áp dụng TUẦN TỰ, thử parse lại sau MỖI lớp, chỉ đi tiếp lớp sau khi lớp trước không đủ:
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

router.post('/ppt-outline', async (req, res, next) => {
  try {
    const { content } = validateGenerateBody(req.body);
    const activeProviders = getActiveProviders();
    if (!activeProviders.length) {
      const err = new Error(
        'Máy chủ chưa cấu hình bất kỳ nhà cung cấp AI nào (thiếu ANTHROPIC_API_KEY/OPENAI_API_KEY/GEMINI_API_KEY... trong .env).'
      );
      err.status = 500;
      throw err;
    }
    const system = buildPPTSystemPrompt();
    // Dùng cùng cơ chế xoay tua/tự động chuyển provider (failover) như /api/chat — trước đây route
    // này gọi cứng callClaude() nên riêng tính năng "Xuất slide PPT" sẽ ngừng hoạt động hoàn toàn
    // mỗi khi Anthropic lỗi/hết hạn mức, dù các nhà cung cấp khác (GPT/Gemini/...) vẫn hoạt động
    // tốt — không có provider nào được ưu tiên cố định.
    // maxTokens trước đây (1400) quá thấp cho nội dung tiếng Việt nhiều slide — model dễ bị CẮT
    // NGANG giữa chừng trước khi kịp đóng xong JSON, khiến JSON luôn cụt và KHÔNG cách nào vá được
    // bằng cú pháp (dù đã có lớp closeTruncatedJSON ở trên, càng ít bị cắt càng giữ được nhiều nội
    // dung thật hơn là phần bù đắp cụt lủn) — tăng lên mức đủ rộng rãi cho ~10-12 slide.
    const { text } = await callWithFailover(activeProviders, {
      system,
      messages: [{ role: 'user', content: 'Nội dung cần chuyển thành slide:\n\n' + content }],
      maxTokens: 2800
    });
    res.json(parseJSONSafe(text));
  } catch (err) {
    next(err);
  }
});

router.post('/flashcards', async (req, res, next) => {
  try {
    const { content } = validateGenerateBody(req.body);
    const activeProviders = getActiveProviders();
    if (!activeProviders.length) {
      const err = new Error(
        'Máy chủ chưa cấu hình bất kỳ nhà cung cấp AI nào (thiếu ANTHROPIC_API_KEY/OPENAI_API_KEY/GEMINI_API_KEY... trong .env).'
      );
      err.status = 500;
      throw err;
    }
    const system = buildFlashcardSystemPrompt();
    // Tương tự — trước đây route này cũng gọi cứng callClaude(), giờ dùng chung failover đa provider.
    // Tương tự /ppt-outline — tăng maxTokens để giảm nguy cơ bị cắt ngang giữa chừng (8 thẻ đầy đủ
    // câu hỏi + câu trả lời cho nội dung tiếng Việt dễ vượt quá 1200 token cũ).
    const { text } = await callWithFailover(activeProviders, {
      system,
      messages: [{ role: 'user', content: 'Nội dung cần tạo flashcard:\n\n' + content }],
      maxTokens: 2000
    });
    res.json(parseJSONSafe(text));
  } catch (err) {
    next(err);
  }
});

// POST /api/generate/outline — soạn dữ liệu đề cương (định nghĩa + công thức quan trọng, tùy chọn
// kèm bài tập chia mức độ). Server CHỈ trả JSON có cấu trúc; client tự dựng file .docx thật bằng
// thư viện docx.js (xem public/js/app.js: buildAndDownloadOutlineDocx), giữ đúng kiến trúc "server
// không lưu/tạo file nhị phân" đã áp dụng cho /ppt-outline và /flashcards ở trên.
router.post('/outline', async (req, res, next) => {
  try {
    const { content, includeExercises } = validateOutlineBody(req.body);
    const activeProviders = getActiveProviders();
    if (!activeProviders.length) {
      const err = new Error(
        'Máy chủ chưa cấu hình bất kỳ nhà cung cấp AI nào (thiếu ANTHROPIC_API_KEY/OPENAI_API_KEY/GEMINI_API_KEY... trong .env).'
      );
      err.status = 500;
      throw err;
    }
    const system = buildOutlineSystemPrompt(includeExercises);
    // Đề cương có bài tập cần nhiều token hơn (4 mức độ x nhiều bài) nên tăng maxTokens khi bật.
    // Cả 2 mức đều tăng thêm đáng kể so với trước (1800/3200) — đề cương có tới 6 "sections", mỗi
    // section nhiều định nghĩa/công thức, rất dễ vượt ngưỡng cũ và bị cắt ngang giữa chừng.
    const { text } = await callWithFailover(activeProviders, {
      system,
      messages: [{ role: 'user', content: 'Nội dung cần chuyển thành đề cương:\n\n' + content }],
      maxTokens: includeExercises ? 4500 : 2800
    });
    res.json(parseJSONSafe(text));
  } catch (err) {
    next(err);
  }
});

// Dọn nhẹ 1 node mindmap trước khi trả về client: giới hạn độ sâu (tối đa 3 cấp dưới gốc), giới hạn
// số nhánh/con ở mỗi cấp (phòng model trả dư), ép "color" về đúng 1 giá trị trong danh sách cho phép
// (xoay vòng theo thứ tự nhánh nếu model bịa màu ngoài danh sách/bỏ trống) — vẽ mindmap ở client dựa
// hoàn toàn vào các giá trị này nên cần chắc chắn hợp lệ, không thể để lỗi JSON tự do làm vỡ layout.
function sanitizeMindmapNode(node, depth, branchIdx) {
  if (!node || typeof node !== 'object') return null;
  const label = String(node.label || '').trim().slice(0, 80);
  if (!label) return null;
  const clean = { label };
  if (depth === 1) {
    clean.color = MINDMAP_COLOR_KEYS.includes(node.color)
      ? node.color
      : MINDMAP_COLOR_KEYS[branchIdx % MINDMAP_COLOR_KEYS.length];
  }
  if (depth < 3 && Array.isArray(node.children)) {
    const maxChildren = depth === 0 ? 7 : depth === 1 ? 5 : 4;
    clean.children = node.children
      .slice(0, maxChildren)
      .map((c, i) => sanitizeMindmapNode(c, depth + 1, depth === 0 ? i : branchIdx))
      .filter(Boolean);
  }
  return clean;
}

router.post('/mindmap', async (req, res, next) => {
  try {
    const { content } = validateGenerateBody(req.body);
    const activeProviders = getActiveProviders();
    if (!activeProviders.length) {
      const err = new Error(
        'Máy chủ chưa cấu hình bất kỳ nhà cung cấp AI nào (thiếu ANTHROPIC_API_KEY/OPENAI_API_KEY/GEMINI_API_KEY... trong .env).'
      );
      err.status = 500;
      throw err;
    }
    const system = buildMindmapSystemPrompt();
    // Tăng maxTokens (từ 1600) cùng lý do với 3 endpoint trên — tối đa 7 nhánh x 5 con x 4 cháu dễ
    // vượt ngưỡng cũ với nội dung tiếng Việt.
    const { text } = await callWithFailover(activeProviders, {
      system,
      messages: [{ role: 'user', content: 'Nội dung cần chuyển thành sơ đồ tư duy (mindmap):\n\n' + content }],
      maxTokens: 2400
    });
    const raw = parseJSONSafe(text);
    const title = String(raw.title || 'Sơ đồ tư duy').trim().slice(0, 60);
    const branches = Array.isArray(raw.branches)
      ? raw.branches.slice(0, 7).map((b, i) => sanitizeMindmapNode(b, 1, i)).filter(Boolean)
      : [];
    if (!branches.length) {
      const err = new Error('AI không tạo được sơ đồ tư duy từ nội dung này, vui lòng thử lại.');
      err.status = 502;
      throw err;
    }
    res.json({ title, branches });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
