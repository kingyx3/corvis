/**
 * "Received" / "last changed" values reach the browser either as machine timestamps (the Postgres platform) or as
 * human labels ("Just now" for an upload completed this session, demo labels such as "18 Sep, 08:31"). Only an
 * ISO-shaped timestamp is parsed: `new Date("18 Sep, 08:31")` happily yields the year 2001.
 */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const JUST_NOW = "Just now";

function timestampMs(value: string): number | undefined {
  if (!TIMESTAMP.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Formats machine timestamps with `format`; any other label is shown exactly as given. */
export function formatReceivedTime(value: string, format: (timestamp: string) => string): string {
  return timestampMs(value) === undefined ? value : format(value);
}

/** Newest first: this session's uploads, then real timestamps by time, then other labels as plain text. */
export function compareReceivedNewestFirst(a: string, b: string): number {
  const rank = (value: string, ms: number | undefined) => value === JUST_NOW ? 2 : ms === undefined ? 0 : 1;
  const msA = timestampMs(a);
  const msB = timestampMs(b);
  const rankA = rank(a, msA);
  const rankB = rank(b, msB);
  if (rankA !== rankB) return rankB - rankA;
  if (msA !== undefined && msB !== undefined) return msB - msA;
  return b.localeCompare(a);
}
