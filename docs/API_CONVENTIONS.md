# `/api/v1` conventions

Implementation tracker: GitHub issue #11. This documents the conventions
`app/api/v1/**` routes actually follow today, backed by `openapi/corvis-v1.yaml`
and `lib/server/http.ts`/`lib/server/pagination.ts`.

## Envelope and errors

Every response is `{ data, correlationId }` on success (an action route may
add fields alongside `data`, as `snapshots/publish` does). Every route reads
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
code, etc.), `invalid_cursor` (400), `invalid_json` (400, malformed request
body), `invalid_idempotency_key` (400), the research-specific timeout/cancel/provider
codes, and `internal_error` (500) as the fallback. Adding a new typed error class
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
Malformed or tampered cursors, and non-positive/non-integer `limit` values,
are rejected with `invalid_cursor` (400) rather than silently ignored,
clamped without complaint, or crashing.

**Landed on:** `GET /documents`, `GET /observations`, `GET /snapshots` and
`GET /jobs` preserve the unpaginated-by-default compatibility rule above.
`GET /funds`, `GET /companies`, `GET /holdings`, `GET /instruments`,
`GET /company-lifecycle-events`, `GET /metric-definitions`,
`GET /consolidated-facts`, `GET /reconciliations` and
`GET /admin/webhooks/subscriptions/{webhookId}/deliveries` are newer
collections and use pagination as their collection contract. `GET /exports`
uses its separately bounded requester-history contract.

Production Postgres repositories now push the requested page into SQL with
a keyset predicate and `limit + 1` fetch for the document/job/observation/
snapshot lists and the governed serving-resource collections above. This
prevents the old silent-cap problem where rows beyond an in-memory fetch
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
action; `lib/server/data-lifecycle.ts`'s deletion execution follows the same
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
subscribable and are excluded from delivery even for legacy subscription rows.
Expand the customer event vocabulary only through a reviewed external-contract
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
  literal are rejected with `endpoint_url_host_not_allowed`; at send time the
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
  customer-visible delivery diagnostics (state, attempt, status code, last
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
`tenant_admin` and `workspace_admin` must not be treated as interchangeable
scopes merely because both are administrative labels; workspace-scoped
administration must never acquire tenant-wide authority without an explicit,
reviewed permission boundary. The implementation/evidence work for this
partitioning is tracked by the enterprise-admin readiness issue.

## Versioning and deprecation

`/api/v1` is the published version today. `openapi/v1-compatibility-baseline.json`
is an append-only CI baseline for already-published v1 paths/methods and stable
contract conventions: additive operations are allowed, but a baseline operation
cannot silently disappear from `openapi/corvis-v1.yaml`.

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
