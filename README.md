# Corvis

Customer-facing workspace for the Corvis private-markets data platform.

## Product surface

- Reporting-cycle overview and fund-period status
- Source document library with ingestion/extraction/review state
- Large-file upload for PDF, Excel, Word, PowerPoint and CSV
- Direct-to-object-storage multipart uploads
- Document processing / lineage view
- Trusted observation review with source evidence
- CSV export
- Ask Corvis research workspace with cited evidence

The customer UI exposes fund-period snapshots, trusted observations and entitled source evidence. It never treats raw extraction JSON or physical Snowflake tables as product contracts.

## Architecture: linked, not married

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

Rules:

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

By default the frontend uses the mock upload adapter so the workflow remains interactive before backend services are connected.

## Production upload port

Set:

```bash
NEXT_PUBLIC_CORVIS_API_BASE=https://api.example.com
NEXT_PUBLIC_CORVIS_MOCK_API=false
```

The HTTP multipart adapter implements the current upload protocol:

1. `POST /uploads/initiate`
   - request: `fileName`, `contentType`, `sizeBytes`, `lastModified`
   - response: `uploadId`, `documentId`, `partSize`
2. `POST /uploads/{uploadId}/parts`
   - request: `partNumber`, `contentLength`
   - response: presigned object-storage `url` and optional headers
3. Browser uploads each part directly to object storage and records the ETag.
4. `POST /uploads/{uploadId}/complete`
   - request: ordered `parts: [{ partNumber, etag }]`
5. Backend finalizes the artifact, registers immutable source identity and emits the next pipeline event.

Current defaults are 32 MB parts, concurrency 3 and exponential retry. Those are adapter configuration, not UI semantics.

## Platform lifecycle expected by the UI

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

These are product lifecycle states, not a requirement that one monolithic worker execute every step. Each downstream process can be retried or replaced using durable upstream records and stable identifiers.

## Current stack

- Next.js 16.3
- React 19.3
- TypeScript
- No component framework dependency

## Next backend contracts

1. Authentication and tenant/workspace context.
2. Upload/presigning adapter implementation.
3. Document read-model + processing-event stream (SSE/WebSocket).
4. Fund-period snapshot and consolidated-fact serving APIs.
5. Permissioned evidence-reader/document-renderer endpoint.
6. Semantic-query and retrieval ports for Ask Corvis.
7. Audit telemetry, errors/retries and feature entitlements.

When those services arrive, bind new adapters at the runtime composition root instead of rewriting product features.
