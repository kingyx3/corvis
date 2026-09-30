-- Disposable database only. Minimal parent schema for isolated migration checks.
create schema corvis_control;
-- Roles are cluster-wide; an earlier CI step (the RLS security acceptance) may already have created them.
do $$
begin
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select from pg_roles where rolname = 'service_role') then create role service_role bypassrls; end if;
end
$$;
grant usage on schema corvis_control to service_role;
create table corvis_control.tenant (tenant_id uuid primary key);
insert into corvis_control.tenant values
 ('11111111-1111-1111-1111-111111111111'),
 ('22222222-2222-2222-2222-222222222222');
