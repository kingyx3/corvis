import assert from "node:assert/strict";
import test from "node:test";
import type { ExportScope } from "../../core/delivery.ts";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { createPhysicalExport } from "./physical-exports.ts";
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
        { snapshot_id: "snap-a", schema_version: "v2", taxonomy_version: "v3", fund_id: "fund-a", version: 3, blocking_exception_count: 0 },
        { snapshot_id: "snap-b", schema_version: "v2", taxonomy_version: "v3", fund_id: "fund-b", version: 1, blocking_exception_count: 2 },
      ];
    }
    if (sql.includes("from corvis_serving.observations")) return [{ row_count: 7 }];
    return [];
  });
  const manifest = await createPhysicalExport(identity, "csv", undefined, db);
  assert.deepEqual(manifest.snapshotIds, ["snap-a", "snap-b"]);
  assert.equal(manifest.rowCounts.observations, 7);
  assert.equal(manifest.rowCounts.snapshots, 2);
  assert.equal(manifest.source, "delivery", "an unlabeled request is a full-tenant Data delivery request");
  assert.deepEqual(manifest.snapshotState, [
    { snapshotId: "snap-a", version: 3, openExceptionCount: 0 },
    { snapshotId: "snap-b", version: 1, openExceptionCount: 2 },
  ], "each exported snapshot's published version and open-exception count travels with the manifest (#182 D16)");
});

test("a scoped export (e.g. 'export this view' from Review) is restricted to exactly the requested, already-entitled snapshot", async () => {
  const db = new FakeDb((sql, parameters) => {
    if (sql.includes("from corvis_serving.fund_period_snapshots")) {
      assert.match(sql, /and snapshot_id::text=\$3/);
      assert.deepEqual(parameters, [identity.tenantId, JSON.stringify(identity.entitlements.fundIds), "snap-a"]);
      return [{ snapshot_id: "snap-a", schema_version: "v2", taxonomy_version: "v3", fund_id: "fund-a", version: 2, blocking_exception_count: 1 }];
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
  const manifest = await createPhysicalExport(identity, "csv", { scope, source: "review" }, db);
  assert.deepEqual(manifest.snapshotIds, ["snap-a"]);
  assert.equal(manifest.rowCounts.observations, 3);
  assert.equal(manifest.rowCounts.snapshots, 1);
  assert.equal(manifest.source, "review");
  assert.deepEqual(manifest.snapshotState, [{ snapshotId: "snap-a", version: 2, openExceptionCount: 1 }]);
});

test("a Position Financials export persists the exact view scope and pins it to matching published snapshots", async () => {
  const db = new FakeDb((sql, parameters) => {
    if (sql.includes("select v.*") && sql.includes("position_financial_statement_values")) {
      assert.match(sql, /v\.fund_id=\$5/);
      return [{
        statement_id: "statement-1", document_id: "doc-1", fund_id: "fund-a", holding_id: "holding-1", company_id: "company-1",
        statement_type: "income_statement", statement_key: "is", report_period: "2026-Q2", line_id: "line-1", line_key: "revenue",
        semantic_line_key: "revenue", source_label: "Revenue", line_role: "line", display_order: 1, depth: 0,
        value_id: "value-1", value_number: "100", period_type: "quarter", fiscal_year: 2026, fiscal_quarter: 2,
        source_reference_ids: ["source-1"],
      }];
    }
    if (sql.includes("select distinct ps.snapshot_id") && sql.includes("position_financial_statement_values")) {
      assert.equal(parameters[4], "fund-a");
      assert.equal(parameters[5], "holding-1");
      assert.equal(parameters[6], "company-1");
      return [{ snapshot_id: "snap-a", schema_version: "v2", taxonomy_version: "v3", fund_id: "fund-a", version: 5, blocking_exception_count: 0 }];
    }
    return [];
  });
  const scope: ExportScope = { positionFinancials: { fundId: "fund-a", holdingId: "holding-1", companyId: "company-1", periodicity: "quarterly" } };
  const manifest = await createPhysicalExport(identity, "csv", { scope, source: "delivery" }, db);
  const governed = manifest as typeof manifest & { scope?: ExportScope; scopeLabel?: string };
  assert.deepEqual(manifest.snapshotIds, ["snap-a"]);
  assert.equal(manifest.rowCounts.positionFinancials, 1);
  assert.deepEqual(governed.scope, scope);
  assert.match(governed.scopeLabel ?? "", /Position financials.*company-1.*quarterly/);
  assert.deepEqual(manifest.snapshotState, [{ snapshotId: "snap-a", version: 5, openExceptionCount: 0 }]);
});

test("a scope naming data the caller is not entitled to (or that isn't published) fails closed instead of exporting every entitled snapshot", async () => {
  const db = new FakeDb(() => []);
  await assert.rejects(
    createPhysicalExport(identity, "csv", { scope: { snapshotId: "not-mine" } }, db),
    (error: unknown) => error instanceof Error && error.name === "AuthorizationError",
  );
});
