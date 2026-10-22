-- ============================================================================================
-- Trợ Giải — Hạn mức token mặc định mỗi user = 50.000 (idempotent, chạy lại an toàn)
-- Chạy SAU 20261003000000_auth_quota_assets.sql.
--
--  * Server lấy mặc định từ AI_TOKEN_LIMIT (mặc định trong mã nay là 50000) và truyền vào ai_reserve /
--    ai_quota_status khi TẠO dòng ai_quota lần đầu. Migration này lo phần DỮ LIỆU ĐÃ CÓ + giá trị mặc định ở DB.
--  * Ghi đè từng user vẫn dùng cột ai_quota.token_limit (migration này đưa MỌI dòng hiện có về 50.000 một lần).
-- ============================================================================================
alter table public.ai_quota alter column token_limit set default 50000;

update public.ai_quota
   set token_limit = 50000, updated_at = now()
 where token_limit <> 50000;
