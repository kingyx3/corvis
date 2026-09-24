-- RLS negative acceptance: proves row-level security actually denies
-- cross-tenant reads for a non-owner, non-bypass role, not just that it is
-- declared. Run after the full migration chain and supabase-auth-fixture.sql
-- (which makes auth.uid() readable from the "request.jwt.claim.sub" session
-- setting) on an isolated disposable database.
--
-- The application's own runtime connection is documented (migration 001) to
-- use a service-role-equivalent connection that intentionally bypasses RLS
-- and relies on explicit tenant_id predicates in repository code instead;
-- this test targets the other, previously unverified audience for RLS: a
-- plain non-owner, non-bypassrls role, such as a browser client querying
-- Supabase directly under the `authenticated` role, or an operator's direct
-- console connection.

\set ON_ERROR_STOP on

begin;

insert into corvis_control.tenant (tenant_id,slug,display_name)
values
  ('a0000000-0000-4000-8000-00000000000a','tenant-isolation-a','Tenant Isolation A'),
  ('b0000000-0000-4000-8000-00000000000b','tenant-isolation-b','Tenant Isolation B');

insert into corvis_control.workspace (workspace_id,tenant_id,slug,display_name)
values ('c0000000-0000-4000-8000-00000000000c','a0000000-0000-4000-8000-00000000000a','primary','Tenant A Primary');

insert into corvis_control.membership (tenant_id,workspace_id,user_id,role_name)
values ('a0000000-0000-4000-8000-00000000000a','c0000000-0000-4000-8000-00000000000c',
        'd0000000-0000-4000-8000-00000000000d','viewer');

-- A genuinely non-owner, non-bypassrls role: RLS is not applied to the table
-- owner (this DB is built by the owner role) or to any role with BYPASSRLS,
-- so testing under the owner role would prove nothing about enforcement.
drop role if exists corvis_rls_negative_test_role;
create role corvis_rls_negative_test_role nologin nosuperuser nobypassrls noinherit;
grant usage on schema corvis_control to corvis_rls_negative_test_role;
grant select on corvis_control.tenant to corvis_rls_negative_test_role;

set role corvis_rls_negative_test_role;

-- No claim set: auth.uid() is null, has_tenant_access matches nothing, so a
-- role with a live table-level SELECT grant still sees zero rows.
do $$
declare visible_count integer;
begin
  set local request.jwt.claim.sub = '';
  select count(*) into visible_count from corvis_control.tenant;
  if visible_count <> 0 then
    raise exception 'expected 0 tenant rows visible with no auth.uid() claim, saw %', visible_count;
  end if;
end $$;

-- Claim set to tenant A's member: only tenant A is visible, never tenant B.
do $$
declare visible_ids uuid[];
begin
  set local request.jwt.claim.sub = 'd0000000-0000-4000-8000-00000000000d';
  select array_agg(tenant_id order by tenant_id) into visible_ids from corvis_control.tenant;
  if visible_ids is distinct from array['a0000000-0000-4000-8000-00000000000a'::uuid] then
    raise exception 'expected only tenant A visible for its member, saw %', visible_ids;
  end if;
end $$;

-- Claim set to a user with no membership anywhere: zero rows, not an error
-- and not every tenant.
do $$
declare visible_count integer;
begin
  set local request.jwt.claim.sub = 'e0000000-0000-4000-8000-00000000000e';
  select count(*) into visible_count from corvis_control.tenant;
  if visible_count <> 0 then
    raise exception 'expected 0 tenant rows visible for an unrelated user, saw %', visible_count;
  end if;
end $$;

reset role;
drop owned by corvis_rls_negative_test_role;
drop role corvis_rls_negative_test_role;

rollback;
