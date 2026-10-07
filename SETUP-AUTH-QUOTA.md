# Cài đặt Đăng nhập + Hạn mức token + Cooldown + Asset Manager

Tài liệu này là phần **bạn phải làm bằng tay** (tôi không có quyền truy cập dự án Supabase của bạn). Làm đúng thứ tự.

## 1. Tạo dự án Supabase & chạy migration

1. https://supabase.com → New project.
2. **SQL Editor** → dán toàn bộ `supabase/migrations/20261003000000_auth_quota_assets.sql` → Run. (Chạy lại nhiều lần an toàn.)
3. **Authentication → Providers → Email**: bật. Quyết định **Confirm email**:
   - Bật (khuyến nghị production): đăng ký xong user phải bấm link trong thư mới đăng nhập được. UI đã xử lý (hiện "kiểm tra hộp thư").
   - Tắt: đăng ký xong vào luôn.
4. **Authentication → URL Configuration**: đặt *Site URL* = domain Vercel của bạn. Thêm cùng domain vào *Redirect URLs*
   (link xác nhận email và link **đặt lại mật khẩu** đều đưa người dùng về đây). Nếu đặt `AUTH_REDIRECT_URL`, URL đó cũng phải nằm trong danh sách này.
5. **Authentication → Rate limits**: giữ mặc định hoặc siết thêm (server đã có giới hạn riêng, xem mục 5).
6. (Tuỳ chọn) **Authentication → Email Templates**: chỉnh nội dung thư xác nhận / đặt lại mật khẩu sang tiếng Việt.

## 2. Lấy khóa & đặt biến môi trường (Vercel → Settings → Environment Variables)

| Biến | Lấy ở đâu | Lưu ý |
|---|---|---|
| `SUPABASE_URL` | Project Settings → API → Project URL | |
| `SUPABASE_ANON_KEY` | API → `anon` / publishable key | Server dùng; không đưa xuống trình duyệt |
| `SUPABASE_SERVICE_ROLE_KEY` | API → `service_role` / secret key | **Tuyệt đối bí mật.** Không đặt tiền tố `NEXT_PUBLIC_`. Lộ khóa này = ai cũng tự reset quota / đổi admin được |
| `AI_TOKEN_LIMIT` | tùy bạn | mặc định 100000 |
| `AI_COOLDOWN_MINUTES` | tùy bạn | **số nguyên 30–40**, mặc định 35. Ngoài khoảng → server từ chối khởi động |
| `AI_IMAGE_TOKEN_COST` | tùy bạn | mỗi ảnh server sinh thành công bị tính bấy nhiêu "token-tương-đương" (mặc định 4000) |
| `AUTH_SIGNUP_POW_BITS` | tùy bạn | độ khó proof-of-work khi đăng ký/quên mật khẩu (mặc định 16 ≈ 1 giây; `0` = tắt) |
| `RATE_LIMIT_SIGNUP` | tùy bạn | số lần đăng ký / quên mật khẩu mỗi giờ mỗi IP (mặc định 5) |
| `AUTH_REDIRECT_URL` | tuỳ chọn | trang web mà link đặt lại mật khẩu đưa về; bỏ trống = Site URL |

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
npm run build      # build:assets tự fingerprint authUI.js + visualViewer.js, rồi next build
```

## 5. Hệ thống làm gì (để biết chính xác)

**Hạn mức token**
- Mỗi request AI: **đặt chỗ** token (nguyên tử trong Postgres, khóa theo user) → gọi model → **ghi token thật** từ phản hồi
  của provider → hoàn phần dư.
- Cạn `AI_TOKEN_LIMIT` → khóa `AI_COOLDOWN_MINUTES` phút. Trong thời gian khóa **server không gọi model**.
  Hết khóa → tự reset về 0 ở lần dùng kế tiếp. Không có cửa sổ reset thứ hai.
- Cooldown tính theo đồng hồ **database**; đăng xuất/đăng nhập/đổi thiết bị không né được.
- Request lỗi / cache hit / không gọi model → không tốn token. Reservation treo quá `AI_RESERVATION_TTL_SECONDS` → **bị tính phí
  phần đã đặt chỗ** (làm hỏng bước ghi nhận không thể thành "dùng miễn phí"); nếu ghi nhận đến muộn sẽ điều chỉnh về số thật.
- Request vượt hạn mức khi đang chạy vẫn hoàn tất (không cắt giữa câu trả lời) và được tính theo thực tế → có thể vượt nhẹ giới hạn.
- Chặn đồng thời `AI_MAX_CONCURRENT` request/user nên không thể vượt hạn mức hàng loạt bằng cách bắn song song.
- **Ảnh**: mỗi ảnh *server* sinh thành công = `AI_IMAGE_TOKEN_COST` token-tương-đương (cùng hạn mức/cooldown); ảnh lỗi / cache hit = 0.
  Ảnh sinh ở trình duyệt qua Puter không đi qua server nên không bị tính (chi phí nằm ở tài khoản Puter của người dùng).

**Chống tạo hàng loạt tài khoản (nhân hạn mức)** — ba lớp, chỉ có ý nghĩa khi dùng cùng nhau:
1. **Bật Confirm email** ở Supabase (lớp quan trọng nhất; PoW và rate-limit không thay thế được).
2. **Proof-of-work** tự host (không CSP/bên thứ ba): đăng ký và quên mật khẩu phải giải 1 bài toán SHA-256 ~1 giây; mỗi lời giải dùng 1 lần.
3. **Giới hạn/IP**: `RATE_LIMIT_SIGNUP` lần đăng ký/quên mật khẩu mỗi giờ.

Vì sao không dùng CAPTCHA (Turnstile/hCaptcha): widget bên thứ ba cần nới `script-src`/`frame-src` cho **mọi** người dùng (header CSP của
`vercel.json` là tĩnh), không gắn được SRI, và làm hỏng các test `cdn-sri` / `vercel-header-parity` của dự án. Nếu sau này bị lạm dụng
nặng, bật CAPTCHA của Supabase là bước tiếp theo hợp lý — nhưng phải chấp nhận nới CSP.

**Quên mật khẩu**: `/forgot` luôn trả cùng một thông điệp (không dò được email nào có tài khoản). Link trong thư đưa về site kèm token
trong `#fragment`; giao diện đọc token, **xoá nó khỏi URL ngay**, chỉ giữ trong bộ nhớ rồi gửi tới `/reset`. Sau khi đổi, người dùng đăng nhập lại.

## 6. Kiểm tra sau khi cài

1. Mở app khi chưa đăng nhập → hiện khung đăng nhập. Gửi câu hỏi bằng `curl` không cookie → 401.
2. Đăng ký → đăng nhập → F5 vẫn đăng nhập. Góc trên phải hiện `đã dùng / giới hạn`.
3. "Quên mật khẩu?" → nhận thư → bấm link → đặt mật khẩu mới → đăng nhập bằng mật khẩu mới.
4. Để thử cooldown nhanh: đặt tạm `AI_TOKEN_LIMIT=1000`, hỏi 1–2 câu → banner đếm ngược ~35 phút.
5. Supabase → Table editor → `ai_usage`: mỗi request 1 dòng với token thật.
6. `GET /api/health` → `auth.supabaseConfigured: true`.
7. Hỏi "Biểu diễn miền nghiệm của hệ bất phương trình x² + y² ≤ 9, y ≥ x" → ra hình; mở phóng to → có nút +/−/⟲ và Lưới/Trục.

## 7. Bất phương trình & miền nghiệm — phạm vi hỗ trợ

| Loại | Cách làm | Ghi chú |
|---|---|---|
| 1 ẩn (x hoặc y): bậc 1, bậc 2, `|…|`, chuỗi `−1 < x ≤ 3`, `≠`, `hoặc`, `và` | **đại số chính xác** (tập khoảng) | tối đa 8 điều kiện; tối đa 2 dấu `|…|` |
| 2 ẩn, tuyến tính | **đa giác chính xác** + đỉnh + điểm kiểm tra `M(1; 2)` | tối đa 8 điều kiện |
| 2 ẩn, cong (đường tròn, elip, parabol, hypebol, `|…|`, bậc ≤ 2) | lưới điểm + marching squares | biên là xấp xỉ ~3 px; không ghi đỉnh |
| Không hỗ trợ → không vẽ | bậc ≥ 3, hàm lượng giác/log/căn, phương trình `=`, > 2 ẩn, `hoặc`/`≠` trong mặt phẳng | rơi về nhánh khác, **không vẽ sai** |

Hệ vô nghiệm (tuyến tính / 1 ẩn) → báo thẳng. Miền cong mà lưới không tìm thấy điểm nào → **không kết luận vô nghiệm** (lưới thô có thể bỏ sót
miền rất nhỏ/rất xa), chỉ không vẽ.

## 8. Giới hạn còn lại (nói thẳng)

- Chưa được thử với dự án Supabase **thật** của bạn (tôi dùng GoTrue giả lập + Postgres thật + `rateLimit.js` thật). Hãy chạy mục 6 trước khi mở cho người dùng.
- Chưa chạy `next build` và toàn bộ `npm test` của dự án trong môi trường của tôi (không có `node_modules` của bạn). Hãy chạy `npm run build && npm test`.
- Người dùng vẫn có thể tạo nhiều tài khoản bằng nhiều email thật + nhiều IP; ba lớp ở mục 5 chỉ làm tăng chi phí, không chặn tuyệt đối.
- Request đang chạy khi chạm trần vẫn hoàn tất nên có thể vượt nhẹ hạn mức.
- Provider **không trả usage** (hiếm) → tính bảo thủ theo mức đặt chỗ, không tính 0.
- Số token hiển thị cập nhật sau mỗi lượt gọi AI (~1 giây sau khi stream kết thúc), không theo thời gian thực từng token.
- Bản dịch giao diện đăng nhập/quota/ảnh có tiếng Việt + tiếng Anh (đúng 2 ngôn ngữ dự án đang hỗ trợ); thông báo lỗi lấy theo mã lỗi nên dịch theo ngôn ngữ giao diện.
- Nút Lưới/Trục chỉ có với hình **miền nghiệm do server vẽ** (SVG có nhóm `layer-grid`/`layer-axes`); các hình khác chỉ có zoom/kéo.
