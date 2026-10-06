import type { IssueSnapshot, IssueSnapshotItem } from "./scanners/issue-hygiene.ts";
import type { IssueWriter } from "./issue-reconciliation.ts";
import type { EditApplier } from "./apply.ts";
import type { TextEdit } from "./types.ts";

/** Upper bound for any single GitHub API call so a hung connection cannot stall a control-loop run. */
export const GITHUB_REQUEST_TIMEOUT_MS = 15_000;
/** Hard page cap for the issue snapshot (per_page=100). Reaching it fails closed rather than truncating. */
export const ISSUE_SNAPSHOT_MAX_PAGES = 20;

const FINGERPRINT_LINE = /Finding fingerprint:\s*`([^`]+)`/;

type RawIssue = { number: number; state: string; title: string; body: string | null; labels: Array<string | { name?: string }> };

function labelNames(labels: RawIssue["labels"]): string[] {
  return labels.map((label) => (typeof label === "string" ? label : label.name ?? "")).filter(Boolean);
}

function extractFingerprint(body: string | null): string | null {
  if (!body) return null;
  const match = FINGERPRINT_LINE.exec(body);
  return match?.[1]?.trim() || null;
}

export type FetchIssuesOptions = {
  owner: string;
  repo: string;
  token?: string;
  label?: string;
  fetchImpl?: typeof fetch;
  /** Per-request timeout; defaults to GITHUB_REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Page cap (100 issues per page); defaults to ISSUE_SNAPSHOT_MAX_PAGES. */
  maxPages?: number;
};

/**
 * Reads every open and closed issue carrying the control-loop label. A token is
 * optional while the repository is public; when Corvis becomes private or the
 * loop gains write capability, a bounded managed GitHub credential is required.
 * Request failure, a request timeout, or a result set larger than the page cap
 * degrades to "issue hygiene unavailable this run" (null) instead of returning a
 * silently truncated snapshot that would make reconciliation open duplicates.
 */
export async function fetchIssueSnapshot(options: FetchIssuesOptions): Promise<IssueSnapshot | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const label = options.label ?? "control-loop";
  const timeoutMs = options.timeoutMs ?? GITHUB_REQUEST_TIMEOUT_MS;
  const maxPages = options.maxPages ?? ISSUE_SNAPSHOT_MAX_PAGES;
  const issues: IssueSnapshotItem[] = [];
  let complete = false;
  try {
    for (let page = 1; page <= maxPages; page += 1) {
      const url = `https://api.github.com/repos/${options.owner}/${options.repo}/issues`
        + `?state=all&labels=${encodeURIComponent(label)}&per_page=100&page=${page}`;
      const headers: Record<string, string> = {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "corvis-control-loop",
      };
      if (options.token) headers.authorization = `Bearer ${options.token}`;
      const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return null;
      const batch = await response.json() as RawIssue[];
      for (const raw of batch) {
        if ("pull_request" in (raw as unknown as Record<string, unknown>)) continue;
        issues.push({
          number: raw.number,
          state: raw.state === "closed" ? "closed" : "open",
          title: raw.title,
          fingerprint: extractFingerprint(raw.body),
          labels: labelNames(raw.labels),
        });
      }
      if (batch.length < 100) {
        complete = true;
        break;
      }
    }
  } catch {
    return null;
  }
  // The last allowed page was full: more issues may exist. Fail closed.
  if (!complete) return null;
  return { fetchedAt: new Date().toISOString(), issues };
}

export type GitHubIssueWriterOptions = {
  owner: string;
  repo: string;
  /** A managed credential scoped to issue write on this repository only. Required — this writer mutates state. */
  token: string;
  fetchImpl?: typeof fetch;
  /** Per-request timeout; defaults to GITHUB_REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
};

function githubHeaders(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "corvis-control-loop",
    authorization: `Bearer ${token}`,
  };
}

/**
 * The write counterpart to `fetchIssueSnapshot`: creates, closes, reopens and
 * comments on control-loop-labeled issues via the GitHub REST API. Kept as a
 * thin, directly-testable adapter behind the `IssueWriter` port so the
 * deterministic reconciliation logic in `issue-reconciliation.ts` never talks
 * to the network itself.
 */
export function createGitHubIssueWriter(options: GitHubIssueWriterOptions): IssueWriter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = `https://api.github.com/repos/${options.owner}/${options.repo}`;
  const headers = githubHeaders(options.token);
  const timeoutMs = options.timeoutMs ?? GITHUB_REQUEST_TIMEOUT_MS;

  return {
    async create(input) {
      const response = await fetchImpl(`${base}/issues`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ title: input.title, body: input.body, labels: input.labels }),
      });
      if (!response.ok) throw new Error(`github_issue_create_failed:${response.status}`);
      const created = await response.json() as { number: number };
      return { number: created.number };
    },
    async setState(issueNumber, state) {
      const response = await fetchImpl(`${base}/issues/${issueNumber}`, {
        method: "PATCH",
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ state }),
      });
      if (!response.ok) throw new Error(`github_issue_set_state_failed:${response.status}`);
    },
    async comment(issueNumber, body) {
      const response = await fetchImpl(`${base}/issues/${issueNumber}/comments`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ body }),
      });
      if (!response.ok) throw new Error(`github_issue_comment_failed:${response.status}`);
    },
  };
}

export type GitHubFileEditApplierOptions = {
  owner: string;
  repo: string;
  /** A managed credential scoped to repository contents write on this repository only. Required — this applier mutates files. */
  token: string;
  /** Branch to read and write; defaults to the repository's default branch. */
  branch?: string;
  fetchImpl?: typeof fetch;
  /** Per-request timeout; defaults to GITHUB_REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
};

/** Encodes each path segment separately so a literal "/" in `path` stays a path separator, not `%2F`. */
function contentsPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

type GitHubContentsResponse = { content: string; encoding: string; sha: string };

/**
 * The write counterpart to the allowlisted documentation-remediation plan
 * (`plan.ts`'s `auto-fix` actions): applies a single `TextEdit` to a
 * repository file via the GitHub Contents API with three independent
 * safeguards, matching the "optimistic version checks, bounded diffs and
 * post-write validation" the control loop's safety invariants require —
 *
 *  1. Optimistic version check: refuses to write unless the file's current
 *     content still matches `edit.before` exactly, so a human or another
 *     run editing the same file in between is never silently clobbered.
 *  2. Bounded diff: the write is exactly the plan's own before→after edit —
 *     never a regenerated or broader rewrite of the file.
 *  3. Post-write validation: re-reads the file after the commit and fails
 *     the action unless the committed content matches `edit.after` exactly.
 *
 * Kept as a thin, directly-testable adapter behind the `EditApplier` port
 * (see `apply.ts`), mirroring `createGitHubIssueWriter`. `apply.ts`'s own
 * budget/halt/skip bookkeeping around this stays untouched.
 */
export function createGitHubFileEditApplier(options: GitHubFileEditApplierOptions): EditApplier {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = `https://api.github.com/repos/${options.owner}/${options.repo}/contents`;
  const headers = githubHeaders(options.token);
  const timeoutMs = options.timeoutMs ?? GITHUB_REQUEST_TIMEOUT_MS;
  const query = options.branch ? `?ref=${encodeURIComponent(options.branch)}` : "";

  async function readFile(path: string): Promise<{ content: string; sha: string }> {
    const response = await fetchImpl(`${base}/${contentsPath(path)}${query}`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`github_file_read_failed:${response.status}`);
    const body = await response.json() as GitHubContentsResponse;
    if (body.encoding !== "base64") throw new Error("github_file_read_failed:unsupported_encoding");
    return { content: Buffer.from(body.content, "base64").toString("utf8"), sha: body.sha };
  }

  return {
    async apply(edit: TextEdit): Promise<void> {
      const before = await readFile(edit.path);
      if (before.content !== edit.before) throw new Error("github_file_edit_stale");

      const putBody: Record<string, unknown> = {
        message: `control-loop: allowlisted documentation remediation\n\nFile: ${edit.path}`,
        content: Buffer.from(edit.after, "utf8").toString("base64"),
        sha: before.sha,
      };
      if (options.branch) putBody.branch = options.branch;
      const putResponse = await fetchImpl(`${base}/${contentsPath(edit.path)}`, {
        method: "PUT",
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify(putBody),
      });
      if (!putResponse.ok) throw new Error(`github_file_write_failed:${putResponse.status}`);

      const after = await readFile(edit.path);
      if (after.content !== edit.after) throw new Error("github_file_edit_validation_failed");
    },
  };
}
