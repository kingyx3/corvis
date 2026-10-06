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
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateMutationBudget } from "./mutation-budget.ts";
import { createGitRunner, resolveChangedPaths } from "./changed-paths.ts";
import { createGitHubFileEditApplier, createGitHubIssueWriter, fetchIssueSnapshot } from "./github.ts";
import { runControlLoop } from "./orchestrator.ts";
import { resolveRunMode } from "./schedule.ts";
import { FileStateStore, GcsStateStore, type StateStore } from "./state.ts";
import { readWatermark } from "./watermark.ts";

export type CliArgs = {
  mode?: string;
  apply: boolean;
  "apply-issues": boolean;
  evidence?: string;
  "mutation-budget": string;
  "issue-mutation-budget": string;
  root: string;
};

export function parseCliArgs(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
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
  return values as CliArgs;
}

export function createStateStore(env: NodeJS.ProcessEnv, root: string, fetchImpl?: typeof fetch): { store: StateStore; durable: boolean } {
  const bucket = env.CONTROL_LOOP_STATE_BUCKET?.trim();
  if (!bucket) return { store: new FileStateStore(`${root}/services/control-loop/state`), durable: false };
  return {
    store: new GcsStateStore({
      bucket,
      prefix: env.CONTROL_LOOP_STATE_PREFIX?.trim() || "control-loop",
      fetchImpl,
    }),
    durable: true,
  };
}

/**
 * Everything the run depends on beyond the repository checkout itself: CLI
 * flags, environment, and the one shared `fetchImpl` threaded into every
 * GitHub/GCS adapter so a test can intercept the network without touching
 * global state. Omitted fields default to the real `process.argv`/`process.env`
 * and the platform `fetch`, exactly as running `node cli.ts` does.
 */
export type CliIO = {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
};

export async function runCli(io: CliIO = {}): Promise<void> {
  const argv = io.argv ?? process.argv.slice(2);
  const env = io.env ?? process.env;
  const fetchImpl = io.fetchImpl;

  const values = parseCliArgs(argv);
  const mode = resolveRunMode(values.mode);
  const mutationBudget = validateMutationBudget(Number(values["mutation-budget"]));
  const issueMutationBudget = validateMutationBudget(Number(values["issue-mutation-budget"]));
  const state = createStateStore(env, values.root, fetchImpl);

  // A daily incremental scan covers everything changed since the last
  // successfully scanned commit (not just the latest commit), diffed here with
  // git so non-ASCII paths and odd file names are handled verbatim. Any doubt
  // yields null changed paths, which the orchestrator turns into a full scan.
  const lastScannedCommit = await readWatermark(state.store).then((watermark) => watermark.lastScannedCommit ?? null, () => null);
  const { headCommit, changedPaths } = await resolveChangedPaths({ lastScannedCommit, git: createGitRunner(values.root) });

  const owner = env.GITHUB_REPOSITORY_OWNER;
  const repoFull = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  const repo = repoFull?.split("/")[1];
  const issueSnapshot = owner && repo ? await fetchIssueSnapshot({ owner, repo, token, fetchImpl }) : null;

  // Issue reconciliation can only ever execute (rather than dry-run) with
  // both an explicit --apply-issues opt-in and a real write-scoped token —
  // the production Cloud Scheduler job today passes neither, so it stays
  // read-only exactly as documented until that is a deliberate rollout step.
  const issueWriter = values["apply-issues"] && token && owner && repo
    ? createGitHubIssueWriter({ owner, repo, token, fetchImpl })
    : undefined;

  // Same opt-in shape as issueWriter: file-edit apply can only ever execute
  // (rather than dry-run) with both an explicit --apply flag and a real
  // write-scoped token. Mutating repo files and mutating GitHub issues are
  // independent blast radii with independent rollout timing, so this stays
  // its own opt-in even once --apply-issues is turned on elsewhere.
  const applier = values.apply && token && owner && repo
    ? createGitHubFileEditApplier({ owner, repo, token, fetchImpl })
    : undefined;

  const report = await runControlLoop({
    root: values.root,
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
    mutationBudget: mutationBudget,
    applier,
    issueApplyMode: issueWriter ? "execute" : "dry-run",
    issueMutationBudget: issueMutationBudget,
    issueWriter,
  });

  const serialized = JSON.stringify(report, null, 2);
  if (values.evidence) await writeFile(values.evidence, `${serialized}\n`, "utf8");
  if (state.durable) await state.store.write(`report_${mode}`, `${serialized}\n`);
  process.stdout.write(`${serialized}\n`);
  if (report.status !== "complete" && !report.skipped) process.exitCode = 1;
}

export function reportCliFailure(error: unknown): void {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}

// Compare resolved paths: an unrelated command also named cli.ts must not run us.
export function isInvokedDirectly(): boolean {
  return Boolean(process.argv[1]) && resolve(process.argv[1]!) === fileURLToPath(import.meta.url);
}

// A no-op when imported for its exports, so that importing this module never
// triggers a real, unconfigured run as a side effect.
export async function maybeRunAsCli(): Promise<void> {
  if (!isInvokedDirectly()) return;
  await runCli().catch(reportCliFailure);
}

await maybeRunAsCli();
