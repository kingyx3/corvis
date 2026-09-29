import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity, ResearchAnswer } from "../../core/enterprise.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import { NO_GROUNDED_FIGURES_ANSWER } from "./research-grounding.ts";
import { listResearchPins, pinResearchAnswer, ResearchPinError, unpinResearchAnswer } from "./research-pins.ts";

// CI runs unit tests with CORVIS_DEMO_MODE=true (see .github/workflows/ci.yml),
// which would otherwise short-circuit every function under test to its
// demo-mode branch before it ever touches the FakeDb below. This suite
// exercises the real Postgres-backed path, same pattern as
// lib/server/workspace-personalization.test.ts.
process.env.CORVIS_DEMO_MODE = "false";

const identity: RequestIdentity = {
  subject: "oidc|user-1",
  tenantId: "00000000-0000-0000-0000-000000000010",
  workspaceId: "00000000-0000-0000-0000-000000000020",
  roles: ["read_only"],
  authMethod: "oidc",
  sessionId: "session-1",
  entitlements: {
    workspaceIds: ["00000000-0000-0000-0000-000000000020"],
    fundIds: [],
    documentIds: [], sourceDocumentIds: [], sourceDocumentAccessAllowed: false, redistributionAllowed: false,
  },
};

const answer: ResearchAnswer = { answer: "NAV increased quarter over quarter.", citations: [], semanticQueryIds: [] };

class FakeDb implements PostgresSqlApi {
  calls: Array<{ sql: string; parameters: PostgresPrimitive[] }> = [];
  rows: PostgresRow[] = [];
  queryQueue: PostgresRow[][] = [];
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.calls.push({ sql, parameters });
    if (this.queryQueue.length) return this.queryQueue.shift()!;
    return this.rows;
  }
  async execute(): Promise<void> {}
  async health(): Promise<boolean> { return true; }
}

test("listResearchPins scopes the lookup to tenant/workspace/auth method/subject", async () => {
  const db = new FakeDb();
  db.rows = [{ pin_id: "pin-1", question: "What changed?", answer, asked_at: new Date("2026-09-20T00:00:00Z"), pinned_at: new Date("2026-09-21T00:00:00Z") }];
  const pins = await listResearchPins(identity, db);
  assert.deepEqual(pins, [{ pinId: "pin-1", question: "What changed?", answer, askedAt: "2026-09-20T00:00:00.000Z", pinnedAt: "2026-09-21T00:00:00.000Z" }]);
  assert.deepEqual(db.calls[0]?.parameters.slice(0, 4), [identity.tenantId, identity.workspaceId, identity.authMethod, identity.subject]);
  assert.match(db.calls[0]!.sql, /tenant_id=\$1::uuid and workspace_id=\$2::uuid and auth_method=\$3 and subject=\$4/);
});

test("pinResearchAnswer rejects an empty question and stores the exact answer payload otherwise", async () => {
  const db = new FakeDb();
  await assert.rejects(() => pinResearchAnswer(identity, { question: "   ", answer, askedAt: "2026-09-20T00:00:00Z" }, db), (error: unknown) => error instanceof ResearchPinError && error.code === "invalid_question");

  db.queryQueue = [[], [{ count: 0 }], [{ pin_id: "pin-2", question: "What changed?", answer, asked_at: new Date("2026-09-20T00:00:00Z"), pinned_at: new Date("2026-09-22T00:00:00Z") }]];
  const pin = await pinResearchAnswer(identity, { question: "What changed?", answer, askedAt: "2026-09-20T00:00:00Z" }, db);
  assert.deepEqual(pin, { pinId: "pin-2", question: "What changed?", answer, askedAt: "2026-09-20T00:00:00.000Z", pinnedAt: "2026-09-22T00:00:00.000Z" });
  assert.match(db.calls[0]!.sql, /pg_advisory_xact_lock/);
  const insertCall = db.calls[2]!;
  assert.match(insertCall.sql, /insert into corvis_control\.research_answer_pin/);
  assert.equal(insertCall.parameters[5], JSON.stringify(answer));
});

test("pinResearchAnswer fails closed once the per-subject pin limit is reached", async () => {
  const db = new FakeDb();
  db.queryQueue = [[], [{ count: 50 }]];
  await assert.rejects(
    () => pinResearchAnswer(identity, { question: "What changed?", answer, askedAt: "2026-09-20T00:00:00Z" }, db),
    (error: unknown) => error instanceof ResearchPinError && error.code === "pin_limit_reached" && error.status === 409,
  );
});

test("pinResearchAnswer serializes concurrent pin attempts from the same subject with an advisory lock", async () => {
  const db = new FakeDb();
  db.queryQueue = [[], [{ count: 0 }], [{ pin_id: "pin-3", question: "What changed?", answer, asked_at: new Date("2026-09-20T00:00:00Z"), pinned_at: new Date("2026-09-22T00:00:00Z") }]];
  await pinResearchAnswer(identity, { question: "What changed?", answer, askedAt: "2026-09-20T00:00:00Z" }, db);
  const lockCall = db.calls[0]!;
  assert.match(lockCall.sql, /select pg_advisory_xact_lock\(hashtextextended\(\$1, 0\)\)/);
  assert.equal(lockCall.parameters[0], `${identity.tenantId}:${identity.workspaceId}:${identity.authMethod}:${identity.subject}`);
});

test("unpinResearchAnswer scopes the delete to the caller and fails closed when nothing matched", async () => {
  const db = new FakeDb();
  db.rows = [];
  await assert.rejects(() => unpinResearchAnswer(identity, "pin-1", db), (error: unknown) => error instanceof ResearchPinError && error.code === "pin_not_found" && error.status === 404);

  db.rows = [{ pin_id: "pin-1" }];
  await unpinResearchAnswer(identity, "pin-1", db);
  assert.deepEqual(db.calls.at(-1)?.parameters, ["pin-1", identity.tenantId, identity.workspaceId, identity.authMethod, identity.subject]);
});

test("pinResearchAnswer rejects an oversized answer payload", async () => {
  const db = new FakeDb();
  await assert.rejects(
    pinResearchAnswer(identity, { question: "Q", askedAt: "2026-05-01T00:00:00.000Z", answer: { ...answer, answer: "x".repeat(70_000) } }, db),
    (error: unknown) => error instanceof ResearchPinError && error.code === "invalid_answer",
  );
});

// ---------------------------------------------------------------------------
// #233: pin integrity (the client payload is verified, not trusted)
// ---------------------------------------------------------------------------

const SQ = "sq_0123456789abcdef01234567";
const SRC = "00000000-0000-0000-0000-000000000401";
const pinnedRow = (stored: unknown) => ({ pin_id: "pin-9", question: "Q", answer: stored, asked_at: new Date("2026-09-20T00:00:00Z"), pinned_at: new Date("2026-09-22T00:00:00Z") });
const readerIdentity: RequestIdentity = {
  ...identity,
  entitlements: { ...identity.entitlements, sourceDocumentAccessAllowed: true, sourceDocumentIds: ["doc-1"], documentIds: undefined },
};
const groundedAnswer = (): ResearchAnswer => ({
  answer: "Revenue was 100.",
  citations: [{ sourceReferenceId: SRC, documentId: "doc-1", label: "Report", page: 2 }],
  semanticQueryIds: [SQ],
  computedResults: [{ semanticQueryId: SQ, status: "executed", metricCode: "revenue", operation: "values", rows: [{ value_number: 100 }] }],
});
const pin = (db: FakeDb, payload: unknown, caller: RequestIdentity = readerIdentity) =>
  pinResearchAnswer(caller, { question: "Q", askedAt: "2026-09-20T00:00:00Z", answer: payload as ResearchAnswer }, db);
const rejectedWith = (code: string, status?: number) => (error: unknown) =>
  error instanceof ResearchPinError && error.code === code && (status === undefined || error.status === status);

test("a well-formed, entitled answer is pinned after its citations and query ids are verified against the caller", async () => {
  const db = new FakeDb();
  db.queryQueue = [
    [{ source_reference_id: SRC, document_id: "doc-1" }],
    [{ semantic_query_id: SQ }],
    [], [{ count: 0 }], [pinnedRow(groundedAnswer())],
  ];
  const result = await pin(db, groundedAnswer());
  assert.equal(result.pinId, "pin-9");
  assert.match(db.calls[0]!.sql, /corvis_serving\.source_references/);
  assert.deepEqual(db.calls[0]!.parameters.slice(0, 1), [identity.tenantId]);
  assert.match(db.calls[1]!.sql, /corvis_control\.semantic_query_log/);
  assert.deepEqual(db.calls[1]!.parameters, [identity.tenantId, JSON.stringify([SQ])]);
  assert.deepEqual(JSON.parse(String(db.calls[4]!.parameters[5])), groundedAnswer());
});

test("a pinned answer with a citation the caller may not read is rejected with 403 and nothing is written", async () => {
  for (const rows of [[], [{ source_reference_id: SRC, document_id: "doc-2" }]]) {
    const db = new FakeDb();
    db.queryQueue = [rows, [{ semantic_query_id: SQ }]];
    await assert.rejects(pin(db, groundedAnswer()), rejectedWith("answer_not_permitted", 403));
    assert.ok(!db.calls.some((call) => /insert into|pg_advisory/.test(call.sql)));
  }
  // document not in the caller's source-document entitlement: rejected before any lookup
  const db = new FakeDb();
  await assert.rejects(pin(db, { ...groundedAnswer(), citations: [{ ...groundedAnswer().citations[0]!, documentId: "doc-9" }] }), rejectedWith("answer_not_permitted", 403));
});

test("a pinned answer citing a semantic query unknown to the caller's tenant is rejected with 403", async () => {
  const db = new FakeDb();
  db.queryQueue = [[{ source_reference_id: SRC, document_id: "doc-1" }], []];
  await assert.rejects(pin(db, groundedAnswer()), rejectedWith("answer_not_permitted", 403));
  assert.ok(!db.calls.some((call) => /insert into/.test(call.sql)));
});

test("pinned answers must match the ResearchAnswer shape strictly", async () => {
  const db = new FakeDb();
  const bad: unknown[] = [
    null, "text", [], { ...groundedAnswer(), extra: true }, { ...groundedAnswer(), answer: 5 }, { ...groundedAnswer(), answer: "" },
    { ...groundedAnswer(), citations: "none" }, { ...groundedAnswer(), citations: Array.from({ length: 21 }, () => groundedAnswer().citations[0]) },
    { ...groundedAnswer(), citations: [{ ...groundedAnswer().citations[0], label: 7 }] },
    { ...groundedAnswer(), semanticQueryIds: ["forged"] },
    { ...groundedAnswer(), semanticQueryIds: Array.from({ length: 11 }, () => SQ) },
    { ...groundedAnswer(), computedResults: [{ ...groundedAnswer().computedResults![0], semanticQueryId: "sq_ffffffffffffffffffffffff" }] },
    { ...groundedAnswer(), computedResults: [{ ...groundedAnswer().computedResults![0], rows: [{ value_number: { nested: 1 } }] }] },
  ];
  for (const payload of bad) await assert.rejects(pin(db, payload), rejectedWith("invalid_answer", 400));
  assert.equal(db.calls.length, 0);
});

test("figures in a pinned answer must be grounded in its computed rows; a forged no-grounded-figures marker is rejected", async () => {
  const db = new FakeDb();
  await assert.rejects(pin(db, { ...groundedAnswer(), answer: "Revenue was 999." }), rejectedWith("invalid_answer"));
  await assert.rejects(pin(db, { answer: "NAV increased 4% quarter over quarter.", citations: [], semanticQueryIds: [] }), rejectedWith("invalid_answer"));
  await assert.rejects(pin(db, { ...groundedAnswer(), uncertainty: "Might be 40% off." }), rejectedWith("invalid_answer"));
  await assert.rejects(pin(db, { answer: "Revenue was 999.", citations: [], semanticQueryIds: [], grounding: "no_grounded_figures" }), rejectedWith("invalid_answer"));
  assert.equal(db.calls.length, 0);
  // the server's own downgraded answer can be pinned
  db.queryQueue = [[{ semantic_query_id: SQ }], [], [{ count: 0 }], [pinnedRow({})]];
  await pin(db, { answer: NO_GROUNDED_FIGURES_ANSWER, citations: [], semanticQueryIds: [SQ], grounding: "no_grounded_figures" });
});

test("demo identities still get shape and grounding validation but never touch the database", async () => {
  const db = new FakeDb();
  const demo: RequestIdentity = { ...identity, authMethod: "demo" };
  const stored = await pin(db, { answer: "Demo response for: hi", citations: [{ sourceReferenceId: "demo-source-1", documentId: "demo-document", label: "Demo", page: 12, hasOpenReconciliation: true }], semanticQueryIds: [], uncertainty: "Demo mode" }, demo);
  assert.equal(stored.answer.answer, "Demo response for: hi");
  await assert.rejects(pin(db, { answer: "x", citations: [], semanticQueryIds: [], extra: 1 }, demo), rejectedWith("invalid_answer"));
  assert.equal(db.calls.length, 0);
});
