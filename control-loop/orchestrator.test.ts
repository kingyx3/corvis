import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireLock } from "./lock.ts";
import { runControlLoop } from "./orchestrator.ts";
import { InMemoryStateStore } from "./state.ts";
import { readWatermark } from "./watermark.ts";

async function tempRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "control-loop-test-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return root;
}

const NOW = new Date("2026-09-19T00:00:00.000Z");
const EMPTY_ISSUE_SNAPSHOT = { fetchedAt: NOW.toISOString(), issues: [] };

test("a first run on a clean repo with no prior watermark completes, is unhealthy on freshness, and updates the watermark", async () => {
  const root = await tempRepo({ "docs/README.md": "# Hi\n" });
  try {
    const store = new InMemoryStateStore();
    const report = await runControlLoop({ root, mode: "daily", now: NOW, stateStore: store, runId: "run-1" });
    assert.equal(report.skipped, false);
    // No prior daily success and no prior weekly scan ever completed: unhealthy on both counts.
    assert.equal(report.health.healthy, false);
    assert.equal(report.watermark.lastRunId, "run-1");
    assert.equal(report.status, "incomplete", "issue hygiene has no snapshot available with no GitHub token configured");
    assert.equal(report.watermark.consecutiveFailures, 1, "a run that does not reach complete status still counts toward the failure streak");
    const persisted = await readWatermark(store);
    assert.deepEqual(persisted, report.watermark);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("closure is never allowed while the loop is unhealthy, even on a structurally complete run", async () => {
  const root = await tempRepo({ "docs/README.md": "# Hi\n" });
  try {
    // A complete daily run still leaves the loop unhealthy when no weekly
    // scan has ever completed, since that dimension only a weekly/monthly
    // run can satisfy.
    const report = await runControlLoop({ root, mode: "daily", now: NOW, stateStore: new InMemoryStateStore(), runId: "run-1", issueSnapshot: EMPTY_ISSUE_SNAPSHOT });
    assert.equal(report.status, "complete");
    assert.equal(report.health.healthy, false);
    assert.equal(report.closure.allowed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a run skipped by lock contention never touches the watermark and is reported as incomplete", async () => {
  const store = new InMemoryStateStore();
  await acquireLock(store, "someone-else", NOW, 60 * 60 * 1000);
  const before = await readWatermark(store);

  const root = await tempRepo({ "docs/README.md": "# Hi\n" });
  try {
    const report = await runControlLoop({ root, mode: "daily", now: NOW, stateStore: store, lockOwner: "control-loop" });
    assert.equal(report.skipped, true);
    assert.equal(report.status, "incomplete");
    assert.equal(report.closure.allowed, false);
    assert.deepEqual(await readWatermark(store), before, "a skipped run must not change the watermark");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the lock is always released after a run, so the next run on the same repo can acquire it", async () => {
  const store = new InMemoryStateStore();
  const root = await tempRepo({ "docs/README.md": "# Hi\n" });
  try {
    await runControlLoop({ root, mode: "daily", now: NOW, stateStore: store });
    const second = await runControlLoop({ root, mode: "daily", now: NOW, stateStore: store });
    assert.equal(second.skipped, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("two consecutive failed runs make the loop unhealthy via the accumulated failure count", async () => {
  const store = new InMemoryStateStore();
  const missingRoot = join(tmpdir(), "control-loop-test-missing-does-not-exist");
  const first = await runControlLoop({ root: missingRoot, mode: "daily", now: NOW, stateStore: store });
  assert.equal(first.status, "failed");
  assert.equal(first.watermark.consecutiveFailures, 1);

  const second = await runControlLoop({ root: missingRoot, mode: "daily", now: NOW, stateStore: store });
  assert.equal(second.watermark.consecutiveFailures, 2);
  assert.equal(second.health.healthy, false);
  assert.ok(second.health.reasons.includes("two_consecutive_failures"));
  assert.equal(second.closure.allowed, false);
});

test("a successful daily run resets the consecutive-failure counter", async () => {
  const store = new InMemoryStateStore();
  const missingRoot = join(tmpdir(), "control-loop-test-missing-does-not-exist-2");
  await runControlLoop({ root: missingRoot, mode: "daily", now: NOW, stateStore: store });

  const root = await tempRepo({ "docs/README.md": "# Hi\n" });
  try {
    const report = await runControlLoop({ root, mode: "weekly", now: NOW, stateStore: store, issueSnapshot: EMPTY_ISSUE_SNAPSHOT });
    assert.equal(report.watermark.consecutiveFailures, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a weekly run that completes marks the weekly scan complete in the watermark for the health check", async () => {
  const root = await tempRepo({ "docs/README.md": "# Hi\n" });
  try {
    const report = await runControlLoop({ root, mode: "weekly", now: NOW, stateStore: new InMemoryStateStore(), issueSnapshot: EMPTY_ISSUE_SNAPSHOT });
    assert.equal(report.watermark.lastWeeklyScanComplete, true);
    assert.equal(report.watermark.lastSuccessfulWeeklyRunAt, NOW.toISOString());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a healthy prior state (recent daily success and a complete prior weekly scan) allows closure on a clean complete run", async () => {
  const store = new InMemoryStateStore();
  const root = await tempRepo({ "docs/README.md": "# Hi\n" });
  try {
    await runControlLoop({ root, mode: "weekly", now: NOW, stateStore: store, issueSnapshot: EMPTY_ISSUE_SNAPSHOT });
    const later = new Date(NOW.getTime() + 60 * 60 * 1000);
    const report = await runControlLoop({ root, mode: "daily", now: later, stateStore: store, issueSnapshot: EMPTY_ISSUE_SNAPSHOT });
    assert.equal(report.health.healthy, true);
    assert.equal(report.closure.allowed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("apply defaults to dry-run and never calls a configured applier unless the caller opts into execute mode", async () => {
  const root = await tempRepo({ "docs/README.md": "[broken](./MISSING.md)\n" });
  try {
    let called = false;
    const report = await runControlLoop({
      root, mode: "daily", now: NOW, stateStore: new InMemoryStateStore(),
      applier: { apply: async () => { called = true; } },
    });
    assert.ok(report.findings.some((f) => f.ruleId === "CL-DOC-003"));
    assert.equal(report.applied?.dryRun, true);
    assert.equal(called, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent runs with default lock owners exclude each other, and a finishing run never releases another run's lease", async () => {
  const store = new InMemoryStateStore();
  const root = await tempRepo({ "docs/README.md": "# Hi\n" });
  try {
    // Simulate run A mid-flight holding its default per-run lease.
    await acquireLock(store, "control-loop:run-a", NOW, 60 * 60 * 1000);
    const runB = await runControlLoop({ root, mode: "daily", now: NOW, stateStore: store, runId: "run-b", issueSnapshot: EMPTY_ISSUE_SNAPSHOT });
    assert.equal(runB.skipped, true, "a second run must not treat the first run's live lease as its own");
    const runC = await runControlLoop({ root, mode: "daily", now: NOW, stateStore: store, runId: "run-c", issueSnapshot: EMPTY_ISSUE_SNAPSHOT });
    assert.equal(runC.skipped, true, "run B's exit must not have released run A's lease");
    assert.equal(JSON.parse((await store.read("lock"))!).owner, "control-loop:run-a");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a run whose watermark changed underneath it does not overwrite the newer watermark", async () => {
  const store = new InMemoryStateStore();
  const root = await tempRepo({ "docs/README.md": "# Hi\n" });
  try {
    const racing = {
      read: (key: string) => store.read(key),
      write: (key: string, value: string | null) => store.write(key, value),
      readVersioned: (key: string) => store.readVersioned(key),
      async writeIfVersion(key: string, value: string | null, expected: string | null) {
        // Another writer lands a watermark just before this run persists its own.
        if (key === "watermark") await store.write("watermark", JSON.stringify({ ...(await readWatermark(store)), lastRunId: "newer-run" }));
        return store.writeIfVersion(key, value, expected);
      },
    };
    const report = await runControlLoop({ root, mode: "daily", now: NOW, stateStore: racing, runId: "stale-run", issueSnapshot: EMPTY_ISSUE_SNAPSHOT });
    assert.ok(report.notes.includes("watermark_write_conflict"));
    assert.equal((await readWatermark(store)).lastRunId, "newer-run");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("without a GitHub token a missing issue snapshot is a skipped scanner, not a failure, while closure stays disabled", async () => {
  const store = new InMemoryStateStore();
  const root = await tempRepo({ "docs/README.md": "# Hi\n" });
  try {
    const first = await runControlLoop({ root, mode: "weekly", now: NOW, stateStore: store, runId: "run-1", issueSnapshot: null, issueSnapshotRequired: false });
    assert.equal(first.status, "complete");
    assert.equal(first.watermark.consecutiveFailures, 0);
    assert.equal(first.watermark.lastWeeklyScanComplete, true);
    const hygiene = first.scan.scanners.find((scanner) => scanner.name === "issue-hygiene");
    assert.deepEqual(hygiene, { name: "issue-hygiene", complete: false, skipped: true, reason: "issue_snapshot_unavailable_no_github_token" });
    assert.equal(first.closure.allowed, false, "closure needs the issue snapshot");

    const later = new Date(NOW.getTime() + 60 * 60 * 1000);
    const second = await runControlLoop({ root, mode: "daily", now: later, stateStore: store, runId: "run-2", issueSnapshot: null, issueSnapshotRequired: false });
    assert.equal(second.health.healthy, true, "an unconfigured optional scanner must not degrade health forever");
    assert.equal(second.closure.allowed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("with a GitHub token configured, a failed issue fetch still marks the run incomplete", async () => {
  const root = await tempRepo({ "docs/README.md": "# Hi\n" });
  try {
    const report = await runControlLoop({ root, mode: "daily", now: NOW, stateStore: new InMemoryStateStore(), issueSnapshot: null, issueSnapshotRequired: true });
    assert.equal(report.status, "incomplete");
    assert.equal(report.watermark.consecutiveFailures, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an incremental daily scan never allows automatic closure even when the loop is healthy", async () => {
  const store = new InMemoryStateStore();
  const root = await tempRepo({ "docs/README.md": "# Hi\n" });
  try {
    await runControlLoop({ root, mode: "weekly", now: NOW, stateStore: store, issueSnapshot: EMPTY_ISSUE_SNAPSHOT });
    const later = new Date(NOW.getTime() + 60 * 60 * 1000);
    const report = await runControlLoop({ root, mode: "daily", now: later, stateStore: store, issueSnapshot: EMPTY_ISSUE_SNAPSHOT, changedPaths: ["docs/README.md"] });
    assert.equal(report.scan.full, false);
    assert.equal(report.health.healthy, true);
    assert.deepEqual(report.closure, { allowed: false, reason: "incremental_scan" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
