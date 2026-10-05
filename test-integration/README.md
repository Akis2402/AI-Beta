# Test tích hợp Auth + Quota (Postgres thật)

Kiểm tra middleware thật (`requireUser`, `reserveQuota`, `/api/auth/*`) + các hàm SQL `ai_reserve / ai_settle / ai_release`
chạy trên **Postgres thật**. Supabase Auth (GoTrue) được giả lập bằng một HTTP server nhỏ trong file test.

Không nằm trong `npm test` vì cần Postgres. Bộ unit không cần DB: `node test/auth-quota-unit.test.js`.

## Chạy

```bash
# 1. Postgres cục bộ bất kỳ (docker: docker run -d -p 5433:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16)
createdb -h localhost -p 5433 -U postgres tgtest

# 2. Schema giả lập Supabase, rồi migration thật
psql -h localhost -p 5433 -U postgres -d tgtest -v ON_ERROR_STOP=1 -f test-integration/stub-supabase.sql
psql -h localhost -p 5433 -U postgres -d tgtest -v ON_ERROR_STOP=1 -f supabase/migrations/20261003000000_auth_quota_assets.sql

# 3. Chạy (pg chỉ cần cho test, không thêm vào dependencies)
npm i --no-save pg
PGHOST=localhost PGPORT=5433 PGDATABASE=tgtest PGUSER=postgres node test-integration/auth-quota.integration.js
```

Test tự `TRUNCATE ai_usage, ai_quota` trước khi chạy — **chỉ trỏ vào DB test**, không bao giờ vào DB thật.

## Bao phủ (35 kiểm tra)

Chưa đăng nhập bị chặn trước khi gọi model · đăng ký/đăng nhập/cookie httpOnly · không dò được email tồn tại · settle theo
**usage thật** (không phải mức đặt chỗ) · giới hạn đồng thời (6 request song song → 2 qua) · lỗi provider/cache hit không tốn
token · client ngắt giữa chừng vẫn tính token đã tiêu · chặn Origin lạ · cạn quota → cooldown 35 phút, model không được gọi ·
cooldown sống sót qua logout/login · quota tách biệt giữa user · hết cooldown tự reset (đồng hồ DB) · refresh token tự động ·
Supabase chết → fail-closed 503.
