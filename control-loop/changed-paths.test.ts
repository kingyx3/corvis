import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createGitRunner, parseNulSeparatedPaths, resolveChangedPaths, type GitRunner } from "./changed-paths.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function fakeGit(handlers: Record<string, string | Error>): { git: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const git: GitRunner = async (args) => {
    calls.push(args);
    const key = args.includes("diff") ? "diff" : args[0];
    const result = handlers[key];
    if (result === undefined) throw new Error(`unexpected git ${args.join(" ")}`);
    if (result instanceof Error) throw result;
    return result;
  };
  return { git, calls };
}

test("parseNulSeparatedPaths keeps verbatim names, including EOF, newlines and non-ASCII", () => {
  assert.deepEqual(parseNulSeparatedPaths("EOF\0docs/café.md\0weird\nname.md\0"), ["EOF", "docs/café.md", "weird\nname.md"]);
  assert.deepEqual(parseNulSeparatedPaths(""), []);
});

test("resolveChangedPaths diffs lastScannedCommit..HEAD, not just the latest commit", async () => {
  const { git, calls } = fakeGit({ "rev-parse": `${SHA_B}\n`, "cat-file": "", "merge-base": "", diff: "a.md\0b.md\0" });
  const result = await resolveChangedPaths({ lastScannedCommit: SHA_A, git });
  assert.deepEqual(result, { headCommit: SHA_B, changedPaths: ["a.md", "b.md"], reason: "diff_since_last_scanned_commit" });
  const diff = calls.find((args) => args.includes("diff"));
  assert.deepEqual(diff, ["-c", "core.quotepath=off", "diff", "--name-only", "-z", "--no-renames", `${SHA_A}..${SHA_B}`]);
});

test("resolveChangedPaths returns null paths (full scan) whenever the range cannot be established", async () => {
  const noCommit = await resolveChangedPaths({ lastScannedCommit: null, git: fakeGit({ "rev-parse": SHA_B }).git });
  assert.deepEqual([noCommit.changedPaths, noCommit.headCommit, noCommit.reason], [null, SHA_B, "no_last_scanned_commit"]);

  const malformed = await resolveChangedPaths({ lastScannedCommit: "--output=/tmp/x", git: fakeGit({ "rev-parse": SHA_B }).git });
  assert.equal(malformed.changedPaths, null);
  assert.equal(malformed.reason, "last_scanned_commit_malformed");

  const unreachable = await resolveChangedPaths({ lastScannedCommit: SHA_A, git: fakeGit({ "rev-parse": SHA_B, "cat-file": new Error("missing") }).git });
  assert.equal(unreachable.changedPaths, null);
  assert.equal(unreachable.reason, "last_scanned_commit_unreachable");

  const diverged = await resolveChangedPaths({ lastScannedCommit: SHA_A, git: fakeGit({ "rev-parse": SHA_B, "cat-file": "", "merge-base": new Error("not ancestor") }).git });
  assert.equal(diverged.changedPaths, null);
  assert.equal(diverged.reason, "last_scanned_commit_not_ancestor_of_head");

  const noGit = await resolveChangedPaths({ lastScannedCommit: SHA_A, git: fakeGit({ "rev-parse": new Error("git: not found") }).git });
  assert.deepEqual(noGit, { headCommit: null, changedPaths: null, reason: "git_unavailable" });
});

test("resolveChangedPaths against a real repository covers several commits and unquoted non-ASCII paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "control-loop-git-"));
  try {
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" }).trim();
    const commit = async (path: string, message: string) => {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), `${message}\n`, "utf8");
      git("add", "-A");
      git("commit", "-q", "-m", message);
      return git("rev-parse", "HEAD");
    };
    git("init", "-q");
    const first = await commit("base.md", "base");
    await commit("docs/one.md", "one");
    await commit("docs/café.md", "two");
    const head = await commit("EOF", "three");

    const result = await resolveChangedPaths({ lastScannedCommit: first, git: createGitRunner(root) });
    assert.equal(result.headCommit, head);
    assert.deepEqual([...(result.changedPaths ?? [])].sort(), ["EOF", "docs/café.md", "docs/one.md"]);

    const upToDate = await resolveChangedPaths({ lastScannedCommit: head, git: createGitRunner(root) });
    assert.deepEqual(upToDate.changedPaths, []);

    const unknown = await resolveChangedPaths({ lastScannedCommit: SHA_A, git: createGitRunner(root) });
    assert.equal(unknown.changedPaths, null);
    assert.equal(unknown.headCommit, head);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
