import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { createPhysicalExport, type ExportScope } from "./physical-exports.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";

class FakeDb implements PostgresSqlApi {
  readonly queries: Array<{ sql: string; parameters: PostgresPrimitive[] }> = [];
  private readonly rowsFor: (sql: string, parameters: PostgresPrimitive[]) => PostgresRow[];
  constructor(rowsFor: (sql: string, parameters: PostgresPrimitive[]) => PostgresRow[]) { this.rowsFor = rowsFor; }
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.queries.push({ sql, parameters });
    return this.rowsFor(sql, parameters);
  }
  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> { this.queries.push({ sql, parameters }); }
  async health(): Promise<boolean> { return true; }
}

const identity: RequestIdentity = {
  subject: "user-1",
  tenantId: "tenant-1",
  workspaceId: "workspace-1",
  roles: ["analyst"],
  authMethod: "oidc",
  sessionId: "session-1",
  entitlements: {
    workspaceIds: ["workspace-1"],
    fundIds: ["fund-a", "fund-b"],
    documentIds: ["doc-1"],
    sourceDocumentAccessAllowed: true,
    redistributionAllowed: true,
  },
};

test("without a scope, every entitled fund's published snapshots are exported (existing behavior)", async () => {
  const db = new FakeDb((sql) => {
    if (sql.includes("from corvis_serving.fund_period_snapshots")) {
      assert.doesNotMatch(sql, /snapshot_id::text=/);
      return [
        { snapshot_id: "snap-a", schema_version: "v2", taxonomy_version: "v3", fund_id: "fund-a" },
        { snapshot_id: "snap-b", schema_version: "v2", taxonomy_version: "v3", fund_id: "fund-b" },
      ];
    }
    if (sql.includes("from corvis_serving.observations")) return [{ row_count: 7 }];
    return [];
  });
  const manifest = await createPhysicalExport(identity, "csv", undefined, db);
  assert.deepEqual(manifest.snapshotIds, ["snap-a", "snap-b"]);
  assert.equal(manifest.rowCounts.observations, 7);
  assert.equal(manifest.rowCounts.snapshots, 2);
});

test("a scoped export (e.g. 'export this view' from Review) is restricted to exactly the requested, already-entitled snapshot", async () => {
  const db = new FakeDb((sql, parameters) => {
    if (sql.includes("from corvis_serving.fund_period_snapshots")) {
      assert.match(sql, /and snapshot_id::text=\$3/);
      assert.deepEqual(parameters, [identity.tenantId, JSON.stringify(identity.entitlements.fundIds), "snap-a"]);
      return [{ snapshot_id: "snap-a", schema_version: "v2", taxonomy_version: "v3", fund_id: "fund-a" }];
    }
    if (sql.includes("from corvis_serving.observations")) {
      // The row-count preview must also narrow to the resolved snapshot's own
      // fund, not every fund the caller happens to be entitled to.
      assert.deepEqual(JSON.parse(String(parameters[1])), ["fund-a"]);
      return [{ row_count: 3 }];
    }
    return [];
  });
  const scope: ExportScope = { snapshotId: "snap-a" };
  const manifest = await createPhysicalExport(identity, "csv", scope, db);
  assert.deepEqual(manifest.snapshotIds, ["snap-a"]);
  assert.equal(manifest.rowCounts.observations, 3);
  assert.equal(manifest.rowCounts.snapshots, 1);
});

test("a scope naming a snapshot the caller is not entitled to (or that isn't published) fails closed instead of exporting every entitled snapshot", async () => {
  const db = new FakeDb(() => []);
  await assert.rejects(
    createPhysicalExport(identity, "csv", { snapshotId: "not-mine" }, db),
    (error: unknown) => error instanceof Error && error.name === "AuthorizationError",
  );
});
