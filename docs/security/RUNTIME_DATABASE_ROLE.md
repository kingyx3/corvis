# Runtime database role (`corvis_runtime`)

Status: the role, its grants and its acceptance suites exist as of migration 002. **The application's connection has not been switched**; it still connects with the owner/service credential. This document is the design, the guard rails for future migrations, and the per-environment rollout plan.

## Why

No migration used to grant anything to an application role. The application connected as the table owner / Supabase service role, bypassed row level security (says so) and every tenant boundary rested on `tenant_id = $1` predicates in TypeScript. Every function in the `corvis_*` schemas was also executable by `PUBLIC`.

## The role

`corvis_runtime` is a **NOLOGIN group role**: not a superuser, no `BYPASSRLS`, no `CREATEROLE`/`CREATEDB`/`REPLICATION`, owns nothing, member of no other role, no `CREATE` on any schema or the database, and no access to the migration ledger (`corvis_migration`). A deployment creates its own login role per environment and grants membership (`grant corvis_runtime to <login role>`); the migration role stays separate and keeps ownership and DDL.

What it is granted (all explicit; the manifest is `db/postgres/tests/runtime-role-privileges.sql`):

| Object | Grant |
| --- | --- |
| the eight `corvis_*` schemas (`consolidated`, `control`, `facts`, `identity`, `review`, `semantic`, `serving`, `source`) | `USAGE` |
| 109 tables | exactly the `SELECT`/`INSERT`/`UPDATE`/`DELETE` listed in the appendix, never `TRUNCATE`/`REFERENCES`/`TRIGGER`, no column-level grants |
| 13 serving views | `SELECT` |
| the 4 event sequences | `USAGE` |
| 110 functions | `EXECUTE` |
| schema `extensions` (when present, Supabase layout) | `USAGE`, so `apply_identity_lifecycle` finds pgcrypto's `digest()` |
| `auth.uid()` | `EXECUTE`, because policy expressions run with the caller's privileges |

Deliberately **denied** (the manifest records why): `corvis_consolidated.reconciliation`, `corvis_control.control_evidence_escalation`, `corvis_control.exception`, `corvis_identity.entity_relationship` and its view `corvis_serving.entity_relationships` (the application never reaches them), the superseded `corvis_control.apply_data_right_admin` and `corvis_control.current_user_id`, and the `corvis_migration` schema.

Least privilege is real, not nominal. Tables the application changes only through a `SECURITY DEFINER` function get no DML at all (for example `corvis_control.data_rights` is `SELECT` only; `apply_data_right_admin_authorized` writes it as its owner). Append-only tables (`audit_event`, `control_evidence`, the history/event tables) get no `UPDATE`/`DELETE`, so their triggers are a second line of defence rather than the only one. No trigger or guard was changed. Trigger functions get no `EXECUTE` grant (Postgres checks it only when a trigger is created).

### How the grants were derived

From the application's SQL (`src/modules/*/server`, `src/platform`, `src/app/api`, `src/modules/*/domain`) with the verb (`select`/`insert into`/`update`/`delete from`, `for update`/`for share` which need `UPDATE`, `on conflict do update`) read per statement, plus the transitive closure through the bodies of the `SECURITY INVOKER` functions the application calls and the trigger functions its DML fires (a `SECURITY DEFINER` body runs with its owner's privileges and contributes nothing), plus the base tables of every granted view (the views are `security_invoker`). The suites in the next section then ran the real application code on those privileges; every privilege a suite needed beyond them is either added or listed as test-only in `db/postgres/tests/runtime-role-ci-fixture.sql`.

## Row level security for this role

Every `corvis_*` table has RLS enabled **and forced**, but the only policies are `SELECT` policies for end users (`auth.uid()` membership). A role without `BYPASSRLS` would therefore see and write nothing. So each granted table with RLS carries one policy:

```sql
create policy corvis_runtime_service on <table> for all to corvis_runtime
  using (auth.uid() is null) with check (auth.uid() is null);
```

- The application never binds an end-user subject (it authorizes in code), so `auth.uid()` is null and its behaviour is unchanged: it is the same trusted service tier it is today, and **tenant isolation in this mode still rests on the `tenant_id` predicates in the repositories.** This change does not make a bug in those predicates impossible; it removes everything else a compromised or buggy runtime could do (DDL, ownership, ungranted tables and functions, append-only mutation, escaping RLS, the migration ledger).
- A session connected as this role that **does** bind a subject (`request.jwt.claim.sub`) is held to the ordinary tenant/workspace policies: it sees only that subject's tenant, cannot write, and sees server-only tables as empty. This is what the isolation negatives below prove without any owner bypass.
- Follow-up (not done here, needs application changes): bind the tenant per request/transaction so that RLS also pins service-context queries to one tenant.

## Functions

`EXECUTE` is revoked from `PUBLIC` on every function in every `corvis_*` schema (they were all callable by anyone with schema `USAGE`). The only `PUBLIC` exceptions are `corvis_control.has_tenant_access` and `has_workspace_access`: every role that evaluates a tenant policy must be able to call them and they only answer "does the caller have access". `alter default privileges revoke execute on functions from public` stops later migrations from re-opening it for functions created by the migration role.

## Views and `SECURITY DEFINER`

- The ten older `corvis_serving` views (`documents`, `entity_directory`, `entity_relationships`, `fund_period_snapshots`, `holdings`, `instruments`, `observations`, `position_financial_statement_values`, `reconciliation_exceptions`, `source_references`) were owner-evaluated, so a role with `SELECT` on a view read every tenant's base rows. They are now `security_invoker = true` like the later views, and the manifest test requires every `corvis_*` view to be.
- `has_tenant_access`, `has_workspace_access` and `accept_tenant_invitation` pin `search_path = pg_catalog, pg_temp` (every object reference in their bodies was already schema-qualified), like `apply_data_right_admin_authorized`. The manifest test fails any `SECURITY DEFINER` function in a `corvis_*` schema with another `search_path`.

## Guard rails for future migrations

`db/postgres/tests/runtime-role-privileges.sql` (CI) fails when:

- a table, view, sequence, function or schema exists in a `corvis_*` schema without an entry in the manifest (granted, or denied with a reason), or a manifest entry no longer exists;
- the role's actual privileges differ from the manifest in either direction (including `TRUNCATE`/`REFERENCES`/`TRIGGER`, column grants, overloads);
- any `corvis_*` function is executable by `PUBLIC` other than the two helpers, or a function created later by the migration role is;
- the role is not a plain NOLOGIN group role, owns anything, has `CREATE`, or has a `BYPASSRLS`/superuser member;
- a view is not `security_invoker`, or a `SECURITY DEFINER` function has a mutable `search_path`;
- a runtime-reachable RLS table lacks exactly the `corvis_runtime_service` policy, or any other policy names the role or is allow-all.

So a new table is **denied by default**: the author must add it to the manifest *and* to the grant lists in a migration, with a reason. A granted table with row level security also needs the `corvis_runtime_service` policy shown above (copy the `do` block of the schema: grant, then `drop policy if exists` and `create policy`), otherwise the role sees and writes nothing in it. Rules of thumb: grant only the verbs the code issues; a table written only through a `SECURITY DEFINER` function gets `SELECT` at most; an append-only table never gets `UPDATE`/`DELETE`; a new view is `security_invoker`; a new function is granted only if the application (or an invoker function it calls) calls it.

## Acceptance as the runtime role

`db/postgres/tests/run-as-runtime.sh` (CI step "Postgres runtime-role acceptance") runs, on a clean database:

1. `runtime-role-privileges.sql` (above);
2. `runtime-role-acceptance.sql`: the tenant-isolation negatives of `security_acceptance.sql` and `tenant-isolation-negative.sql` under `set local role corvis_runtime` (no owner bypass): service context works and is bounded, DDL/append-only/ungranted/RLS-escape attempts are refused, and subject-bound sessions see exactly their tenant through base tables and every security-invoker view;
3. `security_acceptance.sql` itself, connected as a login role that is a member of `corvis_runtime`: it hands over to `db/postgres/runtime_security_acceptance.sql` (the same probe run entirely as the runtime role; the owner path is unchanged), so the live acceptance workflow keeps one entry point before and after the DSN switch;
4. 9 existing SQL and 6 application suites as that login role only (strict), and 4 SQL and 7 application suites as a second login role that additionally holds the test-only fixture privileges of `runtime-role-ci-fixture.sql` (seed/cleanup statements the application never issues). Those 13 application suites are all the real-Postgres `.mjs` suites in CI that use the migrated schema; they drive the application's own repositories and SQL on the runtime role's privileges.

Not runnable as a non-owner, because they perform owner-only operations the application never does (their application-level `.mjs` counterparts above do run): `processing-retry-exhaustion.sql` (`CREATE SCHEMA`/`ALTER EXTENSION`), `tenant-data-export.sql` and `export-schedules.sql` (`ALTER TABLE ... DISABLE TRIGGER`), and `data-issue-reports.sql`, `review-item-discussion.sql`, `service-accounts.sql`, `session-policy.sql`, `tenant-identity-records.sql`, `tenant-isolation-negative.sql` (`CREATE`/`DROP ROLE` for their own negative-role probes). They keep running as the owner, unchanged apart from the seven "no client policy may exist" assertions, which now ignore the one `corvis_runtime_service` policy.

Application code paths that no real-Postgres suite exercises (and the checks above therefore cannot prove) rest on the static derivation; that is what the UAT step below exists to catch.

## Rollout plan

Per environment, UAT first, then production. Nothing here is automated by this change; no Terraform or Cloud Run wiring was altered.

0. **Prerequisite: a separate migration credential.** `terraform-deploy.yml` applies migrations with the *same* `corvis-postgres-dsn-${environment}` secret the runtime reads. The runtime role has no DDL and no access to `corvis_migration`, so before the runtime DSN is switched, migrations must read a different secret holding the owner/migration role's DSN (create the Terraform-managed secret container, add the version through the controlled provider path, point the "Apply versioned Postgres migrations" step at it). Do not proceed until a deploy has applied migrations with it.
1. **Apply migration 002** through the normal deploy (as the migration role). It creates `corvis_runtime`, the grants, the policies, the `security_invoker` views and the `PUBLIC` revoke. It does not change the running application (the owner/service role is unaffected). If the migration role cannot create roles, pre-create `corvis_runtime` as a plain NOLOGIN role first; the migration verifies and refuses an unsafe pre-existing role. Check for the two warnings the migration can raise (`auth.uid()`, schema `extensions`) and grant by hand as the schema owner if present.
2. **Create the login role** (as an administrator, per environment; never in a migration, so no password is committed): `create role corvis_app login password '<generated>' nosuperuser nobypassrls nocreaterole nocreatedb noreplication connection limit <n>; grant corvis_runtime to corvis_app;` Set role defaults as needed, for example `alter role corvis_app set statement_timeout = '30s'` (see the pooler note in `DATA_PLATFORM.md`). Grant nothing else to it; it must not become a member of the owner role.
3. **Verify as the new login** (`psql` with its DSN): `run-as-runtime.sh` is for disposable databases only. Against a live one run `db/postgres/security_acceptance.sql` (it hands over to the runtime probe, rolls back, and prints `POSTGRES_RLS_SECURITY_ACCEPTANCE_PASS`), and `db/postgres/tests/runtime-role-privileges.sql` as the migration role.
4. **Change the DSN secret** `corvis-postgres-dsn-${environment}` to a new enabled version for `corvis_app`, through the controlled provider path (the DSN is never a Terraform input); keep the previous version in place but not latest for rollback. Roll the Cloud Run services and the processing worker so they read the new version.
5. **Run the acceptance suite in UAT as that role:** the Security acceptance workflow's Postgres RLS job already reads the runtime DSN and runs `security_acceptance.sql`, which now dispatches to the runtime probe. Then run the UAT smoke/E2E and watch the logs for `permission denied` (SQLSTATE `42501`) for at least one full processing-worker cycle (stage delivery, transport, exports, notifications, schedules). Any `42501` is a missing grant: fix it with a new migration that grants the minimum **and** updates the manifest, not by widening the role.
6. **Production:** repeat steps 1 to 5 once UAT has been clean through a full cycle. Record the evidence (acceptance output, absence of `42501`) with the release.
7. **Cleanup:** once production has run clean, disable (not delete) the previous owner/service DSN version after the retention window, and keep the migration credential restricted to the deploy workflow.

**Rollback** is a DSN revert: make the previous secret version (the owner/service credential) the enabled latest version and roll the services. The role, grants and policies are inert for that credential, so nothing in the database needs reverting; if a grant gap is found, ship the migration and retry.

## Appendix: table grants and their code references

The third column is the first reference found (an application file, or the function whose body touches the table); `+N` is the number of further application files. Verbs come from the statements in those references.

| Table | Privileges | Reference |
| --- | --- | --- |
| `corvis_consolidated.consolidated_fact` | SELECT, INSERT, UPDATE | src/modules/delivery/server/exports/export-delivery.ts+5 |
| `corvis_consolidated.consolidation_run` | SELECT, INSERT, UPDATE | function corvis_consolidated.consolidate_reconciliation |
| `corvis_consolidated.fund_period_snapshot` | SELECT, INSERT, UPDATE | src/modules/delivery/server/exports/export-delivery.ts+10 |
| `corvis_consolidated.publication_run` | SELECT, INSERT, UPDATE | src/modules/processing/server/stages/processing-published-stage.ts |
| `corvis_consolidated.reconciliation_exception` | SELECT, INSERT, UPDATE | src/modules/delivery/server/exports/physical-exports.ts+4 |
| `corvis_consolidated.reconciliation_resolution_event` | SELECT, INSERT | src/modules/workspace/server/workspace-summary.ts |
| `corvis_consolidated.reconciliation_run` | SELECT, INSERT, UPDATE | src/modules/delivery/server/exports/export-delivery.ts+3 |
| `corvis_consolidated.snapshot_publication_event` | SELECT, INSERT | src/platform/database/postgres-lineage.ts |
| `corvis_control.api_rate_limit` | SELECT, INSERT, UPDATE | function corvis_control.consume_api_rate_limit |
| `corvis_control.audit_event` | SELECT, INSERT | src/modules/governance/server/evidence/audit-query.ts+5 |
| `corvis_control.control_definition` | SELECT, UPDATE | function corvis_control.promote_control_implementation |
| `corvis_control.control_evidence` | SELECT, INSERT | src/platform/data/operations.ts |
| `corvis_control.control_evidence_record` | SELECT, INSERT | src/modules/governance/server/evidence/control-evidence-collector.ts |
| `corvis_control.control_evidence_requirement` | SELECT | function corvis_control.promote_control_implementation |
| `corvis_control.data_correction_incident` | SELECT, INSERT, UPDATE | src/modules/governance/server/lifecycle/data-correction.ts |
| `corvis_control.data_issue_case` | SELECT, INSERT, UPDATE | src/modules/governance/server/data-issues/data-issue.ts |
| `corvis_control.data_issue_case_event` | SELECT, INSERT | src/modules/governance/server/data-issues/data-issue.ts |
| `corvis_control.data_rights` | SELECT | src/app/api/v1/admin/access-review/route.ts+3 |
| `corvis_control.deletion_execution_evidence` | SELECT, INSERT | src/modules/governance/server/lifecycle/data-lifecycle.ts |
| `corvis_control.deletion_request` | SELECT, INSERT, UPDATE | src/modules/governance/server/lifecycle/data-lifecycle.ts+1 |
| `corvis_control.email_outbox` | SELECT, INSERT, UPDATE | src/modules/delivery/server/schedules/export-schedule-notifications.ts+1 |
| `corvis_control.event_inbox` | SELECT, INSERT, UPDATE | src/platform/data/platform-repositories.ts |
| `corvis_control.export_schedule` | SELECT, INSERT, UPDATE | src/modules/delivery/server/exports/export-history.ts+2 |
| `corvis_control.export_schedule_run` | SELECT, INSERT | src/modules/delivery/server/exports/export-history.ts+2 |
| `corvis_control.feature_flag` | SELECT, INSERT, UPDATE | src/modules/admin/server/feature-flags.ts+1 |
| `corvis_control.feature_flag_emergency_stop` | SELECT, INSERT, UPDATE | src/modules/admin/server/feature-flags.ts |
| `corvis_control.idempotency_key` | SELECT, INSERT, DELETE | src/platform/http/limits/idempotency.ts |
| `corvis_control.identity_lifecycle_event` | SELECT, INSERT | function corvis_control.reactivate_identity_admin |
| `corvis_control.identity_subject` | SELECT, INSERT, UPDATE | src/app/api/v1/admin/access-review/route.ts+10 |
| `corvis_control.legal_hold` | SELECT | src/modules/governance/domain/data-retention.ts+2 |
| `corvis_control.membership` | SELECT, INSERT, UPDATE, DELETE | src/app/api/v1/admin/access-review/route.ts+7 |
| `corvis_control.notification_preference` | SELECT, INSERT, UPDATE | src/modules/notifications/server/notifications.ts |
| `corvis_control.notification_recipient` | SELECT, INSERT, UPDATE | src/modules/notifications/server/notifications.ts |
| `corvis_control.outbox_event` | SELECT, INSERT, UPDATE | src/modules/delivery/server/exports/delivery.ts+4 |
| `corvis_control.processing_job` | SELECT, INSERT, UPDATE | src/platform/data/operations.ts+4 |
| `corvis_control.processing_recovery_event` | SELECT, INSERT | src/platform/data/platform-repositories.ts |
| `corvis_control.processing_stage_effect` | SELECT, INSERT, UPDATE | src/modules/processing/server/stages/processing-reviewed-stage.ts |
| `corvis_control.research_answer_pin` | SELECT, INSERT, DELETE | src/modules/research/server/research-pins.ts |
| `corvis_control.resource_entitlement` | SELECT, INSERT, UPDATE, DELETE | src/app/api/v1/admin/access-review/route.ts+4 |
| `corvis_control.retention_policy` | SELECT | src/modules/governance/domain/data-retention.ts+2 |
| `corvis_control.review_item_comment` | SELECT, INSERT | src/modules/review/server/review-discussion.ts |
| `corvis_control.review_item_thread` | SELECT, INSERT, UPDATE | src/modules/review/server/review-discussion.ts |
| `corvis_control.semantic_query_log` | SELECT, INSERT, UPDATE | src/modules/research/server/research-pins.ts+1 |
| `corvis_control.service_account` | SELECT, INSERT, UPDATE | src/modules/identity-access/server/service-accounts/service-account-credential.ts+1 |
| `corvis_control.service_account_credential` | SELECT, INSERT, UPDATE | src/modules/identity-access/server/service-accounts/service-account-credential.ts+1 |
| `corvis_control.service_identity_grant` | SELECT, INSERT, UPDATE | src/app/api/v1/admin/access-review/route.ts+1 |
| `corvis_control.session_revocation` | SELECT, INSERT | src/modules/identity-access/server/authorization.ts+1 |
| `corvis_control.support_access_grant` | SELECT, INSERT, UPDATE, DELETE | src/app/api/v1/admin/access-review/route.ts+4 |
| `corvis_control.tenant` | SELECT, INSERT, UPDATE | src/app/api/v1/admin/tenant-health/route.ts+7 |
| `corvis_control.tenant_access_notification` | SELECT, INSERT, UPDATE | src/modules/identity-access/server/tenants/support-access-self-service.ts+1 |
| `corvis_control.tenant_export_download_grant` | SELECT, INSERT, UPDATE, DELETE | src/modules/delivery/server/tenant-export/tenant-export.ts |
| `corvis_control.tenant_export_request` | SELECT, INSERT, UPDATE | src/modules/delivery/server/tenant-export/tenant-export-operations.ts+1 |
| `corvis_control.tenant_export_request_event` | SELECT, INSERT | src/modules/delivery/server/tenant-export/tenant-export.ts |
| `corvis_control.tenant_identity_provider` | SELECT, INSERT, UPDATE | src/modules/identity-access/server/authorization.ts+1 |
| `corvis_control.tenant_invitation` | SELECT, INSERT, UPDATE | src/app/api/v1/admin/tenant-health/route.ts+4 |
| `corvis_control.tenant_scim_configuration` | SELECT, INSERT, UPDATE | src/modules/identity-access/server/directory/scim.ts+1 |
| `corvis_control.tenant_scim_identity` | SELECT, INSERT, UPDATE | src/modules/identity-access/server/directory/scim.ts+1 |
| `corvis_control.tenant_session_activity` | SELECT, INSERT, UPDATE, DELETE | src/modules/identity-access/server/sessions/session-activity-sweep.ts+1 |
| `corvis_control.tenant_session_policy` | SELECT, INSERT, UPDATE | src/modules/identity-access/server/sessions/session-policy.ts |
| `corvis_control.tenant_verified_domain` | SELECT, INSERT, DELETE | src/modules/identity-access/server/directory/identity-records.ts |
| `corvis_control.webhook_delivery` | SELECT, INSERT, UPDATE | src/modules/delivery/server/exports/delivery.ts+1 |
| `corvis_control.webhook_signing_key` | SELECT, INSERT, UPDATE | src/modules/delivery/server/exports/delivery.ts+1 |
| `corvis_control.webhook_subscription` | SELECT, INSERT, UPDATE | src/modules/delivery/server/exports/delivery.ts+1 |
| `corvis_control.workspace` | SELECT, INSERT | src/app/api/v1/admin/access-review/route.ts+12 |
| `corvis_control.workspace_user_preference` | SELECT, INSERT, UPDATE | src/modules/notifications/server/notifications.ts+2 |
| `corvis_facts.canonical_candidate` | SELECT, INSERT | function corvis_facts.canonicalize_reviewed_extraction_v3 |
| `corvis_facts.canonicalization_run` | SELECT, INSERT, UPDATE | function corvis_consolidated.reconcile_canonicalization |
| `corvis_facts.client_portfolio` | SELECT | view corvis_serving.client_portfolios |
| `corvis_facts.client_portfolio_fund_position` | SELECT | view corvis_serving.client_portfolio_fund_positions |
| `corvis_facts.company_sector_classification` | SELECT, INSERT, UPDATE | view corvis_serving.company_sectors |
| `corvis_facts.holding` | SELECT, INSERT, UPDATE | src/platform/data/platform-repositories.ts |
| `corvis_facts.holding_revision` | INSERT | function corvis_facts.canonicalize_reviewed_extraction_v2 |
| `corvis_facts.instrument` | SELECT, INSERT, UPDATE | view corvis_serving.instruments |
| `corvis_facts.instrument_revision` | INSERT | function corvis_facts.canonicalize_reviewed_extraction_v2 |
| `corvis_facts.observation` | SELECT, INSERT, UPDATE | src/platform/data/platform-repositories.ts+2 |
| `corvis_facts.observation_correction` | SELECT, INSERT | function corvis_facts.apply_review_decision |
| `corvis_facts.observation_source_reference` | SELECT, INSERT | src/modules/analytics/server/performance-scorecard.ts+1 |
| `corvis_facts.position_financial_statement` | SELECT, INSERT | view corvis_serving.position_financial_statement_values |
| `corvis_facts.position_financial_statement_line` | SELECT, INSERT | view corvis_serving.position_financial_statement_values |
| `corvis_facts.position_financial_statement_value` | SELECT, INSERT | view corvis_serving.position_financial_statement_values |
| `corvis_facts.review_event` | SELECT, INSERT | src/platform/data/platform-repositories.ts |
| `corvis_identity.company` | SELECT, INSERT | src/modules/workspace/server/company-sectors.ts+1 |
| `corvis_identity.entity_external_identifier` | SELECT | view corvis_serving.entity_directory |
| `corvis_identity.entity_lifecycle_event` | SELECT, INSERT | src/platform/data/public-serving-resources.ts |
| `corvis_identity.entity_lifecycle_participant` | SELECT, INSERT | src/platform/data/public-serving-resources.ts |
| `corvis_identity.entity_name` | SELECT, INSERT, UPDATE | view corvis_serving.entity_directory |
| `corvis_identity.fund` | SELECT, INSERT | src/modules/analytics/server/performance-scorecard.ts+2 |
| `corvis_identity.tenant_entity_lifecycle_evidence` | SELECT, INSERT, UPDATE | src/platform/data/public-serving-resources.ts |
| `corvis_identity.tenant_entity_name` | SELECT, INSERT | function corvis_control.access_policy_resource_belongs_to_tenant |
| `corvis_identity.tenant_entity_revision` | INSERT | function corvis_identity.record_reviewed_entity_candidate_lineage |
| `corvis_identity.tenant_lifecycle_revision` | INSERT | function corvis_facts.canonicalize_reviewed_extraction_v3 |
| `corvis_review.candidate_review_event` | SELECT, INSERT | src/modules/processing/server/stages/processing-reviewed-stage.ts |
| `corvis_review.candidate_review_requirement` | SELECT, INSERT | src/modules/processing/server/stages/processing-reviewed-stage.ts |
| `corvis_review.extraction_review_gate` | SELECT, INSERT, UPDATE | src/modules/processing/server/stages/processing-reviewed-stage.ts |
| `corvis_semantic.metric_definition` | SELECT | src/modules/analytics/domain/performance-scorecard.ts+2 |
| `corvis_semantic.sector` | SELECT | src/app/api/v1/sectors/route.ts+2 |
| `corvis_semantic.sector_alias` | SELECT | src/modules/workspace/domain/sector-taxonomy.ts+1 |
| `corvis_serving.export_download_grant` | SELECT, INSERT, UPDATE, DELETE | src/modules/delivery/server/exports/export-grant-sweep.ts+1 |
| `corvis_serving.export_job` | SELECT, INSERT, UPDATE | src/modules/delivery/server/exports/delivery.ts+4 |
| `corvis_source.acquired_document` | SELECT, INSERT | src/modules/sources/server/connectors/source-connector-sync.ts+2 |
| `corvis_source.document` | SELECT, INSERT, UPDATE | src/modules/processing/server/stages/processing-published-stage.ts+8 |
| `corvis_source.document_artifact_version` | SELECT, INSERT, UPDATE | src/platform/database/postgres-lineage.ts+8 |
| `corvis_source.document_representation` | SELECT, INSERT | src/modules/processing/server/stages/processing-extracted-stage.ts+1 |
| `corvis_source.extraction_candidate` | SELECT, INSERT | src/modules/processing/server/stages/processing-extracted-stage.ts+1 |
| `corvis_source.extraction_candidate_source_reference` | SELECT, INSERT | src/modules/processing/server/stages/processing-extracted-stage.ts |
| `corvis_source.extraction_run` | SELECT, INSERT, UPDATE | src/modules/processing/server/stages/processing-extracted-stage.ts+1 |
| `corvis_source.source_connection` | SELECT, INSERT, UPDATE | src/modules/sources/server/connectors/source-connector-governance.ts+5 |
| `corvis_source.source_connection_run` | SELECT, INSERT, UPDATE | src/modules/sources/server/connectors/source-connector-sync.ts+2 |
| `corvis_source.source_reference` | SELECT, INSERT | src/modules/delivery/server/exports/export-delivery.ts+8 |
