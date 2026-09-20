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

- Extraction candidate review now has a dedicated forced-RLS Postgres domain: immutable policy requirements, append-only attributable decisions, and a derived exact-candidate-set review gate. Provider candidates and their evidence/confidence/provenance are not rewritten by review corrections.
- `candidate_review_v1` requires attributable review for every candidate because governed straight-through approval has not been activated; critical governed metric candidates require two distinct reviewers and candidate exceptions require explicit resolution before canonicalization can proceed.
- A correction begins a new review epoch, so earlier approvals cannot satisfy the corrected candidate. The reviewed processing stage parks in a durable `blocked` state rather than consuming operational retry/dead-letter attempts while waiting for human review.
- Authorized candidate review commands use `POST /api/v1/extraction-review` with the existing review permission plus required idempotency key; accepted decisions are also written to the application audit trail.
- The database independently prevents a `reviewed → canonicalized` processing transition unless the exact finalized extraction candidate set has a ready zero-blocker review gate.
- Existing canonical-observation review events, optimistic concurrency, correction history, critical-observation independent-review and publication-policy foundations remain downstream controls.
- Publication gates block unresolved review/material exceptions/incomplete lineage according to current policy primitives.
- Snapshot publication changes create durable outbox foundations.
- Customer review UI now scopes review/publish state to the selected fund-period snapshot where snapshot-scoped observations are available. A dedicated extraction-candidate review UI remains separate product work; the governed API/persistence boundary exists now.
- The exception/reconciliation workbench, complete four-eyes UX and provider-backed UAT workflow coverage remain in issue #6/#79.

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

- Processing-job/outbox schemas, authoritative stage claims, deterministic effect keys/journaling and retry/dead-letter state primitives exist.
- The processing transport has durable lease ownership, bounded transport retry/dead-letter behavior, Pub/Sub publication and Cloud Tasks scheduling adapters that honor persisted retry timing.
- Authenticated `POST /api/internal/processing-stage` ingress verifies Google OIDC for approved Pub/Sub/Cloud Tasks callers, re-resolves the immutable service-account subject through Postgres lifecycle/membership/data-right controls, and invokes the authoritative Postgres stage/effect worker composition without accepting transport claims as application authorization.
- `BoundedProcessingStageEffectRouter` isolates stage handlers with fail-closed missing bindings and hard timeout/cancellation behavior.
- The `registered` production handler revalidates the exact source artifact against tenant/document-scoped Postgres metadata and requires clean/released immutable GCS generation plus SHA-256 lineage before the pipeline can advance beyond registration.
- The `represented` production handler defines deterministic representation identity, exact predecessor-lineage handoff, keyless bounded invocation of a Corvis representation service, independent GCS generation/hash/source verification and conflict-idempotent forced-RLS Postgres representation metadata. It is composed only when `CORVIS_REPRESENTATION_ENDPOINT` is supplied; otherwise the represented stage remains fail-closed.
- The `extracted` production handler consumes only the exact committed representation lineage, calls a replaceable keyless extraction provider with a deterministic run/bundle identity, independently verifies the immutable GCS JSONL bundle and governed skill/schema metadata, validates evidence/confidence/provenance-backed candidates, and persists forced-RLS server-only extraction runs/candidates/source references idempotently in Postgres. The provider has no Postgres or canonical-write authority. It is composed only when `CORVIS_EXTRACTION_ENDPOINT` is supplied; otherwise the extracted stage remains fail-closed.
- The `reviewed` production handler consumes only finalized `ready` extraction runs and exact predecessor candidate-set lineage. It records immutable policy requirements and evaluates append-only attributable review decisions. Pending human review is a durable `blocked` state, not a technical retry; a ready review gate re-queues the same deterministic reviewed-stage effect. A persistence trigger prevents the next canonicalization job until the exact candidate set has a zero-blocker ready gate.
- Canonicalization/reconciliation/consolidation/publication handlers, operator dead-letter/replay/status completion and production-like UAT evidence remain tracked in issue #79; unimplemented stages intentionally fail closed.
- Merging authenticated ingress, representation, extraction or review-stage code does **not** prove real Pub/Sub/Cloud Tasks IAM, representation/extraction providers, UAT GCS/Postgres bindings, reviewer operations or production-like recovery behavior. Those remain activation/evidence work.
- `lib/server/telemetry.ts` provides structured telemetry hooks.
- Export job/manifest/checksum and webhook-signing/replay foundations exist.
- `/api/v1/admin/readiness` provides fail-closed readiness diagnostics.
- Initial GCP Terraform provisions Pub/Sub lifecycle/dead-letter topics and Cloud Tasks foundations in `dev`.
- SLO dashboards/alerts and broader recovery evidence remain tracked in issue #9.
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

Merging code does not prove an IdP, production GCS bucket, Postgres project/RLS policy, Cloudflare edge, malware scanner, representation/extraction provider, reviewer operating process, backup or operational control is operating correctly. [`PRODUCTION_ACTIVATION.md`](PRODUCTION_ACTIVATION.md) defines the live technical activation/evidence checks; Confluence retains the final business/control readiness gate.
