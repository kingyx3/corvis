import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AuthorizationError, type RequestIdentity } from "../../core/enterprise.ts";
import { scopeObservationsToSnapshot } from "../../core/review-scope.ts";
import { currentSnapshots } from "../../core/current-snapshots.ts";
import { buildWorkspaceSummary, STUCK_DOCUMENT_AFTER_HOURS, STUCK_DOCUMENT_ITEM_LIMIT } from "../../core/workspace-summary.ts";
import { ConflictError, platform, PostgresProductionPlatform, PublicationGateError, snapshotPaginationKey } from "./platform.ts";
import { encodeCursor, InvalidCursorError, keysetPage, MAX_PAGE_LIMIT, paginate, type KeysetPage, type Page } from "./pagination.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import { ResearchProviderError } from "./research.ts";

type Call = { sql: string; parameters: PostgresPrimitive[] };

const exceptionId = "00000000-0000-0000-0000-000000000601";
const snapshotId = "00000000-0000-0000-0000-000000000401";
const allowedSourceId = "00000000-0000-0000-0000-000000000501";

class FakeDb implements PostgresSqlApi {
  calls: Call[] = [];
  reviewResult: PostgresRow = { new_version: 3, next_state: "approved" };
  exceptionRows: PostgresRow[] = [];
  resolutionPreflight: PostgresRow | undefined;
  snapshotBlockers = 0;
  snapshotStatus: string | undefined;
  observationMissing = false;
  appendError: unknown;

  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.calls.push({ sql, parameters });
    if (sql.includes("corvis_serving.reconciliation_exceptions")) return this.exceptionRows;
    if (sql.includes("from corvis_consolidated.reconciliation_exception e")) return this.resolutionPreflight ? [this.resolutionPreflight] : [];
    if (sql.includes("resolve_reconciliation_exception")) return [{ new_version: 2, next_status: "resolved" }];
    if (sql.includes("apply_review_decision")) return [this.reviewResult];
    if (sql.includes("from corvis_facts.observation o")) {
      if (this.observationMissing) return [];
      return [{ observation_id: parameters[1], version: 2, review_state: "review_required", value_number: 100, risk_tier: "normal" }];
    }
    if (sql.includes("select * from corvis_serving.fund_period_snapshots")) {
      return [{ snapshot_id: snapshotId, version: 1, fund_id: "fund-a", report_period: "2026 Q2", blocking_exception_count: this.snapshotBlockers,
        ...(this.snapshotStatus ? { status: this.snapshotStatus } : {}) }];
    }
    if (sql.includes("with snapshot_observation as") && sql.includes("needs_review_count")) {
      return [{ needs_review_count: 0, critical_count: 0, lineage_count: 1, total_count: 1 }];
    }
    if (sql.includes("independently_reviewed")) return [{ independently_reviewed: 0 }];
    if (sql.includes("append_snapshot_transition")) {
      if (this.appendError) throw this.appendError;
      return [{ new_version: 2 }];
    }
    if (sql.includes("corvis_serving.documents")) return [{
      document_id: "00000000-0000-0000-0000-000000000101",
      display_name: "Q2 report.pdf", fund_name: "Fund A", report_period: "2026 Q2",
      document_type: "Quarterly report", page_count: 20, size_bytes: 1024,
      status: "review", quality: "high", observation_count: 10, created_at: "2026-07-01T00:00:00Z",
    }];
    return [];
  }
  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> { this.calls.push({ sql, parameters }); }
  async health(): Promise<boolean> { return true; }
}

class UnhealthyDb extends FakeDb {
  async health(): Promise<boolean> { return false; }
}

const identity: RequestIdentity = {
  subject: "oidc|reviewer-1",
  tenantId: "00000000-0000-0000-0000-000000000010",
  workspaceId: "00000000-0000-0000-0000-000000000020",
  roles: ["reviewer"],
  entitlements: {
    workspaceIds: ["00000000-0000-0000-0000-000000000020"],
    fundIds: ["fund-a"],
    documentIds: ["00000000-0000-0000-0000-000000000101"],
    sourceDocumentIds: ["00000000-0000-0000-0000-000000000101"],
    sourceDocumentAccessAllowed: true,
    redistributionAllowed: true,
  },
  authMethod: "oidc",
  sessionId: "session-1",
};

async function withReadinessEnv<T>(fn: () => Promise<T>): Promise<T> {
  const previous = { ...process.env };
  try {
    Object.assign(process.env, { NODE_ENV: "test" });
    process.env.CORVIS_DEMO_MODE = "false";
    process.env.CORVIS_AUTH_ISSUER = "https://idp.example";
    process.env.CORVIS_AUTH_AUDIENCE = "corvis";
    process.env.CORVIS_TRUSTED_AUTH_PROXY_SECRET = "test-secret";
    process.env.CORVIS_OBJECT_STORE_BUCKET = "corvis-source-uat";
    process.env.CORVIS_UPLOAD_ALLOWED_ORIGINS = "https://uat.example";
    process.env.CORVIS_SEARCH_ENDPOINT = "https://search.example";
    process.env.CORVIS_AI_ENDPOINT = "https://ai.example";
    process.env.CORVIS_OBSERVABILITY_ENDPOINT = "https://otel.example";
    return await fn();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
}

test("production platform source contains no direct Snowflake persistence", async () => {
  const source = await readFile("lib/server/platform.ts", "utf8");
  assert.equal(source.includes("@/lib/server/snowflake"), false);
  assert.equal(source.includes("./snowflake"), false);
  assert.equal(source.includes("SnowflakeProductionPlatform"), false);
  assert.match(source, /PostgresProductionPlatform/);
});

test("readiness is Postgres-primary and ignores optional Snowflake bindings", { concurrency: false }, async () => {
  await withReadinessEnv(async () => {
    process.env.CORVIS_SNOWFLAKE_DSN = "snowflake://optional-downstream";
    const readiness = await new PostgresProductionPlatform(new FakeDb()).readiness();
    assert.equal(readiness.postgres, "configured");
    assert.equal("snowflake" in readiness, false);
    assert.deepEqual(Object.keys(readiness).sort(), ["ai", "identity", "objectStore", "observability", "orchestration", "postgres", "retrieval"]);
  });
});

test("readiness reports identity from direct OIDC issuer/audience without a trusted-proxy secret", { concurrency: false }, async () => {
  await withReadinessEnv(async () => {
    delete process.env.CORVIS_TRUSTED_AUTH_PROXY_SECRET;
    assert.equal((await new PostgresProductionPlatform(new FakeDb()).readiness()).identity, "configured");
    delete process.env.CORVIS_AUTH_AUDIENCE;
    assert.equal((await new PostgresProductionPlatform(new FakeDb()).readiness()).identity, "missing");
    process.env.CORVIS_TRUSTED_AUTH_PROXY_SECRET = "test-secret";
    assert.equal((await new PostgresProductionPlatform(new FakeDb()).readiness()).identity, "configured");
  });
});

test("readiness fails the authoritative structured-data binding when Postgres health fails", { concurrency: false }, async () => {
  await withReadinessEnv(async () => {
    const readiness = await new PostgresProductionPlatform(new UnhealthyDb()).readiness();
    assert.equal(readiness.postgres, "missing");
  });
});

test("workspace reads use the Postgres serving contract and explicit document allowlist", async () => {
  const db = new FakeDb();
  const result = await new PostgresProductionPlatform(db).listDocuments(identity);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.name, "Q2 report.pdf");
  assert.match(db.calls[0]?.sql ?? "", /corvis_serving\.documents/);
  assert.match(db.calls[0]?.sql ?? "", /document_id in \(select entitled\.id::uuid/);
  assert.equal(db.calls[0]?.parameters[0], identity.tenantId);
  assert.equal(db.calls[0]?.parameters[1], JSON.stringify(identity.entitlements.documentIds));
});

test("document and snapshot timestamps leave the server as ISO-8601 UTC, whatever text form Postgres returned", async () => {
  class TimestampDb extends FakeDb {
    override async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
      if (sql.includes("corvis_serving.documents")) {
        return [
          { document_id: "00000000-0000-0000-0000-000000000101", display_name: "a.pdf", created_at: "2026-07-01 14:02:11.123456+00" },
          { document_id: "00000000-0000-0000-0000-000000000102", display_name: "b.pdf", created_at: new Date("2026-07-01T09:00:00.000Z") },
          { document_id: "00000000-0000-0000-0000-000000000103", display_name: "c.pdf", created_at: "2026-07-01 09:00:00+08" },
          { document_id: "00000000-0000-0000-0000-000000000104", display_name: "d.pdf", created_at: null },
          { document_id: "00000000-0000-0000-0000-000000000105", display_name: "e.pdf", created_at: new Date("not a date") },
          { document_id: "00000000-0000-0000-0000-000000000106", display_name: "f.pdf", created_at: "2026-13-45 99:99:00" },
        ];
      }
      if (sql.includes("corvis_serving.fund_period_snapshots")) {
        return [{ snapshot_id: snapshotId, version: 1, fund_id: "fund-a", fund_name: "Fund A", report_period: "2026 Q2", status: "published", created_at: "2026-08-01 01:00:00+00", published_at: "2026-08-02 10:30:00+08" }];
      }
      return super.query(sql, parameters);
    }
  }
  const platform = new PostgresProductionPlatform(new TimestampDb());
  assert.deepEqual((await platform.listDocuments(identity)).map((document) => document.uploaded), [
    "2026-07-01T14:02:11.123Z", "2026-07-01T09:00:00.000Z", "2026-07-01T01:00:00.000Z", "—",
    "—", "2026-13-45 99:99:00", // an invalid Date has no time to show; unparseable text is passed through untouched
  ]);
  const [snapshot] = await platform.listSnapshots(identity);
  assert.equal(snapshot?.changed, "2026-08-02T02:30:00.000Z", "the publish time wins over creation, normalized to UTC");
});

test("empty resource allowlists fail closed before a broad Postgres read", async () => {
  const db = new FakeDb();
  const noResources: RequestIdentity = { ...identity, entitlements: { ...identity.entitlements, fundIds: [], documentIds: [] } };
  assert.deepEqual(await new PostgresProductionPlatform(db).listDocuments(noResources), []);
  assert.deepEqual(await new PostgresProductionPlatform(db).listObservations(noResources), []);
  assert.deepEqual(await new PostgresProductionPlatform(db).listSnapshots(noResources), []);
  assert.equal(db.calls.length, 0);
});

test("Postgres snapshot and observation mappers carry what Review needs to scope a queue to one fund period", async () => {
  class ScopeDb extends FakeDb {
    override async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
      if (sql.includes("corvis_serving.fund_period_snapshots")) {
        return [
          { snapshot_id: snapshotId, version: 1, fund_id: "fund-a", fund_name: "Fund A", report_period: "2026 Q2", status: "review", created_at: "2026-08-01" },
          { snapshot_id: "00000000-0000-0000-0000-000000000402", version: 1, fund_id: "fund-b", fund_name: "Fund B", report_period: "2026 Q2", status: "review", created_at: "2026-08-01" },
        ];
      }
      if (sql.includes("corvis_serving.observations")) {
        const row = (id: string, fund_id: string, fund_name: string, economic_period: string | null) =>
          ({ observation_id: id, fund_id, fund_name, company_id: "c", company_name: "Co", metric_code: "revenue", value_string: "1", economic_period, report_date: "2026-06-30", review_state: "review_required", confidence_score: 90, version: 1 });
        return [row("a-q2", "fund-a", "Fund A", "2026 Q2"), row("b-q2", "fund-b", "Fund B", "2026 Q2"), row("a-q1", "fund-a", "Fund A", "2026 Q1"), row("a-dated", "fund-a", "Fund A", null)];
      }
      return super.query(sql, parameters);
    }
  }
  const platform = new PostgresProductionPlatform(new ScopeDb());
  const [snapshots, observations] = [await platform.listSnapshots(identity), await platform.listObservations(identity)];
  assert.deepEqual(snapshots.map((item) => [item.fundId, item.period]), [["fund-a", "2026 Q2"], ["fund-b", "2026 Q2"]]);
  assert.ok(observations.every((item) => item.snapshotId === undefined), "the serving view has no snapshot column");
  assert.deepEqual(scopeObservationsToSnapshot(observations, snapshots[0]).map((item) => item.id), ["a-q2"]);
  assert.deepEqual(scopeObservationsToSnapshot(observations, snapshots[1]).map((item) => item.id), ["b-q2"]);
});

test("review returns the persistence-authoritative next state for four-eyes workflows", async () => {
  const db = new FakeDb();
  db.reviewResult = { new_version: 3, next_state: "review_required" };
  const result = await new PostgresProductionPlatform(db).review(identity, {
    observationId: "00000000-0000-0000-0000-000000000201",
    decision: "approve",
    reasonCode: "verified",
    expectedVersion: 2,
  });
  assert.equal(result.accepted, true);
  assert.equal(result.newVersion, 3);
  assert.equal(result.nextState, "review_required");
  assert.match(db.calls[0]?.sql ?? "", /o\.fund_id in/);
  assert.match(db.calls[0]?.sql ?? "", /r\.document_id in \(select entitled\.id::uuid/);
  assert.match(db.calls[1]?.sql ?? "", /apply_review_decision/);
  assert.equal(db.calls.some((call) => /set\s+value_/i.test(call.sql)), false);
});

test("reconciliation workbench returns only fund-scoped exceptions and entitled source evidence", async () => {
  const db = new FakeDb();
  db.exceptionRows = [{
    exception_id: exceptionId,
    snapshot_id: snapshotId,
    snapshot_version: 1,
    fund_id: "fund-a",
    report_period: "2026 Q2",
    exception_type: "source_authority",
    summary: "Two quarterly reports disagree",
    materiality: "material",
    status: "open",
    version: 1,
    context: { variance: 10 },
    source_references: [{ sourceReferenceId: allowedSourceId, documentId: identity.entitlements.sourceDocumentIds?.[0], page: 4, excerpt: "Revenue 100" }],
    created_at: "2026-09-19T00:00:00Z",
  }];
  const result = await new PostgresProductionPlatform(db).listReconciliationExceptions(identity, snapshotId, 1);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.type, "source_authority");
  assert.deepEqual(result[0]?.allowedActions, ["select_source"]);
  assert.equal(result[0]?.sourceReferences[0]?.sourceReferenceId, allowedSourceId);
  assert.match(db.calls[0]?.sql ?? "", /e\.fund_id in/);
  assert.match(db.calls[0]?.sql ?? "", /r\.document_id in \(select entitled\.id::uuid/);
  assert.equal(db.calls[0]?.parameters[3], JSON.stringify(identity.entitlements.fundIds));
  assert.equal(db.calls[0]?.parameters[4], JSON.stringify(identity.entitlements.sourceDocumentIds));
});

test("source-authority resolution verifies the selected source against the source-document allowlist", async () => {
  const db = new FakeDb();
  db.resolutionPreflight = { exception_id: exceptionId, exception_type: "source_authority", version: 1, status: "open" };
  const result = await new PostgresProductionPlatform(db).resolveReconciliation(identity, {
    exceptionId,
    expectedVersion: 1,
    action: "select_source",
    reasonCode: "authoritative_quarterly_report",
    selectedSourceReferenceId: allowedSourceId,
  });
  assert.equal(result.status, "resolved");
  assert.match(db.calls[0]?.sql ?? "", /r\.source_reference_id=\$5::uuid/);
  assert.match(db.calls[0]?.sql ?? "", /r\.document_id in \(select entitled\.id::uuid/);
  assert.equal(db.calls[0]?.parameters[4], allowedSourceId);
  assert.equal(db.calls[0]?.parameters[5], JSON.stringify(identity.entitlements.sourceDocumentIds));
  assert.match(db.calls[1]?.sql ?? "", /resolve_reconciliation_exception/);
});

test("stale reconciliation resolution fails optimistic version preflight", async () => {
  const db = new FakeDb();
  await assert.rejects(
    new PostgresProductionPlatform(db).resolveReconciliation(identity, {
      exceptionId,
      expectedVersion: 7,
      action: "accept_reconciliation",
      reasonCode: "reviewed_conflict",
    }),
    (error: unknown) => error instanceof ConflictError && error.code === "reconciliation_exception_not_found_or_version_conflict",
  );
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0]?.sql ?? "", /e\.version=\$3 and e\.status='open'/);
  assert.equal(db.calls.some((call) => call.sql.includes("resolve_reconciliation_exception")), false);
});

test("source-authority resolution fails closed when source-document access is unavailable", async () => {
  const db = new FakeDb();
  const denied: RequestIdentity = {
    ...identity,
    entitlements: { ...identity.entitlements, sourceDocumentAccessAllowed: false, sourceDocumentIds: [] },
  };
  await assert.rejects(
    new PostgresProductionPlatform(db).resolveReconciliation(denied, {
      exceptionId,
      expectedVersion: 1,
      action: "select_source",
      reasonCode: "authoritative_quarterly_report",
      selectedSourceReferenceId: allowedSourceId,
    }),
    (error: unknown) => error instanceof ConflictError && error.code === "reconciliation_exception_not_found_or_version_conflict",
  );
  assert.equal(db.calls.length, 0);
});

test("publication preflight reads governed blockers and post-correction independent-review evidence", async () => {
  const db = new FakeDb();
  const result = await new PostgresProductionPlatform(db).publish(identity, { snapshotId, action: "publish", expectedVersion: 1 });
  assert.equal(result.accepted, true);
  assert.match(db.calls[0]?.sql ?? "", /corvis_serving\.fund_period_snapshots/);
  // Counts are scoped to the snapshot version's own source observations and ignore terminal states.
  const counts = db.calls[1]!;
  assert.match(counts.sql, /from corvis_consolidated\.fund_period_snapshot s[\s\S]*s\.snapshot_id=\$2::uuid and s\.version=\$3/);
  assert.match(counts.sql, /review_state not in \('approved','rejected','superseded'\)/);
  assert.doesNotMatch(counts.sql, /o\.fund_id|fund_id=\$2/, "must not count the whole fund");
  assert.deepEqual(counts.parameters, [identity.tenantId, snapshotId, 1]);
  const independentReview = db.calls.find((call) => call.sql.includes("independently_reviewed"));
  assert.ok(independentReview);
  assert.match(independentReview.sql, /r\.observation_version > coalesce/);
  assert.match(independentReview.sql, /c\.decision='correct'/);
  assert.match(independentReview.sql, /s\.snapshot_id=\$2::uuid and s\.version=\$3/, "independent-review evidence is snapshot-scoped too");
  assert.deepEqual(independentReview.parameters, [identity.tenantId, snapshotId, 1]);
  assert.match(db.calls.at(-1)?.sql ?? "", /append_snapshot_transition/);
});

test("publication remains blocked while governed reconciliation exceptions are open", async () => {
  const db = new FakeDb();
  db.snapshotBlockers = 1;
  await assert.rejects(
    new PostgresProductionPlatform(db).publish(identity, { snapshotId, action: "publish", expectedVersion: 1 }),
    (error: unknown) => error instanceof PublicationGateError && error.reasons.includes("blocking_exceptions"),
  );
  assert.equal(db.calls.some((call) => call.sql.includes("append_snapshot_transition")), false);
});

test("withdraw and supersede transitions remain reversible-history commands without publish gating", async () => {
  for (const action of ["withdraw", "supersede"] as const) {
    const db = new FakeDb();
    const result = await new PostgresProductionPlatform(db).publish(identity, { snapshotId, action, expectedVersion: 1, reason: `${action}_test` });
    assert.equal(result.accepted, true);
    assert.equal(db.calls.length, 2);
    assert.match(db.calls[0]?.sql ?? "", /corvis_serving\.fund_period_snapshots/);
    assert.match(db.calls[1]?.sql ?? "", /append_snapshot_transition/);
    assert.equal(db.calls[1]?.parameters[4], action);
    assert.equal(db.calls[1]?.parameters[6], `${action}_test`);
  }
});

test("review of an unknown or malformed observation id is a conflict, and a malformed id never reaches a uuid cast", async () => {
  const db = new FakeDb();
  db.observationMissing = true;
  await assert.rejects(
    new PostgresProductionPlatform(db).review(identity, { observationId: "00000000-0000-0000-0000-000000000301", decision: "approve", reasonCode: "ok", expectedVersion: 2 }),
    (error: unknown) => error instanceof ConflictError && error.code === "observation_not_found_or_version_conflict",
  );
  const clean = new FakeDb();
  await assert.rejects(
    new PostgresProductionPlatform(clean).review(identity, { observationId: "not-a-uuid", decision: "approve", reasonCode: "ok", expectedVersion: 2 }),
    (error: unknown) => error instanceof ConflictError && error.code === "observation_not_found_or_version_conflict",
  );
  assert.equal(clean.calls.length, 0);
});

test("malformed snapshot / exception ids fail closed without issuing a query", async () => {
  const db = new FakeDb();
  const platform = new PostgresProductionPlatform(db);
  await assert.rejects(
    platform.publish(identity, { snapshotId: "snap-1", action: "publish", expectedVersion: 1 }),
    (error: unknown) => error instanceof ConflictError && error.code === "snapshot_not_found_or_version_conflict",
  );
  await assert.rejects(
    platform.resolveReconciliation(identity, { exceptionId: "exc-1", expectedVersion: 1, action: "mark_immaterial", reasonCode: "x" }),
    (error: unknown) => error instanceof ConflictError,
  );
  await assert.rejects(
    platform.resolveReconciliation(identity, { exceptionId, expectedVersion: 1, action: "select_source", reasonCode: "x", selectedSourceReferenceId: "src-1" }),
    (error: unknown) => error instanceof ConflictError,
  );
  assert.deepEqual(await platform.listReconciliationExceptions(identity, "snap-1", 1), []);
  assert.equal(db.calls.length, 0);
});

test("snapshot transitions only target the current version of the snapshot", async () => {
  const db = new FakeDb();
  await new PostgresProductionPlatform(db).publish(identity, { snapshotId, action: "withdraw", expectedVersion: 1 });
  assert.match(db.calls[0]?.sql ?? "", /not exists \(\s*select 1 from corvis_serving\.fund_period_snapshots n[\s\S]+n\.version>s\.version/);
});

test("snapshot transitions refuse a source state they cannot start from with a 409, before the persistence call", async () => {
  const cases: Array<[string, "publish" | "withdraw" | "supersede"]> = [
    ["published", "publish"], ["withdrawn", "publish"], ["draft", "withdraw"], ["withdrawn", "withdraw"], ["superseded", "supersede"], ["draft", "supersede"],
  ];
  for (const [status, action] of cases) {
    const db = new FakeDb();
    db.snapshotStatus = status;
    await assert.rejects(
      new PostgresProductionPlatform(db).publish(identity, { snapshotId, action, expectedVersion: 1 }),
      (error: unknown) => error instanceof ConflictError && error.code === "snapshot_transition_not_allowed",
      `${action} from ${status}`,
    );
    assert.equal(db.calls.some((call) => call.sql.includes("append_snapshot_transition")), false);
  }
  const allowed = new FakeDb();
  allowed.snapshotStatus = "published";
  assert.equal((await new PostgresProductionPlatform(allowed).publish(identity, { snapshotId, action: "withdraw", expectedVersion: 1 })).accepted, true);
});

test("a concurrent transition losing the version race is a version conflict, and a persistence-gate refusal is a blocked publication", async () => {
  const racing = new FakeDb();
  racing.appendError = Object.assign(new Error("Postgres query failed (SQLSTATE 23505)"), { code: "23505" });
  await assert.rejects(
    new PostgresProductionPlatform(racing).publish(identity, { snapshotId, action: "withdraw", expectedVersion: 1 }),
    (error: unknown) => error instanceof ConflictError && error.code === "snapshot_not_found_or_version_conflict",
  );
  const gated = new FakeDb();
  gated.appendError = Object.assign(new Error("Postgres query failed (SQLSTATE P0001)"), { code: "P0001" });
  await assert.rejects(
    new PostgresProductionPlatform(gated).publish(identity, { snapshotId, action: "publish", expectedVersion: 1 }),
    (error: unknown) => error instanceof PublicationGateError && error.reasons.includes("publication_invariant_failed"),
  );
});

test("exports require the independent authoritative redistribution right", async () => {
  const db = new FakeDb();
  const denied: RequestIdentity = { ...identity, entitlements: { ...identity.entitlements, redistributionAllowed: false } };
  await assert.rejects(
    new PostgresProductionPlatform(db).export(denied, "csv"),
    (error: unknown) => error instanceof AuthorizationError && error.requiredPermission === "data_rights:redistribution",
  );
  assert.equal(db.calls.length, 0);
});

test("snapshot pagination walks every version of a snapshot even when a page boundary splits them", () => {
  const otherSnapshotId = "00000000-0000-0000-0000-000000000402";
  const rows = [
    { id: snapshotId, version: 1 }, { id: snapshotId, version: 2 }, { id: snapshotId, version: 10 },
    { id: otherSnapshotId, version: 1 }, { id: otherSnapshotId, version: 2 },
  ].map((row) => ({ ...row, fund: "Fund A", period: "2026 Q2", status: "Review" as const, holdings: 0, facts: 0, changed: "" }));
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page: Page<(typeof rows)[number]> = paginate(rows, snapshotPaginationKey, 1, cursor);
    seen.push(...page.items.map((row) => `${row.id}@${row.version}`));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, [
    `${snapshotId}@1`, `${snapshotId}@2`, `${snapshotId}@10`, `${otherSnapshotId}@1`, `${otherSnapshotId}@2`,
  ]);
});

// ---------------------------------------------------------------------------
// SQL keyset paging for the /documents, /jobs, /observations and /snapshots
// list routes. Paging in memory over a capped fetch (1000 or 5000 rows) made
// every row past the cap unreachable. KeysetDb simulates the keyset predicate
// and `limit` from the SQL text and its parameters, so a cursor walk proves
// every row is reachable and that each fetch reads at most one page plus one.
// ---------------------------------------------------------------------------

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
const pgPad = (version: unknown) => String(version).padStart(10, "0");

class KeysetDb implements PostgresSqlApi {
  calls: Call[] = [];
  documents: PostgresRow[] = [];
  observations: PostgresRow[] = [];
  snapshots: PostgresRow[] = [];
  jobs: PostgresRow[] = [];

  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.calls.push({ sql, parameters });
    for (const parameter of parameters) {
      assert.ok(typeof parameter !== "string" || !parameter.includes("\u0000"), "Postgres text parameters cannot carry NUL");
    }
    assert.equal(parameters[0], identity.tenantId);
    if (sql.includes("from corvis_serving.fund_period_snapshots s")) return this.snapshotPage(sql, parameters);
    if (sql.includes("corvis_serving.documents")) return this.singleKeyPage(sql, parameters, this.documents, "document_id::text", "document_id", "order by created_at desc limit 1000");
    if (sql.includes("from corvis_serving.observations o")) return this.singleKeyPage(sql, parameters, this.observations, "o.observation_id::text", "observation_id", "order by o.updated_at desc limit 5000");
    if (sql.includes("from corvis_control.processing_job j")) return this.singleKeyPage(sql, parameters, this.jobs, "j.job_id::text", "job_id", "order by j.updated_at desc limit 1000");
    return [];
  }
  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> { this.calls.push({ sql, parameters }); }
  async health(): Promise<boolean> { return true; }

  private singleKeyPage(sql: string, parameters: PostgresPrimitive[], rows: PostgresRow[], keyExpression: string, column: string, legacyTail: string): PostgresRow[] {
    const limit = /limit \$(\d+)\s*$/.exec(sql);
    if (!limit) {
      assert.ok(sql.trimEnd().endsWith(legacyTail), "an unpaged call keeps the legacy capped query");
      return rows.slice(0, Number(/limit (\d+)$/.exec(legacyTail)![1]));
    }
    const key = escapeRegExp(keyExpression);
    assert.match(sql, new RegExp(`order by ${key} collate "C" limit \\$${limit[1]}\\s*$`));
    const after = new RegExp(`and ${key} collate "C" > \\$(\\d+)`).exec(sql);
    const bound = after ? String(parameters[Number(after[1]) - 1]) : null;
    return rows
      .filter((row) => bound === null || String(row[column]) > bound)
      .sort((a, b) => compareText(String(a[column]), String(b[column])))
      .slice(0, Number(parameters[Number(limit[1]) - 1]));
  }

  private snapshotPage(sql: string, parameters: PostgresPrimitive[]): PostgresRow[] {
    const limit = /limit \$(\d+)\s*$/.exec(sql);
    if (!limit) {
      assert.ok(sql.trimEnd().endsWith("order by s.created_at desc limit 1000"), "an unpaged call keeps the legacy capped query");
      return this.snapshots.slice(0, 1000);
    }
    const id = `s.snapshot_id::text collate "C"`;
    const version = `lpad(s.version::text, 10, '0') collate "C"`;
    assert.ok(sql.includes(`order by ${id}, ${version} limit $${limit[1]}`), sql);
    const idAtLeast = new RegExp(`and ${escapeRegExp(id)} >= \\$(\\d+)`).exec(sql);
    const tuple = new RegExp(`and \\(${escapeRegExp(id)} > \\$(\\d+) or \\(${escapeRegExp(id)} = \\$(\\d+) and ${escapeRegExp(version)} > \\$(\\d+)\\)\\)`).exec(sql);
    const parameter = (index: string | undefined) => String(parameters[Number(index) - 1]);
    return this.snapshots
      .filter((row) => {
        const rowId = String(row.snapshot_id);
        if (idAtLeast) return rowId >= parameter(idAtLeast[1]);
        if (tuple) {
          assert.equal(parameter(tuple[1]), parameter(tuple[2]));
          return rowId > parameter(tuple[1]) || (rowId === parameter(tuple[2]) && pgPad(row.version) > parameter(tuple[3]));
        }
        return true;
      })
      .sort((a, b) => compareText(String(a.snapshot_id), String(b.snapshot_id)) || compareText(pgPad(a.version), pgPad(b.version)))
      .slice(0, Number(parameters[Number(limit[1]) - 1]));
  }
}

function uuidFor(prefix: number, index: number): string {
  return `00000000-0000-4000-${prefix.toString(16).padStart(4, "0")}-${index.toString(16).padStart(12, "0")}`;
}

/** Mirrors the list routes: keysetPage(cursor, limit) down to storage, then paginate() over the rows. */
async function walkAllPages<T>(fetchPage: (page: KeysetPage) => Promise<T[]>, keyOf: (item: T) => string, limit = MAX_PAGE_LIMIT): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const rows = await fetchPage(keysetPage(cursor, limit));
    assert.ok(rows.length <= limit + 1, "one page fetch never loads more than a page plus one row");
    const page: Page<T> = paginate(rows, keyOf, limit, cursor);
    seen.push(...page.items.map(keyOf));
    cursor = page.nextCursor;
  } while (cursor);
  return seen;
}

function assertEveryKeySeenOnce(seen: string[], expected: string[]): void {
  assert.equal(seen.length, expected.length);
  assert.deepEqual(seen, [...expected].sort(compareText));
}

test("/documents keyset-pages in SQL so documents past the old 1000-row cap are reachable", async () => {
  const db = new KeysetDb();
  const ids = Array.from({ length: 1105 }, (_, index) => uuidFor(1, index));
  db.documents = ids.map((document_id) => ({ document_id }));
  const entitled: RequestIdentity = { ...identity, entitlements: { ...identity.entitlements, documentIds: ids } };
  const platform = new PostgresProductionPlatform(db);
  assertEveryKeySeenOnce(await walkAllPages((page) => platform.listDocuments(entitled, page), (document) => document.id), ids);
  const last = db.calls.at(-1)!;
  assert.match(last.sql, /where tenant_id=\$1\s+and document_id in \(select entitled\.id::uuid from jsonb_array_elements_text\(\$2::jsonb\)/);
  assert.deepEqual(last.parameters.slice(0, 2), [identity.tenantId, JSON.stringify(ids)]);
  assert.equal(last.parameters.at(-1), MAX_PAGE_LIMIT + 1, "fetches limit + 1 rows");
});

test("/jobs keyset-pages in SQL so jobs past the old 1000-row cap are reachable", async () => {
  const db = new KeysetDb();
  const ids = Array.from({ length: 1105 }, (_, index) => uuidFor(2, index));
  db.jobs = ids.map((job_id) => ({ job_id, document_id: identity.entitlements.documentIds![0] }));
  const platform = new PostgresProductionPlatform(db);
  assertEveryKeySeenOnce(await walkAllPages((page) => platform.jobs(identity, page), (job) => job.id), ids);
  const last = db.calls.at(-1)!;
  assert.match(last.sql, /where j\.tenant_id=\$1\s+and j\.document_id in \(select entitled\.id::uuid from jsonb_array_elements_text\(\$2::jsonb\)/);
  assert.deepEqual(last.parameters.slice(0, 2), [identity.tenantId, JSON.stringify(identity.entitlements.documentIds)]);
  assert.equal(last.parameters.at(-1), MAX_PAGE_LIMIT + 1);
});

test("/observations keyset-pages in SQL so observations past the old 5000-row cap are reachable", async () => {
  const db = new KeysetDb();
  const ids = Array.from({ length: 5105 }, (_, index) => uuidFor(3, index));
  db.observations = ids.map((observation_id) => ({ observation_id, review_state: "approved" }));
  const platform = new PostgresProductionPlatform(db);
  assertEveryKeySeenOnce(await walkAllPages((page) => platform.listObservations(identity, page), (observation) => observation.id), ids);
  const last = db.calls.at(-1)!;
  assert.match(last.sql, /where o\.tenant_id=\$1\s+and o\.fund_id in \(select jsonb_array_elements_text\(\$2::jsonb\)\)\s+and r\.document_id in \(select entitled\.id::uuid from jsonb_array_elements_text\(\$3::jsonb\)/);
  assert.deepEqual(last.parameters.slice(0, 3), [identity.tenantId, JSON.stringify(identity.entitlements.fundIds), JSON.stringify(identity.entitlements.documentIds)]);
  assert.equal(last.parameters.at(-1), MAX_PAGE_LIMIT + 1);
});

test("/snapshots keyset-pages in SQL on (snapshot id, padded version) so versions past the old 1000-row cap are reachable", async () => {
  const db = new KeysetDb();
  // Versions 2 and 10 sort wrongly as unpadded text; an odd page size also splits versions of one id across pages.
  db.snapshots = Array.from({ length: 553 }, (_, index) => uuidFor(4, index))
    .flatMap((snapshot_id) => [{ snapshot_id, version: 10 }, { snapshot_id, version: 2 }]);
  const platform = new PostgresProductionPlatform(db);
  const seen = await walkAllPages((page) => platform.listSnapshots(identity, page), snapshotPaginationKey, 199);
  assertEveryKeySeenOnce(seen, db.snapshots.map((row) => `${String(row.snapshot_id)}\u0000${pgPad(row.version)}`));
  const last = db.calls.at(-1)!;
  assert.match(last.sql, /where s\.tenant_id=\$1\s+and s\.fund_id in \(select jsonb_array_elements_text\(\$2::jsonb\)\)/);
  assert.deepEqual(last.parameters.slice(0, 2), [identity.tenantId, JSON.stringify(identity.entitlements.fundIds)]);
  assert.equal(last.parameters.at(-1), 200);
});

test("keyset pages match in-memory paginate() for cursor keys holding NUL, which Postgres text cannot carry", async () => {
  const db = new KeysetDb();
  const ids = Array.from({ length: 30 }, (_, index) => uuidFor(5, index));
  db.documents = ids.map((document_id) => ({ document_id }));
  db.snapshots = ids.flatMap((snapshot_id) => [1, 2, 10].map((version) => ({ snapshot_id, version })));
  const entitled: RequestIdentity = { ...identity, entitlements: { ...identity.entitlements, documentIds: ids } };
  const platform = new PostgresProductionPlatform(db);
  const allDocuments = await platform.listDocuments(entitled);
  const allSnapshots = await platform.listSnapshots(entitled);
  const target = ids[12]!;
  const documentKeys = [target, `${target}\u0000`, `${target}\u0000zz`, `${target.slice(0, 20)}\u0000${target}`];
  for (const key of documentKeys) {
    const cursor = encodeCursor(key);
    const expected = paginate(allDocuments, (document) => document.id, 5, cursor);
    assert.deepEqual(paginate(await platform.listDocuments(entitled, keysetPage(cursor, 5)), (document) => document.id, 5, cursor), expected, JSON.stringify(key));
  }
  const snapshotKeys = [
    target, target.slice(0, 20), `${target}\u0000`, `${target}\u00000000000002`, `${target}\u00000000000002\u0000x`,
    `${target}\u00000000000003`, `${target}\u00000000000010`, `${target}\u0000\u0000`, `${target}\u0000${"9".repeat(11)}`,
  ];
  for (const key of snapshotKeys) {
    const cursor = encodeCursor(key);
    const expected = paginate(allSnapshots, snapshotPaginationKey, 4, cursor);
    assert.deepEqual(paginate(await platform.listSnapshots(entitled, keysetPage(cursor, 4)), snapshotPaginationKey, 4, cursor), expected, JSON.stringify(key));
  }
});

test("a malformed cursor fails before any keyset fetch reaches Postgres", () => {
  assert.throws(() => keysetPage("not-a-cursor", 10), InvalidCursorError);
  assert.deepEqual(keysetPage(null, 10), { limit: 10 });
  assert.deepEqual(keysetPage(encodeCursor("k"), 10), { afterKey: "k", limit: 10 });
});

// ---------------------------------------------------------------------------
// Row mappers, error paths and the remaining platform operations. ScriptedDb
// answers chosen statements itself and defers every other one to FakeDb.
// ---------------------------------------------------------------------------

type Handler = (parameters: PostgresPrimitive[], sql: string) => PostgresRow[];

class ScriptedDb extends FakeDb {
  private readonly handlers: Array<[string, Handler]>;
  constructor(handlers: Array<[string, Handler]>) {
    super();
    this.handlers = handlers;
  }
  override async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    const handler = this.handlers.find(([needle]) => sql.includes(needle));
    if (!handler) return super.query(sql, parameters);
    this.calls.push({ sql, parameters });
    return handler[1](parameters, sql);
  }
}

const rows = (...values: PostgresRow[]): Handler => () => values;
const OBSERVATION_ID = "00000000-0000-0000-0000-000000000201";

async function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = { ...process.env };
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
}

test("document rows map to display records: defaults, size units, statuses, quality and timestamps", async () => {
  const db = new ScriptedDb([["corvis_serving.documents", rows(
    { document_id: "d-full", display_name: "Q2.pdf", fund_name: "Fund A", report_period: "2026 Q2", document_type: "Quarterly report", page_count: 12, size_bytes: 1536,
      status: "Published", quality: "High", observation_count: 3, created_at: "2026-07-01", processing_state: "running", processing_updated_at: new Date("2026-07-02T03:04:05Z") },
    { document_id: "d-large", size_bytes: 25 * 1024 * 1024, status: "In_Review", quality: "Medium", processing_state: "succeeded", processing_updated_at: "" },
    { document_id: "d-bytes", size_bytes: 512, status: "canonicalized", quality: "low", processing_updated_at: "2026-07-02T00:00:00Z" },
    { document_id: "d-huge", size_bytes: 2 * 1024 ** 5, status: "reconciled" },
    { document_id: "d-empty", size_bytes: "not-a-number" },
    { document_id: "d-unknown", status: "mystery" },
  )]]);
  const result = await new PostgresProductionPlatform(db).listDocuments(identity);
  const byId = Object.fromEntries(result.map((document) => [document.id, document]));
  assert.deepEqual(byId["d-full"], {
    id: "d-full", name: "Q2.pdf", fund: "Fund A", period: "2026 Q2", type: "Quarterly report", pages: 12, size: "1.5 KB", status: "Published", progress: 50,
    uploaded: "2026-07-01", quality: "High", observations: 3, processingState: "running", processingUpdatedAt: "2026-07-02T03:04:05.000Z",
  });
  assert.deepEqual([byId["d-large"]?.size, byId["d-large"]?.status, byId["d-large"]?.quality, byId["d-large"]?.progress, byId["d-large"]?.processingState, byId["d-large"]?.processingUpdatedAt],
    ["25 MB", "Review", "Medium", undefined, "succeeded", undefined]);
  assert.deepEqual([byId["d-bytes"]?.size, byId["d-bytes"]?.status, byId["d-bytes"]?.quality, byId["d-bytes"]?.processingState, byId["d-bytes"]?.processingUpdatedAt],
    ["512 B", "Extracting", "Pending", undefined, "2026-07-02T00:00:00Z"]);
  assert.deepEqual([byId["d-huge"]?.size, byId["d-huge"]?.status], ["2048 TB", "Extracting"]);
  assert.deepEqual(byId["d-empty"], {
    id: "d-empty", name: "Untitled document", fund: "Unclassified", period: "Detecting…", type: "Source document", pages: 0, size: "—", status: "Queued",
    progress: undefined, uploaded: "—", quality: "Pending", observations: 0, processingState: undefined, processingUpdatedAt: undefined,
  });
  assert.equal(byId["d-unknown"]?.status, "Queued");
});

test("attention aggregates merge needs-review rows per fund period and report the exact stuck total", async () => {
  const db = new ScriptedDb([
    ["row_number() over", rows(
      { fund_name: "Fund A", economic_period: "2026 Q2", review_count: 2, observation_id: "o1", company_name: "Co A", metric_code: "revenue" },
      { fund_name: "Fund A", economic_period: "2026 Q2", review_count: "3", observation_id: "o2", company_name: "Co B", metric_code: "ebitda" },
      { fund_name: "Fund A", economic_period: "2026 Q1", review_count: 1, observation_id: "o3", company_id: "c3", metric_code: "ebitda" },
      { review_count: 4, observation_id: "o4" },
    )],
    ["stuck_total", rows(
      { document_id: "d1", status: "queued", processing_state: "failed", stuck_total: 7 },
      { document_id: "d2", status: "queued", processing_state: "blocked", stuck_total: 7 },
    )],
  ]);
  const aggregates = await new PostgresProductionPlatform(db).attentionAggregates(identity, { includeDocuments: true });
  assert.deepEqual(aggregates.needsReview, [
    { fund: "Fund A", period: "2026 Q2", count: 5, observationId: "o1", company: "Co A", metric: "revenue" },
    { fund: "Fund A", period: "2026 Q1", count: 1, observationId: "o3", company: "c3", metric: "ebitda" },
    { fund: "Unassigned fund", count: 4, observationId: "o4", company: "Unknown company", metric: "" },
  ]);
  assert.deepEqual(aggregates.stuckDocuments.map((document) => [document.id, document.processingState]), [["d1", "failed"], ["d2", "blocked"]]);
  assert.equal(aggregates.stuckDocumentTotal, 7);
  const stuck = db.calls.find((call) => call.sql.includes("stuck_total"))!;
  assert.deepEqual(stuck.parameters.slice(2), [STUCK_DOCUMENT_AFTER_HOURS, STUCK_DOCUMENT_ITEM_LIMIT]);

  const withoutDocuments = new ScriptedDb([["row_number() over", rows()]]);
  assert.deepEqual(await new PostgresProductionPlatform(withoutDocuments).attentionAggregates(identity, { includeDocuments: false }),
    { needsReview: [], stuckDocuments: [], stuckDocumentTotal: 0 });
  assert.equal(withoutDocuments.calls.some((call) => call.sql.includes("stuck_total")), false, "stuck documents are not read unless requested");

  const noStuck = new ScriptedDb([["stuck_total", rows()]]);
  assert.equal((await new PostgresProductionPlatform(noStuck).attentionAggregates(identity, { includeDocuments: true })).stuckDocumentTotal, 0);
});

test("observation rows normalise confidence, value, source and review state", async () => {
  const db = new ScriptedDb([["from corvis_serving.observations o", rows(
    { observation_id: "o-full", company_id: "c1", company_name: "Co One", metric_code: "revenue", value_string: "12.5m", economic_period: "2026 Q2", report_date: "2026-06-30",
      page_number: 3, source_reference_id: "s1", confidence_score: 0.876, review_state: "Approved", delta_display: "+3%", version: 4, fund_name: "Fund A", fund_id: "fund-a",
      holding_id: "h1", risk_tier: "critical", approved_reviewer_count: 2 },
    { observation_id: "o-number", company_id: "c2", value_number: 100, currency: "USD", report_date: "2026-06-30", sheet_name: "Sheet1", confidence_score: 91.6, review_state: "REJECTED", approved_reviewer_count: 0 },
    { observation_id: "o-number-nocurrency", value_number: 7, cell_range: "B2:C3", confidence_score: 0, review_state: "review_required" },
    { observation_id: "o-bare" },
  )]]);
  const [full, withNumber, noCurrency, bare] = await new PostgresProductionPlatform(db).listObservations(identity);
  assert.deepEqual(full, {
    id: "o-full", company: "Co One", metric: "revenue", value: "12.5m", period: "2026 Q2", source: "p. 3", sourceReferenceId: "s1", confidence: 88, state: "Approved",
    delta: "+3%", version: 4, fund: "Fund A", fundId: "fund-a", companyId: "c1", holdingId: "h1", riskTier: "critical", approvedReviewerCount: 2,
  });
  assert.deepEqual([withNumber?.company, withNumber?.value, withNumber?.period, withNumber?.source, withNumber?.confidence, withNumber?.state, withNumber?.approvedReviewerCount],
    ["c2", "USD 100", "2026-06-30", "Sheet1", 92, "Rejected", 0]);
  assert.deepEqual([noCurrency?.value, noCurrency?.source, noCurrency?.confidence, noCurrency?.state, noCurrency?.approvedReviewerCount], ["7", "B2:C3", 0, "Needs review", undefined]);
  assert.deepEqual(bare, {
    id: "o-bare", company: "Unknown company", metric: "", value: "—", period: "", source: "Source reference", sourceReferenceId: undefined, confidence: 0, state: "Needs review",
    delta: "—", version: 1, fund: undefined, fundId: undefined, companyId: undefined, holdingId: undefined, riskTier: undefined, approvedReviewerCount: undefined,
  });
});

test("snapshot rows map status, fund name fallbacks and the changed timestamp", async () => {
  const db = new ScriptedDb([["from corvis_serving.fund_period_snapshots s", rows(
    { snapshot_id: "s1", version: 2, fund_id: "fund-a", fund_name: "Fund A", report_period: "2026 Q2", status: "Published", holding_count: 4, fact_count: 9,
      published_at: "2026-08-01T00:00:00Z", created_at: "2026-07-01", blocking_exception_count: 1 },
    { snapshot_id: "s2", fund_id: "fund-b", report_period: "2026 Q2", status: "draft", created_at: "2026-07-02" },
    { snapshot_id: "s3" },
  )]]);
  const [published, draft, bare] = await new PostgresProductionPlatform(db).listSnapshots(identity);
  assert.deepEqual(published, {
    id: "s1", version: 2, fund: "Fund A", fundId: "fund-a", period: "2026 Q2", status: "Published", holdings: 4, facts: 9,
    changed: "2026-08-01T00:00:00.000Z", blockingExceptions: 1, publishedAt: "2026-08-01T00:00:00Z",
  });
  assert.deepEqual([draft?.fund, draft?.status, draft?.changed, draft?.publishedAt, draft?.version], ["fund-b", "Review", "2026-07-02", undefined, 1]);
  assert.deepEqual([bare?.fund, bare?.fundId, bare?.period, bare?.changed], ["Unknown fund", undefined, "", ""]);
});

test("snapshotPaginationKey falls back to fund, period and version for a snapshot without an id", () => {
  const base = { fund: "Fund A", period: "2026 Q2", status: "Review" as const, holdings: 0, facts: 0, changed: "" };
  assert.equal(snapshotPaginationKey({ ...base, id: "s1", version: 3 }), "s1\u00000000000003");
  assert.equal(snapshotPaginationKey({ ...base }), "Fund A\u00002026 Q2\u00000000000000");
});

test("reconciliation exception rows normalise context, history, source references and allowed actions", async () => {
  const db = new ScriptedDb([["corvis_serving.reconciliation_exceptions", rows(
    { exception_id: "e1", snapshot_id: snapshotId, snapshot_version: 2, fund_id: "fund-a", report_period: "2026 Q2", exception_type: "materiality", subject_type: "holding", subject_id: "h1",
      metric_code: "nav", summary: "Variance", materiality: "material", status: "resolved", version: 3, resolved_at: "2026-09-20T00:00:00Z", created_at: "2026-09-19T00:00:00Z",
      context: JSON.stringify({ variance: 10 }), published_history: JSON.stringify([{ reportPeriod: "2026 Q1" }, null, "x"]),
      source_references: JSON.stringify([
        { sourceReferenceId: "s1", documentId: "d1", page: 4, sheetName: "Sheet1", cellRange: "A1", excerpt: "Revenue 100" },
        { sourceReferenceId: "s2", documentId: "d2" },
        { sourceReferenceId: "", documentId: "d3" },
        { sourceReferenceId: "s4" },
        { documentId: "d6" },
      ]) },
    { exception_id: "e2", exception_type: "unknown_kind", context: "not json", published_history: "not json", source_references: "{}" },
    { exception_id: "e3", exception_type: "source_authority", context: "[1]", published_history: "{}", source_references: undefined },
    { exception_id: "e4", exception_type: "other", context: "7", published_history: 7, source_references: [null, { sourceReferenceId: "s5", documentId: "d5" }] },
    { exception_id: "e5", exception_type: "other", context: { already: "object" }, published_history: [{ reportPeriod: "2025 Q4" }] },
    { exception_id: "e6", exception_type: "other", context: ["array"] },
  )]]);
  const [materiality, unknown, authority, other, objectContext, arrayContext] = await new PostgresProductionPlatform(db).listReconciliationExceptions(identity, snapshotId, 2);
  assert.deepEqual(materiality, {
    exceptionId: "e1", snapshotId, snapshotVersion: 2, fundId: "fund-a", reportPeriod: "2026 Q2", type: "materiality", subjectType: "holding", subjectId: "h1", metricCode: "nav",
    summary: "Variance", materiality: "material", context: { variance: 10, publishedHistory: [{ reportPeriod: "2026 Q1" }] }, status: "resolved", version: 3,
    allowedActions: ["mark_immaterial"],
    sourceReferences: [
      { sourceReferenceId: "s1", documentId: "d1", page: 4, sheetName: "Sheet1", cellRange: "A1", excerpt: "Revenue 100" },
      { sourceReferenceId: "s2", documentId: "d2", page: undefined, sheetName: undefined, cellRange: undefined, excerpt: undefined },
    ],
    createdAt: "2026-09-19T00:00:00Z", resolvedAt: "2026-09-20T00:00:00Z",
  });
  assert.deepEqual(unknown, {
    exceptionId: "e2", snapshotId: "", snapshotVersion: 1, fundId: "", reportPeriod: "", type: "unknown_kind", subjectType: undefined, subjectId: undefined, metricCode: undefined,
    summary: "Reconciliation exception", materiality: "unknown", context: { publishedHistory: [] }, status: "open", version: 1, allowedActions: ["accept_reconciliation"],
    sourceReferences: [], createdAt: "", resolvedAt: undefined,
  });
  assert.deepEqual(authority?.allowedActions, ["select_source"]);
  assert.deepEqual(authority?.context, { publishedHistory: [] });
  assert.deepEqual(other?.context, { publishedHistory: [] });
  assert.deepEqual(other?.sourceReferences.map((source) => source.sourceReferenceId), ["s5"]);
  assert.deepEqual(objectContext?.context, { already: "object", publishedHistory: [{ reportPeriod: "2025 Q4" }] });
  assert.deepEqual(arrayContext?.context, { publishedHistory: [] });
});

test("portfolio value facts keep only finite nav and fair_value rows", async () => {
  const db = new ScriptedDb([["corvis_identity.fund", rows(
    { snapshot_id: "s1", fund_id: "f1", fund_name: "Fund One", report_period: "2026 Q2", published_at: new Date("2026-08-01T00:00:00Z"), metric_code: "nav", subject_level: "fund", currency: "USD", total_value: "1500.5", fact_count: 2 },
    { snapshot_id: "s2", fund_id: "f2", report_period: "2026 Q1", metric_code: "fair_value", total_value: 10 },
    { snapshot_id: "s3", fund_id: "f3", metric_code: "revenue", total_value: 5 },
    { snapshot_id: "s4", fund_id: "f4", metric_code: "nav", total_value: "abc" },
    { snapshot_id: "s5", fund_id: "f5", metric_code: "nav" },
  )]]);
  const facts = await new PostgresProductionPlatform(db).portfolioValueFacts(identity);
  assert.deepEqual(facts, [
    { snapshotId: "s1", fundId: "f1", fund: "Fund One", period: "2026 Q2", publishedAt: "2026-08-01T00:00:00.000Z", metricCode: "nav", subjectLevel: "fund", currency: "USD", value: 1500.5, factCount: 2 },
    { snapshotId: "s2", fundId: "f2", fund: "f2", period: "2026 Q1", publishedAt: null, metricCode: "fair_value", subjectLevel: null, currency: null, value: 10, factCount: 0 },
  ]);
  assert.deepEqual(await new PostgresProductionPlatform(new FakeDb()).portfolioValueFacts({ ...identity, entitlements: { ...identity.entitlements, fundIds: [] } }), []);
});

test("exposure dimension facts keep only finite asset_type and sector rows", async () => {
  const db = new ScriptedDb([["holding_type as", rows(
    { snapshot_id: "s1", fund_id: "f1", dimension: "asset_type", subject_level: "holding", category: "equity", label: "Equity", currency: "USD", total_value: "42", fact_count: 3 },
    { snapshot_id: "s2", fund_id: "f2", dimension: "sector", total_value: 8 },
    { snapshot_id: "s3", fund_id: "f3", dimension: "region", total_value: 1 },
    { snapshot_id: "s4", fund_id: "f4", dimension: "sector", total_value: "n/a" },
    { snapshot_id: "s5", fund_id: "f5", dimension: "sector" },
  )]]);
  const facts = await new PostgresProductionPlatform(db).exposureDimensionFacts(identity);
  assert.deepEqual(facts, [
    { snapshotId: "s1", fundId: "f1", dimension: "asset_type", subjectLevel: "holding", category: "equity", label: "Equity", currency: "USD", value: 42, factCount: 3 },
    { snapshotId: "s2", fundId: "f2", dimension: "sector", subjectLevel: null, category: null, label: null, currency: null, value: 8, factCount: 0 },
  ]);
  assert.deepEqual(await new PostgresProductionPlatform(new FakeDb()).exposureDimensionFacts({ ...identity, entitlements: { ...identity.entitlements, fundIds: [] } }), []);
});

test("review refuses a stale version, a correction without a value and an unconfirmed or mismatched apply", async () => {
  const decision = { observationId: OBSERVATION_ID, decision: "approve" as const, reasonCode: "ok", expectedVersion: 2 };
  const applied = (db: FakeDb) => db.calls.some((call) => call.sql.includes("apply_review_decision"));
  const conflict = (code: string) => (error: unknown) => error instanceof ConflictError && error.code === code;

  const stale = new FakeDb();
  await assert.rejects(new PostgresProductionPlatform(stale).review(identity, { ...decision, expectedVersion: 5 }), conflict("observation_version_conflict"));
  assert.equal(applied(stale), false);

  const uncorrected = new FakeDb();
  await assert.rejects(new PostgresProductionPlatform(uncorrected).review(identity, { ...decision, decision: "correct" }), /Corrected value is required/);
  assert.equal(applied(uncorrected), false);

  const corrected = new FakeDb();
  corrected.reviewResult = { new_version: 3, next_state: "review_required" };
  const outcome = await new PostgresProductionPlatform(corrected).review(identity, { ...decision, decision: "correct", correctedValue: "125" });
  assert.deepEqual([outcome.newVersion, outcome.nextState], [3, "review_required"]);
  assert.equal(corrected.calls.find((call) => call.sql.includes("apply_review_decision"))?.parameters.at(-1), "125");

  const nothingApplied = new ScriptedDb([["apply_review_decision", rows()]]);
  await assert.rejects(new PostgresProductionPlatform(nothingApplied).review(identity, decision), conflict("observation_version_conflict"));

  const wrongVersion = new FakeDb();
  wrongVersion.reviewResult = { new_version: 9, next_state: "approved" };
  await assert.rejects(new PostgresProductionPlatform(wrongVersion).review(identity, decision), conflict("observation_version_conflict"));
});

test("reconciliation resolution requires a reason, an allowed action and a confirmed apply", async () => {
  const command = { exceptionId, expectedVersion: 1, action: "mark_immaterial" as const, reasonCode: "immaterial_variance" };
  const conflict = (code: string) => (error: unknown) => error instanceof ConflictError && error.code === code;
  const resolved = (db: FakeDb) => db.calls.some((call) => call.sql.includes("resolve_reconciliation_exception"));
  const withPreflight = (type: string) => {
    const db = new FakeDb();
    db.resolutionPreflight = { exception_id: exceptionId, exception_type: type, version: 1, status: "open" };
    return db;
  };

  const noReason = withPreflight("materiality");
  await assert.rejects(new PostgresProductionPlatform(noReason).resolveReconciliation(identity, { ...command, reasonCode: "" }), /Resolution reason is required/);
  assert.equal(noReason.calls.length, 0);

  const wrongAction = withPreflight("materiality");
  await assert.rejects(new PostgresProductionPlatform(wrongAction).resolveReconciliation(identity, { ...command, action: "accept_reconciliation" }), conflict("reconciliation_resolution_not_allowed"));
  assert.equal(resolved(wrongAction), false);

  const materiality = withPreflight("materiality");
  assert.deepEqual(
    { ...(await new PostgresProductionPlatform(materiality).resolveReconciliation(identity, command)), resolutionEventId: undefined },
    { accepted: true, resolutionEventId: undefined, newVersion: 2, status: "resolved" },
  );
  const accept = withPreflight("conflicting_values");
  assert.equal((await new PostgresProductionPlatform(accept).resolveReconciliation(identity, { ...command, action: "accept_reconciliation" })).status, "resolved");

  const nothingApplied = new ScriptedDb([["resolve_reconciliation_exception", rows()]]);
  nothingApplied.resolutionPreflight = { exception_id: exceptionId, exception_type: "materiality", version: 1, status: "open" };
  await assert.rejects(new PostgresProductionPlatform(nothingApplied).resolveReconciliation(identity, command), conflict("reconciliation_exception_not_found_or_version_conflict"));

  const wrongVersion = withPreflight("materiality");
  await assert.rejects(new PostgresProductionPlatform(wrongVersion).resolveReconciliation(identity, { ...command, expectedVersion: 4 }), conflict("reconciliation_exception_not_found_or_version_conflict"));
});

test("publish is blocked when the snapshot has no source observations, and unexpected persistence errors surface", async () => {
  const empty = new ScriptedDb([["needs_review_count", rows({ needs_review_count: 0, critical_count: 0, lineage_count: 0, total_count: 0 })]]);
  await assert.rejects(
    new PostgresProductionPlatform(empty).publish(identity, { snapshotId, action: "publish", expectedVersion: 1 }),
    (error: unknown) => error instanceof PublicationGateError && error.reasons.includes("incomplete_source_lineage"),
  );
  assert.equal(empty.calls.some((call) => call.sql.includes("append_snapshot_transition")), false);

  const broken = new FakeDb();
  broken.appendError = new Error("connection reset");
  await assert.rejects(new PostgresProductionPlatform(broken).publish(identity, { snapshotId, action: "publish", expectedVersion: 1 }), /connection reset/);

  // The P0001 translation applies to publication only; a withdraw failing the same way is a real fault.
  const gatedWithdraw = new FakeDb();
  gatedWithdraw.appendError = Object.assign(new Error("Postgres query failed (SQLSTATE P0001)"), { code: "P0001" });
  await assert.rejects(
    new PostgresProductionPlatform(gatedWithdraw).publish(identity, { snapshotId, action: "withdraw", expectedVersion: 1 }),
    (error: unknown) => !(error instanceof PublicationGateError) && (error as { code?: string }).code === "P0001",
  );

  const notAppended = new ScriptedDb([["append_snapshot_transition", rows()]]);
  await assert.rejects(
    new PostgresProductionPlatform(notAppended).publish(identity, { snapshotId, action: "withdraw", expectedVersion: 1 }),
    (error: unknown) => error instanceof ConflictError && error.code === "snapshot_not_found_or_version_conflict",
  );
});

test("export writes a checksummed manifest of the published snapshots and queues it", async () => {
  const db = new ScriptedDb([
    ["select snapshot_id,schema_version,taxonomy_version", rows({ snapshot_id: snapshotId, schema_version: "v2", taxonomy_version: "t3" }, { snapshot_id: "00000000-0000-0000-0000-000000000402" })],
    ["select count(*) as row_count", rows({ row_count: "12" })],
  ]);
  const manifest = await new PostgresProductionPlatform(db).export(identity, "csv");
  assert.deepEqual(
    { ...manifest, exportId: undefined, generatedAt: undefined, checksumSha256: undefined },
    { exportId: undefined, tenantId: identity.tenantId, generatedAt: undefined, schemaVersion: "v2", taxonomyVersion: "t3",
      snapshotIds: [snapshotId, "00000000-0000-0000-0000-000000000402"], format: "csv", rowCounts: { observations: 12, snapshots: 2 }, checksumSha256: undefined },
  );
  const { checksumSha256, ...manifestBase } = manifest;
  assert.equal(checksumSha256, createHash("sha256").update(JSON.stringify(manifestBase)).digest("hex"));
  assert.ok(!Number.isNaN(Date.parse(manifest.generatedAt)));
  const queued = db.calls.find((call) => call.sql.includes("corvis_serving.export_job"))!;
  assert.deepEqual([queued.parameters[0], queued.parameters[1], queued.parameters[3], queued.parameters[5]], [identity.tenantId, manifest.exportId, "csv", checksumSha256]);
  assert.equal(queued.parameters[6], JSON.stringify(manifest));
  assert.ok(db.calls.some((call) => call.sql.includes("corvis_control.outbox_event")));

  const none = new PostgresProductionPlatform(new FakeDb());
  const noSnapshots = await none.export(identity, "xlsx");
  assert.deepEqual([noSnapshots.schemaVersion, noSnapshots.taxonomyVersion, noSnapshots.snapshotIds, noSnapshots.rowCounts], ["v1", "v1", [], { observations: 0, snapshots: 0 }]);

  const defaults = new ScriptedDb([["select snapshot_id,schema_version,taxonomy_version", rows({ snapshot_id: snapshotId })]]);
  const defaulted = await new PostgresProductionPlatform(defaults).export(identity, "csv");
  assert.deepEqual([defaulted.schemaVersion, defaulted.taxonomyVersion], ["v1", "v1"]);
});

test("readiness reports every unconfigured binding as missing while orchestration is always configured", { concurrency: false }, async () => {
  const unset = {
    CORVIS_AUTH_ISSUER: undefined, CORVIS_AUTH_AUDIENCE: undefined, CORVIS_TRUSTED_AUTH_PROXY_SECRET: undefined, CORVIS_OBJECT_STORE_BUCKET: undefined,
    CORVIS_UPLOAD_ALLOWED_ORIGINS: undefined, CORVIS_SEARCH_ENDPOINT: undefined, CORVIS_AI_ENDPOINT: undefined, CORVIS_OBSERVABILITY_ENDPOINT: undefined,
    CORVIS_DEMO_MODE: "false", NODE_ENV: "test",
  };
  await withEnv(unset, async () => {
    assert.deepEqual(await new PostgresProductionPlatform(new FakeDb()).readiness(), {
      identity: "missing", objectStore: "missing", postgres: "configured", orchestration: "configured", retrieval: "missing", ai: "missing", observability: "missing",
    });
  });
  await withEnv({ ...unset, CORVIS_OBJECT_STORE_BUCKET: "bucket" }, async () => {
    assert.equal((await new PostgresProductionPlatform(new FakeDb()).readiness()).objectStore, "missing", "a bucket without an allowed upload origin is not ready");
  });
  await withEnv({ ...unset, CORVIS_UPLOAD_ALLOWED_ORIGINS: "https://uat.example" }, async () => {
    assert.equal((await new PostgresProductionPlatform(new FakeDb()).readiness()).objectStore, "missing", "an allowed origin without a bucket is not ready");
  });
  await withEnv({ ...unset, CORVIS_AUTH_ISSUER: "https://idp.example", CORVIS_AUTH_AUDIENCE: "corvis", CORVIS_TRUSTED_AUTH_PROXY_SECRET: "s" }, async () => {
    assert.equal((await new PostgresProductionPlatform(new UnhealthyDb()).readiness()).postgres, "missing");
  });
});

test("research fails closed through the permissioned research service when no AI endpoint is configured", { concurrency: false }, async () => {
  await withEnv({ NODE_ENV: "test", CORVIS_DEMO_MODE: "false", CORVIS_AI_ENDPOINT: undefined, CORVIS_POSTGRES_DSN: "postgres://corvis:secret@localhost:5432/corvis" }, async () => {
    const phases: string[] = [];
    await assert.rejects(
      new PostgresProductionPlatform(new FakeDb()).research(identity, "What is NAV?", { onProgress: (phase) => phases.push(phase) }),
      (error: unknown) => error instanceof ResearchProviderError && error.provider === "ai",
    );
    assert.deepEqual(phases, [], "no research phase starts before the provider check");
    await assert.rejects(new PostgresProductionPlatform(new FakeDb()).research(identity, "What is NAV?"), ResearchProviderError);
  });
});

test("platform() selects the Postgres platform outside demo mode and memoises it", { concurrency: false }, async () => {
  await withEnv({ NODE_ENV: "test", CORVIS_DEMO_MODE: "false", CORVIS_POSTGRES_DSN: "postgres://corvis:secret@localhost:5432/corvis" }, async () => {
    const selected = platform();
    assert.ok(selected instanceof PostgresProductionPlatform);
    assert.equal(platform(), selected);
  });
});

test("snapshot listing keeps every version with a truthful status, and the current-version reduction drives the summary", async () => {
  const otherId = "00000000-0000-0000-0000-000000000402";
  class HistoryDb extends FakeDb {
    override async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
      if (sql.includes("corvis_serving.fund_period_snapshots")) {
        const row = (id: string, version: number, status: string, fund: string, extra: PostgresRow = {}): PostgresRow =>
          ({ snapshot_id: id, version, fund_id: fund, fund_name: fund, report_period: "Q2 2026", status, created_at: "2026-08-01", published_at: null, blocking_exception_count: 0, ...extra });
        return [
          // Newest first, as the unpaged listing returns it: v3 withdrawn, v2 published, v1 draft.
          row(snapshotId, 3, "withdrawn", "Fund A"),
          row(snapshotId, 2, "published", "Fund A", { published_at: "2026-09-01T00:00:00Z" }),
          row(snapshotId, 1, "draft", "Fund A", { blocking_exception_count: 2 }),
          row(otherId, 2, "PUBLISHED", "Fund B", { published_at: "2026-09-02T00:00:00Z" }),
          row(otherId, 1, "blocked", "Fund B"),
          row("00000000-0000-0000-0000-000000000403", 2, "superseded", "Fund C"),
        ];
      }
      return super.query(sql, parameters);
    }
  }
  const listed = await new PostgresProductionPlatform(new HistoryDb()).listSnapshots(identity);
  // The Postgres list stays the full append-only history (the keyset-paged /snapshots listing relies on that)...
  assert.deepEqual(listed.map((item) => [item.id?.slice(-3), item.version, item.status]), [
    ["401", 3, "Withdrawn"], ["401", 2, "Published"], ["401", 1, "Review"],
    ["402", 2, "Published"], ["402", 1, "Review"], ["403", 2, "Superseded"],
  ]);
  assert.equal(new Set(listed.map(snapshotPaginationKey)).size, listed.length, "every version keeps a unique cursor key");
  // ...while consumers that need current state reduce it.
  assert.deepEqual(currentSnapshots(listed).map((item) => [item.id?.slice(-3), item.version, item.status]), [["401", 3, "Withdrawn"], ["402", 2, "Published"], ["403", 2, "Superseded"]]);
  const summary = buildWorkspaceSummary({ snapshots: listed, observations: [], documents: [], valueFacts: [], now: new Date("2026-09-25T12:00:00Z") });
  assert.deepEqual(summary.freshness.funds.map((row) => [row.fund, row.latestPublishedPeriod, row.preliminaryPeriods, row.stale]), [
    ["Fund A", null, 0, true],
    ["Fund B", "Q2 2026", 0, false],
    ["Fund C", null, 0, true],
  ]);
  assert.equal(summary.attention.counts.blocking_exception, 0, "the withdrawn snapshot's draft history carries no live blockers");
});
