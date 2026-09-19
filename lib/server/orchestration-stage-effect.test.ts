import assert from "node:assert/strict";
import test from "node:test";
import { PostgresProcessingStageEffectRepository } from "./orchestration-stage-effect.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";

type Call = { sql: string; parameters: PostgresPrimitive[] };

class FakeDb implements PostgresSqlApi {
  calls: Call[] = [];
  rows: PostgresRow[][] = [];
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.calls.push({ sql, parameters });
    return this.rows.shift() ?? [];
  }
  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> { this.calls.push({ sql, parameters }); }
  async health(): Promise<boolean> { return true; }
}

test("stage effect repository binds tenant job document stage and key", async () => {
  const db = new FakeDb();
  db.rows.push([{ should_execute: true, already_complete: false, effect_attempt: 2 }]);
  const repo = new PostgresProcessingStageEffectRepository(db);
  const result = await repo.begin({
    tenantId: "00000000-0000-0000-0000-000000000010",
    jobId: "registered:doc",
    effectKey: "effect-key",
    documentId: "00000000-0000-0000-0000-000000000101",
    stage: "registered",
  });
  assert.deepEqual(result, { shouldExecute: true, alreadyComplete: false, attempt: 2 });
  assert.match(db.calls[0]?.sql ?? "", /begin_processing_stage_effect/);
  assert.deepEqual(db.calls[0]?.parameters, [
    "00000000-0000-0000-0000-000000000010",
    "registered:doc",
    "effect-key",
    "00000000-0000-0000-0000-000000000101",
    "registered",
  ]);
});

test("stage effect completion persists handler result in one database call", async () => {
  const db = new FakeDb();
  db.rows.push([{ completed: true }]);
  const repo = new PostgresProcessingStageEffectRepository(db);
  const completed = await repo.complete({
    tenantId: "00000000-0000-0000-0000-000000000010",
    jobId: "registered:doc",
    effectKey: "effect-key",
    result: { objectGeneration: "42" },
  });
  assert.equal(completed, true);
  assert.match(db.calls[0]?.sql ?? "", /complete_processing_stage_effect/);
  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0]?.parameters[3], JSON.stringify({ objectGeneration: "42" }));
});
