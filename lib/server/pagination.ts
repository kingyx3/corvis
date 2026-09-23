/**
 * Opaque cursor pagination for `/api/v1` collection endpoints.
 *
 * The cursor encodes the sort key of the last item on the previous page.
 * Items are paginated in a caller-supplied stable order (by convention,
 * ascending by id) so a client walking pages sees each item exactly once
 * even if it does not know the underlying ordering, as long as that order
 * does not change between requests. A cursor's structure is validated on
 * decode so tampering with it fails the request rather than silently
 * returning the wrong page or crashing.
 */

export type Page<T> = {
  items: T[];
  nextCursor: string | null;
};

export class InvalidCursorError extends Error {
  constructor() {
    super("invalid_cursor");
    this.name = "InvalidCursorError";
  }
}

const CURSOR_SCHEMA_VERSION = 1;

export function encodeCursor(sortKey: string): string {
  const payload = JSON.stringify({ v: CURSOR_SCHEMA_VERSION, k: sortKey });
  return Buffer.from(payload, "utf8").toString("base64url");
}

/** Throws InvalidCursorError on any malformed, tampered or unsupported-version cursor. */
export function decodeCursor(cursor: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursorError();
  }
  if (
    !parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || (parsed as Record<string, unknown>).v !== CURSOR_SCHEMA_VERSION
    || typeof (parsed as Record<string, unknown>).k !== "string"
    || !(parsed as Record<string, unknown>).k
  ) {
    throw new InvalidCursorError();
  }
  return (parsed as { k: string }).k;
}

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

/**
 * Existing internal callers of these collection endpoints predate pagination
 * and expect the full, unpaginated list when they pass neither `limit` nor
 * `cursor`. Pagination only activates once a caller explicitly asks for it,
 * so this stays backward compatible without requiring every existing
 * caller to be updated first.
 */
export function paginationRequested(searchParams: URLSearchParams): boolean {
  return searchParams.has("limit") || searchParams.has("cursor");
}

export function parseLimit(raw: string | null, fallback = DEFAULT_PAGE_LIMIT): number {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new InvalidCursorError();
  return Math.min(value, MAX_PAGE_LIMIT);
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Paginates `items` in ascending `keyOf` order, starting just after
 * `cursor`'s sort key, if given. A cursor whose key no longer appears in
 * `items` (an already-consumed item was deleted, for example) still
 * paginates correctly: it starts from the first item whose key sorts after
 * the cursor rather than throwing or silently restarting from page one.
 *
 * The cursor contract ("every key after the cursor key") only holds when the
 * page walk is in the same order the cursor comparison uses, so this sorts a
 * copy by the key itself rather than trusting the caller's order. A caller
 * that passed rows in SQL `desc` order (or ordered by a different column than
 * its composite key) would otherwise loop forever or skip rows. The input
 * array is never mutated.
 */
export function paginate<T>(items: readonly T[], keyOf: (item: T) => string, limit: number, cursor?: string | null): Page<T> {
  const afterKey = cursor ? decodeCursor(cursor) : null;
  const ordered = items
    .map((item) => ({ item, key: keyOf(item) }))
    .sort((a, b) => compareKeys(a.key, b.key));
  const startIndex = afterKey === null ? 0 : ordered.findIndex((entry) => entry.key > afterKey);
  const remaining = startIndex === -1 ? [] : ordered.slice(startIndex).map((entry) => entry.item);
  const page = remaining.slice(0, limit);
  const hasMore = remaining.length > limit;
  return {
    items: page,
    nextCursor: hasMore ? encodeCursor(keyOf(page[page.length - 1]!)) : null,
  };
}
