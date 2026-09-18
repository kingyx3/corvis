# Enterprise implementation status

This document maps the enterprise architecture to executable repository components. The authoritative semantic/security architecture remains in Confluence; this file documents implementation boundaries only.

## Implemented runtime

### Identity and tenant authorization
- `core/enterprise.ts` defines roles, permissions, entitlements and source-access separation.
- `lib/server/request-context.ts` accepts production identity only from a trusted gateway secret and rejects caller-supplied identity without that trust boundary.
- Production configuration requires issuer/audience and fails closed when bindings are missing.

### Source ingestion
- `lib/server/s3.ts` implements S3/S3-compatible SigV4 control operations and multipart presigning.
- `lib/server/uploads.ts` implements durable tenant-scoped sessions, idempotency, actual-part resume state, exact part validation, file-signature validation and quarantine.
- Artifacts remain quarantined until the configured malware-clean object tag is observed; only clean artifacts emit `DocumentRegistered`/processing state.
- Browser bytes travel directly to object storage; the application API never proxies large uploads.

### Structured data plane
- `lib/server/snowflake.ts` implements the Snowflake SQL API adapter with OAuth and bound parameters.
- `db/migrations/001_enterprise_core.sql` establishes tenant-scoped canonical/serving foundations.
- `002_governance_delivery.sql` establishes rights, retention, deletion, jobs/outbox, webhooks and exports.
- `003_serving_review_retrieval.sql` completes holdings/instruments, representations/classification, reconciliation, control evidence and secure serving read models.
- `lib/server/platform.ts` binds customer reads, review, publication, audit, export and job status to Snowflake.

### Review and publication
- Review events are immutable and optimistic-concurrency protected.
- Critical observations require independent reviewers before becoming approved.
- Publication gates block unresolved review, material exceptions, incomplete critical review or incomplete source lineage.
- Snapshot publication changes create durable outbox events.

### Retrieval and AI
- `lib/server/research.ts` keeps structured facts and source retrieval separate.
- Retrieval calls carry tenant/workspace/document/fund filters before search execution.
- Source text is sanitized/marked as untrusted data and cannot authorize tools.
- Research responses carry semantic-query IDs and source-reference citations.
- `/api/v1/source-references/{id}` independently rechecks source permissions before exposing exact evidence coordinates/excerpts.

### Reliability and delivery
- Processing jobs/outbox schemas, retry/dead-letter logic and audited operator retry exist.
- `lib/server/telemetry.ts` emits structured events locally and to the configured enterprise collector.
- Export requests create versioned manifests/checksums and durable export jobs/outbox events.
- Webhook signing/replay verification primitives are tested.
- `/api/v1/admin/readiness` fails deployment readiness when required production bindings are absent/unhealthy.

### Secure SDLC / infrastructure
- deterministic lockfile + `npm ci`;
- ESLint, TypeScript, unit tests, production build, Playwright and dependency audit in CI;
- CodeQL and Dependabot;
- Terraform reference: versioned private KMS-encrypted S3, restricted upload CORS, multipart cleanup and encrypted processing queue/DLQ;
- Terraform format/init/validate CI gate;
- browser security headers and safe error boundaries.

## Adapter boundary

Corvis product modules consume contracts, not vendor SDKs. Snowflake, S3, identity gateways, search providers, AI providers and telemetry systems can be replaced behind adapters without changing fund/holding/observation/snapshot semantics.

## Deployment activation is separate from implementation

Merging source code does not prove an IdP, bucket, Snowflake account, search corpus, malware scanner, backup or operational control is active. `PRODUCTION_ACTIVATION.md` defines the live activation/evidence gate. Production configuration intentionally fails closed until those bindings exist.
