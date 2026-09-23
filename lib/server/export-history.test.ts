import assert from "node:assert/strict";
import test from "node:test";
import { AuthorizationError, type RequestIdentity } from "../../core/enterprise.ts";
import { listPhysicalExportStatuses } from "./export-history.ts";
import { getPhysicalExportStatus } from "./physical-exports.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";

const TENANT = "00000000-0000-4000-8000-000000000001";
const FUTURE = new Date(Date.now() + 24 * 3_600_000).toISOString();
const PAST = new Date(Date.now() - 3_600_000).toISOString();

function identity(overrides: Partial<RequestIdentity["entitlements"]> = {}): RequestIdentity {
  return {
    subject: "analyst@example.test",
    tenantId: TENANT,
    workspaceId: "00000000-0000-4000-8000-000000000002",
    roles: ["analyst"],
    entitlements: {
      workspaceIds: ["00000000-0000-4000-8000-000000000002"],
      fundIds: ["fund-a", "fund-b"],
      documentIds: ["doc-a"],
      sourceDocumentAccessAllowed: false,
      redistributionAllowed: true,
      ...overrides,
    },
    authMethod: "oidc",
    sessionId: "session-1",
  };
}

function job(id: string, overrides: PostgresRow = {}): PostgresRow {
  return {
    export_id: `00000000-0000-4000-8000-00000000010${id}`,
    format: "csv",
    state: "complete",
    manifest: {
      exportId: id, tenantId: TENANT, generatedAt: PAST, schemaVersion: "v1", taxonomyVersion: "v1",
      snapshotIds: [], format: "csv", rowCounts: { observations: 3, snapshots: 0 }, checksumSha256: "a".repeat(64),
      artifact: { fundIds: ["fund-a"], documentIds: ["doc-a"] },
    },
    checksum_sha256: "b".repeat(64),
    created_at: PAST,
    completed_at: PAST,
    expires_at: FUTURE,
    snapshot_ids: [],
    ...overrides,
  };
}

type Call = { kind: "query" | "execute"; sql: string; parameters: PostgresPrimitive[] };

function fakeStore(jobs: PostgresRow[], options: { snapshotCount?: (parameters: PostgresPrimitive[]) => number; failSnapshots?: boolean } = {}) {
  const calls: Call[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const store: PostgresSqlApi = {
    async query(sql, parameters = []) {
      calls.push({ kind: "query", sql, parameters });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        if (sql.includes("from corvis_serving.export_job")) {
          if (sql.includes("export_id=$2::uuid")) return jobs.filter((row) => row.export_id === parameters[1]);
          return jobs.slice(0, Number(parameters[2]));
        }
        if (sql.includes("from corvis_consolidated.fund_period_snapshot")) {
          if (options.failSnapshots) throw new Error("postgres_unavailable");
          return [{ snapshot_count: options.snapshotCount?.(parameters) ?? 0 }];
        }
        return [];
      } finally {
        inFlight -= 1;
      }
    },
    async execute(sql, parameters = []) { calls.push({ kind: "execute", sql, parameters }); },
    async health() { return true; },
  };
  return { store, calls, maxInFlight: () => maxInFlight };
}

test("export history is read-only: listing never issues download grants", async () => {
  const { store, calls } = fakeStore([job("1"), job("2", { state: "queued", completed_at: null, expires_at: null })]);
  const statuses = await listPhysicalExportStatuses(identity(), 20, store);

  assert.equal(statuses.length, 2);
  assert.equal(calls.filter((call) => call.kind === "execute").length, 0, "listing must not insert export_download_grant rows");
  assert.equal(calls.some((call) => call.sql.includes("export_download_grant")), false);
  assert.ok(statuses.every((status) => status.downloadUrl === undefined && status.downloadExpiresAt === undefined));
  assert.equal(statuses[0]!.downloadAvailable, true);
  assert.equal(statuses[1]!.downloadAvailable, false);
});

test("export history reports expired complete exports as not downloadable", async () => {
  const { store } = fakeStore([job("1", { expires_at: PAST })]);
  const [status] = await listPhysicalExportStatuses(identity(), 20, store);
  assert.equal(status!.state, "complete");
  assert.equal(status!.downloadAvailable, false);
});

test("export history is scoped to the caller's tenant and own requests and reads rows in one bounded query", async () => {
  const { store, calls } = fakeStore([job("1"), job("2")]);
  await listPhysicalExportStatuses(identity(), 500, store);
  const listQueries = calls.filter((call) => call.sql.includes("from corvis_serving.export_job"));
  assert.equal(listQueries.length, 1, "artifact-scoped rows must not be re-read one by one");
  assert.match(listQueries[0]!.sql, /where tenant_id=\$1 and requested_by=\$2/);
  assert.match(listQueries[0]!.sql, /order by created_at desc/);
  assert.deepEqual(listQueries[0]!.parameters, [TENANT, "analyst@example.test", 50]);

  const { store: lowStore, calls: lowCalls } = fakeStore([job("1")]);
  await listPhysicalExportStatuses(identity(), 0, lowStore);
  assert.equal(lowCalls[0]!.parameters[2], 1);
});

test("one export the caller can no longer access is omitted instead of failing the whole history", async () => {
  const revoked = job("2", { manifest: { ...(job("2").manifest as Record<string, unknown>), artifact: { fundIds: ["fund-z"], documentIds: ["doc-a"] } } });
  const { store } = fakeStore([job("1"), revoked, job("3")]);
  const statuses = await listPhysicalExportStatuses(identity(), 20, store);
  assert.deepEqual(statuses.map((status) => status.exportId), [job("1").export_id, job("3").export_id]);
});

test("snapshot-scoped exports are rechecked sequentially and revoked snapshots are omitted", async () => {
  const snapshotA = "00000000-0000-4000-8000-00000000a001";
  const snapshotB = "00000000-0000-4000-8000-00000000b001";
  const withoutArtifact = (id: string, snapshot: string) => {
    const manifest = { ...(job(id).manifest as Record<string, unknown>), snapshotIds: [snapshot] };
    delete (manifest as { artifact?: unknown }).artifact;
    return job(id, { manifest, snapshot_ids: [snapshot] });
  };
  const { store, maxInFlight } = fakeStore(
    [withoutArtifact("1", snapshotA), withoutArtifact("2", snapshotB), withoutArtifact("3", snapshotA)],
    { snapshotCount: (parameters) => (String(parameters[1]).includes(snapshotA) ? 1 : 0) },
  );
  const statuses = await listPhysicalExportStatuses(identity(), 20, store);
  assert.deepEqual(statuses.map((status) => status.exportId), [job("1").export_id, job("3").export_id]);
  assert.equal(maxInFlight(), 1, "per-export rights checks must not fan out concurrently");
});

test("infrastructure failures still fail the listing rather than silently hiding exports", async () => {
  const manifest = { ...(job("1").manifest as Record<string, unknown>), snapshotIds: ["00000000-0000-4000-8000-00000000a001"] };
  delete (manifest as { artifact?: unknown }).artifact;
  const { store } = fakeStore([job("1", { manifest, snapshot_ids: manifest.snapshotIds })], { failSnapshots: true });
  await assert.rejects(listPhysicalExportStatuses(identity(), 20, store), /postgres_unavailable/);
});

test("export history requires current redistribution rights before reading any export", async () => {
  const { store, calls } = fakeStore([job("1")]);
  await assert.rejects(listPhysicalExportStatuses(identity({ redistributionAllowed: false }), 20, store), AuthorizationError);
  assert.equal(calls.length, 0);
});

test("a download grant is issued only by the explicit single-export read", async () => {
  const { store, calls } = fakeStore([job("1")]);
  const status = await getPhysicalExportStatus(identity(), String(job("1").export_id), store);
  const grants = calls.filter((call) => call.kind === "execute");
  assert.equal(grants.length, 1);
  assert.match(grants[0]!.sql, /insert into corvis_serving\.export_download_grant/);
  assert.deepEqual(grants[0]!.parameters.slice(0, 3), [TENANT, job("1").export_id, "analyst@example.test"]);
  assert.equal(status?.downloadAvailable, true);
  assert.match(status?.downloadUrl ?? "", /^\/api\/v1\/exports\/[0-9a-f-]+\/download\?grant=/);
  assert.ok(Date.parse(status!.downloadExpiresAt!) <= Date.now() + 10 * 60_000);

  const { store: expiredStore, calls: expiredCalls } = fakeStore([job("1", { expires_at: PAST })]);
  const expired = await getPhysicalExportStatus(identity(), String(job("1").export_id), expiredStore);
  assert.equal(expired?.downloadUrl, undefined);
  assert.equal(expiredCalls.filter((call) => call.kind === "execute").length, 0);
});
