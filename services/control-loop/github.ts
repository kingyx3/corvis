import type { IssueSnapshot, IssueSnapshotItem } from "./scanners/issue-hygiene.ts";
import type { IssueWriter } from "./issue-reconciliation.ts";

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
