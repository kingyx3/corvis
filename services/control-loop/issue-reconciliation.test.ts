import assert from "node:assert/strict";
import test from "node:test";
import { CONTROL_LOOP_HEALTH_FINGERPRINT, healthFinding } from "./reports/health.ts";
import { applyIssueReconciliation, planIssueReconciliation, type IssueWriter } from "./issue-reconciliation.ts";
import type { Finding } from "./types.ts";
import type { IssueSnapshot } from "./scanners/issue-hygiene.ts";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    ruleId: "CL-DOC-002", fingerprint: "business-control-loop:strategy-engineering:x",
    subject: "x", severity: "high", authority: "github", remediation: "human-approval",
    path: "docs/A.md", line: 3, detail: "some finding detail", suggestion: null,
    ...overrides,
  };
}

function snapshot(issues: IssueSnapshot["issues"]): IssueSnapshot {
  return { fetchedAt: "2026-09-25T00:00:00.000Z", issues };
}

// ---- planIssueReconciliation ----

test("a failed run never plans any reconciliation action", () => {
  const actions = planIssueReconciliation({
    findings: [finding()],
    snapshot: snapshot([]),
    status: "failed",
    closureAllowed: false,
  });
  assert.deepEqual(actions, []);
});

test("an active finding with no tracked issue at all is planned for creation", () => {
  const f = finding();
  const actions = planIssueReconciliation({ findings: [f], snapshot: snapshot([]), status: "complete", closureAllowed: true });
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.type, "create");
  assert.equal(actions[0]?.fingerprint, f.fingerprint);
  assert.ok(actions[0]?.title?.includes("CL-DOC-002"));
  assert.ok(actions[0]?.body?.includes(f.fingerprint));
});

test("an active finding already tracked by an open issue plans nothing", () => {
  const f = finding();
  const actions = planIssueReconciliation({
    findings: [f],
    snapshot: snapshot([{ number: 1, state: "open", title: "t", fingerprint: f.fingerprint, labels: ["control-loop"] }]),
    status: "complete",
    closureAllowed: true,
  });
  assert.deepEqual(actions, []);
});

test("an active finding whose only tracked issue is closed is planned for reopening", () => {
  const f = finding();
  const actions = planIssueReconciliation({
    findings: [f],
    snapshot: snapshot([{ number: 3, state: "closed", title: "t", fingerprint: f.fingerprint, labels: ["control-loop"] }]),
    status: "complete",
    closureAllowed: true,
  });
  assert.equal(actions.length, 1);
  assert.deepEqual({ type: actions[0]?.type, issueNumber: actions[0]?.issueNumber }, { type: "reopen", issueNumber: 3 });
});

test("an open tracked issue with no matching active finding is planned for closure only when closure is allowed", () => {
  const trackedSnapshot = snapshot([{ number: 5, state: "open", title: "t", fingerprint: "business-control-loop:strategy-engineering:gone", labels: ["control-loop"] }]);

  const blocked = planIssueReconciliation({ findings: [], snapshot: trackedSnapshot, status: "complete", closureAllowed: false });
  assert.deepEqual(blocked, []);

  const allowed = planIssueReconciliation({ findings: [], snapshot: trackedSnapshot, status: "complete", closureAllowed: true });
  assert.equal(allowed.length, 1);
  assert.deepEqual({ type: allowed[0]?.type, issueNumber: allowed[0]?.issueNumber }, { type: "close", issueNumber: 5 });
});

test("an issue without the control-loop label is never touched even if its fingerprint matches", () => {
  const f = finding();
  const actions = planIssueReconciliation({
    findings: [f],
    snapshot: snapshot([{ number: 1, state: "open", title: "t", fingerprint: f.fingerprint, labels: [] }]),
    status: "complete",
    closureAllowed: true,
  });
  // Not recognized as tracked, so a duplicate create is planned rather than silently ignored.
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.type, "create");
});

// ---- control-loop health issue ----

const unhealthy = healthFinding({ healthy: false, reasons: ["incomplete_weekly_scan"], automaticClosureEnabled: false }) as Finding;
const healthIssue = (state: "open" | "closed") => ({ number: 40, state, title: "t", fingerprint: CONTROL_LOOP_HEALTH_FINGERPRINT, labels: ["control-loop"] });

test("an unhealthy loop plans one health issue and a failed run still plans nothing", () => {
  const created = planIssueReconciliation({ findings: [], snapshot: snapshot([]), status: "incomplete", closureAllowed: false, health: { finding: unhealthy, closeAllowed: false } });
  assert.deepEqual(created.map((action) => [action.type, action.fingerprint]), [["create", CONTROL_LOOP_HEALTH_FINGERPRINT]]);
  assert.ok(created[0]?.title?.includes("CL-HEALTH-001"));
  assert.ok(created[0]?.body?.includes("incomplete_weekly_scan"));
  assert.deepEqual(planIssueReconciliation({ findings: [], snapshot: snapshot([]), status: "failed", closureAllowed: false, health: { finding: unhealthy, closeAllowed: false } }), []);
});

test("an open health issue is not duplicated and a closed one is reopened", () => {
  const open = planIssueReconciliation({ findings: [], snapshot: snapshot([healthIssue("open")]), status: "complete", closureAllowed: false, health: { finding: unhealthy, closeAllowed: false } });
  assert.deepEqual(open, []);
  const reopened = planIssueReconciliation({ findings: [], snapshot: snapshot([healthIssue("closed")]), status: "complete", closureAllowed: false, health: { finding: unhealthy, closeAllowed: false } });
  assert.deepEqual(reopened.map((action) => [action.type, action.issueNumber]), [["reopen", 40]]);
});

test("the health issue closes on its own gate, independent of the full-scan content closure gate", () => {
  const closes = planIssueReconciliation({ findings: [], snapshot: snapshot([healthIssue("open")]), status: "complete", closureAllowed: false, health: { finding: null, closeAllowed: true } });
  assert.deepEqual(closes.map((action) => [action.type, action.issueNumber]), [["close", 40]]);
  assert.ok(closes[0]?.body?.includes("health finding"));
  const held = planIssueReconciliation({ findings: [], snapshot: snapshot([healthIssue("open")]), status: "incomplete", closureAllowed: false, health: { finding: null, closeAllowed: false } });
  assert.deepEqual(held, []);
});

test("the health issue is left alone unless the caller supplies health, and a content close does not close it", () => {
  const content = finding();
  const snap = snapshot([healthIssue("open"), { number: 41, state: "open", title: "t", fingerprint: content.fingerprint, labels: ["control-loop"] }]);
  const withoutHealth = planIssueReconciliation({ findings: [], snapshot: snap, status: "complete", closureAllowed: true });
  assert.deepEqual(withoutHealth.map((action) => [action.type, action.issueNumber]), [["close", 41]]);
  const contentGateClosed = planIssueReconciliation({ findings: [], snapshot: snap, status: "complete", closureAllowed: true, health: { finding: null, closeAllowed: false } });
  assert.deepEqual(contentGateClosed.map((action) => action.issueNumber), [41]);
});

// ---- applyIssueReconciliation ----

class RecordingWriter implements IssueWriter {
  created: Array<{ title: string; body: string; labels: string[] }> = [];
  stateChanges: Array<{ issueNumber: number; state: "open" | "closed" }> = [];
  comments: Array<{ issueNumber: number; body: string }> = [];
  async create(input: { title: string; body: string; labels: string[] }) {
    this.created.push(input);
    return { number: 42 };
  }
  async setState(issueNumber: number, state: "open" | "closed") {
    this.stateChanges.push({ issueNumber, state });
  }
  async comment(issueNumber: number, body: string) {
    this.comments.push({ issueNumber, body });
  }
}

test("dry-run mode never calls the writer", async () => {
  const writer = new RecordingWriter();
  const result = await applyIssueReconciliation(
    [{ type: "create", fingerprint: "f", issueNumber: null, title: "t", body: "b" }],
    { mode: "dry-run", budget: 10, writer },
  );
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.outcomes, [{ type: "create", fingerprint: "f", issueNumber: null, outcome: "dry-run", reason: null }]);
  assert.equal(writer.created.length, 0);
});

test("execute mode with no writer configured reports skipped rather than silently succeeding", async () => {
  const result = await applyIssueReconciliation(
    [{ type: "create", fingerprint: "f", issueNumber: null, title: "t", body: "b" }],
    { mode: "execute", budget: 10 },
  );
  assert.deepEqual(result.outcomes, [{ type: "create", fingerprint: "f", issueNumber: null, outcome: "skipped", reason: "no_writer_configured" }]);
});

test("execute mode with a writer creates, reopens (with a comment) and closes (with a comment)", async () => {
  const writer = new RecordingWriter();
  const result = await applyIssueReconciliation(
    [
      { type: "create", fingerprint: "a", issueNumber: null, title: "t", body: "b" },
      { type: "reopen", fingerprint: "b", issueNumber: 7, title: null, body: "recurred" },
      { type: "close", fingerprint: "c", issueNumber: 9, title: null, body: "resolved" },
    ],
    { mode: "execute", budget: 10, writer },
  );
  assert.deepEqual(result.outcomes.map((o) => o.outcome), ["applied", "applied", "applied"]);
  assert.deepEqual(writer.created, [{ title: "t", body: "b", labels: ["control-loop"] }]);
  assert.deepEqual(writer.stateChanges, [{ issueNumber: 7, state: "open" }, { issueNumber: 9, state: "closed" }]);
  assert.deepEqual(writer.comments, [{ issueNumber: 7, body: "recurred" }, { issueNumber: 9, body: "resolved" }]);
  assert.equal(result.outcomes[0]?.issueNumber, 42, "the created issue's real number is reported, not null");
});

test("the mutation budget stops further writes and is reported as exceeded", async () => {
  const writer = new RecordingWriter();
  const result = await applyIssueReconciliation(
    [
      { type: "create", fingerprint: "a", issueNumber: null, title: "t", body: "b" },
      { type: "create", fingerprint: "b", issueNumber: null, title: "t", body: "b" },
    ],
    { mode: "execute", budget: 1, writer },
  );
  assert.equal(writer.created.length, 1);
  assert.equal(result.budgetExceeded, true);
  assert.deepEqual(result.outcomes.map((o) => o.outcome), ["applied", "skipped"]);
});

/** Throws `github_issue_create_failed:<status>` on the given 1-based create attempt; succeeds otherwise. */
class FailingWriter extends RecordingWriter {
  private attempts = 0;
  private readonly failOnAttempt: number;
  private readonly status: number;
  constructor(failOnAttempt: number, status: number) {
    super();
    this.failOnAttempt = failOnAttempt;
    this.status = status;
  }
  async create(input: { title: string; body: string; labels: string[] }) {
    this.attempts += 1;
    if (this.attempts === this.failOnAttempt) throw new Error(`github_issue_create_failed:${this.status}`);
    return super.create(input);
  }
}

const THREE_CREATES = ["a", "b", "c"].map((fingerprint) => ({ type: "create" as const, fingerprint, issueNumber: null, title: "t", body: "b" }));

test("a non-halting writer error is recorded as a failed outcome and later actions still run", async () => {
  const writer = new FailingWriter(2, 500);
  const result = await applyIssueReconciliation(THREE_CREATES, { mode: "execute", budget: 10, writer });
  assert.deepEqual(result.outcomes.map((o) => o.outcome), ["applied", "failed", "applied"]);
  assert.equal(result.outcomes[1]?.reason, "github_500");
  assert.equal(result.haltedReason, null);
});

test("a 403 writer error halts further writes and records the rest as skipped, retaining earlier applies", async () => {
  const writer = new FailingWriter(2, 403);
  const result = await applyIssueReconciliation(THREE_CREATES, { mode: "execute", budget: 10, writer });
  assert.deepEqual(result.outcomes.map((o) => o.outcome), ["applied", "failed", "skipped"]);
  assert.equal(result.outcomes[1]?.reason, "github_403");
  assert.equal(result.outcomes[2]?.reason, "halted_after:github_403");
  assert.equal(result.haltedReason, "github_403");
  assert.equal(result.outcomes[0]?.issueNumber, 42);
});
