#!/usr/bin/env node
// Control-loop run entry point.
//
//   node control-loop/cli.ts --mode daily [--evidence report.json] [--apply]
//
// --mode selects the scheduler contract (daily/weekly/monthly/manual).
// Without --apply the run is dry-run: findings are scanned and classified but
// nothing is written back to GitHub or Confluence. --apply is accepted for
// forward compatibility with a future remediator; today no remediator is
// registered, so an automatic action still reports as skipped rather than
// silently mutating anything.
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { fetchIssueSnapshot } from "./github.ts";
import { runControlLoop } from "./orchestrator.ts";
import { FileStateStore } from "./state.ts";
import type { RunMode } from "./types.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string" },
    apply: { type: "boolean", default: false },
    evidence: { type: "string" },
    "mutation-budget": { type: "string", default: "20" },
    root: { type: "string", default: "." },
  },
});

const VALID_MODES: readonly RunMode[] = ["daily", "weekly", "monthly", "manual"];

function parseMode(value: string | undefined): RunMode {
  if (!value || !VALID_MODES.includes(value as RunMode)) {
    throw new Error(`--mode must be one of ${VALID_MODES.join(", ")}`);
  }
  return value as RunMode;
}

function changedPathsFromEnv(): string[] | null {
  const raw = process.env.CONTROL_LOOP_CHANGED_PATHS;
  if (!raw) return null;
  return raw.split("\n").map((line) => line.trim()).filter(Boolean);
}

async function run() {
  const mode = parseMode(values.mode);
  const stateStore = new FileStateStore(`${values.root}/control-loop/state`);

  const owner = process.env.GITHUB_REPOSITORY_OWNER;
  const repoFull = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const repo = repoFull?.split("/")[1];
  const issueSnapshot = owner && repo && token ? await fetchIssueSnapshot({ owner, repo, token }) : null;

  const report = await runControlLoop({
    root: values.root ?? ".",
    mode,
    now: new Date(),
    stateStore,
    changedPaths: changedPathsFromEnv(),
    issueSnapshot,
    applyMode: values.apply ? "execute" : "dry-run",
    mutationBudget: Number(values["mutation-budget"]) || 20,
  });

  const serialized = JSON.stringify(report, null, 2);
  if (values.evidence) await writeFile(values.evidence, `${serialized}\n`, "utf8");
  process.stdout.write(`${serialized}\n`);
  if (report.status === "failed") process.exitCode = 1;
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
