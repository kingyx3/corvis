import { statusPillTone, statusSlug, isKnownStatusPill, type StatusPillStatus } from "./status-pill-logic.ts";

export type { StatusPillTone, KnownStatusPill, StatusPillStatus } from "./status-pill-logic.ts";
export { STATUS_PILL_VOCABULARY, statusPillTone, statusSlug } from "./status-pill-logic.ts";

export function StatusPill({ status }: { status: StatusPillStatus }) {
  const known = isKnownStatusPill(status);
  const tone = statusPillTone(status);
  return <span className={`status-pill status-${known ? statusSlug(status) : "unknown"}`} data-tone={tone}><span className="status-dot" aria-hidden="true" />{status}</span>;
}
