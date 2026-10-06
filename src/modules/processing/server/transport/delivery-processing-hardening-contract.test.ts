import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MIGRATION = "db/postgres/migrations/001_baseline.sql";

async function migration(): Promise<string> {
  return (await readFile(MIGRATION, "utf8")).toLowerCase();
}

function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`create function corvis_control.${name}(`);
  assert.ok(start >= 0, `${name} must be defined in the baseline`);
  const bodyStart = sql.indexOf("as $$", start);
  const bodyEnd = sql.indexOf("\n$$;", bodyStart);
  return sql.slice(start, bodyEnd);
}

test("webhook fan-out has its own completion column and index", async () => {
  const sql = await migration();
  assert.match(sql, /create table corvis_control\.outbox_event \([^;]*?\n    webhook_fanout_completed_at timestamp with time zone[^;]*?\n\);/);
  assert.match(sql, /create index outbox_webhook_fanout_pending_idx on corvis_control\.outbox_event [^;]*?where \(webhook_fanout_completed_at is null\);/);
  assert.match(sql, /create table corvis_serving\.export_job \([^;]*?\n    delivery_started_at timestamp with time zone[^;]*?\n\);/);
});

test("claim does not raise on exhausted attempts; it dead-letters and fails the inbox event", async () => {
  const claim = functionBody(await migration(), "claim_processing_stage_delivery");
  assert.doesNotMatch(claim, /raise exception 'processing job attempts exhausted'/);
  assert.match(claim, /current_job\.attempt >= current_job\.max_attempts[\s\S]*dead_letter_exhausted_processing_job/);
  assert.match(claim, /update corvis_control\.event_inbox\s+set state='failed'/);
  // A job whose inbox lease is still live on another delivery is transient and must roll back.
  assert.match(
    claim,
    /current_job\.state='running' then[\s\S]*?i\.state='processing'\s+and i\.lease_expires_at > now\(\)\s*\) then\s*raise exception 'processing job is not claimable'/
  );
  assert.match(claim, /set search_path to 'pg_catalog', 'corvis_control'/);
});

test("failure dead-letters once the job's own attempt budget is spent, preserving the retry payload", async () => {
  const fail = functionBody(await migration(), "fail_processing_stage_delivery");
  assert.match(fail, /when computed_inbox_state='retryable' and current_job\.attempt < current_job\.max_attempts then 'retryable'/);
  assert.match(fail, /signal_payload := \(inbox_row\.payload - 'nextattemptat'\)/);
  assert.match(fail, /'processingstagedeadlettered'/);
});

test("apply_identity_lifecycle pins search_path to reach pgcrypto in the extensions schema", async () => {
  const lifecycle = functionBody(await migration(), "apply_identity_lifecycle");
  assert.match(lifecycle, /set search_path to 'pg_catalog', 'corvis_control', 'extensions', 'public'/);
});
