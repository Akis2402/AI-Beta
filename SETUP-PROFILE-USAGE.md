# Hồ sơ · Cài đặt · Sử dụng token (50.000/user)

## Hạn mức
- Mỗi user có **50.000 token** (mặc định trong `server/utils/quota/config.js`, biến `AI_TOKEN_LIMIT`).
- Khi dùng hết: tài khoản tạm khoá một thời gian (cooldown) rồi tự mở lại — cơ chế cũ, không đổi.
- **Nếu bạn đã đặt `AI_TOKEN_LIMIT` trên Vercel/.env thì giá trị đó thắng mặc định.** Hãy sửa thành `50000` hoặc xoá biến.
- Đổi riêng cho một user: sửa cột `ai_quota.token_limit` trong Supabase.

## Migration (chạy theo thứ tự, đều idempotent)
1. `20261003000000_auth_quota_assets.sql` — bảng `profiles`, `ai_quota`, `ai_usage`, các hàm `ai_reserve/ai_settle/ai_release/ai_quota_status`.
2. `20261017000000_profiles_google_bio_phone.sql` — cột `bio`, `phone`, trigger đọc tên/ảnh từ Google.
3. `20261018000000_token_limit_50k.sql` — đặt `token_limit` = 50.000 cho mọi dòng hiện có.

> Server đọc cột `bio`, `phone` của `profiles`: **phải áp migration 2 trước khi deploy bản code này**, nếu không truy vấn hồ sơ lỗi.
> Supabase MCP đặt phiên bản migration theo giờ áp (khác tên file). Vì các file đều idempotent nên `supabase db push` sau này không gây hại.

## Giao diện
- Số token **không còn hiện trên màn hình chính**. Chỉ còn: pill hiện tên + chữ cái đầu, banner "tạm khoá" khi hết hạn mức, và toast nhắc ở 80% (tắt được).
- Bấm pill hoặc nút **Cài đặt** → hộp thoại **Hồ sơ** có 4 tab:
  - **Hồ sơ**: tên, giới thiệu (≤280), số điện thoại, email (chỉ đọc).
  - **Cài đặt**: Giảm chuyển động · Nhắc khi gần hết hạn mức · toàn bộ cài đặt AI cũ (chuyển nguyên DOM từ `#settingsModal`).
  - **Sử dụng**: đã dùng/giới hạn, %, còn lại, thống kê hôm nay / 7 ngày, biểu đồ 7 ngày, 10 lượt gần nhất (đọc từ `GET /api/auth/usage`).
  - **Bảo mật**: đổi mật khẩu (phải nhập đúng mật khẩu hiện tại), đăng xuất, đăng xuất mọi thiết bị.
- Khách (chưa đăng nhập) vẫn mở được **Cài đặt**; các tab còn lại cần đăng nhập.
- Đăng nhập/đăng ký/quên mật khẩu chạy ở trang `/auth` (Turnstile + Google). Hộp thoại đăng nhập cũ trong app không còn được gọi.

## Endpoint mới
`GET /api/auth/usage` · `POST /api/auth/password` · `POST /api/auth/logout-all` · `PATCH /api/auth/profile` nhận thêm `bio`, `phone`.

## Kiểm thử
`node test/auth-profile-usage.test.js` · `node test/profile-ui.test.js` (cần `jsdom`) · `node test/akis-mascot-image.test.js` · `node test/auth-turnstile.test.js` · `node test/auth-google-oauth.test.js` · `node test/pdf-extraction-optimizations.test.js`.
