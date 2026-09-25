import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { PostgresCompanySectorRepository } from "./company-sectors.ts";
import { ConflictError } from "./platform.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";

const identity: RequestIdentity = {
  subject: "oidc|reviewer-1",
  tenantId: "00000000-0000-0000-0000-000000000010",
  workspaceId: "00000000-0000-0000-0000-000000000020",
  roles: ["reviewer"],
  authMethod: "oidc",
  sessionId: "session-1",
  entitlements: {
    workspaceIds: ["00000000-0000-0000-0000-000000000020"],
    fundIds: ["fund-a"],
    documentIds: [],
    sourceDocumentIds: [],
    sourceDocumentAccessAllowed: false,
    redistributionAllowed: false,
  },
};

class SectorDb implements PostgresSqlApi {
  calls: Array<{ sql: string; parameters: PostgresPrimitive[] }> = [];
  entitled = true;
  newVersion: number | null = 1;
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.calls.push({ sql, parameters });
    if (sql.includes("assign_company_sector")) return [{ new_version: this.newVersion }];
    if (sql.includes("select 1 from entitled_company")) return this.entitled ? [{ "?column?": 1 }] : [];
    return [
      { company_id: "c-alpha", company_name: "Alpha Co", fund_ids: ["fund-a"], sector_code: "technology", sector_name: "Technology", taxonomy_version: "corvis_sector_v1", version: 2, classified_by: "oidc|reviewer-2", classified_at: new Date("2026-09-01T00:00:00Z") },
      { company_id: "c-beta", company_name: "Beta Co", fund_ids: "{fund-a,fund-b}", sector_code: null, sector_name: null, taxonomy_version: null, version: null, classified_by: null, classified_at: null },
    ];
  }
  async execute(): Promise<void> {}
  async health(): Promise<boolean> { return true; }
}

test("the company sector listing is scoped to companies the caller's entitled funds hold", async () => {
  const db = new SectorDb();
  const rows = await new PostgresCompanySectorRepository(db).list(identity);
  assert.deepEqual(rows.map((row) => [row.company, row.sectorCode, row.sectorName, row.version, row.fundIds, row.classifiedAt]), [
    ["Alpha Co", "technology", "Technology", 2, ["fund-a"], "2026-09-01T00:00:00.000Z"],
    ["Beta Co", null, null, 0, ["fund-a", "fund-b"], null],
  ]);
  const { sql, parameters } = db.calls[0]!;
  assert.deepEqual(parameters, [identity.tenantId, JSON.stringify(["fund-a"])]);
  assert.match(sql, /from corvis_serving\.holdings h[\s\S]*h\.fund_id in \(select jsonb_array_elements_text\(\$2::jsonb\)\)[\s\S]*h\.target_type='company'/);
  assert.match(sql, /left join corvis_serving\.company_sectors cs on cs\.tenant_id=\$1::uuid/);

  const none = new SectorDb();
  assert.deepEqual(await new PostgresCompanySectorRepository(none).list({ ...identity, entitlements: { ...identity.entitlements, fundIds: [] } }), []);
  assert.equal(none.calls.length, 0);
});

test("assignment checks entitlement first, then runs the governed function with the caller as actor", async () => {
  const db = new SectorDb();
  const outcome = await new PostgresCompanySectorRepository(db).assign(identity, { companyId: "c-beta", sectorCode: "industrials", expectedVersion: 0, reason: "Primary business activity" });
  assert.deepEqual(outcome, { accepted: true, companyId: "c-beta", sectorCode: "industrials", newVersion: 1 });
  assert.match(db.calls[0]!.sql, /select 1 from entitled_company where company_id=\$3/);
  assert.deepEqual(db.calls[0]!.parameters, [identity.tenantId, JSON.stringify(["fund-a"]), "c-beta"]);
  assert.match(db.calls[1]!.sql, /corvis_facts\.assign_company_sector\(\$1::uuid,\$2,\$3,\$4,\$5,\$6\)/);
  assert.deepEqual(db.calls[1]!.parameters, [identity.tenantId, "c-beta", "industrials", 0, identity.subject, "Primary business activity"]);
});

test("an unentitled company and a stale version are both 409s, and the unentitled one never reaches the write", async () => {
  const unentitled = new SectorDb();
  unentitled.entitled = false;
  await assert.rejects(
    new PostgresCompanySectorRepository(unentitled).assign(identity, { companyId: "c-other", sectorCode: "energy", expectedVersion: 0, reason: "x" }),
    (error: unknown) => error instanceof ConflictError && error.code === "company_not_found_or_version_conflict",
  );
  assert.equal(unentitled.calls.some((call) => call.sql.includes("assign_company_sector")), false);

  const stale = new SectorDb();
  stale.newVersion = null;
  await assert.rejects(
    new PostgresCompanySectorRepository(stale).assign(identity, { companyId: "c-beta", sectorCode: "energy", expectedVersion: 3, reason: "x" }),
    (error: unknown) => error instanceof ConflictError && error.code === "company_sector_version_conflict",
  );
});
