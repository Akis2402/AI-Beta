// Cấu hình phía CLIENT — không đặt bất kỳ bí mật nào ở đây (mọi thứ trong file này đều công khai với người dùng).
// Nếu bạn bật APP_SHARED_KEY trong .env của server, điền đúng giá trị đó vào đây để frontend gửi kèm header.
// Lưu ý: đây chỉ là lớp chặn cơ bản (che bớt endpoint khỏi bot quét ngẫu nhiên), KHÔNG phải xác thực người dùng thật sự —
// vì giá trị này luôn có thể bị đọc trong mã nguồn frontend. Bảo mật thật sự vẫn dựa vào rate-limit + CORS + validate ở server.
window.APP_CONFIG = {
  appKey: '' // để trống nếu server không bật APP_SHARED_KEY
};
