import assert from "node:assert/strict";
import test from "node:test";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import { PostgresEventInboxRepository } from "./orchestration-inbox.ts";

type Call = { sql: string; parameters: PostgresPrimitive[] };

class FakeDb implements PostgresSqlApi {
  calls: Call[] = [];
  rows: PostgresRow[] = [];

  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.calls.push({ sql, parameters });
    return this.rows;
  }
  async execute(): Promise<void> {}
  async health(): Promise<boolean> { return true; }
}

const envelope = {
  tenantId: "00000000-0000-0000-0000-000000000010",
  consumerName: "representation-worker",
  eventId: "00000000-0000-0000-0000-000000000020",
  eventType: "DocumentRegistered",
  aggregateType: "document",
  aggregateId: "00000000-0000-0000-0000-000000000030",
  payload: { documentId: "00000000-0000-0000-0000-000000000030" },
  payloadSha256: "sha256:abc",
};

test("inbox claims bind tenant, consumer, event identity, payload hash and bounded retry controls", async () => {
  const db = new FakeDb();
  db.rows = [{ claimed: true, duplicate_complete: false, claim_lease_token: "00000000-0000-0000-0000-000000000040", claim_attempt: 1, claim_state: "processing" }];
  const claim = await new PostgresEventInboxRepository(db).claim(envelope);

  assert.equal(claim.claimed, true);
  assert.equal(claim.duplicateComplete, false);
  assert.equal(claim.attempt, 1);
  assert.equal(claim.state, "processing");
  assert.equal(claim.leaseToken, "00000000-0000-0000-0000-000000000040");
  assert.match(db.calls[0]?.sql ?? "", /corvis_control\.claim_event_delivery/);
  assert.deepEqual(db.calls[0]?.parameters.slice(0, 8), [
    envelope.tenantId,
    envelope.consumerName,
    envelope.eventId,
    envelope.eventType,
    envelope.aggregateType,
    envelope.aggregateId,
    JSON.stringify(envelope.payload),
    envelope.payloadSha256,
  ]);
  assert.equal(db.calls[0]?.parameters[8], 5);
  assert.equal(db.calls[0]?.parameters[9], 300);
});

test("completed duplicate delivery returns an idempotent no-work claim", async () => {
  const db = new FakeDb();
  db.rows = [{ claimed: false, duplicate_complete: true, claim_attempt: 1, claim_state: "complete" }];
  const claim = await new PostgresEventInboxRepository(db).claim(envelope);
  assert.equal(claim.claimed, false);
  assert.equal(claim.duplicateComplete, true);
  assert.equal(claim.leaseToken, undefined);
  assert.equal(claim.state, "complete");
});

test("a claim for an event with no matching outbox record propagates the authenticity exception", async () => {
  const db = new FakeDb();
  db.query = async () => { throw new Error("event id has no matching outbox record"); };
  await assert.rejects(
    () => new PostgresEventInboxRepository(db).claim(envelope),
    /event id has no matching outbox record/,
  );
});

test("completion and failure require the exact tenant consumer event and lease token", async () => {
  const db = new FakeDb();
  const repository = new PostgresEventInboxRepository(db);
  db.rows = [{ completed: true }];
  assert.equal(await repository.complete(envelope.tenantId, envelope.consumerName, envelope.eventId, "00000000-0000-0000-0000-000000000040"), true);
  assert.match(db.calls[0]?.sql ?? "", /complete_event_delivery/);
  assert.deepEqual(db.calls[0]?.parameters, [envelope.tenantId, envelope.consumerName, envelope.eventId, "00000000-0000-0000-0000-000000000040"]);

  db.rows = [{ next_state: "retryable" }];
  assert.equal(await repository.fail(envelope.tenantId, envelope.consumerName, envelope.eventId, "00000000-0000-0000-0000-000000000040", "temporary provider failure"), "retryable");
  assert.match(db.calls[1]?.sql ?? "", /fail_event_delivery/);
  assert.equal(db.calls[1]?.parameters[0], envelope.tenantId);
  assert.equal(db.calls[1]?.parameters[1], envelope.consumerName);
  assert.equal(db.calls[1]?.parameters[2], envelope.eventId);
});
