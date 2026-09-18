# Corvis

Corvis private-markets data platform.

## Documentation authority

Corvis deliberately separates business architecture from technical implementation.

**Confluence owns business-level truth:** product/business capabilities, canonical semantic requirements, customer rights, operating model, commercial decisions, risk/control requirements and production-readiness gates.

**GitHub owns technical truth:** implementation architecture, cloud topology, infrastructure as code, database migrations, environment configuration, secret names, CI/CD, runtime adapters, runbooks and code-level interfaces.

If the same subject appears in both places, Confluence defines the required outcome and GitHub defines how it is implemented. GitHub must not silently redefine business semantics, customer rights, security/control claims or commercial commitments.

Start with [`docs/README.md`](docs/README.md) for the technical documentation index.

Key Confluence business references:

- Enterprise Production Readiness Plan: https://corvis.atlassian.net/wiki/spaces/FUNDATA/pages/1376262
- Core Product Architecture: https://corvis.atlassian.net/wiki/spaces/FUNDATA/pages/688508
- Platform Architecture & Data Lifecycle: https://corvis.atlassian.net/wiki/spaces/FUNDATA/pages/360450
- Canonical Data Model, Taxonomy & Lineage: https://corvis.atlassian.net/wiki/spaces/FUNDATA/pages/425985

## Current production architecture

- **Cloudflare** — Terraform-managed public edge: authoritative DNS, TLS/proxy, DDoS/WAF/rate controls and safe caching.
- **GCP Singapore** — Cloud Run/Jobs, GCS, Pub/Sub/Tasks/Scheduler, Secret Manager/KMS, Artifact Registry and platform telemetry.
- **Supabase Postgres Singapore** — primary production operational/canonical/serving structured system of record.
- **GCS** — immutable source-document and replayable-artifact lake.
- **Snowflake** — optional downstream analytics / secure sharing only after an explicit activation decision; never the application write authority.
- **No Corvis-managed AWS infrastructure by default.**

Detailed technical implementation is in [`docs/INFRASTRUCTURE.md`](docs/INFRASTRUCTURE.md) and [`docs/DATA_PLATFORM.md`](docs/DATA_PLATFORM.md).

## GitHub-first environment configuration

Canonical deployment environments are:

```text
dev
uat
prod
```

The old name `staging` is deprecated in favor of `uat`.

Human-entered technical deployment configuration should be set in GitHub Environment variables/secrets and propagated by GitHub Actions to GCP, Cloudflare and Supabase wherever provider APIs/IaC allow. GCP runtime secrets ultimately live in Secret Manager; GitHub is the deployment control plane, not the application runtime secret store.

See [`docs/GITHUB_ENVIRONMENTS.md`](docs/GITHUB_ENVIRONMENTS.md) for the exact variable/secret checklist and unavoidable one-time bootstrap exceptions.

## Repository ownership

Target monorepo boundaries:

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
      cloudflare/
      gcp/
      supabase/
      snowflake/       # optional downstream only
    environments/
      dev/
      uat/
      prod/
db/
  postgres/
    migrations/
  snowflake/           # optional downstream only
```

The physical layout is migrating incrementally toward these boundaries. Production application or infrastructure code must not live in an untracked external deployment project.

## Public repository posture

The repository is intentionally public for now, with an H2 2027 privacy review recorded in Confluence. Treat every committed byte and Git-history version as permanently public: never commit customer data, production credentials, private keys, real secrets, confidential control evidence or sensitive environment values.

## Source upload

Production ingestion uses native Google Cloud Storage resumable uploads:

1. Browser calls `POST /api/v1/uploads/initiate`.
2. Corvis authenticates/authorizes the caller, validates origin and creates a tenant-scoped GCS resumable session.
3. Browser uploads directly to GCS; Cloudflare and application servers do not proxy ordinary multi-GB file bodies.
4. Interrupted transfers query committed range and resume.
5. Corvis verifies final GCS size/generation/checksums and file signature, then quarantines the artifact.
6. Only an approved clean malware disposition releases the artifact and allows `DocumentRegistered` processing.

Multipart part numbers and S3 ETags are not Corvis domain/API contracts.

## Structured data

Customer-facing modules consume governed application/serving contracts, not raw extraction payloads or unrestricted physical database tables.

```text
SOURCE → STAGING → CANONICAL → CURATED → SEMANTIC → SERVING
```

The logical layers are product/data contracts; current authoritative structured persistence is Postgres. Search indexes and any future Snowflake warehouse remain rebuildable/downstream.

Global economic identity never widens tenant access. Source-evidence access and structured-fact access remain independently permissioned.

## Current implementation status

The repository contains production-oriented foundations for GCS resumable ingestion, serving/review/publication, permissioned retrieval, admin/control APIs, exports/webhooks, jobs/outbox, control evidence and initial GCP Terraform.

The repository is currently migrating legacy Snowflake-primary persistence code to the approved Postgres-primary implementation. Production is not enterprise-ready merely because adapters or infrastructure code exist; live provider bindings, production-equivalent UAT, direct identity verification/control-plane authorization, complete Postgres/RLS migration, Cloudflare/origin hardening, durable processing, admin UI, broader E2E/security coverage and operated control/SRE evidence remain tracked in GitHub issues.

Technical status and activation:

- [`docs/ENTERPRISE_IMPLEMENTATION.md`](docs/ENTERPRISE_IMPLEMENTATION.md)
- [`docs/PRODUCTION_ACTIVATION.md`](docs/PRODUCTION_ACTIVATION.md)
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)
- [`ops/RUNBOOK.md`](ops/RUNBOOK.md)
- [`ops/slos.yaml`](ops/slos.yaml)

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
