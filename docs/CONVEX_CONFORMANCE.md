# Convex upstream conformance

Corvis directly consumes the supported self-hosted Convex backend as a **database-semantics conformance oracle** in CI. It does not copy Convex implementation code into the Corvis runtime and it does not make Convex a second production datastore.

## Why this boundary

The useful upstream boundary is the self-hosted backend and public Convex CLI/client surface, not Convex's internal Rust crates. The backend repository publishes self-hosted images at `ghcr.io/get-convex/convex-backend`, and the Convex CLI supports self-hosted deployments.

Depending on internal workspace crates would couple Corvis to implementation details that are not a stable TypeScript-facing library contract. Running the official backend instead means improvements to Convex's transaction engine, optimistic concurrency control and schema/runtime behavior are exercised by Corvis without vendoring those implementations.

## PostgreSQL-backed conformance

The self-hosted backend natively supports a PostgreSQL persistence URL through `POSTGRES_URL` (`self-hosted/docker-build/run_backend.sh`). Corvis conformance therefore runs the official Convex image **on top of a disposable PostgreSQL 17 service**, rather than accepting Convex's default SQLite fallback.

This is the closest safe proof of the eventual provider-portable deployment shape:

```text
Convex self-hosted backend
        ↓ POSTGRES_URL
managed PostgreSQL
        ↓
Supabase | GCP Cloud SQL | RDS | Azure PostgreSQL | self-hosted PostgreSQL
```

The conformance job does not depend on provider-specific PostgreSQL APIs. A provider move remains a PostgreSQL provisioning, migration, connectivity and acceptance exercise.

## What CI proves

`db/convex-conformance/` contains a deliberately small reference state machine. The conformance workflow boots the official Convex backend with PostgreSQL persistence and proves two semantics that Corvis database adapters must preserve:

1. **Concurrent compare-and-set has one winner.** Eight mutations race from version `0` to `1`. Exactly one transition may succeed and exactly one event may be committed.
2. **Failed mutations are atomic.** A mutation inserts an event and then throws. The inserted event must not remain visible.

These are reference semantics, not Corvis storage. Corvis's PostgreSQL acceptance tests must establish the same observable invariants for the actual implementation.

## Pinned gate and upstream canary

`.github/workflows/convex-conformance.yml` has two modes:

- pull requests and manual runs use a known Convex backend release SHA and an exact Convex CLI version;
- the weekly scheduled canary uses `ghcr.io/get-convex/convex-backend:latest` and `convex@latest`.

Both modes use PostgreSQL as Convex's persistence engine. This split keeps normal CI reproducible while still letting upstream Convex changes continuously test Corvis's required semantics. Dependabot separately tracks the isolated `convex` npm dependency.

When the canary passes on a newer upstream release, the pinned backend SHA can be advanced deliberately.

## Could Convex become the production data API?

Technically yes, but it is a **migration**, not a transparent wrapper around Corvis's current SQL schema.

The upstream PostgreSQL persistence implementation creates its own schema and stores Convex documents/index data in backend-managed relations such as `documents` and `indexes` (`crates/postgres/src/sql.rs`). `ctx.db` therefore operates on Convex-managed document state; it does not turn existing Corvis relational tables, RLS policies, functions and migrations into Convex tables automatically.

A production move to Convex would require an explicit program to:

1. map Corvis repository contracts and relational entities to Convex tables/functions;
2. migrate existing data and retained lineage without creating two authorities;
3. re-prove tenant isolation currently enforced with PostgreSQL RLS;
4. replace or preserve SQL functions/triggers/state-machine constraints;
5. rework direct SQL reporting/export/reconciliation paths where appropriate;
6. prove backup/restore, observability and provider migration for the Convex-managed PostgreSQL schema;
7. perform a fresh licensing/security/operational review for production use.

If Corvis later chooses that architecture, the attractive property is real: **Convex engine updates would directly improve the runtime while the underlying storage could still move between managed PostgreSQL providers through `POSTGRES_URL`.**

This PR deliberately stops one boundary earlier. It proves the upstream backend + PostgreSQL shape and keeps the current Corvis relational system authoritative, so adopting Convex runtime later can be a measured migration rather than an accidental dual-write architecture.

## Upgrade policy

When advancing the pinned Convex backend or CLI:

1. require the upstream canary to pass;
2. review Convex release notes/license changes;
3. update the pinned backend SHA and CLI version together when practical;
4. run the Corvis PostgreSQL migration/acceptance suite as well as Convex conformance;
5. do not interpret a passing Convex test as proof that the Corvis PostgreSQL implementation is correct—it is the reference behavior to match.

## Licensing boundary

The Convex backend repository currently uses FSL-1.1-Apache-2.0, while the published `convex` npm package identifies itself as Apache-2.0. Corvis uses the backend here only as an internal CI dependency and does not redistribute, white-label or expose it as a Corvis database service.

Any future proposal to run Convex as part of the customer-serving Corvis product must receive a fresh legal/license review rather than relying on this CI-use decision.

## Production authority remains PostgreSQL

The production dependency graph in this PR stays:

```text
Corvis domain
    -> repository ports
    -> persistence repositories
    -> DatabaseApi
    -> PostgreSQL adapter
    -> Supabase / Cloud SQL / RDS / Azure PostgreSQL / self-hosted PostgreSQL
```

Convex sits beside that graph only in test infrastructure:

```text
required database semantics
      |                 |
      v                 v
Convex upstream     Corvis PostgreSQL
on PostgreSQL       implementation tests
      |                 |
      +------ compare --+
```

There are no application dual writes, no Convex-to-Postgres replication requirement, and no production cutover dependency on Convex.
