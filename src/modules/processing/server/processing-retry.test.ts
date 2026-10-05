import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../../shared/domain/enterprise.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "../../../platform/database/postgres.ts";
import { retryProcessingJobCommand } from "./processing-retry.ts";

const identity: RequestIdentity = {
  subject: "operator@example.test",
  tenantId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  roles: ["admin"],
  entitlements: { workspaceIds: ["22222222-2222-4222-8222-222222222222"], sourceDocumentAccessAllowed: false },
  authMethod: "oidc",
  sessionId: "session-1",
};

const JOB_ID = "33333333-3333-4333-8333-333333333333";

class FakePostgres implements PostgresSqlApi {
  readonly queries: Array<{ sql: string; parameters: PostgresPrimitive[] }> = [];
  queue: PostgresRow[][] = [];

  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.queries.push({ sql, parameters });
    return this.queue.shift() ?? [];
  }
  async execute(): Promise<void> {}
  async health(): Promise<boolean> { return true; }
}

test("a malformed jobId is a normal not-found result, not a database uuid cast failure", async () => {
  for (const jobId of ["not-a-uuid", "", "33333333-3333-4333-8333-333333333333; drop table x"]) {
    const db = new FakePostgres();
    const result = await retryProcessingJobCommand(identity, jobId, db);
    assert.deepEqual(result, { ok:false, reason:"not_found" });
    assert.equal(db.queries.length, 0, `${JSON.stringify(jobId)}: a malformed id must never reach Postgres`);
  }
});

test("a missing job is not found", async () => {
  const db = new FakePostgres();
  const result = await retryProcessingJobCommand(identity, JOB_ID, db);
  assert.deepEqual(result, { ok:false, reason:"not_found" });
  assert.equal(db.queries.length, 1);
});

test("a job outside a retryable state is refused", async () => {
  const db = new FakePostgres();
  db.queue.push([{ state: "succeeded", attempt: 0, max_attempts: 3, version: 1 }]);
  const result = await retryProcessingJobCommand(identity, JOB_ID, db);
  assert.deepEqual(result, { ok:false, reason:"not_retryable" });
});

test("a row with missing fields defaults rather than crashing, and still refuses a non-retryable state", async () => {
  const db = new FakePostgres();
  db.queue.push([{}]);
  const result = await retryProcessingJobCommand(identity, JOB_ID, db);
  assert.deepEqual(result, { ok:false, reason:"not_retryable" });
  assert.equal(db.queries.length, 1, "a defaulted, non-retryable state never issues the retry command");
});

test("a lost compare-and-set race where the database reports no rows at all is a version conflict", async () => {
  const db = new FakePostgres();
  db.queue.push([{ state: "retryable", attempt: 1, max_attempts: 3, version: 1 }]);
  db.queue.push([]);
  const result = await retryProcessingJobCommand(identity, JOB_ID, db);
  assert.deepEqual(result, { ok:false, reason:"version_conflict" });
});

test("a job with no attempts left is refused before retrying", async () => {
  const db = new FakePostgres();
  db.queue.push([{ state: "failed", attempt: 3, max_attempts: 3, version: 1 }]);
  const result = await retryProcessingJobCommand(identity, JOB_ID, db);
  assert.deepEqual(result, { ok:false, reason:"attempts_exhausted" });
  assert.equal(db.queries.length, 1, "no retry command is issued once attempts are exhausted");
});

test("a lost compare-and-set race on the version is a version conflict, not a false success", async () => {
  const db = new FakePostgres();
  db.queue.push([{ state: "retryable", attempt: 1, max_attempts: 3, version: 1 }]);
  db.queue.push([{ new_version: 1 }]);
  const result = await retryProcessingJobCommand(identity, JOB_ID, db);
  assert.deepEqual(result, { ok:false, reason:"version_conflict" });
});

test("a successful retry reports the new version and is tenant-scoped", async () => {
  const db = new FakePostgres();
  db.queue.push([{ state: "dead_letter", attempt: 1, max_attempts: 3, version: 1 }]);
  db.queue.push([{ new_version: 2 }]);
  const result = await retryProcessingJobCommand(identity, JOB_ID, db);
  assert.deepEqual(result, { ok:true, version:2 });
  assert.deepEqual(db.queries[0]?.parameters, [identity.tenantId, JOB_ID]);
  assert.match(db.queries[0]?.sql ?? "", /tenant_id=\$1 and job_id=\$2/);
});
