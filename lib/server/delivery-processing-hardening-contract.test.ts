import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MIGRATION = "db/postgres/migrations/043_delivery_processing_hardening.sql";

async function migration(): Promise<string> {
  return (await readFile(MIGRATION, "utf8")).toLowerCase();
}

function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function corvis_control.${name}(`);
  assert.ok(start >= 0, `${name} must be (re)defined in 043`);
  const bodyStart = sql.indexOf("as $$", start);
  const bodyEnd = sql.indexOf("\n$$;", bodyStart);
  return sql.slice(start, bodyEnd);
}

test("043 gives webhook fan-out its own completion column and index", async () => {
  const sql = await migration();
  assert.match(sql, /alter table corvis_control\.outbox_event\s+add column if not exists webhook_fanout_completed_at timestamptz/);
  assert.match(sql, /create index if not exists outbox_webhook_fanout_pending_idx[\s\S]*?where webhook_fanout_completed_at is null/);
  assert.match(sql, /alter table corvis_serving\.export_job\s+add column if not exists delivery_started_at timestamptz/);
});

test("claim no longer raises on exhausted attempts; it dead-letters and fails the inbox event", async () => {
  const claim = functionBody(await migration(), "claim_processing_stage_delivery");
  assert.doesNotMatch(claim, /raise exception 'processing job attempts exhausted'/);
  assert.match(claim, /current_job\.attempt >= current_job\.max_attempts[\s\S]*dead_letter_exhausted_processing_job/);
  assert.match(claim, /update corvis_control\.event_inbox\s+set state='failed'/);
  // A job leased by another delivery is still transient and must roll back.
  assert.match(claim, /current_job\.state='running' then raise exception/);
  assert.match(claim, /set search_path = pg_catalog, corvis_control/);
});

test("failure dead-letters once the job's own attempt budget is spent, preserving the 027 retry payload", async () => {
  const fail = functionBody(await migration(), "fail_processing_stage_delivery");
  assert.match(fail, /when computed_inbox_state='retryable' and current_job\.attempt < current_job\.max_attempts then 'retryable'/);
  assert.match(fail, /signal_payload := \(inbox_row\.payload - 'nextattemptat'\)/);
  assert.match(fail, /'processingstagedeadlettered'/);
});

test("stranded retryable-but-exhausted jobs are repaired into recoverable dead letters", async () => {
  const sql = await migration();
  assert.match(sql, /where state='retryable' and attempt >= max_attempts[\s\S]*dead_letter_exhausted_processing_job/);
});

test("apply_identity_lifecycle pins search_path to reach pgcrypto in the extensions schema, body otherwise unchanged", async () => {
  const redefined = functionBody(await migration(), "apply_identity_lifecycle");
  assert.match(redefined, /set search_path = pg_catalog, corvis_control, extensions, public/);
  const original = functionBody((await readFile("db/postgres/migrations/011_identity_lifecycle_sync.sql", "utf8")).toLowerCase(), "apply_identity_lifecycle");
  assert.equal(redefined.replace("set search_path = pg_catalog, corvis_control, extensions, public\n", ""), original);
});
