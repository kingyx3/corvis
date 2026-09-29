/**
 * Typed errors for the browser-side API adapters. Screens map these to plain-language copy; raw
 * codes (`research_timeout`, `HTTP 500`) are never shown to users directly.
 */

/** A non-2xx API response. `message` keeps the historic "code: reason; reason" format. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** The session is missing or expired (HTTP 401): the user has to sign in again. */
export class UnauthenticatedError extends ApiError {
  constructor(message = "unauthenticated", code?: string) {
    super(message, 401, code ?? "unauthenticated");
    this.name = "UnauthenticatedError";
  }
}

/** A streaming response contained a line that is not valid JSON, or a shape we do not know. */
export class MalformedStreamError extends Error {
  constructor(message = "research_stream_malformed") {
    super(message);
    this.name = "MalformedStreamError";
  }
}

export function isUnauthenticatedError(value: unknown): value is UnauthenticatedError {
  return value instanceof UnauthenticatedError;
}

export const SESSION_EXPIRED_MESSAGE = "Your session has expired. Sign in again to continue.";

/** Fired on `window` whenever any API call reports an expired session, so the shell can prompt once. */
export const SESSION_EXPIRED_EVENT = "corvis:session-expired";

export function notifySessionExpired(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}

/** Plain-language text for an unexpected failure; falls back to `fallback` for code-like messages. */
export function friendlyErrorMessage(reason: unknown, fallback: string): string {
  if (isUnauthenticatedError(reason)) return SESSION_EXPIRED_MESSAGE;
  if (reason instanceof MalformedStreamError) return "The response was interrupted or unreadable. Try again.";
  if (!(reason instanceof Error) || !reason.message) return fallback;
  // Machine codes such as `pagination_cursor_cycle` or `request_failed: reason` are not user copy.
  if (/^[a-z][a-z0-9_]*(:|$)/.test(reason.message)) return fallback;
  return reason.message;
}
