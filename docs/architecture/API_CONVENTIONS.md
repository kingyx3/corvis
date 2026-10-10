# `/api/v1` conventions

Implementation tracker: GitHub issue #11. This documents the conventions
`src/app/api/v1/**` routes actually follow today, backed by `openapi/corvis-v1.yaml`
and `src/platform/http/api/http.ts`/`src/platform/http/api/pagination.ts`.

## Envelope and errors

Every response is `{ data, correlationId }` on success (an action route may
add fields alongside `data`, as `snapshots/publish` does). Two families are deliberately not enveloped: `uploads/initiate` returns the upload session object directly, and `scim/v2/**` follows the SCIM 2.0 wire format. Every route reads
or generates `correlationId` from the `x-correlation-id` request header via
`correlationId(request)` and echoes it back, including on error, so a client
and server log can be correlated even across a failure.

Errors are always `{ error: "<stable_code>", correlationId }` with an
appropriate HTTP status, produced by the single `apiError()` mapper in
`src/platform/http/api/http.ts` rather than by each route improvising its own shape.
The stable error codes today include `authentication_required` (401),
`forbidden` (403), a per-domain conflict/governance code (409 or 422 —
`publication_blocked`, `deletion_blocked_by_legal_hold`, a
`FeatureFlagGovernanceError`/`DeletionExecutionError`/`WebhookSubscriptionError`
code, etc.), `invalid_cursor` (400), `invalid_limit` (400), `invalid_json` (400, malformed request
body), `invalid_idempotency_key` (400), `idempotency_key_reused` (422 from `apiError()` for request-level `Idempotency-Key` reuse; the dead-letter recovery and
candidate-review routes return 409 instead, because there the key names an already-recorded command on a specific resource and
reuse with different content is a state conflict), `rate_limited`
(429 with `Retry-After`), the research-specific timeout/cancel/provider
codes, and `internal_error` (500) as the fallback. `openapi/corvis-v1.yaml`
declares 401, 403, 429 and 500 once as shared components and references them from
every operation, and documents every 4xx body as the `ErrorResponse` schema. Adding a new typed error class
means adding one `instanceof` branch to `apiError()`, not reinventing the
envelope in the route.

## Pagination and collection queries

`src/platform/http/api/pagination.ts` implements opaque cursor pagination:
`GET` collection endpoints accept `?limit=` (1–200, default 50) and
`?cursor=` (an opaque, tamper-checked continuation token from a previous
page's `nextCursor`). A response always includes `nextCursor`, which is
`null` on the last page.

**Backward compatibility rule:** a collection endpoint that predates
pagination keeps returning its full, unpaginated list when the caller
passes neither `limit` nor `cursor` — pagination only activates once a
caller explicitly asks for it (`paginationRequested()`). This matters
because production callers like `src/modules/workspace/adapters/http-workspace.ts`
already call `/documents`, `/observations` and `/snapshots` with no query
parameters and expect the complete list back; changing that default would
have silently truncated their data. New endpoints without an existing
unpaginated caller make pagination the only mode instead of adding this
compatibility branch.

A cursor encodes the sort key of the last item on the page that issued it
(by convention, the resource's own id; `snapshots` uses an id/version key so
multiple versions cannot be skipped at a page boundary). Pagination is
keyset-based and ordered with the same `C` collation used by the cursor key.
Malformed or tampered cursors are rejected with `invalid_cursor` (400), and
non-positive/non-integer `limit` values with `invalid_limit` (400), rather than
silently ignored, clamped without complaint, or crashing.

**Landed on:** `GET /documents`, `GET /observations`, `GET /snapshots` and
`GET /jobs` preserve the unpaginated-by-default compatibility rule above.
`GET /funds`, `GET /companies`, `GET /holdings`, `GET /instruments`,
`GET /company-lifecycle-events`, `GET /metric-definitions`,
`GET /consolidated-facts`, `GET /reconciliations` and
`GET /admin/webhooks/subscriptions/{webhookId}/deliveries` are newer
collections and use pagination as their collection contract. `GET /exports`
uses its separately bounded requester-history contract.

**Chronological collections:** the id-ordered rule above is the default, not
a requirement. `GET /admin/webhooks/subscriptions/{webhookId}/deliveries` is a
diagnostic feed whose useful order is newest first, and its delivery ids are
random v4 UUIDs, so it orders by `(created_at desc, delivery_id desc)` and its
cursor encodes that composite position (a microsecond-precision UTC timestamp
plus the delivery id). It does not go through `paginate()` (which sorts
ascending by one key); the repository applies the row-value keyset predicate in
SQL and returns the page with its `nextCursor`. A cursor that does not decode
to the composite position, including one issued before the ordering changed, is
rejected as `invalid_cursor` (400); cursors are opaque, so clients restart from
the first page rather than reuse them across deployments.

Production Postgres repositories now push the requested page into SQL with
a keyset predicate and `limit + 1` fetch for the document/job/observation/
snapshot lists and the governed serving-resource collections above. This
prevents the former silent-cap failure where rows beyond an in-memory fetch
ceiling could never be reached, and avoids loading an entire entitled
collection for each page. Demo/test adapters may still paginate already
materialized arrays, but that is not the production Postgres path.

The initial-UAT collection contract deliberately does **not** add a generic
filter/sort language. Add a filter or ordering only when UAT or a concrete
customer workflow identifies the exact field, semantics and compatibility
requirement; opaque cursor pagination remains the stable baseline.

## Serving-resource authorization

Global economic identity is not a customer entitlement. `/funds` is bounded
by the authoritative fund entitlement list; an absent fund list fails closed
to no funds. `/companies` is derived from approved observations belonging to
the current tenant on entitled funds. `/company-lifecycle-events` is stricter:
an event is suppressed if any fund or company participant falls outside the
caller-visible entitlement graph, preventing a globally known relationship
from leaking a hidden entity. `/consolidated-facts` returns only facts for the
current tenant and entitled funds that are actually included in a published
fund-period snapshot. `/metric-definitions` exposes the active governed
semantic dictionary, never extraction-provider payloads.

`/holdings` and `/instruments` are backed by the governed persisted economic
model rather than synthesized from optional observation identifier columns.
A holding targets exactly one company or underlying fund; fund targets are
returned only when that target fund is itself entitled. Instruments are
returned beneath approved company-targeted holdings and preserve the source
security description plus normalized instrument attributes and lineage.

## Idempotency

Write operations that a client may need to safely retry take an explicit
`idempotencyKey` field in the request body (see `src/modules/sources/server/uploads/uploads.ts`'s
upload-session `initiate`/`complete` flow), not an `Idempotency-Key` HTTP
header. A repeated call with the same key and tenant returns the original
result rather than creating a duplicate resource or repeating a destructive
action. Upload keys are additionally bound to the caller's subject and
workspace (`uploadIdempotencyKey`); replaying one from another uploader or
workspace is a 409 `upload_idempotency_mismatch`.
`src/modules/governance/server/lifecycle/data-lifecycle.ts`'s deletion execution follows the same
principle for its per-attempt evidence ledger. New mutating endpoints that
can be safely retried should follow this same body-field convention rather
than introducing a second one.

Some newer HTTP action routes also accept an `Idempotency-Key` header for
client ergonomics while normalizing it into the same tenant/subject-scoped
server idempotency contract. A route must not create a second independent
idempotency namespace for header versus body representations of the same key.

## Webhooks

`corvis_control.webhook_subscription` and `corvis_control.webhook_delivery`
(`001_baseline.sql`) hold the durable outbound
delivery ledger: `src/modules/delivery/server/exports/delivery.ts`'s `processWebhookDeliveries` claims
outbox events for each active subscription with an idempotent
`on conflict (tenant_id,webhook_id,event_id,attempt) do nothing` insert,
bounded to 5 attempts, and marks the fifth failure terminal
(`docs/architecture/API_CONVENTIONS.md`'s own idempotency rule applies here too: a
redelivered attempt is a no-op, not a duplicate). Fan-out completion is
tracked on `outbox_event.webhook_fanout_completed_at`; webhook
delivery never reads or writes `published_at`/`attempt_count`/`last_error`,
which belong to the processing transport. A delivery left in `delivering` for
more than 10 minutes (worker crash) is reclaimed as retryable; export jobs are
reclaimed the same way via `export_job.delivery_started_at`.

The launch customer-facing event allowlist is intentionally narrower than the
internal processing event stream. `WEBHOOK_EVENT_TYPES` currently exposes:
`SnapshotPublicationChanged`, `DataCorrectionOpened`, `DataCorrectionResolved`,
`CorrectionReplacementDeliveryRequested`, `ExportRequested`,
`ExportScheduleRunCompleted` and `ExportScheduleRunFailed` (F4b, below). Internal
processing/job signals — including `DocumentRegistered`, stage-ready/retry
transport events, and stage blocked/dead-letter operator state — are not
subscribable and are excluded from delivery even for pre-policy subscription
rows. Expand the customer event vocabulary only through a reviewed external-contract
change; do not expose internal outbox events merely because they exist.

Subscription administration and per-subscription signing-key rotation
(`001_baseline.sql`,
`src/modules/delivery/server/webhooks/webhook-subscriptions.ts`) are exposed under
`/admin/webhooks/subscriptions`, gated by `admin:manage`:

- `POST /admin/webhooks/subscriptions` — create (`endpointUrl` must be
  `https://`, `eventTypes` a non-empty array of customer-facing event types
  from `WEBHOOK_EVENT_TYPES` in `src/modules/delivery/server/webhooks/webhook-endpoint-policy.ts`;
  internal processing-transport signals such as `DocumentRegistered` are
  rejected with `event_type_not_supported`). Endpoints naming `localhost`,
  `*.internal`/metadata hosts or a loopback/private/link-local/reserved IP
  literal are rejected with `endpoint_url_host_not_allowed`; a URL longer than
  2048 characters (as submitted or once normalized) is rejected with
  `endpoint_url_too_long` (400), and a tenant may hold at most 25 non-revoked
  (active or paused) subscriptions — the 26th create is rejected with
  `webhook_subscription_limit_reached` (409) until one is revoked (the cap is
  checked under a per-tenant advisory lock, so racing creates cannot exceed it;
  limits live in `src/modules/delivery/server/webhooks/webhook-subscriptions.ts`). At send time the
  host is re-checked and its DNS answers must all be public, redirects are
  never followed (a 3xx is a failed attempt) and each POST has a 10s timeout.
  The response includes the signing secret exactly once; it is never
  re-readable afterward.
- `GET /admin/webhooks/subscriptions` — list (metadata only, never a secret).
- `PATCH /admin/webhooks/subscriptions/{webhookId}` — `{ "action": "pause" | "resume" | "revoke" }`.
  `revoke` is terminal; `pause`/`resume` are reversible. An invalid transition
  (for example resuming an already-active subscription) is rejected rather
  than silently accepted.
- `POST /admin/webhooks/subscriptions/{webhookId}/rotate-signing-key` —
  retires the current key and activates a freshly generated one atomically,
  so a subscription is never left with zero or two active keys. The new
  secret is returned exactly once, in this response.
- `GET /admin/webhooks/subscriptions/{webhookId}/deliveries` — paginated
  customer-visible delivery diagnostics, newest first (state, attempt, status code, last
  error).

A signing secret is per tenant and per subscription, never shared across
tenants: each outbound delivery is signed with `webhookHeaders()` using the
subscription's own current active key. `webhookHeaders()` signs with the
actual send time, not the business event's own (fixed) `createdAt`, so a
retry sent well after the original event still produces a signature the
receiver's tolerance window accepts.

## Rate limiting

`/api/v1` has both edge-level Cloudflare rate controls and an application
rate-limit boundary. The production request identity path resolves the
current tenant/service-account identity and uses the Postgres-backed atomic
limiter so distinct tenant/subject pairings have independent budgets and a
database outage or malformed rate-limit decision fails closed. A denied
request maps to HTTP 429 with `Retry-After`. The in-memory limiter remains a
bounded test/local primitive, not the production distributed authority.

## Authentication and authorization

Every non-public `/api/v1` route calls `resolveAuthorizedRequestIdentity()`
and `assertPermission()`/`assertRole()` before doing anything else; this
repository-wide contract is enforced by `src/platform/http/security/security-contract.test.ts`,
not by convention alone.

Database lifecycle roles and application permissions are separate layers.
`tenant_admin` and `accountadmin` (a workspace/product administrator; renamed
from the earlier `workspace_admin`) both map to the application `admin` Role
for ordinary permission checks, but they are not interchangeable scopes:
`assertTenantAdminRequestScope()` (`src/modules/identity-access/server/request/authorized-request.ts`) requires
the authoritative, tenant-wide `isTenantAdmin` signal — never just the `admin`
Role — for every `/api/v1/admin/**` route and the tenant-scoped processing
recovery commands (`/jobs/{jobId}/retry`, `/jobs/{jobId}/recover`); granting
the `tenant_admin` role itself carries the same requirement, enforced both in
the route and authoritatively in SQL. Workspace/product
routes such as `/api/v1/source-connections/**` remain available to
`accountadmin`, but are scoped to the caller's own workspace
(`src/modules/sources/server/connectors/source-connector-governance.ts`), never tenant-wide.

## Data retention and full data export (F10)

Implementation tracker: GitHub issue #266. Organization Admins (`tenant_admin`; `accountadmin` is refused with `403 tenant_admin_required`) can read the retention periods and legal holds that apply to their organization, and request a complete export of its data that a **different** Organization Admin must approve. Both live under `/api/v1/access/**` (classified `tenant_control`, not a stable data-integration API) and render on the existing `/access-self-service` page.

| Route | Who | Purpose |
| --- | --- | --- |
| `GET /api/v1/access/retention` | Organization Admin | Read-only: `{ policies, legalHolds, deletionRequests }` (the last is described under "Deletion requests (F10e)" below). A policy is the version in effect now per data class (`retentionLabel` is plain language, `legalHold` follows the rule deletion execution applies); `legalHolds` are the active holds only (matter reference, what they cover, when placed; never who placed them). Nothing here can change a policy or a hold: Corvis operations own both (#10). |
| `GET /api/v1/access/data-exports` | Organization Admin | The organization's export requests, newest first, paged: `?limit=` (1 to 200, default 50) and `?cursor=` (the previous page's `nextCursor`, `null` on the last page; a malformed one is `400 invalid_cursor`, a bad limit `400 invalid_limit`). The order is the stable keyset `(requested_at desc, request_id desc)` and the cursor holds the last row's microsecond timestamp and id, so a request made while paging never shifts or repeats an older page. Each item has its `status`, who asked and decided, the artifact (checksum, size, expiry, manifest) once built, and the `actions` the caller may take now. The access page loads ten at a time and offers "Show older requests". |
| `POST /api/v1/access/data-exports` | Organization Admin | Request a full export. Body `{ reason }` (3 to 1,000 characters): what is exported is fixed, so nothing can widen it. `201` with the pending request. One request is open at a time (`409 data_export_already_active`). |
| `GET /api/v1/access/data-exports/{exportId}` | Organization Admin | One request with its status history. A missing or malformed id is `404 data_export_not_found`. |
| `POST /api/v1/access/data-exports/{exportId}` | Organization Admin | `{ action: "approve" or "reject" or "cancel", note?, expectedStatus? }` decides the request. `approve` and `reject` need an Organization Admin who is **not** the requester (`403 data_export_independent_approver_required`, enforced in SQL, see below); `reject` needs a `note`; only the requester may `cancel`, and only before the build starts. `{ action: "prepare_download" }` returns `{ downloadUrl, downloadExpiresAt }` for a completed export. |
| `GET /api/v1/access/data-exports/{exportId}/download?grant=` | Organization Admin | Redeems a link and streams the archive (`application/zip`, `x-corvis-checksum-sha256`). The link is single-use, bound to the admin it was issued to, valid for ten minutes at most and never beyond the artifact's expiry. `HEAD` is `405` so a probe cannot consume it. A used, expired or foreign link is `404 not_found`. |

**Deletion requests.** The retention view also lists the deletion requests that affect the caller's tenant, newest first (at most 100), and an Organization Admin may ask for a deletion of their own. Both ride on the operator deletion lifecycle (#10, `src/modules/governance/server/lifecycle/data-lifecycle.ts`, the schema), which they do not change.

| Route | Who | Purpose |
| --- | --- | --- |
| `GET /api/v1/access/retention` | Organization Admin | `deletionRequests`: per request `requestId`, `origin` (`customer`, or `corvis` for one Corvis operations made), `status`, `dataClasses`, `scopeLabel` (plain language, e.g. "3 documents within source documents"), `requestedAt`, `decidedAt`, `executedAt`, `legalHoldBlocks` (a legal hold on the data stops it from being carried out, never true for one that has ended), the `actions` the caller may take, and for an Organization Admin's own request also `reason`, `requestedBy`, `requestedByMe`, `approvalExpiresAt`, `decidedBy` and `decisionNote`. For a request Corvis operations made those last fields are always `null`: the operator who made or ran it, an internal reason or note, the last error and the evidence of each attempt are never selected (the SQL returns `NULL` for them and the mapping ignores them again) and other tenants' requests are never read. |
| `POST /api/v1/access/deletion-requests` | Organization Admin | Ask for deletion of whole data classes. Body `{ dataClasses: string[], reason }`: 1 to 20 distinct data classes the organization has a retention policy in effect for (`400 invalid_data_classes` otherwise; never a document, fund or person: narrower scopes stay with operations) and why (3 to 1,000 characters, `400 invalid_reason`). `201` with the pending request. `409 deletion_blocked_by_legal_hold` while a legal hold covers any of the data, `409 deletion_request_already_pending` while another request waits for approval. |
| `POST /api/v1/access/deletion-requests/{requestId}` | Organization Admin | `{ action: "approve" or "reject" or "cancel", note?, expectedStatus?: "pending_approval" }`. `approve` and `reject` need an Organization Admin who is **not** the requester (`403 deletion_independent_approver_required`, enforced in SQL); `reject` needs a `note`; only the requester may `cancel`, and only before anyone approves; `approve` is refused while a legal hold covers the data (`409 deletion_blocked_by_legal_hold`) and after the window (`409 deletion_approval_expired`). A request Corvis operations made, an unknown id and a malformed id are all `404 deletion_request_not_found`. Approving deletes nothing: it hands the request to Corvis operations. |

**Status and lifecycle.** `status` is one of `pending_approval`, `requested`, `approved`, `in_progress`, `retrying`, `blocked`, `completed`, `rejected`, `cancelled` or `expired`, read from the stored `deletion_request.state` (`pending_customer_approval`, `requested`, `approved`, `executing`, `retryable`, `blocked`, `completed`, `rejected`, `cancelled`, `expired`; a state this code does not know is shown as `in_progress`). A customer request is `pending_approval` until a different Organization Admin approves it (then `approved`: the operator flow executes it from there, still blocked by a missing retention policy or an active legal hold, and still needing an executor who is not the requester) or rejects it, the requester withdraws it (`cancelled`), or nobody approves within 168 hours (`expired`; the next request lapses it and writes `deletion_request.customer_expired`). One customer request may be pending per tenant. A request Corvis operations made is `requested`, then `in_progress`, `completed` (or `blocked` / `retrying`).

**Operators cannot run it first, and nobody can skip the second admin.** A customer request is a `deletion_request` row with `origin = 'customer'` that starts in `pending_customer_approval`, a state the operator flow does not execute from (`EXECUTABLE_DELETION_STATES`: requested, approved, retryable, blocked). The table's own CHECK constraints refuse a customer row in any other live state (approved, executing, completed, ...) without a decision by a *different* admin (`customer_decided_by_subject <> requested_by` and `customer_decided_by_user_id <> requested_by_user_id`), a guard trigger keeps its content and decision immutable and allows only the transitions above, and `corvis_control.decide_customer_deletion` / `request_customer_deletion` require an active human Organization Admin (`tenant_export_admin_user`, the same test as the full export). A second identity (for example SAML) of the requester counts as the requester. Legal holds use the same rule as deletion execution (`corvis_control.deletion_scope_legal_hold`: a hold on the class, a retention-policy `legal_hold` flag, or a tenant-wide hold).

**Audit and notice.** Every human step is audited in the transaction that makes it (`deletion_request.customer_requested`, `.customer_approved`, `.customer_rejected`, `.customer_cancelled`, target type `deletion_request`, metadata `status`, `dataClasses` and the reason or note); a lapsed request writes `deletion_request.customer_expired` itself (actor `system:customer-deletion`). A request tells every *other* active human Organization Admin by email (mandatory `deletion_request_approval`, words only, see `NOTIFICATIONS.md`); the retention section also lists it for them to approve. There is deliberately no outcome email: the requester sees the decision in the list. What is not built: customers cannot withdraw an approved request (Corvis operations can), and a customer cannot name specific documents, funds or people.

**Lifecycle.** `pending_approval` then `approved`, `building`, `complete` (or `failed`); or `rejected`, `cancelled` or `expired` (nobody approved within 168 hours). A complete export whose artifact lifetime has passed is reported as `download_expired`. The build runs in the governed delivery worker tick (`/api/internal/delivery`, task `tenantExports`), claims one request at a time with a lease and retries with the same capped backoff as the per-user export queue, starting over from the first page each time. There is no row cap: data sets are written in parts (see below), and a build streams to the object store instead of holding the archive. The one permanent failure is a source file whose stored bytes do not match the size or SHA-256 recorded when it was uploaded and scanned (retrying cannot help). The artifact is stored under the shared `exports/` prefix, so it has the same object lifecycle, and lives for `CORVIS_EXPORT_ARTIFACT_TTL_SECONDS`.

**Size estimate and progress (F10c).** While a request is `building` the item carries `progress`: `{ phase, estimatedBytes, bytesWritten, estimatedRows, rowsWritten, estimatedDocuments, documentsWritten, percent, updatedAt }`, `phase` one of `estimating`, `data`, `documents`, `finalizing`. The estimate is taken before anything is written (data rows at 256 bytes a row, plus the exact total of the source files that will be copied) and `percent` is the bytes written against it, capped at 99 until the request is `complete`. It is `null` for every other status (what an earlier attempt left behind is never shown as current) and before the worker has reported. The access page shows it as a progress bar with the estimated size and polls every three seconds while a request is approved or building. The worker reports about every 15 seconds through `record_tenant_export_build_progress`, which also extends the ten-minute build lease: a build that keeps writing is never reclaimed from under itself however long it runs, and one that stops reporting is reclaimed and retried as before.

**Notices (F10d).** A request tells every *other* active Organization Admin by email (mandatory `tenant_export_approval`), and the requester is told when it is approved, rejected, ready or failed (optional `tenant_export_outcome`); the access page also shows a notice at the top while a colleague's request waits for the viewer. Words only, never the reason or the note. See `NOTIFICATIONS.md`.

**Hygiene (F10f).** The delivery tick's `tenantExportSweep` task deletes the stored archive of every export whose artifact lifetime has passed (after the object store confirms the deletion it stamps `artifact_deleted_at`, appends an `artifact_deleted` history row and writes `data_export.artifact_deleted`, and removes the export's download grants) and deletes download grants a day past their expiry (`data_export.grants_swept`, one audit event per request with the count). An object that cannot be deleted stays on record and is retried next tick, and the tick answers 500 for it. A swept export reads as `download_expired`, as it already did once its lifetime passed.

**Operator view of failed builds (F10f).** The customer only sees "could not be built"; the stored cause is for Corvis operations: `GET /api/v1/admin/tenant-export-builds` (`?status=failed|retrying`, `?limit=`, `?cursor=`; `/admin/tenant-export-builds` renders it, linked from the Admin Console). It is for the operations organization's admins only (`CORVIS_OPERATIONS_TENANT_ID`, like `/admin/tenant-health`; any other tenant, including its Organization Admins, is `403 operations_admin_required`, and so is a deployment with none configured) and lists, newest change first across tenants, builds that gave up (`failed`) or whose last attempt failed and will be retried (`retrying`), each with `tenantId`, `tenantName`, `requestId`, `attempts`, `lastError` (already redacted when stored), `requestedAt`, `changedAt` and `nextAttemptAt`. It never includes the requester, the stated reason, the approver, the manifest or any data, so operations see no more than tenant health already shows plus the build's own diagnostics.

**Four eyes.** `corvis_control.decide_tenant_export` refuses an approver whose identity subject or user is the requester, and requires both to hold an active `tenant_admin` membership; the table's own CHECK constraints refuse any row that records a requester as approver, so no code path can bypass it. A second identity (for example SAML) of the same person counts as the requester. A request needs approval inside its window (`409 data_export_approval_expired`).

**Contents and contractual data rights.** The archive (a stored zip, written as a stream; ZIP64 only where an entry or the archive passes 4 GiB or holds 65,535 or more entries) holds, in this order, `README.txt`, `published-data/observations-0001.csv` (`-0002`, ...), `access-audit/access-audit-0001.csv` (...), `source-documents/inventory-0001.csv` (...), `source-documents/files/{documentId}/{name}` for each source document file, and `manifest.json` **last**, because it lists every other file with its size, row count and SHA-256 as measured while the file was written. Each data set is split into numbered CSV parts of at most 100,000 rows, each starting with the same header row, read with keyset pages of 5,000 rows (observations by `observation_id`, the audit trail by `(occurred_at, audit_event_id)`, the inventory by `document_id`), so a tenant of any size is exported completely across as many parts as it needs and every part is listed in the manifest (`dataset` names which data set a file belongs to; a source file also has its `documentId`). The archive's own SHA-256 is recorded and sent with the download, and the manifest reports how many funds, documents and source files were left out and what the export does not include. The copy of the manifest the API returns leaves out the individual source document files (there can be many thousands; they are all in `manifest.json` inside the archive) and says how many there are: `fileCount`, and `sourceFiles: { included, excluded, totalBytes }`. Only funds and documents for which `corvis_control.tenant_export_rights` returns them are exported: every effective `data_rights` row for the resource must be client-visible **and** redistribution-allowed, a resource with no effective row is excluded, and the organization must also hold a workspace-level redistribution right (the same gate `assertRedistributionAllowed` applies to every other export). The data rights are checked again when a link is issued and redeemed (`409 data_export_rights_changed`), because an archive outlives the terms it was built under. **Source document files (F10b).** A document's file is copied into the archive only when the document is exportable as above **and** `tenant_export_rights` reports `source_document_access_allowed` for it (every effective right for the document grants source-file access), and a released, clean file is on record (`malware_scan_status = 'clean'`, `quarantine_status = 'released'`, a pinned storage generation, an object under the tenant's own `tenant=.../document=.../` prefix). Rights are read again inside every page of documents, so a right withdrawn during a long build is honoured for the files not yet written. The bytes are copied object by object from the object store into the archive as they are read; their SHA-256 and size are measured on the way and must equal what was recorded at upload, or the build fails permanently instead of delivering a file that does not match. A document the organization may redistribute whose file is not in the archive (no source-file access, no released file, or the stored object has gone) stays in the inventory, and is reported only as a count (`sourceFiles.excluded`, and a `notIncluded` entry): never named, never listed. The access check is repeated when a link is issued and when it is redeemed: `tenant_export_scope_changed` compares the funds, documents and source files recorded in the archive's internal scope with the rights as they are now, in SQL, so withdrawing redistribution **or** source-file access after the build blocks the download (`409 data_export_rights_changed`) and the list of what the archive holds never leaves the database.

**Memory.** The archive is never held in memory and no transaction is held open across a build: every query is its own statement, the zip is written as a stream (`src/modules/delivery/server/tenant-export/zip-stream.ts`) and uploaded with a resumable GCS write (`putObjectStream`, one 8 MiB chunk in flight; a failed build cancels the upload session), so what a build holds is a page of rows, a stream chunk and a few hundred bytes of manifest entry per file, whatever the tenant's size (#231). Time is the remaining bound: a build runs inside one delivery request (the private worker's 600-second request timeout, which is also the length of the build lease), so an archive too large to copy in that time is cut off, reclaimed and retried until its attempts run out; the progress report is what shows how far an attempt got. Splitting a build across ticks would need a checkpoint per part and is not part of this release.

**Audit.** Every step writes an `audit_event` (target `tenant_export_request`): the application writes `data_export.requested`, `.approved`, `.rejected`, `.cancelled`, `.link_issued` and `.download_started` in the same transaction as the change (identifiers, status and the stated reason or note; never data), and the SQL functions write the system steps (`data_export.expired`, `.build_started`, `.build_completed`, `.build_failed`, `.build_retry_scheduled`, and from the schema `.artifact_deleted` and `.grants_swept`) in the transaction that makes them. All appear in the tenant access audit listing, its CSV, and the export's own `access-audit.csv`. The per-request history (`GET .../{exportId}`) is append-only in `corvis_control.tenant_export_request_event`.

**Errors** follow the usual `{ error, correlationId }` shape: `invalid_request`, `invalid_reason`, `invalid_action`, `invalid_status`, `invalid_note`, `invalid_cursor`, `invalid_limit`, `operations_admin_required` (403, the operator build view only), `tenant_admin_required` (403), `data_export_independent_approver_required` (403), `data_export_cancel_requester_only` (403), `data_export_not_found` (404), and 409s `data_export_already_active`, `data_export_approval_expired`, `data_export_status_changed`, `data_export_transition_not_allowed`, `data_export_not_available`, `data_export_rights_changed`. The SQL refusals behind them are allow-listed in `src/platform/database/sql-application-errors.ts`.

## Sign-in and session policy (F7)

Organization Admin only (`tenant_admin`; `admin:manage` alone is not enough), classified `tenant_control` with the rest of `/api/v1/access/*`. Every denial is the standard `403`; nothing about the policy is readable or changeable by another role. Corvis does not run the sign-in (users authenticate at the identity provider and Corvis verifies the token), so what is governed here is the Corvis *session*: the identity provider's session id (`sid`, or `jti`).

| Route | Who | Purpose |
| --- | --- | --- |
| `GET /api/v1/access/session-policy` | Organization Admin | Read-only view: `{ policy, bounds, identityProvider, scim, signInMethods, members }`. `policy` is `{ idleTimeoutMinutes, maxSessionMinutes, requireSso, version, updatedAt, updatedBy }` (`null` limit: none set; `version: 0`: never set). `bounds` are the Corvis limits a value must stay within. `identityProvider` is the configured issuer (read-only: initial setup is Corvis-assisted, #78), with `idpEnforcesMfa` (what Corvis support recorded: `true`, `false` or `null` = not reported) and `endSessionEndpoint` (or `null`). `currentSession` is `{ mfaUsed, authContext }` from the caller's own verified token (`mfaUsed`: `true` more than one factor reported in `amr`, `false` an `amr` without a second factor, `null` no `amr`; `authContext` the `acr` claim or `null`). Each member also carries `sessionsWithMfa`. `scim` is whether SCIM provisioning is set up and enabled, its default workspace and role and the number of active SCIM users; the bearer token is never returned. `signInMethods` counts active users per sign-in method. `members` lists each active person with `activeSessions` (seen within the idle limit, or a day when none is set, inside the maximum length and not signed out). |
| `PUT /api/v1/access/session-policy` | Organization Admin | `{ idleTimeoutMinutes, maxSessionMinutes, requireSso?, expectedVersion, reason }`. `requireSso` (F7a, #334) is a boolean, or left out to keep the stored value (anything else is `400 invalid_require_sso`); turning it on needs a recorded active OIDC provider with token binding (`409 sso_requires_token_binding`) and a session that would itself be accepted (`409 sso_would_lock_out_current_session`); turning it off is always allowed. Both limits are always stated: a whole number of minutes within the bounds, or `null` for no limit. The idle timeout may not exceed the maximum session length. `expectedVersion` is the `version` the change is based on (compare-and-set: `409 session_policy_version_conflict`); `reason` is 3 to 1,000 characters. `200` with the saved policy. Setting the values already in force changes nothing (same version, no audit event, no notice). |
| `POST /api/v1/access/session-policy/sign-out` | Organization Admin | "Sign out everywhere". `{ userId, reason }` revokes every session Corvis has seen for that person (all of their identities), effective on their next request. `200` with `{ userId, label, revokedSessions, idpEndSessionEndpoint }`; `idpEndSessionEndpoint` is the identity provider's end-session endpoint when Corvis support recorded one (F7c, #336) and is otherwise `null`: when present, the person's session at the identity provider has NOT been ended (Corvis never calls it) and must be ended there. The person keeps their access and can sign in again; a new sign-in is a new session. You cannot sign yourself out (`409 cannot_sign_out_current_user`). |

**Bounds (Corvis-defined).** Idle timeout 15 to 480 minutes; maximum session length 60 to 10,080 minutes (7 days). A value outside them is `400 invalid_idle_timeout` or `invalid_max_session` (`idle_exceeds_max_session` when the idle timeout is longer than the maximum length); the same bounds are `CHECK` constraints on `corvis_control.tenant_session_policy` and are re-checked in `set_tenant_session_policy` (`400 session_policy_out_of_bounds`), so no code path can store a value outside them.

**Enforcement.** Both limits are applied in SQL by `corvis_control.enforce_session_policy`, which `PostgresMembershipAuthorizationRepository.resolve` calls on every authoritative request after membership resolves (so only authorized sessions are recorded). A session past a limit is refused with the same `401` as a revoked session and stays refused (it is never refreshed); the denial is logged as `auth.session_policy_denied` with the reason (`idle_timeout`, `max_session`, `untracked_session`). A session whose id is not stable (the verifier's `token-<hash>` fallback, used when the identity provider sends neither `sid` nor `jti`) cannot be measured, so it is refused while any limit is set. Service identities are not subject to the policy. Background re-authorization of work a person already started (a queued export, an export schedule) passes `applySessionPolicy: false`: it neither ends nor extends the person's session, but it still honours sign-out-everywhere.

**Observability and housekeeping.** Every enforcement emits the `auth.session_policy` duration metric (latency, tagged `outcome` with the verdict, so its count is the denominator of the denial rate) and every denial the `auth.session_policy_denied` count metric tagged `reason` (`idle_timeout`, `max_session`, `untracked_session` or `unknown` for a missing or unexpected answer, which fails closed), beside the readable `auth.session_policy_denied` warning; none carries a subject or a session id. Terraform turns them into log-based metrics and two alerts (p95 above 100 ms for 15 minutes; more than 200 denials per 5 minutes for 10), documented in `tenant-self-service.md`. `tenant_session_activity` is purged by the `sessionActivitySweep` task of the private delivery tick (`corvis_control.purge_tenant_session_activity`): only records not seen for 90 days, never with a retention shorter than the longest maximum session plus a day (the SQL function refuses it), at most 5,000 per tick, and never anything in `session_revocation`. It writes no audit event and logs the count (`session_activity.purged`).

**Audit.** `access.session_policy.updated` (target `session_policy`, with the previous and new limits and `requireSso`, the version and the reason), `access.session.signed_out_everywhere` (target `user_sessions`, the person's id, how many sessions ended, `idpSessionEndRequired` / `idpEndSessionEndpoint` and the reason) and `access.session.idp_logout` (target `user_sessions`, written by the back-channel logout receiver: counts and issuer only, never the person, session or token) are written in the same transaction as the change and appear in the tenant access audit and the access-audit file of a full export. Every Organization Admin is sent the mandatory `security_policy` notice (see `NOTIFICATIONS.md`).

**Refusals** (stable codes): `tenant_admin_required` (403, also enforced in SQL), `invalid_request`, `invalid_version`, `invalid_reason`, `invalid_user`, `invalid_idle_timeout`, `invalid_max_session`, `idle_exceeds_max_session`, `session_policy_out_of_bounds` (400); `member_not_found` (404); `session_policy_version_conflict`, `session_not_measurable`, `cannot_sign_out_current_user`, `sso_requires_token_binding`, `sso_would_lock_out_current_session` (409), `invalid_require_sso` (400). `session_not_measurable` is the lock-out safeguard: a limit cannot be saved from a session whose id is not stable (the caller's identity provider sends neither `sid` nor `jti`), because every such session would then be refused, the saving admin's included. Clearing both limits is always allowed.

### Verified email domains and identity-provider records (F7b #335, F7e #338)

`GET|POST /api/v1/admin/tenant-identity` is the Corvis-operator surface (classified `tenant_control`, `admin/**`: `tenant_admin` plus `admin:manage`, and the configured operations tenant, otherwise `403 forbidden`). Initial identity-provider and domain setup stays Corvis-assisted (#78); an Organization Admin only reads the result in `GET /api/v1/access/session-policy` (`identityProvider: { protocol, issuer, audience, source: "tenant"|"global", status, tokenBindingEnforced }` and `verifiedDomains: [{ domain, verificationMethod, verifiedAt }]`).

| Method | Body | Purpose |
| --- | --- | --- |
| `GET ?tenantId=` | - | `{ identityProvider, verifiedDomains }` of the named tenant. |
| `POST` | `{ kind: "verified_domain_add", tenantId, domain, verificationMethod: "dns_txt"\|"operator_attested", evidence, reason }` | Verifies a domain for the tenant. One tenant per domain; at most 20. |
| `POST` | `{ kind: "verified_domain_remove", tenantId, domain, reason }` | Removes it. Nobody is locked out: the domain check applies only to NEW invitations and SCIM users. |
| `POST` | `{ kind: "identity_provider_set", tenantId, protocol, issuer, audience, status, enforceTokenBinding, idpEnforcesMfa, endSessionEndpoint, expectedVersion, reason }` | Sets the record (`expectedVersion` 0 for the first). `enforceTokenBinding` defaults to nothing: it must be stated, and is accepted only for an active OIDC record. `idpEnforcesMfa` (F7a) is `true`, `false` or `null` (not reported) and `endSessionEndpoint` (F7c) an https URL (no credentials or fragment, OIDC only) or `null`; both must be stated, so a command never silently keeps or clears them (`invalid_idp_mfa`, `invalid_end_session_endpoint`, 400). While the organization's Require SSO is on, a change that turns binding off, disables the record or makes it SAML is refused: `409 sso_required_by_policy`. |

Responses are `{ data: { kind, tenantId, changed, version }, correlationId }`; setting what is already stored changes and audits nothing. **Audit** (in the customer's tenant access audit, written in SQL in the same transaction): `access.verified_domain.added|removed` and `access.identity_provider.configured` (previous and new values, the reason, the operator's tenant). **Errors**: 400 `invalid_request`, `invalid_kind`, `invalid_tenant`, `invalid_domain`, `invalid_verification_method`, `invalid_evidence`, `invalid_protocol`, `invalid_issuer`, `invalid_audience`, `invalid_status`, `invalid_binding`, `invalid_version`, `invalid_reason`; 403 `operations_admin_required`; 404 `tenant_not_found`, `verified_domain_not_found`; 409 `verified_domain_taken`, `verified_domain_limit_reached`, `identity_provider_version_conflict`.

**Domain check.** While a tenant has at least one verified domain, `POST /api/v1/access/invitations` (and bulk and the operator invitation routes) refuse an address outside them with `422 email_domain_not_verified`, and SCIM user creation with `400 invalidValue`; with none the check is off. **Token binding.** Off by default; when an operator enables it, an OIDC request whose verified token issuer/audience differ from the active record (or carries none) is refused with the generic `401 authentication_required`. See `tenant-self-service.md` for what this does and does not guarantee.

**Back-channel logout (F7c #336).** `POST /api/v1/auth/oidc/backchannel-logout` (`identity_control`, OpenID Connect Back-Channel Logout 1.0; called by the identity provider with `Content-Type: application/x-www-form-urlencoded` and a `logout_token` field, no Corvis credential; not part of `openapi/corvis-v1.yaml`). The signed token is the only authentication: RS256 signature, an issuer Corvis trusts (the shared provider or a tenant's active recorded OIDC provider) and an audience recorded for it, a fresh `iat` (at most 5.5 minutes old), unexpired `exp`, the `http://schemas.openid.net/event/backchannel-logout` event, no `nonce`, a `sub` and/or `sid`, and a single-use `jti`. It revokes the matching sessions through `session_revocation`, effective on their next request. `200` with an empty body for a valid token (whether or not it matched anyone), `400 { error: "invalid_request" }` for everything else without saying why, `429` (with `Retry-After`) when rate limited, `503` (with `Retry-After`) when the issuer's keys could not be fetched. Every response is `Cache-Control: no-store`. Replays are refused.

**Session ended by policy (F7c #336).** Any authenticated route answers `401 { error: "session_ended_by_policy" }` (instead of `authentication_required`) when the organization's idle timeout or maximum session length ended the session. It is returned only after the token verified and the person's membership resolved; revoked, unknown, foreign and unmeasurable sessions keep `authentication_required`.

## Service accounts (F6)

Implementation tracker: GitHub issue #262; design, assumptions and the open decision are in [`SERVICE_ACCOUNTS.md`](../features/SERVICE_ACCOUNTS.md). Organization Admins (`tenant_admin`, held by a person; `accountadmin` and any service account are refused with `403 tenant_admin_required`) manage non-human identities under `/api/v1/access/service-accounts` (classified `tenant_control`, not a stable data-integration API). A service account is a normal identity subject with one role in one workspace under the existing RBAC, entitlement and data-rights model: there is no separate API-scope plane.

| Route | Who | Purpose |
| --- | --- | --- |
| `GET /api/v1/access/service-accounts` | Organization Admin | `{ serviceAccounts, workspaces, owners, grantable }`: the organization's accounts, newest first, each with `name`, `purpose`, `roleName`, `workspaceId`/`workspaceName`, `createdBy`, `createdAt`, `expiresAt`, `status` (`active`, `expired`, `disabled`), `lastUsedAt`, `credentialExpiresAt`, `expiringSoon` (the credential in use, or the account, expires within 14 days), `userId` (the identity reference), the `entitlements` it can read now (`resourceType`, `resourceId`, `label`, `permission`, `grantedAt`, `withinDataRights`) and `entitlementAccess` (`canGrant`, `canRevoke`), the newest ten `credentials` (never a secret or hash), the `ownerSubject`, `ownerAssignedAt`, `ownerActive` and `needsOwner` (an account whose owner was deactivated or demoted keeps working but needs a new owner) and the `actions` the caller may take now (`canIssue`, `canRotate`, `canRevoke`, `canDisable`, `canExtend`, `canTransfer`); the active workspaces an account can be created in; the funds and documents an admin may `grant` (the organization's own that hold an effective client-visible data right, at most 500); and the `owners` it can be handed to (active Organization Admins). |
| `POST /api/v1/access/service-accounts` | Organization Admin | `{ name, purpose, workspaceId, roleName, expiresInDays?, credentialExpiresInDays? }` creates an account and its first credential. `roleName` is `reviewer`, `analyst` or `viewer`; an administrator role is never accepted. `201` with `{ serviceAccount, credential: { credentialId, secret, expiresAt } }`: **`secret` is the API credential, returned once and never retrievable again**; only its SHA-256 is stored. Responses carry `Cache-Control: no-store`. |
| `GET /api/v1/access/service-accounts/{serviceAccountId}` | Organization Admin | One account. A missing, malformed or other-tenant id is `404 service_account_not_found`. |
| `POST /api/v1/access/service-accounts/{serviceAccountId}` | Organization Admin | `{ action }`: `issue` (a credential for an account with none in use), `rotate` (`overlapMinutes` 0 to 1,440, default 60: the old credential keeps working for the overlap, then not at all), `revoke` (`reason`: every credential in use stops working immediately), `disable` (`reason`: deactivates the account everywhere: identity, lifecycle grant, memberships, entitlements and credentials; final). `extend` (`expiresInDays` 1 to 365, default 365, from now: moves the account's expiry, its membership and its 009 lifecycle review date together; at least a day later than the current expiry, so `400 invalid_expiry` otherwise; `409 service_account_needs_owner` for an account whose owner is no longer an active admin; `409 service_account_not_active` for a deactivated one), `grant_entitlement` and `revoke_entitlement` (`resourceType` `fund` or `document`, `resourceId`, `reason` 3 to 1,000 characters: give the account read access to one fund or document, or end everything it holds on it; see below), `transfer` (`ownerSubject`: hands the account to another active Organization Admin; `422 service_account_owner_invalid`, `409 service_account_owner_unchanged`). `issue` and `rotate` return `{ serviceAccount, credential }` with the one-time `secret`; `revoke`, `disable`, `extend` and `transfer` return `{ serviceAccount }`; `extend` and `transfer` are audited as `service_account.extended` and `service_account.owner_transferred`. |

**Authorization is enforced in SQL as well as at the route**: each `corvis_control.*_service_account*` function requires an active human identity holding an active `tenant_admin` membership in the tenant, and the schema refuses any role but `reviewer`, `analyst`, `viewer`.

**Data access.** An Organization Admin scopes an account's data access without a Corvis operator. `grant_entitlement` writes a `read` row in `resource_entitlement` in the account's own workspace (the request names only the resource: never a user, workspace or permission) and is refused unless the organization **owns the fund or document and holds an effective, client-visible data right for it**: `422 entitlement_outside_data_rights`, one code for every such case (another tenant's resource, no right, a hidden, lapsed or conflicting right, an unknown id), so a caller cannot probe what other organizations hold. `409 service_account_entitlement_exists` for what the account already reads, `409 service_account_entitlement_limit_reached` at 200, `409 service_account_not_active` for a deactivated or expired account, `400 invalid_resource_type` (only `fund` and `document`; never a workspace) and `400 invalid_resource`. `revoke_entitlement` ends every entitlement the account holds on that resource at once and is never refused for a data-right reason; `404 service_account_entitlement_not_found` when there is nothing to end. People's entitlements are not covered, and the operator path (`POST /api/v1/admin/access-policy`) is unchanged. A grant is resolved by the existing authorization lookup exactly like a person's, so it ends with the organization's right.

**Using a credential (#340, #350).** `POST /api/v1/auth/service-account/token` (`identity_control`) takes the credential as `Authorization: Bearer corvis_sa_…` and returns `{ data: { accessToken, tokenType: "Corvis-Identity-Assertion", expiresIn } }`: a five-minute signed identity assertion that carries only identity selectors. The caller sends it on each API call as `x-corvis-identity-assertion`; role, entitlements and data rights are re-resolved from Postgres on every request, so a revoked, expired or rotated-out credential (after its overlap) is refused at the next exchange and a disabled account at the next call. A successful exchange records "last used" (at most once a minute per credential).

**Audit.** `service_account.created`, `.credential_issued`, `.credential_rotated`, `.credential_revoked`, `.disabled`, `.extended`, `.owner_transferred`, `.entitlement_granted` and `.entitlement_revoked` (target `service_account`) are written in the same transaction as the change and appear in the tenant access audit and a full export's access-audit file; they carry identifiers, role, expiry, overlap and the stated reason, never a secret.

**Errors** follow the usual `{ error, correlationId }` shape: 400 `invalid_request`, `invalid_name`, `invalid_purpose`, `invalid_role`, `invalid_workspace`, `invalid_expiry`, `invalid_overlap`, `invalid_reason`, `invalid_action`, `invalid_resource_type`, `invalid_resource`; 403 `tenant_admin_required`; 404 `service_account_not_found`, `workspace_not_found`, `service_account_entitlement_not_found`; 422 `entitlement_outside_data_rights`; 409 `service_account_name_in_use`, `service_account_limit_reached` (100 active), `service_account_not_active`, `service_account_credential_exists`, `service_account_no_active_credential`.

## Data issues (F5)

Implementation tracker: GitHub issue #261. A customer who doubts a **published** figure reports it with the figure, its scope and a comment; the report becomes a tenant-scoped case routed to Data Operations. Reporting records a claim only: it never changes observations, snapshots or publication, which remain the business of the governed correction flow (`/admin/data-corrections`, the schema). The routes are product surfaces, classified `workspace_control` in `openapi/v1-route-classification.json` rather than part of the stable integration contract in `openapi/corvis-v1.yaml` (the Data Operations routes fall under `/admin/**`).

| Route | Who | Purpose |
| --- | --- | --- |
| `POST /api/v1/data-issues` | `observations:read`, entitled to the fund | Report. Body `{ idempotencyKey, figure, scope, comment }`; `201` with the case, or `200` with `replayed: true` on an idempotent retry. |
| `GET /api/v1/data-issues` | `observations:read` | The caller's own reports, newest first; `?scope=all` lists the whole tenant (Organization Admins only, else `403 tenant_admin_required`); `?status=` filters; `?limit=` / `?cursor=` page; the response carries `unseenUpdateCount` (the caller's own cases that changed since they last looked). |
| `GET /api/v1/data-issues?format=csv` or `format=json` | as above | Export every matching case for the customer's own records, as a download. |
| `GET /api/v1/data-issues/{caseId}` | the reporter, or an Organization Admin | One case with its status history. Anyone else, and a missing or malformed id, get the same `404 data_issue_not_found`. |
| `PATCH /api/v1/data-issues/{caseId}` | the reporter | `{ "seen": true }`: acknowledge the current status (clears the "Updated" indicator). Touches nothing else. |
| `GET /api/v1/admin/data-issues`, `GET /api/v1/admin/data-issues/{caseId}` | Organization Admins (`tenant_admin`) | The Data Operations queue (same list and export parameters, always tenant-wide). |
| `PATCH /api/v1/admin/data-issues/{caseId}` | Organization Admins | Move a case: `{ action: "investigate" or "correct" or "no_change", expectedStatus?, correctionIncidentId?, note? }`. |

**Scope and comment.** `figure` is `overview`, `position_financials` or `review` (the fund scorecard, F1, will add its own). `scope` is `{ fundId, reportPeriod }` plus optional `companyId`, `metricCode`, `snapshotId` and `snapshotVersion` (a version needs its snapshot) and display labels (`fundLabel`, `companyLabel`, `metricLabel`, at most 200 characters each). `comment` is 1 to 2,000 characters. The caller must be entitled to `fundId`; the snapshot, when named, must exist in the tenant for that fund (and version). The scope is stored with the case and never changes afterwards (a database trigger enforces it).

**Status machine.** `received -> investigating -> corrected | no_change`. `investigate` only from `received` (optionally linking a governed correction incident of the same fund and period that is not cancelled); `correct` only from `investigating`, naming (or already linked to) a **resolved** incident of the same fund and period, from which the replacement snapshot id and version are copied onto the case; `no_change` only from `investigating`, with a note. `expectedStatus` makes a move a compare-and-set. Resolving a governed correction (`POST /admin/data-corrections` `resolve`) corrects every linked `investigating` case in the same transaction (isolated by a savepoint, so it can never fail the correction itself) and reports the count as `dataIssuesCorrected`. A corrected case exposes `replacement: { snapshotId, snapshotVersion }`; only Organization Admins also see `correctionIncidentId`.

**Who moves a case.** Corvis Data Operations is not a tenant role (see `ROLE_AND_ACTOR_TERMINOLOGY.md`). Cases are routed to Data Operations (`routedTo: "data_operations"`) and moved from the admin console / `/admin/data-issues` by an Organization Admin, which is how a Corvis operator acts inside a tenant through an explicit, audited support-access grant. The customer-facing Data issues view is read-only for everyone.

**Visibility.** A case is visible to its reporter (while still entitled to the fund) and to Organization Admins, never to other members of the tenant, even with the same fund entitlement. The tables are server-managed with RLS enabled and forced and deliberately no client policy (the 071 pattern, not 022's tenant-wide select), and every query carries the tenant and reporter predicate.

**Idempotency.** `idempotencyKey` (body) or the `Idempotency-Key` header (one namespace; both present and different is `400 invalid_idempotency_key`; neither is `400 idempotency_key_required`) is scoped to the reporter. The same key and content returns the original case; the same key with different content is `409 idempotency_key_reused`; two concurrent first submissions are `409 data_issue_report_conflict` (retry).

**Errors** follow the usual `{ error, correlationId }` shape: `invalid_request`, `invalid_figure`, `invalid_scope`, `invalid_comment`, `invalid_action`, `invalid_status`, `invalid_correction`, `invalid_note`, `invalid_format`, `fund_not_entitled` (403), `tenant_admin_required` (403), `data_issue_not_found` (404), `data_issue_snapshot_not_found` (404), `data_issue_correction_not_found` (404), and 409s `data_issue_status_changed`, `data_issue_transition_not_allowed`, `data_issue_correction_required`, `data_issue_correction_not_resolved`, `data_issue_correction_scope_mismatch`, `data_issue_correction_cancelled`. The SQL refusals behind them are allow-listed in `src/platform/database/sql-application-errors.ts`.

**Audit.** Report and every status move write an `audit_event` (`data_issue.report`, `data_issue.investigate`, `data_issue.correct`, `data_issue.no_change`; target `data_issue_case`) in the same transaction as the change. Events carry identifiers and the status only, never the comment or a note, and appear in the tenant access audit listing and its CSV.

**Export.** `GET /api/v1/data-issues?format=csv` (or `json`) reuses the list endpoint instead of the asynchronous physical-export pipeline: cases are small, tenant-owned records, so the file is rendered synchronously, with spreadsheet formulas neutralised in CSV (`src/shared/lib/csv.ts`), a `Content-Disposition: attachment` and an `x-corvis-export-truncated` header (true only past 10,000 cases). Columns: `case_id, status, figure, fund, fund_id, company, company_id, metric, metric_code, report_period, snapshot_id, snapshot_version, comment, reported_by, reported_at, status_changed_at, resolution_note, replacement_snapshot_id, replacement_snapshot_version, correction_incident_id` (the last only for Organization Admins).

**Demo mode** serves the same routes from an in-memory per-tenant store (`src/modules/governance/adapters/data-issue-store.ts`, selected in `src/modules/governance/server/data-issues/data-issue-service.ts`), seeded per reporting subject with a corrected case carrying an unseen update, an investigating case and a received case. It is never production evidence.

## Physical export publication versions

Physical export ownership is the tuple `(tenantId, workspaceId, authMethod, subject)` recorded when the job is requested. History, status/grant issuance, redemption and failed-download grant restoration all require that same tuple. A matching subject string in another authentication method or workspace does not own the export, even with identical data entitlements. A fresh session for the same owner may retrieve an unexpired export after normal current authorization; exports are not tied to the original session ID.

The per-user observation, Position Financials and performance-scorecard exports pin each snapshot's exact version in `manifest.snapshotState`. A matching snapshot ID alone is insufficient: the recorded version must still be the latest published version, in the same tenant and within the caller's current fund rights. Delivery checks before and after loading rows; status reads, history and download redemption check again before exposing stored artifacts. Existing document and redistribution checks still apply.

A replaced, withdrawn or unverifiable publication fails closed. The worker records `export_snapshot_authorization_expired` as a permanent failure; the caller must request a new export. Missing, partial, duplicate or malformed version metadata cannot be used to serve an old artifact. The API uses the existing authorization refusal, and history omits inaccessible exports. Empty exports with no snapshots do not require version metadata. This contract also applies to scheduled runs using the same pipeline; the separate Organization Admin tenant-archive pipeline retains its own rights and approval contract.

## Scheduled exports (F4)

Implementation tracker: GitHub issue #260. A schedule saves one "Export this view" (D3) scope with a format and a trigger. It never exports anything itself: each due trigger becomes one governed export request made **as the schedule's owner**, through the same `createPhysicalExport` and export worker as `POST /api/v1/exports` (no second export path), and appears in Data delivery with the schedule's label. The routes are product surfaces, classified `workspace_control` in `openapi/v1-route-classification.json`.

| Route | Who | Purpose |
| --- | --- | --- |
| `POST /api/v1/export-schedules` | `exports:create`, redistribution rights, entitled to the scope's fund | Save a schedule. Body `{ idempotencyKey, label, scope, format, trigger, notifyOnCompletion? }` (`notifyOnCompletion` is a boolean, default `true`); `201` with the schedule, or `200` with `replayed: true` on an idempotent retry. |
| `GET /api/v1/export-schedules` | `exports:create` | The caller's own schedules, newest first, each with its latest run; `?scope=all` lists every schedule in the tenant (Organization Admins only, else `403 tenant_admin_required`); `?limit=` / `?cursor=` page. |
| `GET /api/v1/export-schedules/{scheduleId}` | the owner, or an Organization Admin | One schedule. Anyone else, and a missing, deleted or malformed id, get the same `404 export_schedule_not_found`. |
| `PATCH /api/v1/export-schedules/{scheduleId}` | the owner only | One change per request: `{ "action": "pause" or "resume" }`, or `{ "notifyOnCompletion": true or false }` (F4b; audited as `export_schedule.notify` with the new value). Both in one body is `400 invalid_request`. An Organization Admin who is not the owner gets `404`. |
| `DELETE /api/v1/export-schedules/{scheduleId}` | the owner only | The schedule never runs again; its runs and the exports they produced stay in history. |
| `GET /api/v1/export-schedules/runs` | `exports:create` | The scheduled part of delivery history: every run, including refused ones, with the schedule label, scope, trigger and (for a requested run) the export's delivery state. `?scope=all` (Organization Admins), `?scheduleId=`, paging as above. |

**Scope, format, trigger.** `scope` is exactly what `POST /exports` accepts: `{ snapshotId }`, `{ positionFinancials: { fundId, holdingId, companyId, periodicity, portfolioId? } }` or the performance scorecard `{ performanceScorecard: true, fundId?, period? }`. A scorecard scope never also names a snapshot or a position, a malformed filter is `400 invalid_scope`, and a `fundId` the owner is not entitled to (or, unfiltered, an owner entitled to no fund) is `403 export_scope_not_entitled`. `format` is `csv`, `xlsx` or `parquet`; Parquet is refused with `403 feature_disabled` unless `exports.parquet_delivery` is enabled, at creation and again at every run. `trigger` is `on_publish`, `monthly` or `quarterly`. `label` is 1 to 80 single-line characters and is shown with every run. An owner holds at most 50 schedules that are not deleted (`409 export_schedule_limit_reached`).

**Triggers.** Calendar triggers run on the first day of the month, or of January, April, July and October, in UTC; the first run is the next such date after the schedule is saved, never "now". A long outage yields one run for the current period, not one per missed period. `on_publish` follows the scope: a snapshot scope fires when a new version of that snapshot is published, a position scope (or a scorecard with a `fundId` filter) when any snapshot of its fund is published, and an **unfiltered scorecard when any snapshot of any fund the owner is entitled to at that moment is published**: the owner's entitlements are re-resolved before the claim and only a publication of one of those funds is a trigger; a publication of any other fund is consumed without a run, so the owner never learns it happened. Only publications after the schedule was saved count, a publication counts once it has settled for a minute (`published_at` is the transaction start time), and a burst of publications is **one** run for the newest. A paused schedule does not run and does not catch up when resumed.

**Re-authorization at run time.** The worker never trusts what was true when the schedule was saved. For every run it resolves the owner's current membership, entitlements and contractual data rights from Postgres (the same resolution a request goes through, under a stable per-schedule synthetic session that is never a user's revocable one), then requires `exports:create`, an enabled format, the entitled fund and redistribution rights, and finally lets `createPhysicalExport` enforce them again. An all-funds scorecard means "every fund the owner is entitled to now": each run re-resolves it from the owner's current entitlements and data rights (an owner who now holds no fund is refused `scope_not_entitled`; a scorecard that resolves to no published figure is `scope_unavailable`). A refusal is **fail-closed**: the run is recorded as `failed` with one stable reason and nothing is exported. Reasons: `owner_inactive`, `export_permission_revoked`, `redistribution_not_permitted`, `scope_not_entitled`, `scope_unavailable` (the scope no longer resolves to published data, e.g. a withdrawn snapshot), `format_unavailable`. Only `owner_inactive` stops the schedule; the others leave it running because rights may come back. The delivery worker re-authorizes the owner once more when it renders the file.

**Idempotency.** A run is unique per `(schedule, trigger key)`: `publish:<snapshot id>:v<version>`, `monthly:2026-10` or `quarterly:2026-Q4`. The worker claims a trigger under a row lock on the schedule, advances the schedule past it, requests the export and records the run in **one transaction**, so a crash leaves nothing behind (the next tick claims it again), two workers can never both run a trigger, and a refused trigger is not retried. Creation is idempotent per owner like Data issues: `idempotencyKey` (body) or `Idempotency-Key` (one namespace), same content returns the original, different content is `409 idempotency_key_reused`.

**Deactivated owners.** Every worker tick stops each schedule whose owner's identity is disabled or who no longer holds an active membership in the schedule's workspace (`status: "stopped"`, `stopReason: "owner_inactive"`, audited as `export_schedule.stop` by `system:export-scheduler`); a run that finds the owner unauthorizable also stops it. A stopped schedule is final and can only be deleted.

**Visibility.** A schedule is read by its owner and by Organization Admins, and changed by its owner only. The tables are server-managed with RLS enabled and forced and no client policy (the 071/083 pattern).

**Notifications.** Every schedule has `notifyOnCompletion` (default `true`, which is what every schedule did before it existed), chosen when the schedule is saved and changed afterwards by its owner only. It governs the **owner's emails** about that schedule: with it on, the owner gets the existing `export_ready` email when a run's export completes and the new `export_schedule_failed` email when a run is refused or its export could not be delivered; with it off, neither is sent for that schedule (runs, their outcomes and refusal reasons stay in Data delivery). Both emails also follow the owner's own F2 preferences, and carry no data (`NOTIFICATIONS.md`). `ExportRequested` webhook subscribers still receive the same event an interactive request emits.

Two **webhook events** end every scheduled run, once per run, whatever the owner's email switch (a subscriber chose them for the whole organization; subscribe through `POST /admin/webhooks/subscriptions` like any event type):

| Event | When | `data` |
| --- | --- | --- |
| `ExportScheduleRunCompleted` | The governed export a run requested reached `complete` | `{ scheduleId, scheduleLabel, runId, exportId }` |
| `ExportScheduleRunFailed` | The run was refused (fail-closed), or its export ran out of delivery attempts | `{ scheduleId, scheduleLabel, runId, failureReason, exportId? }` |

`failureReason` is one of the run reasons above (`owner_inactive`, `export_permission_revoked`, `redistribution_not_permitted`, `scope_not_entitled`, `scope_unavailable`, `format_unavailable`) or `export_failed` (accepted, then not deliverable; `exportId` is then present). The payload carries the schedule id and the label its owner chose, and nothing else: no figure, fund, company, scope or person. They ride the ordinary outbox (`corvis_control.outbox_event`, aggregate `export_schedule_run`, written by `emit_export_schedule_run_event`), so signing, retries and fan-out are the existing ones; the refusal is announced in the same transaction as its run record, the completion and delivery failure by the export worker (`src/modules/delivery/server/schedules/export-schedule-notifications.ts`, best effort: a notification fault is logged and never undoes a run or an export).

**Errors:** `invalid_request`, `idempotency_key_required`, `invalid_idempotency_key`, `invalid_label`, `invalid_scope`, `invalid_export_format`, `invalid_trigger`, `invalid_action`, `invalid_notify_on_completion`, `invalid_scope` on the list parameter, `tenant_admin_required` (403), `export_scope_not_entitled` (403), `feature_disabled` (403), `forbidden` (403, no redistribution rights), `export_schedule_not_found` (404), and 409s `idempotency_key_reused`, `export_schedule_limit_reached`, `export_schedule_transition_not_allowed`. The SQL refusals behind them are allow-listed in `src/platform/database/sql-application-errors.ts`.

**Audit.** `export_schedule.create`, `.pause`, `.resume`, `.notify` (metadata includes the new `notifyOnCompletion`) and `.delete` (actor: the owner, in the same transaction as the change), `export_schedule.run` (actor: the owner, outcome `success` or `failure` with the reason) and `export_schedule.stop` (actor `system:export-scheduler`); target `export_schedule`. Events carry identifiers, the label, the trigger, the format and the status, never data, and appear in the tenant access audit listing.

**Demo mode** serves the same routes from an in-memory per-tenant store (`src/modules/delivery/adapters/export-schedule-store.ts`, selected in `src/modules/delivery/server/schedules/export-schedule-service.ts`), seeded per owning subject with an active monthly schedule that delivered and a paused on-publish schedule whose last run was refused. Demo mode has no worker, so a schedule created there never runs and its next run only shows; the seeded runs are illustrative.

## Performance scorecard (F1)

Implementation tracker: GitHub issue #257. `GET /api/v1/performance-scorecard` (`observations:read`, classified `workspace_control` like the other product-composed reads) serves the GP-reported performance of every entitled fund and of its underlying investments as the Analytics **Performance scorecard** lens renders it. Logic lives in `src/modules/analytics/domain/performance-scorecard.ts` (selection, trust flags, formatting, export rows), the Postgres read in `src/modules/analytics/server/performance-scorecard.ts`, the demo dataset in `src/modules/analytics/server/performance-scorecard-demo.ts`.

Query parameters (F1c, #332): `fundId` narrows to one entitled fund (a fund the caller is not entitled to is `403`, never ignored); `period` keeps, per metric, the latest figure the GP stated for that reporting period (a figure's `period` label such as `Q1 2026`; the filter is applied before the latest figure is chosen, so an older period shows what was reported for it and only a metric with no figure for that period is Not reported); `limit` (funds per page, default 25, at most 100) and `cursor` (the previous `nextCursor`). Both filters are single-line, at most 512 / 64 characters, and an empty value is `400 invalid_scorecard_filter`, never "no filter". A bad `limit` or `cursor` is `400 invalid_limit` / `invalid_cursor`.

Response `data` is `{ funds, filters, fundOptions: [{ fundId, fund }], periodOptions: [period] }` with `funds: [{ fundId, fund, cells, investments: [{ key, investment, holdingId, companyId, cells }] }]`; `nextCursor` is the keyset of the last fund of the page (funds are paged by name then id, each fund whole: its figures are never split across pages), null on the last page. `filters` echoes the canonical filters, `fundOptions` lists every entitled fund whatever the filters, and `periodOptions` (every period with a published figure, latest first) is sent with the first page only (no `cursor`) and is empty afterwards. Each cell is `{ metric: { code, label, kind, definition }, figures }`; `figures` is empty when the GP did not report the metric (the UI shows "Not reported", never 0). A figure carries the value exactly as stored (`valueNumber` is exact decimal text, `valueString`, `valueRaw`, `currency`, `unit`), `asOf` (ISO date, or null, then the reporting `period` stands in), `status`, `derived`, `derivationFormula` and its `source` (`documentId`, `sourceReferenceId`, `page`, `sheetName`, `cellRange`), which is what the one-click drill-through opens. Nothing is recomputed, summed across funds or currencies or FX-converted: when one fund reports the latest as-of date in two currencies, both figures are returned.

**Metric dictionary (assumptions).** The Confluence dictionary is not reachable from the repository and `corvis_semantic.metric_definition` is tenant-managed data, not seeded by migrations, so the subject level of each metric is an assumption documented here and pinned by `src/modules/analytics/domain/performance-scorecard.test.ts`. Fund level (subject level `fund`): `nav`, `tvpi`, `dpi`, `rvpi`, `net_irr`, `net_moic`. Investment level (subject level `holding` or `company`, shown under the fund that holds it): `cost`, `fair_value`, `gross_moic`, `gross_irr`, `ownership_pct`. An `instrument`-level fact, a breakdown row (for example fair value by sector), a look-through row and a conflicting alternative are never an investment's or fund's headline figure. All eleven codes are already in the dual-review critical set (`src/modules/processing/server/stages/processing-reviewed-stage.ts`).

**What is served.** Facts of every entitled fund snapshot whose *current* version is `published` (a draft, blocked, withdrawn or superseded version contributes nothing), whose source document the caller is entitled to (a figure with no entitled source is not served). Per fund, subject, metric, currency and unit the query returns the latest fact, ordered by as-of date, then publication time, then snapshot and fact id, undated and unpublished last (`compareLatestFirst`); the final choice is made in core. A forecast, budget, plan, projection or target (`actuality` / `scenarioType`) is not a reported result and is never shown. **Large tenants.** The 50,000-figure cap applies to one page of funds, not to the tenant: a page whose figures would exceed it is halved and retried (the response simply carries fewer funds and a `nextCursor`), so a tenant above the cap still loads, and no figure is ever dropped, because truncating would turn published figures into false "Not reported" cells. Only a single fund with more than 50,000 reported figures cannot be split and fails with `413 performance_scorecard_too_large` (narrow it with `period`). The governed export reads the same pages (100 funds at a time) and so is not limited by the cap either.

**Status flag mapping.** *Final*: published and not flagged. *Preliminary*: the GP marked the figure provisional (`actuality` `preliminary`, `provisional`, `estimate`, `estimated` or `flash`; this vocabulary is an assumption pending the dictionary). *Restated*: the GP flagged the figure as a restatement (the observation's `is_restated`, carried in the fact's semantic dimensions). Preliminary outranks Restated, as in the Review trend and Position Financials. **Supersession is deliberately not mapped to Restated:** the real supersession data (`superseded` snapshot versions and `corvis_control.data_correction_incident` replacements) records Corvis correcting its own extraction, not the GP restating, so the replacement is simply the current published version. A figure the extraction marks `is_derived` is additionally labelled *Derived*.

**Governed export (D3).** `POST /api/v1/exports` accepts `scope: { performanceScorecard: true, fundId?, period? }`: the same filters as the view, validated server-side (`400 invalid_export_scope` for a malformed one; a `fundId` the caller is not entitled to is refused `403`, entitlement still applies, and a scope that resolves to nothing is refused rather than widened). The export is pinned to the published snapshots behind the shown figures, rebuilt at delivery time from only those snapshots (it fails with `export_snapshot_authorization_expired` rather than delivering a different scorecard), and downloadable only while those snapshots stay published and the caller stays entitled. One row per figure with the columns in `SCORECARD_EXPORT_COLUMNS`, plus an explicit `Not reported` row for every metric the GP did not report; `value_number` is `DECIMAL(38,10)` and `is_derived` a Parquet BOOLEAN. The manifest records `rowCounts.performanceScorecard`, the scope **with its filters** (`scope: { performanceScorecard: true, fundId?, period? }`, the filters the export was rebuilt with at delivery time) and the label `Performance scorecard · <fund id or "all entitled funds">[ · <period>]`, which is also the label of a schedule of the same scope.

## Versioning and deprecation

`/api/v1` is the published version today. `openapi/v1-compatibility-baseline.json`
is an append-only CI baseline for already-published v1 paths/methods and stable
contract conventions: additive operations are allowed, but a baseline operation
cannot silently disappear from `openapi/corvis-v1.yaml`. The check also runs the
other way: every operation in the spec must be recorded in the baseline, so a new
published path is protected from the day it is added.
`src/platform/http/api/openapi-response-schemas.test.ts` holds real route responses to the
schemas in the spec (using the dependency-free validator in
`src/test-support/openapi-support.ts`), so documented shapes cannot drift
from what the handlers return.

Breaking changes use a new version prefix rather than changing v1 in place.
The governed migration/notice/sunset process, including the rule that security
and tenant-isolation fixes override compatibility concerns, is defined in
`docs/architecture/API_DEPRECATION.md`.

The OpenAPI document is the customer-facing contract, not a substitute for
operator/admin runbooks. Any customer-reachable or integration-relevant route
that is intentionally part of v1 must be added to the spec and compatibility
baseline before it is treated as a stable external contract. Internal/operator
routes should be explicitly classified rather than silently omitted or
accidentally presented as customer APIs.

## Review-item assignment and discussion (F3)

Implementation tracker: GitHub issue #259. A Review Analyst assigns an observation or a reconciliation exception to a teammate and discusses it in a comment thread. The routes are product surfaces, classified `workspace_control` in `openapi/v1-route-classification.json`. Discussion records ownership and conversation only: it never changes data, never records a review decision and never counts toward dual control. Decisions still go through `POST /review`, `POST /extraction-review` and `POST /reconciliation-exceptions/resolve`. Every route requires `observations:review` (checked before anything else) and a signed-in person (`403 human_identity_required` for a service identity).

| Route | Purpose |
| --- | --- |
| `GET /api/v1/review-items` | Items in the caller's workspace that have an assignee or comments (`subjectKind`, `subjectId`, `assignee`, `assignedAt`, `version`, `commentCount`, `lastCommentAt`), keyset paged by `?limit` / `?cursor`. Only items the caller can read in Data review are listed. |
| `GET /api/v1/review-items/assigned` | The caller's own open assignments (observations still needing review, exceptions still open), blocking exceptions first, for the Overview "Assigned to me" view. |
| `GET /api/v1/review-items/{subjectKind}/{subjectId}` | One thread: assignee, comments oldest first (at most 200) and `members`, everyone who may be assigned or mentioned on this item. `subjectKind` is `observation` or `reconciliation_exception`. An item the caller cannot read, a missing one and a malformed id are the same `404 review_item_not_found`. |
| `PUT /api/v1/review-items/{subjectKind}/{subjectId}/assignee` | `{ assigneeUserId: "<member>" or null, expectedVersion }`: assign, reassign or unassign. `expectedVersion` is the thread version the caller saw (0 when none); a stale one is `409 assignment_changed`. Assigning the current assignee changes nothing (no audit event, no notice). |
| `POST /api/v1/review-items/{subjectKind}/{subjectId}/comments` | `{ idempotencyKey, body, mentionUserIds }` (the key may be the `Idempotency-Key` header): append a comment. `201`, or `200` with `replayed: true` for a replay of the same key and content. There is no edit or delete. |

**Eligibility.** Only workspace members with review access can be assigned or mentioned: an active membership of the workspace in `tenant_admin`, `accountadmin` or `reviewer`, an active human identity, and read entitlement to the item's fund. Anyone else is `422 assignee_not_eligible` / `422 mention_not_eligible`. People are identified by user id and shown by their verified address (then invitation address, then subject); the member list is only ever returned to a caller who can already review the item.

**Comments.** 1 to 2,000 characters of free text, at most 10 distinct mentions. Mentioned people are notified through F2 (`review_discussion`, see `NOTIFICATIONS.md`) without any comment text. Comment text is rendered as text only and is never copied into an email, a notification or an audit event.

**Errors**: `invalid_request`, `invalid_subject_kind`, `invalid_subject_id`, `invalid_assignee`, `invalid_expected_version`, `invalid_comment`, `invalid_mentions`, `idempotency_key_required`, `invalid_idempotency_key`, `invalid_limit`, `invalid_cursor`, `human_identity_required` (403), `review_item_not_found` (404), `assignee_not_eligible` and `mention_not_eligible` (422), and 409s `assignment_changed`, `idempotency_key_reused`, `review_comment_conflict` (two concurrent first comments with one key; retry) and `review_comment_limit_reached`. The SQL refusals behind them are allow-listed in `src/platform/database/sql-application-errors.ts`.

**Audit.** Every change of assignee and every comment writes an `audit_event` (`review_item.assign`, `review_item.reassign`, `review_item.unassign`, `review_item.comment`; target type `review_item`, target id `<kind>:<id>`) in the same transaction as the change. Events carry identifiers and counts only (fund, assignee and previous assignee ids, comment id, mentioned ids, comment length). They are queryable through `GET /admin/audit?targetType=review_item`; they are deliberately not part of the access-administration audit listing, which would otherwise drown in day-to-day discussion.
