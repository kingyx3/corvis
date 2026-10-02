import assert from "node:assert/strict";
import test from "node:test";
import { PostgresDriverError } from "./postgres-native.ts";
import { SQL_APPLICATION_ERRORS, adminSqlErrorClassification, matchSqlApplicationError, sqlApplicationErrorOf } from "./sql-application-errors.ts";

test("only an allowlisted fragment of a raised SQL message is surfaced", () => {
  assert.equal(matchSqlApplicationError(new Error("invitation_expired")), "invitation_expired");
  assert.equal(
    matchSqlApplicationError(new Error("dead-letter recovery requires an exhausted job; use normal retry before exhaustion")),
    "requires an exhausted job",
  );
  // Unknown text (which could embed data) is never carried.
  assert.equal(matchSqlApplicationError(new Error('duplicate key value violates unique constraint "x" Key (email)=(a@b.c)')), undefined);
  assert.equal(matchSqlApplicationError("not an error"), undefined);
});

test("driver errors expose the allowlisted code but never the raw message", () => {
  const raised = new PostgresDriverError("query", "P0001", "invitation_expired");
  assert.equal(raised.applicationError, "invitation_expired");
  assert.equal(raised.message, "Postgres query failed (SQLSTATE P0001)");
  assert.equal(sqlApplicationErrorOf(raised), "invitation_expired");
  // A driver error without a match must not fall back to its generic message.
  assert.equal(sqlApplicationErrorOf(new PostgresDriverError("query", "23505")), "");
  // Non-native drivers and fakes keep raw-message matching.
  assert.equal(sqlApplicationErrorOf(new Error("invitation_not_pending")), "invitation_not_pending");
});

test("a non-driver value without a carried code falls back to its message or string form", () => {
  assert.equal(sqlApplicationErrorOf("plain failure text"), "plain failure text");
  assert.equal(sqlApplicationErrorOf(undefined), "undefined");
  assert.equal(sqlApplicationErrorOf(null), "null");
  assert.equal(sqlApplicationErrorOf(42), "42");
  // An object that is neither an Error nor a driver error is stringified, not mined for a message.
  assert.equal(sqlApplicationErrorOf({ message: "invitation_expired" }), "[object Object]");
  // A carried code wins over the message, and a non-string carried code is ignored.
  assert.equal(sqlApplicationErrorOf(Object.assign(new Error("raw"), { applicationError: "invitation_expired" })), "invitation_expired");
  assert.equal(sqlApplicationErrorOf(Object.assign(new Error("raw"), { applicationError: 7 })), "raw");
});

test("every allowlisted fragment is authored in the SQL migrations", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = new URL("../../db/postgres/migrations/", import.meta.url);
  const sql = readdirSync(dir).filter((name) => name.endsWith(".sql")).map((name) => readFileSync(new URL(name, dir), "utf8")).join("\n");
  for (const fragment of SQL_APPLICATION_ERRORS) assert.ok(sql.includes(fragment), `no migration raises "${fragment}"`);
});

test("every allowlisted fragment is matched as itself, never shadowed by a shorter earlier fragment", () => {
  // The first contained fragment wins, so a fragment that contains another must come first.
  for (const fragment of SQL_APPLICATION_ERRORS) assert.equal(matchSqlApplicationError(new Error(fragment)), fragment);
});

test("admin identity, access-policy and support-access fragments classify to a client error status", () => {
  const adminFragments = SQL_APPLICATION_ERRORS.filter((fragment) => adminSqlErrorClassification(new Error(fragment)));
  assert.ok(adminFragments.length >= 30);
  for (const fragment of adminFragments) {
    const outcome = adminSqlErrorClassification(new Error(fragment))!;
    assert.ok(outcome.status >= 400 && outcome.status < 500, fragment);
    assert.match(outcome.code, /^[a-z_]+$/);
  }
  // Invitation and dead-letter fragments are mapped by their own callers.
  assert.equal(adminSqlErrorClassification(new Error("invitation_expired")), undefined);
  assert.equal(adminSqlErrorClassification(new PostgresDriverError("query", "P0001")), undefined);
  assert.equal(adminSqlErrorClassification(new Error("something unrelated")), undefined);
});

test("data-correction refusals classify to stable conflict codes instead of surfacing as server errors", () => {
  const expected: Record<string, string> = {
    "idempotency key reused with different correction scope": "idempotency_key_reused",
    "correction incident is not replayable": "correction_incident_not_replayable",
    "correction incident abc has no retained source document to replay": "correction_incident_no_source_document",
    "correction incident is not resolvable": "correction_incident_not_resolvable",
    "replacement snapshot must already be published": "replacement_snapshot_not_published",
    "replacement snapshot scope does not match correction incident": "replacement_snapshot_scope_mismatch",
    "active data correction incident blocks publication": "publication_blocked_by_correction",
  };
  for (const [message, code] of Object.entries(expected)) {
    assert.deepEqual(adminSqlErrorClassification(new Error(message)), { code, status: 409 }, message);
    // The native driver carries only the allowlisted fragment, never the raw message.
    const fragment = matchSqlApplicationError(new Error(message));
    assert.ok(fragment, message);
    assert.deepEqual(adminSqlErrorClassification(new PostgresDriverError("query", "P0001", fragment)), { code, status: 409 }, `driver: ${message}`);
  }
});
