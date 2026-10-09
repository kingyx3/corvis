import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  SESSION_ACTIVITY_PURGE_LIMIT,
  SESSION_ACTIVITY_RETENTION_FLOOR_MINUTES,
  SESSION_ACTIVITY_RETENTION_MINUTES,
  SESSION_MAX_LENGTH_BOUNDS,
} from "../../domain/session-policy.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "../../../../platform/database/postgres.ts";
import { sweepTenantSessionActivity } from "./session-activity-sweep.ts";

function recordingDb(purged: unknown) {
  const calls: { sql: string; parameters: PostgresPrimitive[] }[] = [];
  const db: PostgresSqlApi = {
    query: async (sql: string, parameters: PostgresPrimitive[] = []) => {
      calls.push({ sql, parameters });
      return purged === undefined ? [] : [{ purged } as PostgresRow];
    },
    execute: async () => { throw new Error("the sweep calls the purge function through query() so it can count rows"); },
    health: async () => true,
  };
  return { db, calls };
}

function captureLogs(t: test.TestContext) {
  const lines: Array<Record<string, unknown>> = [];
  t.mock.method(console, "info", (line: unknown) => { lines.push(JSON.parse(String(line)) as Record<string, unknown>); });
  return lines;
}

test("the retention outlasts the longest session a limit can measure, with a margin", () => {
  assert.equal(SESSION_MAX_LENGTH_BOUNDS.max, 10080, "the longest allowed maximum session is 7 days");
  assert.equal(SESSION_ACTIVITY_RETENTION_FLOOR_MINUTES, 10080 + 1440);
  assert.ok(SESSION_ACTIVITY_RETENTION_MINUTES > SESSION_ACTIVITY_RETENTION_FLOOR_MINUTES);
  assert.equal(SESSION_ACTIVITY_RETENTION_MINUTES, 90 * 24 * 60);
});

test("the sweep calls the purge function once with the default retention and a bounded batch, and logs how many it removed", async (t) => {
  const lines = captureLogs(t);
  const { db, calls } = recordingDb(7);
  assert.equal(await sweepTenantSessionActivity(db), 7);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /select corvis_control\.purge_tenant_session_activity\(\$1::integer,\$2::integer\) as purged/);
  assert.deepEqual(calls[0]!.parameters, [SESSION_ACTIVITY_RETENTION_MINUTES, SESSION_ACTIVITY_PURGE_LIMIT]);

  const logged = lines.find((line) => line.event === "session_activity.purged")!;
  assert.deepEqual([logged.level, logged.purged, logged.retentionMinutes, logged.fullBatch], ["info", 7, SESSION_ACTIVITY_RETENTION_MINUTES, false]);
  const counted = lines.find((line) => line.event === "metric.count" && line.metric === "session_activity.purged")!;
  assert.equal(counted.value, 7);
  for (const line of lines) assert.doesNotMatch(JSON.stringify(line), /subject|session_id|sessionId/, "counts only: never a person or a session");
});

test("a full batch is reported as such, and nothing is logged when nothing was removed", async (t) => {
  const lines = captureLogs(t);
  const full = recordingDb(25);
  assert.equal(await sweepTenantSessionActivity(full.db, { limit: 25 }), 25);
  assert.equal(lines.find((line) => line.event === "session_activity.purged")!.fullBatch, true, "more remain for the next tick");

  lines.length = 0;
  for (const answer of [0, undefined, null]) {
    const idle = recordingDb(answer);
    assert.equal(await sweepTenantSessionActivity(idle.db), 0);
  }
  assert.deepEqual(lines, [], "an idle tick is silent");
});

test("a caller can lengthen the retention but never shorten it below the floor, and the batch is clamped", async () => {
  const longer = recordingDb(0);
  await sweepTenantSessionActivity(longer.db, { retentionMinutes: 200_000.9, limit: 10 });
  assert.deepEqual(longer.calls[0]!.parameters, [200_000, 10]);

  const shorter = recordingDb(0);
  await sweepTenantSessionActivity(shorter.db, { retentionMinutes: 60, limit: 10 * SESSION_ACTIVITY_PURGE_LIMIT });
  assert.deepEqual(shorter.calls[0]!.parameters, [SESSION_ACTIVITY_RETENTION_FLOOR_MINUTES, SESSION_ACTIVITY_PURGE_LIMIT], "a session a limit is still judging is never purged; the batch never exceeds the cap");

  const nonsense = recordingDb(0);
  await sweepTenantSessionActivity(nonsense.db, { retentionMinutes: Number.NaN, limit: 0 });
  assert.deepEqual(nonsense.calls[0]!.parameters, [SESSION_ACTIVITY_RETENTION_MINUTES, 1]);
});

test("a database failure propagates so the delivery tick reports the task as failed", async () => {
  const db: PostgresSqlApi = { query: async () => { throw new Error("postgres unavailable"); }, execute: async () => {}, health: async () => true };
  await assert.rejects(sweepTenantSessionActivity(db), /postgres unavailable/);
});

test("the scheduled delivery tick runs the session activity sweep as its own settled task", async () => {
  const route = (await readFile("src/app/api/internal/delivery/route.ts", "utf8")).replace(/\s+/g, " ");
  assert.match(route, /import \{ sweepTenantSessionActivity \} from "@\/modules\/identity-access\/server\/sessions\/session-activity-sweep";/);
  assert.match(route, /sessionActivitySweep:\(\)=>sweepTenantSessionActivity\(\)/);
});

test("the purge retains its retention floor and preserves policy expiry in the revocation ledger", async () => {
  const migration = await readFile("db/postgres/migrations/004_session_activity_expiry_revocation.sql", "utf8");
  const start = migration.indexOf("create or replace function corvis_control.purge_tenant_session_activity(");
  assert.ok(start >= 0, "purge_tenant_session_activity must be defined in the expiry migration");
  const body = migration.slice(start, migration.indexOf("\n$$;", start));
  assert.match(body, new RegExp(`p_retention_minutes < ${SESSION_ACTIVITY_RETENTION_FLOOR_MINUTES}`), "the SQL floor is the same number as src/modules/identity-access/domain/session-policy.ts");
  assert.match(body, /insert into corvis_control\.session_revocation/);
  assert.match(body, /on conflict \(tenant_id, auth_method, subject, session_id\) do nothing/);
  assert.doesNotMatch(body, /(?:delete from|update) corvis_control\.session_revocation/i);
});
