# Corvis

Corvis private-markets data platform.

## Documentation authority

This repository documents **implemented code, local development and code-level interfaces only**. It is not the source of truth for enterprise architecture, security policy, data semantics, production cloud design or readiness requirements.

Authoritative Confluence documentation:

- Enterprise Production Readiness Master Plan: https://corvis.atlassian.net/wiki/spaces/FUNDATA/pages/1376262
- Core Product — End-to-End Data & Semantic Architecture: https://corvis.atlassian.net/wiki/spaces/FUNDATA/pages/688508
- Platform Architecture & Data Lifecycle: https://corvis.atlassian.net/wiki/spaces/FUNDATA/pages/360450
- GCP Cloud Infrastructure & Deployment Standard: https://corvis.atlassian.net/wiki/spaces/FUNDATA/pages/1507331

GitHub issues track executable implementation work and link to their authoritative Confluence owners. Requirements and architecture change in Confluence first rather than being copied into GitHub.

## Production target

The approved production topology is:

- **GCP Singapore** — customer/admin/API/worker compute, Identity Platform, GCS, Pub/Sub, Cloud Tasks, Secret Manager, Cloud KMS, Artifact Registry and platform telemetry.
- **Snowflake on AWS Singapore (`ap-southeast-1`)** — governed structured data, Snowflake Hybrid Tables for the default transactional control plane, semantic/serving models and Cortex Search.
- **Cloudflare** — selective public edge for DNS/TLS/DDoS/WAF/rate limiting/safe caching/origin protection.
- **No Corvis-managed AWS infrastructure by default.** Snowflake being hosted on AWS does not require an AWS account, S3, EC2/VPC or AWS Terraform provider for Corvis.
- **Cloud SQL is a fallback**, not the default control plane; add it only if Hybrid Table benchmarks fail application requirements.

Source binaries and replayable artifacts remain in GCS. Snowflake accesses approved GCS data through supported integrations rather than a duplicate S3 source lake.

## Repository ownership

The target monorepo ownership boundaries are:

```text
apps/
  customer-web/
  admin-web/
services/
  api/
  workers/
packages/
  contracts/
  domain/
  auth/
  feature-flags/
  observability/
  shared/
infra/
  terraform/
    modules/
      gcp/
      cloudflare/
      snowflake/
    environments/
      dev/
      staging/
      prod/
db/
  snowflake/
```

The current physical layout is migrating incrementally toward these boundaries. Production application or infrastructure code must not live in an untracked external deployment project.

## Public repository posture

The repository is intentionally public for now, with an H2 2027 privacy review recorded in Confluence. Treat every committed byte and Git-history version as permanently public: never commit customer data, production credentials, private keys, real secrets, confidential control evidence or sensitive environment values.

## Source upload implementation

Production source ingestion uses native **Google Cloud Storage resumable uploads**:

1. Browser calls `POST /api/v1/uploads/initiate`.
2. Corvis authenticates/authorizes the caller, validates the exact browser origin, allocates tenant-scoped document/artifact/ingestion IDs and creates a GCS resumable session.
3. Browser uploads source bytes directly to the returned GCS resumable session in aligned chunks. Cloudflare and application servers do not proxy the file body.
4. Interrupted transfers query the GCS resumable session for the committed range and continue from the next byte.
5. Browser calls `POST /api/v1/uploads/{uploadId}/complete`.
6. Corvis verifies the final GCS object size/generation/storage checksums and file signature, then quarantines it.
7. The approved scanner writes the configured object-metadata disposition. Only clean artifacts are released and emit `DocumentRegistered`.

Multipart part numbers and S3 ETags are not Corvis domain/API contracts.

## Structured data and product serving

Customer-facing modules consume governed application/serving contracts, not raw extraction payloads or unrestricted physical Snowflake tables. The logical data contract is:

```text
SOURCE → STAGING → CANONICAL → CURATED → SEMANTIC → SERVING
```

Global economic identity never widens tenant access. Search/source-evidence access and structured-fact access remain independently permissioned.

## Admin and feature flags

The target admin application is a separate production surface. Feature flags use stable keys, server-authoritative evaluation, global/environment/tenant/workspace scopes where designed, audited mutation and emergency kill switches. Flags do not replace RBAC, resource entitlements or contractual data-rights checks.

## Platform lifecycle

```text
registered
  → represented
  → extracted
  → reviewed
  → canonicalized
  → reconciled
  → consolidated
  → published
```

These are product lifecycle states exposed through application contracts. Authoritative lifecycle/event semantics are maintained in Confluence.

## Current implementation status

The repository now contains meaningful production-oriented runtime code for Snowflake-backed serving/review/publication, permissioned retrieval, admin control APIs, exports/webhooks, jobs/outbox, control evidence and GCS resumable upload adapters. It is **not enterprise-production-ready merely because these adapters exist**. Live provider bindings, complete Terraform, direct Identity Platform verification/control-plane authorization, Hybrid Table migration, Pub/Sub/Tasks processing, full admin UI, broader API contracts, accessibility/E2E/performance coverage and operated control/SRE evidence remain tracked in open GitHub epics.

See:

- `docs/ENTERPRISE_IMPLEMENTATION.md` for code-level implementation status.
- `docs/PRODUCTION_ACTIVATION.md` for live provider/evidence gates.
- `ops/RUNBOOK.md` and `ops/slos.yaml` for operational implementation artifacts.

## Local development

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

Local development uses demo/mock adapters only when explicitly enabled. Production must fail closed rather than silently falling back to demo mode.

## Current stack

- Next.js 16.3
- React 19.3
- TypeScript

## Verification

```bash
npm run verify
npm run test:e2e
```

CI also runs dependency audit, CodeQL and Terraform validation for implemented Terraform roots.
