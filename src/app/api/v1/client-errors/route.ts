import { parseClientErrorEvent } from "@/shared/lib/client-error-report";
import { readBoundedRequestText, RequestBodyTooLargeError } from "@/platform/http/bounded-body";
import { resolveAuthorizedRequestIdentity } from "@/platform/http/authorized-request";
import { apiError, correlationId, json } from "@/platform/http/http";
import { logEvent } from "@/platform/telemetry";

const MAX_BODY_BYTES = 2048;

/**
 * Client error ingest (#245). The browser posts the PII-free event built by `src/shared/lib/client-error-report.ts`;
 * it is accepted only in that exact shape and written to the server log, attributed to the authenticated
 * tenant and workspace. Authentication (and so the per-subject rate limit) is required, so the endpoint
 * cannot be used to write into logs anonymously.
 */
export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    let text: string;
    try { text = await readBoundedRequestText(request, MAX_BODY_BYTES); }
    catch (error) {
      if (error instanceof RequestBodyTooLargeError) return json({ error: "payload_too_large", correlationId: id }, { status: 413 });
      throw error;
    }
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = undefined; }
    const event = parseClientErrorEvent(body);
    if (!event) return json({ error: "invalid_client_error", correlationId: id }, { status: 400 });
    logEvent("warn", "client.error", { correlationId: id, tenantId: identity.tenantId, workspaceId: identity.workspaceId }, {
      source: event.source, errorName: event.name, code: event.code, digest: event.digest, view: event.view, clientOccurredAt: event.occurredAt,
    });
    return new Response(null, { status: 204, headers: { "x-correlation-id": id, "cache-control": "no-store" } });
  } catch (error) { return apiError(error, id); }
}
