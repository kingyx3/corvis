import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { RequestIdentity } from "./enterprise.ts";
import { PostgresPublicServingResourceRepository } from "../lib/server/public-serving-resources.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "../lib/server/postgres.ts";

const identity: RequestIdentity = {
  subject: "user-1",
  tenantId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "workspace-1",
  roles: ["analyst"],
  entitlements: {
    workspaceIds: ["workspace-1"],
    fundIds: ["fund-a", "fund-b"],
    sourceDocumentAccessAllowed: false,
  },
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

function normalized(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

const NEW_RESOURCES = ["funds", "companies", "metric-definitions", "consolidated-facts", "company-lifecycle-events"] as const;

test("fund directory is bounded by authoritative fund entitlements", async () => {
  const db = new FakeDb();
  await new PostgresPublicServingResourceRepository(db).funds(identity);
  assert.equal(db.calls.length, 1);
  assert.match(normalized(db.calls[0]!.sql), /jsonb_array_elements_text\(\$1::jsonb\)/);
  assert.match(normalized(db.calls[0]!.sql), /join allowed_fund/);
  assert.equal(db.calls[0]!.parameters[0], JSON.stringify(["fund-a", "fund-b"]));
});

test("missing fund entitlements fail closed instead of widening access", async () => {
  const db = new FakeDb();
  await new PostgresPublicServingResourceRepository(db).funds({
    ...identity,
    entitlements: { ...identity.entitlements, fundIds: undefined },
  });
  assert.equal(db.calls[0]!.parameters[0], "[]");
});

test("company visibility comes from approved observations or approved company holdings on entitled funds", async () => {
  const db = new FakeDb();
  await new PostgresPublicServingResourceRepository(db).companies(identity);
  const sql = normalized(db.calls[0]!.sql);
  assert.match(sql, /o\.tenant_id=\$1::uuid/);
  assert.match(sql, /o\.review_state='approved'/);
  assert.match(sql, /from corvis_serving\.holdings h/);
  assert.match(sql, /h\.tenant_id=\$1::uuid/);
  assert.match(sql, /h\.target_type='company'/);
  assert.match(sql, /h\.target_company_id is not null/);
  assert.match(sql, /join allowed_fund a on a\.fund_id=h\.fund_id/);
  assert.match(sql, /union/);
  assert.match(sql, /join visible_company/);
});

test("consolidated facts require entitlement and membership in a published snapshot", async () => {
  const db = new FakeDb();
  await new PostgresPublicServingResourceRepository(db).consolidatedFacts(identity);
  const sql = normalized(db.calls[0]!.sql);
  assert.match(sql, /f\.tenant_id=\$1::uuid/);
  assert.match(sql, /join allowed_fund/);
  assert.match(sql, /s\.status='published'/);
  assert.match(sql, /f\.consolidated_fact_id=any\(s\.fact_ids\)/);
});

test("lifecycle API uses holding-derived visibility and refuses hidden participants", async () => {
  const db = new FakeDb();
  await new PostgresPublicServingResourceRepository(db).companyLifecycleEvents(identity);
  const sql = normalized(db.calls[0]!.sql);
  assert.match(sql, /from corvis_serving\.holdings h/);
  assert.match(sql, /h\.tenant_id=\$1::uuid/);
  assert.match(sql, /join allowed_fund a on a\.fund_id=h\.fund_id/);
  assert.match(sql, /not exists \( select 1 from corvis_identity\.entity_lifecycle_participant hidden/);
  assert.match(sql, /not exists \(select 1 from visible_company/);
  assert.match(sql, /not exists \(select 1 from allowed_fund/);
});

test("new public collection routes authenticate, authorize and use opaque pagination", async () => {
  for (const resource of NEW_RESOURCES) {
    const source = (await readFile(`app/api/v1/${resource}/route.ts`, "utf8")).toLowerCase();
    assert.match(source, /resolveauthorizedrequestidentity/);
    assert.match(source, /assertpermission\(identity, "observations:read"\)/);
    assert.match(source, /paginate\(/);
    assert.match(source, /parselimit\(/);
    assert.match(source, /nextcursor/);
  }
});

test("new public resources are part of the versioned OpenAPI contract", async () => {
  const openapi = await readFile("openapi/corvis-v1.yaml", "utf8");
  for (const resource of NEW_RESOURCES) {
    assert.ok(openapi.includes(`  /${resource}:\n`), `OpenAPI missing /${resource}`);
  }
  assert.match(openapi, /global identity alone never creates entitlement/i);
  assert.match(openapi, /included in a published fund-period snapshot/i);
});

test("resource tranche intentionally does not fake holdings or instruments", async () => {
  const contract = (await readFile("docs/API_CONVENTIONS.md", "utf8")).toLowerCase();
  assert.ok(contract.includes("/api/v1"));
  const repository = (await readFile("lib/server/public-serving-resources.ts", "utf8")).toLowerCase();
  assert.doesNotMatch(repository, /targettype:\s*company_id\s*\?/);
});
