# Enterprise implementation status

This document maps the enterprise architecture to executable repository components. The authoritative semantic/security/cloud architecture remains in Confluence; this file documents implementation boundaries only.

## Implemented runtime

### Identity and tenant authorization
- `core/enterprise.ts` defines roles, permissions, entitlements and source-access separation.
- `lib/server/request-context.ts` accepts production identity only from a trusted gateway secret and rejects caller-supplied identity without that trust boundary.
- Production configuration requires issuer/audience and fails closed when bindings are missing.
- Direct Identity Platform token/session verification plus Corvis control-plane resolution remains tracked in GitHub issue #2.

### Source ingestion
- `lib/server/gcs.ts` implements GCS control operations using GCP workload identity and creates native resumable upload sessions.
- `lib/server/uploads.ts` implements tenant-scoped sessions, idempotent initiate/complete behavior, exact object-size verification, GCS generation/checksum capture, file-signature validation and quarantine.
- `adapters/upload/http-gcs-resumable-upload.ts` sends browser bytes directly to GCS in resumable chunks, queries committed offsets and resumes after interruption.
- Artifacts remain quarantined until the approved scanner writes the configured clean object-metadata disposition; only clean artifacts emit `DocumentRegistered`/processing state.
- Cloudflare and the Corvis application API never proxy ordinary large source-document bodies.
- Provider-integrated interruption/quarantine/E2E evidence remains tracked in issue #3.

### Structured data plane
- `lib/server/snowflake.ts` implements the Snowflake SQL API adapter with OAuth and bound parameters.
- `db/migrations/001_enterprise_core.sql` establishes tenant-scoped canonical/serving foundations.
- `002_governance_delivery.sql` establishes rights, retention, deletion, jobs/outbox, webhooks and exports.
- `003_serving_review_retrieval.sql` adds holdings/instruments, representations/classification, reconciliation, control evidence and secure serving read models.
- `004_operational_controls.sql` adds operational control structures.
- `lib/server/platform.ts` binds customer reads, review, publication, audit, export and job status to Snowflake.
- The target AWS Singapore Snowflake account, Hybrid Table control-plane migration and complete authoritative layer model remain tracked in issue #5.

### Review and publication
- Review events are immutable and optimistic-concurrency protected.
- Critical observations require independent reviewers before becoming approved.
- Publication gates block unresolved review, material exceptions, incomplete critical review or incomplete source lineage.
- Snapshot publication changes create durable outbox events.
- The exception/reconciliation workbench and remaining production workflow coverage stay open in issue #6.

### Retrieval and AI
- `lib/server/research.ts` keeps structured facts and source retrieval separate.
- Retrieval calls carry tenant/workspace/document/fund filters before search execution.
- Source text is sanitized/marked as untrusted data and cannot authorize tools.
- Research responses carry semantic-query IDs and source-reference citations.
- `/api/v1/source-references/{id}` independently rechecks source permissions before exposing exact evidence coordinates/excerpts.
- Deterministic semantic-query routing, streaming/error behavior and full evaluation coverage remain tracked in issue #7.

### Reliability and delivery
- Processing jobs/outbox schemas, retry/dead-letter primitives and audited operator retry exist.
- `lib/server/telemetry.ts` emits structured events locally and to the configured enterprise collector.
- Export requests create versioned manifests/checksums and durable export jobs/outbox events.
- Webhook signing/replay verification primitives are tested.
- `/api/v1/admin/readiness` fails deployment readiness when required production bindings are absent/unhealthy.
- Live Pub/Sub/Cloud Tasks consumers, SLO dashboards/alerts and recovery evidence remain open in issues #4 and #9.

### Secure SDLC / infrastructure
- deterministic lockfile + `npm ci`;
- ESLint, TypeScript, unit tests, production build, Playwright and dependency audit in CI;
- CodeQL and Dependabot;
- Terraform validation discovers actual implemented Terraform roots; the obsolete AWS/S3 reference has been removed;
- browser security headers and safe error boundaries.
- Production GCP/Cloudflare/Snowflake Terraform remains tracked in issue #13.

## Adapter boundary

Corvis product modules consume contracts, not vendor SDKs. Snowflake, GCS, identity gateways, search providers, AI providers and telemetry systems can be replaced behind adapters without changing fund/holding/observation/snapshot semantics.

## Deployment activation is separate from implementation

Merging source code does not prove an IdP, GCS bucket, Snowflake account, search corpus, malware scanner, backup or operational control is active. `PRODUCTION_ACTIVATION.md` defines the live activation/evidence gate. Production configuration intentionally fails closed until those bindings exist.
