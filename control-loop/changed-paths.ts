import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Runs `git <args>` in the repository root and resolves to stdout; rejects on a non-zero exit. */
export type GitRunner = (args: string[]) => Promise<string>;

// Full object names only (SHA-1 or SHA-256). Anything else, including an
// abbreviated sha or a value that could parse as a git option, is untrusted
// watermark content and degrades to a full scan.
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface ChangedPathsResult {
  /** The commit the scanned checkout is at, or null when git is unavailable. Recorded in the watermark on a successful run. */
  headCommit: string | null;
  /** Paths changed in `lastScannedCommit..HEAD`, or null when that range cannot be established (forces a full scan). */
  changedPaths: string[] | null;
  /** Why `changedPaths` is null (or a short description when it is not), for diagnostics. */
  reason: string;
}

export function createGitRunner(cwd: string): GitRunner {
  return async (args) => {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  };
}

/** Parses `git diff --name-only -z` output: NUL-terminated, verbatim paths (no quoting; newlines in names are safe). */
export function parseNulSeparatedPaths(raw: string): string[] {
  return raw.split("\0").filter((path) => path.length > 0);
}

/**
 * Resolves the paths changed since the last successfully scanned commit.
 * Any doubt (no recorded commit, malformed or unreachable sha, a commit that
 * is not an ancestor of HEAD such as after a force-push or a scan of another
 * branch, a shallow checkout, git missing) returns `changedPaths: null` so the
 * orchestrator falls back to a full scan instead of silently scanning less.
 */
export async function resolveChangedPaths(input: { lastScannedCommit: string | null | undefined; git: GitRunner }): Promise<ChangedPathsResult> {
  const { lastScannedCommit, git } = input;
  let headCommit: string;
  try {
    headCommit = (await git(["rev-parse", "HEAD"])).trim();
  } catch {
    return { headCommit: null, changedPaths: null, reason: "git_unavailable" };
  }
  if (!COMMIT_SHA.test(headCommit)) return { headCommit: null, changedPaths: null, reason: "git_head_unresolvable" };
  if (!lastScannedCommit) return { headCommit, changedPaths: null, reason: "no_last_scanned_commit" };
  if (!COMMIT_SHA.test(lastScannedCommit)) return { headCommit, changedPaths: null, reason: "last_scanned_commit_malformed" };
  try {
    await git(["cat-file", "-e", `${lastScannedCommit}^{commit}`]);
  } catch {
    return { headCommit, changedPaths: null, reason: "last_scanned_commit_unreachable" };
  }
  try {
    await git(["merge-base", "--is-ancestor", lastScannedCommit, headCommit]);
  } catch {
    return { headCommit, changedPaths: null, reason: "last_scanned_commit_not_ancestor_of_head" };
  }
  try {
    // core.quotepath=off plus -z keeps non-ASCII paths verbatim so they match
    // snapshot paths; --no-renames lists both sides of a rename.
    const raw = await git(["-c", "core.quotepath=off", "diff", "--name-only", "-z", "--no-renames", `${lastScannedCommit}..${headCommit}`]);
    return { headCommit, changedPaths: parseNulSeparatedPaths(raw), reason: "diff_since_last_scanned_commit" };
  } catch {
    return { headCommit, changedPaths: null, reason: "git_diff_failed" };
  }
}
