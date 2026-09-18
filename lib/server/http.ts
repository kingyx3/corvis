import { AuthorizationError } from "@/core/enterprise";
import { AuthenticationError } from "@/lib/server/request-context";

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
  if (error instanceof AuthenticationError) return json({ error: "authentication_required", correlationId }, { status: 401 });
  if (error instanceof AuthorizationError) return json({ error: "forbidden", correlationId }, { status: 403 });
  console.error("corvis_api_error", { correlationId, error });
  return json({ error: "internal_error", correlationId }, { status: 500 });
}

export function correlationId(request: Request): string {
  return request.headers.get("x-correlation-id") || crypto.randomUUID();
}
