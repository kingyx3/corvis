-- Disposable database only. Roles the rate-limit acceptance checks expect to exist before the migrations run.
-- Roles are cluster-wide; an earlier CI step (the RLS security acceptance) may already have created them.
do $$
begin
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select from pg_roles where rolname = 'service_role') then create role service_role bypassrls; end if;
end
$$;
