import { assertPermission } from "@/core/enterprise";
import { readJsonObject } from "@/lib/server/admin-request";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import { getWorkspacePersonalization, markWorkspaceVisited, normalizePinnedFundIds, updatePinnedFunds, WorkspacePersonalizationError } from "@/lib/server/workspace-personalization";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "observations:read");
    return json({ data: await getWorkspacePersonalization(identity), correlationId: id });
  } catch (error) { return apiError(error, id); }
}

export async function PUT(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "observations:read");
    const body = await readJsonObject(request);
    if (!body) return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    const pinnedFundIds = normalizePinnedFundIds(identity, body.pinnedFundIds);
    return json({ data: await updatePinnedFunds(identity, pinnedFundIds), correlationId: id });
  } catch (error) {
    if (error instanceof WorkspacePersonalizationError) return json({ error: error.code, correlationId: id }, { status: error.status });
    return apiError(error, id);
  }
}

/**
 * Explicit acknowledgement keeps GET /workspace-summary side-effect free. The
 * browser posts the summary's generatedAt only after it has successfully
 * rendered, so refreshes/retries cannot erase an unseen change digest.
 */
export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "observations:read");
    const body = await readJsonObject(request);
    if (!body || typeof body.seenAt !== "string") return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    const seenAt = new Date(body.seenAt);
    if (Number.isNaN(seenAt.getTime()) || seenAt.getTime() > Date.now() + 60_000) return json({ error: "invalid_seen_at", correlationId: id }, { status: 400 });
    const data = { lastSeenAt: await markWorkspaceVisited(identity, seenAt) };
    return json({ data, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
