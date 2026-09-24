-- CI-only compatibility shim for applying Corvis Supabase-targeted migrations
-- against vanilla PostgreSQL. This does not emulate Supabase authorization;
-- production migrations still bind RLS to Supabase auth.uid().
create schema if not exists auth;

-- Mirrors Supabase's own auth.uid(): reads the subject claim PostgREST sets
-- per request as the "request.jwt.claim.sub" session setting, defaulting to
-- null exactly as before when nothing is set. Every existing fixture that
-- never sets this claim keeps seeing null (unaffected). A test that needs a
-- real RLS negative case can `set local request.jwt.claim.sub = '<uuid>';`
-- after `set role` to a non-owner test role (see tenant-isolation-negative.sql).
create or replace function auth.uid()
returns uuid
language sql
stable
security invoker
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
