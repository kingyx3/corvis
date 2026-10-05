import test from "node:test";
import assert from "node:assert/strict";
import { enforceRequestRateLimit } from "./distributed-rate-limit.ts";
import { RateLimitError } from "./rate-limit.ts";
import type { PostgresSqlApi } from "./postgres.ts";
import { PostgresDriverError } from "./postgres-native.ts";
import { AuthenticationError } from "./request-context.ts";

function database(query: PostgresSqlApi["query"]): PostgresSqlApi {
  return { query, execute: async () => {}, health: async () => true };
}

test("distributed limiter sends separately bound tenant and subject to the atomic database function", async () => {
  const calls: unknown[] = [];
  const db = database(async (sql, parameters) => {
    calls.push([sql, parameters]);
    return [{ allowed: true, retry_after_seconds: 60 }];
  });
  await enforceRequestRateLimit("tenant-a", "service:x", { db });
  assert.deepEqual(calls, [[
    "select allowed, retry_after_seconds from corvis_control.consume_api_rate_limit($1::uuid,$2,$3)",
    ["tenant-a", "service:x", 600],
  ]]);
});

test("database denial preserves Retry-After", async () => {
  await assert.rejects(enforceRequestRateLimit("a", "b", {
    db: database(async () => [{ allowed: false, retry_after_seconds: 37 }]),
  }), (error: unknown) => error instanceof RateLimitError && error.retryAfterSeconds === 37);
});

test("database outage and malformed decisions fail closed", async () => {
  const failure = new Error("database unavailable");
  await assert.rejects(enforceRequestRateLimit("a", "b", {
    db: database(async () => { throw failure; }),
  }), failure);
  for (const rows of [[], [{ allowed: "true" }], [{ allowed: false, retry_after_seconds: 0 }]]) {
    await assert.rejects(enforceRequestRateLimit("a", "b", { db: database(async () => rows) }));
  }
});

test("an unknown or malformed tenant selector is an authentication failure, not a 500", async () => {
  for (const code of ["23503", "22P02", "23514"]) {
    await assert.rejects(enforceRequestRateLimit("00000000-0000-4000-8000-000000000000", "user-1", {
      db: database(async () => { throw new PostgresDriverError("query", code); }),
    }), (error: unknown) => error instanceof AuthenticationError);
  }
  // Any other driver failure still fails closed as an internal error.
  await assert.rejects(enforceRequestRateLimit("00000000-0000-4000-8000-000000000000", "user-1", {
    db: database(async () => { throw new PostgresDriverError("connection", "ECONNREFUSED"); }),
  }), (error: unknown) => error instanceof PostgresDriverError);
});
