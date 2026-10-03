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

### Full tenant data export (migration 084)

Retention periods and legal holds are operated by Corvis (migrations 003 and 017) and only *read* by customers (`GET /api/v1/access/retention`). Migration 084 adds the customer-requested full export: `corvis_control.tenant_export_request` (state machine, approval and build bookkeeping, the delivered artifact and its checksum manifest), `tenant_export_request_event` (append-only history) and `tenant_export_download_grant` (single-use, hashed, expiring links). All three are server-managed with RLS enabled and forced and no client policy. `request_tenant_export` / `decide_tenant_export` enforce that a *different* active `tenant_admin` approves (and the table CHECKs repeat it); `claim_next_tenant_export_build` / `complete_tenant_export_build` / `fail_tenant_export_build` are the delivery worker's queue (lease, attempt-bound completion, reclaim); `tenant_export_rights` is the contractual-rights selection (client-visible and redistributable at every level, fail closed, plus the workspace-level redistribution gate). It deliberately does not reuse `corvis_serving.export_job`: that table is a per-user observation export (CSV, XLSX or Parquet of entitled snapshots) with its own download-grant and history contracts, whereas a tenant export is a multi-file archive approved by a second admin. It shares the delivery tick, the object store prefix and lifecycle, the artifact lifetime, the retry backoff and the row-cap discipline. Tests: `db/postgres/tests/tenant-data-export.sql` (SQL, in CI) and `tenant-data-export.mjs` (application backend and worker against real Postgres, in CI). See `API_CONVENTIONS.md` for the contract.

### Scheduled exports (migration 085)

Scheduled exports (F4) live in `corvis_control.export_schedule` (the saved scope, format and trigger are immutable by trigger; a schedule is deleted by status, never by row) and the append-only `export_schedule_run` (one row per handled trigger, unique per schedule and trigger key). Both are server-managed: RLS enabled and forced, no client policy, because a schedule is read by its owner and Organization Admins and changed by its owner only. `next_run_at` (calendar triggers) and `publish_watermark` (publication triggers) are set only while the schedule is active, so resuming never catches up on what was missed.

`security invoker` functions own the writes: `create_export_schedule` (idempotent per owner and key, validates the scope shape, 50 per owner), `set_export_schedule_status` (owner-keyed pause / resume / delete), `claim_export_schedule_trigger` (under a row lock: advances past the due trigger and returns its key, nothing when none is due or the trigger already has a run), `list_due_export_schedules`, `export_schedule_latest_publication`, `stop_export_schedules_for_inactive_owners` and `stop_export_schedule`. The export itself is **not** written here: the worker (`lib/server/export-schedule.ts`, called from the private delivery tick `/api/internal/delivery`) calls the existing `createPhysicalExport` in the same transaction as the claim and the run row, so the job, its `ExportRequested` outbox event and the run commit together. Buffering and size limits of the export pipeline (#231) apply unchanged. `db/postgres/tests/export-schedules.sql` covers the SQL (calendar math in UTC, idempotency, owner-only changes, coalescing, tenant isolation, automatic stop, forced RLS); `export-schedules.mjs` drives the backend and worker with real membership resolution and the real export request, and `export-schedule-concurrency.mjs` races two workers. API surface and run semantics: `API_CONVENTIONS.md` (Scheduled exports).

## Application adapter boundary

Application/domain code must not depend on Supabase SDK-specific semantics, direct physical table assumptions or Snowflake SQL as product contracts. Repository/service adapters own persistence details.

The Postgres-primary application migration is complete. Application persistence and governed research paths use Postgres-backed repositories; obsolete Snowflake-primary DDL and the unused application SQL API adapter have been removed. Any future Snowflake implementation must be introduced only as an explicitly activated downstream analytics/sharing path behind a dedicated replication or delivery boundary.

## Customer export file formats

Customer exports (`POST /exports`, CSV / XLSX / Parquet) render in `lib/server/export-renderer.ts`. Parquet column types are part of the delivery contract that warehouse consumers load against:

| Export | Column | Parquet type |
| --- | --- | --- |
| Observations and Position Financials | `value_number` | `DECIMAL(38,10)` (exact; never DOUBLE) |
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
