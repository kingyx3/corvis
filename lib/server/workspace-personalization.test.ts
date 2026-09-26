import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import { getWorkspacePersonalization, markWorkspaceVisited, normalizePinnedFundIds, updatePinnedFunds, WorkspacePersonalizationError } from "./workspace-personalization.ts";

const identity: RequestIdentity = {
  subject: "oidc|user-1",
  tenantId: "00000000-0000-0000-0000-000000000010",
  workspaceId: "00000000-0000-0000-0000-000000000020",
  roles: ["read_only"],
  authMethod: "oidc",
  sessionId: "session-1",
  entitlements: {
    workspaceIds: ["00000000-0000-0000-0000-000000000020"],
    fundIds: ["fund-a", "fund-b"],
    documentIds: [], sourceDocumentIds: [], sourceDocumentAccessAllowed: false, redistributionAllowed: false,
  },
};

class FakeDb implements PostgresSqlApi {
  calls: Array<{ sql: string; parameters: PostgresPrimitive[] }> = [];
  rows: PostgresRow[] = [];
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> { this.calls.push({ sql, parameters }); return this.rows; }
  async execute(): Promise<void> {}
  async health(): Promise<boolean> { return true; }
}

test("stored pins are re-filtered through current fund entitlements", async () => {
  const db = new FakeDb();
  db.rows = [{ pinned_fund_ids: ["fund-a", "revoked-fund"], last_seen_at: new Date("2026-09-20T00:00:00Z") }];
  const value = await getWorkspacePersonalization(identity, db);
  assert.deepEqual(value, { pinnedFundIds: ["fund-a"], lastSeenAt: "2026-09-20T00:00:00.000Z" });
  assert.deepEqual(db.calls[0]?.parameters, [identity.tenantId, identity.workspaceId, identity.authMethod, identity.subject]);
  assert.match(db.calls[0]!.sql, /tenant_id=\$1::uuid and workspace_id=\$2::uuid and auth_method=\$3 and subject=\$4/);
});

test("pin normalization rejects a fund outside the signed-in user's entitlement", () => {
  assert.deepEqual(normalizePinnedFundIds(identity, ["fund-a", "fund-a", "fund-b"]), ["fund-a", "fund-b"]);
  assert.throws(() => normalizePinnedFundIds(identity, ["fund-a", "fund-secret"]), (error: unknown) => error instanceof WorkspacePersonalizationError && error.code === "fund_not_entitled" && error.status === 403);
});

test("pin upsert is scoped to tenant workspace auth method and subject without advancing last seen", async () => {
  const db = new FakeDb();
  db.rows = [{ pinned_fund_ids: ["fund-a"], last_seen_at: new Date("2026-09-20T00:00:00Z") }];
  const result = await updatePinnedFunds(identity, ["fund-a"], db);
  assert.deepEqual(result, { pinnedFundIds: ["fund-a"], lastSeenAt: "2026-09-20T00:00:00.000Z" });
  assert.match(db.calls[0]!.sql, /on conflict \(tenant_id,workspace_id,auth_method,subject\) do update/);
  assert.doesNotMatch(db.calls[0]!.sql, /set last_seen_at=/);
  assert.deepEqual(db.calls[0]?.parameters?.slice(0, 4), [identity.tenantId, identity.workspaceId, identity.authMethod, identity.subject]);
});

test("visit cursor advances monotonically", async () => {
  const db = new FakeDb();
  db.rows = [{ last_seen_at: new Date("2026-09-26T06:00:00Z") }];
  const seen = await markWorkspaceVisited(identity, new Date("2026-09-26T06:00:00Z"), db);
  assert.equal(seen, "2026-09-26T06:00:00.000Z");
  assert.match(db.calls[0]!.sql, /last_seen_at=greatest\(corvis_control\.workspace_user_preference\.last_seen_at,excluded\.last_seen_at\)/);
});
