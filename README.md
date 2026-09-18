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

The exact physical layout may be introduced incrementally from the current frontend-oriented structure, but these ownership boundaries are required. Production application or infrastructure code must not be maintained in an untracked external deployment project.

## Production deployment target

GCP is the primary application/infrastructure cloud, Snowflake runs on GCP, and Cloudflare is used selectively as the public edge:

- Cloudflare → DNS, TLS edge, DDoS protection, WAF, rate limiting, safe CDN caching and routing/origin protection
- `apps/customer-web` → Cloud Run behind Cloudflare
- `apps/admin-web` → separate Cloud Run service behind Cloudflare with stricter controls
- `services/api` → Cloud Run behind Cloudflare for public ingress
- `services/workers` → Cloud Run services and/or Cloud Run Jobs; internal paths do not traverse Cloudflare
- immutable source and replay artifacts → Google Cloud Storage
- events/tasks → Pub/Sub / Cloud Tasks
- secrets → Secret Manager
- encryption keys → Cloud KMS
- images → Artifact Registry
- infrastructure → Terraform under `infra/terraform`, including GCP, Cloudflare and supported Snowflake configuration
- governed structured data → Snowflake on GCP

Cloudflare is intentionally **not** a second stateful application platform. R2, KV, D1, Durable Objects and Cloudflare Queues are excluded by default because they would duplicate GCS, Snowflake, Pub/Sub/Cloud Tasks or backend state. Introduce them only through an approved architecture decision with a quantified reliability/cost advantage.

## Cost posture

The implementation should minimize idle and duplicated infrastructure without weakening reliability or control requirements:

- Cloud Run scales to zero by default where latency/SLOs permit; minimum instances require measured justification.
- Use event-driven Pub/Sub/Cloud Tasks rather than wasteful polling.
- Keep large source-document upload bytes off Cloudflare and API compute: browser → authorized API initiation → direct resumable GCS upload.
- Cache versioned static assets aggressively at Cloudflare, but do not shared-cache authenticated tenant/admin/source-evidence/private-export responses unless isolation is provably safe.
- Keep one authoritative object store (GCS) and one governed structured platform (Snowflake).
- Snowflake workloads should use auto-suspend/right-sizing, workload separation and cost/query attribution.
- Budgets/alerts should surface runaway compute, retries, abandoned uploads and unexpected edge/origin traffic.

Deployment, identity, networking, storage, Cloudflare policy, Snowflake integration and environment requirements are authoritative in Confluence rather than duplicated here.

## Admin application and feature flags

The admin application is a separate production surface from the customer application. Among its controlled operations, it must support governed feature-flag administration.

Feature-flag implementation rules:

- stable feature keys and a shared feature-capability contract;
- authorized admins can view/toggle supported flags globally and by tenant/workspace, with narrower scopes only where explicitly designed;
- backend evaluation is authoritative—UI hiding is not enforcement;
- customer UI, admin UI, API, workers, exports and AI/retrieval paths consume the same effective feature state where applicable;
- production changes are audited with actor, target/scope, old/new state, reason and correlation ID;
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
npm ci
npm run dev
```

Then open `http://localhost:3000`.

Local demo behavior is explicit opt-in:

```bash
CORVIS_DEMO_MODE=true
NEXT_PUBLIC_CORVIS_DEMO_MODE=true
```

Production rejects demo mode and missing required enterprise bindings.

## Application API binding

Set:

```bash
NEXT_PUBLIC_CORVIS_API_BASE=https://api.example.com
NEXT_PUBLIC_CORVIS_DEMO_MODE=false
```

Production must fail closed rather than silently reverting to demo mode when required configuration is missing.

## Production document flow

```text
initiate
  → immutable document/artifact IDs
  → direct object-store upload
  → resumable upload state
  → exact file-signature validation
  → quarantine
  → malware clean disposition
  → DocumentRegistered outbox event
  → interpretation
  → extraction
  → review
  → canonicalization
  → reconciliation
  → consolidation
  → versioned fund-period snapshot
  → semantic / serving layer
```

The stable application upload contract is provider-neutral. The current adapter is S3-compatible; the production target is GCS resumable upload behind the same port. Large source bytes bypass Cloudflare and API body proxying.

Source bytes remain in private versioned object storage. Snowflake is the structured system of record.

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

## Production data and AI rule

Quantitative research is grounded in tenant-scoped serving facts. Narrative evidence comes only from a source corpus filtered by tenant/workspace/document/fund entitlement **before retrieval**. Document text is treated as untrusted data and cannot authorize tools or permissions.

## Verification

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
npm audit --audit-level=high
```

GitHub Actions also runs CodeQL and Terraform validation.

## Activation

Source control cannot prove that an IdP policy, cloud account, Snowflake grant, malware scanner, backup restore or operational control is actually running. Production therefore stays fail-closed until live bindings and evidence are present.

See:

- `docs/ENTERPRISE_IMPLEMENTATION.md`
- `docs/PRODUCTION_ACTIVATION.md`
- `.env.example`
- `db/migrations/`

`GET /api/v1/admin/readiness` is the deployment binding gate; the Confluence Enterprise Control Register remains the operating-evidence authority.

## Current stack

- Next.js 16.3
- React 19.3
- TypeScript
- No component framework dependency

## Implementation tracking

Open GitHub epics track repository work for identity, ingestion, orchestration, Snowflake, review, Ask Corvis, secure SDLC/edge security, SRE/cost telemetry, admin/lifecycle/feature flags, APIs, product quality, GCP/Cloudflare IaC and control-evidence automation. Each epic links back to the relevant Confluence source of truth.
