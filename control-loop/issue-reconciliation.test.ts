import assert from "node:assert/strict";
import test from "node:test";
import { formatFingerprint, legacyFingerprintOf } from "./classifiers/fingerprint.ts";
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

// ---- legacy-fingerprint adoption ----

const OWNERS = ["strategy", "engineering"];
function current(subject: string): string { return formatFingerprint({ domain: "business-control-loop", owners: OWNERS, subject }); }
function issueBody(fingerprint: string): string { return `detail\n\nFinding fingerprint: \`${fingerprint}\`\n\n_Opened automatically_`; }

test("an open issue tagged with the legacy fingerprint is re-keyed, not closed and duplicated", () => {
  const fingerprint = current("docs/a.md:broken");
  const legacy = legacyFingerprintOf(fingerprint);
  const actions = planIssueReconciliation({
    findings: [finding({ fingerprint })],
    snapshot: snapshot([{ number: 9, state: "open", title: "t", fingerprint: legacy, labels: ["control-loop"], body: issueBody(legacy) }]),
    status: "complete",
    closureAllowed: true,
  });
  assert.deepEqual(actions.map((a) => [a.type, a.issueNumber]), [["rekey", 9]]);
  assert.match(actions[0]!.body!, new RegExp(`Finding fingerprint: \`${fingerprint.replace(/[#:]/g, "\\$&")}\``));
  assert.ok(actions[0]!.body!.includes("_Opened automatically_"), "the rest of the body is preserved");
});

test("a closed legacy issue for a recurring finding is re-keyed and reopened", () => {
  const fingerprint = current("docs/a.md:broken");
  const legacy = legacyFingerprintOf(fingerprint);
  const actions = planIssueReconciliation({
    findings: [finding({ fingerprint })],
    snapshot: snapshot([{ number: 4, state: "closed", title: "t", fingerprint: legacy, labels: ["control-loop"], body: issueBody(legacy) }]),
    status: "complete",
    closureAllowed: true,
  });
  assert.deepEqual(actions.map((a) => [a.type, a.issueNumber]), [["rekey", 4], ["reopen", 4]]);
});

test("a legacy issue whose finding is gone is still closed", () => {
  const legacy = legacyFingerprintOf(current("docs/a.md:gone"));
  const actions = planIssueReconciliation({
    findings: [],
    snapshot: snapshot([{ number: 3, state: "open", title: "t", fingerprint: legacy, labels: ["control-loop"], body: issueBody(legacy) }]),
    status: "complete",
    closureAllowed: true,
  });
  assert.deepEqual(actions.map((a) => [a.type, a.issueNumber]), [["close", 3]]);
});

test("findings that collided in the legacy format share one legacy issue: one adopts it, the other gets its own", () => {
  const first = current("docs/a-b.md:missing.md");
  const second = current("docs/a_b.md:missing.md");
  const legacy = legacyFingerprintOf(first);
  assert.equal(legacyFingerprintOf(second), legacy);
  const actions = planIssueReconciliation({
    findings: [finding({ fingerprint: second }), finding({ fingerprint: first })],
    snapshot: snapshot([{ number: 8, state: "open", title: "t", fingerprint: legacy, labels: ["control-loop"], body: issueBody(legacy) }]),
    status: "complete",
    closureAllowed: true,
  });
  assert.deepEqual(actions.map((a) => a.type).sort(), ["create", "rekey"]);
  assert.equal(actions.filter((a) => a.type === "rekey").length, 1);
  assert.ok(!actions.some((a) => a.type === "close"), "the adopted issue is not closed as gone");
  const rekey = actions.find((a) => a.type === "rekey")!;
  const created = actions.find((a) => a.type === "create")!;
  assert.notEqual(rekey.fingerprint, created.fingerprint);
});

test("a legacy issue with no re-keyable body is not adopted (the finding is created instead)", () => {
  const fingerprint = current("docs/a.md:broken");
  const legacy = legacyFingerprintOf(fingerprint);
  const actions = planIssueReconciliation({
    findings: [finding({ fingerprint })],
    snapshot: snapshot([{ number: 9, state: "open", title: "t", fingerprint: legacy, labels: ["control-loop"], body: null }]),
    status: "complete",
    closureAllowed: false,
  });
  assert.deepEqual(actions.map((a) => a.type), ["create"]);
});

test("an issue already carrying the current fingerprint is matched directly with no re-key", () => {
  const fingerprint = current("docs/a.md:broken");
  const actions = planIssueReconciliation({
    findings: [finding({ fingerprint })],
    snapshot: snapshot([{ number: 9, state: "open", title: "t", fingerprint, labels: ["control-loop"], body: issueBody(fingerprint) }]),
    status: "complete",
    closureAllowed: true,
  });
  assert.deepEqual(actions, []);
});

test("applying a rekey rewrites only the issue body and spends one budget unit", async () => {
  const writer = new RecordingWriter();
  const result = await applyIssueReconciliation(
    [{ type: "rekey", fingerprint: "f", issueNumber: 9, title: null, body: "rewritten" }],
    { mode: "execute", budget: 1, writer },
  );
  assert.deepEqual(writer.bodyUpdates, [{ issueNumber: 9, body: "rewritten" }]);
  assert.equal(writer.stateChanges.length + writer.comments.length + writer.created.length, 0);
  assert.deepEqual(result.outcomes.map((o) => o.outcome), ["applied"]);
});

// ---- applyIssueReconciliation ----

class RecordingWriter implements IssueWriter {
  created: Array<{ title: string; body: string; labels: string[] }> = [];
  stateChanges: Array<{ issueNumber: number; state: "open" | "closed" }> = [];
  comments: Array<{ issueNumber: number; body: string }> = [];
  bodyUpdates: Array<{ issueNumber: number; body: string }> = [];
  async updateBody(issueNumber: number, body: string) {
    this.bodyUpdates.push({ issueNumber, body });
  }
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
