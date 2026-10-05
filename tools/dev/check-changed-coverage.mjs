import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const COVERAGE_ROOTS = ["core/", "lib/", "services/control-loop/", "adapters/upload/"];
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

// A restructuring PR renames files and rewrites the references to them. Such edits move code; they do
// not change what it does, so they must not be held to the 100% changed-code bar that guards new logic.
// Two kinds of edit are recognised, and nothing else:
//   1. module specifiers (`from "…"`, `import("…")`, `new URL("…", import.meta.url)`), which are
//      replaced by a placeholder before comparing; and
//   2. path strings that name a file (or a whole directory) the same diff moved, which are rewritten to
//      their new location in the old text before comparing.
// A file counts as unchanged only when the two normalised versions are identical.
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\(\s*|\bnew URL\(\s*|\bregister\(\s*)(["'])[^"'\n]+\2/g;
const PATH_START = "(?<![\\w./@-])";

function normalizeSpecifiers(source) {
  return source.replace(SPECIFIER, "$1$2<specifier>$2");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A directory is rewritten only when every file that lived in it at `base` moved together to one new
// location, so a partial move can never make an unrelated path look like a rename.
function movedDirectories(renames, baseFiles) {
  const targets = new Map();
  const counts = new Map();
  for (const [from, to] of renames) {
    const fromParts = from.split("/");
    const toParts = to.split("/");
    for (let depth = fromParts.length - 1; depth >= 1; depth -= 1) {
      const suffix = fromParts.slice(depth).join("/");
      if (!to.endsWith(`/${suffix}`) && to !== suffix) break;
      const fromDirectory = fromParts.slice(0, depth).join("/");
      const toDirectory = toParts.slice(0, toParts.length - (fromParts.length - depth)).join("/");
      if (!targets.has(fromDirectory)) targets.set(fromDirectory, new Set());
      targets.get(fromDirectory).add(toDirectory);
      counts.set(fromDirectory, (counts.get(fromDirectory) ?? 0) + 1);
    }
  }
  const directories = new Map();
  for (const [directory, destinations] of targets) {
    if (destinations.size !== 1) continue;
    const inBase = baseFiles.filter((file) => file.startsWith(`${directory}/`)).length;
    if (inBase > 0 && inBase === counts.get(directory)) directories.set(directory, [...destinations][0]);
  }
  return directories;
}

function buildPathRewriter(renames, baseFiles) {
  const files = new Map(renames);
  const directories = movedDirectories(renames, baseFiles);
  const fileRe = files.size ? new RegExp(`${PATH_START}(${[...files.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|")})(?![A-Za-z0-9_])`, "g") : null;
  const dirRe = directories.size ? new RegExp(`${PATH_START}(${[...directories.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|")})(?=/)`, "g") : null;
  return (text) => {
    if (fileRe) text = text.replace(fileRe, (match) => files.get(match));
    if (dirRe) text = text.replace(dirRe, (match) => directories.get(match));
    return text;
  };
}

function normalize(source, rewritePaths) {
  return normalizeSpecifiers(rewritePaths(source.replace(/\r?\n$/, "")));
}

function isPureMove(base, previousPath, currentPath, rewritePaths) {
  try {
    const before = git(["show", `${base}:${previousPath}`], { stdio: ["ignore", "pipe", "ignore"] });
    const after = readFileSync(path.resolve(ROOT, currentPath), "utf8");
    return normalize(before, rewritePaths) === normalizeSpecifiers(after.replace(/\r?\n$/, ""));
  } catch { return false; }
}

function changedFiles() {
  let base = process.env.COVERAGE_BASE_REF?.trim() || eventBaseSha();
  if (!base) {
    try { base = git(["rev-parse", "HEAD^"]); }
    catch { return []; }
  }
  ensureCommit(base);
  const entries = git(["diff", "--name-status", "--find-renames=30%", base, "HEAD"])
    .split(/\r?\n/)
    .map((line) => line.split("\t"))
    .filter((parts) => parts.length >= 2);
  const renames = entries
    .filter(([status]) => status.startsWith("R"))
    .map(([, from, to]) => [from.trim(), to.trim()]);
  const baseFiles = git(["ls-tree", "-r", "--name-only", base]).split(/\r?\n/).filter(Boolean);
  const rewritePaths = buildPathRewriter(renames, baseFiles);
  const changed = [];
  for (const [status, first, second] of entries) {
    if (!/^[ACMR]/.test(status)) continue;
    const current = (second ?? first).trim().split(path.sep).join("/");
    const previous = first.trim();
    if ((status.startsWith("R") || status === "M") && isPureMove(base, previous, current, rewritePaths)) continue;
    changed.push(current);
  }
  return changed.filter(Boolean);
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
