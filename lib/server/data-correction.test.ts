import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { PostgresDataCorrectionRepository } from "./data-correction.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";

const identity: RequestIdentity = {
  subject: "ops|reviewer", tenantId: "00000000-0000-4000-8000-000000000001", workspaceId: "00000000-0000-4000-8000-000000000002",
  roles: ["admin"], entitlements: { workspaceIds: ["00000000-0000-4000-8000-000000000002"], sourceDocumentAccessAllowed: true }, authMethod: "oidc", sessionId: "session-1",
};
class FakeDb implements PostgresSqlApi {
  calls: Array<{ sql: string; parameters: PostgresPrimitive[] }> = [];
  constructor(private readonly results: PostgresRow[][]) {}
  async query(sql: string, parameters: PostgresPrimitive[] = []) { this.calls.push({ sql, parameters }); return this.results.shift() ?? []; }
  async execute() {}
  async health() { return true; }
}

test("opening a correction binds tenant, actor, idempotency and an immutable request hash", async () => {
  const db = new FakeDb([[{ incident_id: "00000000-0000-4000-8000-000000000099", state: "open" }]]);
  const result = await new PostgresDataCorrectionRepository(db).open(identity, {
    idempotencyKey: "dq-2026-q3-1", fundId: "fund-1", reportPeriod: "2026-Q3",
    documentId: "00000000-0000-4000-8000-000000000101", rootCause: "source mapping defect", correctionIntent: "replay retained source with corrected mapping",
  });
  assert.equal(result.state, "open");
  assert.match(db.calls[0]?.sql ?? "", /open_data_correction_incident/);
  assert.equal(db.calls[0]?.parameters[0], identity.tenantId);
  assert.equal(db.calls[0]?.parameters[3]?.toString().length, 64);
  assert.equal(db.calls[0]?.parameters.at(-1), identity.subject);
});

test("correction commands reject empty root cause rather than creating an unowned replay", async () => {
  const db = new FakeDb([]);
  await assert.rejects(() => new PostgresDataCorrectionRepository(db).open(identity, {
    idempotencyKey: "x", fundId: "fund-1", reportPeriod: "2026-Q3", rootCause: " ", correctionIntent: "replay",
  }), /rootCause/);
  assert.equal(db.calls.length, 0);
});

test("migration preserves immutable history, deterministic replay and persistence-level publication containment", async () => {
  const sql = (await readFile("db/postgres/migrations/022_data_correction_incidents.sql", "utf8")).toLowerCase();
  assert.match(sql, /create table if not exists corvis_control\.data_correction_incident/);
  assert.match(sql, /unique \(tenant_id, idempotency_key\)/);
  assert.match(sql, /'processingstageready'/);
  assert.match(sql, /on conflict \(tenant_id,event_id\) do nothing/);
  assert.match(sql, /active data correction incident blocks publication/);
  assert.match(sql, /'correctionreplacementdeliveryrequested'/);
  assert.equal(/update corvis_facts\.observation/.test(sql), false);
});
