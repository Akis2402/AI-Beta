# Đăng nhập bằng Google + hồ sơ tự động (Supabase)

Mã đã có trong repo. Phần dưới là **việc bạn phải làm thủ công** (agent không có quyền vào Google Cloud / Supabase Dashboard của bạn).

## Cách hoạt động (khớp kiến trúc hiện có: cookie HttpOnly, không dùng `@supabase/ssr`)

```
/auth  ──nút "Tiếp tục với Google"──▶ GET /api/auth/google
        server: tạo code_verifier (cookie HttpOnly tg_pkce, 10 phút) ─302▶ Supabase /auth/v1/authorize (provider=google, PKCE s256)
Google ─▶ Supabase ─302▶ GET /api/auth/callback?code=…
        server: POST /auth/v1/token?grant_type=pkce {auth_code, code_verifier} ─▶ cookie phiên tg_at/tg_rt/tg_rm ─302▶ /index.html
```

- Trigger `on_auth_user_created` → `public.handle_new_user()` tạo dòng `public.profiles` cho **mọi** cách đăng ký (email, Google, tạo từ dashboard).
- Tên lấy từ `full_name` hoặc `name` → `profiles.display_name`; ảnh từ `avatar_url` hoặc `picture` → `profiles.avatar_url` (chỉ chấp nhận `https://`).
- Supabase **tự liên kết** hai danh tính cùng email đã xác nhận (email+mật khẩu ↔ Google) thành một user; profile cũ được giữ nguyên, không bị ghi đè.

## Checklist cấu hình

1. **Áp migration** `supabase/migrations/20261017000000_profiles_google_bio_phone.sql` (chạy sau `20261003000000_auth_quota_assets.sql`):
   - Cloud: dán vào SQL Editor, hoặc `supabase db push`.
   - Local CLI: `supabase db reset` hoặc `supabase migration up`.
   - Migration idempotent, chỉ **thêm** cột `bio`, `phone` và thay hàm `handle_new_user()`. Không đổi/xóa dữ liệu.
2. **Google Cloud Console** → APIs & Services → Credentials → *Create OAuth client ID* loại **Web application** (cấu hình *OAuth consent screen* trước).
   - *Authorized JavaScript origins*: `https://<domain-production>` và `http://localhost:3000`.
   - *Authorized redirect URIs*: `https://<project-ref>.supabase.co/auth/v1/callback` (lấy đúng giá trị ở Supabase Dashboard → Authentication → Providers → Google). Đây là callback của **Supabase**, không phải của app.
3. **Supabase Dashboard** → Authentication → Providers → **Google**: bật, dán *Client ID* + *Client Secret*. Secret chỉ nằm ở đây, không đưa vào repo/`.env`.
4. **Supabase Dashboard** → Authentication → URL Configuration:
   - *Site URL*: URL production.
   - *Redirect URLs*: thêm **chính xác** `https://<domain-production>/api/auth/callback` và `http://localhost:3000/api/auth/callback`.
   - (Callback tự dựng từ `Host`; nếu muốn cố định, đặt `AUTH_REDIRECT_URL=https://<domain-production>` — server dùng origin của nó + `/api/auth/callback`.)
5. **Supabase local CLI** (nếu dùng): trong `supabase/config.toml`
   ```toml
   [auth.external.google]
   enabled = true
   client_id = "env(GOOGLE_CLIENT_ID)"
   secret = "env(GOOGLE_CLIENT_SECRET)"
   ```
   đặt hai biến đó trong môi trường, không ghi giá trị thật vào file.

## Kiểm thử thủ công sau khi cấu hình

| # | Bước | Kỳ vọng |
|---|------|---------|
| 1 | `/auth` → "Tiếp tục với Google" bằng Gmail **chưa từng đăng ký** | Vào `/index.html`; bảng `profiles` có 1 dòng với `display_name` = tên Google, `avatar_url` = ảnh Google |
| 2 | Đăng xuất, đăng nhập lại bằng Google | Vẫn 1 dòng profile, không tạo user mới |
| 3 | Đăng ký email+mật khẩu có nhập họ tên | `display_name` = họ tên đã nhập |
| 4 | Đăng ký email mà **bỏ trống** họ tên | `display_name` = phần trước `@` |
| 5 | Ở màn Google bấm *Cancel* | Quay về `/auth` với thông báo "Bạn đã hủy đăng nhập bằng Google" |
| 6 | Mở thẳng `/api/auth/callback?code=x` (không qua nút) | Quay về `/auth` với lỗi, **không** có phiên |

SQL kiểm tra: `select id, email, display_name, avatar_url from public.profiles order by created_at desc limit 5;`

## Lưu ý còn lại

- **CSP**: `vercel.json` có `img-src 'self' data: blob:` nên ảnh Google (`https://lh3.googleusercontent.com/...`) **sẽ bị chặn** khi giao diện hiển thị `avatar_url`. Khi làm màn hình hồ sơ có ảnh, thêm `https://lh3.googleusercontent.com` vào `img-src` **đồng thời** ở `vercel.json` và nơi mà `test/vercel-header-parity.test.js` đối chiếu.
- Trang `/auth` chỉ điều hướng; token không bao giờ vào JS của trang.
- Chạy test: `node test/auth-google-oauth.test.js` rồi `npm test`.
