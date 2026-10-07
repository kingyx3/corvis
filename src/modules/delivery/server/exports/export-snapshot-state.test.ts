import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../../../shared/domain/enterprise.ts";
import type { PostgresPrimitive, PostgresSqlApi } from "../../../../platform/database/postgres.ts";
import { assertExportSnapshotVersions, ExportSnapshotChangedError } from "./export-snapshot-state.ts";

const identity = { tenantId: "t", entitlements: { fundIds: ["f"] } } as RequestIdentity;
const pin = { snapshotId: "s", version: 1 };
const store = (query: PostgresSqlApi["query"]): PostgresSqlApi => ({ query, async execute() {}, async health() { return true; } });

test("empty exports need no snapshot check; incomplete, duplicate or invalid pins fail closed before SQL", async () => {
  const db = store(async () => { throw new Error("must not query"); });
  await assertExportSnapshotVersions(identity, [], undefined, db);
  for (const state of [undefined, null, {}, [], [null], [{}], [{ ...pin, snapshotId: 1 }], [{ ...pin, snapshotId: "other" }],
    [{ ...pin, version: 0 }], [{ ...pin, version: -1 }], [{ ...pin, version: 1.5 }], [{ ...pin, version: "1" }], [{ ...pin, version: 2_147_483_648 }]]) {
    await assert.rejects(assertExportSnapshotVersions(identity, ["s"], state, db), (error: unknown) =>
      error instanceof ExportSnapshotChangedError && error.retryable === false && error.code === "export_snapshot_authorization_expired");
  }
  await assert.rejects(assertExportSnapshotVersions(identity, ["s", "s"], [pin, pin], db), ExportSnapshotChangedError);
  await assert.rejects(assertExportSnapshotVersions(identity, ["s", "other"], [pin, pin], db), ExportSnapshotChangedError);
});

test("the version check binds exact versions, tenant and current fund rights and requires every snapshot", async () => {
  let parameters: PostgresPrimitive[] = [];
  const db = store(async (sql, args = []) => {
    parameters = args;
    assert.match(sql, /s\.version=pin\.version/);
    assert.match(sql, /s\.tenant_id=\$1::uuid and s\.status='published'/);
    assert.match(sql, /newer\.version>s\.version/);
    assert.match(sql, /s\.fund_id in/);
    return [{ snapshot_count: "1" }];
  });
  await assertExportSnapshotVersions(identity, ["s"], [pin], db);
  assert.deepEqual(parameters, ["t", '["s"]', '["f"]', JSON.stringify([pin])]);
  await assertExportSnapshotVersions({ ...identity, entitlements: { workspaceIds: [], sourceDocumentAccessAllowed: false } }, ["s"], [pin], db);
  assert.equal(parameters[2], "[]");
  for (const rows of [[], [{ snapshot_count: 0 }]]) {
    await assert.rejects(assertExportSnapshotVersions(identity, ["s"], [pin], store(async () => rows)), ExportSnapshotChangedError);
  }
  await assert.rejects(assertExportSnapshotVersions(identity, ["s"], [pin], store(async () => { throw new Error("database_unavailable"); })), /database_unavailable/);
});
