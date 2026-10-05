-- Schema GIẢ LẬP tối thiểu của Supabase để chạy test tích hợp trên Postgres thường.
-- CHỈ DÙNG CHO TEST. KHÔNG chạy trên dự án Supabase thật (đã có sẵn các role/schema này).
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create schema storage;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
grant usage on schema public, auth to anon, authenticated, service_role;
grant select on auth.users to service_role;
