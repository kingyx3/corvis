import { assertPermission } from "@/core/enterprise";
import { listAuditRecords } from "@/lib/server/audit-query";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw == null ? undefined : Number(limitRaw);
    if (limitRaw != null && !Number.isFinite(limit)) {
      return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    }
    const data = await listAuditRecords(identity, {
      limit,
      action: url.searchParams.get("action") ?? undefined,
      actor: url.searchParams.get("actor") ?? undefined,
      targetType: url.searchParams.get("targetType") ?? undefined,
      outcome: url.searchParams.get("outcome") ?? undefined,
      after: url.searchParams.get("after") ?? undefined,
      before: url.searchParams.get("before") ?? undefined,
    });
    return json({ data, correlationId: id });
  } catch (error) {
    return apiError(error, id);
  }
}
