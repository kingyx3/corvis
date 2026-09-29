import { workspaceContextHeaders } from "./workspace-context.ts";

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

const SOURCES: readonly ClientErrorSource[] = ["error-boundary", "view-boundary", "global-error", "window-error", "unhandled-rejection"];
const SAFE_VIEW = /^(?:[a-z]{1,40}|\/[A-Za-z0-9/_-]{0,120})$/;
const EVENT_KEYS = new Set(["event", "source", "name", "code", "digest", "view", "occurredAt"]);

/**
 * Server-side counterpart of `buildClientErrorEvent`: accepts only the exact PII-free shape (unknown keys,
 * free text or over-long values are rejected, not truncated), so the ingest endpoint cannot be used to write
 * arbitrary text into logs.
 */
export function parseClientErrorEvent(value: unknown): ClientErrorEvent | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (!Object.keys(input).every((key) => EVENT_KEYS.has(key))) return undefined;
  if (input.event !== "corvis.client_error" || !SOURCES.includes(input.source as ClientErrorSource)) return undefined;
  if (typeof input.name !== "string" || (input.name !== "NonError" && !SAFE_NAME.test(input.name))) return undefined;
  if (typeof input.occurredAt !== "string" || input.occurredAt.length > 40 || Number.isNaN(Date.parse(input.occurredAt))) return undefined;
  if (input.code !== undefined && (typeof input.code !== "string" || !MACHINE_CODE.test(input.code))) return undefined;
  if (input.digest !== undefined && (typeof input.digest !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(input.digest))) return undefined;
  if (input.view !== undefined && (typeof input.view !== "string" || !SAFE_VIEW.test(input.view))) return undefined;
  const event: ClientErrorEvent = { event: "corvis.client_error", source: input.source as ClientErrorSource, name: input.name, occurredAt: input.occurredAt };
  if (input.code !== undefined) event.code = input.code as string;
  if (input.digest !== undefined) event.digest = input.digest as string;
  if (input.view !== undefined) event.view = input.view as string;
  return event;
}

export const CLIENT_ERROR_ENDPOINT = "/api/v1/client-errors";

function apiBase(): string {
  return (process.env.NEXT_PUBLIC_CORVIS_API_BASE ?? "").replace(/\/$/, "");
}

/** Best-effort delivery to the ingest endpoint; never throws and never retries. */
function sendClientError(event: ClientErrorEvent): void {
  if (typeof window === "undefined" || typeof fetch !== "function") return;
  if (process.env.NEXT_PUBLIC_CORVIS_DEMO_MODE === "true") return;
  try {
    void fetch(`${apiBase()}${CLIENT_ERROR_ENDPOINT}`, {
      method: "POST",
      credentials: "include",
      keepalive: true,
      headers: { ...workspaceContextHeaders(), "content-type": "application/json" },
      body: JSON.stringify(event),
    }).catch(() => undefined);
  } catch {
    // Reporting must never throw.
  }
}

function currentLocation(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const hash = /^#\/[a-z]+/.exec(window.location.hash)?.[0]?.slice(2);
  return hash ?? window.location.pathname;
}

/**
 * The single client error sink: logs the structured event to the console and forwards it to the
 * authenticated ingest endpoint (`CLIENT_ERROR_ENDPOINT`), which writes it to the server logs.
 */
export function reportClientError(source: ClientErrorSource, error: unknown, context: { view?: string } = {}): ClientErrorEvent {
  const event = buildClientErrorEvent(source, error, { view: context.view ?? currentLocation() });
  try {
    console.error("Corvis client error", event);
  } catch {
    // Reporting must never throw.
  }
  sendClientError(event);
  return event;
}
