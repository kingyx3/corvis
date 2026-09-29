import assert from "node:assert/strict";
import test from "node:test";
import { PostgresDriverError } from "./postgres-native.ts";
import { SQL_APPLICATION_ERRORS, matchSqlApplicationError, sqlApplicationErrorOf } from "./sql-application-errors.ts";

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

test("every allowlisted fragment is authored in the SQL migrations", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = new URL("../../db/postgres/migrations/", import.meta.url);
  const sql = readdirSync(dir).filter((name) => name.endsWith(".sql")).map((name) => readFileSync(new URL(name, dir), "utf8")).join("\n");
  for (const fragment of SQL_APPLICATION_ERRORS) assert.ok(sql.includes(fragment), `no migration raises "${fragment}"`);
});
