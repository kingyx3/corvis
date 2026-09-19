import { assertPermission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import { platform } from "@/lib/server/platform";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "reconciliations:read");
    const url = new URL(request.url);
    const snapshotId = url.searchParams.get("snapshotId") ?? "";
    const snapshotVersion = Number(url.searchParams.get("snapshotVersion"));
    if (!snapshotId || !Number.isInteger(snapshotVersion) || snapshotVersion <= 0) {
      return json({ error: "invalid_reconciliation_query", correlationId: id }, { status: 400 });
    }
    const data = await platform().listReconciliationExceptions(identity, snapshotId, snapshotVersion);
    return json({ data, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
