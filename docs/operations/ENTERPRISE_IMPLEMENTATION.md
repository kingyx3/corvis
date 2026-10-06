# Enterprise implementation status

This document maps Confluence-owned business/enterprise requirements to executable repository components. GitHub owns the technical implementation details; Confluence owns business semantics, customer rights, control requirements and readiness decisions.

See [`README.md`](../README.md) for the technical-doc authority rule, [`MODULARITY.md`](../architecture/MODULARITY.md) for module/failure-isolation requirements, and [`ROLE_AND_ACTOR_TERMINOLOGY.md`](../architecture/ROLE_AND_ACTOR_TERMINOLOGY.md) for the canonical distinction between the tenant/workspace **Review Analyst** persona and Corvis **Data Operations Reviewer** / **Resolver** functions. The persisted `reviewer` role key is a compatibility identifier, not a human-facing label.

## Implemented runtime

### Identity and tenant authorization

- `src/shared/domain/enterprise.ts` defines roles, permissions, entitlements and source-access separation.
- `src/modules/identity-access/server/request/request-context.ts` verifies production end-user OIDC bearer tokens directly (signature, issuer, audience and lifetime), taking the caller token from `X-Forwarded-Authorization` behind API Gateway. Optional signed gateway assertions support brokered SAML/service identities.
- Production configuration requires issuer/audience and fails closed when required bindings are missing.
- `src/modules/identity-access/server/request/authorized-request.ts` independently resolves active Postgres membership, workspace roles, fund/document rights, service-identity lifecycle and session revocation on protected requests. Tenant-wide control paths require authoritative tenant-admin scope.
- OIDC JWKS refreshes are single-flight and throttled even on cold-start failures. Unexpired keys survive a failed refresh; expired keys fail closed.
- Provider-backed identity/access/RLS evidence remains a launch gate in GitHub issues #8/#10; implemented code alone does not establish live control effectiveness.

### Source ingestion

- `src/platform/gcp/gcs.ts` implements GCS control operations and native resumable upload sessions.
- `src/modules/sources/server/uploads/uploads.ts` implements tenant-scoped sessions, idempotent initiate/complete behavior, exact object-size verification, GCS generation/checksum capture, file-signature validation and quarantine.
- `src/modules/sources/adapters/upload/http-gcs-resumable-upload.ts` sends browser bytes directly to GCS in resumable chunks and can query/resume committed offsets.
- Artifacts remain quarantined until the approved scanner records a clean disposition; only clean artifacts may progress to `DocumentRegistered`.
- Release is not tied to a browser session: the private worker's scheduled `POST /api/internal/delivery` tick runs `releaseScannedUploads` (`src/modules/sources/server/uploads/upload-release.ts`), which finds artifacts still quarantined with a landed scanner verdict, re-verifies the object generation and size, and releases clean ones (threats are recorded and never released). It is database-driven and needs only read access to the source bucket. `GET /uploads/{id}` still releases opportunistically; both paths are idempotent.
- Before release, `sealArtifactIntegrity` (`src/modules/sources/server/uploads/upload-integrity.ts`) streams the stored bytes (pinned to the verified GCS generation), records their SHA-256 on `document_artifact_version`, and quarantines the artifact as `integrity_failed` if the bytes contradict a digest declared at initiate. The `registered` stage requires this digest, so a client that sends no checksum still produces SHA-256 lineage.
- Cloudflare and Corvis application services do not proxy ordinary large source-document bodies.
- Initial GCP Terraform provisions the first private/versioned/CMEK GCS source foundation in `dev`.
- Provider-integrated interruption/quarantine/UAT evidence remains tracked in issue #3.
- Upload session objects are written with GCS `ifGenerationMatch` (`putJsonIfGenerationMatch`, `getJsonWithGeneration`): `abort` and the release path each *claim* their state transition durably before any destructive or irreversible step, so the loser of a race gets `upload_conflict` (409) or re-reads the winner's state, and bytes are never purged under a session that ends up `complete`. `initiate` claims the idempotency object with `ifGenerationMatch` (`0` = create-only), so one key cannot create two documents. `UploadSessions.sweep` pages with `options.cursor` / `summary.nextCursor` (driven by the `uploadSweep` task of the scheduled `/api/internal/delivery` tick). Bucket lifecycle rules and noncurrent-version cleanup for the versioned bucket are Terraform/provider concerns and are not handled here.

### Pipeline and delivery durability (issues #230, #231)

- **Transport dead letters.** After 8 failed publishes `fail_processing_transport_event` dead-letters the outbox event and the document stays `registered`. The dispatcher now emits the `processing.transport.dead_letter` count metric and a `processing.transport.dead_lettered` error log; alert on either. A tenant admin lists dead-lettered events with `GET /api/v1/admin/processing-transport/dead-letters` and requeues one with an audited `POST` to the same path (`ops/RUNBOOK.md`); recovery of an individual job goes through `recoverDeadLetterProcessingJob`.
- **Lease budget.** The transport batch stops starting events once `TRANSPORT_BATCH_BUDGET_MS` (35s of the 60s lease) has elapsed and hands the remainder back through `release_processing_transport_event` (which refunds the attempt), and a failure in `fail` no longer aborts the remaining events.
- **Stage timeouts.** `src/modules/processing/server/stages/processing-stage-http.ts` keeps each call's timeout armed through body consumption. Representation retains a 27s stage budget inside the default 30s router limit, with provider calls capped at 20s. Extraction has a 510s stage budget, a 540s router limit and a 600s worker deadline; its provider timeout is capped at 480s and Terraform supplies 300s by default. The application's unset/invalid-variable fallback is 15s. See [`AI_MODEL_GATEWAY.md`](../architecture/AI_MODEL_GATEWAY.md).
- **Deletion requests** carry `execution_lease_expires_at` (10 minutes). A request stuck in `executing` with an expired or null lease is reclaimed by the next independent, authorized execute call; four-eyes, retention-coverage and legal-hold checks are unchanged. The adapter keeps receiving the stable `idempotency-key` (`tenant:request`). Since the schema an Organization Admin can also ask for a deletion from `/access-self-service`: that request waits in `pending_customer_approval`, which `EXECUTABLE_DELETION_STATES` does not include, until a different Organization Admin approves it (then it is `approved` and executes through this same flow, with this flow's checks). The admin console list (`GET /api/v1/admin/deletion-requests`) shows such requests like any other, with their `origin`.
- **Delivery tick** (`POST /api/internal/delivery`) settles every task independently and reports per-task results; any failed task makes the response 500 (with the other results still in the body) so the scheduler retries and alerts.
- **`last_error`** is written through `safeErrorText` (`src/modules/processing/server/recovery/processing-error-text.ts`): a stable error class plus a redacted (bearer tokens, JWTs, URL credentials/query strings, secret-named key/value pairs, opaque tokens, embedded JSON bodies), 500-character message.
- **Exports.** Object keys are deterministic per attempt (`exports/<tenant>/<export>/attempt-<n>/...`); a failed attempt deletes its own object and a successful one deletes its predecessors. Retries back off exponentially with jitter (1m, 2m, 4m, 8m, capped 15m) via `export_job.delivery_next_attempt_at`. `numeric(38,10)` values stay decimal strings end to end (CSV exact; XLSX numeric only when a double holds it exactly, otherwise exact text; Parquet `DECIMAL(38,10)`). Exports are capped at `EXPORT_MAX_ROWS` (200,000) with a typed, non-retryable `ExportRowLimitError`. Renderers still buffer in memory; a streaming rewrite is not done. Download grants are single use (`export_download_grant.consumed_at`); a failed download must request a fresh grant from the single-export read.

### Structured data plane

**Target/current architecture:** Supabase Postgres Singapore is the sole operational/canonical/serving structured write authority. GCS remains source evidence. Snowflake is optional downstream only.

**Repository migration state:** the Postgres-primary application migration is complete; Snowflake is not an application persistence dependency.

- Production config requires `CORVIS_DATABASE_DSN` and does not require Snowflake bindings to start.
- `PostgresProductionPlatform` is the active production composition for workspace, review/publication and operations persistence.
- `src/modules/research/server/research.ts` reads governed Postgres serving observations and records semantic-query logs in Postgres.
- The obsolete Snowflake-primary DDL reference set and unused application Snowflake SQL API adapter have been removed.
- Issue #28 is complete. Remaining data-plane work is provider-backed UAT/RLS/recovery/performance evidence and bounded decomposition where justified, not an application persistence migration.

Technical target rules are in [`DATA_PLATFORM.md`](../architecture/DATA_PLATFORM.md).

### Review and publication

- Extraction candidate review now has a dedicated forced-RLS Postgres domain: immutable policy requirements, append-only attributable decisions, and a derived exact-candidate-set review gate. Provider candidates and their evidence/confidence/provenance are not rewritten by review corrections.
- `candidate_review_v1` requires attributable review for every candidate because governed straight-through approval has not been activated; critical governed metric candidates require two distinct approvers and candidate exceptions require explicit resolution before canonicalization can proceed.
- A correction begins a new review epoch, so earlier approvals cannot satisfy the corrected candidate. The reviewed processing stage parks in a durable `blocked` state rather than consuming operational retry/dead-letter attempts while waiting for human review.
- Authorized candidate review commands use `POST /api/v1/extraction-review` with the existing review permission plus required idempotency key; accepted decisions are also written to the application audit trail. A tenant user exercising this permission is presented as a **Review Analyst**. A Corvis **Data Operations Reviewer** exercising equivalent tenant-scoped authority does so only through an explicit audited operational/support-access context; the actor provenance remains distinct even when the permission set is equivalent.
- The database independently prevents a `reviewed → canonicalized` processing transition unless the exact finalized extraction candidate set has a ready zero-blocker review gate.
- Canonicalization, reconciliation, consolidation and publication handlers are implemented with persistence-bound gates; operator status, dead-letter recovery and governed correction replay are also implemented. Production-like provider/UAT evidence for those paths remains tracked in issue #79.
- Existing canonical-observation review events, optimistic concurrency, correction history, critical-observation independent-review and publication-policy foundations remain downstream controls.
- Publication gates block unresolved review/material exceptions/incomplete lineage according to current policy primitives.
- Snapshot publication changes create durable outbox foundations.
- The customer workspace's **Review Analyst** UI now scopes review/publish state to the selected fund-period snapshot where snapshot-scoped observations are available. A dedicated extraction-candidate review UI remains separate product work; the governed API/persistence boundary exists now.
- Exception investigation, competing/prior values, resolution context and independent-approver UI are implemented in the workspace. Issues #6/#79 retain broader workflow acceptance and provider-backed evidence; they must not be read as proof that these UI paths are absent.

### Customer journey and module isolation

- The client workspace loads Documents, Snapshots and Observations independently with partial-success handling rather than one all-or-nothing request chain.
- A read-module failure produces a scoped degraded state; healthy modules remain usable.
- Acquisition/upload, workspace reads, review/publication, research and delivery are composed through typed ports/adapters rather than direct provider access from feature UI.
- Customer structured delivery now has a dedicated `DeliveryPort` and customer-facing Data Delivery surface for CSV/XLSX/Parquet export requests.
- The demo/E2E harness is stateful across the product seams: an uploaded source creates a review-scoped snapshot and structured observations, review decisions unlock publication, and published snapshots can be requested through the delivery module.
- Playwright covers the representative seam `upload → structured observations → review → publish → structured delivery` and an injected Observations-module outage that leaves unrelated customer surfaces available.
- These tests prove product contracts and blast-radius behavior in CI; they are **not** production/provider activation evidence. Production-equivalent `uat` must repeat the journey against real Postgres/GCS/processing/delivery bindings and fault-inject representative module/dependency failures.
- `src/platform/data/platform.ts` remains a broad service composition boundary. Further decomposition should be driven by concrete failure/scaling/security boundaries; its production persistence paths are already Postgres-backed.

See [`MODULARITY.md`](../architecture/MODULARITY.md) and issue #12.

### Retrieval and AI

- `src/modules/research/server/research.ts` keeps structured facts and source retrieval conceptually separate.
- Retrieval carries tenant/workspace/document/fund filters before search execution.
- Source text is treated as untrusted data and responses carry source-reference citations.
- Semantic-query ID/hash foundations exist.
- Governed structured research reads Postgres serving observations. Provider-backed retrieval/AI evaluation, streaming/error behavior and full production-like coverage remain in issue #7 and the activation tracks.

### Reliability and delivery

- Processing-job/outbox schemas, authoritative stage claims, deterministic effect keys/journaling and retry/dead-letter state primitives exist.
- The processing transport has durable lease ownership, bounded transport retry/dead-letter behavior, Pub/Sub publication and Cloud Tasks scheduling adapters that honor persisted retry timing.
- Authenticated `POST /api/internal/processing-stage` ingress verifies Google OIDC for approved Pub/Sub/Cloud Tasks callers, re-resolves the immutable service-account subject through Postgres lifecycle/membership/data-right controls, and invokes the authoritative Postgres stage/effect worker composition without accepting transport claims as application authorization.
- `BoundedProcessingStageEffectRouter` isolates stage handlers with fail-closed missing bindings and hard timeout/cancellation behavior.
- The `registered` production handler revalidates the exact source artifact against tenant/document-scoped Postgres metadata and requires clean/released immutable GCS generation plus SHA-256 lineage before the pipeline can advance beyond registration.
- The `represented` production handler defines deterministic representation identity, exact predecessor-lineage handoff, keyless bounded invocation of a Corvis representation service, independent GCS generation/hash/source verification and conflict-idempotent forced-RLS Postgres representation metadata. It is composed only when `CORVIS_REPRESENTATION_ENDPOINT` is supplied; otherwise the represented stage remains fail-closed.
- The `extracted` production handler consumes only the exact committed representation lineage, calls a replaceable keyless extraction provider with a deterministic run/bundle identity, independently verifies the immutable GCS JSONL bundle and governed skill/schema metadata, validates evidence/confidence/provenance-backed candidates, and persists forced-RLS server-only extraction runs/candidates/source references idempotently in Postgres. The provider has no Postgres or canonical-write authority. It is composed only when `CORVIS_EXTRACTION_ENDPOINT` is supplied; otherwise the extracted stage remains fail-closed.
- The `reviewed` production handler consumes only finalized `ready` extraction runs and exact predecessor candidate-set lineage. It records immutable policy requirements and evaluates append-only attributable review decisions. Pending human review is a durable `blocked` state, not a technical retry; a ready review gate re-queues the same deterministic reviewed-stage effect. A persistence trigger prevents the next canonicalization job until the exact candidate set has a zero-blocker ready gate.
- Canonicalization/reconciliation/consolidation/publication handlers, operator dead-letter/replay/status controls and governed correction replay are implemented. Issue #79 now owns production-like execution and retained provider/recovery evidence rather than implementation of those paths.
- Merging authenticated ingress, representation, extraction or review-stage code does **not** prove real Pub/Sub/Cloud Tasks IAM, representation/extraction providers, UAT GCS/Postgres bindings, Data Operations Reviewer operations or production-like recovery behavior. Those remain activation/evidence work.
- `src/platform/observability/telemetry.ts` provides structured telemetry hooks.
- Export job/manifest/checksum and webhook-signing/replay foundations exist.
- `/api/v1/admin/readiness` provides fail-closed readiness diagnostics.
- Initial GCP Terraform provisions Pub/Sub lifecycle/dead-letter topics and Cloud Tasks foundations in `dev`.
- SLO dashboards/alerts and broader recovery evidence remain tracked in issue #9.
- Asynchronous export rendering/storage/expiry, scheduled export execution and signed durable/retryable customer webhook delivery are implemented in the delivery server and scheduled internal tick. Issue #11 retains provider-backed delivery/recovery evidence; the implemented adapters and client surface do not establish live operation.

### Admin, control and evidence

- Admin API foundations exist for feature flags, deletion workflows, control evidence and readiness.
- Data-lifecycle adapter and evidence foundations exist.
- These paths use the Postgres control plane. The `/admin` console, tenant-health and tenant-export-build surfaces are implemented with server reauthorization and audit controls. Issue #10 retains provider-backed administration and cross-channel authorization acceptance.
- Recurring automated evidence collection/freshness/escalation remains tracked in issue #14.

### Secure SDLC and infrastructure

- deterministic lockfile + `npm ci`;
- ESLint, TypeScript, unit tests, production build, Playwright and dependency audit in CI;
- CodeQL and Dependabot;
- Terraform validation discovers implemented environment roots;
- initial GCP `dev` foundation for APIs, KMS, GCS, Artifact Registry, Pub/Sub, Cloud Tasks and service identities;
- obsolete Corvis-managed AWS/S3 reference infrastructure removed;
- browser security headers and safe error boundaries.

Repository infrastructure includes `dev`, `uat` and `prod` Terraform roots, Cloud Run and AI-runtime modules, edge/origin configuration, Secret Manager identities, cost guards and reviewed release/promotion/rollback workflows. Issue #13 retains environment activation and evidence. In particular, #358 tracks the least-privilege runtime login rollout, and #224 tracks external trust/account settings; merged infrastructure code does not close either live gate.

Technical standards:

- [`MODULARITY.md`](../architecture/MODULARITY.md)
- [`INFRASTRUCTURE.md`](./INFRASTRUCTURE.md)
- [`GITHUB_ENVIRONMENTS.md`](./GITHUB_ENVIRONMENTS.md)
- [`DEPLOYMENT.md`](./DEPLOYMENT.md)

## Adapter boundary

Corvis product modules consume stable contracts rather than vendor-specific implementation details. GCS, Postgres/Supabase, identity providers, search/model providers, Cloudflare and telemetry providers remain replaceable behind implementation boundaries provided they continue to satisfy business/data/security contracts.

Snowflake is specifically **not** a required application adapter at launch. If activated later, it must be introduced as optional downstream analytics/sharing without changing Postgres write authority.

## Implementation is not activation

Merging code does not prove an IdP, production GCS bucket, Postgres project/RLS policy, Cloudflare edge, malware scanner, representation/extraction provider, Data Operations Reviewer operating process, backup or operational control is operating correctly. [`PRODUCTION_ACTIVATION.md`](./PRODUCTION_ACTIVATION.md) defines the live technical activation/evidence checks; Confluence retains the final business/control readiness gate.
