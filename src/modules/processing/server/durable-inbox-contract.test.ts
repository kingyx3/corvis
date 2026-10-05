import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("durable inbox enforces per-consumer event dedupe and payload identity", async () => {
  const sql = (await readFile("db/postgres/migrations/013_durable_event_inbox.sql", "utf8")).toLowerCase();
  assert.match(sql, /primary key \(tenant_id, consumer_name, event_id\)/);
  assert.match(sql, /payload_sha256 text not null/);
  assert.match(sql, /current_row\.payload_sha256 <> p_payload_sha256/);
  assert.match(sql, /event id payload mismatch/);
  assert.match(sql, /current_row\.event_type <> p_event_type/);
  assert.match(sql, /delivery_count=delivery_count\+1/);
  assert.match(sql, /current_row\.state='complete'[\s\S]*select false,true/);
});

test("durable inbox uses bounded leases and lease-token ownership for side-effect completion", async () => {
  const sql = (await readFile("db/postgres/migrations/013_durable_event_inbox.sql", "utf8")).toLowerCase();
  assert.match(sql, /p_lease_seconds < 1 or p_lease_seconds > 3600/);
  assert.match(sql, /lease_expires_at=now\(\)\+make_interval\(secs => p_lease_seconds\)/);
  assert.match(sql, /state='processing' and lease_token=p_lease_token/);
  assert.match(sql, /create or replace function corvis_control\.complete_event_delivery/);
  assert.match(sql, /create or replace function corvis_control\.fail_event_delivery/);
});

test("durable inbox retries with bounded backoff and persists terminal exhaustion", async () => {
  const sql = (await readFile("db/postgres/migrations/013_durable_event_inbox.sql", "utf8")).toLowerCase();
  assert.match(sql, /current_row\.attempt >= current_row\.max_attempts[\s\S]*set state='failed'/);
  assert.match(sql, /next_state := case when current_row\.attempt >= current_row\.max_attempts then 'failed' else 'retryable' end/);
  assert.match(sql, /delay_seconds := least\(900, power\(2, greatest\(0, current_row\.attempt-1\)\)::integer\)/);
  assert.match(sql, /next_attempt_at=case when next_state='retryable'/);
  assert.match(sql, /left\(coalesce\(p_error,'unknown error'\),2000\)/);
});

test("durable inbox is server-managed with RLS and no client mutation policy", async () => {
  const sql = (await readFile("db/postgres/migrations/013_durable_event_inbox.sql", "utf8")).toLowerCase();
  assert.match(sql, /alter table corvis_control\.event_inbox enable row level security/);
  assert.match(sql, /alter table corvis_control\.event_inbox force row level security/);
  assert.equal(/create policy[^;]+event_inbox/.test(sql), false);
});
