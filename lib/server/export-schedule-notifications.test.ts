import assert from "node:assert/strict";
import test from "node:test";
import { notifyScheduledExportOutcome, notifyScheduledRunFailed } from "./export-schedule-notifications.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";

const TENANT = "11111111-aaaa-4aaa-8aaa-111111111111";
const RUN = "7f3d2c1e-5b6a-4c7d-9e8f-0a1b2c3d4e5f";
const EXPORT = "55555555-5555-4555-8555-555555555555";

type Statement = { sql: string; parameters: PostgresPrimitive[] };

class Store implements PostgresSqlApi {
  readonly queries: Statement[] = [];
  readonly executed: Statement[] = [];
  run: PostgresRow[] = [{ run_id: RUN }];
  failOn: string | undefined;
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.queries.push({ sql, parameters });
    if (this.failOn && sql.includes(this.failOn)) throw new Error("postgres_unavailable");
    return sql.includes("export_schedule_run where") ? this.run : [];
  }
  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> {
    this.executed.push({ sql, parameters });
    if (this.failOn && sql.includes(this.failOn)) throw new Error("postgres_unavailable");
  }
  async health(): Promise<boolean> { return true; }
}

function muteErrors(t: test.TestContext): string[] {
  const lines: string[] = [];
  t.mock.method(console, "error", (line: unknown) => { lines.push(String(line)); });
  return lines;
}

test("a failed run emits its webhook event and queues the owner's email, both carrying only ids and the reason code", async () => {
  const store = new Store();
  await notifyScheduledRunFailed(store, { tenantId: TENANT, runId: RUN, reason: "redistribution_not_permitted" });
  assert.equal(store.queries.length, 1);
  assert.deepEqual(store.queries[0]!.parameters, [TENANT, RUN, "redistribution_not_permitted"]);
  assert.match(store.queries[0]!.sql, /emit_export_schedule_run_event\(\$1::uuid,\$2::uuid,'failed',\$3\)/);

  assert.equal(store.executed.length, 1);
  const email = store.executed[0]!;
  assert.deepEqual(email.parameters, [TENANT, RUN, "redistribution_not_permitted"]);
  assert.match(email.sql, /'export_schedule_failed'/);
  assert.match(email.sql, /jsonb_build_object\('reason',\$3::text\)/, "the template parameters are the reason code and nothing else");
  assert.match(email.sql, /'export_schedule_failed:' \|\| r\.run_id::text[\s\S]*on conflict \(tenant_id,dedupe_key\) do nothing/, "one email per run, however often it is announced");
  assert.match(email.sql, /s\.notify_on_completion/, "a schedule whose owner switched emails off sends none");
  assert.match(email.sql, /i\.auth_method in \('oidc','saml'\)/, "a service identity has no verified address");
  assert.match(email.sql, /where r\.tenant_id=\$1::uuid and r\.run_id=\$2::uuid/, "scoped to the tenant that owns the run");
  assert.doesNotMatch(email.sql, /s\.label|scope_label|\bscope\b/, "the email row is built without the schedule's name or scope");
});

test("a notification fault is logged and never thrown into the run or the export worker", async (t) => {
  const lines = muteErrors(t);
  for (const failOn of ["emit_export_schedule_run_event", "'export_schedule_failed'"]) {
    const store = new Store();
    store.failOn = failOn;
    await notifyScheduledRunFailed(store, { tenantId: TENANT, runId: RUN, reason: "export_failed" });
  }
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.match(line, /"event":"notifications\.enqueue_failed"/);
    assert.match(line, new RegExp(`export_schedule_run:${RUN}:failed`));
    assert.doesNotMatch(line, /postgres_unavailable/, "the error text is not logged, only its class");
  }
});

test("inside the run's transaction a notification fault is isolated by a savepoint so the run still commits", async () => {
  const store = new Store();
  await notifyScheduledRunFailed(store, { tenantId: TENANT, runId: RUN, reason: "owner_inactive" }, { inTransaction: true });
  assert.deepEqual(store.executed.map((statement) => statement.sql).filter((sql) => sql.includes("savepoint")), ["savepoint corvis_notification", "release savepoint corvis_notification"]);
});

test("an export that no schedule requested announces nothing", async () => {
  const store = new Store();
  store.run = [];
  await notifyScheduledExportOutcome(store, { tenantId: TENANT, exportId: EXPORT, outcome: "complete" });
  await notifyScheduledExportOutcome(store, { tenantId: TENANT, exportId: EXPORT, outcome: "failed" });
  assert.equal(store.queries.length, 2, "only the lookup, by export within the tenant");
  assert.deepEqual(store.queries[0]!.parameters, [TENANT, EXPORT]);
  assert.equal(store.executed.length, 0);
});

test("a completed scheduled export emits the completion event and no failure email, and a failed one is a failure with the export_failed reason", async () => {
  const completed = new Store();
  await notifyScheduledExportOutcome(completed, { tenantId: TENANT, exportId: EXPORT, outcome: "complete" });
  const emit = completed.queries.find((statement) => statement.sql.includes("emit_export_schedule_run_event"))!;
  assert.deepEqual(emit.parameters, [TENANT, RUN]);
  assert.match(emit.sql, /'completed'/);
  assert.equal(completed.executed.length, 0, "the owner's completion email is the existing export ready email");

  const failed = new Store();
  await notifyScheduledExportOutcome(failed, { tenantId: TENANT, exportId: EXPORT, outcome: "failed" });
  assert.deepEqual(failed.queries.find((statement) => statement.sql.includes("emit_export_schedule_run_event"))!.parameters, [TENANT, RUN, "export_failed"]);
  assert.deepEqual(failed.executed.map((statement) => statement.parameters), [[TENANT, RUN, "export_failed"]]);
});

test("a fault while looking the run up is contained", async (t) => {
  const lines = muteErrors(t);
  const store = new Store();
  store.failOn = "export_schedule_run where";
  await notifyScheduledExportOutcome(store, { tenantId: TENANT, exportId: EXPORT, outcome: "complete" });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, new RegExp(`export_schedule_export:${EXPORT}:complete`));
});
