# `/api/v1` conventions

Implementation tracker: GitHub issue #11. This documents the conventions
`app/api/v1/**` routes actually follow today, backed by `openapi/corvis-v1.yaml`
and `lib/server/http.ts`/`lib/server/pagination.ts`.

## Envelope and errors

Every response is `{ data, correlationId }` on success (an action route may
add fields alongside `data`, as `snapshots/publish` does). Two families are deliberately not enveloped: `uploads/initiate` returns the upload session object directly, and `scim/v2/**` follows the SCIM 2.0 wire format. Every route reads
or generates `correlationId` from the `x-correlation-id` request header via
`correlationId(request)` and echoes it back, including on error, so a client
and server log can be correlated even across a failure.

Errors are always `{ error: "<stable_code>", correlationId }` with an
appropriate HTTP status, produced by the single `apiError()` mapper in
`lib/server/http.ts` rather than by each route improvising its own shape.
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

`lib/server/pagination.ts` implements opaque cursor pagination:
`GET` collection endpoints accept `?limit=` (1–200, default 50) and
`?cursor=` (an opaque, tamper-checked continuation token from a previous
page's `nextCursor`). A response always includes `nextCursor`, which is
`null` on the last page.

**Backward compatibility rule:** a collection endpoint that predates
pagination keeps returning its full, unpaginated list when the caller
passes neither `limit` nor `cursor` — pagination only activates once a
caller explicitly asks for it (`paginationRequested()`). This matters
because production callers like `adapters/workspace/http-workspace.ts`
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
`idempotencyKey` field in the request body (see `lib/server/uploads.ts`'s
upload-session `initiate`/`complete` flow), not an `Idempotency-Key` HTTP
header. A repeated call with the same key and tenant returns the original
result rather than creating a duplicate resource or repeating a destructive
action. Upload keys are additionally bound to the caller's subject and
workspace (`uploadIdempotencyKey`); replaying one from another uploader or
workspace is a 409 `upload_idempotency_mismatch`.
`lib/server/data-lifecycle.ts`'s deletion execution follows the same
principle for its per-attempt evidence ledger. New mutating endpoints that
can be safely retried should follow this same body-field convention rather
than introducing a second one.

Some newer HTTP action routes also accept an `Idempotency-Key` header for
client ergonomics while normalizing it into the same tenant/subject-scoped
server idempotency contract. A route must not create a second independent
idempotency namespace for header versus body representations of the same key.

## Webhooks

`corvis_control.webhook_subscription` and `corvis_control.webhook_delivery`
(migration `006_upload_delivery_operations.sql`) hold the durable outbound
delivery ledger: `lib/server/delivery.ts`'s `processWebhookDeliveries` claims
outbox events for each active subscription with an idempotent
`on conflict (tenant_id,webhook_id,event_id,attempt) do nothing` insert,
bounded to 5 attempts, and marks the fifth failure terminal
(`docs/API_CONVENTIONS.md`'s own idempotency rule applies here too: a
redelivered attempt is a no-op, not a duplicate). Fan-out completion is
tracked on `outbox_event.webhook_fanout_completed_at` (migration 043); webhook
delivery never reads or writes `published_at`/`attempt_count`/`last_error`,
which belong to the processing transport. A delivery left in `delivering` for
more than 10 minutes (worker crash) is reclaimed as retryable; export jobs are
reclaimed the same way via `export_job.delivery_started_at`.

The launch customer-facing event allowlist is intentionally narrower than the
internal processing event stream. `WEBHOOK_EVENT_TYPES` currently exposes:
`SnapshotPublicationChanged`, `DataCorrectionOpened`, `DataCorrectionResolved`,
`CorrectionReplacementDeliveryRequested` and `ExportRequested`. Internal
processing/job signals — including `DocumentRegistered`, stage-ready/retry
transport events, and stage blocked/dead-letter operator state — are not
subscribable and are excluded from delivery even for pre-policy subscription
rows. Expand the customer event vocabulary only through a reviewed external-contract
change; do not expose internal outbox events merely because they exist.

Subscription administration and per-subscription signing-key rotation
(migration `019_webhook_subscription_management.sql`,
`lib/server/webhook-subscriptions.ts`) are exposed under
`/admin/webhooks/subscriptions`, gated by `admin:manage`:

- `POST /admin/webhooks/subscriptions` — create (`endpointUrl` must be
  `https://`, `eventTypes` a non-empty array of customer-facing event types
  from `WEBHOOK_EVENT_TYPES` in `lib/server/webhook-endpoint-policy.ts`;
  internal processing-transport signals such as `DocumentRegistered` are
  rejected with `event_type_not_supported`). Endpoints naming `localhost`,
  `*.internal`/metadata hosts or a loopback/private/link-local/reserved IP
  literal are rejected with `endpoint_url_host_not_allowed`; a URL longer than
  2048 characters (as submitted or once normalized) is rejected with
  `endpoint_url_too_long` (400), and a tenant may hold at most 25 non-revoked
  (active or paused) subscriptions — the 26th create is rejected with
  `webhook_subscription_limit_reached` (409) until one is revoked (the cap is
  checked under a per-tenant advisory lock, so racing creates cannot exceed it;
  limits live in `lib/server/webhook-subscriptions.ts`). At send time the
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
repository-wide contract is enforced by `lib/server/security-contract.test.ts`,
not by convention alone.

Database lifecycle roles and application permissions are separate layers.
`tenant_admin` and `accountadmin` (a workspace/product administrator; renamed
from the earlier `workspace_admin`) both map to the application `admin` Role
for ordinary permission checks, but they are not interchangeable scopes:
`assertTenantAdminRequestScope()` (`lib/server/authorized-request.ts`) requires
the authoritative, tenant-wide `isTenantAdmin` signal — never just the `admin`
Role — for every `/api/v1/admin/**` route and the tenant-scoped processing
recovery commands (`/jobs/{jobId}/retry`, `/jobs/{jobId}/recover`); granting
the `tenant_admin` role itself carries the same requirement, enforced both in
the route and authoritatively in SQL (migration 048). Workspace/product
routes such as `/api/v1/source-connections/**` remain available to
`accountadmin`, but are scoped to the caller's own workspace
(`lib/server/source-connector-governance.ts`), never tenant-wide.

## Data issues (F5)

Implementation tracker: GitHub issue #261. A customer who doubts a **published** figure reports it with the figure, its scope and a comment; the report becomes a tenant-scoped case routed to Data Operations. Reporting records a claim only: it never changes observations, snapshots or publication, which remain the business of the governed correction flow (`/admin/data-corrections`, migration 022). The routes are product surfaces, classified `workspace_control` in `openapi/v1-route-classification.json` rather than part of the stable integration contract in `openapi/corvis-v1.yaml` (the Data Operations routes fall under `/admin/**`).

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

**Errors** follow the usual `{ error, correlationId }` shape: `invalid_request`, `invalid_figure`, `invalid_scope`, `invalid_comment`, `invalid_action`, `invalid_status`, `invalid_correction`, `invalid_note`, `invalid_format`, `fund_not_entitled` (403), `tenant_admin_required` (403), `data_issue_not_found` (404), `data_issue_snapshot_not_found` (404), `data_issue_correction_not_found` (404), and 409s `data_issue_status_changed`, `data_issue_transition_not_allowed`, `data_issue_correction_required`, `data_issue_correction_not_resolved`, `data_issue_correction_scope_mismatch`, `data_issue_correction_cancelled`. The SQL refusals behind them are allow-listed in `lib/server/sql-application-errors.ts`.

**Audit.** Report and every status move write an `audit_event` (`data_issue.report`, `data_issue.investigate`, `data_issue.correct`, `data_issue.no_change`; target `data_issue_case`) in the same transaction as the change. Events carry identifiers and the status only, never the comment or a note, and appear in the tenant access audit listing and its CSV.

**Export.** `GET /api/v1/data-issues?format=csv` (or `json`) reuses the list endpoint instead of the asynchronous physical-export pipeline: cases are small, tenant-owned records, so the file is rendered synchronously, with spreadsheet formulas neutralised in CSV (`lib/csv.ts`), a `Content-Disposition: attachment` and an `x-corvis-export-truncated` header (true only past 10,000 cases). Columns: `case_id, status, figure, fund, fund_id, company, company_id, metric, metric_code, report_period, snapshot_id, snapshot_version, comment, reported_by, reported_at, status_changed_at, resolution_note, replacement_snapshot_id, replacement_snapshot_version, correction_incident_id` (the last only for Organization Admins).

**Demo mode** serves the same routes from an in-memory per-tenant store (`adapters/demo/data-issue-store.ts`, selected in `lib/server/data-issue-service.ts`), seeded per reporting subject with a corrected case carrying an unseen update, an investigating case and a received case. It is never production evidence.

## Versioning and deprecation

`/api/v1` is the published version today. `openapi/v1-compatibility-baseline.json`
is an append-only CI baseline for already-published v1 paths/methods and stable
contract conventions: additive operations are allowed, but a baseline operation
cannot silently disappear from `openapi/corvis-v1.yaml`. The check also runs the
other way: every operation in the spec must be recorded in the baseline, so a new
published path is protected from the day it is added.
`lib/server/openapi-response-schemas.test.ts` holds real route responses to the
schemas in the spec (using the dependency-free validator in
`lib/server/test-support/openapi-support.ts`), so documented shapes cannot drift
from what the handlers return.

Breaking changes use a new version prefix rather than changing v1 in place.
The governed migration/notice/sunset process, including the rule that security
and tenant-isolation fixes override compatibility concerns, is defined in
`docs/API_DEPRECATION.md`.

The OpenAPI document is the customer-facing contract, not a substitute for
operator/admin runbooks. Any customer-reachable or integration-relevant route
that is intentionally part of v1 must be added to the spec and compatibility
baseline before it is treated as a stable external contract. Internal/operator
routes should be explicitly classified rather than silently omitted or
accidentally presented as customer APIs.
