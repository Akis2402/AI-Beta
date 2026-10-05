# Cài đặt Đăng nhập + Hạn mức token + Cooldown + Asset Manager

Tài liệu này là phần **bạn phải làm bằng tay** (tôi không có quyền truy cập dự án Supabase của bạn). Làm đúng thứ tự.

## 1. Tạo dự án Supabase & chạy migration

1. https://supabase.com → New project.
2. **SQL Editor** → dán toàn bộ `supabase/migrations/20261003000000_auth_quota_assets.sql` → Run. (Chạy lại nhiều lần an toàn.)
3. **Authentication → Providers → Email**: bật. Quyết định **Confirm email**:
   - Bật (khuyến nghị production): đăng ký xong user phải bấm link trong thư mới đăng nhập được. UI đã xử lý (hiện "kiểm tra hộp thư").
   - Tắt: đăng ký xong vào luôn.
4. **Authentication → URL Configuration**: đặt *Site URL* = domain Vercel của bạn (để link xác nhận email trỏ đúng).
5. **Authentication → Rate limits**: giữ mặc định hoặc siết chặt thêm (server đã có giới hạn 20 lần/15 phút/IP).

## 2. Lấy khóa & đặt biến môi trường (Vercel → Settings → Environment Variables)

| Biến | Lấy ở đâu | Lưu ý |
|---|---|---|
| `SUPABASE_URL` | Project Settings → API → Project URL | |
| `SUPABASE_ANON_KEY` | API → `anon` / publishable key | Server dùng; không đưa xuống trình duyệt |
| `SUPABASE_SERVICE_ROLE_KEY` | API → `service_role` / secret key | **Tuyệt đối bí mật.** Không đặt tiền tố `NEXT_PUBLIC_`. Lộ khóa này = ai cũng tự reset quota / đổi admin được |
| `AI_TOKEN_LIMIT` | tùy bạn | mặc định 100000 |
| `AI_COOLDOWN_MINUTES` | tùy bạn | **số nguyên 30–40**, mặc định 35. Ngoài khoảng → server từ chối khởi động |

Các biến còn lại có trong `.env.example` (mỗi biến có chú thích).

> Không đặt `AUTH_ENFORCEMENT=off` trên production — server **từ chối khởi động** nếu làm vậy.

## 3. Tạo admin đầu tiên (để dùng Quản lý hình ảnh)

Không có đường nào tự nâng quyền qua ứng dụng (cố ý). Đăng ký tài khoản bình thường, rồi trong **SQL Editor**:

```sql
update public.profiles set role = 'admin' where email = 'email-cua-ban@example.com';
```

Đăng nhập lại → mở "Tài khoản" → có nút **Quản lý hình ảnh**.

## 4. Deploy

```bash
npm run build      # build:assets tự fingerprint authUI.js, rồi next build
```

## 5. Mô hình hạn mức (để biết chính xác hệ thống làm gì)

- Mỗi request AI: **đặt chỗ** token (nguyên tử trong Postgres, khóa theo user) → gọi model → **ghi token thật** từ phản hồi
  của provider → hoàn phần dư.
- Cạn `AI_TOKEN_LIMIT` → khóa `AI_COOLDOWN_MINUTES` phút. Trong thời gian khóa **server không gọi model**.
  Hết khóa → tự reset về 0 ở lần dùng kế tiếp. Không có cửa sổ reset thứ hai.
- Cooldown tính theo đồng hồ **database**, không phụ thuộc đồng hồ máy người dùng; đăng xuất/đăng nhập/đổi thiết bị không né được.
- Request lỗi / cache hit / không gọi model → không tốn token. Reservation treo quá `AI_RESERVATION_TTL_SECONDS` → **bị tính phí
  phần đã đặt chỗ** (an toàn: làm hỏng bước ghi nhận không thể thành "dùng miễn phí"); nếu ghi nhận đến muộn sẽ điều chỉnh về số thật.
- Request vượt hạn mức khi đang chạy vẫn hoàn tất (không cắt giữa câu trả lời) và được tính theo thực tế → có thể vượt nhẹ giới hạn.
- Chặn đồng thời `AI_MAX_CONCURRENT` request/user nên không thể vượt hạn mức hàng loạt bằng cách bắn song song.

## 6. Kiểm tra sau khi cài

1. Mở app khi chưa đăng nhập → hiện khung đăng nhập. Gửi câu hỏi bằng `curl` không cookie → 401.
2. Đăng ký → đăng nhập → F5 vẫn đăng nhập. Góc trên phải hiện `đã dùng / giới hạn`.
3. Để thử cooldown nhanh: đặt tạm `AI_TOKEN_LIMIT=1000`, hỏi 1–2 câu → banner đếm ngược ~35 phút.
4. Supabase → Table editor → `ai_usage`: mỗi request 1 dòng với token thật.
5. `GET /api/health` → `auth.supabaseConfigured: true`.

## 7. Giới hạn đã biết (nói thẳng)

- Chưa được thử với dự án Supabase **thật** của bạn (tôi dùng GoTrue giả lập + Postgres thật). Hãy chạy mục 6 trước khi mở cho người dùng.
- Provider **không trả usage** (hiếm) → tính bảo thủ theo mức đặt chỗ, không tính 0.
- Thông báo lỗi của auth/quota bằng tiếng Việt; chưa dịch sang ngôn ngữ UI khác.
- Số token hiển thị cập nhật sau mỗi lượt gọi AI (~1 giây sau khi stream kết thúc), không theo thời gian thực từng token.
- Lỗ hổng còn lại của mọi hệ quota phía server: người dùng có thể tạo nhiều tài khoản để có nhiều hạn mức. Cân nhắc bật
  Confirm email + CAPTCHA (Supabase hỗ trợ Turnstile/hCaptcha) nếu bị lạm dụng.
