/**
 * The native driver returns timestamptz as Postgres text ("2026-09-29 10:11:12.123456+00") so keyset
 * cursors keep microsecond precision. API responses must carry RFC 3339 (`format: date-time`), so the
 * JSON boundary rewrites exactly that shape, losslessly: the space becomes "T", the fractional seconds
 * are kept as written and the offset is expanded ("+00" -> "Z", "+05:30" / "-08" -> "-08:00").
 * Any other string, including one that is already RFC 3339, is returned unchanged (#239).
 */
const POSTGRES_TIMESTAMPTZ = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)([+-])(\d{2})(?::?(\d{2}))?$/;

export function rfc3339FromPostgres(value: string): string {
  const match = POSTGRES_TIMESTAMPTZ.exec(value);
  if (!match) return value;
  const [, date, time, sign, hours, minutes = "00"] = match;
  const offset = hours === "00" && minutes === "00" ? "Z" : `${sign}${hours}:${minutes}`;
  return `${date}T${time}${offset}`;
}

/** `JSON.stringify` replacer applying `rfc3339FromPostgres` to every string value. */
export function rfc3339Replacer(_key: string, value: unknown): unknown {
  return typeof value === "string" ? rfc3339FromPostgres(value) : value;
}
