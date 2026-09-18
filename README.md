# Corvis

Customer-facing workspace for the Corvis private-markets data platform.

## What is included

- Reporting-cycle overview and fund-period status
- Source document library with ingestion/extraction/review state
- Large-file upload workflow for PDFs, Excel, Word, PowerPoint and CSV
- Direct-to-object-storage multipart upload client (32 MB parts, concurrent uploads, retries and progress)
- Document detail / processing pipeline view
- Trusted observation review surface with source evidence and confidence
- CSV export of customer-facing trusted data
- Research workspace for quantitative questions plus permissioned source evidence
- Responsive desktop/tablet/mobile product shell

The UI intentionally exposes fund-period snapshots, reviewed observations and source evidence rather than raw extraction-agent JSON.

## Run locally

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

By default the frontend uses a demo upload transport so the end-to-end interaction is usable before backend services are connected.

## Production upload API contract

Set `NEXT_PUBLIC_CORVIS_API_BASE` and `NEXT_PUBLIC_CORVIS_MOCK_API=false`.

The browser never needs to proxy large PDF bytes through the Next.js server. Instead:

1. `POST /uploads/initiate`
   - request: `fileName`, `contentType`, `sizeBytes`, `lastModified`
   - response: `uploadId`, `documentId`, `partSize`
2. `POST /uploads/{uploadId}/parts`
   - request: `partNumber`, `contentLength`
   - response: presigned object-storage `url` and optional request `headers`
3. Browser `PUT`s each part directly to object storage and records the returned ETag.
4. `POST /uploads/{uploadId}/complete`
   - request: ordered `parts: [{ partNumber, etag }]`
5. Backend finalizes multipart upload, registers the immutable source artifact, and starts the Corvis document pipeline.

The current client uses 32 MB parts, concurrency of 3, exponential retry and XHR upload progress. These values can be made backend-configurable without changing the UI contract.

## Expected backend lifecycle

After upload completion the backend should expose document state progressing through:

`registered → interpreting → extracting → reviewing → reconciling → consolidated → published`

The frontend is already organized around those product semantics. In production, replace the representative data in `lib/mock-data.ts` with API/query hooks backed by the serving layer.

## Architecture boundaries

- Original files live in immutable object storage.
- Structured trusted data is served from governed Snowflake/serving APIs.
- Search and narrative evidence are permission checked independently from structured fact access.
- Customer interfaces do not query raw extraction JSON.
- Global entity identity must not widen tenant data access.

## Current stack

- Next.js 16.3
- React 19.3
- TypeScript
- No component framework dependency; the visual system is implemented in `app/globals.css` to keep the initial surface lightweight.

## Next implementation steps

1. Wire authentication / tenant session.
2. Implement the upload API and object-storage presigning service.
3. Add document-list and document-status endpoints plus WebSocket or SSE status updates.
4. Connect data review to fund-period snapshot / consolidated-fact serving APIs.
5. Connect source evidence links to a permissioned document renderer.
6. Connect Ask Corvis to semantic-query + document-retrieval endpoints.
7. Add audit telemetry, errors/retry UX and customer-specific feature flags.
