const GITHUB_STATUS_SUFFIX = /^github_[a-z_]+_failed:(\d{3})$/;
/** Auth and rate-limit responses: every further write in the run would fail the same way. */
const HALTING_STATUSES = new Set([401, 403, 429]);

export interface ClassifiedFailure {
  /** Stable, report-friendly reason, e.g. `github_403` or `error:<message>`. */
  reason: string;
  /** True when continuing to mutate in this run is pointless or harmful (auth / rate limit). */
  halt: boolean;
}

/**
 * Turns a thrown writer/applier error into a recordable outcome reason. The
 * GitHub writer throws `github_issue_*_failed:<status>`; those map to
 * `github_<status>`, and 401/403/429 additionally halt further mutation.
 */
export function classifyFailure(error: unknown): ClassifiedFailure {
  const message = error instanceof Error ? error.message : String(error);
  const match = GITHUB_STATUS_SUFFIX.exec(message);
  if (match) {
    const status = Number(match[1]);
    return { reason: `github_${status}`, halt: HALTING_STATUSES.has(status) };
  }
  return { reason: `error:${message}`.slice(0, 200), halt: false };
}
