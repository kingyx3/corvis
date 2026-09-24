import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("claim_event_delivery and claim_processing_stage_delivery both require a matching outbox_event row", async () => {
  const sql = (await readFile("db/postgres/migrations/049_outbox_event_authenticity_guard.sql", "utf8")).toLowerCase();

  // The guard appears twice: once in claim_event_delivery, once in
  // claim_processing_stage_delivery (defense in depth for the stage-specific
  // entry point even though it also delegates to claim_event_delivery).
  const guardOccurrences = sql.match(/raise exception 'event id has no matching outbox record'/g) ?? [];
  assert.equal(guardOccurrences.length, 2);

  assert.match(sql, /not exists \(\s*select 1\s*from corvis_control\.outbox_event o\s*where o\.tenant_id=p_tenant_id\s*and o\.event_id=p_event_id\s*and o\.event_type=p_event_type\s*and o\.payload=p_payload\s*\)/);

  // Both functions are redefined with their prior body otherwise intact:
  // the pre-existing mismatch/lease/backoff checks from 013 and 046 remain.
  assert.match(sql, /current_row\.payload_sha256 <> p_payload_sha256/);
  assert.match(sql, /event id payload mismatch/);
  assert.match(sql, /raise exception 'processing job is not claimable'/);
  assert.match(sql, /raise exception 'processing job not found for claimed event'/);
});
