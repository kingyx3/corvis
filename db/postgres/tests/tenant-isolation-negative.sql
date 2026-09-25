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
values
  ('c0000000-0000-4000-8000-00000000000c','a0000000-0000-4000-8000-00000000000a','primary','Tenant A Primary'),
  ('c0000000-0000-4000-8000-00000000000b','b0000000-0000-4000-8000-00000000000b','primary','Tenant B Primary');

insert into corvis_control.membership (tenant_id,workspace_id,user_id,role_name)
values ('a0000000-0000-4000-8000-00000000000a','c0000000-0000-4000-8000-00000000000c',
        'd0000000-0000-4000-8000-00000000000d','viewer');

-- Portfolio attribution is workspace-scoped and must remain tenant-isolated even
-- when queried through its security-invoker serving views.
insert into corvis_identity.fund (global_fund_id,canonical_name)
values ('portfolio-rls-fund-a','Portfolio RLS Fund A'),('portfolio-rls-fund-b','Portfolio RLS Fund B');

insert into corvis_facts.client_portfolio
  (tenant_id,workspace_id,portfolio_id,portfolio_key,display_name)
values
  ('a0000000-0000-4000-8000-00000000000a','c0000000-0000-4000-8000-00000000000c','f0000000-0000-4000-8000-00000000000a','portfolio-a','Portfolio A'),
  ('b0000000-0000-4000-8000-00000000000b','c0000000-0000-4000-8000-00000000000b','f0000000-0000-4000-8000-00000000000b','portfolio-b','Portfolio B');

insert into corvis_facts.client_portfolio_fund_position
  (tenant_id,portfolio_fund_position_id,portfolio_id,position_key,fund_id)
values
  ('a0000000-0000-4000-8000-00000000000a','f1000000-0000-4000-8000-00000000000a','f0000000-0000-4000-8000-00000000000a','fund-a','portfolio-rls-fund-a'),
  ('b0000000-0000-4000-8000-00000000000b','f1000000-0000-4000-8000-00000000000b','f0000000-0000-4000-8000-00000000000b','fund-b','portfolio-rls-fund-b');

-- Company sector classifications (migration 055) are tenant-private even
-- though the company identity and the sector taxonomy are global.
insert into corvis_identity.company (global_company_id,canonical_name)
values ('sector-rls-company','Sector RLS Company')
on conflict (global_company_id) do nothing;
select corvis_facts.assign_company_sector('a0000000-0000-4000-8000-00000000000a','sector-rls-company','technology',0,'rls|a','tenant A view');
select corvis_facts.assign_company_sector('b0000000-0000-4000-8000-00000000000b','sector-rls-company','energy',0,'rls|b','tenant B view');

-- A genuinely non-owner, non-bypassrls role: RLS is not applied to the table
-- owner (this DB is built by the owner role) or to any role with BYPASSRLS,
-- so testing under the owner role would prove nothing about enforcement.
drop role if exists corvis_rls_negative_test_role;
create role corvis_rls_negative_test_role nologin nosuperuser nobypassrls noinherit;
grant usage on schema corvis_control,corvis_facts,corvis_serving,corvis_semantic to corvis_rls_negative_test_role;
grant select on corvis_control.tenant to corvis_rls_negative_test_role;
grant select on corvis_facts.client_portfolio,corvis_facts.client_portfolio_fund_position to corvis_rls_negative_test_role;
grant select on corvis_serving.client_portfolios,corvis_serving.client_portfolio_fund_positions to corvis_rls_negative_test_role;
grant select on corvis_facts.company_sector_classification,corvis_serving.company_sectors,corvis_semantic.sector to corvis_rls_negative_test_role;

set role corvis_rls_negative_test_role;

-- No claim set: auth.uid() is null, access functions match nothing, so a
-- role with live table/view SELECT grants still sees zero tenant/portfolio rows.
do $$
declare tenant_count integer; portfolio_count integer; position_count integer; sector_count integer;
begin
  set local request.jwt.claim.sub = '';
  select count(*) into tenant_count from corvis_control.tenant;
  select count(*) into portfolio_count from corvis_serving.client_portfolios;
  select count(*) into position_count from corvis_serving.client_portfolio_fund_positions;
  select count(*) into sector_count from corvis_serving.company_sectors;
  if tenant_count <> 0 or portfolio_count <> 0 or position_count <> 0 or sector_count <> 0 then
    raise exception 'expected no rows with no auth.uid(); tenant %, portfolio %, position %, sector %', tenant_count,portfolio_count,position_count,sector_count;
  end if;
end $$;

-- Claim set to tenant A's member: only tenant/workspace A data is visible,
-- never tenant B, through both base-table RLS and security-invoker views.
do $$
declare visible_ids uuid[]; portfolio_ids uuid[]; position_ids uuid[]; sector_codes text[];
begin
  set local request.jwt.claim.sub = 'd0000000-0000-4000-8000-00000000000d';
  select array_agg(tenant_id order by tenant_id) into visible_ids from corvis_control.tenant;
  if visible_ids is distinct from array['a0000000-0000-4000-8000-00000000000a'::uuid] then
    raise exception 'expected only tenant A visible for its member, saw %', visible_ids;
  end if;
  select array_agg(portfolio_id order by portfolio_id) into portfolio_ids from corvis_serving.client_portfolios;
  if portfolio_ids is distinct from array['f0000000-0000-4000-8000-00000000000a'::uuid] then
    raise exception 'expected only tenant A portfolio visible, saw %', portfolio_ids;
  end if;
  select array_agg(portfolio_fund_position_id order by portfolio_fund_position_id) into position_ids from corvis_serving.client_portfolio_fund_positions;
  if position_ids is distinct from array['f1000000-0000-4000-8000-00000000000a'::uuid] then
    raise exception 'expected only tenant A portfolio fund position visible, saw %', position_ids;
  end if;
  select array_agg(sector_code order by sector_code) into sector_codes from corvis_serving.company_sectors;
  if sector_codes is distinct from array['technology'] then
    raise exception 'expected only tenant A company sector visible, saw %', sector_codes;
  end if;
  if (select count(*) from corvis_facts.company_sector_classification) <> 1 then
    raise exception 'expected only tenant A classification history visible';
  end if;
end $$;

-- Claim set to a user with no membership anywhere: zero rows, not an error
-- and not every tenant/portfolio.
do $$
declare tenant_count integer; portfolio_count integer; position_count integer; sector_count integer;
begin
  set local request.jwt.claim.sub = 'e0000000-0000-4000-8000-00000000000e';
  select count(*) into tenant_count from corvis_control.tenant;
  select count(*) into portfolio_count from corvis_serving.client_portfolios;
  select count(*) into position_count from corvis_serving.client_portfolio_fund_positions;
  select count(*) into sector_count from corvis_serving.company_sectors;
  if tenant_count <> 0 or portfolio_count <> 0 or position_count <> 0 or sector_count <> 0 then
    raise exception 'expected no rows for unrelated user; tenant %, portfolio %, position %, sector %', tenant_count,portfolio_count,position_count,sector_count;
  end if;
end $$;

reset role;
drop owned by corvis_rls_negative_test_role;
drop role corvis_rls_negative_test_role;

rollback;
