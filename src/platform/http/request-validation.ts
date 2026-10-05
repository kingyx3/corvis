/**
 * Versions are Postgres `integer` columns; anything above 2^31-1 is malformed
 * input for a route to reject with 400, not an optimistic-concurrency conflict.
 */
export const MAX_VERSION = 2_147_483_647;

/** True for a string with at least one non-whitespace character. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
