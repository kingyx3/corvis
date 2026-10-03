import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { processQueuedExports, reclaimStaleExportDeliveries } from "./delivery.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";

const TENANT = "00000000-0000-4000-8000-0000000000a1";
const EXPORT = "00000000-0000-4000-8000-0000000000b1";
const WORKSPACE = "00000000-0000-4000-8000-0000000000d1";
const RUN = "00000000-0000-4000-8000-0000000000e1";

type Statement = { sql: string; parameters: PostgresPrimitive[] };

/**
 * Answers the statement shapes one export completion issues: the stale-lease
 * reclaim, the due-row select, the optimistic claim, the authorization lookup
 * and the final `complete` update.
 */
class ExportCompletionStore implements PostgresSqlApi {
  readonly statements: Statement[] = [];
  dueRows: PostgresRow[] = [];
  /** `undefined` answers like the database (prior attempt + 1); `[]` simulates losing the claim race. */
  claimResult: PostgresRow[] | undefined;
  completedResult: PostgresRow[] = [{ completed_at: "2026-09-01T00:00:05.000Z" }];
  /** The scheduled run (F4b) that requested the export, when a schedule did. */
  scheduledRun: string | undefined;
  /** The scheduled run's owner switch (F4b): whether the requester is still emailed when the export is ready. */
  scheduleEmails = true;
  /** What the stale-lease reclaim returns. */
  reclaimed: PostgresRow[] = [];

  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.statements.push({ sql, parameters });
    if (sql.includes("returning tenant_id,export_id,state")) return this.reclaimed;
    if (sql.includes("select r.run_id,s.notify_on_completion")) return this.scheduledRun ? [{ run_id: this.scheduledRun, notify_on_completion: this.scheduleEmails }] : [];
    if (sql.includes("select tenant_id,export_id")) return this.dueRows;
    if (sql.includes("returning delivery_attempts")) return this.claimResult ?? [{ delivery_attempts: Number(parameters[2]) + 1 }];
    if (sql.includes("from corvis_control.identity_subject s")) {
      return [{ workspace_id: WORKSPACE, role_name: "reviewer", redistribution_allowed: true }];
    }
    if (sql.includes("returning completed_at")) return this.completedResult;
    return [];
  }

  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> {
    this.statements.push({ sql, parameters });
  }

  async health(): Promise<boolean> { return true; }

  find(fragment: string): Statement | undefined { return this.statements.find((statement) => statement.sql.includes(fragment)); }
  scheduleEvents(): Statement[] { return this.statements.filter((statement) => statement.sql.includes("emit_export_schedule_run_event")); }
  notificationInserts(): Statement[] { return this.statements.filter((statement) => statement.sql.includes("corvis_control.email_outbox")); }
}

function dueExport(overrides: PostgresRow = {}): PostgresRow {
  return {
    tenant_id: TENANT, export_id: EXPORT, workspace_id: WORKSPACE, auth_method: "oidc", session_id: "session-1", requested_by: "idp|analyst-1",
    format: "csv", snapshot_ids: [], manifest: { rowCounts: { snapshots: 0 } }, delivery_attempts: 0, created_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function objectStore(options: { failDeletes?: boolean } = {}) {
  const puts: Array<{ key: string; bytes: Uint8Array; contentType: string }> = [];
  const deleted: string[] = [];
  return {
    puts, deleted, bucket: "corvis-exports",
    async putObject(key: string, bytes: Uint8Array, contentType: string) { puts.push({ key, bytes, contentType }); },
    async deleteObject(key: string) {
      deleted.push(key);
      if (options.failDeletes) throw new Error("object store unavailable");
    },
  };
}

function captureMetrics(t: test.TestContext) {
  const lines: Array<Record<string, unknown>> = [];
  t.mock.method(console, "info", (line: unknown) => { try { lines.push(JSON.parse(String(line)) as Record<string, unknown>); } catch { /* not a JSON log line */ } });
  return {
    durations: () => lines.filter((line) => line.event === "metric.duration" && line.metric === "delivery.export"),
    counts: () => lines.filter((line) => line.event === "metric.count" && line.metric === "delivery.export"),
  };
}

test("a first-attempt export completes under tenant-scoped, attempt-fenced SQL, records the artifact manifest, and enqueues one ready notification", async (t) => {
  const metrics = captureMetrics(t);
  const store = new ExportCompletionStore();
  store.dueRows = [dueExport()];
  const objects = objectStore();
  const before = Date.now();
  const result = await processQueuedExports(5, store, () => 0.5, objects);
  assert.deepEqual(result, { processed: 1, failed: 0 });

  // The claim is tenant scoped and guarded by the attempt count we read.
  const claim = store.find("returning delivery_attempts")!;
  assert.match(claim.sql, /where tenant_id=\$1 and export_id=\$2::uuid and state in \('queued','retryable'\) and coalesce\(delivery_attempts,0\)=\$3/);
  assert.deepEqual(claim.parameters, [TENANT, EXPORT, 0]);

  // The artifact is written to the deterministic attempt-1 key and described by the stored manifest.
  const key = `exports/${TENANT}/${EXPORT}/attempt-1/observations.csv`;
  assert.equal(objects.puts.length, 1);
  assert.equal(objects.puts[0]!.key, key);
  const checksum = createHash("sha256").update(objects.puts[0]!.bytes).digest("hex");

  const complete = store.find("returning completed_at")!;
  assert.match(complete.sql, /set state='complete'/);
  assert.match(complete.sql, /where tenant_id=\$5 and export_id=\$6::uuid and state='delivering' and delivery_attempts=\$7/, "completion only applies to the attempt that still owns the lease");
  const [objectUri, expiresAt, storedChecksum, manifestJson, tenantId, exportId, attempt] = complete.parameters;
  assert.equal(objectUri, `gs://corvis-exports/${key}`);
  assert.equal(storedChecksum, checksum);
  assert.equal(tenantId, TENANT);
  assert.equal(exportId, EXPORT);
  assert.equal(attempt, 1);
  const ttlMs = Date.parse(String(expiresAt)) - before;
  assert.ok(ttlMs > 23.9 * 3_600_000 && ttlMs < 24.1 * 3_600_000, `artifact expires after the configured TTL, got ${ttlMs}ms`);
  const manifest = JSON.parse(String(manifestJson)) as { checksumSha256: string; rowCounts: Record<string, number>; artifact: { objectKey: string; sizeBytes: number; contentType: string } };
  assert.equal(manifest.checksumSha256, checksum);
  assert.deepEqual(manifest.rowCounts, { snapshots: 0, observations: 0 });
  assert.equal(manifest.artifact.objectKey, key);
  assert.equal(manifest.artifact.sizeBytes, objects.puts[0]!.bytes.length);
  assert.equal(manifest.artifact.contentType, objects.puts[0]!.contentType);

  // The requester is told once, scoped to the same tenant and workspace.
  const inserts = store.notificationInserts();
  assert.equal(inserts.length, 1);
  assert.deepEqual(inserts[0]!.parameters, [TENANT, "oidc", "idp|analyst-1", WORKSPACE, "csv", EXPORT]);
  assert.match(inserts[0]!.sql, /'export_ready:' \|\| \$6::text[\s\S]*on conflict \(tenant_id,dedupe_key\) do nothing/, "re-delivery cannot send a second email");

  // Attempt 1 has no predecessors, so nothing is deleted.
  assert.deepEqual(objects.deleted, []);

  // Created at 00:00:00, completed at 00:00:05 => a 5s duration metric, plus a count tagged with the format.
  assert.equal(metrics.durations().length, 1);
  assert.equal(metrics.durations()[0]!.durationMs, 5000);
  assert.equal(metrics.durations()[0]!.format, "csv");
  assert.equal(metrics.durations()[0]!.tenantId, TENANT);
  assert.equal(metrics.durations()[0]!.workspaceId, WORKSPACE);
  assert.equal(metrics.durations()[0]!.correlationId, `export:${EXPORT}`);
  assert.equal(metrics.counts().length, 1);
  assert.equal(metrics.counts()[0]!.outcome, "complete");
  assert.equal(metrics.counts()[0]!.format, "csv");
});

test("a retried export that completes removes every earlier attempt's object, and an object-store failure there never fails the export", async (t) => {
  captureMetrics(t);
  const store = new ExportCompletionStore();
  // Two attempts already consumed; the database reports no attempt count back, so the worker falls back to prior + 1.
  store.dueRows = [dueExport({ delivery_attempts: 2 })];
  store.claimResult = [{ delivery_attempts: null }];
  const objects = objectStore({ failDeletes: true });
  const result = await processQueuedExports(5, store, () => 0.5, objects);
  assert.deepEqual(result, { processed: 1, failed: 0 });

  assert.equal(store.find("returning delivery_attempts")!.parameters[2], 2);
  assert.equal(objects.puts[0]!.key, `exports/${TENANT}/${EXPORT}/attempt-3/observations.csv`, "attempt = prior attempts + 1");
  assert.equal(store.find("returning completed_at")!.parameters[6], 3);
  // The first failing delete is swallowed, so the export still completes (the second key is never reached).
  assert.deepEqual(objects.deleted, [`exports/${TENANT}/${EXPORT}/attempt-1/observations.csv`]);
  assert.equal(store.statements.some((statement) => statement.sql.includes("set state=$1")), false, "a cleanup failure must not turn a completed export into a failure");

  const cleanStore = new ExportCompletionStore();
  cleanStore.dueRows = [dueExport({ delivery_attempts: 2 })];
  const cleanObjects = objectStore();
  await processQueuedExports(5, cleanStore, () => 0.5, cleanObjects);
  assert.deepEqual(cleanObjects.deleted, [
    `exports/${TENANT}/${EXPORT}/attempt-1/observations.csv`,
    `exports/${TENANT}/${EXPORT}/attempt-2/observations.csv`,
  ], "every earlier attempt is cleaned up but the current attempt's object is kept");
});

test("a completion that lost its lease sends no notification and deletes no earlier objects", async (t) => {
  const metrics = captureMetrics(t);
  const store = new ExportCompletionStore();
  store.dueRows = [dueExport({ delivery_attempts: 1 })];
  // The guarded update matched no row: the lease was reclaimed or the job changed state meanwhile.
  store.completedResult = [];
  const objects = objectStore();
  await processQueuedExports(5, store, () => 0.5, objects);

  assert.ok(store.find("returning completed_at"));
  assert.deepEqual(store.notificationInserts(), [], "no ready email for an export this worker did not complete");
  assert.deepEqual(objects.deleted, [], "earlier attempts are kept unless this attempt is the recorded completion");
  assert.equal(metrics.durations().length, 0, "no completion timestamp, so no duration metric");
});

test("the export duration metric is only emitted for a usable, non-negative interval", async (t) => {
  const cases: Array<{ name: string; createdAt: unknown; completedAt: unknown; expectedMs?: number }> = [
    { name: "valid interval", createdAt: "2026-09-01T00:00:00.000Z", completedAt: "2026-09-01T00:00:02.500Z", expectedMs: 2500 },
    { name: "zero-length interval", createdAt: "2026-09-01T00:00:03.000Z", completedAt: "2026-09-01T00:00:03.000Z", expectedMs: 0 },
    { name: "completion before creation (clock skew)", createdAt: "2026-09-01T00:00:10.000Z", completedAt: "2026-09-01T00:00:01.000Z" },
    { name: "completion timestamp is null", createdAt: "2026-09-01T00:00:00.000Z", completedAt: null },
    { name: "completion timestamp is unparseable", createdAt: "2026-09-01T00:00:00.000Z", completedAt: "not-a-timestamp" },
    { name: "creation timestamp is missing", createdAt: null, completedAt: "2026-09-01T00:00:05.000Z" },
    { name: "creation timestamp is unparseable", createdAt: "garbage", completedAt: "2026-09-01T00:00:05.000Z" },
  ];
  for (const { name, createdAt, completedAt, expectedMs } of cases) {
    const metrics = captureMetrics(t);
    const store = new ExportCompletionStore();
    store.dueRows = [dueExport({ created_at: createdAt })];
    store.completedResult = [{ completed_at: completedAt }];
    const result = await processQueuedExports(5, store, () => 0.5, objectStore());
    assert.deepEqual(result, { processed: 1, failed: 0 }, name);
    assert.equal(metrics.counts().length, 1, `${name}: the completion is always counted`);
    if (expectedMs === undefined) assert.equal(metrics.durations().length, 0, name);
    else assert.deepEqual(metrics.durations().map((line) => line.durationMs), [expectedMs], name);
    t.mock.restoreAll();
  }
});

test("a queued export whose claim is lost to another worker is skipped without delivering or failing", async (t) => {
  const metrics = captureMetrics(t);
  const store = new ExportCompletionStore();
  store.dueRows = [dueExport()];
  store.claimResult = [];
  const objects = objectStore();
  const result = await processQueuedExports(5, store, () => 0.5, objects);
  assert.deepEqual(result, { processed: 0, failed: 0 });
  assert.deepEqual(objects.puts, [], "an unclaimed export must not write an artifact");
  assert.deepEqual(objects.deleted, []);
  assert.equal(store.find("returning completed_at"), undefined);
  assert.equal(store.statements.some((statement) => statement.sql.includes("set state=$1")), false, "losing the claim is not a delivery failure");
  assert.equal(metrics.counts().length, 0);
});

test("an export row with no recorded attempts is claimed as attempt zero and a missing workspace fails retryably with a redacted error", async (t) => {
  const metrics = captureMetrics(t);
  const store = new ExportCompletionStore();
  const { workspace_id: _omitted, delivery_attempts: _alsoOmitted, ...withoutWorkspace } = dueExport();
  void _omitted; void _alsoOmitted;
  store.dueRows = [withoutWorkspace];
  const objects = objectStore();
  const result = await processQueuedExports(5, store, () => 0.5, objects);
  assert.deepEqual(result, { processed: 0, failed: 1 });

  assert.equal(store.find("returning delivery_attempts")!.parameters[2], 0, "a null attempt counter is treated as zero prior attempts");
  const failure = store.find("set state=$1")!;
  assert.equal(failure.parameters[0], "retryable");
  assert.match(String(failure.parameters[1]), /export_missing_workspace_id/);
  assert.equal(failure.parameters[2], TENANT);
  assert.equal(failure.parameters[3], EXPORT);
  assert.equal(failure.parameters[4], 1);
  assert.deepEqual(objects.puts, []);
  assert.equal(metrics.counts()[0]!.outcome, "retryable");
  assert.equal(metrics.counts()[0]!.workspaceId, undefined, "telemetry context omits an absent workspace instead of printing 'null'");
});

test("a failed export attempt still becomes retryable when removing its partial object also fails", async (t) => {
  captureMetrics(t);
  const store = new ExportCompletionStore();
  // An unsupported auth method fails deterministically before anything is rendered.
  store.dueRows = [dueExport({ auth_method: "password", delivery_attempts: 1 })];
  const objects = objectStore({ failDeletes: true });
  const result = await processQueuedExports(5, store, () => 0.5, objects);
  assert.deepEqual(result, { processed: 0, failed: 1 });
  assert.deepEqual(objects.deleted, [`exports/${TENANT}/${EXPORT}/attempt-2/observations.csv`], "cleanup targets only this attempt's key");
  const failure = store.find("set state=$1")!;
  assert.equal(failure.parameters[0], "retryable");
  assert.match(String(failure.parameters[1]), /export_invalid_auth_method/);
  assert.equal(failure.parameters[4], 2);
  const retryAt = Date.parse(String(failure.parameters[5])) - Date.now();
  assert.ok(Math.abs(retryAt - 2 * 60_000) < 5_000, `attempt 2 backs off ~2m, got ${retryAt}`);
});

test("an export no schedule requested is looked up once and announces nothing beyond the ready email", async (t) => {
  captureMetrics(t);
  const store = new ExportCompletionStore();
  store.dueRows = [dueExport()];
  await processQueuedExports(5, store, () => 0.5, objectStore());
  assert.equal(store.statements.filter((statement) => statement.sql.includes("select r.run_id,s.notify_on_completion")).length, 1);
  assert.deepEqual(store.scheduleEvents(), []);
});

test("a completed export that a schedule requested ends its run with one completion event carrying ids only", async (t) => {
  captureMetrics(t);
  const store = new ExportCompletionStore();
  store.dueRows = [dueExport()];
  store.scheduledRun = RUN;
  assert.deepEqual(await processQueuedExports(5, store, () => 0.5, objectStore()), { processed: 1, failed: 0 });
  const lookup = store.find("select r.run_id,s.notify_on_completion")!;
  assert.deepEqual(lookup.parameters, [TENANT, EXPORT], "found by the export, within the tenant");
  const events = store.scheduleEvents();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.parameters, [TENANT, RUN]);
  assert.match(events[0]!.sql, /'completed'/);
  assert.equal(store.notificationInserts().length, 1, "the owner's export ready email is the existing one");

  // Losing the lease means this worker did not complete the export, so it announces nothing.
  const lost = new ExportCompletionStore();
  lost.dueRows = [dueExport()];
  lost.scheduledRun = RUN;
  lost.completedResult = [];
  await processQueuedExports(5, lost, () => 0.5, objectStore());
  assert.deepEqual(lost.scheduleEvents(), []);
});

test("an export that a schedule requested and that ran out of attempts ends its run in a failure notice, and a retryable one does not", async (t) => {
  captureMetrics(t);
  // A deterministic failure on the last attempt is final.
  const final = new ExportCompletionStore();
  final.dueRows = [dueExport({ auth_method: "password", delivery_attempts: 4 })];
  final.scheduledRun = RUN;
  assert.deepEqual(await processQueuedExports(5, final, () => 0.5, objectStore()), { processed: 0, failed: 1 });
  assert.equal(final.find("set state=$1")!.parameters[0], "failed");
  const events = final.scheduleEvents();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.parameters, [TENANT, RUN, "export_failed"]);
  assert.equal(final.notificationInserts().length, 1, "and the owner is emailed, in words only");
  assert.deepEqual(final.notificationInserts()[0]!.parameters, [TENANT, RUN, "export_failed"]);

  // The first attempt can still be retried: nothing is announced until the outcome is final.
  const retry = new ExportCompletionStore();
  retry.dueRows = [dueExport({ auth_method: "password", delivery_attempts: 0 })];
  retry.scheduledRun = RUN;
  await processQueuedExports(5, retry, () => 0.5, objectStore());
  assert.equal(retry.find("set state=$1")!.parameters[0], "retryable");
  assert.deepEqual(retry.scheduleEvents(), []);
  assert.equal(retry.statements.some((statement) => statement.sql.includes("select r.run_id,s.notify_on_completion")), false);
});

test("a stale export lease that runs out of attempts is final and announced, while one that will be retried is not", async () => {
  const store = new ExportCompletionStore();
  store.scheduledRun = RUN;
  store.reclaimed = [{ tenant_id: TENANT, export_id: EXPORT, state: "failed" }, { tenant_id: TENANT, export_id: "00000000-0000-4000-8000-0000000000b2", state: "retryable" }];
  assert.equal(await reclaimStaleExportDeliveries(store), 2);
  const lookups = store.statements.filter((statement) => statement.sql.includes("select r.run_id,s.notify_on_completion"));
  assert.deepEqual(lookups.map((statement) => statement.parameters), [[TENANT, EXPORT]]);
  assert.deepEqual(store.scheduleEvents().map((statement) => statement.parameters), [[TENANT, RUN, "export_failed"]]);
});

test("a scheduled export whose owner switched emails off still announces its completion but sends no ready email, and any other export always does", async (t) => {
  captureMetrics(t);
  const quiet = new ExportCompletionStore();
  quiet.dueRows = [dueExport()];
  quiet.scheduledRun = RUN;
  quiet.scheduleEmails = false;
  assert.deepEqual(await processQueuedExports(5, quiet, () => 0.5, objectStore()), { processed: 1, failed: 0 });
  assert.deepEqual(quiet.notificationInserts(), [], "switched off for this schedule: the owner is not emailed");
  assert.equal(quiet.scheduleEvents().length, 1, "webhook subscribers are told whatever the owner's email switch");

  const loud = new ExportCompletionStore();
  loud.dueRows = [dueExport()];
  loud.scheduledRun = RUN;
  await processQueuedExports(5, loud, () => 0.5, objectStore());
  assert.equal(loud.notificationInserts().length, 1, "switched on: the owner is emailed as for any export");

  const interactive = new ExportCompletionStore();
  interactive.dueRows = [dueExport()];
  interactive.scheduleEmails = false;
  await processQueuedExports(5, interactive, () => 0.5, objectStore());
  assert.equal(interactive.notificationInserts().length, 1, "an export no schedule requested has no switch");
});
