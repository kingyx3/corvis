/** Microsecond-precision UTC text of a timestamptz, the exact value a keyset cursor compares against (a JS Date would drop digits and skip or repeat rows). */
export function keysetTimestampSql(column: string): string {
  return `to_char(${column} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}
