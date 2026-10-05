# Database portability and correctness

Corvis uses PostgreSQL as a **database dialect and correctness boundary**, not Supabase as an application contract.

Supabase is the current managed PostgreSQL provider. A move to GCP Cloud SQL for PostgreSQL, AWS RDS/Aurora PostgreSQL, Azure Database for PostgreSQL, or self-hosted PostgreSQL must not require domain-model changes.

Corvis directly exercises the supported self-hosted Convex backend in CI as a reference oracle for transaction/concurrency semantics, while keeping PostgreSQL as the sole production structured-data authority. See [`CONVEX_CONFORMANCE.md`](../engineering/CONVEX_CONFORMANCE.md).

The database design uses these Convex correctness properties:

- mutations should be atomic rather than partially committed;
- schema changes are validated as state transitions, not treated as successful merely because DDL executed;
- database capabilities are explicit;
- concurrency behavior is part of correctness;
- persistence implementation details stay below application/domain contracts.

## Dependency rule

```text
product/domain code
       ↓
repository ports
       ↓
repository implementations
       ↓
DatabaseApi (provider-neutral)
       ↓
PostgreSQL adapter
       ↓
managed provider connection plumbing
       ↓
Supabase | GCP Cloud SQL | RDS | Azure | self-hosted
```

Product/domain code must not import a provider SDK, provider-specific auth helper, connection object, schema API or generated database client.

`lib/server/database.ts` owns the low-level provider-neutral contract. `lib/server/postgres.ts` is the PostgreSQL adapter and retains compatibility aliases while existing repository implementations migrate naming gradually.

## Portability target

There are two different kinds of database migration and Corvis treats them differently.

### Managed PostgreSQL provider migration

Example: Supabase PostgreSQL → GCP Cloud SQL for PostgreSQL.

This is an expected operational migration. The application contract remains PostgreSQL. The migration should require only:

1. provision the target PostgreSQL service;
2. configure TLS/network/identity and a least-privilege runtime role;
3. restore/replay schema and data;
4. run the complete migration and database acceptance suites;
5. verify required extensions and settings;
6. switch `CORVIS_DATABASE_DSN` and `CORVIS_DATABASE_PROVIDER`;
7. observe/reconcile before retiring the previous provider.

No domain module should change.

### Database-engine migration

Example: PostgreSQL → Spanner, CockroachDB in non-PostgreSQL-compatible mode, or another engine.

This is intentionally **not** promised as a DSN-only switch. Corvis relies on PostgreSQL semantics including RLS, transactional DDL/mutations, advisory locks, extensions and PostgreSQL SQL. Repository ports protect the product/domain layer, but a new engine requires new persistence adapters and equivalent security/correctness evidence.

Pretending all databases are interchangeable would hide rather than remove this work.

## Runtime contract

`DatabaseApi` exposes only the primitive operations needed by persistence adapters:

- parameterized query;
- parameterized execute;
- health;
- an optional native transaction primitive.

`DatabaseRuntime` describes the provider separately from database capabilities. Provider identity is informational; code must make correctness decisions from capabilities, not from brand names.

Current PostgreSQL baseline capabilities are:

- PostgreSQL dialect;
- native transactions;
- row-level security;
- advisory locks;
- extensions;
- logical replication.

A connection adapter must not advertise a capability it cannot actually provide. For example, the legacy HTTP SQL compatibility transport does not advertise native transactions/advisory-lock semantics and is not permitted for production mutation paths.

## Atomicity rule

New multi-statement mutation code should use `requireTransaction` from `lib/server/database.ts`.

It fails closed when the selected transport cannot provide a native transaction. This avoids the dangerous compatibility behavior where a business mutation commits but its audit/event/outbox statement fails separately.

`withTransaction` in `lib/server/postgres.ts` remains temporarily as a compatibility alias to the legacy optional behavior. Existing call sites can migrate incrementally; security- or audit-sensitive mutation paths should move first.

## Convex reference model

`tools/convex-conformance/` runs against the official upstream Convex backend and verifies the reference behavior for concurrent compare-and-set, lost-update freedom and atomic rollback. `db/postgres/tests/convex-parity.mjs` asserts the same invariants against Corvis's PostgreSQL adapter in CI.

PR CI is pinned to a known Convex backend release SHA and exact CLI version (from `tools/convex-conformance/package.json` and `run.sh`). A scheduled canary tracks upstream `latest`, so improvements or regressions in Convex's supported backend surface are detected without making ordinary PR CI nondeterministic.

## Convex-inspired schema state model

Corvis remains migration-driven, but migration correctness should converge on this model:

```text
proposed
   ↓
preconditions validated
   ↓
DDL/data migration applied atomically
   ↓
postconditions validated
   ↓
active
```

A future migration validation layer should distinguish:

- **structural validation** — constraints, PK/FK/index/RLS/grants/function shape;
- **data validation** — existing rows satisfy new invariants;
- **security validation** — tenant isolation and privilege-negative tests still pass;
- **behavior validation** — state machines, idempotency and race tests still pass.

The existing forward-only migration ledger/checksum mechanism remains authoritative.

## Database constitution

These rules are provider-independent requirements of a Corvis PostgreSQL deployment:

1. Postgres is the sole authoritative structured application write path unless architecture explicitly replaces it.
2. Every tenant-sensitive relation has an enforceable tenant key.
3. RLS independently prevents cross-tenant access where required; application authorization does not substitute for it.
4. Multi-record business state transitions that require atomicity use a native transaction.
5. Source/canonical history that is specified as append-only cannot be rewritten in place.
6. Published facts retain deterministic lineage to reviewed state and retained source evidence.
7. Migrations are versioned, checksummed, forward-only and reproducible from Git.
8. Provider-specific SDK/API concepts do not appear in domain contracts.
9. Required database capabilities are checked before promotion to UAT/production.
10. Provider migration is proven through replay, data reconciliation, security acceptance and concurrency tests rather than assumed from PostgreSQL compatibility claims.

## GCP Cloud SQL migration path

For a future Supabase → Cloud SQL move, prefer Cloud SQL for PostgreSQL with a normal PostgreSQL wire connection presented to the existing adapter. Connection setup may use infrastructure-specific mechanisms (private IP, connector/proxy, workload identity), but those terminate at the provider adapter boundary.

The acceptance gate should include:

- full migration replay from empty database;
- migration ledger/checksum reconciliation;
- extension inventory reconciliation;
- RLS/grant/function ownership checks;
- tenant-isolation negatives;
- representative application repository tests;
- concurrent state-transition/idempotency tests;
- snapshot/lineage reconciliation;
- backup/restore/PITR exercise;
- query-plan/performance checks on representative data;
- connection-pool and failover behavior.

Only after those pass should the application DSN switch.

## Configuration

Preferred new bindings:

```text
CORVIS_DATABASE_DSN=postgresql://...
CORVIS_DATABASE_PROVIDER=supabase
```

Supported provider labels:

```text
supabase
gcp-cloud-sql
aws-rds
azure-postgresql
self-hosted
unknown
```

`CORVIS_POSTGRES_DSN` remains a compatibility fallback while deployment configuration and documentation migrate to `CORVIS_DATABASE_DSN`.

## What this architecture does not do

Convex is not run alongside production Postgres, receives no application dual writes, and is not another source of truth. It is an internal CI reference dependency only. Making Convex a production authority would create a separate migration/reconciliation design and would require an explicit architecture and licensing decision.

This preserves the useful upstream dependency—Convex's real transaction/concurrency behavior—without coupling Corvis customer data or provider portability to Convex.
