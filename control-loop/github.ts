import type { IssueSnapshot, IssueSnapshotItem } from "./scanners/issue-hygiene.ts";

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
};

/**
 * Reads every open and closed issue carrying the control-loop label. A token is
 * optional while the repository is public; when Corvis becomes private or the
 * loop gains write capability, a bounded managed GitHub credential is required.
 * Request failure degrades to "issue hygiene unavailable this run".
 */
export async function fetchIssueSnapshot(options: FetchIssuesOptions): Promise<IssueSnapshot | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const label = options.label ?? "control-loop";
  const issues: IssueSnapshotItem[] = [];
  try {
    for (let page = 1; page <= 20; page += 1) {
      const url = `https://api.github.com/repos/${options.owner}/${options.repo}/issues`
        + `?state=all&labels=${encodeURIComponent(label)}&per_page=100&page=${page}`;
      const headers: Record<string, string> = {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "corvis-control-loop",
      };
      if (options.token) headers.authorization = `Bearer ${options.token}`;
      const response = await fetchImpl(url, { headers });
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
      if (batch.length < 100) break;
    }
  } catch {
    return null;
  }
  return { fetchedAt: new Date().toISOString(), issues };
}
