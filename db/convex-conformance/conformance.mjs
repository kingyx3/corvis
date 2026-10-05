// Executable oracle for the database semantics Corvis adapters must preserve.
// Run by run.sh against a live Convex backend (CONVEX_SELF_HOSTED_URL). All
// concurrent calls are issued from this one process so they genuinely overlap at
// the backend, unlike separate CLI processes whose start-up jitter can serialize
// them. db/postgres/tests/convex-parity.mjs asserts the same invariants against
// Corvis's PostgreSQL adapter; keep CONTENDERS and the scenarios in step.
import assert from "node:assert/strict";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

const url = process.env.CONVEX_SELF_HOSTED_URL;
assert.ok(url, "CONVEX_SELF_HOSTED_URL is required");
const CONTENDERS = 16;
const client = new ConvexHttpClient(url);
const { conformance } = anyApi;

async function rejectsWith(promise, pattern) {
  try {
    await promise;
  } catch (error) {
    assert.match(String(error?.message ?? error), pattern, "mutation failed for the wrong reason");
    return;
  }
  assert.fail("mutation unexpectedly succeeded");
}

// 1. Concurrent compare-and-set: exactly one winner, exactly one event.
await client.mutation(conformance.reset, { key: "race" });
const outcomes = await Promise.all(
  Array.from({ length: CONTENDERS }, () => client.mutation(conformance.compareAndSet, { key: "race", expected: 0, next: 1 })),
);
assert.ok(outcomes.every((outcome) => typeof outcome === "boolean"), `unexpected compare-and-set results: ${JSON.stringify(outcomes)}`);
assert.equal(outcomes.filter(Boolean).length, 1, "exactly one compare-and-set may win");
assert.deepEqual(await client.query(conformance.summary, { key: "race" }), { version: 1, events: 1 });

// 2. No lost updates: unlocked read-modify-write from many writers still ends at N.
await client.mutation(conformance.reset, { key: "counter" });
await Promise.all(Array.from({ length: CONTENDERS }, () => client.mutation(conformance.increment, { key: "counter" })));
assert.equal(await client.query(conformance.counterValue, { key: "counter" }), CONTENDERS, "concurrent increments lost an update");

// 3. Failed mutations are atomic: neither inserts nor patches survive a throw.
await client.mutation(conformance.reset, { key: "rollback" });
await rejectsWith(client.mutation(conformance.writeThenFail, { key: "rollback" }), /intentional conformance rollback/);
await rejectsWith(client.mutation(conformance.patchThenFail, { key: "rollback" }), /intentional conformance rollback/);
assert.deepEqual(await client.query(conformance.summary, { key: "rollback" }), { version: 0, events: 0 }, "failed mutation left partial state");

console.log(`Convex conformance passed: ${CONTENDERS} contenders, one CAS winner, no lost updates, failed mutations rolled back.`);
