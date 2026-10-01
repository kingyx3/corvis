import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity, ResearchAnswer } from "../../core/enterprise.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import { computedRowsDigest, NO_GROUNDED_FIGURES_ANSWER } from "./research-grounding.ts";
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
  const bulky = { semanticQueryId: "sq_0123456789abcdef01234567", status: "executed", metricCode: "revenue", operation: "values", rows: Array.from({ length: 2000 }, (_, i) => ({ value_number: i, note: "n".repeat(400) })) };
  await assert.rejects(
    pinResearchAnswer(identity, { question: "Q", askedAt: "2026-05-01T00:00:00.000Z", answer: { ...answer, computedResults: [bulky] } as ResearchAnswer }, db),
    (error: unknown) => error instanceof ResearchPinError && error.code === "invalid_answer",
  );
});

test("a full 200-row semantic result is small enough to pin", async () => {
  const db = new FakeDb();
  // Same columns as the semantic executeRows query.
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const rows = Array.from({ length: 200 }, (_, i) => ({
    observation_id: uuid(i), fund_id: uuid(1000), company_id: uuid(2000 + i), holding_id: uuid(3000 + i), instrument_id: null, metric_code: "net_asset_value",
    value_number: 1000 + i, value_string: null, currency: "USD", economic_period: "2026-Q2", report_date: "2026-06-30",
    source_reference_id: uuid(4000 + i), version: 3, updated_at: "2026-07-01T00:00:00.000Z", subject_type: "holding",
  }));
  const big = {
    answer: "Net asset value by holding.", citations: [], semanticQueryIds: ["sq_0123456789abcdef01234567"],
    computedResults: [{ semanticQueryId: "sq_0123456789abcdef01234567", status: "executed", metricCode: "nav", operation: "values", rows }],
  } as ResearchAnswer;
  assert.ok(JSON.stringify(big).length > 64 * 1024, "the fixture must exceed the old cap");
  db.queryQueue = [
    [{ semantic_query_id: "sq_0123456789abcdef01234567", query_shape: { fundIds: ["fund-1"], documentIds: ["doc-1"] }, result_rows_sha256: computedRowsDigest(rows) }],
    [], [{ count: 0 }], [{ pin_id: "pin-3", question: "Q", answer: big, asked_at: new Date("2026-09-20T00:00:00Z"), pinned_at: new Date("2026-09-22T00:00:00Z") }],
  ];
  const pinned = await pinResearchAnswer(readerIdentity, { question: "Q", answer: big, askedAt: "2026-09-20T00:00:00Z" }, db);
  assert.equal(pinned.pinId, "pin-3");
});

// ---------------------------------------------------------------------------
// #233: pin integrity (the client payload is verified, not trusted)
// ---------------------------------------------------------------------------

const SQ = "sq_0123456789abcdef01234567";
const SRC = "00000000-0000-0000-0000-000000000401";
const pinnedRow = (stored: unknown) => ({ pin_id: "pin-9", question: "Q", answer: stored, asked_at: new Date("2026-09-20T00:00:00Z"), pinned_at: new Date("2026-09-22T00:00:00Z") });
const readerIdentity: RequestIdentity = {
  ...identity,
  entitlements: { ...identity.entitlements, sourceDocumentAccessAllowed: true, sourceDocumentIds: ["doc-1"], documentIds: ["doc-1"], fundIds: ["fund-1"] },
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
    [{ semantic_query_id: SQ, query_shape: { fundIds: ["fund-1"], documentIds: ["doc-1"] }, result_rows_sha256: computedRowsDigest(groundedAnswer().computedResults![0]!.rows) }],
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
  db.queryQueue = [[{ semantic_query_id: SQ, query_shape: { fundIds: [], documentIds: [] } }], [], [{ count: 0 }], [pinnedRow({})]];
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

test("pinned computed rows must be exactly the rows the server logged for that query (#245)", async () => {
  const logged = computedRowsDigest(groundedAnswer().computedResults![0]!.rows);
  // Forged rows that stay internally consistent ("Revenue was 999." backed by a 999 row) are still rejected.
  const forged: ResearchAnswer = { ...groundedAnswer(), answer: "Revenue was 999.", computedResults: [{ ...groundedAnswer().computedResults![0]!, rows: [{ value_number: 999 }] }] };
  for (const digest of [logged, null]) {
    const db = new FakeDb();
    db.queryQueue = [[{ source_reference_id: SRC, document_id: "doc-1" }], [{ semantic_query_id: SQ, query_shape: { fundIds: ["fund-1"], documentIds: ["doc-1"] }, result_rows_sha256: digest }]];
    await assert.rejects(pin(db, digest === null ? groundedAnswer() : forged), rejectedWith("answer_not_permitted", 403));
    assert.ok(!db.calls.some((call) => /insert into/.test(call.sql)), "nothing is written");
  }
});

test("the rows digest ignores key order and matches Postgres timestamps after the API's RFC 3339 rewrite", () => {
  assert.equal(
    computedRowsDigest([{ b: 1, a: "2026-09-29 10:11:12.5+00", c: ["x"] }]),
    computedRowsDigest([{ a: "2026-09-29T10:11:12.5Z", c: ["x"], b: 1 }]),
  );
  assert.notEqual(computedRowsDigest([{ a: 1 }]), computedRowsDigest([{ a: 2 }]));
});

test("listing pins re-checks access to every cited document, so lost access hides the pin", async () => {
  const cited = groundedAnswer();
  const rows = () => [
    pinnedRow(answer),
    { ...pinnedRow(cited), pin_id: "pin-cited" },
  ];
  const ids = (pins: Array<{ pinId: string }>) => pins.map((pin) => pin.pinId);

  const stillAllowed = new FakeDb();
  stillAllowed.queryQueue = [rows(), [{ source_reference_id: SRC, document_id: "doc-1" }], [{ semantic_query_id: SQ, query_shape: { fundIds: ["fund-1"], documentIds: ["doc-1"] }, result_rows_sha256: computedRowsDigest(cited.computedResults![0]!.rows) }]];
  assert.deepEqual(ids(await listResearchPins(readerIdentity, stillAllowed)), ["pin-9", "pin-cited"]);
  assert.match(stillAllowed.calls[1]!.sql, /corvis_serving\.source_references/);

  const accessRevoked = new FakeDb();
  accessRevoked.queryQueue = [rows(), [{ source_reference_id: SRC, document_id: "doc-1" }]];
  assert.deepEqual(ids(await listResearchPins(identity, accessRevoked)), ["pin-9"], "an identity without source-document access no longer sees the cited pin");

  const movedDocument = new FakeDb();
  movedDocument.queryQueue = [rows(), [{ source_reference_id: SRC, document_id: "doc-other" }]];
  assert.deepEqual(ids(await listResearchPins(readerIdentity, movedDocument)), ["pin-9"]);

  const uncitedOnly = new FakeDb();
  uncitedOnly.queryQueue = [[pinnedRow(answer)]];
  await listResearchPins(identity, uncitedOnly);
  assert.equal(uncitedOnly.calls.length, 1, "no extra query when nothing is cited");
});


test("uncited computed pins are hidden after fund or document access is revoked", async () => {
  const stored = { ...groundedAnswer(), citations: [] };
  for (const scope of [{ fundIds: ["revoked-fund"], documentIds: ["doc-1"] }, { fundIds: ["fund-1"], documentIds: ["revoked-doc"] }]) {
    const db = new FakeDb();
    db.queryQueue = [[pinnedRow(stored)], [{ semantic_query_id: SQ, query_shape: scope, result_rows_sha256: computedRowsDigest(stored.computedResults![0]!.rows) }]];
    assert.deepEqual(await listResearchPins(readerIdentity, db), []);
  }
});

test("pin creation rejects a server-recorded query outside current resource entitlements", async () => {
  const db = new FakeDb();
  const stored = { ...groundedAnswer(), citations: [] };
  db.queryQueue = [[{ semantic_query_id: SQ, query_shape: { fundIds: ["revoked-fund"], documentIds: ["doc-1"] }, result_rows_sha256: computedRowsDigest(stored.computedResults![0]!.rows) }], [], [{ count: 0 }], [pinnedRow(stored)]];
  await assert.rejects(pin(db, stored), rejectedWith("answer_not_permitted", 403));
  assert.ok(!db.calls.some((call) => /insert into/.test(call.sql)));
});


test("pin authorization fails closed for absent, malformed and incomplete recorded query scopes", async () => {
  for (const scope of [undefined, null, {}, "not json", { fundIds: ["fund-1"] }, { fundIds: ["fund-1"], documentIds: [42] }]) {
    const db = new FakeDb();
    db.queryQueue = [[{ semantic_query_id: SQ, query_shape: scope, result_rows_sha256: computedRowsDigest(groundedAnswer().computedResults![0]!.rows) }]];
    await assert.rejects(pin(db, { ...groundedAnswer(), citations: [] }), rejectedWith("answer_not_permitted", 403));
  }
});

test("uncited computed pins remain readable only while the complete recorded scope and digest match", async () => {
  const stored = { ...groundedAnswer(), citations: [] };
  for (const digest of [computedRowsDigest(stored.computedResults![0]!.rows), null, "forged"]) {
    const db = new FakeDb();
    db.queryQueue = [[pinnedRow(stored)], [{ semantic_query_id: SQ, query_shape: JSON.stringify({ fundIds: ["fund-1"], documentIds: ["doc-1"] }), result_rows_sha256: digest }]];
    const pins = await listResearchPins(readerIdentity, db);
    assert.equal(pins.length, digest === computedRowsDigest(stored.computedResults![0]!.rows) ? 1 : 0);
    assert.equal(db.calls.length, 2);
  }
});
