import assert from "node:assert/strict";
import test from "node:test";
import { SCORECARD_EXPORT_COLUMNS } from "../../../analytics/domain/performance-scorecard.ts";
import { deleteExportAttemptArtifacts, deliverExportArtifact, exportAttemptObjectKey, loadArtifactRows, loadPositionFinancialRows, type QueuedExportRow } from "./export-delivery.ts";
import { POSITION_EXPORT_COLUMNS } from "./export-renderer.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "../../../../platform/database/postgres.ts";

const TENANT = "00000000-0000-4000-8000-0000000000a1";
const WORKSPACE = "00000000-0000-4000-8000-0000000000d1";
const EXPORT = "00000000-0000-4000-8000-0000000000b1";
const DOC = "00000000-0000-4000-8000-0000000000c1";

type Statement = { sql: string; parameters: PostgresPrimitive[] };

function authRows(options: { funds?: string[]; documents?: string[]; redistribution?: boolean } = {}): PostgresRow[] {
  const entitlement = (type: string, id: string): PostgresRow => ({ workspace_id: WORKSPACE, role_name: "reviewer", resource_type: type, resource_id: id, resource_permission: "read", resource_client_visible: true, resource_source_access: true, redistribution_allowed: options.redistribution ?? true });
  const rows = [...(options.funds ?? ["fund-a"]).map((id) => entitlement("fund", id)), ...(options.documents ?? [DOC]).map((id) => entitlement("document", id))];
  return rows.length ? rows : [{ workspace_id: WORKSPACE, role_name: "reviewer", redistribution_allowed: options.redistribution ?? true }];
}

class Store implements PostgresSqlApi {
  readonly statements: Statement[] = [];
  auth: PostgresRow[] = authRows();
  handler: (sql: string, parameters: PostgresPrimitive[]) => PostgresRow[] = () => [];
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.statements.push({ sql, parameters });
    if (sql.includes("from corvis_control.identity_subject s")) return this.auth;
    return this.handler(sql, parameters);
  }
  async execute(): Promise<void> {}
  async health(): Promise<boolean> { return true; }
}

function objectStore() {
  const puts: Array<{ key: string; bytes: Uint8Array; contentType: string }> = [];
  const deleted: string[] = [];
  return {
    puts, deleted, bucket: "corvis-exports",
    async putObject(key: string, bytes: Uint8Array, contentType: string) { puts.push({ key, bytes, contentType }); },
    async deleteObject(key: string) { deleted.push(key); },
  };
}

function job(overrides: QueuedExportRow = {}): QueuedExportRow {
  return { tenant_id: TENANT, export_id: EXPORT, workspace_id: WORKSPACE, auth_method: "oidc", session_id: "session-1", requested_by: "idp|analyst-1", format: "csv", snapshot_ids: [], manifest: { rowCounts: {} }, ...overrides };
}

const csv = (put: { bytes: Uint8Array }) => Buffer.from(put.bytes).toString("utf8").split("\r\n");

test("object keys are deterministic per attempt and name the export kind", () => {
  const base = { tenantId: "t", exportId: "e", attempt: 2, extension: "csv" };
  assert.equal(exportAttemptObjectKey({ ...base, scoped: false }), "exports/t/e/attempt-2/observations.csv");
  assert.equal(exportAttemptObjectKey({ ...base, scoped: true }), "exports/t/e/attempt-2/position-financials.csv");
  assert.equal(exportAttemptObjectKey({ ...base, scoped: false, scorecard: true }), "exports/t/e/attempt-2/performance-scorecard.csv");
});

test("cleanup removes the objects of the right kind for each attempt and nothing for an unknown format", async () => {
  const store = objectStore();
  const scorecard = job({ manifest: { scope: { performanceScorecard: true } } });
  await deleteExportAttemptArtifacts(scorecard, [1, 2], store);
  await deleteExportAttemptArtifacts(job({ manifest: { scope: { positionFinancials: { fundId: "f", holdingId: "h", companyId: "c", periodicity: "reported" } } } }), 3, store);
  await deleteExportAttemptArtifacts(job({ manifest: null }), 1, store);
  await deleteExportAttemptArtifacts(job({ format: "pdf" }), 1, store);
  assert.deepEqual(store.deleted, [
    `exports/${TENANT}/${EXPORT}/attempt-1/performance-scorecard.csv`,
    `exports/${TENANT}/${EXPORT}/attempt-2/performance-scorecard.csv`,
    `exports/${TENANT}/${EXPORT}/attempt-3/position-financials.csv`,
    `exports/${TENANT}/${EXPORT}/attempt-1/observations.csv`,
  ]);
});

test("delivery refuses a malformed or no-longer-authorized request before reading any data", async () => {
  const store = new Store();
  await assert.rejects(deliverExportArtifact(job({ auth_method: "password" }), store, objectStore()), /export_invalid_auth_method/);
  await assert.rejects(deliverExportArtifact(job({ requested_by: "  " }), store, objectStore()), /export_missing_requested_by/);
  await assert.rejects(deliverExportArtifact(job({ session_id: null }), store, objectStore()), /export_missing_session_id/);
  store.auth = [];
  await assert.rejects(deliverExportArtifact(job(), store, objectStore()), /export_authorization_expired/);
  store.auth = authRows({ redistribution: false });
  await assert.rejects(deliverExportArtifact(job(), store, objectStore()), (error: unknown) => error instanceof Error && error.name === "AuthorizationError");
  store.auth = authRows();
  await assert.rejects(deliverExportArtifact(job({ format: "pdf" }), store, objectStore()), /export_invalid_format/);
});

test("a full-tenant export with no snapshots renders only the observation header", async () => {
  const store = new Store();
  const objects = objectStore();
  const delivered = await deliverExportArtifact(job({ snapshot_ids: "not-an-array" }), store, objects);
  assert.match(csv(objects.puts[0]!)[0]!, /^observation_id,fund_id,/);
  assert.equal(delivered.objectUri, `gs://corvis-exports/exports/${TENANT}/${EXPORT}/attempt-1/observations.csv`);
  assert.deepEqual((delivered.manifest as { rowCounts: Record<string, number> }).rowCounts, { observations: 0, snapshots: 0 });
});

test("observation rows are loaded for exactly the requested published snapshots and entitled documents, with exact decimals", async () => {
  const store = new Store();
  const objects = objectStore();
  store.handler = (sql) => {
    if (sql.includes("count(distinct s.snapshot_id)")) return [{ snapshot_count: 1 }];
    return [
      { observation_id: "o1", fund_id: "fund-a", company_id: "c", holding_id: "h", instrument_id: "i", metric_code: "nav", value_number: "123456789012345678.1234567891", value_string: null, currency: "USD", economic_period: "Q2", report_date: new Date("2026-06-30T00:00:00Z"), review_state: "approved", source_reference_id: "r", document_id: DOC, version: "3", updated_at: "2026-07-01" },
      { observation_id: "o2", fund_id: "fund-a", metric_code: "tvpi", value_number: null, value_string: "NM", version: null },
    ];
  };
  const delivered = await deliverExportArtifact(job({ snapshot_ids: ["snap-1"] }), store, objects, { attempt: 2 });
  const lines = csv(objects.puts[0]!);
  assert.match(lines[1]!, /^o1,fund-a,c,h,i,nav,123456789012345678\.1234567891,,USD,Q2,2026-06-30T00:00:00\.000Z,approved,r,/);
  assert.match(lines[2]!, /^o2,fund-a,,,,tvpi,,NM,/);
  assert.ok(objects.puts[0]!.key.endsWith("attempt-2/observations.csv"));
  const rowQuery = store.statements.find((statement) => statement.sql.includes("artifact_observation"))!;
  assert.deepEqual(rowQuery.parameters, [TENANT, JSON.stringify(["snap-1"]), JSON.stringify(["fund-a"]), JSON.stringify([DOC])]);
  const manifest = delivered.manifest as { artifact: { fundIds: string[]; documentIds: string[]; objectKey: string }; rowCounts: Record<string, number> };
  assert.deepEqual([manifest.artifact.fundIds, manifest.artifact.documentIds, manifest.rowCounts.observations], [["fund-a"], [DOC], 2]);
});

test("observation delivery fails when the caller lost fund or document entitlement or a snapshot is no longer current", async () => {
  const store = new Store();
  store.auth = authRows({ funds: [] });
  await assert.rejects(deliverExportArtifact(job({ snapshot_ids: ["snap-1"] }), store, objectStore()), /export_authorization_expired/);
  store.auth = authRows({ documents: [] });
  await assert.rejects(deliverExportArtifact(job({ snapshot_ids: ["snap-1"] }), store, objectStore()), /export_authorization_expired/);
  store.auth = authRows();
  store.handler = () => [];
  await assert.rejects(deliverExportArtifact(job({ snapshot_ids: ["snap-1"] }), store, objectStore()), /export_snapshot_authorization_expired/);
});

const POSITION_SCOPE = { positionFinancials: { fundId: "fund-a", holdingId: "h-1", companyId: "c-1", periodicity: "reported" } };

function positionRow(overrides: PostgresRow = {}): PostgresRow {
  return {
    statement_id: "s1", document_id: DOC, fund_id: "fund-a", holding_id: "h-1", company_id: "c-1", statement_type: "income_statement", statement_key: "k",
    source_title: "Income", report_period: "2026-Q2", line_id: "l1", line_key: "revenue", semantic_line_key: "revenue", source_label: "Revenue", metric_code: "revenue",
    line_role: "line_item", parent_line_key: null, display_order: "2", depth: 0, value_id: "v1", value_raw: "10", value_number: "10", value_string: null,
    value_qualifier: "exact", currency: "USD", unit: "currency", reported_multiplier: "1", source_precision: "1", value_nature: "flow", period_type: "quarter",
    period_start: "2026-04-01", period_end: "2026-06-30", as_of_date: "2026-06-30", fiscal_year: 2026, fiscal_quarter: 2, source_document_period_end: "2026-06-30",
    source_column_label: "Q2", actuality: "actual", scenario_type: "reported", source_version_status: "final", preliminary: "true", is_restatement: true,
    is_re_reported_prior_period: false, is_derived: "false", derivation_formula: null, source_reference_ids: "{r1,r2}", page_number: 18, sheet_name: null,
    ...overrides,
  };
}

test("a Position Financials delivery renders its own columns, maps every disclosed field and reads the source references of each row", async () => {
  const store = new Store();
  const objects = objectStore();
  store.handler = (sql) => sql.includes("position_financial_statement_values")
    ? [positionRow(), positionRow({ statement_id: "s2", display_order: "bad", depth: null, preliminary: false, is_restatement: false, source_reference_ids: JSON.stringify(["j1"]), valueless: 1 }), positionRow({ statement_id: "s3", source_reference_ids: ["a1"] }), positionRow({ statement_id: "s4", source_reference_ids: "{}" }), positionRow({ statement_id: "s5", source_reference_ids: "[not json" }), positionRow({ statement_id: "s6", source_reference_ids: 7 })]
    : [];
  const delivered = await deliverExportArtifact(job({ snapshot_ids: ["snap-1"], manifest: { scope: POSITION_SCOPE } }), store, objects);
  const lines = csv(objects.puts[0]!);
  assert.equal(lines[0], POSITION_EXPORT_COLUMNS.join(","));
  assert.equal(lines.length, 8);
  assert.match(lines[1]!, /,true,true,false,,"\[""r1"",""r2""\]"$/);
  assert.match(lines[2]!, /,"\[""j1""\]"$/);
  assert.match(lines[3]!, /,"\[""a1""\]"$/);
  for (const index of [4, 5, 6]) assert.match(lines[index]!, /,\[\]$/);
  assert.ok(objects.puts[0]!.key.endsWith("position-financials.csv"));
  assert.equal((delivered.manifest as { rowCounts: Record<string, number> }).rowCounts.positionFinancials, 6);
  const query = store.statements.find((statement) => statement.sql.includes("position_financial_statement_values"))!;
  assert.deepEqual(query.parameters, [TENANT, JSON.stringify(["fund-a"]), JSON.stringify([DOC]), JSON.stringify(["snap-1"]), WORKSPACE, "fund-a", "h-1", "c-1"]);
  assert.doesNotMatch(query.sql, /client_portfolio_holding_attribution/);
});

test("a Position Financials delivery scoped to a client portfolio binds the portfolio attribution", async () => {
  const store = new Store();
  const objects = objectStore();
  store.handler = () => [positionRow()];
  await deliverExportArtifact(job({ snapshot_ids: ["snap-1"], manifest: { scope: { positionFinancials: { ...POSITION_SCOPE.positionFinancials, portfolioId: "p-1" } } } }), store, objects);
  const query = store.statements.find((statement) => statement.sql.includes("position_financial_statement_values"))!;
  assert.match(query.sql, /pa\.portfolio_id::text=\$9/);
  assert.equal(query.parameters[8], "p-1");
});

test("a Position Financials delivery fails when the fund, documents or snapshots are no longer available", async () => {
  const store = new Store();
  const scoped = (scope: unknown) => job({ snapshot_ids: ["snap-1"], manifest: { scope } });
  await assert.rejects(deliverExportArtifact(scoped({ positionFinancials: { ...POSITION_SCOPE.positionFinancials, fundId: "fund-z" } }), store, objectStore()), /export_authorization_expired/);
  store.auth = authRows({ documents: [] });
  await assert.rejects(deliverExportArtifact(scoped(POSITION_SCOPE), store, objectStore()), /export_authorization_expired/);
  store.auth = authRows();
  await assert.rejects(deliverExportArtifact(job({ snapshot_ids: [], manifest: { scope: POSITION_SCOPE } }), store, objectStore()), /export_authorization_expired/);
});

test("a malformed Position Financials scope is not a scope and falls back to the observation export", async () => {
  for (const scope of [null, [], { positionFinancials: null }, { positionFinancials: [] }, { positionFinancials: { fundId: "f", holdingId: "h" } }, { positionFinancials: { fundId: "f", holdingId: "h", companyId: "c", periodicity: "weekly" } }]) {
    const objects = objectStore();
    await deliverExportArtifact(job({ manifest: { scope } }), new Store(), objects);
    assert.ok(objects.puts[0]!.key.endsWith("observations.csv"), JSON.stringify(scope));
  }
});

test("a performance scorecard delivery renders the scorecard columns from the pinned snapshots and records its own row count", async () => {
  const store = new Store();
  const objects = objectStore();
  store.handler = (sql) => {
    if (sql.includes("corvis_identity.fund f")) return [{ fund_id: "fund-a", fund_name: "Alpha" }];
    return [{ fact_id: "f1", snapshot_id: "snap-1", published_at: "2026-07-01T00:00:00Z", fund_id: "fund-a", level: "fund", metric_code: "nav", value_number: "100.5000000000", currency: "USD", as_of: "2026-06-30", economic_period: "Q2 2026", actuality: "actual", document_id: DOC, source_reference_id: "ref-1", page_number: 4 }];
  };
  const delivered = await deliverExportArtifact(job({ snapshot_ids: ["snap-1"], manifest: { scope: { performanceScorecard: true }, rowCounts: { snapshots: 1 } } }), store, objects);
  const lines = csv(objects.puts[0]!);
  assert.equal(lines[0], SCORECARD_EXPORT_COLUMNS.join(","));
  assert.match(lines[1]!, /^fund,fund-a,Alpha,,,,,nav,NAV,Final,100\.5000000000,,,USD,,2026-06-30,Q2 2026,false,,snap-1,/);
  assert.equal(lines.filter((line) => line.includes("Not reported")).length, 5);
  assert.ok(objects.puts[0]!.key.endsWith("attempt-1/performance-scorecard.csv"));
  const manifest = delivered.manifest as { rowCounts: Record<string, number>; artifact: { fundIds: string[]; documentIds: string[] } };
  assert.deepEqual([manifest.rowCounts.performanceScorecard, manifest.rowCounts.snapshots, manifest.artifact.fundIds, manifest.artifact.documentIds], [6, 1, ["fund-a"], [DOC]]);
});

test("a filtered scorecard delivery rebuilds with the filters recorded on the manifest scope", async () => {
  const store = new Store();
  const objects = objectStore();
  let factsParameters: unknown[] = [];
  store.handler = (sql, parameters) => {
    if (sql.includes("corvis_identity.fund f")) return [{ fund_id: "fund-a", fund_name: "Alpha" }];
    factsParameters = parameters;
    return [{ fact_id: "f1", snapshot_id: "snap-1", published_at: "2026-07-01T00:00:00Z", fund_id: "fund-a", level: "fund", metric_code: "nav", value_number: "100.5000000000", currency: "USD", as_of: "2026-03-31", economic_period: "Q1 2026", actuality: "actual", document_id: DOC, source_reference_id: "ref-1", page_number: 4 }];
  };
  await deliverExportArtifact(job({ snapshot_ids: ["snap-1"], manifest: { scope: { performanceScorecard: true, fundId: "fund-a", period: "Q1 2026" }, rowCounts: { snapshots: 1 } } }), store, objects);
  assert.equal(factsParameters.at(-1), "Q1 2026", "the period filter reaches the query");
  assert.equal(csv(objects.puts[0]!).length, 8, "header, six rows of the one filtered fund, trailing newline");
});

test("typed non-text cells pass through, sparse position rows get empty defaults and odd manifests or formats are tolerated", async () => {
  const typed = new Store();
  typed.handler = (sql) => sql.includes("count(distinct s.snapshot_id)") ? [{ snapshot_count: 1 }] : [{ observation_id: "o9", fund_id: "fund-a", metric_code: "nav", value_string: "x", economic_period: 2026, review_state: true }];
  const typedObjects = objectStore();
  await deliverExportArtifact(job({ snapshot_ids: ["snap-1"] }), typed, typedObjects);
  assert.match(csv(typedObjects.puts[0]!)[1]!, /,nav,,x,,2026,,true,/);

  const sparse = new Store();
  sparse.handler = () => [{ value_id: "v1" }];
  const sparseObjects = objectStore();
  await deliverExportArtifact(job({ snapshot_ids: ["snap-1"], manifest: { scope: POSITION_SCOPE } }), sparse, sparseObjects);
  assert.equal(csv(sparseObjects.puts[0]!).length, 3, "header, one sparse row, trailing newline");

  const stringManifest = objectStore();
  await deliverExportArtifact(job({ manifest: "not an object" }), new Store(), stringManifest);
  assert.ok(stringManifest.puts[0]!.key.endsWith("observations.csv"));
  const none = objectStore();
  await deleteExportAttemptArtifacts(job({ format: undefined }), 1, none);
  assert.deepEqual(none.deleted, []);
});

test("the row loaders refuse a caller whose entitlements are absent", async () => {
  const bare = { subject: "s", tenantId: TENANT, workspaceId: WORKSPACE, roles: ["analyst" as const], authMethod: "oidc" as const, sessionId: "x", entitlements: { workspaceIds: [WORKSPACE] } };
  const store = new Store();
  await assert.rejects(loadArtifactRows(bare as never, ["snap-1"], store), /export_authorization_expired/);
  await assert.rejects(loadPositionFinancialRows(bare as never, ["snap-1"], POSITION_SCOPE as never, store), /export_authorization_expired/);
  assert.equal(store.statements.length, 0);
});

test("a performance scorecard delivery fails instead of delivering a different scorecard when a pinned snapshot is gone", async () => {
  const store = new Store();
  store.handler = () => [];
  await assert.rejects(deliverExportArtifact(job({ snapshot_ids: ["snap-1"], manifest: { scope: { performanceScorecard: true } } }), store, objectStore()), /export_snapshot_authorization_expired/);
});
