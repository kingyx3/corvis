import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { RequestIdentity } from "./enterprise.ts";
import { PostgresHoldingInstrumentServingRepository } from "../lib/server/holding-instrument-serving.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "../lib/server/postgres.ts";

const identity: RequestIdentity = {
  subject: "user-1",
  tenantId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "workspace-1",
  roles: ["analyst"],
  entitlements: { workspaceIds: ["workspace-1"], fundIds: ["fund-a", "fund-b"], sourceDocumentAccessAllowed: false },
  authMethod: "oidc",
  sessionId: "session-1",
};

class FakeDb implements PostgresSqlApi {
  calls: Array<{ sql: string; parameters: PostgresPrimitive[] }> = [];
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.calls.push({ sql, parameters });
    return [];
  }
  async execute(): Promise<void> {}
  async health(): Promise<boolean> { return true; }
}

const normalized = (sql: string) => sql.replace(/\s+/g, " ").trim().toLowerCase();

test("holding schema enforces exactly one polymorphic target and company-only instruments", async () => {
  const migration = (await readFile("db/postgres/migrations/035_holdings_instruments.sql", "utf8")).toLowerCase();
  assert.match(migration, /target_type in \('company','fund'\)/);
  assert.match(migration, /target_type='company' and target_company_id is not null and target_fund_id is null/);
  assert.match(migration, /target_type='fund' and target_fund_id is not null and target_company_id is null/);
  assert.match(migration, /instrument must belong to a company-targeted holding/);
  assert.match(migration, /force row level security/);
  assert.match(migration, /where review_state='approved'/);
});

test("holding serving is tenant scoped and fund-target holdings cannot leak an unentitled target fund", async () => {
  const db = new FakeDb();
  await new PostgresHoldingInstrumentServingRepository(db).holdings(identity);
  const sql = normalized(db.calls[0]!.sql);
  assert.match(sql, /h\.tenant_id=\$1::uuid/);
  assert.match(sql, /join allowed_fund a on a\.fund_id=h\.fund_id/);
  assert.match(sql, /exists \(select 1 from allowed_fund target where target\.fund_id=h\.target_fund_id\)/);
  assert.equal(db.calls[0]!.parameters[1], JSON.stringify(["fund-a", "fund-b"]));
});

test("instrument serving is tenant scoped and bounded by parent fund entitlement", async () => {
  const db = new FakeDb();
  await new PostgresHoldingInstrumentServingRepository(db).instruments(identity);
  const sql = normalized(db.calls[0]!.sql);
  assert.match(sql, /i\.tenant_id=\$1::uuid/);
  assert.match(sql, /join allowed_fund a on a\.fund_id=i\.fund_id/);
});

test("missing fund entitlements fail closed", async () => {
  const db = new FakeDb();
  await new PostgresHoldingInstrumentServingRepository(db).holdings({
    ...identity,
    entitlements: { ...identity.entitlements, fundIds: undefined },
  });
  assert.equal(db.calls[0]!.parameters[1], "[]");
});

test("holdings and instruments routes keep the standard auth and opaque-pagination contract", async () => {
  for (const resource of ["holdings", "instruments"]) {
    const route = (await readFile(`app/api/v1/${resource}/route.ts`, "utf8")).toLowerCase();
    assert.match(route, /resolveauthorizedrequestidentity/);
    assert.match(route, /assertpermission\(identity, "observations:read"\)/);
    assert.match(route, /paginate\(/);
    assert.match(route, /parselimit\(/);
  }
});
