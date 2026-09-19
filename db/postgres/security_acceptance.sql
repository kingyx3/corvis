\set ON_ERROR_STOP on
\set QUIET 1

begin;

-- Synthetic identifiers live only for this transaction. The entire acceptance
-- probe rolls back, so no test tenant, membership or evidence persists.
select set_config('corvis.security.tenant_a', gen_random_uuid()::text, false);
select set_config('corvis.security.tenant_b', gen_random_uuid()::text, false);
select set_config('corvis.security.workspace_a', gen_random_uuid()::text, false);
select set_config('corvis.security.workspace_b', gen_random_uuid()::text, false);
select set_config('corvis.security.user_a', gen_random_uuid()::text, false);
select set_config('corvis.security.user_b', gen_random_uuid()::text, false);
select set_config('corvis.security.document_a', gen_random_uuid()::text, false);
select set_config('corvis.security.document_b', gen_random_uuid()::text, false);
select set_config('corvis.security.export_a', gen_random_uuid()::text, false);
select set_config('corvis.security.export_b', gen_random_uuid()::text, false);

insert into corvis_control.tenant (tenant_id, slug, display_name)
values
  (current_setting('corvis.security.tenant_a')::uuid, 'security-acceptance-a-' || left(current_setting('corvis.security.tenant_a'), 8), 'Security acceptance tenant A'),
  (current_setting('corvis.security.tenant_b')::uuid, 'security-acceptance-b-' || left(current_setting('corvis.security.tenant_b'), 8), 'Security acceptance tenant B');

insert into corvis_control.workspace (workspace_id, tenant_id, slug, display_name)
values
  (current_setting('corvis.security.workspace_a')::uuid, current_setting('corvis.security.tenant_a')::uuid, 'security-a', 'Security A'),
  (current_setting('corvis.security.workspace_b')::uuid, current_setting('corvis.security.tenant_b')::uuid, 'security-b', 'Security B');

insert into corvis_control.membership (tenant_id, workspace_id, user_id, role_name)
values
  (current_setting('corvis.security.tenant_a')::uuid, current_setting('corvis.security.workspace_a')::uuid, current_setting('corvis.security.user_a')::uuid, 'analyst'),
  (current_setting('corvis.security.tenant_b')::uuid, current_setting('corvis.security.workspace_b')::uuid, current_setting('corvis.security.user_b')::uuid, 'analyst');

insert into corvis_control.feature_flag (tenant_id, flag_key, enabled)
values
  (current_setting('corvis.security.tenant_a')::uuid, 'security_acceptance', true),
  (current_setting('corvis.security.tenant_b')::uuid, 'security_acceptance', false);

insert into corvis_control.control_evidence
  (tenant_id, evidence_id, control_code, evidence_type, result, generated_by)
values
  (current_setting('corvis.security.tenant_a')::uuid, gen_random_uuid(), 'SECURITY_ACCEPTANCE', 'synthetic', 'pass', 'security-acceptance'),
  (current_setting('corvis.security.tenant_b')::uuid, gen_random_uuid(), 'SECURITY_ACCEPTANCE', 'synthetic', 'pass', 'security-acceptance');

insert into corvis_source.document
  (tenant_id, document_id, display_name, media_type, status, created_by)
values
  (current_setting('corvis.security.tenant_a')::uuid, current_setting('corvis.security.document_a')::uuid, 'Tenant A synthetic.pdf', 'application/pdf', 'registered', 'security-acceptance'),
  (current_setting('corvis.security.tenant_b')::uuid, current_setting('corvis.security.document_b')::uuid, 'Tenant B synthetic.pdf', 'application/pdf', 'registered', 'security-acceptance');

insert into corvis_serving.export_job
  (tenant_id, export_id, requested_by, format, state)
values
  (current_setting('corvis.security.tenant_a')::uuid, current_setting('corvis.security.export_a')::uuid, 'security-acceptance', 'csv', 'queued'),
  (current_setting('corvis.security.tenant_b')::uuid, current_setting('corvis.security.export_b')::uuid, 'security-acceptance', 'csv', 'queued');

-- Test the actual RLS policies independently of long-term application grants.
-- These grants exist only inside this transaction and are rolled back. This
-- prevents the acceptance test from changing the production authorization model.
grant usage on schema corvis_control, corvis_source, corvis_serving to authenticated;
grant select, insert, update, delete on
  corvis_control.workspace,
  corvis_control.feature_flag,
  corvis_control.control_evidence,
  corvis_source.document,
  corvis_serving.export_job
  to authenticated;

set local role authenticated;
set local row_security = on;
select set_config('request.jwt.claim.sub', current_setting('corvis.security.user_a'), true);

-- Tenant A must see exactly its own rows without an application tenant filter.
do $$
declare
  expected_tenant uuid := current_setting('corvis.security.tenant_a')::uuid;
begin
  if (select count(*) from corvis_control.workspace) <> 1 then
    raise exception 'tenant A workspace RLS returned unexpected row count';
  end if;
  if exists (select 1 from corvis_control.workspace where tenant_id <> expected_tenant) then
    raise exception 'tenant A can read another tenant workspace';
  end if;
  if (select count(*) from corvis_control.feature_flag) <> 1
     or exists (select 1 from corvis_control.feature_flag where tenant_id <> expected_tenant) then
    raise exception 'tenant A feature flag RLS leakage';
  end if;
  if (select count(*) from corvis_control.control_evidence) <> 1
     or exists (select 1 from corvis_control.control_evidence where tenant_id <> expected_tenant) then
    raise exception 'tenant A control evidence RLS leakage';
  end if;
  if (select count(*) from corvis_source.document) <> 1
     or exists (select 1 from corvis_source.document where tenant_id <> expected_tenant) then
    raise exception 'tenant A source document RLS leakage';
  end if;
  if (select count(*) from corvis_serving.export_job) <> 1
     or exists (select 1 from corvis_serving.export_job where tenant_id <> expected_tenant) then
    raise exception 'tenant A export RLS leakage';
  end if;
end $$;

-- Even with temporary SQL privileges, absence of mutation policies must keep
-- the authenticated client read-only on privileged control state.
do $$
begin
  begin
    insert into corvis_control.feature_flag (tenant_id, flag_key, enabled)
    values (current_setting('corvis.security.tenant_a')::uuid, 'unauthorized_mutation_probe', true);
    raise exception 'authenticated mutation unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;
end $$;

reset role;
set local role authenticated;
set local row_security = on;
select set_config('request.jwt.claim.sub', current_setting('corvis.security.user_b'), true);

-- Repeat from tenant B so a one-sided policy mistake cannot pass.
do $$
declare
  expected_tenant uuid := current_setting('corvis.security.tenant_b')::uuid;
begin
  if (select count(*) from corvis_control.workspace) <> 1
     or exists (select 1 from corvis_control.workspace where tenant_id <> expected_tenant) then
    raise exception 'tenant B workspace RLS leakage';
  end if;
  if (select count(*) from corvis_control.feature_flag) <> 1
     or exists (select 1 from corvis_control.feature_flag where tenant_id <> expected_tenant) then
    raise exception 'tenant B feature flag RLS leakage';
  end if;
  if (select count(*) from corvis_control.control_evidence) <> 1
     or exists (select 1 from corvis_control.control_evidence where tenant_id <> expected_tenant) then
    raise exception 'tenant B control evidence RLS leakage';
  end if;
  if (select count(*) from corvis_source.document) <> 1
     or exists (select 1 from corvis_source.document where tenant_id <> expected_tenant) then
    raise exception 'tenant B source document RLS leakage';
  end if;
  if (select count(*) from corvis_serving.export_job) <> 1
     or exists (select 1 from corvis_serving.export_job where tenant_id <> expected_tenant) then
    raise exception 'tenant B export RLS leakage';
  end if;
end $$;

reset role;
rollback;

\set QUIET 0
\echo POSTGRES_RLS_SECURITY_ACCEPTANCE_PASS
