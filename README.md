# Corvis

Customer-facing workspace for the Corvis private-markets data platform.

## Documentation authority

This repository documents **implemented code, local development and code-level interfaces only**. It is not the source of truth for enterprise architecture, security policy, data semantics, production cloud design or readiness requirements.

Authoritative Confluence documentation:

- Enterprise Production Readiness Master Plan: https://corvis.atlassian.net/wiki/spaces/FUNDATA/pages/1376262
- Core Product — End-to-End Data & Semantic Architecture: https://corvis.atlassian.net/wiki/spaces/FUNDATA/pages/688508
- Platform Architecture & Data Lifecycle: https://corvis.atlassian.net/wiki/spaces/FUNDATA/pages/360450
- GCP Cloud Infrastructure & Deployment Standard: https://corvis.atlassian.net/wiki/spaces/FUNDATA/pages/1507331

GitHub issues track executable implementation work and link to their authoritative Confluence owners. Requirements and architecture should be changed in Confluence first rather than copied into GitHub.

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

```text
core/contracts.ts                    stable domain + port contracts
        │
        ├── application/             use-case orchestration
        │     └── upload-document.ts
        │
        ├── adapters/                replaceable infrastructure / demo bindings
        │     ├── upload/http-multipart-upload.ts
        │     ├── upload/mock-upload.ts
        │     └── demo/catalog.ts
        │
        ├── runtime/services.ts      composition root for adapters
        │
        ├── features/                product capabilities
        │     ├── overview/
        │     ├── documents/
        │     ├── review/
        │     └── research/
        │
        ├── components/ui/           reusable presentation primitives
        └── app/page.tsx             shell + feature composition only
```

Code-level rules:

- Feature modules depend on `core` contracts and application services, not adapter internals.
- Vendor/API details live in adapters.
- `runtime/services.ts` selects adapters; replacing object storage or API transport should not change UI features.
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

By default the frontend uses demo/mock adapters so workflows remain interactive before production services are connected.

## Application API binding

Set:

```bash
NEXT_PUBLIC_CORVIS_API_BASE=https://api.example.com
NEXT_PUBLIC_CORVIS_MOCK_API=false
```

Production must fail closed rather than silently reverting to demo mode when required configuration is missing. The production backend, identity, GCS ingestion, Snowflake serving and other infrastructure contracts are specified in the authoritative Confluence pages above and tracked through linked GitHub issues.

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

Open GitHub epics track repository work for identity, ingestion, orchestration, Snowflake, review, Ask Corvis, secure SDLC, SRE, admin/lifecycle, APIs, product quality, GCP/IaC and control-evidence automation. Each epic links back to the relevant Confluence source of truth.
