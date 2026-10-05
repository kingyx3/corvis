-- #227: a least-privilege runtime database role, so the application no longer has to connect as the table owner or a
-- BYPASSRLS service role.
-- Depends on migrations 001-099 (every table, view and function the grants below name).
--
-- Until now no migration granted anything to an application role: the app ran as the owner / service role, bypassed row
-- level security (migration 051 says so) and every tenant boundary rested on `tenant_id = $1` predicates in TypeScript.
-- This migration adds the role and the grants a deployment needs to move the application onto it; it does NOT change the
-- application's connection (that is a per-environment rollout step, see docs/RUNTIME_DATABASE_ROLE.md), and it changes
-- nothing for the owner role.
--
--   1. `corvis_runtime`: a NOLOGIN group role. Not a superuser, no BYPASSRLS, no CREATEROLE/CREATEDB/REPLICATION, owns
--      nothing, no CREATE on any schema, no access to the migration ledger (`corvis_migration`). A deployment creates its
--      login role separately and makes it a member (`grant corvis_runtime to <login role>`).
--   2. EXECUTE is revoked from PUBLIC on every function in every corvis_* schema (they were all callable by anyone with
--      schema USAGE), and `alter default privileges` stops later migrations re-opening it. Only the two RLS helpers stay
--      PUBLIC (every role that evaluates a tenant policy must be able to call them; they answer only "does the caller
--      have access", for the caller's own auth.uid()).
--   3. The runtime role gets USAGE on the eight corvis_* schemas and explicit SELECT/INSERT/UPDATE/DELETE on exactly the
--      tables the application reaches, EXECUTE on exactly the functions it calls, SELECT on the serving views it reads and
--      USAGE on the four sequences those tables draw from. Each list was derived from the application's SQL
--      (lib/server, app/api, core) and the bodies of the SECURITY INVOKER functions and trigger functions it fires. A
--      table, view or function that is not listed is deliberately denied. Tables are never granted through ALTER DEFAULT
--      PRIVILEGES: every future table needs a deliberate decision, enforced by db/postgres/tests/runtime-role-privileges.sql.
--      Append-only tables get no UPDATE/DELETE grant, so their triggers stay a second line of defence, not the only one.
--   4. Every table the runtime role may touch that has row level security gets the policy `corvis_runtime_service`
--      (FOR ALL, TO corvis_runtime), true only while NO end-user subject is bound to the session (`auth.uid() is null`).
--      The application never binds one (it authorizes in code), so its behaviour is unchanged; a session that DOES carry a
--      subject claim is held to the ordinary tenant/workspace policies even when it is connected as this role, so the
--      tenant-isolation negatives run as the runtime role without relying on any bypass.
--   5. The ten corvis_serving views from migrations 002-055 that were owner-evaluated become `security_invoker`, like the
--      later ones: they read the base tables with the caller's privileges and the caller's row level security.
--   6. The three SECURITY DEFINER functions of migrations 001/056 pin `search_path = pg_catalog, pg_temp` (every object
--      reference in their bodies is already schema-qualified), like `apply_data_right_admin_authorized` (078).

begin;

-- 1. The role. Idempotent; an existing role must already be safe, never silently altered.
do $$
declare
  v_role pg_roles%rowtype;
begin
  select * into v_role from pg_roles where rolname = 'corvis_runtime';
  if not found then
    create role corvis_runtime nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  elsif v_role.rolsuper or v_role.rolbypassrls or v_role.rolcreaterole or v_role.rolcreatedb or v_role.rolreplication or v_role.rolcanlogin then
    raise exception 'role corvis_runtime exists with unsafe attributes (superuser, bypassrls, createrole, createdb, replication or login); it must be a plain NOLOGIN group role';
  end if;
  if exists (
    select 1 from pg_auth_members m join pg_roles r on r.oid = m.member where r.rolname = 'corvis_runtime'
  ) then
    raise exception 'role corvis_runtime must not be a member of any other role';
  end if;
end;
$$;

comment on role corvis_runtime is 'Least-privilege application runtime group role (#227). Grant to the application login role; owns nothing, no DDL, no BYPASSRLS. See docs/RUNTIME_DATABASE_ROLE.md.';

-- 2. No function in any corvis_* schema is callable through PUBLIC any more.
revoke execute on all functions in schema corvis_consolidated from public;
revoke execute on all functions in schema corvis_control from public;
revoke execute on all functions in schema corvis_facts from public;
revoke execute on all functions in schema corvis_identity from public;
revoke execute on all functions in schema corvis_review from public;
revoke execute on all functions in schema corvis_semantic from public;
revoke execute on all functions in schema corvis_serving from public;
revoke execute on all functions in schema corvis_source from public;

-- The only PUBLIC exceptions: the RLS helpers every policy evaluator needs.
grant execute on function corvis_control.has_tenant_access(uuid) to public;
grant execute on function corvis_control.has_workspace_access(uuid, uuid) to public;

-- Functions created by the migration role from now on are not PUBLIC-executable either. (A schema-scoped default
-- cannot remove the built-in PUBLIC default, so this is the role-wide form; it only affects functions this role creates.)
alter default privileges revoke execute on functions from public;

-- 3. Grants. Schemas first: USAGE only, never CREATE.
grant usage on schema
  corvis_consolidated, corvis_control, corvis_facts, corvis_identity,
  corvis_review, corvis_semantic, corvis_serving, corvis_source
  to corvis_runtime;

-- Policy expressions run with the caller's privileges, so the runtime role must be able to call auth.uid(). Supabase
-- grants it to its own roles; where it is not already PUBLIC and this role may not grant it, warn instead of failing the
-- whole migration (the acceptance suite run as the runtime role then fails loudly and a deployment grants it by hand).
do $$
begin
  if to_regprocedure('auth.uid()') is not null then
    begin
      execute 'grant execute on function auth.uid() to corvis_runtime';
    exception when insufficient_privilege then
      raise warning 'could not grant EXECUTE on auth.uid() to corvis_runtime; grant it as the schema owner';
    end;
  end if;
end;
$$;

-- Tables: explicit privileges, plus the service-context policy where the table has row level security.
do $$
declare
  r record;
  v_relkind "char";
  v_rls boolean;
begin
  for r in select * from (values
    ('corvis_consolidated.consolidated_fact', 'select, insert, update'),
    ('corvis_consolidated.consolidation_run', 'select, insert, update'),
    ('corvis_consolidated.fund_period_snapshot', 'select, insert, update'),
    ('corvis_consolidated.publication_run', 'select, insert, update'),
    ('corvis_consolidated.reconciliation_exception', 'select, insert, update'),
    ('corvis_consolidated.reconciliation_resolution_event', 'select, insert'),
    ('corvis_consolidated.reconciliation_run', 'select, insert, update'),
    ('corvis_consolidated.snapshot_publication_event', 'select, insert'),
    ('corvis_control.api_rate_limit', 'select, insert, update'),
    ('corvis_control.audit_event', 'select, insert'),
    ('corvis_control.control_definition', 'select, update'),
    ('corvis_control.control_evidence', 'select, insert'),
    ('corvis_control.control_evidence_record', 'select, insert'),
    ('corvis_control.control_evidence_requirement', 'select'),
    ('corvis_control.data_correction_incident', 'select, insert, update'),
    ('corvis_control.data_issue_case', 'select, insert, update'),
    ('corvis_control.data_issue_case_event', 'select, insert'),
    ('corvis_control.data_rights', 'select'),
    ('corvis_control.deletion_execution_evidence', 'select, insert'),
    ('corvis_control.deletion_request', 'select, insert, update'),
    ('corvis_control.email_outbox', 'select, insert, update'),
    ('corvis_control.event_inbox', 'select, insert, update'),
    ('corvis_control.export_schedule', 'select, insert, update'),
    ('corvis_control.export_schedule_run', 'select, insert'),
    ('corvis_control.feature_flag', 'select, insert, update'),
    ('corvis_control.feature_flag_emergency_stop', 'select, insert, update'),
    ('corvis_control.idempotency_key', 'select, insert, delete'),
    ('corvis_control.identity_lifecycle_event', 'select, insert'),
    ('corvis_control.identity_subject', 'select, insert, update'),
    ('corvis_control.legal_hold', 'select'),
    ('corvis_control.membership', 'select, insert, update, delete'),
    ('corvis_control.notification_preference', 'select, insert, update'),
    ('corvis_control.notification_recipient', 'select, insert, update'),
    ('corvis_control.outbox_event', 'select, insert, update'),
    ('corvis_control.processing_job', 'select, insert, update'),
    ('corvis_control.processing_recovery_event', 'select, insert'),
    ('corvis_control.processing_stage_effect', 'select, insert, update'),
    ('corvis_control.research_answer_pin', 'select, insert, delete'),
    ('corvis_control.resource_entitlement', 'select, insert, update, delete'),
    ('corvis_control.retention_policy', 'select'),
    ('corvis_control.review_item_comment', 'select, insert'),
    ('corvis_control.review_item_thread', 'select, insert, update'),
    ('corvis_control.semantic_query_log', 'select, insert, update'),
    ('corvis_control.service_account', 'select, insert, update'),
    ('corvis_control.service_account_credential', 'select, insert, update'),
    ('corvis_control.service_identity_grant', 'select, insert, update'),
    ('corvis_control.session_revocation', 'select, insert'),
    ('corvis_control.support_access_grant', 'select, insert, update, delete'),
    ('corvis_control.tenant', 'select, insert, update'),
    ('corvis_control.tenant_access_notification', 'select, insert, update'),
    ('corvis_control.tenant_export_download_grant', 'select, insert, update, delete'),
    ('corvis_control.tenant_export_request', 'select, insert, update'),
    ('corvis_control.tenant_export_request_event', 'select, insert'),
    ('corvis_control.tenant_identity_provider', 'select, insert, update'),
    ('corvis_control.tenant_invitation', 'select, insert, update'),
    ('corvis_control.tenant_scim_configuration', 'select, insert, update'),
    ('corvis_control.tenant_scim_identity', 'select, insert, update'),
    ('corvis_control.tenant_session_activity', 'select, insert, update, delete'),
    ('corvis_control.tenant_session_policy', 'select, insert, update'),
    ('corvis_control.tenant_verified_domain', 'select, insert, delete'),
    ('corvis_control.webhook_delivery', 'select, insert, update'),
    ('corvis_control.webhook_signing_key', 'select, insert, update'),
    ('corvis_control.webhook_subscription', 'select, insert, update'),
    ('corvis_control.workspace', 'select, insert'),
    ('corvis_control.workspace_user_preference', 'select, insert, update'),
    ('corvis_facts.canonical_candidate', 'select, insert'),
    ('corvis_facts.canonicalization_run', 'select, insert, update'),
    ('corvis_facts.client_portfolio', 'select'),
    ('corvis_facts.client_portfolio_fund_position', 'select'),
    ('corvis_facts.company_sector_classification', 'select, insert, update'),
    ('corvis_facts.holding', 'select, insert, update'),
    ('corvis_facts.holding_revision', 'insert'),
    ('corvis_facts.instrument', 'select, insert, update'),
    ('corvis_facts.instrument_revision', 'insert'),
    ('corvis_facts.observation', 'select, insert, update'),
    ('corvis_facts.observation_correction', 'select, insert'),
    ('corvis_facts.observation_source_reference', 'select, insert'),
    ('corvis_facts.position_financial_statement', 'select, insert'),
    ('corvis_facts.position_financial_statement_line', 'select, insert'),
    ('corvis_facts.position_financial_statement_value', 'select, insert'),
    ('corvis_facts.review_event', 'select, insert'),
    ('corvis_identity.company', 'select, insert'),
    ('corvis_identity.entity_external_identifier', 'select'),
    ('corvis_identity.entity_lifecycle_event', 'select, insert'),
    ('corvis_identity.entity_lifecycle_participant', 'select, insert'),
    ('corvis_identity.entity_name', 'select, insert, update'),
    ('corvis_identity.fund', 'select, insert'),
    ('corvis_identity.tenant_entity_lifecycle_evidence', 'select, insert, update'),
    ('corvis_identity.tenant_entity_name', 'select, insert'),
    ('corvis_identity.tenant_entity_revision', 'insert'),
    ('corvis_identity.tenant_lifecycle_revision', 'insert'),
    ('corvis_review.candidate_review_event', 'select, insert'),
    ('corvis_review.candidate_review_requirement', 'select, insert'),
    ('corvis_review.extraction_review_gate', 'select, insert, update'),
    ('corvis_semantic.metric_definition', 'select'),
    ('corvis_semantic.sector', 'select'),
    ('corvis_semantic.sector_alias', 'select'),
    ('corvis_serving.export_download_grant', 'select, insert, update, delete'),
    ('corvis_serving.export_job', 'select, insert, update'),
    ('corvis_source.acquired_document', 'select, insert'),
    ('corvis_source.document', 'select, insert, update'),
    ('corvis_source.document_artifact_version', 'select, insert, update'),
    ('corvis_source.document_representation', 'select, insert'),
    ('corvis_source.extraction_candidate', 'select, insert'),
    ('corvis_source.extraction_candidate_source_reference', 'select, insert'),
    ('corvis_source.extraction_run', 'select, insert, update'),
    ('corvis_source.source_connection', 'select, insert, update'),
    ('corvis_source.source_connection_run', 'select, insert, update'),
    ('corvis_source.source_reference', 'select, insert')
  ) as t(rel, privileges) loop
    select c.relkind, c.relrowsecurity into v_relkind, v_rls from pg_class c where c.oid = r.rel::regclass;
    if v_relkind not in ('r', 'p') then
      raise exception 'runtime table grant names a relation that is not a table: %', r.rel;
    end if;
    execute format('grant %s on table %s to corvis_runtime', r.privileges, r.rel);
    if v_rls then
      execute format('drop policy if exists corvis_runtime_service on %s', r.rel);
      execute format(
        'create policy corvis_runtime_service on %s for all to corvis_runtime using (auth.uid() is null) with check (auth.uid() is null)',
        r.rel
      );
    end if;
  end loop;
end;
$$;

-- Serving views the application reads (SELECT only; the base-table grants above are what a security-invoker view needs).
do $$
declare
  v_name text;
begin
  foreach v_name in array array[
    'corvis_serving.client_portfolio_fund_positions',
    'corvis_serving.client_portfolio_holding_attribution',
    'corvis_serving.client_portfolios',
    'corvis_serving.company_sectors',
    'corvis_serving.documents',
    'corvis_serving.entity_directory',
    'corvis_serving.fund_period_snapshots',
    'corvis_serving.holdings',
    'corvis_serving.instruments',
    'corvis_serving.observations',
    'corvis_serving.position_financial_statement_values',
    'corvis_serving.reconciliation_exceptions',
    'corvis_serving.source_references'
  ] loop
    if (select c.relkind from pg_class c where c.oid = v_name::regclass) <> 'v' then
      raise exception 'runtime view grant names a relation that is not a view: %', v_name;
    end if;
    execute format('grant select on %s to corvis_runtime', v_name);
  end loop;
end;
$$;

-- Sequences behind the append-only event tables' bigserial keys.
do $$
declare
  v_name text;
begin
  foreach v_name in array array[
    'corvis_control.data_issue_case_event_event_seq_seq',
    'corvis_control.review_item_comment_comment_seq_seq',
    'corvis_control.tenant_export_request_event_event_seq_seq',
    'corvis_review.candidate_review_event_event_sequence_seq'
  ] loop
    execute format('grant usage on sequence %s to corvis_runtime', v_name);
  end loop;
end;
$$;

-- Functions the application calls (or that a function it calls invokes as the caller, or a column default evaluates).
-- Trigger functions are not listed: Postgres checks EXECUTE only when a trigger is created, not when it fires.
do $$
declare
  v_name text;
  v_sig text;
  v_matched integer;
begin
  foreach v_name in array array[
    'corvis_consolidated.append_snapshot_transition',
    'corvis_consolidated.assert_snapshot_publishable',
    'corvis_consolidated.consolidate_reconciliation',
    'corvis_consolidated.publish_consolidation',
    'corvis_consolidated.reconcile_canonicalization',
    'corvis_consolidated.resolve_reconciliation_exception',
    'corvis_consolidated.snapshot_grain_peer_observations',
    'corvis_control.accept_tenant_invitation',
    'corvis_control.access_policy_resource_belongs_to_tenant',
    'corvis_control.add_review_item_comment',
    'corvis_control.apply_data_right_admin_authorized',
    'corvis_control.apply_identity_lifecycle',
    'corvis_control.apply_resource_entitlement_admin',
    'corvis_control.apply_support_access_admin',
    'corvis_control.begin_processing_stage_effect',
    'corvis_control.block_processing_stage_delivery',
    'corvis_control.claim_event_delivery',
    'corvis_control.claim_export_schedule_trigger',
    'corvis_control.claim_next_tenant_export_build',
    'corvis_control.claim_processing_stage_delivery',
    'corvis_control.claim_processing_transport_events',
    'corvis_control.close_data_issue_cases_for_correction',
    'corvis_control.complete_event_delivery',
    'corvis_control.complete_processing_stage_delivery',
    'corvis_control.complete_processing_stage_effect',
    'corvis_control.complete_processing_transport_event',
    'corvis_control.complete_tenant_export_build',
    'corvis_control.consume_api_rate_limit',
    'corvis_control.create_export_schedule',
    'corvis_control.create_service_account',
    'corvis_control.create_webhook_subscription',
    'corvis_control.dead_letter_exhausted_processing_job',
    'corvis_control.decide_tenant_export',
    'corvis_control.disable_service_account',
    'corvis_control.email_domain_allowed',
    'corvis_control.emit_export_schedule_run_event',
    'corvis_control.enforce_session_policy',
    'corvis_control.expired_tenant_export_artifacts',
    'corvis_control.export_schedule_latest_publication',
    'corvis_control.export_schedule_next_run_at',
    'corvis_control.extend_service_account',
    'corvis_control.fail_event_delivery',
    'corvis_control.fail_processing_stage_delivery',
    'corvis_control.fail_processing_transport_event',
    'corvis_control.fail_tenant_export_build',
    'corvis_control.grant_service_account_entitlement',
    'corvis_control.identity_records_operator',
    'corvis_control.issue_service_account_credential',
    'corvis_control.list_due_export_schedules',
    'corvis_control.mark_tenant_export_artifact_deleted',
    'corvis_control.open_data_correction_incident',
    'corvis_control.processing_job_for_effect_key',
    'corvis_control.processing_predecessor_job_for_effect',
    'corvis_control.processing_predecessor_job_for_job',
    'corvis_control.processing_replay_scope_for_effect',
    'corvis_control.promote_control_implementation',
    'corvis_control.purge_tenant_session_activity',
    'corvis_control.queue_service_account_expiry_notices',
    'corvis_control.reactivate_identity_admin',
    'corvis_control.record_tenant_export_build_progress',
    'corvis_control.recover_dead_letter_processing_job',
    'corvis_control.release_processing_transport_event',
    'corvis_control.remove_tenant_verified_domain',
    'corvis_control.report_data_issue',
    'corvis_control.request_data_correction_replay',
    'corvis_control.request_tenant_export',
    'corvis_control.resolve_data_correction_incident',
    'corvis_control.resolve_review_subject',
    'corvis_control.resume_blocked_reconciled_stage',
    'corvis_control.resume_blocked_reviewed_stage',
    'corvis_control.retry_processing_job',
    'corvis_control.review_eligible_members',
    'corvis_control.review_member_eligible',
    'corvis_control.review_member_label',
    'corvis_control.review_member_labels',
    'corvis_control.revoke_service_account_credentials',
    'corvis_control.revoke_service_account_entitlement',
    'corvis_control.rotate_webhook_signing_key',
    'corvis_control.scoped_processing_job_id',
    'corvis_control.service_account_admin_user',
    'corvis_control.service_account_data_right_effective',
    'corvis_control.service_account_owner_active',
    'corvis_control.session_policy_admin_user',
    'corvis_control.set_export_schedule_notification',
    'corvis_control.set_export_schedule_status',
    'corvis_control.set_review_item_assignee',
    'corvis_control.set_tenant_identity_provider',
    'corvis_control.set_tenant_session_policy',
    'corvis_control.set_tenant_verified_domain',
    'corvis_control.sign_out_user_everywhere',
    'corvis_control.stop_export_schedule',
    'corvis_control.stop_export_schedules_for_inactive_owners',
    'corvis_control.sweep_tenant_export_grants',
    'corvis_control.tenant_export_admin_user',
    'corvis_control.tenant_export_rights',
    'corvis_control.tenant_export_scope_changed',
    'corvis_control.tenant_export_system_audit',
    'corvis_control.transfer_service_account_owner',
    'corvis_control.transition_data_issue_case',
    'corvis_facts.apply_review_decision',
    'corvis_facts.assign_company_sector',
    'corvis_facts.canonicalize_reviewed_extraction',
    'corvis_facts.canonicalize_reviewed_extraction_v2',
    'corvis_facts.canonicalize_reviewed_extraction_v3',
    'corvis_facts.canonicalize_reviewed_extraction_v4',
    'corvis_identity.normalize_entity_name',
    'corvis_identity.pre_materialize_reviewed_entity_candidates',
    'corvis_identity.record_reviewed_entity_candidate_lineage',
    'corvis_semantic.normalize_sector_label',
    'corvis_source.release_clean_artifact'
  ] loop
    v_matched := 0;
    for v_sig in
      select p.oid::regprocedure::text
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname || '.' || p.proname = v_name
    loop
      execute format('grant execute on function %s to corvis_runtime', v_sig);
      v_matched := v_matched + 1;
    end loop;
    if v_matched = 0 then
      raise exception 'runtime EXECUTE grant names a function that does not exist: %', v_name;
    end if;
  end loop;
end;
$$;

-- 5. The ten owner-evaluated serving views read base tables with their caller's privileges and row level security.
alter view corvis_serving.documents set (security_invoker = true);
alter view corvis_serving.entity_directory set (security_invoker = true);
alter view corvis_serving.entity_relationships set (security_invoker = true);
alter view corvis_serving.fund_period_snapshots set (security_invoker = true);
alter view corvis_serving.holdings set (security_invoker = true);
alter view corvis_serving.instruments set (security_invoker = true);
alter view corvis_serving.observations set (security_invoker = true);
alter view corvis_serving.position_financial_statement_values set (security_invoker = true);
alter view corvis_serving.reconciliation_exceptions set (security_invoker = true);
alter view corvis_serving.source_references set (security_invoker = true);

-- 6. SECURITY DEFINER functions never resolve an object through a mutable search_path.
alter function corvis_control.has_tenant_access(uuid) set search_path = pg_catalog, pg_temp;
alter function corvis_control.has_workspace_access(uuid, uuid) set search_path = pg_catalog, pg_temp;
alter function corvis_control.accept_tenant_invitation(text, text, text, text, boolean, text) set search_path = pg_catalog, pg_temp;

commit;
