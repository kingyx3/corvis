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
code, etc.), `invalid_cursor` (400), the research-specific timeout/cancel/provider
codes, and `internal_error` (500) as the fallback. Adding a new typed error class
means adding one `instanceof` branch to `apiError()`, not reinventing the
envelope in the route.

## Pagination

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
(by convention, the resource's own id; `snapshots` falls back to a
composite `fund/period/version` key since a `FundSnapshot`'s `id` is
optional in some compositions). Pagination is keyset-based: walking pages
with the returned cursor visits every item created before or during the
walk exactly once, in stable order, even if items are inserted or deleted
between requests — it is not resilient to the underlying sort key itself
changing. Malformed or tampered cursors, and non-positive/non-integer
`limit` values, are rejected with `invalid_cursor` (400) rather than
silently ignored, clamped without complaint, or crashing.

**Landed on:** `GET /documents`, `GET /observations`, `GET /snapshots` and
`GET /jobs` preserve the unpaginated-by-default compatibility rule above.
`GET /funds`, `GET /companies`, `GET /company-lifecycle-events`,
`GET /metric-definitions`, `GET /consolidated-facts` and
`GET /admin/webhooks/subscriptions/{webhookId}/deliveries` are newer
endpoints and therefore use pagination as their only collection mode.
`GET /exports` and any future resource listing should adopt the same opaque
cursor contract; genuinely new endpoints should default to pagination-only.

**Known limitation:** pagination is currently applied over the full list
each repository/adapter already returns, not pushed down as a `LIMIT`/
keyset `WHERE` clause in the underlying Postgres query. It is correct and
convenient for a client, but does not reduce the amount of work the server
does to serve one page. Push-down to the repository layer is future work.

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

Holdings and instruments are intentionally not synthesized from optional
observation identifier columns. Those resources are added only after their
full polymorphic holding-target and instrument semantics are represented in
the governed persisted model.

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
redelivered attempt is a no-op, not a duplicate).

Subscription administration and per-subscription signing-key rotation
(migration `019_webhook_subscription_management.sql`,
`lib/server/webhook-subscriptions.ts`) are exposed under
`/admin/webhooks/subscriptions`, gated by `admin:manage`:

- `POST /admin/webhooks/subscriptions` — create (`endpointUrl` must be
  `https://`, `eventTypes` a non-empty array). The response includes the
  signing secret exactly once; it is never re-readable afterward.
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

## Versioning and deprecation

`/api/v1` is the published version today. `openapi/v1-compatibility-baseline.json`
is an append-only CI baseline for already-published v1 paths/methods and stable
contract conventions: additive operations are allowed, but a baseline operation
cannot silently disappear from `openapi/corvis-v1.yaml`.

Breaking changes use a new version prefix rather than changing v1 in place.
The governed migration/notice/sunset process, including the rule that security
and tenant-isolation fixes override compatibility concerns, is defined in
`docs/API_DEPRECATION.md`.
