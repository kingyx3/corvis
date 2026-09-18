# Corvis

Corvis private-markets data platform.

## Documentation authority

This repository documents **implemented code, local development and code-level interfaces only**. It is not the source of truth for enterprise architecture, security policy, data semantics, production cloud design or readiness requirements.

Authoritative Confluence documentation:

- Enterprise Production Readiness Master Plan: https://corvis.atlassian.net/wiki/spaces/FUNDATA/pages/1376262
- Core Product — End-to-End Data & Semantic Architecture: https://corvis.atlassian.net/wiki/spaces/FUNDATA/pages/688508
- Platform Architecture & Data Lifecycle: https://corvis.atlassian.net/wiki/spaces/FUNDATA/pages/360450
- GCP Cloud Infrastructure & Deployment Standard: https://corvis.atlassian.net/wiki/spaces/FUNDATA/pages/1507331

GitHub issues track executable implementation work and link to their authoritative Confluence owners. Requirements and architecture should be changed in Confluence first rather than copied into GitHub.

## Repository responsibility

This GitHub repository is the canonical home for all executable Corvis application and infrastructure code used to build production:

```text
apps/
  customer-web/        customer-facing Next.js application
  admin-web/           administrative Next.js application

services/
  api/                 authenticated backend/API and admin commands
  workers/             asynchronous processing workers / job entry points

packages/
  contracts/           stable shared application/domain contracts
  ...                  reusable libraries and clients

infra/
  terraform/           GCP and supported Snowflake infrastructure as code

db/
  snowflake/           versioned Snowflake migrations, policies and serving objects
```

The exact physical layout may be introduced incrementally from the current frontend-only structure, but these ownership boundaries are required. Production application or infrastructure code must not be maintained in an untracked external deployment project.

## Production deployment target

Production is standardized on GCP with Snowflake on GCP:

- `apps/customer-web` → Cloud Run
- `apps/admin-web` → separate Cloud Run service
- `services/api` → Cloud Run
- `services/workers` → Cloud Run services and/or Cloud Run Jobs
- immutable source and replay artifacts → Google Cloud Storage
- events/tasks → Pub/Sub / Cloud Tasks
- secrets → Secret Manager
- encryption keys → Cloud KMS
- images → Artifact Registry
- infrastructure → Terraform under `infra/terraform`
- governed structured data → Snowflake on GCP

Deployment, identity, networking, storage, Snowflake integration and environment requirements are authoritative in Confluence rather than duplicated here.

## Admin application and feature flags

The admin application is a separate production surface from the customer application. Among its controlled operations, it must support governed feature-flag administration.

Feature-flag implementation rules:

- stable feature keys and a shared feature-capability contract;
- authorized admins can view/toggle supported flags globally and by tenant/workspace, with narrower scopes only where explicitly designed;
- backend evaluation is authoritative—UI hiding is not enforcement;
- customer UI, admin UI, API, workers, exports and AI/retrieval paths consume the same effective feature state where applicable;
- production changes are audited with actor, target, old/new state and reason;
- operationally critical flags can act as kill switches without redeployment;
- feature flags do not replace RBAC, resource entitlements or contractual data-rights checks;
- temporary rollout flags have an owner and retirement condition.

The detailed model and launch requirements live in the GCP Infrastructure Standard and Enterprise Production Readiness Master Plan.

## Product surface currently represented in this repo

- Reporting-cycle overview and fund-period status
- Source document library with ingestion/extraction/review state
- Large-file upload UI
- Document processing / lineage view
- Trusted observation review with source evidence
- CSV export surface
- Ask Corvis research workspace UI

The customer UI is designed to expose fund-period snapshots, trusted observations and entitled source evidence. It must not treat raw extraction JSON or unrestricted physical Snowflake tables as product contracts.

## Code architecture: linked, not married

Each capability owns one concern and depends on contracts rather than another module's implementation.

Current frontend structure:

```text
core/contracts.ts                    stable domain + port contracts
        │
        ├── application/             use-case orchestration
        ├── adapters/                replaceable infrastructure / demo bindings
        ├── runtime/services.ts      composition root for adapters
        ├── features/                product capabilities
        ├── components/ui/           reusable presentation primitives
        └── app/page.tsx             shell + feature composition only
```

Code-level rules:

- Feature modules depend on stable contracts/application services, not adapter internals.
- Vendor/API details live in adapters.
- Infrastructure/provider SDKs do not leak into product/domain contracts.
- Demo data is an adapter, not domain state.
- Customer-facing modules consume serving/application contracts, not extraction schemas.
- Search, source evidence and structured fact access remain independently permissioned.
- Global entity identity never widens tenant access.

## Run locally

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

By default the current frontend uses demo/mock adapters so workflows remain interactive before production services are connected.

## Application API binding

Set:

```bash
NEXT_PUBLIC_CORVIS_API_BASE=https://api.example.com
NEXT_PUBLIC_CORVIS_MOCK_API=false
```

Production must fail closed rather than silently reverting to demo mode when required configuration is missing.

## Upload adapter currently implemented in the frontend

The current HTTP adapter exposes an S3-style multipart-compatible application protocol:

1. `POST /uploads/initiate`
2. `POST /uploads/{uploadId}/parts`
3. Browser uploads bytes directly to the returned object-storage URL.
4. `POST /uploads/{uploadId}/complete`

This describes the existing frontend adapter, not the production cloud architecture. The production standard is GCP/GCS and may normalize native GCS resumable-upload semantics behind the stable application port. Provider-specific concepts such as multipart ETags must not become domain contracts.

## Platform lifecycle consumed by the UI

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

## Current stack

- Next.js 16.3
- React 19.3
- TypeScript
- No component framework dependency

## Implementation tracking

Open GitHub epics track repository work for identity, ingestion, orchestration, Snowflake, review, Ask Corvis, secure SDLC, SRE, admin/lifecycle/feature flags, APIs, product quality, GCP/IaC and control-evidence automation. Each epic links back to the relevant Confluence source of truth.
