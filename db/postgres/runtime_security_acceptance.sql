-- Live Postgres RLS security acceptance for a deployment whose application connects as a login role that is a member of
-- the least-privilege `corvis_runtime` role. It is the counterpart of security_acceptance.sql, which
-- needs owner-level grants and SET ROLE and therefore cannot run as the runtime role; security_acceptance.sql hands over to
-- this file automatically when it is run as a non-superuser member of corvis_runtime, so the acceptance workflow keeps one
-- entry point before and after the DSN switch.
--
-- Everything runs as the connected runtime login, with row level security enforced (the role owns nothing and has no
-- BYPASSRLS). All synthetic data (tenants, memberships, evidence, documents, holdings) lives in one transaction that is
-- rolled back. It proves, with actual RLS and no owner bypass:
--   1. the role can do the application's work (cross-tenant service reads, granted inserts/updates);
--   2. it cannot do anything else (no DDL, no ownership, no append-only mutation, no ungranted table/function/schema,
--      no way around RLS);
--   3. a session that binds an end-user subject is tenant-scoped through base tables and the security-invoker serving views,
--      cannot write, and an unrelated subject sees nothing.

\set ON_ERROR_STOP on
\set QUIET 1
\o /dev/null

begin;

do $$
declare
  v_owned text;
begin
  if not pg_has_role(current_user, 'corvis_runtime', 'member') then
    raise exception 'run this probe as a login role that is a member of corvis_runtime (current role: %)', current_user;
  end if;
  if exists (select 1 from pg_roles where rolname = current_user and (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb)) then
    raise exception 'the connected role % must not be superuser, BYPASSRLS, CREATEROLE or CREATEDB', current_user;
  end if;
  select string_agg(c.relnamespace::regnamespace::text || '.' || c.relname, ', ') into v_owned
  from pg_class c
  where c.relnamespace::regnamespace::text like 'corvis\_%' and c.relkind in ('r', 'p', 'v', 'S') and pg_has_role(current_user, c.relowner, 'member');
  if v_owned is not null then
    raise exception 'the connected role % owns (or is a member of the owner of) corvis_* relations, so RLS would not bind it: %', current_user, v_owned;
  end if;
end $$;

select set_config('corvis.rtsec.tenant_a', gen_random_uuid()::text, false);
select set_config('corvis.rtsec.tenant_b', gen_random_uuid()::text, false);
select set_config('corvis.rtsec.workspace_a', gen_random_uuid()::text, false);
select set_config('corvis.rtsec.workspace_b', gen_random_uuid()::text, false);
select set_config('corvis.rtsec.user_a', gen_random_uuid()::text, false);
select set_config('corvis.rtsec.user_b', gen_random_uuid()::text, false);
select set_config('corvis.rtsec.user_x', gen_random_uuid()::text, false);
select set_config('corvis.rtsec.document_a', gen_random_uuid()::text, false);
select set_config('corvis.rtsec.document_b', gen_random_uuid()::text, false);
select set_config('corvis.rtsec.export_a', gen_random_uuid()::text, false);
select set_config('corvis.rtsec.export_b', gen_random_uuid()::text, false);
select set_config('corvis.rtsec.fund_a', 'rtsec-fund-a-' || gen_random_uuid()::text, false);
select set_config('corvis.rtsec.fund_b', 'rtsec-fund-b-' || gen_random_uuid()::text, false);
select set_config('corvis.rtsec.company_a', 'rtsec-company-a-' || gen_random_uuid()::text, false);
select set_config('corvis.rtsec.company_b', 'rtsec-company-b-' || gen_random_uuid()::text, false);

\ir tests/runtime-role-helpers.sql

-- ------------------------------------------------------------------ fixtures, written with the runtime role's own grants
insert into corvis_control.tenant (tenant_id, slug, display_name) values
  (current_setting('corvis.rtsec.tenant_a')::uuid, 'rtsec-a-' || left(current_setting('corvis.rtsec.tenant_a'), 8), 'Runtime security acceptance A'),
  (current_setting('corvis.rtsec.tenant_b')::uuid, 'rtsec-b-' || left(current_setting('corvis.rtsec.tenant_b'), 8), 'Runtime security acceptance B');
insert into corvis_control.workspace (workspace_id, tenant_id, slug, display_name) values
  (current_setting('corvis.rtsec.workspace_a')::uuid, current_setting('corvis.rtsec.tenant_a')::uuid, 'rtsec-a', 'Runtime security A'),
  (current_setting('corvis.rtsec.workspace_b')::uuid, current_setting('corvis.rtsec.tenant_b')::uuid, 'rtsec-b', 'Runtime security B');
insert into corvis_control.membership (tenant_id, workspace_id, user_id, role_name) values
  (current_setting('corvis.rtsec.tenant_a')::uuid, current_setting('corvis.rtsec.workspace_a')::uuid, current_setting('corvis.rtsec.user_a')::uuid, 'analyst'),
  (current_setting('corvis.rtsec.tenant_b')::uuid, current_setting('corvis.rtsec.workspace_b')::uuid, current_setting('corvis.rtsec.user_b')::uuid, 'analyst');
insert into corvis_control.feature_flag (tenant_id, flag_key, enabled) values
  (current_setting('corvis.rtsec.tenant_a')::uuid, 'security_acceptance', true),
  (current_setting('corvis.rtsec.tenant_b')::uuid, 'security_acceptance', false);
insert into corvis_control.control_evidence (tenant_id, evidence_id, control_code, evidence_type, result, generated_by) values
  (current_setting('corvis.rtsec.tenant_a')::uuid, gen_random_uuid(), 'SECURITY_ACCEPTANCE', 'synthetic', 'pass', 'security-acceptance'),
  (current_setting('corvis.rtsec.tenant_b')::uuid, gen_random_uuid(), 'SECURITY_ACCEPTANCE', 'synthetic', 'pass', 'security-acceptance');
insert into corvis_source.document (tenant_id, document_id, display_name, media_type, status, created_by) values
  (current_setting('corvis.rtsec.tenant_a')::uuid, current_setting('corvis.rtsec.document_a')::uuid, 'Tenant A synthetic.pdf', 'application/pdf', 'registered', 'security-acceptance'),
  (current_setting('corvis.rtsec.tenant_b')::uuid, current_setting('corvis.rtsec.document_b')::uuid, 'Tenant B synthetic.pdf', 'application/pdf', 'registered', 'security-acceptance');
insert into corvis_serving.export_job (tenant_id, export_id, requested_by, format, state) values
  (current_setting('corvis.rtsec.tenant_a')::uuid, current_setting('corvis.rtsec.export_a')::uuid, 'security-acceptance', 'csv', 'queued'),
  (current_setting('corvis.rtsec.tenant_b')::uuid, current_setting('corvis.rtsec.export_b')::uuid, 'security-acceptance', 'csv', 'queued');
insert into corvis_control.idempotency_key (tenant_id, scope, idempotency_key, request_hash, expires_at) values
  (current_setting('corvis.rtsec.tenant_a')::uuid, 'security-acceptance', 'key-a', 'hash-a', now() + interval '1 hour'),
  (current_setting('corvis.rtsec.tenant_b')::uuid, 'security-acceptance', 'key-b', 'hash-b', now() + interval '1 hour');
insert into corvis_identity.fund (global_fund_id, canonical_name) values
  (current_setting('corvis.rtsec.fund_a'), 'Runtime security fund A'), (current_setting('corvis.rtsec.fund_b'), 'Runtime security fund B');
insert into corvis_identity.company (global_company_id, canonical_name) values
  (current_setting('corvis.rtsec.company_a'), 'Runtime security company A'), (current_setting('corvis.rtsec.company_b'), 'Runtime security company B');
insert into corvis_facts.holding (tenant_id, fund_id, target_type, target_company_id, review_state) values
  (current_setting('corvis.rtsec.tenant_a')::uuid, current_setting('corvis.rtsec.fund_a'), 'company', current_setting('corvis.rtsec.company_a'), 'approved'),
  (current_setting('corvis.rtsec.tenant_b')::uuid, current_setting('corvis.rtsec.fund_b'), 'company', current_setting('corvis.rtsec.company_b'), 'approved');
insert into corvis_consolidated.fund_period_snapshot (tenant_id, fund_id, report_period, version, status, schema_version, taxonomy_version) values
  (current_setting('corvis.rtsec.tenant_a')::uuid, current_setting('corvis.rtsec.fund_a'), '2025Q4', 1, 'draft', '1', '1'),
  (current_setting('corvis.rtsec.tenant_b')::uuid, current_setting('corvis.rtsec.fund_b'), '2025Q4', 1, 'draft', '1', '1');

-- ------------------------------------------------------------------ 1. service context: the application's own mode
do $$
declare
  a uuid := current_setting('corvis.rtsec.tenant_a')::uuid;
  b uuid := current_setting('corvis.rtsec.tenant_b')::uuid;
  v_rows integer;
begin
  if (select count(*) from corvis_control.tenant where tenant_id in (a, b)) <> 2
     or (select count(*) from corvis_source.document where tenant_id in (a, b)) <> 2
     or (select count(*) from corvis_serving.documents where tenant_id in (a, b)) <> 2
     or (select count(*) from corvis_serving.holdings where tenant_id in (a, b)) <> 2 then
    raise exception 'service context: the runtime role must read the application tables and serving views';
  end if;
  update corvis_control.feature_flag set enabled = false where tenant_id = a and flag_key = 'security_acceptance';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then raise exception 'service context: expected to update the tenant A flag, updated %', v_rows; end if;
end $$;

-- ------------------------------------------------------------------ 2. nothing beyond that
select pg_temp.expect_sqlstate('audit_event update', $$update corvis_control.audit_event set outcome = 'x'$$, '42501');
select pg_temp.expect_sqlstate('audit_event delete', $$delete from corvis_control.audit_event$$, '42501');
select pg_temp.expect_sqlstate('control_evidence update', $$update corvis_control.control_evidence set result = 'fail'$$, '42501');
select pg_temp.expect_sqlstate('control_evidence delete', $$delete from corvis_control.control_evidence$$, '42501');
select pg_temp.expect_sqlstate('create table', 'create table corvis_control.rt_probe (x integer)', '42501');
select pg_temp.expect_sqlstate('create schema', 'create schema rt_probe', '42501');
select pg_temp.expect_sqlstate('alter table', 'alter table corvis_control.tenant add column rt_probe integer', '42501');
select pg_temp.expect_sqlstate('disable trigger', 'alter table corvis_control.audit_event disable trigger all', '42501');
select pg_temp.expect_sqlstate('disable rls', 'alter table corvis_control.tenant disable row level security', '42501');
select pg_temp.expect_sqlstate('truncate', 'truncate corvis_control.tenant', '42501');
select pg_temp.expect_sqlstate('create role', 'create role rt_probe_role', '42501');
select pg_temp.expect_sqlstate('replica role', 'set session_replication_role = replica', '42501');
select pg_temp.expect_sqlstate('row_security off', $$set local row_security = off; select count(*) from corvis_control.tenant$$, '42501');
select pg_temp.expect_sqlstate('ungranted table', 'select count(*) from corvis_control.exception', '42501');
select pg_temp.expect_sqlstate('ungranted function', 'select corvis_control.current_user_id()', '42501');
select pg_temp.expect_sqlstate('set role', 'set role postgres', '42501');
do $$
begin
  if to_regnamespace('corvis_migration') is not null then
    perform pg_temp.expect_sqlstate('migration ledger', 'select count(*) from corvis_migration.schema_migration', '42501');
  end if;
end $$;

-- ------------------------------------------------------------------ 3. subject-bound tenant isolation, no owner bypass
select set_config('corvis.rtsec.relations', array_to_string(array[
  'corvis_control.tenant', 'corvis_control.workspace', 'corvis_control.membership', 'corvis_control.feature_flag',
  'corvis_control.control_evidence', 'corvis_source.document', 'corvis_serving.export_job', 'corvis_facts.holding',
  'corvis_consolidated.fund_period_snapshot',
  'corvis_serving.documents', 'corvis_serving.holdings', 'corvis_serving.fund_period_snapshots'
], ','), false);

select pg_temp.assert_scoped('tenant A member', current_setting('corvis.rtsec.user_a')::uuid,
  current_setting('corvis.rtsec.tenant_a')::uuid, current_setting('corvis.rtsec.tenant_b')::uuid, true, string_to_array(current_setting('corvis.rtsec.relations'), ','));
select pg_temp.assert_scoped('tenant B member', current_setting('corvis.rtsec.user_b')::uuid,
  current_setting('corvis.rtsec.tenant_b')::uuid, current_setting('corvis.rtsec.tenant_a')::uuid, true, string_to_array(current_setting('corvis.rtsec.relations'), ','));
select pg_temp.assert_scoped('unrelated subject', current_setting('corvis.rtsec.user_x')::uuid,
  current_setting('corvis.rtsec.tenant_a')::uuid, current_setting('corvis.rtsec.tenant_b')::uuid, false, string_to_array(current_setting('corvis.rtsec.relations'), ','));

do $$
declare
  v_rows integer;
begin
  perform set_config('request.jwt.claim.sub', current_setting('corvis.rtsec.user_a'), true);
  if (select count(*) from corvis_control.idempotency_key where tenant_id in (current_setting('corvis.rtsec.tenant_a')::uuid, current_setting('corvis.rtsec.tenant_b')::uuid)) <> 0 then
    raise exception 'a server-only table is visible to a subject-bound session';
  end if;
  perform pg_temp.expect_sqlstate('bound insert (own tenant)',
    format($f$insert into corvis_control.feature_flag (tenant_id, flag_key, enabled) values (%L, 'unauthorized_probe', true)$f$, current_setting('corvis.rtsec.tenant_a')), '42501');
  perform pg_temp.expect_sqlstate('bound insert (other tenant)',
    format($f$insert into corvis_control.feature_flag (tenant_id, flag_key, enabled) values (%L, 'unauthorized_probe', true)$f$, current_setting('corvis.rtsec.tenant_b')), '42501');
  update corvis_control.tenant set display_name = 'hijacked' where tenant_id = current_setting('corvis.rtsec.tenant_a')::uuid;
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then raise exception 'a subject-bound session updated % tenant row(s) through the runtime role', v_rows; end if;
  perform set_config('request.jwt.claim.sub', '', true);
  if (select count(*) from corvis_control.tenant where tenant_id in (current_setting('corvis.rtsec.tenant_a')::uuid, current_setting('corvis.rtsec.tenant_b')::uuid)) <> 2 then
    raise exception 'clearing the subject claim must return the runtime role to service context';
  end if;
end $$;

rollback;

\o
\set QUIET 0
\echo POSTGRES_RLS_SECURITY_ACCEPTANCE_PASS
