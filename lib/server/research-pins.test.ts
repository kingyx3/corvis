import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity, ResearchAnswer } from "../../core/enterprise.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
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

const answer: ResearchAnswer = { answer: "NAV increased 4% quarter over quarter.", citations: [], semanticQueryIds: [] };

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

  db.queryQueue = [[{ count: 0 }], [{ pin_id: "pin-2", question: "What changed?", answer, asked_at: new Date("2026-09-20T00:00:00Z"), pinned_at: new Date("2026-09-22T00:00:00Z") }]];
  const pin = await pinResearchAnswer(identity, { question: "What changed?", answer, askedAt: "2026-09-20T00:00:00Z" }, db);
  assert.deepEqual(pin, { pinId: "pin-2", question: "What changed?", answer, askedAt: "2026-09-20T00:00:00.000Z", pinnedAt: "2026-09-22T00:00:00.000Z" });
  const insertCall = db.calls[1]!;
  assert.match(insertCall.sql, /insert into corvis_control\.research_answer_pin/);
  assert.equal(insertCall.parameters[5], JSON.stringify(answer));
});

test("pinResearchAnswer fails closed once the per-subject pin limit is reached", async () => {
  const db = new FakeDb();
  db.queryQueue = [[{ count: 50 }]];
  await assert.rejects(
    () => pinResearchAnswer(identity, { question: "What changed?", answer, askedAt: "2026-09-20T00:00:00Z" }, db),
    (error: unknown) => error instanceof ResearchPinError && error.code === "pin_limit_reached" && error.status === 409,
  );
});

test("unpinResearchAnswer scopes the delete to the caller and fails closed when nothing matched", async () => {
  const db = new FakeDb();
  db.rows = [];
  await assert.rejects(() => unpinResearchAnswer(identity, "pin-1", db), (error: unknown) => error instanceof ResearchPinError && error.code === "pin_not_found" && error.status === 404);

  db.rows = [{ pin_id: "pin-1" }];
  await unpinResearchAnswer(identity, "pin-1", db);
  assert.deepEqual(db.calls.at(-1)?.parameters, ["pin-1", identity.tenantId, identity.workspaceId, identity.authMethod, identity.subject]);
});
