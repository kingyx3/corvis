import { AuthorizationError } from "@/core/enterprise";
import { AuthenticationError } from "@/lib/server/request-context";
import { logEvent } from "@/lib/server/telemetry";

export function json(data: unknown, init: ResponseInit = {}): Response {
  return Response.json(data, {
    ...init,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...(init.headers || {}),
    },
  });
}

export function apiError(error: unknown, correlationId: string): Response {
  if (error instanceof AuthenticationError) {
    logEvent("warn", "api.authentication_denied", { correlationId });
    return json({ error: "authentication_required", correlationId }, { status: 401 });
  }
  if (error instanceof AuthorizationError) {
    logEvent("warn", "api.authorization_denied", { correlationId }, { requiredPermission: error.requiredPermission });
    return json({ error: "forbidden", correlationId }, { status: 403 });
  }
  logEvent("error", "api.unhandled_error", { correlationId }, { errorName: error instanceof Error ? error.name : "unknown", message: error instanceof Error ? error.message : "Unknown error" });
  return json({ error: "internal_error", correlationId }, { status: 500 });
}

export function correlationId(request: Request): string {
  return request.headers.get("x-correlation-id") || crypto.randomUUID();
}
