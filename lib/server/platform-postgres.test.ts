import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AuthorizationError, type RequestIdentity } from "../../core/enterprise.ts";
import { ConflictError, PostgresProductionPlatform, PublicationGateError } from "./platform.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";

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
    if (sql.includes("count(*) filter (where review_state<>'approved')")) {
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
  assert.match(db.calls[0]?.sql ?? "", /document_id::text in/);
  assert.equal(db.calls[0]?.parameters[0], identity.tenantId);
  assert.equal(db.calls[0]?.parameters[1], JSON.stringify(identity.entitlements.documentIds));
});

test("empty resource allowlists fail closed before a broad Postgres read", async () => {
  const db = new FakeDb();
  const noResources: RequestIdentity = { ...identity, entitlements: { ...identity.entitlements, fundIds: [], documentIds: [] } };
  assert.deepEqual(await new PostgresProductionPlatform(db).listDocuments(noResources), []);
  assert.deepEqual(await new PostgresProductionPlatform(db).listObservations(noResources), []);
  assert.deepEqual(await new PostgresProductionPlatform(db).listSnapshots(noResources), []);
  assert.equal(db.calls.length, 0);
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
  assert.match(db.calls[0]?.sql ?? "", /r\.document_id::text in/);
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
  assert.match(db.calls[0]?.sql ?? "", /r\.document_id::text in/);
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
  assert.match(db.calls[0]?.sql ?? "", /r\.document_id::text in/);
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
  assert.match(db.calls[1]?.sql ?? "", /review_state<>'approved'/);
  const independentReview = db.calls.find((call) => call.sql.includes("independently_reviewed"));
  assert.ok(independentReview);
  assert.match(independentReview.sql, /r\.observation_version > coalesce/);
  assert.match(independentReview.sql, /c\.decision='correct'/);
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
