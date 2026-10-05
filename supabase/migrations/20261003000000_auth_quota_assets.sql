-- ============================================================================================
-- Trợ Giải — Auth + Token Quota/Cooldown + Asset Manager (Supabase / Postgres)
-- Chạy MỘT LẦN trong Supabase Dashboard -> SQL Editor (hoặc `supabase db push`).
--
-- MÔ HÌNH QUOTA (một mô hình duy nhất — "reset sau cooldown"):
--   * Mỗi user có 1 hàng ai_quota. Dùng token -> tokens_used tăng.
--   * Khi tokens_used + tokens_reserved >= token_limit sau settle -> cooldown_until = now() + N phút.
--   * Trong cooldown: MỌI ai_reserve() bị từ chối (server không gọi model).
--   * Hết cooldown: ai_reserve()/ai_quota_status() tự reset tokens_used = 0, cooldown_until = null,
--     window_started_at = now() trong CÙNG transaction đang giữ khoá hàng.
--   * Không có cửa sổ reset thứ hai (không reset theo ngày/giờ).
--
-- BẢO MẬT:
--   * ai_quota / ai_usage: user chỉ SELECT dòng của mình. KHÔNG có policy INSERT/UPDATE/DELETE và
--     đã REVOKE quyền ghi => user không thể tự reset quota qua API Supabase công khai.
--   * Mọi ghi vào quota đi qua hàm SECURITY DEFINER (search_path rỗng), chỉ service_role được EXECUTE.
--   * Thời gian luôn là now() của database, không bao giờ là đồng hồ client/app.
--   * Vai trò admin nằm ở profiles.role; user KHÔNG có quyền UPDATE cột này (column privilege).
--     Server tra role bằng service_role; KHÔNG BAO GIỜ đọc role từ user_metadata (user tự sửa được).
-- ============================================================================================

-- ---------- 1. profiles ----------
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text,
  display_name text,
  avatar_url   text,
  role         text not null default 'user' check (role in ('user', 'admin')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- Cột nào user được sửa: CHỈ display_name, avatar_url. role/email/id không sửa được.
revoke insert, update, delete on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name, avatar_url) on public.profiles to authenticated;

-- Tạo profile tự động khi có user mới. SECURITY DEFINER + search_path rỗng (chống hijack schema).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, split_part(coalesce(new.email, ''), '@', 1))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill cho user đã tồn tại trước khi chạy migration (tài khoản cũ không được thành ngoại lệ).
insert into public.profiles (id, email, display_name)
select u.id, u.email, split_part(coalesce(u.email, ''), '@', 1)
from auth.users u
on conflict (id) do nothing;

-- ---------- 2. ai_quota ----------
create table if not exists public.ai_quota (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  tokens_used       bigint not null default 0 check (tokens_used >= 0),
  token_limit       bigint not null check (token_limit > 0),
  tokens_reserved   bigint not null default 0 check (tokens_reserved >= 0),
  window_started_at timestamptz not null default now(),
  cooldown_until    timestamptz,
  status            text not null default 'active' check (status in ('active', 'cooldown')),
  updated_at        timestamptz not null default now()
);

-- ---------- 3. ai_usage (sổ cái; mỗi request 1 dòng, request_id UNIQUE => idempotent) ----------
create table if not exists public.ai_usage (
  id               bigint generated always as identity primary key,
  user_id          uuid not null references auth.users(id) on delete cascade,
  request_id       text not null unique,
  kind             text not null default 'chat',
  provider         text,
  model            text,
  input_tokens     bigint not null default 0 check (input_tokens >= 0),
  output_tokens    bigint not null default 0 check (output_tokens >= 0),
  cached_tokens    bigint not null default 0 check (cached_tokens >= 0),
  estimated_tokens bigint not null default 0 check (estimated_tokens >= 0),
  reserved_tokens  bigint not null default 0 check (reserved_tokens >= 0),
  total_tokens     bigint not null default 0 check (total_tokens >= 0),
  status           text not null default 'reserved' check (status in ('reserved', 'settled', 'released', 'expired')),
  expires_at       timestamptz,
  created_at       timestamptz not null default now(),
  settled_at       timestamptz
);

create index if not exists ai_usage_user_created_idx on public.ai_usage (user_id, created_at desc);
create index if not exists ai_usage_user_reserved_idx on public.ai_usage (user_id) where status = 'reserved';

alter table public.ai_quota enable row level security;
alter table public.ai_usage enable row level security;

drop policy if exists ai_quota_select_own on public.ai_quota;
create policy ai_quota_select_own on public.ai_quota
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists ai_usage_select_own on public.ai_usage;
create policy ai_usage_select_own on public.ai_usage
  for select to authenticated
  using (user_id = (select auth.uid()));

-- KHÔNG có policy insert/update/delete + thu hồi quyền ghi: user không tự reset quota được.
revoke all on public.ai_quota from anon, authenticated;
revoke all on public.ai_usage from anon, authenticated;
grant select on public.ai_quota to authenticated;
grant select on public.ai_usage to authenticated;

-- ---------- 4. Hàm nội bộ: dọn reservation hết hạn + tính lại tokens_reserved từ sổ cái ----------
-- tokens_reserved luôn được TÍNH LẠI từ ai_usage (nguồn sự thật) => không thể trôi (drift) dù crash.
create or replace function public._ai_refresh_reserved(p_user uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reserved bigint;
  v_expired  bigint;
begin
  -- Reservation hết hạn = settle bị thất lạc (crash, function bị freeze...). FAIL-CLOSED: tính phí phần đã đặt chỗ
  -- (thay vì miễn phí) để việc làm hỏng settle không thể biến thành “dùng AI miễn phí”.
  -- Nếu settle đến muộn, ai_settle sẽ điều chỉnh chênh lệch (cả hai chiều) theo usage thật.
  with e as (
    update public.ai_usage
       set status = 'expired', settled_at = now(), total_tokens = reserved_tokens
     where user_id = p_user and status = 'reserved' and expires_at is not null and expires_at < now()
    returning reserved_tokens
  )
  select coalesce(sum(reserved_tokens), 0) into v_expired from e;

  if v_expired > 0 then
    update public.ai_quota set tokens_used = tokens_used + v_expired where user_id = p_user;
  end if;

  select coalesce(sum(reserved_tokens), 0) into v_reserved
    from public.ai_usage
   where user_id = p_user and status = 'reserved';

  update public.ai_quota set tokens_reserved = v_reserved, updated_at = now() where user_id = p_user;
  return v_reserved;
end;
$$;

-- ---------- 5. ai_reserve: kiểm tra + đặt chỗ NGUYÊN TỬ ----------
-- Trả jsonb: {ok:true, granted, remaining, ...} hoặc {ok:false, code, ...}
-- code: cooldown_active | quota_busy | too_many_concurrent
create or replace function public.ai_reserve(
  p_user                uuid,
  p_request_id          text,
  p_kind                text,
  p_estimate            bigint,
  p_default_limit       bigint,
  p_cooldown_minutes    int,
  p_max_concurrent      int,
  p_reservation_ttl_sec int,
  p_min_request         bigint default 500
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  q            public.ai_quota%rowtype;
  v_existing   public.ai_usage%rowtype;
  v_reserved   bigint;
  v_active     int;
  v_remaining  bigint;
  v_grant      bigint;
begin
  if p_estimate is null or p_estimate <= 0 then
    raise exception 'invalid_estimate';
  end if;

  -- Tạo hàng quota nếu chưa có (mọi user, kể cả tài khoản cũ/không profile, đều bị giới hạn).
  insert into public.ai_quota (user_id, token_limit)
  values (p_user, p_default_limit)
  on conflict (user_id) do nothing;

  -- KHOÁ hàng quota: mọi request song song của CÙNG user xếp hàng tại đây.
  select * into q from public.ai_quota where user_id = p_user for update;

  -- Idempotency: cùng request_id không reserve/ghi lần hai.
  select * into v_existing from public.ai_usage where request_id = p_request_id;
  if found then
    if v_existing.user_id <> p_user then
      raise exception 'request_id_conflict';
    end if;
    return jsonb_build_object('ok', true, 'duplicate', true, 'status', v_existing.status,
                              'granted', v_existing.reserved_tokens);
  end if;

  v_reserved := public._ai_refresh_reserved(p_user);
  -- Refresh có thể vừa tính phí reservation hết hạn => đọc LẠI hàng (nếu không, tokens_used bị cũ).
  select * into q from public.ai_quota where user_id = p_user;

  -- Hết cooldown -> reset trong cùng transaction.
  if q.cooldown_until is not null and q.cooldown_until <= now() then
    update public.ai_quota
       set tokens_used = 0, cooldown_until = null, status = 'active',
           window_started_at = now(), updated_at = now()
     where user_id = p_user;
    q.tokens_used := 0; q.cooldown_until := null; q.status := 'active';
  end if;

  -- Đang cooldown -> từ chối, server không được gọi model.
  if q.cooldown_until is not null and q.cooldown_until > now() then
    return jsonb_build_object('ok', false, 'code', 'cooldown_active',
      'cooldown_until', q.cooldown_until,
      'retry_after_seconds', greatest(1, ceil(extract(epoch from (q.cooldown_until - now())))::int),
      'tokens_used', q.tokens_used, 'token_limit', q.token_limit);
  end if;

  -- Giới hạn số request AI đồng thời của mỗi user.
  select count(*) into v_active from public.ai_usage where user_id = p_user and status = 'reserved';
  if v_active >= p_max_concurrent then
    return jsonb_build_object('ok', false, 'code', 'too_many_concurrent',
      'retry_after_seconds', 3, 'active', v_active, 'max_concurrent', p_max_concurrent);
  end if;

  v_remaining := q.token_limit - q.tokens_used - v_reserved;

  if v_remaining >= p_estimate then
    v_grant := p_estimate;
  elsif v_remaining >= p_min_request then
    -- Còn ít hơn mức ước lượng nhưng vẫn dùng được: đặt chỗ phần còn lại (settle sẽ tính theo thực tế).
    v_grant := v_remaining;
  else
    -- Gần như cạn. Nếu còn request đang chạy -> có thể chúng sẽ trả bớt; bảo user thử lại ngay.
    if v_reserved > 0 then
      return jsonb_build_object('ok', false, 'code', 'quota_busy', 'retry_after_seconds', 5,
        'tokens_used', q.tokens_used, 'token_limit', q.token_limit);
    end if;
    -- Không còn gì đang chạy và còn dưới mức tối thiểu hữu ích => coi như cạn, bắt đầu cooldown
    -- (tránh trạng thái kẹt vĩnh viễn: còn vài token nhưng không đủ cho request nào, không reset).
    update public.ai_quota
       set cooldown_until = now() + make_interval(mins => p_cooldown_minutes),
           status = 'cooldown', updated_at = now()
     where user_id = p_user
    returning cooldown_until into q.cooldown_until;
    return jsonb_build_object('ok', false, 'code', 'cooldown_active',
      'cooldown_until', q.cooldown_until,
      'retry_after_seconds', greatest(1, ceil(extract(epoch from (q.cooldown_until - now())))::int),
      'tokens_used', q.tokens_used, 'token_limit', q.token_limit);
  end if;

  insert into public.ai_usage (user_id, request_id, kind, reserved_tokens, estimated_tokens, status, expires_at)
  values (p_user, p_request_id, coalesce(p_kind, 'chat'), v_grant, p_estimate, 'reserved',
          now() + make_interval(secs => p_reservation_ttl_sec));

  update public.ai_quota
     set tokens_reserved = v_reserved + v_grant, updated_at = now()
   where user_id = p_user;

  return jsonb_build_object('ok', true, 'duplicate', false, 'granted', v_grant,
    'tokens_used', q.tokens_used, 'tokens_reserved', v_reserved + v_grant,
    'token_limit', q.token_limit, 'remaining', q.token_limit - q.tokens_used - v_reserved - v_grant);
end;
$$;

-- ---------- 6. ai_settle: ghi usage THẬT, hoàn phần dư, kích hoạt cooldown ----------
create or replace function public.ai_settle(
  p_user             uuid,
  p_request_id       text,
  p_input            bigint,
  p_output           bigint,
  p_cached           bigint,
  p_total            bigint,
  p_provider         text,
  p_model            text,
  p_cooldown_minutes int
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  q          public.ai_quota%rowtype;
  u          public.ai_usage%rowtype;
  v_total    bigint := greatest(coalesce(p_total, 0), 0);
  v_prev     bigint := 0;
  v_reserved bigint;
begin
  select * into q from public.ai_quota where user_id = p_user for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'no_quota_row');
  end if;

  -- Nhả các reservation đã quá hạn của user trước (kèm tính phí bảo thủ), rồi mới đọc dòng của request này.
  perform public._ai_refresh_reserved(p_user);

  select * into u from public.ai_usage where request_id = p_request_id and user_id = p_user;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'unknown_request');
  end if;
  if u.status = 'settled' then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;
  if u.status = 'released' then
    return jsonb_build_object('ok', true, 'duplicate', true, 'ignored', 'already_released');
  end if;

  -- 'expired' đã bị tính phí = reserved_tokens: chỉ điều chỉnh phần chênh lệch (có thể âm = hoàn lại).
  if u.status = 'expired' then v_prev := u.total_tokens; end if;

  update public.ai_usage
     set status = 'settled', settled_at = now(),
         input_tokens = greatest(coalesce(p_input, 0), 0),
         output_tokens = greatest(coalesce(p_output, 0), 0),
         cached_tokens = greatest(coalesce(p_cached, 0), 0),
         total_tokens = v_total,
         provider = coalesce(p_provider, provider),
         model = coalesce(p_model, model)
   where id = u.id;

  update public.ai_quota set tokens_used = greatest(tokens_used + (v_total - v_prev), 0) where user_id = p_user;
  v_reserved := public._ai_refresh_reserved(p_user);

  select * into q from public.ai_quota where user_id = p_user;

  if (q.cooldown_until is null or q.cooldown_until <= now())
     and q.tokens_used + v_reserved >= q.token_limit then
    update public.ai_quota
       set cooldown_until = now() + make_interval(mins => p_cooldown_minutes),
           status = 'cooldown', updated_at = now()
     where user_id = p_user
    returning cooldown_until into q.cooldown_until;
  end if;

  return jsonb_build_object('ok', true, 'duplicate', false, 'charged', v_total,
    'tokens_used', q.tokens_used, 'tokens_reserved', v_reserved, 'token_limit', q.token_limit,
    'cooldown_until', q.cooldown_until);
end;
$$;

-- ---------- 7. ai_release: request thất bại, provider không tính phí ----------
create or replace function public.ai_release(p_user uuid, p_request_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  q public.ai_quota%rowtype;
begin
  select * into q from public.ai_quota where user_id = p_user for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'no_quota_row');
  end if;
  perform public._ai_refresh_reserved(p_user);
  update public.ai_usage
     set status = 'released', settled_at = now()
   where request_id = p_request_id and user_id = p_user and status = 'reserved';
  perform public._ai_refresh_reserved(p_user);
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------- 8. ai_quota_status: đọc trạng thái cho UI (cũng tự reset khi hết cooldown) ----------
create or replace function public.ai_quota_status(
  p_user          uuid,
  p_default_limit bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  q          public.ai_quota%rowtype;
  v_reserved bigint;
begin
  insert into public.ai_quota (user_id, token_limit)
  values (p_user, p_default_limit)
  on conflict (user_id) do nothing;

  select * into q from public.ai_quota where user_id = p_user for update;
  v_reserved := public._ai_refresh_reserved(p_user);
  select * into q from public.ai_quota where user_id = p_user; -- đọc lại sau khi refresh (có thể vừa tính phí reservation hết hạn)

  if q.cooldown_until is not null and q.cooldown_until <= now() then
    update public.ai_quota
       set tokens_used = 0, cooldown_until = null, status = 'active',
           window_started_at = now(), updated_at = now()
     where user_id = p_user;
    q.tokens_used := 0; q.cooldown_until := null; q.status := 'active';
  end if;

  return jsonb_build_object(
    'tokens_used', q.tokens_used,
    'tokens_reserved', v_reserved,
    'token_limit', q.token_limit,
    'remaining', greatest(q.token_limit - q.tokens_used - v_reserved, 0),
    'cooldown_until', q.cooldown_until,
    'retry_after_seconds', case when q.cooldown_until is not null and q.cooldown_until > now()
        then greatest(1, ceil(extract(epoch from (q.cooldown_until - now())))::int) else 0 end,
    'status', case when q.cooldown_until is not null and q.cooldown_until > now() then 'cooldown' else 'active' end,
    'server_time', now()
  );
end;
$$;

-- Dọn reservation treo toàn hệ thống (gọi từ cron/pg_cron nếu muốn; không bắt buộc vì mỗi lần
-- reserve/status của user đã tự dọn phần của chính user đó).
create or replace function public.ai_sweep_expired()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  n bigint;
begin
  with e as (
    update public.ai_usage set status = 'expired', settled_at = now(), total_tokens = reserved_tokens
     where status = 'reserved' and expires_at is not null and expires_at < now()
    returning user_id, reserved_tokens
  ), s as (
    select user_id, sum(reserved_tokens) as t from e group by user_id
  ), c as (
    update public.ai_quota q set tokens_used = q.tokens_used + s.t from s where q.user_id = s.user_id returning 1
  )
  select (select count(*) from e) into n;

  update public.ai_quota q
     set tokens_reserved = coalesce((
           select sum(u.reserved_tokens) from public.ai_usage u where u.user_id = q.user_id and u.status = 'reserved'
         ), 0),
         updated_at = now()
   where q.tokens_reserved <> coalesce((
           select sum(u.reserved_tokens) from public.ai_usage u where u.user_id = q.user_id and u.status = 'reserved'
         ), 0);
  return n;
end;
$$;

-- Chỉ service_role (server của bạn) được gọi các hàm này. anon/authenticated KHÔNG.
revoke execute on function public._ai_refresh_reserved(uuid) from public, anon, authenticated;
revoke execute on function public.ai_reserve(uuid, text, text, bigint, bigint, int, int, int, bigint) from public, anon, authenticated;
revoke execute on function public.ai_settle(uuid, text, bigint, bigint, bigint, bigint, text, text, int) from public, anon, authenticated;
revoke execute on function public.ai_release(uuid, text) from public, anon, authenticated;
revoke execute on function public.ai_quota_status(uuid, bigint) from public, anon, authenticated;
revoke execute on function public.ai_sweep_expired() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

grant execute on function public.ai_reserve(uuid, text, text, bigint, bigint, int, int, int, bigint) to service_role;
grant execute on function public.ai_settle(uuid, text, bigint, bigint, bigint, bigint, text, text, int) to service_role;
grant execute on function public.ai_release(uuid, text) to service_role;
grant execute on function public.ai_quota_status(uuid, bigint) to service_role;
grant execute on function public.ai_sweep_expired() to service_role;

-- ---------- 9. site_assets (Asset Manager) ----------
create table if not exists public.site_assets (
  key          text primary key check (key ~ '^[a-z0-9_]{2,40}$'),
  storage_path text not null,
  content_type text not null,
  alt          text not null default '',
  version      integer not null default 1 check (version > 0),
  updated_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.site_assets enable row level security;

-- Asset toàn site là dữ liệu CÔNG KHAI (favicon, logo...): ai cũng đọc được metadata.
drop policy if exists site_assets_public_read on public.site_assets;
create policy site_assets_public_read on public.site_assets
  for select to anon, authenticated
  using (true);

-- Ghi: không có policy nào cho anon/authenticated => chỉ service_role (server, sau khi kiểm tra admin).
revoke insert, update, delete on public.site_assets from anon, authenticated;
grant select on public.site_assets to anon, authenticated;

-- Bucket Storage công khai (đọc). Ghi chỉ qua service_role; KHÔNG tạo policy ghi trên storage.objects.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('site-assets', 'site-assets', true, 1048576, array['image/png', 'image/jpeg', 'image/webp', 'image/x-icon'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------- 10. Tạo admin ĐẦU TIÊN (chạy tay trong SQL Editor, KHÔNG qua ứng dụng) ----------
-- update public.profiles set role = 'admin' where email = 'ban@example.com';
