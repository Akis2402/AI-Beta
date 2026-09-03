'use strict';

// ---------- Danh sách nhà cung cấp AI BỔ SUNG — tự động nhận diện, KHÔNG cần sửa code ----------
// Hầu hết các hãng AI ngoài Anthropic/Google (Grok/xAI, Mistral, DeepSeek, Groq, OpenRouter,
// Together AI, Fireworks, Perplexity...) đều expose một API tương thích chuẩn "OpenAI Chat
// Completions" (POST {baseURL}, body {model, messages}, header Authorization: Bearer <key>).
// Vì vậy chỉ cần khai báo 1 object ở đây — KHÔNG cần viết file client riêng — hệ thống sẽ tự dùng
// server/utils/openaiCompatibleClient.js để gọi.
//
// CÁCH BẬT 1 PROVIDER TRONG DANH SÁCH DƯỚI ĐÂY:
//   1. Điền khóa API vào biến môi trường `apiKeyEnv` tương ứng trong file .env (xem .env.example).
//   2. Xong — không cần khởi động lại code, không cần sửa gì thêm. Lần request kế tiếp,
//      server/utils/aiProviders.js sẽ tự phát hiện biến môi trường đó đã có giá trị và đưa
//      provider này vào vòng xoay tua ngẫu nhiên của cả chế độ "Nhanh" lẫn "Suy nghĩ sâu".
//   3. Để trống biến môi trường đó = provider bị bỏ qua hoàn toàn, không gây lỗi ứng dụng.
//
// ---------- ĐA DẠNG HOÁ: 1 provider có thể nhập NHIỀU API key + NHIỀU model ----------
// `apiKeyEnv` và `modelEnv`/`fastModelEnv` không bị giới hạn chỉ 1 giá trị — điền NHIỀU khóa/model
// phân tách bằng dấu phẩy (hoặc xuống dòng) là được, ví dụ trong .env:
//   GROK_API_KEY=xai-khoa-thu-1,xai-khoa-thu-2,xai-khoa-thu-3
//   GROK_MODEL=grok-4,grok-4-fast-reasoning
// server/utils/executionTargets.js#buildTargetsForDef() tự tách thành nhiều Execution Target
// TƯỜNG MINH — MỖI tổ hợp (khóa API × model) là 1 ứng viên độc lập trong vòng xoay công bằng/đua
// tốc độ/failover (server/utils/rotationManager.js), với health riêng theo 3 tầng khóa/model/target
// (khóa nào hết hạn mức hoặc bị lỗi tự động nhường sang khóa khác CÙNG hãng hoặc hãng khác) — giúp
// vừa tăng độ tin cậy (nhiều khóa dự phòng) vừa tăng đa dạng câu trả lời (nhiều model) mà không cần
// sửa code. Chỉ khai 1 khóa/1 model như trước đây thì hành vi giữ nguyên y hệt.
//
// CÁCH THÊM 1 PROVIDER MỚI CHƯA CÓ SẴN Ở ĐÂY (miễn là hãng đó có API tương thích OpenAI):
//   Thêm 1 object vào mảng EXTRA_PROVIDERS bên dưới theo đúng khuôn các provider có sẵn, rồi thêm
//   biến môi trường tương ứng vào .env. Chỉ những hãng dùng API KHÔNG tương thích OpenAI mới cần
//   viết file client riêng (xem mục 8 trong README.md, phần "Thêm nhà cung cấp có API riêng biệt").
//
// Mỗi object gồm:
//   key           — định danh nội bộ, duy nhất, không dấu/khoảng trắng
//   label         — tên hiển thị cho người dùng (kèm biến model để biết đang dùng bản nào)
//   apiKeyEnv     — tên biến môi trường chứa khóa API (chỉ bật provider khi biến này có giá trị)
//   baseURL       — endpoint chat completions tương thích OpenAI của hãng đó
//   modelEnv      — tên biến môi trường cho phép người dùng ghi đè model mặc định
//   defaultModel  — model dùng khi KHÔNG bật chế độ "Nhanh" tốc độ cao (chế độ Sâu, hoặc khi
//                   FAST_MODE_QUICK=false) — nên chọn model mạnh/chính xác
//   fastModelEnv  — biến môi trường cho phép ghi đè model "nhanh" dùng riêng cho chế độ Nhanh
//   defaultFastModel — model nhẹ/nhanh hơn dùng cho chế độ Nhanh (tăng tốc độ phản hồi)
//   extraBody     — (tùy chọn) object các trường BỔ SUNG gộp thẳng vào body JSON gửi cho hãng đó,
//                   dùng khi hãng có tham số RIÊNG để điều khiển hành vi ngoài chuẩn OpenAI chung.
//
// ---------- Vì sao có trường `extraBody`: fix lỗi "lộ nháp suy luận thô ra màn hình người dùng" ----------
// Một số model "reasoning" nguồn mở (đặc biệt dòng openai/gpt-oss-* chạy qua Groq bên dưới) tự
// sinh ra 1 đoạn nháp suy luận/tự-kiểm-tra NỘI BỘ (vd "Here's a thinking process...", hay thậm chí
// nhãn tự phân loại an toàn kiểu "User Safety: safe / Response Safety: safe") như 1 phần của quy
// trình sinh câu trả lời — nhưng KHÔNG bọc trong bất kỳ thẻ nào (không phải <thinking>/<think>),
// nên bộ lọc thẻ ở server/utils/thinkingFilter.js không thể nhận diện để ẩn đi (không có gì để
// phân biệt với văn bản thường). Nhà cung cấp phải TỰ tách/ẩn phần này ở phía họ trước khi trả về
// — Groq hỗ trợ tham số `reasoning_format: "hidden"` cho đúng mục đích này (loại bỏ hẳn nháp suy
// luận khỏi cả `content` lẫn `delta.content`, chỉ trả về câu trả lời cuối). OpenRouter có cơ chế
// tương đương qua `reasoning: {exclude: true}`. server/utils/openaiCompatibleClient.js gộp
// `extraBody` này vào body gửi đi cho ĐÚNG provider khai báo nó — các hãng khác không bị ảnh hưởng.
const EXTRA_PROVIDERS = [
  {
    key: 'grok',
    label: 'Grok (xAI)',
    apiKeyEnv: 'GROK_API_KEY',
    baseURL: 'https://api.x.ai/v1/chat/completions',
    modelEnv: 'GROK_MODEL',
    defaultModel: 'grok-4',
    fastModelEnv: 'GROK_MODEL_FAST',
    defaultFastModel: 'grok-4-fast'
  },
  {
    key: 'deepseek',
    label: 'DeepSeek',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    baseURL: 'https://api.deepseek.com/chat/completions',
    modelEnv: 'DEEPSEEK_MODEL',
    defaultModel: 'deepseek-chat',
    fastModelEnv: 'DEEPSEEK_MODEL_FAST',
    defaultFastModel: 'deepseek-chat'
  },
  {
    key: 'mistral',
    label: 'Mistral',
    apiKeyEnv: 'MISTRAL_API_KEY',
    baseURL: 'https://api.mistral.ai/v1/chat/completions',
    modelEnv: 'MISTRAL_MODEL',
    defaultModel: 'mistral-large-latest',
    fastModelEnv: 'MISTRAL_MODEL_FAST',
    defaultFastModel: 'mistral-small-latest'
  },
  {
    key: 'groq',
    label: 'Groq',
    apiKeyEnv: 'GROQ_API_KEY',
    baseURL: 'https://api.groq.com/openai/v1/chat/completions',
    modelEnv: 'GROQ_MODEL',
    // Groq chạy trên phần cứng LPU chuyên dụng — tốc độ sinh token cực nhanh, rất hợp để làm
    // "provider tốc độ" cho chế độ Nhanh dù model không phải bản mạnh nhất.
    // Lưu ý: llama-3.3-70b-versatile và llama-3.1-8b-instant đã bị Groq khai tử (deprecated) —
    // dùng dòng model openai/gpt-oss thay thế theo khuyến nghị chính thức của Groq.
    defaultModel: 'openai/gpt-oss-120b',
    fastModelEnv: 'GROQ_MODEL_FAST',
    defaultFastModel: 'openai/gpt-oss-20b',
    // Dòng model gpt-oss là model "reasoning" — mặc định Groq trả về CẢ nháp suy luận nội bộ lẫn
    // câu trả lời cuối lẫn lộn trong cùng 1 trường `content`/`delta.content`. "hidden" yêu cầu
    // Groq loại bỏ hẳn phần nháp, chỉ trả về câu trả lời cuối — xem giải thích đầy đủ ở đầu file.
    extraBody: { reasoning_format: 'hidden' }
  },
  {
    key: 'openrouter',
    label: 'OpenRouter',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    baseURL: 'https://openrouter.ai/api/v1/chat/completions',
    modelEnv: 'OPENROUTER_MODEL',
    // OpenRouter là cổng trung gian truy cập hàng trăm model khác nhau bằng 1 khóa API — hữu ích
    // nếu bạn muốn thử nhanh 1 model lạ mà chưa muốn viết provider riêng.
    defaultModel: 'openrouter/auto',
    fastModelEnv: 'OPENROUTER_MODEL_FAST',
    defaultFastModel: 'openrouter/auto',
    // 'openrouter/auto' có thể tự động định tuyến sang 1 model "reasoning" — loại trừ nháp suy
    // luận khỏi kết quả trả về, chỉ giữ câu trả lời cuối (xem giải thích đầy đủ ở đầu file).
    extraBody: { reasoning: { exclude: true } }
  }
];

module.exports = { EXTRA_PROVIDERS };
