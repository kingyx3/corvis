# Data platform implementation

This file is the technical source of truth for Corvis structured-data implementation. Confluence owns the business semantics, canonical data requirements, customer rights and activation decisions.

## System-of-record boundaries

| Data class | Technical authority | Rule |
| --- | --- | --- |
| Original documents / replayable binary artifacts | GCS | Private, immutable/versioned evidence. Relational stores retain object references, hashes and source coordinates rather than large BLOBs. |
| Operational / canonical structured state | Supabase Postgres | Sole application write authority for tenant/control state, governed source metadata, observations, review history, reconciliation, snapshots and serving records. |
| Search/vector acceleration | Postgres FTS / pgvector initially | Rebuildable acceleration only; never a source of truth. |
| Large-scale analytics / warehouse delivery | Snowflake only when activated | Downstream replica/derived analytical layer. No application dual writes. |

## Logical ownership

```text
GCS source evidence
      ↓ references/events
Supabase Postgres
  control   — tenants, workspaces, memberships, roles, entitlements, flags, idempotency
  source    — document/artifact registry, representations, source references, chunks
  canonical — identities, holdings, instruments, append-only observations
  curated   — reconciliations, consolidated/derived facts, fund-period snapshots
  semantic  — dimensions, measures, formula/version metadata
  serving   — tenant-safe application/API/export read models
  internal  — rights-filtered Corvis analytics where explicitly allowed
      ↓ optional governed CDC/export
Snowflake analytical replica / secure sharing
```

These are logical domains. Physical PostgreSQL schema names may vary if migrations preserve the boundaries and contracts.

## PostgreSQL implementation rules

- Every tenant-sensitive row carries `tenant_id` or an equivalent enforceable tenant key.
- Global economic/entity identity never widens tenant visibility.
- Backend authorization is authoritative; Postgres RLS is defense-in-depth and must independently prevent cross-tenant leakage.
- RLS policies, grants, roles and security-definer functions require explicit negative tests for horizontal and vertical privilege escalation.
- Source observations are append-only. Corrections/restatements create new versions/derived records rather than rewriting disclosed history.
- Economic validity and system-knowledge validity are represented separately where the data contract requires them.
- Every published material fact must resolve through reviewed/consolidated state to exact retained source evidence in GCS.
- Backups/PITR are recovery mechanisms, not a substitute for explicit business history/versioning.

## Migration ownership

Target layout:

```text
db/postgres/
  migrations/
  replication/
```

Version-controlled SQL owns:

- schemas/tables;
- constraints and indexes;
- extensions;
- RLS policies;
- database roles/grants;
- functions/triggers;
- seed/reference data where appropriate;
- replication publication / replica identity / source grants if downstream CDC is activated.

Terraform may create/manage the Supabase project and provider-supported project settings, but SQL migrations are the authoritative database contract.

### Migration replay and lineage assurance

`db/postgres/migrate.ts` (backed by `lib/server/postgres-migration-runner.ts`) is a
deterministic, forward-only replay tool: it discovers every versioned migration,
refuses a version gap, duplicate version, or drift between an already-applied
migration's recorded checksum and its current repository content, and records
every applied version in a runner-owned `corvis_migration.schema_migration`
ledger inside the same transaction as the migration's own DDL. `--dry-run`
produces the full replay plan without contacting a database; `--apply` replays
only pending migrations against `CORVIS_POSTGRES_DSN` and is safe to re-run
against an up-to-date database (it then executes no migration SQL). Deployment
workflows are expected to call this tool rather than applying SQL by hand.

`lib/server/postgres-lineage.ts` walks a published fund-period snapshot back
through consolidated facts, canonical observations, source references and
retained GCS artifact evidence, reporting every broken hop explicitly instead
of inferring reproducibility. This proves the repository-side half of
historical-snapshot reproducibility and lineage reconciliation.

**Still provider-gated, not covered by the above:** actually running replay
against a provisioned UAT/prod Supabase project, backup/restore and PITR
exercises, and representative large-dataset/performance tests. Those require
#13's environment provisioning and are tracked there, not simulated here.

### Cross-document reconciliation semantics (migration 080)

Documents for the same fund-period deliberately share one draft snapshot, so
reconciliation compares each document against the other documents of that draft
(not only against itself). The policy is fail-closed and never drops lineage:

- **Conflicting values.** The same exact semantic grain (subject, metric
  definition dimensions, period, scenario, currency/unit, adjustment and
  breakdown dimensions) with a different normalized value in another document's
  reconciliation run opens a `reconciliation_conflict` exception on the later
  document's run (`context.conflictScope = 'cross_document'`, every competing
  observation listed). That run and its stage job block and the snapshot cannot
  publish while the exception is open. Resolution is the existing governed
  `accept_reconciliation` flow, which resumes the blocked job without re-checking
  documents that arrived later. Accepting a conflict publishes the values only as
  retained `conflicting_alternative` facts (all documents' facts of that grain are
  relabelled, none deleted); they are excluded from published totals and never
  selected or summed. Choosing one value requires the governed correction path.
- **Backstop.** `assert_snapshot_publishable` refuses a snapshot whose facts
  disagree on a grain unless every such fact is a `conflicting_alternative` with
  an attributable resolved exception, so facts that bypassed reconciliation still
  cannot be summed.
- **Identical values.** An identical fact from a second document merges into the
  existing deterministic fact (same snapshot + grain + value): it keeps its first
  `reconciliation_run_id`, gains the union of `source_observation_ids`, is marked
  `equivalent_grain`, and appears in both documents' consolidation runs. Replays
  inside the same reconciliation run still require exact lineage.
- Observations whose grain differs (for example a different `report_date` or
  `period_start`) are different grains and remain separate facts.

### Data-issue reports (migration 083)

Customer reports on published figures (F5) live in `corvis_control.data_issue_case` (current state; scope, comment and reporter are immutable by trigger) and the append-only `data_issue_case_event` history (ordered by `event_seq`). Both are server-managed: RLS enabled and forced, no client policy, because a case is visible to its reporter and to Organization Admins only, which is a predicate on the reporter's identity that tenant membership cannot express. `data_issue_case.correction_incident_id` links a case to the governed `data_correction_incident` (022); a `corrected` case copies the replacement snapshot id and version from that incident.

Three `security invoker` functions own the writes: `report_data_issue` (idempotent per reporter and key, validates that a named snapshot exists for the fund, writes only the case and its first history row), `transition_data_issue_case` (the `received -> investigating -> corrected | no_change` machine with compare-and-set on the expected status) and `close_data_issue_cases_for_correction` (corrects every linked investigating case once a correction has resolved). **Reporting never touches `fund_period_snapshot`, observations, facts, publication events, `data_correction_incident`, processing jobs or the outbox**; `db/postgres/tests/data-issue-reports.sql` asserts that by fingerprinting those tables around a report, alongside the state machine, immutability, tenant isolation and the forced-RLS/no-policy shape, and `data-issue-reports.mjs` drives the same SQL through the application repository. Migration 083 also adds `data_issue_update` to the `email_outbox` and `notification_preference` category checks (see `NOTIFICATIONS.md`). API surface: `API_CONVENTIONS.md` (Data issues).

### Organization session policy (migration 087)

Corvis verifies bearer tokens from one configured identity provider; it does not run the sign-in. Migration 087 adds what an Organization Admin can govern on top of that: `corvis_control.tenant_session_policy` (one row per tenant: an optional idle timeout and an optional maximum session length, with `CHECK` bounds of 15 to 480 and 60 to 10,080 minutes and idle never above the session length, a `version` for compare-and-set, and who last changed it) and `tenant_session_activity` (the sessions Corvis has seen, keyed by tenant, auth method, subject and session id, with first and last seen times). Both are server-managed with RLS enabled and forced and no client policy. `security invoker` functions own the rules: `session_policy_admin_user` (an active human identity with an active `tenant_admin` membership), `set_tenant_session_policy` (admin-only, bounds re-checked, compare-and-set on `version`, the tenant row locked so the first insert cannot race; the same values change nothing), `enforce_session_policy` (records the session and returns `ok`, `idle_timeout`, `max_session` or `untracked_session`; an expired session is never refreshed; service identities are exempt; an unstable `token-%` session id is refused while a limit is set) and `sign_out_user_everywhere` (admin-only; revokes every recorded session of every identity of the named user by writing the existing `session_revocation` of migration 008, which every authoritative lookup already consults; refuses the caller themself, a user outside the tenant and a missing reason). The migration also adds the `security_policy` category to the `email_outbox` check (see `NOTIFICATIONS.md`). Enforcement costs one extra round trip per authoritative request, and the last-seen time is written at most every 30 seconds per session. Migration 091 (F7d, #337) adds housekeeping: `purge_tenant_session_activity(p_retention_minutes, p_limit)` (security invoker, one global bounded delete over the new `tenant_session_activity_last_seen_idx`, rows locked by a concurrent request skipped) which refuses a retention shorter than 11,520 minutes (the longest allowed maximum session, 10,080, plus a day: a record not seen for that long was first seen longer ago than any maximum, so a limit has nothing left to decide with it) and a batch outside 1 to 10,000. It never reads or writes `session_revocation`, so revoked sessions stay revoked whether or not their activity record exists, and sign-out-everywhere still revokes every record that remains. The delivery tick calls it with a 90-day retention (`core/session-policy.ts`). A session that comes back after its record was purged is recorded as a new session and measured from then, which is why the retention is far longer than any session could be valid. Tests: `db/postgres/tests/session-policy.sql` (SQL, in CI) and `session-policy.mjs` (application backend and authoritative lookup against real Postgres, in CI). See `API_CONVENTIONS.md` (Sign-in and session policy) for the contract.

### Full tenant data export (migration 084)

Retention periods and legal holds are operated by Corvis (migrations 003 and 017) and only *read* by customers (`GET /api/v1/access/retention`). Migration 084 adds the customer-requested full export: `corvis_control.tenant_export_request` (state machine, approval and build bookkeeping, the delivered artifact and its checksum manifest), `tenant_export_request_event` (append-only history) and `tenant_export_download_grant` (single-use, hashed, expiring links). All three are server-managed with RLS enabled and forced and no client policy. `request_tenant_export` / `decide_tenant_export` enforce that a *different* active `tenant_admin` approves (and the table CHECKs repeat it); `claim_next_tenant_export_build` / `complete_tenant_export_build` / `fail_tenant_export_build` are the delivery worker's queue (lease, attempt-bound completion, reclaim); `tenant_export_rights` is the contractual-rights selection (client-visible and redistributable at every level, fail closed, plus the workspace-level redistribution gate). It deliberately does not reuse `corvis_serving.export_job`: that table is a per-user observation export (CSV, XLSX or Parquet of entitled snapshots) with its own download-grant and history contracts, whereas a tenant export is a multi-file archive approved by a second admin. It shares the delivery tick, the object store prefix and lifecycle, the artifact lifetime, the retry backoff and the row-cap discipline. Tests: `db/postgres/tests/tenant-data-export.sql` (SQL, in CI) and `tenant-data-export.mjs` (application backend and worker against real Postgres, in CI). See `API_CONVENTIONS.md` for the contract.

Migration 089 (F10d #324 and F10f #326) follows up on that export. **Notices:** the trigger `tenant_export_request_event_notify` on the append-only history queues the F2 outbox rows, so every path that moves a request (the approval workflow, the build worker, and a build failed by the lease reclaim inside `claim_next_tenant_export_build`) queues its notice in the same transaction without each caller having to remember to. `requested` queues the mandatory `tenant_export_approval` row for every other active human Organization Admin (never the requester, an analyst, a revoked admin or a service account); `approved`, `rejected`, `build_completed` and `build_failed` queue the optional `tenant_export_outcome` row for the requester only (a build that will be retried is not yet a failure, and withdrawing your own request tells no one). Rows carry the recipient, `required_roles = {tenant_admin}` (re-checked when the email is sent) and a words-only `event` parameter, never a reason, note or name. The enqueue runs under an exception handler, so an outbox fault is raised as a warning and never undoes the step. The migration adds both categories to the `email_outbox` check and the optional one to the `notification_preference` check (the approval notice cannot be a stored preference). **Hygiene:** `artifact_deleted_at` records that an expired export's stored object was deleted (the table's own check ties a complete request to its artifact columns, so `object_uri` stays); `expired_tenant_export_artifacts`, `mark_tenant_export_artifact_deleted` (stamps the request, removes its grants, appends an `artifact_deleted` history row and writes `data_export.artifact_deleted`) and `sweep_tenant_export_grants` (bounded delete of grants expired past a retention, one `data_export.grants_swept` audit event per request) back the sweep `lib/server/tenant-export-sweep.ts`, which runs on the private delivery tick as task `tenantExportSweep` and reports an object it could not delete as a task failure so it is retried. Partial indexes serve the sweep and the operator view of failed builds (`GET /api/v1/admin/tenant-export-builds`). Tests: the same `tenant-data-export.sql` and `tenant-data-export.mjs`. See `NOTIFICATIONS.md` and `API_CONVENTIONS.md`.

Migration 088 (F6, #262) adds customer self-service service accounts: `corvis_control.service_account` (the managed record: name, purpose, one workspace and one of `reviewer`/`analyst`/`viewer`, creator, finite expiry, deactivation) and `service_account_credential` (SHA-256 of the one-time secret, expiry, `ends_at` for a rotation overlap or a revocation, `last_used_at`). Both are server-managed and secret-bearing, with RLS enabled and forced and no client policy. `create_service_account` writes the rows the existing authorization lookup resolves (an `identity_subject` with `auth_method = 'service_account'`, one `membership`, one 009 `service_identity_grant`) together with the account and its first credential; `issue_service_account_credential` (issue or rotate with an overlap of at most a day), `revoke_service_account_credentials` and `disable_service_account` (deactivate everywhere) are the only writers, and each requires an active human `tenant_admin`. Guard triggers make a credential's hash and lifetime immutable, keep a revoked credential revoked and let an end date only move earlier. Tests: `db/postgres/tests/service-accounts.sql` and `service-accounts.mjs` (both in CI). See `SERVICE_ACCOUNTS.md`.

### Scheduled exports (migration 085)

Scheduled exports (F4) live in `corvis_control.export_schedule` (the saved scope, format and trigger are immutable by trigger; a schedule is deleted by status, never by row) and the append-only `export_schedule_run` (one row per handled trigger, unique per schedule and trigger key). Both are server-managed: RLS enabled and forced, no client policy, because a schedule is read by its owner and Organization Admins and changed by its owner only. `next_run_at` (calendar triggers) and `publish_watermark` (publication triggers) are set only while the schedule is active, so resuming never catches up on what was missed.

`security invoker` functions own the writes: `create_export_schedule` (idempotent per owner and key, validates the scope shape, 50 per owner), `set_export_schedule_status` (owner-keyed pause / resume / delete), `claim_export_schedule_trigger` (under a row lock: advances past the due trigger and returns its key, nothing when none is due or the trigger already has a run), `list_due_export_schedules`, `export_schedule_latest_publication`, `stop_export_schedules_for_inactive_owners` and `stop_export_schedule`. The export itself is **not** written here: the worker (`lib/server/export-schedule.ts`, called from the private delivery tick `/api/internal/delivery`) calls the existing `createPhysicalExport` in the same transaction as the claim and the run row, so the job, its `ExportRequested` outbox event and the run commit together. Buffering and size limits of the export pipeline (#231) apply unchanged. `db/postgres/tests/export-schedules.sql` covers the SQL (calendar math in UTC, idempotency, owner-only changes, coalescing, tenant isolation, automatic stop, forced RLS); `export-schedules.mjs` drives the backend and worker with real membership resolution and the real export request, and `export-schedule-concurrency.mjs` races two workers.

Migration 090 (F4b, #328) adds `export_schedule.notify_on_completion boolean not null default true` (a workflow column: the content-immutability guard does not list it), replaces the 12-argument `create_export_schedule` with one that takes the switch (default on), and adds `set_export_schedule_notification` (owner-keyed, a no-op when the value is unchanged) and `emit_export_schedule_run_event`, which writes the `ExportScheduleRunCompleted` / `ExportScheduleRunFailed` outbox event once per run with a payload of ids, the schedule label and a closed reason code. It widens the three allow-lists that name the new things: `webhook_subscription_customer_event_types` (064), `email_outbox_category_check` and `notification_preference_category_check` (`export_schedule_failed`), all re-created with their earlier members. API surface and run semantics: `API_CONVENTIONS.md` (Scheduled exports).

### Review-item assignment and discussion (migration 086)

Assigning and discussing review items (F3) live in `corvis_control.review_item_thread` (one row per workspace and review item, holding the current assignee, a version that counts changes of assignee, the item's fund and period, and comment counters; identity and fund are immutable by trigger and a thread cannot be deleted) and the append-only `review_item_comment` (no update, delete or truncate; ordered by `comment_seq`; idempotent per author and key; at most 200 per thread). A review item is an observation (`corvis_facts.observation`) or a reconciliation exception (`corvis_consolidated.reconciliation_exception`). Both tables are server-managed: RLS enabled and forced, no client policy, because whether someone may see a thread depends on their fund and document entitlement and their review role, which tenant membership alone cannot express.

`security invoker` functions own the rules: `resolve_review_subject` (a thread can only be opened on an item the caller could already read in Data review, using the caller's own fund and document entitlements), `review_member_eligible` (an active membership of the workspace in `tenant_admin`, `accountadmin` or `reviewer`, an active human identity, and read entitlement to the item's fund, the same rule the notification outbox re-checks at send time), `review_eligible_members` and `review_member_labels` (verified address, then invitation address, then subject), `set_review_item_assignee` (compare-and-set on the thread version; assigning the current assignee changes nothing) and `add_review_item_comment` (idempotent, every mention verified eligible). **Discussion never touches observations, `review_event`, `reconciliation_resolution_event`, snapshots, publication or the outbox**, so a comment can never count toward dual control (the approval count is derived from `review_event` alone); `db/postgres/tests/review-item-discussion.sql` fingerprints those tables around every operation, and `review-item-discussion.mjs` drives the same SQL through the application repository, including that a second reviewer's comment leaves `approved_reviewer_count` unchanged. Migration 086 also adds `review_discussion` to the `email_outbox` and `notification_preference` category checks (see `NOTIFICATIONS.md`). API surface: `API_CONVENTIONS.md` (Review-item assignment and discussion).

## Application adapter boundary

Application/domain code must not depend on Supabase SDK-specific semantics, direct physical table assumptions or Snowflake SQL as product contracts. Repository/service adapters own persistence details.

The Postgres-primary application migration is complete. Application persistence and governed research paths use Postgres-backed repositories; obsolete Snowflake-primary DDL and the unused application SQL API adapter have been removed. Any future Snowflake implementation must be introduced only as an explicitly activated downstream analytics/sharing path behind a dedicated replication or delivery boundary.

## Customer export file formats

Customer exports (`POST /exports`, CSV / XLSX / Parquet) render in `lib/server/export-renderer.ts`. Parquet column types are part of the delivery contract that warehouse consumers load against:

| Export | Column | Parquet type |
| --- | --- | --- |
| Observations, Position Financials and Performance scorecard | `value_number` | `DECIMAL(38,10)` (exact; never DOUBLE) |
| Performance scorecard | `is_derived` | `BOOLEAN` (nullable; null on a `Not reported` row) |
| Performance scorecard | every other column (`level`, `status`, `as_of_date`, `source_page`, ...) | `BYTE_ARRAY` / `UTF8` |
| Observations | `version` | `DOUBLE` |
| Position Financials | `display_order`, `depth`, `fiscal_year`, `fiscal_quarter` | `INT32` (nullable) |
| Position Financials | `preliminary`, `is_restatement`, `is_derived` | `BOOLEAN` (nullable) |
| both | every other column | `BYTE_ARRAY` / `UTF8` |

Change note (Position Financials Parquet): the integer and boolean columns above were previously written as UTF8 strings (`"2026"`, `"true"`), unlike CSV/XLSX, so a warehouse sorted `"10"` before `"2"`. They are now typed. A consumer that loaded these columns as `STRING` must switch its table definition to `INT` / `BOOLEAN`; files already delivered keep the old string schema and expire with their artifact TTL. A value that cannot be represented (a non-integer or beyond-INT32 integer column, a non-boolean flag) fails the export instead of writing a wrong value. Observation exports are unchanged. There is no file-format version field to bump: the manifest's `schemaVersion` is the published snapshot's data schema version, not the file layout, so this change is recorded here and in `docs/POSITION_FINANCIAL_STATEMENTS.md` rather than in the manifest.

## Retrieval and AI

Use Postgres full-text search and pgvector initially where adequate. Durable chunk identity, source-reference identity and entitlement metadata belong in Postgres; source representations remain in GCS.

Search indexes are rebuildable. If a specialist search engine is introduced later, it must preserve existing chunk IDs, rights filters and source lineage and must not become the authoritative fact store.

Ask Corvis quantitative paths should query governed semantic/read models deterministically. Generative explanation must not become the calculation engine for numerical facts.

## Supabase environment model

- `dev` — disposable/low-cost project where practical; no production customer data.
- `uat` — separate production-like project with synthetic or explicitly sanitized data.
- `prod` — Singapore project on the minimum paid tier that satisfies approved backup/recovery requirements.

Do not use a single Supabase project across environments.

## Optional Snowflake activation

Snowflake is not an initial application dependency. Activate it only after the business architecture approves a customer/workload trigger such as:

- Snowflake-native customer sharing;
- warehouse-scale analytics/concurrency that should not burden Postgres;
- independent BI/research compute;
- materially better economics/performance for approved analytical workloads.

When activated:

- Postgres remains authoritative;
- application transactions still commit only to Postgres;
- Snowflake is rebuildable from Postgres plus retained source evidence;
- Snowflake failure cannot block the product write path.

## Preferred Postgres → Snowflake CDC

If Snowflake is activated, the preferred baseline is selective PostgreSQL logical CDC through the approved Snowflake PostgreSQL/Openflow path, subject to current provider support at implementation time.

Technical rules:

- direct PostgreSQL connection for CDC; do not route logical replication through a transaction pooler;
- dedicated least-privilege replication identity;
- explicit publication/table/column allowlist;
- stable primary key or approved replica identity for every replicated table;
- raw CDC landing is internal only;
- customer shares/analytics consume governed transformations/views that reapply tenant, rights, semantic-version and publication-state controls;
- source schema changes and downstream transformations are released compatibly;
- replication lag, slot/WAL retention and destination freshness are monitored;
- orphaned replication slots must not be allowed to retain WAL indefinitely.

Default replication candidates are stable governed product entities/facts/snapshots and the tenant/data-right metadata needed to secure them. Exclude authentication internals, secrets/API keys, transient job state, extraction scratch data and low-value operational logs unless a specific approved use requires them.

## Initial replication validation

Before an activated Snowflake replica serves analytics/sharing:

1. define publication/table/column allowlist;
2. perform initial snapshot;
3. reconcile row counts, key uniqueness, representative values and tenant/right metadata;
4. verify sampled lineage back to authoritative Postgres/GCS evidence;
5. begin incremental CDC and record the start position;
6. prove Snowflake outage/lag does not affect Postgres transactions;
7. keep raw landing tables inaccessible to customer roles.

## Recovery and scale

- Keep GCS evidence independently recoverable from the database.
- Exercise Postgres backup/restore and PITR where enabled.
- Tune queries/indexes and connection pooling before scaling compute materially.
- Prefer a Postgres read replica when the problem is primarily application read scaling; do not activate Snowflake solely as a read replica substitute.
- Monitor database size, connections, slow queries, bloat, backup success, migration state and unit cost.

## Non-negotiable technical invariants

- Postgres is the sole authoritative structured write path unless a future business architecture decision explicitly replaces it.
- No application dual writes to Snowflake.
- Search/vector/warehouse layers are downstream/rebuildable.
- Tenant rights and source lineage survive every derived/replicated path.
- Raw extraction payloads and physical database tables are not external customer contracts.
- Database changes are versioned, reviewed and reproducible from Git.

### Native Postgres runtime transport

`CORVIS_POSTGRES_DSN` accepts the provider's `postgresql://` (or `postgres://`)
connection string. The application now uses the PostgreSQL wire protocol for
these bindings, including the migration CLI; it does not POST them to an HTTP
endpoint. Explicit HTTPS SQL gateway bindings remain accepted outside production
only: the HTTPS transport has no transactions, so `withTransaction` would run
non-atomically (a mutation could commit without its audit row), and production
startup fails unless the DSN is `postgres://` or `postgresql://`.

Each process shares a five-connection pool per configured DSN (tunable with
`CORVIS_POSTGRES_POOL_MAX`, 1-50; the provider's connection limit must cover
max instances x pool size for every service, and the API and worker Cloud Run
services cap request concurrency at 20 to match), with bounded
connection/query timeouts, a 60-second `idle_in_transaction_session_timeout`, idle eviction and five-minute connection rotation.

Behind a transaction-mode pooler (PgBouncer, Supavisor's transaction port) set
`CORVIS_POSTGRES_POOLER=transaction`: the server-side timeouts are then applied
with `SET LOCAL` at the start of every transaction instead of as startup
parameters, which such poolers may reject and cannot pin to one server session.
Single statements outside a transaction are then bounded by the client-side
query timeout and the database role's defaults, so also run
`alter role <app role> set statement_timeout = '30s'` there. Run migrations
against a session-mode connection: they take a transaction-scoped advisory lock
and hold one transaction per file.
Queries remain parameterized. Failed transactions destroy their connection;
queries are never automatically retried because their commit outcome may be
unknown. Migration files must keep their existing single-call BEGIN/COMMIT
contract. Statements are bounded to 30 seconds; large backfills belong in
bounded batches outside the migration transaction.

Remote and production connections require verified TLS. `sslmode=require` is
strengthened to certificate/hostname verification; TLS downgrade and arbitrary
connection-string options are rejected. For a provider whose certificates chain
to a private root (Supabase signs with its own root CA, which is not in Node's
trust store), set `CORVIS_POSTGRES_CA_CERT` to the reviewed PEM CA bundle. It is
public certificate material, not a secret: store it as the `CORVIS_POSTGRES_CA_CERT`
GitHub Environment variable, which the deploy workflow passes to Terraform
(`postgres_ca_cert`, set as a plain env var on the API and worker Cloud Run
services) and to the migration and security-acceptance steps. When set, it
replaces the default trust store for Postgres connections only; certificate and
hostname verification remain mandatory. Empty (the default) uses Node's trust
store. `sslrootcert` in the DSN stays rejected, and `NODE_EXTRA_CA_CERTS` is not
used because it requires a mounted file. Never disable certificate verification.

Driver failures surface only a closed diagnostic code, never the driver message,
DSN or SQL: `Postgres query failed (SQLSTATE 42P01)` for server errors and
`Postgres connection failed (SELF_SIGNED_CERT_IN_CHAIN)` (or `ECONNREFUSED`,
`28P01`, `CONNECT_TIMEOUT`, ...) for connection failures. Failed migration
evidence additionally records `failedVersion`, `failedMigration`,
`alreadyApplied`, `appliedThisRun` and `driverCode`. Only non-production loopback
connections can use plaintext for disposable CI. Use the provider's appropriate
pooler/direct endpoint and size Cloud Run instance limits against the database
connection budget. Keep the DSN in Secret Manager, not repository variables or
logs. This adapter does not provision a Supabase project or establish UAT evidence.
