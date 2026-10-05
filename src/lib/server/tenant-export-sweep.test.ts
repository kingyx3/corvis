import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import {
  TENANT_EXPORT_ARTIFACT_SWEEP_LIMIT,
  TENANT_EXPORT_GRANT_RETENTION_HOURS,
  TENANT_EXPORT_GRANT_SWEEP_LIMIT,
  sweepTenantExports,
} from "./tenant-export-sweep.ts";

const TENANT = "11111111-aaaa-4aaa-8aaa-111111111111";
const FIRST = "8f3d2c1e-5b6a-4c7d-9e8f-0a1b2c3d4e5f";
const SECOND = "9f3d2c1e-5b6a-4c7d-9e8f-0a1b2c3d4e5f";
const uri = (request: string) => `gs://corvis-bucket/exports/${TENANT}/tenant-export-${request}/attempt-1/corvis-tenant-export.zip`;

process.env.CORVIS_OBJECT_STORE_BUCKET = "corvis-bucket";
console.error = console.info = () => undefined;

type Call = { sql: string; parameters: PostgresPrimitive[] };
class FakeDb implements PostgresSqlApi {
  readonly calls: Call[] = [];
  expired: PostgresRow[] = [];
  marked: (requestId: string) => PostgresRow | undefined = () => ({ marked: true });
  grants: PostgresRow | undefined = { deleted: 0 };
  async query(sql: string, parameters: PostgresPrimitive[] = []) {
    this.calls.push({ sql, parameters });
    if (/expired_tenant_export_artifacts/.test(sql)) return this.expired;
    if (/mark_tenant_export_artifact_deleted/.test(sql)) return [this.marked(String(parameters[1]))].filter((row): row is PostgresRow => row !== undefined);
    if (/sweep_tenant_export_grants/.test(sql)) return this.grants ? [this.grants] : [];
    return [];
  }
  async execute() {}
  async health() { return true; }
}

class FakeObjects {
  readonly deleted: string[] = [];
  failFor?: string;
  async deleteObject(key: string) {
    this.deleted.push(key);
    if (this.failFor && key.includes(this.failFor)) throw new Error("object store down");
  }
}

test("an expired artifact is deleted from the object store, then recorded; the grant sweep runs with its retention", async () => {
  const db = new FakeDb();
  db.expired = [{ tenant_id: TENANT, request_id: FIRST, object_uri: uri(FIRST) }, { tenant_id: TENANT, request_id: SECOND, object_uri: uri(SECOND) }];
  db.grants = { deleted: "3" };
  const objects = new FakeObjects();
  const result = await sweepTenantExports({ store: db, objectStore: objects });
  assert.deepEqual(result, { artifactsDeleted: 2, grantsDeleted: 3, errors: 0 });
  assert.deepEqual(objects.deleted, [`exports/${TENANT}/tenant-export-${FIRST}/attempt-1/corvis-tenant-export.zip`, `exports/${TENANT}/tenant-export-${SECOND}/attempt-1/corvis-tenant-export.zip`]);
  assert.deepEqual(db.calls[0]!.parameters, [TENANT_EXPORT_ARTIFACT_SWEEP_LIMIT]);
  // The record is written only after the object store confirmed the deletion, per request, for that request's tenant.
  const marks = db.calls.filter((call) => /mark_tenant_export_artifact_deleted/.test(call.sql));
  assert.deepEqual(marks.map((call) => call.parameters), [[TENANT, FIRST], [TENANT, SECOND]]);
  assert.deepEqual(db.calls.at(-1)!.parameters, [TENANT_EXPORT_GRANT_RETENTION_HOURS, TENANT_EXPORT_GRANT_SWEEP_LIMIT]);
});

test("a failed deletion is not recorded, is counted so the tick reports it, and does not stop the others or the grant sweep", async () => {
  const db = new FakeDb();
  db.expired = [{ tenant_id: TENANT, request_id: FIRST, object_uri: uri(FIRST) }, { tenant_id: TENANT, request_id: SECOND, object_uri: uri(SECOND) }];
  const objects = new FakeObjects();
  objects.failFor = FIRST;
  const result = await sweepTenantExports({ store: db, objectStore: objects, artifactLimit: 5, grantLimit: 7 });
  assert.deepEqual(result, { artifactsDeleted: 1, grantsDeleted: 0, errors: 1 });
  assert.deepEqual(db.calls.filter((call) => /mark_tenant_export_artifact_deleted/.test(call.sql)).map((call) => call.parameters[1]), [SECOND], "the failed one stays on record for the next tick");
  assert.deepEqual(db.calls[0]!.parameters, [5]);
  assert.deepEqual(db.calls.at(-1)!.parameters, [TENANT_EXPORT_GRANT_RETENTION_HOURS, 7]);
});

test("an object outside the exports prefix is never deleted, and a request already recorded by another worker is not counted twice", async () => {
  const db = new FakeDb();
  db.expired = [
    { tenant_id: TENANT, request_id: FIRST, object_uri: "gs://corvis-bucket/uploads/secret.pdf" },
    { tenant_id: TENANT, request_id: SECOND, object_uri: uri(SECOND) },
  ];
  db.marked = () => ({ marked: false });
  const objects = new FakeObjects();
  const result = await sweepTenantExports({ store: db, objectStore: objects });
  assert.deepEqual(objects.deleted, [`exports/${TENANT}/tenant-export-${SECOND}/attempt-1/corvis-tenant-export.zip`]);
  assert.deepEqual(result, { artifactsDeleted: 0, grantsDeleted: 0, errors: 1 });
  db.marked = () => undefined;
  assert.equal((await sweepTenantExports({ store: db, objectStore: new FakeObjects() })).artifactsDeleted, 0, "no row back means nothing was recorded");
});

test("with nothing expired no object store is needed, and a missing grant count reads as zero", async () => {
  const db = new FakeDb();
  db.grants = undefined;
  const result = await sweepTenantExports({ store: db });
  assert.deepEqual(result, { artifactsDeleted: 0, grantsDeleted: 0, errors: 0 });
  assert.equal(db.calls.length, 2);
});

test("a non-Error failure is still counted without leaking anything", async () => {
  const db = new FakeDb();
  db.expired = [{ tenant_id: TENANT, request_id: FIRST, object_uri: uri(FIRST) }];
  const result = await sweepTenantExports({ store: db, objectStore: { async deleteObject() { throw "plain string"; } } });
  assert.equal(result.errors, 1);
});

test("the scheduled delivery tick runs the sweep as its own settled task and reports undeleted artifacts as a failure", async () => {
  const route = (await readFile("src/app/api/internal/delivery/route.ts", "utf8")).replace(/\s+/g, " ");
  assert.match(route, /import \{ sweepTenantExports \} from "@\/lib\/server\/tenant-export-sweep";/);
  assert.match(route, /tenantExportSweep:\(\)=>sweepTenantExports\(\)/);
  assert.match(route, /results\.tenantExportSweep/);
  assert.match(route, /failed\.push\("tenantExportSweep"\)/);
});

test("the sweep's SQL only ever selects expired artifacts and deletes expired grants, with the audit written by the functions", async () => {
  const db = new FakeDb();
  db.expired = [{ tenant_id: TENANT, request_id: FIRST, object_uri: uri(FIRST) }];
  await sweepTenantExports({ store: db, objectStore: new FakeObjects() });
  assert.match(db.calls[0]!.sql, /corvis_control\.expired_tenant_export_artifacts\(\$1\)/);
  assert.match(db.calls[1]!.sql, /corvis_control\.mark_tenant_export_artifact_deleted\(\$1::uuid,\$2::uuid\)/);
  assert.match(db.calls[2]!.sql, /corvis_control\.sweep_tenant_export_grants\(\$1, \$2\)/);
});
