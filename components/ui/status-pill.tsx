export type StatusPillTone = "neutral" | "info" | "success" | "warning" | "danger";

/** Documented status vocabulary. Unknown server-provided values deliberately fall back to neutral. */
export const STATUS_PILL_VOCABULARY = {
  Published: "success",
  Final: "success",
  Approved: "success",
  Complete: "success",
  Completed: "success",
  Ready: "success",
  Active: "success",
  Healthy: "success",
  Current: "success",
  Review: "warning",
  "Needs review": "warning",
  "Needs attention": "warning",
  Preliminary: "warning",
  Pending: "warning",
  Stale: "warning",
  Draft: "neutral",
  Queued: "neutral",
  Inactive: "neutral",
  "Not started": "neutral",
  Processing: "info",
  "In progress": "info",
  Derived: "info",
  Restated: "info",
  Normal: "info",
  Blocking: "danger",
  High: "danger",
  Failed: "danger",
  Error: "danger",
  Rejected: "danger",
  Unhealthy: "danger",
  Expired: "danger",
} as const satisfies Record<string, StatusPillTone>;

export type KnownStatusPill = keyof typeof STATUS_PILL_VOCABULARY;
export type StatusPillStatus = KnownStatusPill | (string & Record<never, never>);

function statusSlug(status: string): string {
  return status.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
}

export function statusPillTone(status: string): StatusPillTone {
  return Object.prototype.hasOwnProperty.call(STATUS_PILL_VOCABULARY, status)
    ? STATUS_PILL_VOCABULARY[status as KnownStatusPill]
    : "neutral";
}

export function StatusPill({ status }: { status: StatusPillStatus }) {
  const known = Object.prototype.hasOwnProperty.call(STATUS_PILL_VOCABULARY, status);
  const tone = statusPillTone(status);
  return <span className={`status-pill status-${known ? statusSlug(status) : "unknown"}`} data-tone={tone}><span className="status-dot" aria-hidden="true" />{status}</span>;
}
