import { createHash } from "node:crypto";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { postgres, withTransaction, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";

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
 * Usage: `withIdempotency(identity, scope, clientKey, fn)`, where `fn` receives
 * the transaction handle the record is written on (see "Atomicity" below).
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
 * Atomicity: when a key is supplied, `withIdempotency` opens one transaction
 * (`withTransaction`), hands its handle to `fn`, and inserts the idempotency
 * record on that same handle after `fn` returns. A handler that runs its work
 * on the handle -- `runAuditedMutation({ db: tx, ... })` joins the caller's
 * transaction instead of opening its own -- therefore commits the mutation,
 * its audit row and the idempotency record together or not at all:
 *
 *  - If the record insert (or the commit) fails, or the process dies before
 *    the commit, the mutation rolls back with it. The client sees a 5xx or a
 *    timeout, and a retry with the same key re-runs from scratch instead of
 *    hitting a spurious version conflict or creating a duplicate job.
 *  - If the commit succeeded, the record exists, so a retry replays the stored
 *    response without re-running the mutation.
 *
 * This needs a transport that supports transactions (the native Postgres
 * client). On the stateless HTTP transport `withTransaction` degrades to
 * running without one -- exactly as `runAuditedMutation` already does -- so
 * there the mutation and the record are separate statements, as they always
 * were. A handler that ignores the handle (opens its own transaction, or is an
 * in-memory demo-mode mutation) is likewise outside the atomic unit: the
 * record is still written, but after the handler has committed, and a crash in
 * that window leaves an unrecorded mutation. Only the lookup that decides
 * between replay and execution runs outside the transaction, so a replay never
 * holds a connection open.
 *
 * Concurrent requests: if two requests with the same brand-new key both pass
 * the lookup, both invoke `fn`, but the primary key admits one record. The
 * loser's insert waits for the winner's transaction, then is rejected; the
 * loser's transaction is rolled back (its mutation and audit row are
 * discarded) and it returns the winner's stored response with
 * `replayed: true`. Without a real transaction (HTTP transport) the loser's
 * `fn` has already committed and cannot be undone, so `fn` may have run twice
 * while every caller still converges on one stored response. The call sites
 * carry an independent safeguard there too: reconciliation resolution and
 * sector assignment are protected by their `expectedVersion`
 * optimistic-concurrency check at the database, which fails the loser of any
 * real race (that loser surfaces the conflict, as errors are never cached),
 * and exports create a fresh row per call (a duplicate is a duplicate export
 * job, not a corrupted one).
 */

export interface IdempotentOutcome<T> {
  status: number;
  body: T;
  /** True when this response came from a previously stored attempt rather than a fresh call to `fn`. */
  replayed: boolean;
}

export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

export class IdempotencyKeyReuseError extends Error {
  readonly code = "idempotency_key_reused";
  constructor() {
    super("idempotency_key_reused");
    this.name = "IdempotencyKeyReuseError";
  }
}

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

/** Deterministic JSON: object keys sorted, `undefined` members dropped. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([name, member]) => `${JSON.stringify(name)}:${canonicalJson(member)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Hash stored in `idempotency_key.request_hash`. Without a caller-supplied
 * `fingerprint` it covers only `(scope, key)`, the form every row written
 * before payload binding carries. With one it also covers the canonical
 * request content, so the same key reused for a different request is
 * detected rather than silently replaying the first response.
 */
function requestHash(scope: string, key: string, fingerprint?: unknown): string {
  const base = `${scope}:${key}`;
  return createHash("sha256").update(fingerprint === undefined ? base : `${base}:${canonicalJson(fingerprint)}`).digest("hex");
}

function assertSameRequest(row: PostgresRow, scope: string, key: string, fingerprint: unknown): void {
  if (fingerprint === undefined) return;
  const stored = typeof row.request_hash === "string" ? row.request_hash : undefined;
  // A missing hash (fakes, legacy) and rows stored before payload binding
  // still replay; only a positively different payload is refused.
  if (!stored || stored === requestHash(scope, key, fingerprint) || stored === requestHash(scope, key)) return;
  throw new IdempotencyKeyReuseError();
}

function parseResponseBody(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

async function findRecord(db: PostgresSqlApi, tenantId: string, scope: string, key: string): Promise<PostgresRow | undefined> {
  const rows = await db.query(
    `select response_status, response_body, request_hash from corvis_control.idempotency_key
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
  fingerprint: unknown,
): Promise<PostgresRow | undefined> {
  const rows = await db.query(
    `insert into corvis_control.idempotency_key
        (tenant_id, scope, idempotency_key, request_hash, response_status, response_body, expires_at)
      values ($1,$2,$3,$4,$5,$6::jsonb, now() + make_interval(secs => $7))
      on conflict (tenant_id, scope, idempotency_key) do nothing
      returning response_status, response_body, request_hash`,
    [tenantId, scope, key, requestHash(scope, key, fingerprint), status, JSON.stringify(body ?? null), Math.floor(IDEMPOTENCY_RECORD_TTL_MS / 1000)],
  );
  return rows[0];
}

function toOutcome<T>(row: PostgresRow, replayed: boolean): IdempotentOutcome<T> {
  return { status: Number(row.response_status), body: parseResponseBody(row.response_body) as T, replayed };
}

/** Thrown inside the transaction to roll it back when the record insert lost the race to another request. */
class LostInsertRace<T> extends Error {
  readonly fresh: { status: number; body: T };
  constructor(fresh: { status: number; body: T }) {
    super("idempotency_insert_lost");
    this.fresh = fresh;
  }
}

/**
 * Runs `fn` at most once per `(identity.tenantId, scope, clientKey)`. See the
 * module doc comment above for the full replay, namespacing, atomicity and
 * failure-handling contract. `fn` receives the transaction handle to run its
 * mutation on, or nothing when no key was supplied (no record is written, so
 * the handler uses its own connection exactly as before).
 */
export async function withIdempotency<T>(
  identity: RequestIdentity,
  scope: string,
  clientKey: string | undefined,
  fn: (tx?: PostgresSqlApi) => Promise<{ status: number; body: T }>,
  db: PostgresSqlApi = controlDb(),
  /** Canonical request content; reusing `clientKey` with a different value is refused with {@link IdempotencyKeyReuseError}. */
  fingerprint?: unknown,
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
  if (existing) {
    assertSameRequest(existing, scope, key, fingerprint);
    return toOutcome<T>(existing, true);
  }

  try {
    // The record is inserted on the same handle `fn` mutates through, so a
    // failed insert rolls the mutation back and a committed mutation always
    // has its record. An error from `fn` rolls back too and stores nothing.
    const fresh = await withTransaction(db, async (tx) => {
      const result = await fn(tx);
      const inserted = await insertRecordIfAbsent(tx, identity.tenantId, scope, key, result.status, result.body, fingerprint);
      if (!inserted) throw new LostInsertRace(result);
      return result;
    });
    return { ...fresh, replayed: false };
  } catch (error) {
    if (!(error instanceof LostInsertRace)) throw error;
    // Lost the insert race -- see "Concurrent requests" in the module doc comment.
    const winner = await findRecord(db, identity.tenantId, scope, key);
    if (winner) {
      assertSameRequest(winner, scope, key, fingerprint);
      return toOutcome<T>(winner, true);
    }
    // The winner's row is gone (swept or rolled back) before we could read it.
    // Without a real transaction our own result is already committed and is
    // returned as before; with one it was rolled back above, so fail
    // retryably rather than acknowledge work that did not persist.
    if (!db.transaction) return { ...(error as LostInsertRace<T>).fresh, replayed: false };
    throw new Error("idempotency_record_unavailable");
  }
}

/** Upper bound on one call to {@link sweepExpiredIdempotencyKeys}. */
export const IDEMPOTENCY_KEY_SWEEP_LIMIT = 5000;

/**
 * Deletes past-expiry rows from `corvis_control.idempotency_key`. Every row
 * carries its own `expires_at` (set at insert time, see
 * `insertRecordIfAbsent`), but until now nothing ever deleted an expired
 * row, so the table grew forever. Idempotency keys are not meaningfully
 * swept per-tenant -- an expired key can never be replayed regardless of
 * which tenant wrote it -- so this is a single global, bounded delete
 * (migration 049 adds the supporting index on `expires_at`), matching how
 * the export/webhook reclaim sweeps in this file's neighbors are also
 * tenant-agnostic. Bounded to `IDEMPOTENCY_KEY_SWEEP_LIMIT` rows per call so
 * it can never hold a long-running scan or lock.
 */
export async function sweepExpiredIdempotencyKeys(db: PostgresSqlApi = controlDb(), limit = IDEMPOTENCY_KEY_SWEEP_LIMIT): Promise<number> {
  const rows = await db.query(`delete from corvis_control.idempotency_key
    where ctid in (
      select ctid from corvis_control.idempotency_key
      where expires_at <= now()
      limit $1
    )
    returning tenant_id`,[limit]);
  return rows.length;
}
