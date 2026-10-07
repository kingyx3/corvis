import { recordResponseCorrelation } from "./request-correlation.ts";

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

/** The stable code of the 401 for a session the organization's sign-in policy ended (F7c, #336); distinct from `authentication_required`. */
export const SESSION_ENDED_BY_POLICY_CODE = "session_ended_by_policy";
export const SESSION_ENDED_BY_POLICY_MESSAGE = "Your session ended because of your organization's sign-in policy. Sign in again to continue.";

let endedByPolicy = false;

/** Whether the latest coded 401 said the organization's policy ended the session. Read by the shell banner, which renders after the event. */
export function sessionEndedByPolicy(): boolean { return endedByPolicy; }

/** The shell banner's words: the generic expiry, or why the organization's policy ended the session. */
export function sessionExpiredCopy(): { title: string; detail: string } {
  return endedByPolicy
    ? { title: "Your session ended by organization policy", detail: "Your organization's sign-in policy ended this session after a period of inactivity or its maximum length. Sign in again to continue. Data that was already saved is not affected." }
    : { title: "Your session has expired", detail: "Sign in again to continue. Data that was already saved is not affected." };
}

/** Fired on `window` whenever any API call reports an expired session, so the shell can prompt once. */
export const SESSION_EXPIRED_EVENT = "corvis:session-expired";

export function notifySessionExpired(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}

/**
 * The one place a 401 becomes "session expired": announces it to the shell (once per call, the shell
 * de-duplicates the prompt) and returns the typed error. `message` defaults to user-facing copy so raw
 * `fetch` callers that print `error.message` never show a code.
 */
export function sessionExpiredError(code?: string, message: string = code === SESSION_ENDED_BY_POLICY_CODE ? SESSION_ENDED_BY_POLICY_MESSAGE : SESSION_EXPIRED_MESSAGE): UnauthenticatedError {
  // A call that could not read the response body (no code) leaves what an earlier, coded 401 said; a coded one sets it.
  if (code !== undefined) endedByPolicy = code === SESSION_ENDED_BY_POLICY_CODE;
  notifySessionExpired();
  return new UnauthenticatedError(message, code);
}

/**
 * For raw `fetch` callers: throw the session-expired error if the response is a 401, before any other status handling.
 * Await it. It reads the stable reason code from a clone of the body (the caller still reads the original), so a session the
 * organization's policy ended is told apart from a plain expiry: the shell banner and `error.message` then say why.
 */
export async function throwIfUnauthenticated(response: { status: number; clone?: () => { json(): Promise<unknown> } }): Promise<void> {
  if (response.status !== 401) return;
  let code: string | undefined;
  try {
    const body = await response.clone?.().json() as { error?: unknown } | null;
    if (typeof body?.error === "string") code = body.error;
  } catch {
    // Not JSON, or the body was already consumed: treat it as an expiry without a stated reason.
  }
  throw sessionExpiredError(code);
}

/** Typed error for a non-2xx API response; a 401 additionally fires the session-expired flow. */
export async function apiResponseError(response: Response): Promise<ApiError> {
  const body = await response.json().catch(() => ({})) as { error?: string; reasons?: string[]; correlationId?: string };
  // Remembered so "Contact support" can quote the request that just failed (src/modules/support/domain/support.ts).
  recordResponseCorrelation(response.headers, body);
  const message = body.reasons?.length
    ? `${body.error || "request_failed"}: ${body.reasons.join("; ")}`
    : body.error || `Corvis API request failed (${response.status})`;
  if (response.status === 401) return sessionExpiredError(body.error, message);
  return new ApiError(message, response.status, body.error);
}

/** Plain-language text for an unexpected failure; falls back to `fallback` for code-like messages. */
export function friendlyErrorMessage(reason: unknown, fallback: string): string {
  if (isUnauthenticatedError(reason)) return reason.code === SESSION_ENDED_BY_POLICY_CODE ? SESSION_ENDED_BY_POLICY_MESSAGE : SESSION_EXPIRED_MESSAGE;
  if (reason instanceof MalformedStreamError) return "The response was interrupted or unreadable. Try again.";
  if (!(reason instanceof Error) || !reason.message) return fallback;
  // Machine codes such as `pagination_cursor_cycle` or `request_failed: reason` are not user copy.
  if (/^[a-z][a-z0-9_]*(:|$)/.test(reason.message)) return fallback;
  return reason.message;
}
