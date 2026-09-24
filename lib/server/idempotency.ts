import { createHash } from "node:crypto";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { postgres, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";

/**
 * Postgres-backed idempotency for mutating `/api/v1` requests (issue #11).
 *
 * Extends the `Idempotency-Key` convention already used by the uploads
 * routes (app/api/v1/uploads/**, lib/server/uploads.ts) -- which pointer-file
 * a dedup marker into GCS because the upload session port is object-store
 * backed -- to routes whose state lives in Postgres instead. Storage here is
 * `corvis_control.idempotency_key`: a table that has existed, unused, since
 * the original control-plane migration (001_control_plane.sql). Its primary
 * key is `(tenant_id, scope, idempotency_key)`, so two requests racing to
 * record the same key resolve atomically at the database -- one INSERT wins,
 * the other is rejected by the primary key -- rather than through a
 * check-then-insert race in application code. The table intentionally has no
 * client-facing SELECT policy under RLS (like `session_revocation`,
 * `service_identity_grant` and other server-only control state): only the
 * server-side connection this module uses can ever read or write it.
 *
 * Usage: `withIdempotency(identity, scope, clientKey, fn)`.
 *
 *  - `clientKey` is optional. `undefined` (no `idempotencyKey` in the body
 *    and no `Idempotency-Key` header) skips this mechanism entirely: `fn`
 *    always runs and Postgres is never touched. This is what makes the key
 *    backward compatible -- every caller that predates idempotency support
 *    keeps working exactly as before.
 *  - When a key is supplied it is namespaced as
 *    `JSON.stringify([subject, workspaceId, clientKey])` before being stored,
 *    and every query also filters on `identity.tenantId`. Neither a different
 *    subject, workspace nor tenant can collide with, or read, another
 *    caller's record even if they reuse the same key text. Keys must be
 *    strings of at most MAX_IDEMPOTENCY_KEY_LENGTH characters.
 *  - If a record already exists for `(tenant, scope, key)` it is returned
 *    verbatim and `fn` is never invoked (`replayed: true`).
 *  - Otherwise `fn` runs and only a *successful* result is persisted. If
 *    `fn` throws, nothing is written for that key, so the next attempt (with
 *    the same key) calls `fn` again from scratch. This applies equally to a
 *    deliberate domain error -- a validation failure, or a genuine
 *    optimistic-concurrency `ConflictError` such as the reconciliation
 *    resolve endpoint's `expectedVersion` mismatch -- as to an unexpected
 *    one: this module has no reliable way to tell a permanently-failing
 *    request apart from a transiently-failing one, and caching an error
 *    response would let a stale failure permanently poison a key even after
 *    the caller corrects it (e.g. resubmits with a refreshed
 *    `expectedVersion`). Errors are therefore always re-attempted, never
 *    replayed; only success responses are ever cached. This is a deliberate,
 *    consistent choice applied identically at both call sites that use this
 *    module.
 *
 * A caveat worth stating plainly: this guards against the common case this
 * module targets -- a client retrying after a dropped/timed-out response --
 * not against two requests that are truly concurrent. If two requests with
 * the same brand-new key reach the "no existing record" branch at the same
 * instant, both invoke `fn`; the primary key still guarantees at most one
 * row is ever stored, so every caller (including the one whose own insert
 * lost that race) converges on one consistent stored response, but `fn`
 * itself may have run twice. Both call sites this module is used by already
 * carry an independent safeguard for that: exports create a fresh row per
 * call (a duplicate is a duplicate export job, not a corrupted one), and
 * reconciliation resolution is additionally protected by its own
 * `expectedVersion` optimistic-concurrency check at the database, which
 * fails the loser of any real race regardless of idempotency.
 */

export interface IdempotentOutcome<T> {
  status: number;
  body: T;
  /** True when this response came from a previously stored attempt rather than a fresh call to `fn`. */
  replayed: boolean;
}

export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

export class InvalidIdempotencyKeyError extends Error {
  readonly code = "invalid_idempotency_key";
  constructor() {
    super("invalid_idempotency_key");
    this.name = "InvalidIdempotencyKeyError";
  }
}

function controlDb(): PostgresSqlApi { return postgres(getServerConfig().postgresDsn); }

/**
 * How long a stored record remains available to satisfy a replay before it
 * becomes eligible for a future maintenance sweep. `corvis_control.idempotency_key`
 * requires `expires_at` on every row (`check (expires_at > created_at)`); no
 * sweep exists yet, so this only bounds how long a row *could* be reclaimed,
 * matching the sweep-hint use of similar `*_at` columns elsewhere in this
 * repo (e.g. `lib/server/uploads.ts`'s abandoned/quarantine retention
 * windows) rather than a live validity check consulted on every lookup.
 */
export const IDEMPOTENCY_RECORD_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * `idempotency_key`'s `request_hash` column exists for future
 * request-payload comparison (detecting the same key reused for a
 * different request), which this module does not implement -- doing so
 * safely needs a caller-supplied canonical fingerprint of the request body,
 * which is out of scope for the two call sites this change wires up. A
 * stable hash of `(scope, key)` satisfies the column's `not null` and
 * primary-key-adjacent role without asserting a payload guarantee this
 * module does not check.
 */
function requestHash(scope: string, key: string): string {
  return createHash("sha256").update(`${scope}:${key}`).digest("hex");
}

function parseResponseBody(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

async function findRecord(db: PostgresSqlApi, tenantId: string, scope: string, key: string): Promise<PostgresRow | undefined> {
  const rows = await db.query(
    `select response_status, response_body from corvis_control.idempotency_key
      where tenant_id=$1 and scope=$2 and idempotency_key=$3
      limit 1`,
    [tenantId, scope, key],
  );
  return rows[0];
}

async function insertRecordIfAbsent(
  db: PostgresSqlApi,
  tenantId: string,
  scope: string,
  key: string,
  status: number,
  body: unknown,
): Promise<PostgresRow | undefined> {
  const rows = await db.query(
    `insert into corvis_control.idempotency_key
        (tenant_id, scope, idempotency_key, request_hash, response_status, response_body, expires_at)
      values ($1,$2,$3,$4,$5,$6::jsonb, now() + make_interval(secs => $7))
      on conflict (tenant_id, scope, idempotency_key) do nothing
      returning response_status, response_body`,
    [tenantId, scope, key, requestHash(scope, key), status, JSON.stringify(body ?? null), Math.floor(IDEMPOTENCY_RECORD_TTL_MS / 1000)],
  );
  return rows[0];
}

function toOutcome<T>(row: PostgresRow, replayed: boolean): IdempotentOutcome<T> {
  return { status: Number(row.response_status), body: parseResponseBody(row.response_body) as T, replayed };
}

/**
 * Runs `fn` at most once per `(identity.tenantId, scope, clientKey)`. See the
 * module doc comment above for the full replay, namespacing and
 * failure-handling contract.
 */
export async function withIdempotency<T>(
  identity: RequestIdentity,
  scope: string,
  clientKey: string | undefined,
  fn: () => Promise<{ status: number; body: T }>,
  db: PostgresSqlApi = controlDb(),
): Promise<IdempotentOutcome<T>> {
  if (!clientKey) {
    const fresh = await fn();
    return { ...fresh, replayed: false };
  }
  // Route bodies are untyped JSON: reject non-string keys and keys long
  // enough to exceed the primary-key btree row limit (a Postgres 500).
  if (typeof clientKey !== "string" || clientKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) throw new InvalidIdempotencyKeyError();

  // JSON-encoded so neither a subject containing ':' can collide with another
  // subject's keys nor one workspace's stored response replay into another
  // workspace for the same subject.
  const key = JSON.stringify([identity.subject, identity.workspaceId, clientKey]);
  const existing = await findRecord(db, identity.tenantId, scope, key);
  if (existing) return toOutcome<T>(existing, true);

  const fresh = await fn();
  const inserted = await insertRecordIfAbsent(db, identity.tenantId, scope, key, fresh.status, fresh.body);
  if (inserted) return { ...fresh, replayed: false };

  // Lost the insert race -- see the caveat in the module doc comment.
  const winner = await findRecord(db, identity.tenantId, scope, key);
  return winner ? toOutcome<T>(winner, true) : { ...fresh, replayed: false };
}
