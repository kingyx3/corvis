-- Close a row-level-security consistency gap: several tables enabled RLS
-- (migrations 001-006) but were never patched to FORCE it, unlike every
-- table added or hardened from migration 007 onward. Without FORCE, RLS is
-- not applied to the table owner, so an ad hoc session connected as the
-- owning role (for example a direct Supabase SQL-editor/console session,
-- distinct from the application's own service-role connection) would see
-- every tenant's rows unfiltered instead of the intended deny-by-default.
--
-- This has no effect on the running application: server-side requests use
-- a service-role-equivalent connection that already bypasses RLS by design
-- (see the comment on corvis_control.current_user_id in migration 001) and
-- rely on the explicit tenant_id predicates in lib/server/platform-repositories.ts
-- for isolation, not RLS. FORCE only closes the owner/ad hoc-connection gap.
--
-- corvis_identity.company/fund/entity_* and corvis_semantic.metric_definition
-- are intentionally excluded: they are global economic-identity/reference
-- data with no tenant_id column, not tenant-private rows.

begin;

alter table corvis_control.tenant force row level security;
alter table corvis_control.workspace force row level security;
alter table corvis_control.membership force row level security;
alter table corvis_control.resource_entitlement force row level security;
alter table corvis_control.feature_flag force row level security;
alter table corvis_control.feature_flag_emergency_stop force row level security;
alter table corvis_control.idempotency_key force row level security;
alter table corvis_control.audit_event force row level security;
alter table corvis_control.control_evidence force row level security;
alter table corvis_control.deletion_execution_evidence force row level security;
alter table corvis_control.deletion_request force row level security;
alter table corvis_control.exception force row level security;
alter table corvis_control.legal_hold force row level security;
alter table corvis_control.outbox_event force row level security;
alter table corvis_control.processing_job force row level security;
alter table corvis_control.retention_policy force row level security;
alter table corvis_control.semantic_query_log force row level security;
alter table corvis_control.webhook_delivery force row level security;
alter table corvis_control.webhook_subscription force row level security;

alter table corvis_source.acquired_document force row level security;
alter table corvis_source.document force row level security;
alter table corvis_source.document_artifact_version force row level security;
alter table corvis_source.source_connection_run force row level security;
alter table corvis_source.source_reference force row level security;

alter table corvis_facts.observation force row level security;
alter table corvis_facts.observation_correction force row level security;
alter table corvis_facts.review_event force row level security;

alter table corvis_consolidated.fund_period_snapshot force row level security;
alter table corvis_consolidated.reconciliation force row level security;
alter table corvis_consolidated.reconciliation_exception force row level security;
alter table corvis_consolidated.reconciliation_resolution_event force row level security;
alter table corvis_consolidated.snapshot_publication_event force row level security;

alter table corvis_serving.export_download_grant force row level security;
alter table corvis_serving.export_job force row level security;

commit;
