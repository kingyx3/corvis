import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { EXPORT_GRANT_RETENTION_DAYS, EXPORT_GRANT_SWEEP_LIMIT, sweepExpiredExportDownloadGrants } from "./export-grant-sweep.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";

function recordingDb(returned: number) {
  const calls: { sql: string; parameters: PostgresPrimitive[] }[] = [];
  const db: PostgresSqlApi = {
    query: async (sql: string, parameters: PostgresPrimitive[] = []) => {
      calls.push({ sql, parameters });
      return Array.from({ length: returned }, (_, index) => ({ grant_id: `g-${index}` })) as PostgresRow[];
    },
    execute: async () => { throw new Error("the sweep must delete via query() so it can count rows"); },
    health: async () => true,
  };
  return { db, calls };
}

test("the sweep issues one bounded, tenant-agnostic delete of grants expired beyond the retention window", async () => {
  const { db, calls } = recordingDb(3);
  assert.equal(await sweepExpiredExportDownloadGrants(db, { retentionDays: 14, limit: 250 }), 3);
  assert.equal(calls.length, 1);
  const sql = calls[0]!.sql.replace(/\s+/g, " ");
  assert.match(sql, /^delete from corvis_serving\.export_download_grant where ctid in \( select ctid from corvis_serving\.export_download_grant where expires_at < now\(\) - make_interval\(days => \$1\) order by expires_at limit \$2 \)/);
  assert.doesNotMatch(sql, /tenant_id\s*=/);
  assert.doesNotMatch(sql, /consumed_at/, "an expired grant is removable whether or not it was redeemed");
  assert.deepEqual(calls[0]!.parameters, [14, 250]);
});

test("the sweep defaults to a week of retention and a bounded batch, and clamps caller options", async () => {
  const defaults = recordingDb(0);
  assert.equal(await sweepExpiredExportDownloadGrants(defaults.db), 0);
  assert.deepEqual(defaults.calls[0]!.parameters, [EXPORT_GRANT_RETENTION_DAYS, EXPORT_GRANT_SWEEP_LIMIT]);
  assert.equal(EXPORT_GRANT_RETENTION_DAYS, 7);

  const clamped = recordingDb(0);
  await sweepExpiredExportDownloadGrants(clamped.db, { retentionDays: 0, limit: 10 * EXPORT_GRANT_SWEEP_LIMIT });
  assert.deepEqual(clamped.calls[0]!.parameters, [1, EXPORT_GRANT_SWEEP_LIMIT], "a grant is never swept before it expired; the batch never exceeds the cap");
  const floor = recordingDb(0);
  await sweepExpiredExportDownloadGrants(floor.db, { limit: 0 });
  assert.deepEqual(floor.calls[0]!.parameters, [EXPORT_GRANT_RETENTION_DAYS, 1]);
});

test("a database failure propagates so the delivery tick reports the task as failed", async () => {
  const db: PostgresSqlApi = { query: async () => { throw new Error("postgres unavailable"); }, execute: async () => {}, health: async () => true };
  await assert.rejects(sweepExpiredExportDownloadGrants(db), /postgres unavailable/);
});

test("the scheduled delivery tick runs the export grant sweep as its own settled task", async () => {
  const route = (await readFile("app/api/internal/delivery/route.ts", "utf8")).replace(/\s+/g, " ");
  assert.match(route, /import \{ sweepExpiredExportDownloadGrants \} from "@\/lib\/server\/export-grant-sweep";/);
  assert.match(route, /exportGrantSweep:\(\)=>sweepExpiredExportDownloadGrants\(\)/);
});
