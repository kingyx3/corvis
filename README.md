# Corvis

Corvis private-markets data platform.

## Documentation authority

This repository documents **implemented code, local development and code-level interfaces only**. It is not the source of truth for enterprise architecture, security policy, data semantics, production cloud design or readiness requirements.

Authoritative Confluence documentation:

- Enterprise Production Readiness Master Plan: https://corvis.atlassian.net/wiki/spaces/FUNDATA/pages/1376262
- Core Product — End-to-End Data & Semantic Architecture: https://corvis.atlassian.net/wiki/spaces/FUNDATA/pages/688508
- Platform Architecture & Data Lifecycle: https://corvis.atlassian.net/wiki/spaces/FUNDATA/pages/360450
- GCP Cloud Infrastructure & Deployment Standard: https://corvis.atlassian.net/wiki/spaces/FUNDATA/pages/1507331
- Snowflake Data Platform reference: https://corvis.atlassian.net/wiki/spaces/FUNDATA/pages/655414

GitHub issues track executable implementation work and link to their authoritative Confluence owners. Requirements and architecture should be changed in Confluence first rather than copied into GitHub.

## Repository visibility

This repository is intentionally public for now. The authoritative master plan records an H2 2027 review of moving it private. Until then, every committed byte and Git-history version must be treated as permanently public: never commit customer data, production credentials, private keys, actual secrets, confidential control evidence or sensitive environment values.

## Repository responsibility

This GitHub repository is the canonical home for executable Corvis application and infrastructure code used to build production. The target ownership boundaries are:

```text
apps/
  customer-web/        customer-facing Next.js application
  admin-web/           administrative Next.js application
services/
  api/                 authenticated backend/API and admin commands
  workers/             asynchronous processing workers / job entry points
packages/
  contracts/           stable shared application/domain contracts
  domain/              domain model and validation
  auth/                authentication/authorization helpers
  feature-flags/       feature-capability evaluation contracts
  observability/       logging/tracing/correlation helpers
  shared/              shared non-domain utilities
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
  snowflake/           versioned Snowflake migrations, policies and serving objects
```

The exact physical layout may be introduced incrementally from the current frontend-oriented structure, but these ownership boundaries are required.

## Production deployment target

**GCP Singapore is the primary application/infrastructure cloud. Snowflake is hosted by Snowflake on AWS Asia Pacific (Singapore), `ap-southeast-1`. Cloudflare is the selective public edge.**

- Cloudflare → DNS, TLS edge, DDoS protection, WAF, rate limiting, safe CDN caching and routing/origin protection
- `apps/customer-web` → Cloud Run in GCP Singapore behind Cloudflare
- `apps/admin-web` → separate Cloud Run service in GCP Singapore behind Cloudflare with stricter controls
- `services/api` → Cloud Run in GCP Singapore behind Cloudflare for public ingress
- `services/workers` → Cloud Run services and/or Cloud Run Jobs; internal GCP paths do not traverse Cloudflare
- immutable source and replay artifacts → Google Cloud Storage
- events/tasks → Pub/Sub / Cloud Tasks
- authentication → Google Cloud Identity Platform / Firebase Authentication with Identity Platform
- secrets → Secret Manager
- encryption keys → Cloud KMS
- images → Artifact Registry
- governed structured data → Snowflake on AWS Singapore
- transactional control-plane state → Snowflake Hybrid Tables by default
- retrieval → Snowflake Cortex Search initially
- infrastructure/configuration → Terraform for GCP, Cloudflare and Snowflake plus controlled Snowflake migrations

Snowflake being hosted on AWS **does not require a Corvis AWS account or the Terraform AWS provider by default**. Use the Snowflake Terraform provider for Snowflake account objects/configuration. Add Corvis-managed AWS resources only through an approved architecture change.

The source lake remains GCS. Snowflake can consume approved GCS paths through Snowflake storage integrations/external stages; do not create a duplicate S3 source lake simply because Snowflake is AWS-hosted. Cross-cloud GCP↔Snowflake latency and transfer cost must be measured and monitored.

## Transactional control plane

The default production design uses Snowflake Hybrid Tables for transactional operational state such as tenant/workspace membership, RBAC/entitlements, feature flags, idempotency/upload sessions and related coordination metadata. This keeps operational and governed structured state in one Snowflake account and avoids a database synchronization pipeline initially.

Cloud SQL PostgreSQL is a fallback only if measured Hybrid Table latency, throughput, availability, functionality or cost does not meet application requirements. If Cloud SQL is introduced later, replicate required control-plane history into Snowflake through CDC rather than bespoke dual writes.

## Cost and SLO posture

The implementation should minimize idle and duplicated infrastructure without weakening reliability or control requirements:

- Cloud Run scales to zero by default where latency/SLOs permit; minimum instances require measured justification.
- Use event-driven Pub/Sub/Cloud Tasks rather than wasteful polling.
- Keep large source-document upload bytes off Cloudflare and API compute: browser → authorized API initiation → direct resumable GCS upload.
- Cache versioned static assets aggressively at Cloudflare, but do not shared-cache authenticated tenant/admin/source-evidence/private-export responses unless isolation is provably safe.
- Keep one authoritative object store (GCS) and one governed structured platform (Snowflake).
- Use Snowflake auto-suspend/right-sizing, workload separation and cost/query attribution; benchmark Hybrid Table cost and application latency.
- Monitor GCP↔Snowflake transfer volume/cost rather than duplicating the source lake pre-emptively.
- Budgets/alerts should surface runaway compute, retries, abandoned uploads and unexpected edge/origin traffic.

Initial engineering targets are defined in Confluence and instrumented by the repository SLO configuration, including 99.9% monthly API availability, p95 publication freshness ≤60 minutes for unblocked approved data, structured-data RPO ≤15 minutes, structured-data RTO ≤120 minutes and acknowledged source-artifact RPO = 0. Customer contractual SLAs require separate approval and operating evidence.

## Admin application and feature flags

The admin application is a separate production surface from the customer application. Among its controlled operations, it must support governed feature-flag administration.

Feature-flag implementation rules:

- stable feature keys and a shared feature-capability contract;
- authorized admins can view/toggle supported flags globally and by tenant/workspace;
- backend evaluation is authoritative—UI hiding is not enforcement;
- customer UI, admin UI, API, workers, exports and AI/retrieval paths consume the same effective feature state where applicable;
- production changes are audited with actor, target/scope, old/new state, reason and correlation ID;
- operationally critical flags can act as kill switches without redeployment;
- feature flags do not replace RBAC, resource entitlements or contractual data-rights checks;
- temporary rollout flags have an owner and retirement condition.

## Product surface currently represented in this repo

- Reporting-cycle overview and fund-period status
- Source document library with ingestion/extraction/review state
- Large-file upload UI
- Document processing / lineage view
- Trusted observation review with source evidence
- CSV export surface
- Ask Corvis research workspace UI

The customer UI must consume serving/application contracts, not raw extraction JSON or unrestricted physical Snowflake tables.

## Code architecture: linked, not married

Each capability owns one concern and depends on contracts rather than another module's implementation.

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

This describes the existing frontend adapter, not the production cloud architecture. The production standard is native GCS resumable upload behind the stable application port. The production upload path must bypass Cloudflare and API body proxying for ordinary large source files. Provider-specific concepts such as multipart ETags must not become domain contracts.

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

Open GitHub epics track repository work for identity, ingestion, orchestration, Snowflake/control plane, review, Ask Corvis, secure SDLC/edge security, SRE/cost telemetry, admin/lifecycle/feature flags, APIs, product quality, GCP/Cloudflare/Snowflake IaC and control-evidence automation. Each epic links back to the relevant Confluence source of truth.
