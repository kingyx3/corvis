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

## Application adapter boundary

Application/domain code must not depend on Supabase SDK-specific semantics, direct physical table assumptions or Snowflake SQL as product contracts. Repository/service adapters own persistence details.

Migration from the legacy Snowflake-primary code should:

1. introduce/strengthen structured-data repository interfaces;
2. port useful existing Snowflake DDL/domain structures into PostgreSQL migrations;
3. migrate one service path at a time to Postgres;
4. avoid application dual writes;
5. add replay/tenant-isolation/lineage/snapshot tests before removing the legacy path;
6. leave any remaining Snowflake code clearly optional/downstream.

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
endpoint. Existing explicit HTTPS SQL gateway bindings remain compatible.

Each process shares a five-connection pool per configured DSN, with bounded
connection/query timeouts, idle eviction and five-minute connection rotation.
Queries remain parameterized. Failed transactions destroy their connection;
queries are never automatically retried because their commit outcome may be
unknown. Migration files must keep their existing single-call BEGIN/COMMIT
contract. Statements are bounded to 30 seconds; large backfills belong in
bounded batches outside the migration transaction.

Remote and production connections require verified TLS. `sslmode=require` is
strengthened to certificate/hostname verification; TLS downgrade and arbitrary
connection-string options are rejected. For a provider-specific CA, mount the
reviewed CA certificate and configure Node's `NODE_EXTRA_CA_CERTS` before process
startup. Never disable certificate verification. Only non-production loopback
connections can use plaintext for disposable CI. Use the provider's appropriate
pooler/direct endpoint and size Cloud Run instance limits against the database
connection budget. Keep the DSN in Secret Manager, not repository variables or
logs. This adapter does not provision a Supabase project or establish UAT evidence.
