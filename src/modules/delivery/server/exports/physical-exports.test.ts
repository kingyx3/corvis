import assert from "node:assert/strict";
import test from "node:test";
import type { ExportScope } from "../../domain/delivery.ts";
import type { RequestIdentity } from "../../../../shared/domain/enterprise.ts";
import { createPhysicalExport, exportStatusFromJob, redeemPhysicalExportGrant, restorePhysicalExportGrant } from "./physical-exports.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "../../../../platform/database/postgres.ts";

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
      assert.match(sql, /and s\.snapshot_id::text=\$3/);
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

test("a download grant is single use: redemption consumes it atomically and a replay matches nothing", async () => {
  let consumed = false;
  const db = new FakeDb((sql) => {
    if (!sql.startsWith("update corvis_serving.export_download_grant")) return [];
    assert.match(sql, /g\.consumed_at is null/);
    assert.match(sql, /set consumed_at=now\(\)/);
    if (consumed) return [];
    consumed = true;
    return [{ object_uri: "gs://b/exports/t/e/attempt-1/observations.csv", format: "csv", checksum_sha256: "a".repeat(64), snapshot_ids: [], manifest: { snapshotIds: [], artifact: { fundIds: ["fund-a"], documentIds: ["doc-1"] } } }];
  });
  const first = await redeemPhysicalExportGrant(identity, "00000000-0000-4000-8000-000000000001", "token", db);
  assert.equal(first?.format, "csv");
  assert.equal(await redeemPhysicalExportGrant(identity, "00000000-0000-4000-8000-000000000001", "token", db), null, "replaying the same token must fail");
  assert.equal(db.queries.filter((call) => call.sql.startsWith("select")).length, 0, "validation and consumption are one statement, not check-then-mark");
});

test("a consumed grant is restored only for the same tenant, export, subject and token, and never once expired", async () => {
  const db = new FakeDb(() => []);
  await restorePhysicalExportGrant(identity, "00000000-0000-4000-8000-000000000001", "token", db);
  const restore = db.queries.find((call) => call.sql.startsWith("update corvis_serving.export_download_grant"))!;
  assert.match(restore.sql, /set consumed_at=null/);
  for (const predicate of [/tenant_id=\$1/, /subject=\$3/, /token_sha256=\$4/, /consumed_at is not null/, /expires_at>now\(\)/]) assert.match(restore.sql, predicate);
  assert.equal(restore.parameters[2], identity.subject);
  const before = db.queries.length;
  await restorePhysicalExportGrant(identity, "00000000-0000-4000-8000-000000000001", "", db);
  await restorePhysicalExportGrant(identity, "00000000-0000-4000-8000-000000000001", "x".repeat(257), db);
  assert.equal(db.queries.length, before, "a missing or oversized token never reaches the database");
});

const NEWER_VERSION_GUARD = /not exists \(\s*select 1 from corvis_(?:serving\.fund_period_snapshots|consolidated\.fund_period_snapshot) newer\s*where newer\.tenant_id=s\.tenant_id and newer\.snapshot_id=s\.snapshot_id and newer\.version>s\.version\s*\)/;

test("a new export only picks the current version of each snapshot, so withdrawn and superseded snapshots are never exported", async () => {
  const db = new FakeDb((sql) => {
    if (sql.includes("from corvis_serving.fund_period_snapshots")) assert.match(sql, NEWER_VERSION_GUARD);
    return [];
  });
  await createPhysicalExport(identity, "csv", undefined, db).catch(() => undefined);
  assert.ok(db.queries.some((call) => call.sql.includes("from corvis_serving.fund_period_snapshots")), "the snapshot listing ran");
});

test("a finished export stops being visible once a newer snapshot version (withdrawal or supersession) exists", async () => {
  let checked = false;
  const db = new FakeDb((sql) => {
    if (!sql.includes("from corvis_consolidated.fund_period_snapshot s")) return [];
    checked = true;
    assert.match(sql, NEWER_VERSION_GUARD);
    assert.match(sql, /count\(distinct s\.snapshot_id\)/);
    return [{ snapshot_count: 0 }];
  });
  const artifactRow: PostgresRow = {
    export_id: "00000000-0000-4000-8000-000000000001", format: "csv", state: "complete",
    snapshot_ids: ["00000000-0000-4000-8000-0000000000aa"],
    manifest: { snapshotIds: ["00000000-0000-4000-8000-0000000000aa"], artifact: { fundIds: ["fund-a"], documentIds: ["doc-1"] } },
    created_at: "2026-09-01T00:00:00Z",
  };
  await assert.rejects(exportStatusFromJob(identity, artifactRow, db), (error: unknown) => error instanceof Error && error.name === "AuthorizationError");
  assert.ok(checked, "an artifact-bearing manifest still re-checks snapshot currency");
});

/** Buffers writes made through the transaction handle and only "commits" them when the callback resolves. */
class TransactionalDb extends FakeDb {
  committed: string[] = [];
  transactions = 0;
  failOn: RegExp | undefined;
  constructor() {
    super((sql) => sql.includes("from corvis_serving.fund_period_snapshots")
      ? [{ snapshot_id: "snap-a", schema_version: "v2", taxonomy_version: "v3", fund_id: "fund-a", version: 1, blocking_exception_count: 0 }]
      : sql.includes("from corvis_serving.observations") ? [{ row_count: 1 }] : []);
  }
  async transaction<T>(fn: (tx: PostgresSqlApi) => Promise<T>): Promise<T> {
    this.transactions += 1;
    const pending: string[] = [];
    const tx: PostgresSqlApi = {
      query: async () => [],
      execute: async (sql: string) => {
        if (this.failOn?.test(sql)) throw new Error("simulated insert failure");
        pending.push(sql);
      },
      health: async () => true,
    };
    const result = await fn(tx);
    this.committed.push(...pending);
    return result;
  }
}

test("createPhysicalExport inserts the export job and its ExportRequested event in one transaction", async () => {
  const db = new TransactionalDb();
  await createPhysicalExport(identity, "csv", undefined, db);
  assert.equal(db.transactions, 1);
  assert.equal(db.committed.length, 2);
  assert.match(db.committed[0]!, /corvis_serving\.export_job/);
  assert.match(db.committed[1]!, /corvis_control\.outbox_event/);
});

test("a failed outbox insert leaves no queued export job behind", async () => {
  const db = new TransactionalDb();
  db.failOn = /outbox_event/;
  await assert.rejects(createPhysicalExport(identity, "csv", undefined, db), /simulated insert failure/);
  assert.deepEqual(db.committed, [], "the export_job row must roll back with the failed outbox insert");
});
