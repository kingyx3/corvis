import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// See lib/server/source-connections-routes.test.ts for why this loader is needed.
register(new URL("./test-support/alias-loader.mjs", import.meta.url), import.meta.url);

process.env.CORVIS_DEMO_MODE = "true";
// withIdempotency builds its Postgres client eagerly; no request here sends an
// idempotency key, so the fake DSN is never actually contacted.
process.env.CORVIS_POSTGRES_DSN = "https://fake-postgres.test/sql";

const { GET: listGet, POST: assignPost } = await import("@/app/api/v1/company-sectors/route");
const { GET: sectorsGet } = await import("@/app/api/v1/sectors/route");
const { GET: summaryGet } = await import("@/app/api/v1/workspace-summary/route");

function headers(roles: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-corvis-demo-tenant": "tenant-sectors",
    "x-corvis-demo-workspace": "workspace-1",
    "x-corvis-demo-subject": `sectors-${roles}`,
    "x-corvis-demo-roles": roles,
  };
}
const get = (path: string, roles = "read_only") => new Request(`https://corvis.test${path}`, { headers: headers(roles) });
const post = (body: unknown, roles = "reviewer") => new Request("https://corvis.test/api/v1/company-sectors", { method: "POST", headers: headers(roles), body: JSON.stringify(body) });

type Company = { companyId: string; sectorCode: string | null; version: number };

test("GET /sectors serves the governed taxonomy", async () => {
  const response = await sectorsGet(get("/api/v1/sectors"));
  assert.equal(response.status, 200);
  const { data } = await response.json() as { data: { taxonomyVersion: string; sectors: Array<{ code: string }> } };
  assert.equal(data.taxonomyVersion, "corvis_sector_v1");
  assert.equal(data.sectors.length, 11);
});

test("reviewers classify a company; the sector breakdown follows; stale and invalid commands are refused", async () => {
  const listed = await (await listGet(get("/api/v1/company-sectors"))).json() as { data: Company[] };
  const sparrow = listed.data.find((row) => row.companyId === "company-project-sparrow")!;
  assert.deepEqual([sparrow.sectorCode, sparrow.version], [null, 0]);

  const summarySector = async () => {
    const body = await (await summaryGet(get("/api/v1/workspace-summary"))).json() as { data: { exposure: { total: number; bySector: Array<{ label: string; value: number }> } } };
    return body.data.exposure;
  };
  const before = await summarySector();
  assert.ok(!before.bySector.some((row) => row.label === "Consumer staples"));

  // A viewer cannot classify.
  assert.equal((await assignPost(post({ companyId: sparrow.companyId, sectorCode: "consumer_staples", expectedVersion: 0, reason: "x" }, "read_only"))).status, 403);
  // Ungoverned codes and missing reasons are 400s.
  assert.equal((await assignPost(post({ companyId: sparrow.companyId, sectorCode: "crypto", expectedVersion: 0, reason: "x" }))).status, 400);
  assert.equal((await assignPost(post({ companyId: sparrow.companyId, sectorCode: "consumer_staples", expectedVersion: 0, reason: " " }))).status, 400);

  const assigned = await assignPost(post({ companyId: sparrow.companyId, sectorCode: "consumer_staples", expectedVersion: 0, reason: "Primary business activity" }));
  assert.equal(assigned.status, 200);
  assert.deepEqual((await assigned.json() as { data: unknown }).data, { accepted: true, companyId: sparrow.companyId, sectorCode: "consumer_staples", newVersion: 1 });

  // Replaying the stale version is a conflict, not a silent overwrite.
  const stale = await assignPost(post({ companyId: sparrow.companyId, sectorCode: "energy", expectedVersion: 0, reason: "Primary business activity" }));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json() as { error: string }).error, "company_sector_version_conflict");
  // An unknown company answers like a conflict, never confirming other holdings.
  assert.equal((await assignPost(post({ companyId: "company-not-held", sectorCode: "energy", expectedVersion: 0, reason: "x" }))).status, 409);

  const after = await summarySector();
  const staples = after.bySector.find((row) => row.label === "Consumer staples");
  assert.equal(staples?.value, 1_046_000_000);
  assert.equal(Math.round(after.bySector.reduce((sum, row) => sum + row.value, 0)), Math.round(after.total));
});
