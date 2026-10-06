import { readJsonObject } from "@/platform/http/identity/admin-request";
import { resolveAuthorizedRequestIdentity } from "@/platform/http/identity/authorized-request";
import { apiError, correlationId, json } from "@/platform/http/api/http";
import { getNotificationSettings, NotificationPreferenceError, updateNotificationPreferences } from "@/modules/notifications/server/notifications";

/**
 * The signed-in person's own email notification settings. Any authenticated
 * human may read and change their own; which categories appear depends on
 * their current role, and mandatory security notices cannot be turned off.
 */
export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    return json({ data: await getNotificationSettings(identity), correlationId: id });
  } catch (error) {
    if (error instanceof NotificationPreferenceError) return json({ error: error.code, correlationId: id }, { status: error.status });
    return apiError(error, id);
  }
}

export async function PUT(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    const body = await readJsonObject(request);
    if (!body) return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    return json({ data: await updateNotificationPreferences(identity, body), correlationId: id });
  } catch (error) {
    if (error instanceof NotificationPreferenceError) return json({ error: error.code, correlationId: id }, { status: error.status });
    return apiError(error, id);
  }
}
