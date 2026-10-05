import { resolveAuthorizedRequestIdentity } from "@/platform/http/authorized-request";
import { apiError, correlationId, json } from "@/platform/http/http";
import { captureVerifiedRecipient } from "@/modules/notifications/server/notifications";
import { logEvent } from "@/platform/observability/telemetry";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    // The app calls /me on every load, so this keeps the notification address in
    // step with the verified identity claim. Best effort: never fails the request.
    await captureVerifiedRecipient(identity).catch((error: unknown) => logEvent("warn", "notifications.recipient_capture_failed", { correlationId: id, tenantId: identity.tenantId }, { errorName: error instanceof Error ? error.name : typeof error }));
    return json({
      data: {
        subject: identity.subject,
        tenantId: identity.tenantId,
        workspaceId: identity.workspaceId,
        roles: identity.roles,
        entitlements: identity.entitlements,
        tenantDisplayName: identity.tenantDisplayName,
        workspaceDisplayName: identity.workspaceDisplayName,
        tenantAdmin: identity.isTenantAdmin === true,
      },
      correlationId: id,
    });
  } catch (error) { return apiError(error, id); }
}
