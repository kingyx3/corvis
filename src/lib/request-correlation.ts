/**
 * The correlation id of the most recent API response the browser received. The server stamps every
 * `/api/v1` response body with a `correlationId` (and echoes it in logs), so support can find the exact
 * server-side trail for what a user just saw. Only the id is kept: never the request, its payload or
 * the response, so nothing here can carry financial data.
 */

/** Log-safe token shape; mirrors the server's acceptance rule in `src/lib/server/http.ts`. */
const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

let latest: string | undefined;
const listeners = new Set<() => void>();

/** Remembers `candidate` as the latest request id; anything that is not a log-safe token is ignored. */
export function recordRequestCorrelationId(candidate: unknown): void {
  if (typeof candidate !== "string" || !CORRELATION_ID.test(candidate) || candidate === latest) return;
  latest = candidate;
  for (const listener of [...listeners]) listener();
}

/**
 * Records the id of one API response: the body's `correlationId` when it has one (every `/api/v1` envelope
 * and error body does), otherwise the `x-correlation-id` response header.
 */
export function recordResponseCorrelation(headers: Pick<Headers, "get">, body?: unknown): void {
  const fromBody = typeof body === "object" && body !== null ? (body as { correlationId?: unknown }).correlationId : undefined;
  recordRequestCorrelationId(fromBody ?? headers.get("x-correlation-id"));
}

export function latestRequestCorrelationId(): string | undefined {
  return latest;
}

/** `useSyncExternalStore`-compatible subscription, so a Contact support link follows the newest request. */
export function subscribeRequestCorrelation(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
