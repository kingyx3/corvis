# Enterprise implementation status

This document maps Confluence-owned business/enterprise requirements to executable repository components. GitHub owns the technical implementation details; Confluence owns business semantics, customer rights, control requirements and readiness decisions.

See [`README.md`](README.md) for the technical-doc authority rule and [`MODULARITY.md`](MODULARITY.md) for module/failure-isolation requirements.

## Implemented runtime

### Identity and tenant authorization

- `core/enterprise.ts` defines roles, permissions, entitlements and source-access separation.
- `lib/server/request-context.ts` currently accepts production identity from a trusted gateway assertion boundary and rejects callers that do not satisfy that trust check.
- Production configuration requires issuer/audience and fails closed when required bindings are missing.
- Direct production IdP/session verification plus Postgres-backed membership/RBAC/entitlement resolution remains tracked in GitHub issue #2.

### Source ingestion

- `lib/server/gcs.ts` implements GCS control operations and native resumable upload sessions.
- `lib/server/uploads.ts` implements tenant-scoped sessions, idempotent initiate/complete behavior, exact object-size verification, GCS generation/checksum capture, file-signature validation and quarantine.
- `adapters/upload/http-gcs-resumable-upload.ts` sends browser bytes directly to GCS in resumable chunks and can query/resume committed offsets.
- Artifacts remain quarantined until the approved scanner records a clean disposition; only clean artifacts may progress to `DocumentRegistered`.
- Cloudflare and Corvis application services do not proxy ordinary large source-document bodies.
- Initial GCP Terraform provisions the first private/versioned/CMEK GCS source foundation in `dev`.
- Provider-integrated interruption/quarantine/UAT evidence remains tracked in issue #3.

### Structured data plane

**Target/current architecture:** Supabase Postgres Singapore is the sole operational/canonical/serving structured write authority. GCS remains source evidence. Snowflake is optional downstream only.

**Repository migration state:** legacy Snowflake-primary code is still being replaced.

- Production config now requires `CORVIS_POSTGRES_DSN` and no longer requires Snowflake bindings to start.
- Existing Snowflake migrations contain useful domain structures but are not the target production dialect/security model.
- `lib/server/snowflake.ts` and direct Snowflake calls still exist in multiple service paths.
- Postgres schemas/migrations/RLS plus repository/adapter migration remain tracked in issue #28.

Technical target rules are in [`DATA_PLATFORM.md`](DATA_PLATFORM.md).

### Review and publication

- Review events and optimistic-concurrency foundations exist.
- Critical-observation independent-review and publication-policy foundations exist.
- Publication gates block unresolved review/material exceptions/incomplete lineage according to current policy primitives.
- Snapshot publication changes create durable outbox foundations.
- Customer review UI now scopes review/publish state to the selected fund-period snapshot where snapshot-scoped observations are available.
- The exception/reconciliation workbench, persistence-bound four-eyes enforcement and complete provider-backed UAT workflow coverage remain in issue #6.

### Customer journey and module isolation

- The client workspace loads Documents, Snapshots and Observations independently with partial-success handling rather than one all-or-nothing request chain.
- A read-module failure produces a scoped degraded state; healthy modules remain usable.
- Acquisition/upload, workspace reads, review/publication, research and delivery are composed through typed ports/adapters rather than direct provider access from feature UI.
- Customer structured delivery now has a dedicated `DeliveryPort` and customer-facing Data Delivery surface for CSV/XLSX/Parquet export requests.
- The demo/E2E harness is stateful across the product seams: an uploaded source creates a review-scoped snapshot and structured observations, review decisions unlock publication, and published snapshots can be requested through the delivery module.
- Playwright covers the representative seam `upload → structured observations → review → publish → structured delivery` and an injected Observations-module outage that leaves unrelated customer surfaces available.
- These tests prove product contracts and blast-radius behavior in CI; they are **not** production/provider activation evidence. Production-equivalent `uat` must repeat the journey against real Postgres/GCS/processing/delivery bindings and fault-inject representative module/dependency failures.
- The largest remaining technical coupling is the legacy `lib/server/platform.ts` service/persistence composition. Issue #28 must replace its Snowflake-oriented persistence paths with bounded Postgres-backed repositories/module adapters rather than reproducing a new provider-specific platform monolith.

See [`MODULARITY.md`](MODULARITY.md) and issue #12.

### Retrieval and AI

- `lib/server/research.ts` keeps structured facts and source retrieval conceptually separate.
- Retrieval carries tenant/workspace/document/fund filters before search execution.
- Source text is treated as untrusted data and responses carry source-reference citations.
- Semantic-query ID/hash foundations exist.
- The current implementation still reads broad serving facts through the legacy Snowflake adapter; deterministic Postgres semantic-query routing, streaming/error behavior and full evaluation coverage remain in issue #7 and #28.

### Reliability and delivery

- Processing-job/outbox schemas and retry/dead-letter state primitives exist.
- `lib/server/telemetry.ts` provides structured telemetry hooks.
- Export job/manifest/checksum and webhook-signing/replay foundations exist.
- `/api/v1/admin/readiness` provides fail-closed readiness diagnostics.
- Initial GCP Terraform provisions Pub/Sub lifecycle/dead-letter topics and Cloud Tasks foundations in `dev`.
- Live consumers, durable inbox/deduplication, UAT failure tests, SLO dashboards/alerts and recovery evidence remain in issues #4 and #9.
- Real asynchronous export rendering/storage/expiry and customer webhook delivery remain tracked in issue #11; the client delivery port/surface does not substitute for those provider-backed paths.

### Admin, control and evidence

- Admin API foundations exist for feature flags, deletion workflows, control evidence and readiness.
- Data-lifecycle adapter and evidence foundations exist.
- These paths still require migration from legacy Snowflake persistence to the Postgres control plane under #28.
- The separate production admin application and full cross-channel control/entitlement implementation remain tracked in issue #10.
- Recurring automated evidence collection/freshness/escalation remains tracked in issue #14.

### Secure SDLC and infrastructure

- deterministic lockfile + `npm ci`;
- ESLint, TypeScript, unit tests, production build, Playwright and dependency audit in CI;
- CodeQL and Dependabot;
- Terraform validation discovers implemented environment roots;
- initial GCP `dev` foundation for APIs, KMS, GCS, Artifact Registry, Pub/Sub, Cloud Tasks and service identities;
- obsolete Corvis-managed AWS/S3 reference infrastructure removed;
- browser security headers and safe error boundaries.

Remaining technical infrastructure is tracked primarily in issue #13: `uat`/`prod`, Cloud Run deployment, Cloudflare edge/origin, Supabase provisioning, Secret Manager/runtime identity, monitoring/budgets and release/rollback automation.

Technical standards:

- [`MODULARITY.md`](MODULARITY.md)
- [`INFRASTRUCTURE.md`](INFRASTRUCTURE.md)
- [`GITHUB_ENVIRONMENTS.md`](GITHUB_ENVIRONMENTS.md)
- [`DEPLOYMENT.md`](DEPLOYMENT.md)

## Adapter boundary

Corvis product modules consume stable contracts rather than vendor-specific implementation details. GCS, Postgres/Supabase, identity providers, search/model providers, Cloudflare and telemetry providers remain replaceable behind implementation boundaries provided they continue to satisfy business/data/security contracts.

Snowflake is specifically **not** a required application adapter at launch; any remaining Snowflake implementation must become optional downstream analytics/sharing or be removed as #28 completes.

## Implementation is not activation

Merging code does not prove an IdP, production GCS bucket, Postgres project/RLS policy, Cloudflare edge, malware scanner, backup or operational control is operating correctly. [`PRODUCTION_ACTIVATION.md`](PRODUCTION_ACTIVATION.md) defines the live technical activation/evidence checks; Confluence retains the final business/control readiness gate.
