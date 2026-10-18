-- ============================================================================================
-- Trợ Giải — Hồ sơ người dùng: đọc dữ liệu từ Google OAuth + cột bio/phone (ADDITIVE, idempotent)
-- Chạy SAU 20261003000000_auth_quota_assets.sql. Chạy lại nhiều lần an toàn.
--
-- Phạm vi (không đổi/xóa gì đang có):
--   1. Thêm cột public.profiles.bio, public.profiles.phone (nullable).
--   2. Thay hàm public.handle_new_user(): lấy tên/ảnh từ raw_user_meta_data
--        tên : full_name | name       -> profiles.display_name  (cột display_name ĐÃ CÓ; không tạo thêm full_name)
--        ảnh : avatar_url | picture   -> profiles.avatar_url
--      Dữ liệu này do CLIENT/NHÀ CUNG CẤP kiểm soát (email signup cho phép tự gửi options.data) nên được làm sạch:
--      bỏ ký tự điều khiển/zero-width, cắt 60 ký tự, chỉ nhận ảnh https:// <= 2048 ký tự. Không bao giờ ném lỗi
--      làm hỏng việc đăng ký: giá trị xấu -> bỏ qua, quay về phần local của email.
--   3. Trigger tự cập nhật updated_at.
--   4. Quyền cột: user được sửa display_name, avatar_url, bio, phone. KHÔNG sửa được id/email/role.
-- ============================================================================================

-- ---------- 1. Cột mới ----------
alter table public.profiles add column if not exists bio   text;
alter table public.profiles add column if not exists phone text;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.profiles'::regclass and conname = 'profiles_bio_len') then
    alter table public.profiles add constraint profiles_bio_len
      check (bio is null or char_length(bio) <= 280);
  end if;

  if not exists (select 1 from pg_constraint where conrelid = 'public.profiles'::regclass and conname = 'profiles_phone_fmt') then
    alter table public.profiles add constraint profiles_phone_fmt
      check (phone is null or phone ~ '^\+?[0-9 ().-]{6,20}$');
  end if;

  -- avatar_url: chỉ https. NOT VALID = chỉ kiểm tra dòng mới/được sửa, không làm migration thất bại vì dữ liệu cũ.
  if not exists (select 1 from pg_constraint where conrelid = 'public.profiles'::regclass and conname = 'profiles_avatar_https') then
    alter table public.profiles add constraint profiles_avatar_https
      check (avatar_url is null or (avatar_url ~ '^https://' and char_length(avatar_url) <= 2048)) not valid;
  end if;
end
$$;

-- ---------- 2. handle_new_user(): đọc metadata (Google: name/picture; email signup: full_name) ----------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meta   jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_name   text;
  v_avatar text;
begin
  -- Chỉ nhận giá trị kiểu chuỗi JSON (số/object/mảng bị bỏ qua).
  -- Tên: full_name rồi name; bỏ ký tự điều khiển + zero-width/bidi (khớp BAD_NAME_CHARS ở server); gộp khoảng trắng; cắt 60 ký tự.
  v_name := coalesce(
    nullif(btrim(case when jsonb_typeof(v_meta -> 'full_name') = 'string' then v_meta ->> 'full_name' end), ''),
    nullif(btrim(case when jsonb_typeof(v_meta -> 'name') = 'string' then v_meta ->> 'name' end), '')
  );
  if v_name is not null then
    v_name := regexp_replace(left(v_name, 200), '[[:cntrl:]\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]', '', 'g');
    v_name := regexp_replace(btrim(v_name), '\s+', ' ', 'g');
    v_name := nullif(btrim(left(v_name, 60)), '');
  end if;
  v_name := coalesce(v_name, nullif(left(split_part(coalesce(new.email, ''), '@', 1), 60), ''));

  -- Ảnh: avatar_url rồi picture (chỉ chuỗi JSON); chỉ https, không khoảng trắng, <= 2048 ký tự; ngược lại bỏ.
  v_avatar := coalesce(
    nullif(btrim(case when jsonb_typeof(v_meta -> 'avatar_url') = 'string' then v_meta ->> 'avatar_url' end), ''),
    nullif(btrim(case when jsonb_typeof(v_meta -> 'picture') = 'string' then v_meta ->> 'picture' end), '')
  );
  if v_avatar is not null and (v_avatar !~ '^https://[^[:space:]]+$' or char_length(v_avatar) > 2048) then
    v_avatar := null;
  end if;

  insert into public.profiles (id, email, display_name, avatar_url)
  values (new.id, new.email, v_name, v_avatar)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- ---------- 3. updated_at tự cập nhật ----------
create or replace function public.set_profiles_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_profiles_updated_at();

-- ---------- 4. Quyền cột ----------
-- (RLS đã bật + policy select/update "chỉ chính mình" từ migration trước; không đổi.)
grant update (display_name, avatar_url, bio, phone) on public.profiles to authenticated;
