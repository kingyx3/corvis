-- Runtime-role privilege contract.
--
-- The least-privilege application role `corvis_runtime` is granted exactly what is written down below, and nothing in
-- any corvis_* schema may exist without a deliberate decision recorded here. The manifests are the contract: a migration
-- that adds a table, view, sequence or function (or a schema) FAILS this test until the new object is listed either as
-- granted (and the migration grants it) or as denied (with the reason). A migration that widens or removes a grant fails
-- it too. So future migrations can neither silently widen nor silently break the runtime role's access.
--
-- Also asserted: the role is a plain NOLOGIN group role (no superuser, BYPASSRLS, CREATEROLE/DB, replication, DDL, ownership,
-- no membership of any other role), no corvis_* function is executable through PUBLIC except the two RLS helpers, later
-- functions do not get PUBLIC execute either, every serving view is security_invoker, every SECURITY DEFINER function pins
-- a safe search_path, and every runtime-reachable table with row level security carries exactly the service-context policy.
--
-- Run after the full migration chain on an isolated disposable database, as the role that applied the migrations (the
-- default-privilege probe creates one function in a rolled-back transaction). Read-only.
--
-- Updating the manifest is a security decision: every table row needs a code reference (see docs/security/RUNTIME_DATABASE_ROLE.md).

\set ON_ERROR_STOP on

begin;

create temporary table rt_granted_tables (rel text primary key, privileges text not null) on commit drop;
insert into rt_granted_tables values
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
  ('corvis_control.oidc_logout_token_use', 'select, insert, delete'),
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
  ('corvis_source.source_reference', 'select, insert');

-- Deliberately denied: not reached by the application. Reason is mandatory.
create temporary table rt_denied_tables (rel text primary key, reason text not null) on commit drop;
insert into rt_denied_tables values
  ('corvis_consolidated.reconciliation', 'legacy header table; the application reads reconciliation_run and reconciliation_exception'),
  ('corvis_control.control_evidence_escalation', 'operator escalation register; not reached by the application'),
  ('corvis_control.exception', 'operator exception register; not reached by the application'),
  ('corvis_identity.entity_relationship', 'not reached by the application (and its serving view is denied too)');

create temporary table rt_granted_views (rel text primary key) on commit drop;
insert into rt_granted_views values
  ('corvis_serving.client_portfolio_fund_positions'),
  ('corvis_serving.client_portfolio_holding_attribution'),
  ('corvis_serving.client_portfolios'),
  ('corvis_serving.company_sectors'),
  ('corvis_serving.documents'),
  ('corvis_serving.entity_directory'),
  ('corvis_serving.fund_period_snapshots'),
  ('corvis_serving.holdings'),
  ('corvis_serving.instruments'),
  ('corvis_serving.observations'),
  ('corvis_serving.position_financial_statement_values'),
  ('corvis_serving.reconciliation_exceptions'),
  ('corvis_serving.source_references');

create temporary table rt_denied_views (rel text primary key, reason text not null) on commit drop;
insert into rt_denied_views values
  ('corvis_serving.entity_relationships', 'not reached by the application');

create temporary table rt_granted_sequences (rel text primary key) on commit drop;
insert into rt_granted_sequences values
  ('corvis_control.data_issue_case_event_event_seq_seq'),
  ('corvis_control.review_item_comment_comment_seq_seq'),
  ('corvis_control.tenant_export_request_event_event_seq_seq'),
  ('corvis_review.candidate_review_event_event_sequence_seq');

create temporary table rt_granted_functions (fn text primary key) on commit drop;
insert into rt_granted_functions values
  ('corvis_consolidated.append_snapshot_transition'),
  ('corvis_consolidated.assert_snapshot_publishable'),
  ('corvis_consolidated.consolidate_reconciliation'),
  ('corvis_consolidated.publish_consolidation'),
  ('corvis_consolidated.reconcile_canonicalization'),
  ('corvis_consolidated.resolve_reconciliation_exception'),
  ('corvis_consolidated.snapshot_grain_peer_observations'),
  ('corvis_control.accept_tenant_invitation'),
  ('corvis_control.apply_backchannel_logout'),
  ('corvis_control.backchannel_logout_tenants'),
  ('corvis_control.customer_deletion_system_audit'),
  ('corvis_control.decide_customer_deletion'),
  ('corvis_control.deletion_scope_legal_hold'),
  ('corvis_control.request_customer_deletion'),
  ('corvis_control.sso_session_allowed'),
  ('corvis_control.access_policy_resource_belongs_to_tenant'),
  ('corvis_control.add_review_item_comment'),
  ('corvis_control.apply_data_right_admin_authorized'),
  ('corvis_control.apply_identity_lifecycle'),
  ('corvis_control.apply_resource_entitlement_admin'),
  ('corvis_control.apply_support_access_admin'),
  ('corvis_control.begin_processing_stage_effect'),
  ('corvis_control.block_processing_stage_delivery'),
  ('corvis_control.claim_event_delivery'),
  ('corvis_control.claim_export_schedule_trigger'),
  ('corvis_control.claim_next_tenant_export_build'),
  ('corvis_control.claim_processing_stage_delivery'),
  ('corvis_control.claim_processing_transport_events'),
  ('corvis_control.close_data_issue_cases_for_correction'),
  ('corvis_control.complete_event_delivery'),
  ('corvis_control.complete_processing_stage_delivery'),
  ('corvis_control.complete_processing_stage_effect'),
  ('corvis_control.complete_processing_transport_event'),
  ('corvis_control.complete_tenant_export_build'),
  ('corvis_control.consume_api_rate_limit'),
  ('corvis_control.create_export_schedule'),
  ('corvis_control.create_service_account'),
  ('corvis_control.create_webhook_subscription'),
  ('corvis_control.dead_letter_exhausted_processing_job'),
  ('corvis_control.decide_tenant_export'),
  ('corvis_control.disable_service_account'),
  ('corvis_control.email_domain_allowed'),
  ('corvis_control.emit_export_schedule_run_event'),
  ('corvis_control.enforce_session_policy'),
  ('corvis_control.expired_tenant_export_artifacts'),
  ('corvis_control.export_schedule_latest_publication'),
  ('corvis_control.export_schedule_next_run_at'),
  ('corvis_control.extend_service_account'),
  ('corvis_control.fail_event_delivery'),
  ('corvis_control.fail_processing_stage_delivery'),
  ('corvis_control.fail_processing_transport_event'),
  ('corvis_control.fail_tenant_export_build'),
  ('corvis_control.grant_service_account_entitlement'),
  ('corvis_control.identity_records_operator'),
  ('corvis_control.issue_service_account_credential'),
  ('corvis_control.list_due_export_schedules'),
  ('corvis_control.mark_tenant_export_artifact_deleted'),
  ('corvis_control.open_data_correction_incident'),
  ('corvis_control.processing_job_for_effect_key'),
  ('corvis_control.processing_predecessor_job_for_effect'),
  ('corvis_control.processing_predecessor_job_for_job'),
  ('corvis_control.processing_replay_scope_for_effect'),
  ('corvis_control.promote_control_implementation'),
  ('corvis_control.purge_tenant_session_activity'),
  ('corvis_control.queue_service_account_expiry_notices'),
  ('corvis_control.reactivate_identity_admin'),
  ('corvis_control.record_tenant_export_build_progress'),
  ('corvis_control.recover_dead_letter_processing_job'),
  ('corvis_control.release_processing_transport_event'),
  ('corvis_control.remove_tenant_verified_domain'),
  ('corvis_control.report_data_issue'),
  ('corvis_control.request_data_correction_replay'),
  ('corvis_control.request_tenant_export'),
  ('corvis_control.resolve_data_correction_incident'),
  ('corvis_control.resolve_review_subject'),
  ('corvis_control.resume_blocked_reconciled_stage'),
  ('corvis_control.resume_blocked_reviewed_stage'),
  ('corvis_control.retry_processing_job'),
  ('corvis_control.review_eligible_members'),
  ('corvis_control.review_member_eligible'),
  ('corvis_control.review_member_label'),
  ('corvis_control.review_member_labels'),
  ('corvis_control.revoke_service_account_credentials'),
  ('corvis_control.revoke_service_account_entitlement'),
  ('corvis_control.rotate_webhook_signing_key'),
  ('corvis_control.scoped_processing_job_id'),
  ('corvis_control.service_account_admin_user'),
  ('corvis_control.service_account_data_right_effective'),
  ('corvis_control.service_account_owner_active'),
  ('corvis_control.session_policy_admin_user'),
  ('corvis_control.set_export_schedule_notification'),
  ('corvis_control.set_export_schedule_status'),
  ('corvis_control.set_review_item_assignee'),
  ('corvis_control.set_tenant_identity_provider'),
  ('corvis_control.set_tenant_session_policy'),
  ('corvis_control.set_tenant_verified_domain'),
  ('corvis_control.sign_out_user_everywhere'),
  ('corvis_control.stop_export_schedule'),
  ('corvis_control.stop_export_schedules_for_inactive_owners'),
  ('corvis_control.sweep_tenant_export_grants'),
  ('corvis_control.tenant_export_admin_user'),
  ('corvis_control.tenant_export_rights'),
  ('corvis_control.tenant_export_scope_changed'),
  ('corvis_control.tenant_export_system_audit'),
  ('corvis_control.transfer_service_account_owner'),
  ('corvis_control.transition_data_issue_case'),
  ('corvis_facts.apply_review_decision'),
  ('corvis_facts.assign_company_sector'),
  ('corvis_facts.canonicalize_reviewed_extraction'),
  ('corvis_facts.canonicalize_reviewed_extraction_v2'),
  ('corvis_facts.canonicalize_reviewed_extraction_v3'),
  ('corvis_facts.canonicalize_reviewed_extraction_v4'),
  ('corvis_identity.normalize_entity_name'),
  ('corvis_identity.pre_materialize_reviewed_entity_candidates'),
  ('corvis_identity.record_reviewed_entity_candidate_lineage'),
  ('corvis_semantic.normalize_sector_label'),
  ('corvis_source.release_clean_artifact');

-- Non-trigger functions the runtime role must not execute. (Trigger functions need no EXECUTE: Postgres checks it only
-- when a trigger is created, and they must still not be PUBLIC-executable.)
create temporary table rt_denied_functions (fn text primary key, reason text not null) on commit drop;
insert into rt_denied_functions values
  ('corvis_control.apply_data_right_admin', 'superseded by apply_data_right_admin_authorized (078); the application never calls it'),
  ('corvis_control.current_user_id', 'thin auth.uid() wrapper; not used by the application or any policy');

-- The only functions in a corvis_* schema that PUBLIC may execute: every role evaluating a tenant policy needs them.
create temporary table rt_public_functions (fn text primary key) on commit drop;
insert into rt_public_functions values
  ('corvis_control.has_tenant_access'),
  ('corvis_control.has_workspace_access');

create temporary table rt_schemas (schema_name text primary key) on commit drop;
insert into rt_schemas values
  ('corvis_consolidated'), ('corvis_control'), ('corvis_facts'), ('corvis_identity'),
  ('corvis_review'), ('corvis_semantic'), ('corvis_serving'), ('corvis_source');

-- Schemas the runtime role must never touch.
create temporary table rt_denied_schemas (schema_name text primary key, reason text not null) on commit drop;
insert into rt_denied_schemas values
  ('corvis_migration', 'migration ledger, owned by the migration role (db/postgres/migrate.ts)');

do $$
declare
  rt oid;
  offenders text;
  r record;
  v_priv text;
begin
  select oid into rt from pg_roles where rolname = 'corvis_runtime';
  if rt is null then raise exception 'role corvis_runtime does not exist'; end if;

  -- ---------------------------------------------------------------- the role itself
  if exists (select 1 from pg_roles where oid = rt and (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication or rolcanlogin)) then
    raise exception 'corvis_runtime must be NOLOGIN with no SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION';
  end if;
  if exists (select 1 from pg_auth_members where member = rt) then
    raise exception 'corvis_runtime must not be a member of any role (it would inherit that role''s privileges)';
  end if;
  -- A superuser/BYPASSRLS role that can act as corvis_runtime (inherits it or can SET ROLE to it) would not be bound by RLS.
  -- (Postgres 16+ makes the creating, non-superuser administrator an ADMIN-only member with neither option: harmless.)
  if current_setting('server_version_num')::integer >= 160000 then
    execute $q$
      select string_agg(distinct m.member::regrole::text, ', ')
      from pg_auth_members m join pg_roles mr on mr.oid = m.member
      where m.roleid = $1 and (mr.rolsuper or mr.rolbypassrls) and (m.inherit_option or m.set_option)
    $q$ into offenders using rt;
  else
    select string_agg(distinct m.member::regrole::text, ', ') into offenders
    from pg_auth_members m join pg_roles mr on mr.oid = m.member
    where m.roleid = rt and (mr.rolsuper or mr.rolbypassrls);
  end if;
  if offenders is not null then
    raise exception 'a superuser or BYPASSRLS role is a member of corvis_runtime (RLS would not bind it): %', offenders;
  end if;
  if exists (
    select 1 from pg_shdepend
    where refclassid = 'pg_authid'::regclass and refobjid = rt and deptype = 'o'
      and dbid in (0, (select oid from pg_database where datname = current_database()))
  ) then
    raise exception 'corvis_runtime must own no objects';
  end if;
  if has_database_privilege(rt, current_database(), 'CREATE') then
    raise exception 'corvis_runtime must not hold CREATE on the database';
  end if;

  -- ---------------------------------------------------------------- schemas: USAGE only, never CREATE
  for r in select s.schema_name, to_regnamespace(s.schema_name) as ns from rt_schemas s loop
    if r.ns is null then raise exception 'manifest schema % does not exist', r.schema_name; end if;
    if not has_schema_privilege(rt, r.ns, 'USAGE') then raise exception 'corvis_runtime lacks USAGE on schema %', r.schema_name; end if;
    if has_schema_privilege(rt, r.ns, 'CREATE') then raise exception 'corvis_runtime must not hold CREATE on schema %', r.schema_name; end if;
  end loop;
  for r in select s.schema_name from rt_denied_schemas s where to_regnamespace(s.schema_name) is not null loop
    if has_schema_privilege(rt, r.schema_name, 'USAGE') or has_schema_privilege(rt, r.schema_name, 'CREATE') then
      raise exception 'corvis_runtime must have no access to schema %', r.schema_name;
    end if;
  end loop;
  -- Where pgcrypto lives in `extensions` (the Supabase layout), apply_identity_lifecycle needs USAGE on it to find digest().
  if to_regnamespace('extensions') is not null
     and (not has_schema_privilege(rt, 'extensions', 'USAGE') or has_schema_privilege(rt, 'extensions', 'CREATE')) then
    raise exception 'corvis_runtime needs USAGE (never CREATE) on schema extensions: apply_identity_lifecycle resolves pgcrypto digest() through it';
  end if;
  -- Policy expressions run with the caller's privileges: the service-context policy and the RLS helpers call auth.uid().
  if to_regprocedure('auth.uid()') is not null and not has_function_privilege(rt, 'auth.uid()', 'EXECUTE') then
    raise exception 'corvis_runtime cannot execute auth.uid(), so no row level security policy could be evaluated for it';
  end if;
  -- A new corvis_* schema needs a deliberate decision.
  select string_agg(n.nspname, ', ' order by n.nspname) into offenders
  from pg_namespace n
  where n.nspname like 'corvis\_%'
    and not exists (select 1 from rt_schemas s where s.schema_name = n.nspname)
    and not exists (select 1 from rt_denied_schemas s where s.schema_name = n.nspname);
  if offenders is not null then
    raise exception 'new schema without a runtime-role decision (add it to the manifest in runtime-role-privileges.sql and to migration grants): %', offenders;
  end if;

  -- ---------------------------------------------------------------- tables
  select string_agg(c.relnamespace::regnamespace::text || '.' || c.relname, ', ') into offenders
  from pg_class c
  where c.relnamespace::regnamespace::text like 'corvis\_%' and c.relkind in ('r', 'p') and not c.relispartition
    and (c.relnamespace::regnamespace::text || '.' || c.relname) not in (select rel from rt_granted_tables union select rel from rt_denied_tables)
    and c.relnamespace::regnamespace::text <> 'corvis_migration';
  if offenders is not null then
    raise exception 'new table without a runtime-role grant decision (list it as granted or denied in runtime-role-privileges.sql, and grant or leave it denied in the migration): %', offenders;
  end if;
  select string_agg(rel, ', ' order by rel) into offenders
  from (select rel from rt_granted_tables union all select rel from rt_denied_tables) m
  where not exists (select 1 from pg_class c where c.oid = to_regclass(m.rel) and c.relkind in ('r', 'p'));
  if offenders is not null then raise exception 'manifest names a table that does not exist: %', offenders; end if;

  for r in select rel, privileges from rt_granted_tables loop
    for v_priv in select unnest(array['select', 'insert', 'update', 'delete']) loop
      if has_table_privilege(rt, r.rel, v_priv) <> (v_priv = any (string_to_array(r.privileges, ', '))) then
        raise exception 'table % privilege % does not match the manifest (%)', r.rel, v_priv, r.privileges;
      end if;
    end loop;
    if has_table_privilege(rt, r.rel, 'truncate') or has_table_privilege(rt, r.rel, 'references') or has_table_privilege(rt, r.rel, 'trigger') then
      raise exception 'corvis_runtime must never hold TRUNCATE, REFERENCES or TRIGGER on %', r.rel;
    end if;
  end loop;
  for r in select rel from rt_denied_tables loop
    if has_any_column_privilege(rt, r.rel, 'select, insert, update, references') or has_table_privilege(rt, r.rel, 'delete, truncate, trigger') then
      raise exception 'denied table % is accessible to corvis_runtime', r.rel;
    end if;
  end loop;
  -- No column-level grants anywhere (they would bypass the table manifest).
  select string_agg(distinct a.attrelid::regclass::text, ', ') into offenders
  from pg_attribute a
  where a.attrelid::regclass::text like 'corvis\_%' and a.attacl is not null
    and exists (select 1 from aclexplode(a.attacl) x where x.grantee = rt);
  if offenders is not null then raise exception 'column-level grants to corvis_runtime are not allowed: %', offenders; end if;
  -- The ledger table is never visible to it.
  if to_regclass('corvis_migration.schema_migration') is not null and has_any_column_privilege(rt, 'corvis_migration.schema_migration', 'select, insert, update, references') then
    raise exception 'corvis_runtime must not touch the migration ledger';
  end if;

  -- ---------------------------------------------------------------- views
  select string_agg(c.relnamespace::regnamespace::text || '.' || c.relname, ', ') into offenders
  from pg_class c
  where c.relnamespace::regnamespace::text like 'corvis\_%' and c.relkind in ('v', 'm')
    and (c.relnamespace::regnamespace::text || '.' || c.relname) not in (select rel from rt_granted_views union select rel from rt_denied_views);
  if offenders is not null then
    raise exception 'new view without a runtime-role grant decision (and it must be security_invoker): %', offenders;
  end if;
  select string_agg(rel, ', ') into offenders
  from (select rel from rt_granted_views union all select rel from rt_denied_views) m
  where not exists (select 1 from pg_class c where c.oid = to_regclass(m.rel) and c.relkind = 'v');
  if offenders is not null then raise exception 'manifest names a view that does not exist: %', offenders; end if;
  for r in select rel from rt_granted_views loop
    if not has_table_privilege(rt, r.rel, 'select') or has_table_privilege(rt, r.rel, 'insert, update, delete, truncate, references, trigger') then
      raise exception 'view % must be SELECT-only for corvis_runtime', r.rel;
    end if;
  end loop;
  for r in select rel from rt_denied_views loop
    if has_table_privilege(rt, r.rel, 'select, insert, update, delete') then raise exception 'denied view % is accessible to corvis_runtime', r.rel; end if;
  end loop;
  -- Every corvis_* view reads base tables as its caller (never as the owner, which would bypass the caller's RLS).
  select string_agg(c.relnamespace::regnamespace::text || '.' || c.relname, ', ') into offenders
  from pg_class c
  where c.relnamespace::regnamespace::text like 'corvis\_%' and c.relkind in ('v', 'm')
    and not coalesce('security_invoker=true' = any (c.reloptions), false);
  if offenders is not null then raise exception 'views must be security_invoker = true: %', offenders; end if;

  -- ---------------------------------------------------------------- sequences
  select string_agg(c.relnamespace::regnamespace::text || '.' || c.relname, ', ') into offenders
  from pg_class c
  where c.relnamespace::regnamespace::text like 'corvis\_%' and c.relkind = 'S'
    and (c.relnamespace::regnamespace::text || '.' || c.relname) not in (select rel from rt_granted_sequences)
    and c.relnamespace::regnamespace::text <> 'corvis_migration';
  if offenders is not null then
    raise exception 'new sequence without a runtime-role decision (grant USAGE in the migration and list it here): %', offenders;
  end if;
  for r in select rel from rt_granted_sequences loop
    if to_regclass(r.rel) is null then raise exception 'manifest names a sequence that does not exist: %', r.rel; end if;
    if not has_sequence_privilege(rt, r.rel, 'usage') or has_sequence_privilege(rt, r.rel, 'update') then
      raise exception 'sequence % must grant USAGE (not UPDATE) to corvis_runtime', r.rel;
    end if;
  end loop;

  -- ---------------------------------------------------------------- functions
  select string_agg(f.sig, ', ' order by f.sig) into offenders
  from (
    select p.oid::regprocedure::text as sig, n.nspname || '.' || p.proname as fn, p.prorettype = 'trigger'::regtype as is_trigger
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname like 'corvis\_%'
  ) f
  where not f.is_trigger
    and f.fn not in (select fn from rt_granted_functions union select fn from rt_denied_functions union select fn from rt_public_functions);
  if offenders is not null then
    raise exception 'new function without a runtime-role EXECUTE decision (grant it in the migration and list it as granted, or list it as denied, in runtime-role-privileges.sql): %', offenders;
  end if;
  select string_agg(fn, ', ' order by fn) into offenders
  from (select fn from rt_granted_functions union all select fn from rt_denied_functions union all select fn from rt_public_functions) m
  where not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname || '.' || p.proname = m.fn and p.prorettype <> 'trigger'::regtype
  );
  if offenders is not null then raise exception 'manifest names a function that does not exist (or is a trigger function): %', offenders; end if;

  -- Direct EXECUTE grants to corvis_runtime are exactly the granted list (PUBLIC grants are checked separately below).
  select string_agg(f.sig, ', ' order by f.sig) into offenders
  from (
    select p.oid::regprocedure::text as sig, n.nspname || '.' || p.proname as fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname like 'corvis\_%'
      and exists (select 1 from aclexplode(p.proacl) a where a.grantee = rt and a.privilege_type = 'EXECUTE')
  ) f
  where f.fn not in (select fn from rt_granted_functions);
  if offenders is not null then raise exception 'corvis_runtime holds EXECUTE on functions outside the manifest: %', offenders; end if;
  select string_agg(g.fn, ', ' order by g.fn) into offenders
  from rt_granted_functions g
  where not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname || '.' || p.proname = g.fn
      and exists (select 1 from aclexplode(p.proacl) a where a.grantee = rt and a.privilege_type = 'EXECUTE')
  );
  if offenders is not null then raise exception 'manifest says corvis_runtime may execute, but it cannot: %', offenders; end if;
  -- ...and it is a grant on every overload (a later migration adding an overload must decide it).
  select string_agg(p.oid::regprocedure::text, ', ') into offenders
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname || '.' || p.proname in (select fn from rt_granted_functions)
    and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = rt and a.privilege_type = 'EXECUTE');
  if offenders is not null then raise exception 'an overload of a granted function is not granted: %', offenders; end if;

  -- No corvis_* function is executable by PUBLIC, except the RLS helpers. (A null ACL means the built-in PUBLIC default.)
  select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text) into offenders
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname like 'corvis\_%'
    and (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'))
    and (n.nspname || '.' || p.proname) not in (select fn from rt_public_functions);
  if offenders is not null then raise exception 'functions executable by PUBLIC (REVOKE EXECUTE ... FROM PUBLIC): %', offenders; end if;
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname || '.' || p.proname) in (select fn from rt_public_functions)
      and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')
  loop
    raise exception 'RLS helper % must stay executable by PUBLIC (every policy evaluator calls it)', r.oid::regprocedure;
  end loop;
  -- Denied non-trigger functions are not executable by the runtime role through any path.
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace where (n.nspname || '.' || p.proname) in (select fn from rt_denied_functions) loop
    if has_function_privilege(rt, r.oid, 'EXECUTE') then raise exception 'denied function % is executable by corvis_runtime', r.oid::regprocedure; end if;
  end loop;

  -- SECURITY DEFINER functions never resolve names through a mutable search_path.
  select string_agg(p.oid::regprocedure::text, ', ') into offenders
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname like 'corvis\_%' and p.prosecdef
    and not coalesce(
      (select cfg like 'search_path=pg_catalog, pg_temp%' from unnest(p.proconfig) cfg where cfg like 'search_path=%'),
      false);
  if offenders is not null then raise exception 'SECURITY DEFINER functions must set search_path = pg_catalog, pg_temp: %', offenders; end if;
  select string_agg(p.oid::regprocedure::text, ', ') into offenders
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname like 'corvis\_%' and p.prosecdef
    and exists (select 1 from unnest(p.proconfig) cfg where cfg like 'search_path=%' and (cfg like '%public%' or cfg like '%$user%' or cfg like '%corvis%'));
  if offenders is not null then raise exception 'SECURITY DEFINER search_path must contain only pg_catalog and pg_temp: %', offenders; end if;

  -- ---------------------------------------------------------------- row level security for the runtime role
  -- Every runtime-reachable table with RLS carries exactly the service-context policy, and no other policy targets the role.
  select string_agg(g.rel, ', ' order by g.rel) into offenders
  from rt_granted_tables g
  join pg_class c on c.oid = g.rel::regclass
  where c.relrowsecurity
    and not exists (
      select 1 from pg_policy po
      where po.polrelid = c.oid and po.polname = 'corvis_runtime_service' and po.polcmd = '*'
        and po.polroles = array[rt]::oid[]
        and pg_get_expr(po.polqual, po.polrelid) = '(auth.uid() IS NULL)'
        and pg_get_expr(po.polwithcheck, po.polrelid) = '(auth.uid() IS NULL)'
    );
  if offenders is not null then raise exception 'runtime-reachable RLS tables without the exact corvis_runtime_service policy: %', offenders; end if;
  select string_agg(po.polrelid::regclass::text || ':' || po.polname, ', ') into offenders
  from pg_policy po
  where (rt = any (po.polroles) or po.polname = 'corvis_runtime_service')
    and not (po.polname = 'corvis_runtime_service' and po.polroles = array[rt]::oid[]
             and po.polrelid::regclass::text in (select rel from rt_granted_tables));
  if offenders is not null then raise exception 'unexpected policies naming corvis_runtime: %', offenders; end if;
  -- Policies for PUBLIC/anyone else must never be allow-all.
  select string_agg(po.polrelid::regclass::text || ':' || po.polname, ', ') into offenders
  from pg_policy po
  where po.polrelid::regclass::text like 'corvis\_%'
    and po.polname <> 'corvis_runtime_service'
    and (coalesce(pg_get_expr(po.polqual, po.polrelid), '') in ('true', '') and po.polcmd in ('r', '*', 'w', 'd'));
  if offenders is not null then raise exception 'allow-all policy on a corvis_* table: %', offenders; end if;
end
$$;

-- Functions created later by the migration role are not PUBLIC-executable (alter default privileges in migration 002).
-- Functional probe, rolled back.
create function corvis_control.rt_default_acl_probe() returns integer language sql as 'select 1';
do $$
declare
  v_acl aclitem[];
begin
  select proacl into v_acl from pg_proc where oid = 'corvis_control.rt_default_acl_probe()'::regprocedure;
  if v_acl is null or exists (select 1 from aclexplode(v_acl) a where a.grantee = 0) then
    raise exception 'a function created by this role in a corvis_* schema is executable by PUBLIC (alter default privileges revoke execute on functions from public is missing for %)', current_user;
  end if;
  if exists (select 1 from aclexplode(v_acl) a where a.grantee = 'corvis_runtime'::regrole) then
    raise exception 'a newly created function must not be granted to corvis_runtime implicitly';
  end if;
end $$;

-- A newly created table is not granted to the runtime role implicitly either.
create table corvis_control.rt_default_acl_probe (probe_id integer);
do $$
begin
  if has_any_column_privilege('corvis_runtime', 'corvis_control.rt_default_acl_probe', 'select, insert, update, references')
     or has_table_privilege('corvis_runtime', 'corvis_control.rt_default_acl_probe', 'delete, truncate, trigger') then
    raise exception 'a newly created table must not be accessible to corvis_runtime implicitly';
  end if;
end $$;

rollback;

\echo POSTGRES_RUNTIME_ROLE_PRIVILEGES_PASS
