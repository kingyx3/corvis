import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { PostgresReconciliationServingRepository } from "./reconciliation-serving.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";

const identity: RequestIdentity = {
  subject: "user-1",
  tenantId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "workspace-1",
  roles: ["analyst"],
  entitlements: { workspaceIds: ["workspace-1"], fundIds: ["fund-a"], sourceDocumentAccessAllowed: false },
  authMethod: "oidc",
  sessionId: "session-1",
};

class FakeDb implements PostgresSqlApi {
  calls: Array<{ sql: string; parameters: PostgresPrimitive[] }> = [];
  rows: PostgresRow[] = [];
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.calls.push({ sql, parameters });
    return this.rows;
  }
  async execute(): Promise<void> {}
  async health(): Promise<boolean> { return true; }
}

const normalized = (sql: string) => sql.replace(/\s+/g, " ").trim().toLowerCase();

test("reconciliation serving is tenant and fund-entitlement scoped", async () => {
  const db = new FakeDb();
  await new PostgresReconciliationServingRepository(db).list(identity);
  const sql = normalized(db.calls[0]!.sql);
  assert.match(sql, /r\.tenant_id=\$1::uuid/);
  assert.match(sql, /join allowed_fund a on a\.fund_id=r\.fund_id/);
  assert.equal(db.calls[0]!.parameters[1], JSON.stringify(["fund-a"]));
});

test("missing fund entitlements fail closed", async () => {
  const db = new FakeDb();
  await new PostgresReconciliationServingRepository(db).list({
    ...identity,
    entitlements: { ...identity.entitlements, fundIds: undefined },
  });
  assert.equal(db.calls[0]!.parameters[1], "[]");
});

test("public reconciliation query does not expose internal processing identifiers", async () => {
  const db = new FakeDb();
  await new PostgresReconciliationServingRepository(db).list(identity);
  const sql = normalized(db.calls[0]!.sql);
  assert.doesNotMatch(sql, /canonicalization_run_id/);
  assert.doesNotMatch(sql, /idempotency_key/);
  assert.doesNotMatch(sql, /document_id/);
});

test("reconciliation route uses customer read permission and opaque pagination", async () => {
  const route = (await readFile("app/api/v1/reconciliations/route.ts", "utf8")).toLowerCase();
  assert.match(route, /resolveauthorizedrequestidentity/);
  assert.match(route, /assertpermission\(identity, "observations:read"\)/);
  assert.match(route, /paginate\(/);
  assert.match(route, /parselimit\(/);
  assert.doesNotMatch(route, /observations:review/);
});
