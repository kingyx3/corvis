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
`FeatureFlagGovernanceError`/`DeletionExecutionError` code, etc.),
`invalid_cursor` (400), the research-specific timeout/cancel/provider codes,
and `internal_error` (500) as the fallback. Adding a new typed error class
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
unpaginated caller should make pagination the only mode instead of adding
this compatibility branch.

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

**Landed on:** `GET /documents`, `GET /observations`, `GET /snapshots`.
**Not yet applied:** `GET /jobs`, `GET /exports` and any future resource
listing should adopt the same `paginate()`/`paginationRequested()` pair.

**Known limitation:** pagination is currently applied over the full list
each repository/adapter already returns, not pushed down as a `LIMIT`/
keyset `WHERE` clause in the underlying Postgres query. It is correct and
convenient for a client, but does not reduce the amount of work the server
does to serve one page. Push-down to the repository layer is future work.

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

## Rate limiting

Not yet implemented at the application layer for `/api/v1`. Cloudflare edge
rate limiting is configured per `docs/INFRASTRUCTURE.md` and
`infra/terraform/modules/cloudflare-edge`; there is no additional
per-tenant/per-key application-level limiter today.

## Authentication and authorization

Every non-public `/api/v1` route calls `resolveAuthorizedRequestIdentity()`
and `assertPermission()`/`assertRole()` before doing anything else; this
repository-wide contract is enforced by `lib/server/security-contract.test.ts`,
not by convention alone.

## Versioning

`/api/v1` is the only version today. There is no deprecation/sunset
mechanism yet; a breaking change to a resource should add a new version
prefix rather than changing `/api/v1`'s existing contract in place.
