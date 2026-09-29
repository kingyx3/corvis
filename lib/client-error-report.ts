/**
 * Structured, PII-free client error events. Only fields that cannot carry user or tenant data are
 * included: the error class name, a machine-code message (never free text, which can embed row
 * values or identifiers), the Next.js digest, and where in the app it happened. Stack traces and
 * URLs with query strings are deliberately left out.
 */
export type ClientErrorSource = "error-boundary" | "view-boundary" | "global-error" | "window-error" | "unhandled-rejection";

export type ClientErrorEvent = {
  event: "corvis.client_error";
  source: ClientErrorSource;
  name: string;
  /** Present only when the message is a machine code such as `research_timeout`. */
  code?: string;
  digest?: string;
  /** Workspace view (from the URL hash) or a route path; never a query string. */
  view?: string;
  occurredAt: string;
};

const MACHINE_CODE = /^[a-z][a-z0-9_]{2,63}$/;
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export function buildClientErrorEvent(source: ClientErrorSource, error: unknown, context: { view?: string; now?: Date } = {}): ClientErrorEvent {
  const candidate = error instanceof Error ? error : undefined;
  const name = candidate && SAFE_NAME.test(candidate.name) ? candidate.name : "NonError";
  const event: ClientErrorEvent = { event: "corvis.client_error", source, name, occurredAt: (context.now ?? new Date()).toISOString() };
  if (candidate && MACHINE_CODE.test(candidate.message)) event.code = candidate.message;
  const digest = (candidate as (Error & { digest?: unknown }) | undefined)?.digest;
  if (typeof digest === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(digest)) event.digest = digest;
  if (context.view) event.view = context.view;
  return event;
}

function currentLocation(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const hash = /^#\/[a-z]+/.exec(window.location.hash)?.[0]?.slice(2);
  return hash ?? window.location.pathname;
}

/** Logs the structured event. Kept as the single sink so a collector can be attached in one place. */
export function reportClientError(source: ClientErrorSource, error: unknown, context: { view?: string } = {}): ClientErrorEvent {
  const event = buildClientErrorEvent(source, error, { view: context.view ?? currentLocation() });
  try {
    console.error("Corvis client error", event);
  } catch {
    // Reporting must never throw.
  }
  return event;
}
