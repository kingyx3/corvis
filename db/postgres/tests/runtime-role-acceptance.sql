-- Runtime-role acceptance (#227): the tenant-isolation negatives of security_acceptance.sql and tenant-isolation-negative.sql,
-- run AS the least-privilege application role `corvis_runtime` (migration 100), with row level security enforced because
-- the role owns nothing and has no BYPASSRLS -- no owner bypass anywhere in the checked phases.
--
-- Fixtures are written by the session's own (owner) role; everything after `set local role corvis_runtime` runs with the
-- runtime role's real privileges. Run after the full migration chain and supabase-auth-fixture.sql on an isolated
-- disposable database. The whole probe rolls back.
--
-- Contract proved here:
--   1. Service context (no end-user subject bound -- how the application connects today): the role does its job
--      (reads, writes and calls the granted functions across tenants) and nothing else (no DDL, no append-only
--      mutation, no ungranted table or function, no escape from RLS).
--   2. Subject-bound context (`request.jwt.claim.sub` set, as for a PostgREST/console session or a future per-request
--      binding): the SAME connected role is held to the tenant/workspace policies -- tenant A's member sees exactly
--      tenant A through base tables and through every security-invoker serving view, tenant B's member exactly tenant B,
--      an unrelated subject nothing, server-only tables nothing, and no write is accepted.

\set ON_ERROR_STOP on
\set QUIET 1
\o /dev/null

begin;

-- ------------------------------------------------------------------ fixtures (owner phase)
select set_config('corvis.rt.tenant_a', gen_random_uuid()::text, false);
select set_config('corvis.rt.tenant_b', gen_random_uuid()::text, false);
select set_config('corvis.rt.workspace_a', gen_random_uuid()::text, false);
select set_config('corvis.rt.workspace_b', gen_random_uuid()::text, false);
select set_config('corvis.rt.user_a', gen_random_uuid()::text, false);
select set_config('corvis.rt.user_b', gen_random_uuid()::text, false);
select set_config('corvis.rt.user_x', gen_random_uuid()::text, false);
select set_config('corvis.rt.doc_a', gen_random_uuid()::text, false);
select set_config('corvis.rt.doc_b', gen_random_uuid()::text, false);
select set_config('corvis.rt.export_a', gen_random_uuid()::text, false);
select set_config('corvis.rt.export_b', gen_random_uuid()::text, false);
select set_config('corvis.rt.portfolio_a', gen_random_uuid()::text, false);
select set_config('corvis.rt.portfolio_b', gen_random_uuid()::text, false);

insert into corvis_control.tenant (tenant_id, slug, display_name) values
  (current_setting('corvis.rt.tenant_a')::uuid, 'rt-acceptance-a-' || left(current_setting('corvis.rt.tenant_a'), 8), 'Runtime acceptance A'),
  (current_setting('corvis.rt.tenant_b')::uuid, 'rt-acceptance-b-' || left(current_setting('corvis.rt.tenant_b'), 8), 'Runtime acceptance B');
insert into corvis_control.workspace (workspace_id, tenant_id, slug, display_name) values
  (current_setting('corvis.rt.workspace_a')::uuid, current_setting('corvis.rt.tenant_a')::uuid, 'rt-a', 'Runtime A'),
  (current_setting('corvis.rt.workspace_b')::uuid, current_setting('corvis.rt.tenant_b')::uuid, 'rt-b', 'Runtime B');
insert into corvis_control.membership (tenant_id, workspace_id, user_id, role_name) values
  (current_setting('corvis.rt.tenant_a')::uuid, current_setting('corvis.rt.workspace_a')::uuid, current_setting('corvis.rt.user_a')::uuid, 'analyst'),
  (current_setting('corvis.rt.tenant_b')::uuid, current_setting('corvis.rt.workspace_b')::uuid, current_setting('corvis.rt.user_b')::uuid, 'analyst');
insert into corvis_control.feature_flag (tenant_id, flag_key, enabled) values
  (current_setting('corvis.rt.tenant_a')::uuid, 'rt_acceptance', true),
  (current_setting('corvis.rt.tenant_b')::uuid, 'rt_acceptance', false);
insert into corvis_control.control_evidence (tenant_id, evidence_id, control_code, evidence_type, result, generated_by) values
  (current_setting('corvis.rt.tenant_a')::uuid, gen_random_uuid(), 'RT_ACCEPTANCE', 'synthetic', 'pass', 'rt-acceptance'),
  (current_setting('corvis.rt.tenant_b')::uuid, gen_random_uuid(), 'RT_ACCEPTANCE', 'synthetic', 'pass', 'rt-acceptance');
insert into corvis_source.document (tenant_id, document_id, display_name, media_type, status, created_by) values
  (current_setting('corvis.rt.tenant_a')::uuid, current_setting('corvis.rt.doc_a')::uuid, 'Tenant A synthetic.pdf', 'application/pdf', 'registered', 'rt-acceptance'),
  (current_setting('corvis.rt.tenant_b')::uuid, current_setting('corvis.rt.doc_b')::uuid, 'Tenant B synthetic.pdf', 'application/pdf', 'registered', 'rt-acceptance');
insert into corvis_serving.export_job (tenant_id, export_id, requested_by, format, state) values
  (current_setting('corvis.rt.tenant_a')::uuid, current_setting('corvis.rt.export_a')::uuid, 'rt-acceptance', 'csv', 'queued'),
  (current_setting('corvis.rt.tenant_b')::uuid, current_setting('corvis.rt.export_b')::uuid, 'rt-acceptance', 'csv', 'queued');
-- A server-only table (RLS enabled and forced, no end-user policy at all).
insert into corvis_control.idempotency_key (tenant_id, scope, idempotency_key, request_hash, expires_at) values
  (current_setting('corvis.rt.tenant_a')::uuid, 'rt-acceptance', 'key-a', 'hash-a', now() + interval '1 hour'),
  (current_setting('corvis.rt.tenant_b')::uuid, 'rt-acceptance', 'key-b', 'hash-b', now() + interval '1 hour');
-- Identity graph, holdings, snapshots, portfolios and sector classifications behind the serving views.
insert into corvis_identity.fund (global_fund_id, canonical_name) values ('rt-fund-a', 'Runtime Fund A'), ('rt-fund-b', 'Runtime Fund B');
insert into corvis_identity.company (global_company_id, canonical_name) values ('rt-company-a', 'Runtime Company A'), ('rt-company-b', 'Runtime Company B');
insert into corvis_facts.holding (tenant_id, fund_id, target_type, target_company_id, review_state) values
  (current_setting('corvis.rt.tenant_a')::uuid, 'rt-fund-a', 'company', 'rt-company-a', 'approved'),
  (current_setting('corvis.rt.tenant_b')::uuid, 'rt-fund-b', 'company', 'rt-company-b', 'approved');
insert into corvis_consolidated.fund_period_snapshot (tenant_id, fund_id, report_period, version, status, schema_version, taxonomy_version) values
  (current_setting('corvis.rt.tenant_a')::uuid, 'rt-fund-a', '2025Q4', 1, 'draft', '1', '1'),
  (current_setting('corvis.rt.tenant_b')::uuid, 'rt-fund-b', '2025Q4', 1, 'draft', '1', '1');
insert into corvis_facts.client_portfolio (tenant_id, workspace_id, portfolio_id, portfolio_key, display_name) values
  (current_setting('corvis.rt.tenant_a')::uuid, current_setting('corvis.rt.workspace_a')::uuid, current_setting('corvis.rt.portfolio_a')::uuid, 'rt-portfolio-a', 'Portfolio A'),
  (current_setting('corvis.rt.tenant_b')::uuid, current_setting('corvis.rt.workspace_b')::uuid, current_setting('corvis.rt.portfolio_b')::uuid, 'rt-portfolio-b', 'Portfolio B');
insert into corvis_facts.client_portfolio_fund_position (tenant_id, portfolio_fund_position_id, portfolio_id, position_key, fund_id) values
  (current_setting('corvis.rt.tenant_a')::uuid, gen_random_uuid(), current_setting('corvis.rt.portfolio_a')::uuid, 'fund-a', 'rt-fund-a'),
  (current_setting('corvis.rt.tenant_b')::uuid, gen_random_uuid(), current_setting('corvis.rt.portfolio_b')::uuid, 'fund-b', 'rt-fund-b');
select corvis_facts.assign_company_sector(current_setting('corvis.rt.tenant_a')::uuid, 'rt-company-a', 'technology', 0, 'rt|a', 'tenant A view');

-- ------------------------------------------------------------------ the runtime role, with RLS enforced
set local role corvis_runtime;
set local row_security = on;

do $$
begin
  if current_user <> 'corvis_runtime' then raise exception 'expected to run as corvis_runtime, running as %', current_user; end if;
  if exists (select 1 from pg_roles where rolname = current_user and (rolsuper or rolbypassrls)) then
    raise exception 'the runtime role must be neither superuser nor BYPASSRLS';
  end if;
  if exists (select 1 from pg_class where relowner = (select oid from pg_roles where rolname = current_user)) then
    raise exception 'the runtime role must own no relation (the owner is the one role RLS is not forced on by default)';
  end if;
end $$;

-- Helpers live in the temp schema, owned by the runtime role itself (a temp function needs only the TEMP privilege).
create function pg_temp.expect_sqlstate(p_label text, p_statement text, p_expected text) returns void language plpgsql as $$
declare v_got text := 'no error';
begin
  begin
    execute p_statement;
  exception when others then
    v_got := sqlstate;
  end;
  if v_got is distinct from p_expected then
    raise exception '%: expected SQLSTATE % but got % for: %', p_label, p_expected, v_got, p_statement;
  end if;
end $$;

-- A subject-bound session sees exactly its own tenant in every table and view, and none of the other's.
create function pg_temp.assert_scoped(p_label text, p_subject uuid, p_own uuid, p_other uuid, p_expect_own boolean) returns void language plpgsql as $$
declare
  v_rel text;
  v_own bigint;
  v_other bigint;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_subject::text, ''), true);
  foreach v_rel in array array[
    'corvis_control.tenant', 'corvis_control.workspace', 'corvis_control.membership', 'corvis_control.feature_flag',
    'corvis_control.control_evidence', 'corvis_source.document', 'corvis_serving.export_job', 'corvis_facts.holding',
    'corvis_consolidated.fund_period_snapshot', 'corvis_facts.client_portfolio', 'corvis_facts.client_portfolio_fund_position',
    -- security-invoker serving views (the ten older ones were owner-evaluated before migration 100)
    'corvis_serving.documents', 'corvis_serving.holdings', 'corvis_serving.fund_period_snapshots',
    'corvis_serving.client_portfolios', 'corvis_serving.client_portfolio_fund_positions'
  ] loop
    execute format('select count(*) filter (where tenant_id = %L), count(*) filter (where tenant_id = %L) from %s',
      p_own, p_other, v_rel) into v_own, v_other;
    if v_other <> 0 then raise exception '%: % leaks % row(s) of another tenant', p_label, v_rel, v_other; end if;
    if p_expect_own and v_own < 1 then raise exception '%: % hides the subject''s own tenant', p_label, v_rel; end if;
    if not p_expect_own and v_own <> 0 then raise exception '%: % shows rows to a subject without membership', p_label, v_rel; end if;
    -- No other tenant may appear at all (not merely the one under test).
    execute format('select count(*) from %s where tenant_id <> %L', v_rel, p_own) into v_other;
    if v_other <> 0 and p_expect_own then raise exception '%: % shows % row(s) of tenants other than the subject''s', p_label, v_rel, v_other; end if;
  end loop;
  -- Server-only tables stay invisible to a subject-bound session, even connected as the runtime role.
  select count(*) into v_other from corvis_control.idempotency_key;
  if v_other <> 0 then raise exception '%: server-only corvis_control.idempotency_key is visible to a subject-bound session', p_label; end if;
  -- Company sector classifications (global company, tenant-private view) and their serving view.
  if (select count(*) from corvis_facts.company_sector_classification where tenant_id = p_other) <> 0
     or (select count(*) from corvis_serving.company_sectors where tenant_id = p_other) <> 0 then
    raise exception '%: sector classification leaks another tenant', p_label;
  end if;
end $$;

-- ------------------------------------------------------------------ 1. service context (the application's own mode)
do $$
declare
  a uuid := current_setting('corvis.rt.tenant_a')::uuid;
  b uuid := current_setting('corvis.rt.tenant_b')::uuid;
  v_rows integer;
begin
  if (select count(*) from corvis_control.tenant where tenant_id in (a, b)) <> 2
     or (select count(*) from corvis_source.document where tenant_id in (a, b)) <> 2
     or (select count(*) from corvis_serving.documents where tenant_id in (a, b)) <> 2
     or (select count(*) from corvis_serving.holdings where tenant_id in (a, b)) <> 2
     or (select count(*) from corvis_control.idempotency_key where tenant_id in (a, b)) <> 2 then
    raise exception 'service context: the runtime role must read the application tables (and security-invoker views) across tenants';
  end if;
  -- Granted DML works: insert, update, and a granted function.
  insert into corvis_control.audit_event (tenant_id, actor_subject, action, target_type, outcome, correlation_id)
    values (a, 'rt-acceptance', 'runtime_role.acceptance', 'probe', 'success', 'rt-acceptance');
  update corvis_control.feature_flag set enabled = false where tenant_id = a and flag_key = 'rt_acceptance';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then raise exception 'service context: expected to update the tenant A flag, updated %', v_rows; end if;
  perform corvis_facts.assign_company_sector(b, 'rt-company-b', 'energy', 0, 'rt|b', 'tenant B view');
  if (select count(*) from corvis_serving.company_sectors where tenant_id in (a, b)) <> 2 then
    raise exception 'service context: assign_company_sector (granted function and its table grants) did not take effect';
  end if;
end $$;

-- Append-only guards stay in force twice over: no UPDATE/DELETE privilege on append-only tables, and the trigger where a
-- privilege exists (company sector classifications are INSERT/UPDATE-able only to supersede the current row).
select pg_temp.expect_sqlstate('audit_event update', $$update corvis_control.audit_event set outcome = 'x'$$, '42501');
select pg_temp.expect_sqlstate('audit_event delete', $$delete from corvis_control.audit_event$$, '42501');
select pg_temp.expect_sqlstate('control_evidence update', $$update corvis_control.control_evidence set result = 'fail'$$, '42501');
select pg_temp.expect_sqlstate('control_evidence delete', $$delete from corvis_control.control_evidence$$, '42501');
select pg_temp.expect_sqlstate('audit_event truncate', $$truncate corvis_control.audit_event$$, '42501');
do $$
begin
  begin
    update corvis_facts.company_sector_classification set reason = 'rewritten' where tenant_id = current_setting('corvis.rt.tenant_a')::uuid;
    raise exception 'the append-only trigger on company_sector_classification did not fire for the runtime role';
  exception when others then
    if sqlerrm not like '%append-only%' then raise; end if;
  end;
end $$;

-- No DDL, no ownership, no escape hatches.
select pg_temp.expect_sqlstate('create table', 'create table corvis_control.rt_probe (x integer)', '42501');
select pg_temp.expect_sqlstate('create function', $$create function corvis_control.rt_probe() returns integer language sql as 'select 1'$$, '42501');
select pg_temp.expect_sqlstate('create schema', 'create schema rt_probe', '42501');
select pg_temp.expect_sqlstate('alter table', 'alter table corvis_control.tenant add column rt_probe integer', '42501');
select pg_temp.expect_sqlstate('disable trigger', 'alter table corvis_control.audit_event disable trigger all', '42501');
select pg_temp.expect_sqlstate('disable rls', 'alter table corvis_control.tenant disable row level security', '42501');
select pg_temp.expect_sqlstate('drop table', 'drop table corvis_control.tenant', '42501');
select pg_temp.expect_sqlstate('truncate tenant', 'truncate corvis_control.tenant', '42501');
select pg_temp.expect_sqlstate('create role', 'create role rt_probe_role', '42501');
select pg_temp.expect_sqlstate('self-grant', 'grant select on corvis_control.exception to corvis_runtime', '42501');
select pg_temp.expect_sqlstate('replica role', 'set session_replication_role = replica', '42501');
select pg_temp.expect_sqlstate('row_security off', $$set local row_security = off; select count(*) from corvis_control.tenant$$, '42501');
-- Ungranted tables, functions and schemas.
select pg_temp.expect_sqlstate('ungranted table', 'select count(*) from corvis_control.exception', '42501');
select pg_temp.expect_sqlstate('ungranted function', 'select corvis_control.current_user_id()', '42501');
select pg_temp.expect_sqlstate('ungranted view', 'select count(*) from corvis_serving.entity_relationships', '42501');
do $$
begin
  if to_regclass('corvis_migration.schema_migration') is not null then
    perform pg_temp.expect_sqlstate('migration ledger', 'select count(*) from corvis_migration.schema_migration', '42501');
  end if;
end $$;
-- ------------------------------------------------------------------ 2. subject-bound context: tenant isolation as the runtime role
select pg_temp.assert_scoped('tenant A member', current_setting('corvis.rt.user_a')::uuid,
  current_setting('corvis.rt.tenant_a')::uuid, current_setting('corvis.rt.tenant_b')::uuid, true);
select pg_temp.assert_scoped('tenant B member', current_setting('corvis.rt.user_b')::uuid,
  current_setting('corvis.rt.tenant_b')::uuid, current_setting('corvis.rt.tenant_a')::uuid, true);
select pg_temp.assert_scoped('unrelated subject', current_setting('corvis.rt.user_x')::uuid,
  current_setting('corvis.rt.tenant_a')::uuid, current_setting('corvis.rt.tenant_b')::uuid, false);

-- A bound subject cannot write: the service-context policy no longer applies and no mutation policy exists for anyone else.
do $$
declare
  v_rows integer;
begin
  perform set_config('request.jwt.claim.sub', current_setting('corvis.rt.user_a'), true);
  perform pg_temp.expect_sqlstate('bound insert (own tenant)',
    format($f$insert into corvis_control.feature_flag (tenant_id, flag_key, enabled) values (%L, 'unauthorized_probe', true)$f$, current_setting('corvis.rt.tenant_a')), '42501');
  perform pg_temp.expect_sqlstate('bound insert (other tenant)',
    format($f$insert into corvis_control.feature_flag (tenant_id, flag_key, enabled) values (%L, 'unauthorized_probe', true)$f$, current_setting('corvis.rt.tenant_b')), '42501');
  update corvis_control.feature_flag set enabled = true where tenant_id = current_setting('corvis.rt.tenant_a')::uuid;
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then raise exception 'a subject-bound session updated % row(s) through the runtime role', v_rows; end if;
  update corvis_control.tenant set display_name = 'hijacked';
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then raise exception 'a subject-bound session updated % tenant row(s) through the runtime role', v_rows; end if;
end $$;

-- ...and with the claim cleared the runtime role is back in service context (the claim, not the role, decides).
do $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  if (select count(*) from corvis_control.tenant where tenant_id in (current_setting('corvis.rt.tenant_a')::uuid, current_setting('corvis.rt.tenant_b')::uuid)) <> 2 then
    raise exception 'clearing the subject claim must return the runtime role to service context';
  end if;
end $$;

reset role;
rollback;

\o
\set QUIET 0
\echo POSTGRES_RUNTIME_ROLE_ACCEPTANCE_PASS
