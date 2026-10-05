import assert from "node:assert/strict";
import test from "node:test";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "../../../platform/database/postgres.ts";
import { SERVICE_ACCOUNT_EXPIRY_NOTICE_BATCH, sweepServiceAccountExpiry } from "./service-account-expiry-sweep.ts";

function recordingDb(queued: unknown) {
  const calls: { sql: string; parameters: PostgresPrimitive[] }[] = [];
  const db: PostgresSqlApi = {
    query: async (sql: string, parameters: PostgresPrimitive[] = []) => {
      calls.push({ sql, parameters });
      return queued === undefined ? [] : [{ queued } as PostgresRow];
    },
    execute: async () => { throw new Error("the sweep calls the queue function through query() so it can count rows"); },
    health: async () => true,
  };
  return { db, calls };
}

function captureLogs(t: test.TestContext) {
  const lines: Array<Record<string, unknown>> = [];
  t.mock.method(console, "info", (line: unknown) => { lines.push(JSON.parse(String(line)) as Record<string, unknown>); });
  return lines;
}

test("the sweep calls the queue function once with a bounded batch and logs only how many notices it queued", async (t) => {
  const lines = captureLogs(t);
  const { db, calls } = recordingDb(4);
  assert.equal(await sweepServiceAccountExpiry(db), 4);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /select corvis_control\.queue_service_account_expiry_notices\(\$1::integer\) as queued/);
  assert.deepEqual(calls[0]!.parameters, [SERVICE_ACCOUNT_EXPIRY_NOTICE_BATCH]);

  const logged = lines.find((line) => line.event === "service_account_expiry.queued")!;
  assert.deepEqual([logged.level, logged.queued, logged.fullBatch], ["info", 4, false]);
  assert.equal(lines.find((line) => line.event === "metric.count" && line.metric === "service_account_expiry.queued")!.value, 4);
  for (const line of lines) assert.doesNotMatch(JSON.stringify(line), /subject|account_id|accountId|credential_id|user/i, "a count only: never an account, a credential or a person");
});

test("a full batch is reported as such, and an idle tick is silent", async (t) => {
  const lines = captureLogs(t);
  assert.equal(await sweepServiceAccountExpiry(recordingDb(25).db, 25), 25);
  assert.equal(lines.find((line) => line.event === "service_account_expiry.queued")!.fullBatch, true, "more may be due on the next tick");

  lines.length = 0;
  for (const answer of [0, undefined, null]) assert.equal(await sweepServiceAccountExpiry(recordingDb(answer).db), 0);
  assert.deepEqual(lines, []);
});

test("the batch is clamped to the sweep's bound and never below one", async () => {
  const larger = recordingDb(0);
  await sweepServiceAccountExpiry(larger.db, 1_000_000);
  assert.deepEqual(larger.calls[0]!.parameters, [SERVICE_ACCOUNT_EXPIRY_NOTICE_BATCH]);
  const smaller = recordingDb(0);
  await sweepServiceAccountExpiry(smaller.db, -5);
  assert.deepEqual(smaller.calls[0]!.parameters, [1]);
  const fractional = recordingDb(0);
  await sweepServiceAccountExpiry(fractional.db, 7.9);
  assert.deepEqual(fractional.calls[0]!.parameters, [7]);
});

test("a failing database fails the task rather than hiding that no notice was queued", async () => {
  const db: PostgresSqlApi = { query: async () => { throw new Error("database unavailable"); }, execute: async () => undefined, health: async () => false };
  await assert.rejects(() => sweepServiceAccountExpiry(db), /database unavailable/);
});

test("the sweep is part of the private delivery tick", async () => {
  const { readFile } = await import("node:fs/promises");
  const route = await readFile(new URL("../../../app/api/internal/delivery/route.ts", import.meta.url), "utf8");
  assert.match(route, /import \{ sweepServiceAccountExpiry \} from "@\/modules\/identity-access\/server\/service-account-expiry-sweep"/);
  assert.match(route, /serviceAccountExpirySweep:\(\)=>sweepServiceAccountExpiry\(\)/);
});
