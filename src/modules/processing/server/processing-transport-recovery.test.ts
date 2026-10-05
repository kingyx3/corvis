import assert from "node:assert/strict";
import test from "node:test";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "../../../platform/database/postgres.ts";
import { listTransportDeadLetters, requeueTransportDeadLetter } from "./processing-transport-recovery.ts";

const tenant = { tenantId: "11111111-1111-4111-8111-111111111111" };
const EVENT = "22222222-2222-4222-8222-222222222222";

function db(rows: PostgresRow[]): PostgresSqlApi & { calls: Array<{ sql: string; parameters: PostgresPrimitive[] }> } {
  const calls: Array<{ sql: string; parameters: PostgresPrimitive[] }> = [];
  return {
    calls,
    async query(sql: string, parameters: PostgresPrimitive[] = []) { calls.push({ sql, parameters }); return rows; },
    async execute() {},
    async health() { return true; },
  };
}

const row = { event_id: EVENT, event_type: "DocumentRegistered", aggregate_type: "document", aggregate_id: "d1", attempt_count: 8, last_error: "boom", created_at: "2026-09-29 10:00:00+00", transport_dead_lettered_at: "2026-09-29 11:00:00+00" };

test("dead letters are listed per tenant, unpublished only, with a bounded limit", async () => {
  const store = db([row]);
  const listed = await listTransportDeadLetters(tenant, store, 10_000);
  assert.deepEqual(listed, [{ eventId: EVENT, eventType: "DocumentRegistered", aggregateType: "document", aggregateId: "d1", attempts: 8, lastError: "boom", createdAt: row.created_at, deadLetteredAt: row.transport_dead_lettered_at }]);
  assert.match(store.calls[0]!.sql, /where tenant_id=\$1::uuid and published_at is null and transport_dead_lettered_at is not null/);
  assert.deepEqual(store.calls[0]!.parameters, [tenant.tenantId, 500]);
});

test("a requeue clears the dead-letter mark and attempt budget of that tenant's unpublished event only", async () => {
  const store = db([row]);
  const result = await requeueTransportDeadLetter(tenant, EVENT, store);
  assert.equal(result.ok, true);
  const { sql, parameters } = store.calls[0]!;
  assert.match(sql, /set transport_dead_lettered_at=null,attempt_count=0,next_attempt_at=now\(\)/);
  assert.match(sql, /tenant_id=\$1::uuid and event_id=\$2::uuid and published_at is null and transport_dead_lettered_at is not null/);
  assert.deepEqual(parameters, [tenant.tenantId, EVENT]);
});

test("an event that is not dead-lettered (or was already requeued) is a no-op; a malformed id never reaches the database", async () => {
  assert.deepEqual(await requeueTransportDeadLetter(tenant, EVENT, db([])), { ok: false, reason: "not_dead_lettered" });
  const store = db([row]);
  assert.deepEqual(await requeueTransportDeadLetter(tenant, "x' or 1=1", store), { ok: false, reason: "invalid_event_id" });
  assert.equal(store.calls.length, 0);
});
