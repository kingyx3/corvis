import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const COVERAGE_ROOTS = ["core/", "lib/", "control-loop/", "adapters/upload/"];
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

function git(args, options = {}) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", ...options }).trim();
}

function normalizeRepoPath(value) {
  const clean = value.replace(/^file:\/\//, "").split("?")[0];
  const absolute = path.isAbsolute(clean) ? clean : path.resolve(ROOT, clean);
  return path.relative(ROOT, absolute).split(path.sep).join("/");
}

function eligible(file) {
  return COVERAGE_ROOTS.some((root) => file.startsWith(root))
    && file.endsWith(".ts")
    && !file.endsWith(".d.ts")
    && !TEST_FILE.test(file)
    && !file.includes("/test-support/");
}

function coveragePercent(hit, found) {
  return found === 0 ? 100 : (hit / found) * 100;
}

function parseLcov(content) {
  const records = new Map();
  let current = null;
  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      current = { file: normalizeRepoPath(line.slice(3)), LF: 0, LH: 0, BRF: 0, BRH: 0, FNF: 0, FNH: 0 };
      continue;
    }
    if (!current) continue;
    if (line === "end_of_record") {
      const previous = records.get(current.file);
      if (previous) {
        for (const key of ["LF", "LH", "BRF", "BRH", "FNF", "FNH"]) previous[key] += current[key];
      } else records.set(current.file, current);
      current = null;
      continue;
    }
    for (const key of ["LF", "LH", "BRF", "BRH", "FNF", "FNH"]) {
      if (line.startsWith(`${key}:`)) current[key] = Number(line.slice(key.length + 1)) || 0;
    }
  }
  return records;
}

function eventBaseSha() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !existsSync(eventPath)) return null;
  try {
    const event = JSON.parse(readFileSync(eventPath, "utf8"));
    return event.pull_request?.base?.sha ?? event.before ?? null;
  } catch { return null; }
}

function ensureCommit(base) {
  try { git(["cat-file", "-e", `${base}^{commit}`]); return; }
  catch {
    if (!process.env.GITHUB_ACTIONS) throw new Error(`Coverage base commit ${base} is not available locally.`);
    git(["fetch", "--no-tags", "--depth=1", "origin", base], { stdio: ["ignore", "pipe", "pipe"] });
  }
}

function changedFiles() {
  let base = process.env.COVERAGE_BASE_REF?.trim() || eventBaseSha();
  if (!base) {
    try { base = git(["rev-parse", "HEAD^"]); }
    catch { return []; }
  }
  ensureCommit(base);
  return git(["diff", "--name-only", "--diff-filter=ACMR", base, "HEAD"])
    .split(/\r?\n/)
    .map((file) => file.trim().split(path.sep).join("/"))
    .filter(Boolean);
}

const lcovPath = process.argv[2] ?? ".coverage/lcov.info";
const records = parseLcov(readFileSync(lcovPath, "utf8"));
const changed = changedFiles().filter(eligible);
const failures = [];

for (const file of changed) {
  const coverage = records.get(file);
  if (!coverage) {
    failures.push(`${file}: changed production source is absent from the coverage report`);
    continue;
  }
  const metrics = [
    ["lines", coverage.LH, coverage.LF],
    ["branches", coverage.BRH, coverage.BRF],
    ["functions", coverage.FNH, coverage.FNF],
  ];
  for (const [label, hit, found] of metrics) {
    const percent = coveragePercent(hit, found);
    if (percent !== 100) failures.push(`${file}: ${label} ${hit}/${found} (${percent.toFixed(2)}%), required 100%`);
  }
}

if (failures.length > 0) {
  console.error("Changed-code coverage policy failed:\n" + failures.map((failure) => `- ${failure}`).join("\n"));
  process.exitCode = 1;
} else if (changed.length === 0) {
  console.log("Changed-code coverage policy: no eligible production files changed.");
} else {
  console.log(`Changed-code coverage policy: 100% lines/branches/functions for ${changed.length} changed production file(s): ${changed.join(", ")}`);
}
