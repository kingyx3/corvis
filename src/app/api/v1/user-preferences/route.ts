import { resolveAuthorizedRequestIdentity } from "@/platform/http/identity/authorized-request";
import { readJsonObject } from "@/platform/http/identity/admin-request";
import { apiError, correlationId, json } from "@/platform/http/api/http";
import { getUserPreferences, saveDisplayPreferences, mutateSavedView, PreferenceError } from "@/modules/workspace/server/user-preferences";
export async function GET(request: Request) {
  const id = correlationId(request);
  try { const identity = await resolveAuthorizedRequestIdentity(request); return json({ data: await getUserPreferences(identity), correlationId: id }); } catch (error) { return apiError(error, id); }
}
export async function PUT(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request); const body = await readJsonObject(request);
    if (!body) throw new PreferenceError("invalid_request");
    return json({ data: await saveDisplayPreferences(identity, body.display), correlationId: id });
  } catch (error) { if (error instanceof PreferenceError || (error instanceof Error && error.message.startsWith("invalid_"))) return json({ error: error.message, correlationId: id }, { status: error instanceof PreferenceError ? error.status : 400 }); return apiError(error, id); }
}
export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request); const body = await readJsonObject(request);
    if (!body) throw new PreferenceError("invalid_request");
    return json({ data: await mutateSavedView(identity, body), correlationId: id });
  } catch (error) { if (error instanceof PreferenceError || (error instanceof Error && error.message.startsWith("invalid_"))) return json({ error: error.message, correlationId: id }, { status: error instanceof PreferenceError ? error.status : 400 }); return apiError(error, id); }
}
