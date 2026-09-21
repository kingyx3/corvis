-- CI-only compatibility shim for applying Corvis Supabase-targeted migrations
-- against vanilla PostgreSQL. This does not emulate Supabase authorization;
-- production migrations still bind RLS to Supabase auth.uid().
create schema if not exists auth;

create or replace function auth.uid()
returns uuid
language sql
stable
security invoker
as $$
  select null::uuid;
$$;
