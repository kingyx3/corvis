import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyActions } from "./apply.ts";
import { runCli } from "./cli.ts";
import { createGitHubFileEditApplier } from "./github.ts";
import { applyIssueReconciliation, planIssueReconciliation } from "./issue-reconciliation.ts";
import { runControlLoop } from "./orchestrator.ts";
import { planActions } from "./plan.ts";
import { scanInternalLinks } from "./scanners/internal-links.ts";
import { resolveRelative } from "./scanners/markdown.ts";
import { InMemoryStateStore } from "./state.ts";

const now = new Date("2026-10-06T12:00:00Z");
async function repo() {
  const root = await mkdtemp(join(tmpdir(), "review-control-loop-"));
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "docs/README.md"), "[a](old/A.md)\n[b](old/B.md)\n");
  await writeFile(join(root, "docs/A.md"), "# A\n");
  await writeFile(join(root, "docs/B.md"), "# B\n");
  return root;
}

test("real scanner plans are accepted by the GitHub applier, preserving prose, code, anchors and encoded paths", async () => {
  const original = '# Links\nLiteral old/A.md and `code [a](old/A.md)`\n[a](old/A.md#section) [again](old/A.md#section)\n[b](old/my%20doc.md)\n[ref]: old/A.md#section\n```\n[a](old/A.md)\n```\n';
  const expected = original.replaceAll('](old/A.md#section)', '](./A.md#section)').replace('](old/my%20doc.md)', '](./my%20doc.md)').replace('[ref]: old/A.md#section', '[ref]: ./A.md#section');
  let content = original;
  let writes = 0;
  const findings = scanInternalLinks([{ path: "docs/README.md", text: original }], { root: ".", files: [], paths: new Set(["docs/README.md", "docs/A.md", "docs/my doc.md"]) });
  const applier = createGitHubFileEditApplier({ owner: "o", repo: "r", token: "test", fetchImpl: (async (_input, init) => {
    if (init?.method === "PUT") {
      writes += 1;
      content = Buffer.from(JSON.parse(String(init.body)).content, "base64").toString("utf8");
      return Response.json({});
    }
    return Response.json({ content: Buffer.from(content).toString("base64"), sha: "sha", encoding: "base64" });
  }) as typeof fetch });
  const result = await applyActions(planActions(findings), { mode: "execute", budget: 1, applier });
  assert.ok(result.actions.every((action) => action.outcome === "applied"));
  assert.equal(content, expected);
  assert.equal(writes, 1, "one consolidated write per document");
});

test("failed post-write verification consumes the file mutation budget", async () => {
  const plan = planActions(["A", "B"].map((name) => ({ ruleId: "CL-DOC-003", fingerprint: name, subject: name, severity: "medium" as const, authority: "github" as const, remediation: "auto-fix" as const, path: `docs/${name}.md`, line: 1, detail: "broken link", suggestion: { path: `docs/${name}.md`, before: "x", after: "y" } })));
  let writes = 0;
  const result = await applyActions(plan, { mode: "execute", budget: 1, applier: { apply: async () => { writes += 1; throw new Error("github_file_edit_validation_failed"); } } });
  assert.equal(writes, 1);
  assert.equal(result.budgetExceeded, true);
});

test("successful issue state changes followed by failed comments consume the issue budget", async () => {
  let writes = 0;
  const result = await applyIssueReconciliation([1, 2].map((number) => ({ type: "reopen" as const, fingerprint: String(number), issueNumber: number, title: null, body: "resolved" })), { mode: "execute", budget: 1, writer: { create: async () => ({ number: 3 }), setState: async () => { writes += 1; }, comment: async () => { throw new Error("comment failed"); } } });
  assert.equal(writes, 1);
  assert.equal(result.budgetExceeded, true);
});

test("zero CLI budgets stay zero and do not send mutations", async () => {
  const root = await repo();
  const exitCode = process.exitCode;
  let mutations = 0;
  try {
    const evidence = join(root, "report.json");
    await runCli({ argv: ["--mode", "weekly", "--root", root, "--apply-issues", "--mutation-budget", "0", "--issue-mutation-budget", "0", "--evidence", evidence], env: { GITHUB_REPOSITORY_OWNER: "o", GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "test" }, fetchImpl: (async (_input, init) => {
      if (init?.method === "POST") { mutations += 1; return Response.json({ number: 1 }); }
      return Response.json([]);
    }) as typeof fetch });
    const report = JSON.parse(await readFile(evidence, "utf8"));
    assert.equal(mutations, 0);
    assert.equal(report.applied.budget, 0);
    assert.equal(report.issueReconciliation.budget, 0);
    assert.equal(report.status, "incomplete");
    assert.equal(process.exitCode, 1);
  } finally { process.exitCode = exitCode; await rm(root, { recursive: true, force: true }); }
});

test("exhausted remediation does not advance success or authorize issue closure", async () => {
  const root = await repo();
  try {
    const report = await runControlLoop({ root, mode: "weekly", now, stateStore: new InMemoryStateStore(), headCommit: "new", issueSnapshot: { fetchedAt: now.toISOString(), issues: [] }, applyMode: "execute", mutationBudget: 0 });
    assert.equal(report.status, "incomplete");
    assert.equal(report.closure.allowed, false);
    assert.equal(report.watermark.lastScannedCommit, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the final closure decision reflects a reconciliation failure on a full healthy scan", async () => {
  const root = await repo();
  try {
    const report = await runControlLoop({ root, mode: "weekly", now, stateStore: new InMemoryStateStore(), issueSnapshot: { fetchedAt: now.toISOString(), issues: [] }, issueApplyMode: "execute", issueWriter: { create: async () => { throw new Error("github_issue_create_failed:403"); }, setState: async () => {}, comment: async () => {} } });
    assert.equal(report.status, "incomplete");
    assert.equal(report.closure.allowed, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid budgets fail closed at CLI and both mutation boundaries", async () => {
  for (const budget of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(applyActions([], { mode: "execute", budget }), /nonnegative_safe_integer/);
    await assert.rejects(applyIssueReconciliation([], { mode: "execute", budget }), /nonnegative_safe_integer/);
    await assert.rejects(runCli({ argv: ["--mode", "weekly", `--mutation-budget=${budget}`], env: {} }), /nonnegative_safe_integer/);
    await assert.rejects(runCli({ argv: ["--mode", "weekly", `--issue-mutation-budget=${budget}`], env: {} }), /nonnegative_safe_integer/);
  }
});

test("allowlisting refuses traversal and ambiguous path separators", () => {
  for (const path of ["docs/../src/file.ts", "docs/./A.md", "docs//A.md", "docs/..\\src/file.ts"]) {
    const findings = scanInternalLinks([{ path: "docs/source.md", text: "[a](missing/A.md)" }], { root: ".", files: [], paths: new Set(["docs/A.md"]) });
    findings[0]!.suggestion!.path = path;
    assert.equal(planActions(findings)[0]?.blockedReason, "edit_path_not_allowlisted");
  }
});

test("audit plan exists before any external write; a failed plan save blocks all writes", async () => {
  const root = await repo();
  try {
    for (const rejectPlan of [false, true]) {
      class Store extends InMemoryStateStore {
        override async write(key: string, value: string | null) {
          if (rejectPlan && key === "plan_weekly") throw new Error("storage unavailable");
          return super.write(key, value);
        }
      }
      const store = new Store();
      let calls = 0;
      const verifyPlan = async () => {
        const saved = JSON.parse((await store.read("plan_weekly"))!);
        assert.equal(saved.runId, "audit-plan-test");
        assert.ok(saved.plan.length > 0);
        assert.ok(saved.issuePlan.length > 0);
        calls += 1;
      };
      const report = await runControlLoop({ root, mode: "weekly", now, runId: "audit-plan-test", stateStore: store, issueSnapshot: { fetchedAt: now.toISOString(), issues: [] }, applyMode: "execute", applier: { apply: verifyPlan }, issueApplyMode: "execute", issueWriter: { create: async () => { await verifyPlan(); return { number: 1 }; }, setState: verifyPlan, comment: verifyPlan } });
      assert.equal(report.status, rejectPlan ? "failed" : "complete");
      assert.equal(calls > 0, !rejectPlan);
      if (rejectPlan) assert.ok(report.notes.some((note) => note.startsWith("plan_write_failed:")));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an earlier non-halting reconciliation failure blocks subsequent closure", async () => {
  let closes = 0;
  const result = await applyIssueReconciliation([
    { type: "create", fingerprint: "a", issueNumber: null, title: "a", body: "a" },
    { type: "close", fingerprint: "b", issueNumber: 1, title: null, body: "b" },
  ], { mode: "execute", budget: 5, writer: { create: async () => { throw new Error("github_issue_create_failed:500"); }, setState: async () => { closes += 1; }, comment: async () => {} } });
  assert.equal(closes, 0);
  assert.equal(result.outcomes[1]?.reason, "earlier_mutation_failed");
});

test("explicit execute without a configured writer or applier is incomplete", async () => {
  const root = await repo();
  try {
    for (const modes of [{ applyMode: "execute" as const }, { issueApplyMode: "execute" as const }]) {
      const report = await runControlLoop({ root, mode: "weekly", now, stateStore: new InMemoryStateStore(), issueSnapshot: { fetchedAt: now.toISOString(), issues: [] }, ...modes });
      assert.equal(report.status, "incomplete");
      assert.equal(report.closure.allowed, false);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("link resolution handles root paths and refuses ambiguous replacements", () => {
  assert.equal(resolveRelative("README.md", "A.md"), "A.md");
  assert.equal(resolveRelative("README.md", "."), null);
  assert.equal(resolveRelative("docs/A.md", ".."), null);
  const findings = scanInternalLinks([{ path: "docs/source.md", text: "[a](/missing/A.md)" }], { root: ".", files: [], paths: new Set(["docs/A.md", "docs/another/A.md"]) });
  assert.equal(findings[0]?.suggestion, null);
});

test("reconciliation retains stable ordering and handles pathless findings and duplicate history", () => {
  const source = scanInternalLinks([{ path: "docs/source.md", text: "[a](old/A.md)" }], { root: ".", files: [], paths: new Set() })[0]!;
  const findings = [{ ...source, fingerprint: "z", path: null, line: null }, { ...source, fingerprint: "a", line: null }];
  const actions = planIssueReconciliation({ findings, status: "complete", closureAllowed: true, snapshot: { fetchedAt: now.toISOString(), issues: [
    { number: 2, state: "open", title: "gone", fingerprint: "gone-z", labels: ["control-loop"] },
    { number: 3, state: "open", title: "gone", fingerprint: "gone-a", labels: ["control-loop"] },
    { number: 5, state: "open", title: "duplicate", fingerprint: "gone-a", labels: ["control-loop"] },
  ] } });
  assert.deepEqual(actions.map((action) => action.fingerprint), ["a", "z", "gone-a", "gone-z"]);
  assert.ok(actions[0]?.title?.endsWith("docs/source.md"));
  assert.ok(actions[1]?.title?.endsWith(source.subject));
  const reopened = planIssueReconciliation({ findings: [source], status: "complete", closureAllowed: false, snapshot: { fetchedAt: now.toISOString(), issues: [2, 1].map((number) => ({ number, state: "closed", title: "old", fingerprint: source.fingerprint, labels: ["control-loop"] })) } });
  assert.equal(reopened[0]?.issueNumber, 2);
  const reverse = planIssueReconciliation({ findings: [], status: "complete", closureAllowed: true, snapshot: { fetchedAt: now.toISOString(), issues: ["a", "z"].map((fingerprint, number) => ({ number, state: "open", title: "old", fingerprint, labels: ["control-loop"] })) } });
  assert.deepEqual(reverse.map((action) => action.fingerprint), ["a", "z"]);
});

test("invalid adapter budgets, auth refusal and failed watermark storage cannot report success", async () => {
  const root = await repo();
  try {
    for (const extra of [
      { mutationBudget: NaN },
      { issueMutationBudget: NaN },
      { applyMode: "execute" as const, applier: { apply: async () => { throw new Error("github_file_write_failed:403"); } } },
    ]) {
      const report = await runControlLoop({ root, mode: "weekly", now, stateStore: new InMemoryStateStore(), issueSnapshot: { fetchedAt: now.toISOString(), issues: [{ number: 10, state: "open", title: "resolved", fingerprint: "business-control-loop:strategy-engineering:gone#1234567890", labels: ["control-loop"] }] }, ...extra });
      assert.equal(report.status, "incomplete");
      assert.equal(report.closure.allowed, false);
    }
    class BrokenWatermarkStore extends InMemoryStateStore {
      override async writeIfVersion(key: string, value: string | null, expected: string | null) {
        if (key === "watermark") throw "storage unavailable";
        return super.writeIfVersion(key, value, expected);
      }
    }
    const report = await runControlLoop({ root, mode: "weekly", now, stateStore: new BrokenWatermarkStore(), issueSnapshot: { fetchedAt: now.toISOString(), issues: [] } });
    assert.equal(report.status, "incomplete");
    assert.ok(report.notes.includes("watermark_write_failed:storage unavailable"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
