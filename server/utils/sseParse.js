'use strict';

// Tiện ích DÙNG CHUNG để đọc phản hồi dạng SSE (Server-Sent Events, "text/event-stream") từ bất kỳ
// nhà cung cấp AI nào (Anthropic/OpenAI/Gemini/các provider tương thích OpenAI) — mọi client
// streaming trong dự án (anthropicClient, openaiClient, geminiClient, openaiCompatibleClient) đều
// gọi qua hàm này thay vì tự viết lại logic đọc stream + gộp buffer dòng dở.
//
// SSE format chuẩn: mỗi sự kiện là 1 hoặc nhiều dòng "field: value", các sự kiện cách nhau bởi 1
// dòng trống. Ta chỉ quan tâm dòng bắt đầu bằng "data:" (nội dung payload, thường là JSON hoặc
// "[DONE]") — bỏ qua "event:", "id:", comment (":")... vì cả 4 client trong dự án đều không cần.
//
// @param {Response} response Đối tượng fetch Response còn nguyên body stream (chưa .text()/.json()).
// @returns {AsyncGenerator<string>} yield lần lượt phần payload sau "data:" của từng dòng sự kiện.
async function* iterateSSELines(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        yield line.slice(5).trim();
      }
    }
    // Phần còn lại sau khi stream kết thúc (hiếm khi có, nhưng phòng trường hợp server không kết
    // thúc bằng \n cuối cùng).
    const last = buffer.trim();
    if (last.startsWith('data:')) yield last.slice(5).trim();
  } finally {
    try { reader.releaseLock(); } catch (e) { /* đã release hoặc stream đã đóng — bỏ qua */ }
  }
}

module.exports = { iterateSSELines };
