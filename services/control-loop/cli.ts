#!/usr/bin/env node
// Control-loop run entry point.
//
//   node services/control-loop/cli.ts --mode daily [--evidence report.json] [--apply]
//
// Cloud Run Job may also pass `monthly-candidate`; it resolves to monthly only
// on the first Asia/Singapore Sunday window and otherwise performs the weekly
// scan, preserving the documented scheduler contract.
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createGitRunner, resolveChangedPaths } from "./changed-paths.ts";
import { createGitHubIssueWriter, fetchIssueSnapshot } from "./github.ts";
import { runControlLoop } from "./orchestrator.ts";
import { resolveRunMode } from "./schedule.ts";
import { FileStateStore, GcsStateStore, type StateStore } from "./state.ts";
import { readWatermark } from "./watermark.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string" },
    apply: { type: "boolean", default: false },
    "apply-issues": { type: "boolean", default: false },
    evidence: { type: "string" },
    "mutation-budget": { type: "string", default: "20" },
    "issue-mutation-budget": { type: "string", default: "5" },
    root: { type: "string", default: "." },
  },
});

function createStateStore(): { store: StateStore; durable: boolean } {
  const bucket = process.env.CONTROL_LOOP_STATE_BUCKET?.trim();
  if (!bucket) return { store: new FileStateStore(`${values.root}/control-loop/state`), durable: false };
  return {
    store: new GcsStateStore({
      bucket,
      prefix: process.env.CONTROL_LOOP_STATE_PREFIX?.trim() || "control-loop",
    }),
    durable: true,
  };
}

async function run() {
  const mode = resolveRunMode(values.mode);
  const state = createStateStore();

  // A daily incremental scan covers everything changed since the last
  // successfully scanned commit (not just the latest commit), diffed here with
  // git so non-ASCII paths and odd file names are handled verbatim. Any doubt
  // yields null changed paths, which the orchestrator turns into a full scan.
  const lastScannedCommit = await readWatermark(state.store).then((watermark) => watermark.lastScannedCommit ?? null, () => null);
  const { headCommit, changedPaths } = await resolveChangedPaths({ lastScannedCommit, git: createGitRunner(values.root ?? ".") });

  const owner = process.env.GITHUB_REPOSITORY_OWNER;
  const repoFull = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const repo = repoFull?.split("/")[1];
  const issueSnapshot = owner && repo ? await fetchIssueSnapshot({ owner, repo, token }) : null;

  // Issue reconciliation can only ever execute (rather than dry-run) with
  // both an explicit --apply-issues opt-in and a real write-scoped token —
  // the production Cloud Scheduler job today passes neither, so it stays
  // read-only exactly as documented until that is a deliberate rollout step.
  const issueWriter = values["apply-issues"] && token && owner && repo
    ? createGitHubIssueWriter({ owner, repo, token })
    : undefined;

  const report = await runControlLoop({
    root: values.root ?? ".",
    mode,
    now: new Date(),
    stateStore: state.store,
    changedPaths,
    headCommit,
    issueSnapshot,
    // Without a credential, issue hygiene is best-effort (anonymous, rate
    // limited); a missing snapshot is then a skip, not a run failure.
    issueSnapshotRequired: Boolean(token),
    applyMode: values.apply ? "execute" : "dry-run",
    mutationBudget: Number(values["mutation-budget"]) || 20,
    issueApplyMode: issueWriter ? "execute" : "dry-run",
    issueMutationBudget: Number(values["issue-mutation-budget"]) || 5,
    issueWriter,
  });

  const serialized = JSON.stringify(report, null, 2);
  if (values.evidence) await writeFile(values.evidence, `${serialized}\n`, "utf8");
  if (state.durable) await state.store.write(`report_${mode}`, `${serialized}\n`);
  process.stdout.write(`${serialized}\n`);
  if (report.status === "failed") process.exitCode = 1;
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
