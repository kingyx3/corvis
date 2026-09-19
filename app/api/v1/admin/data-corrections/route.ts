import { assertPermission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { dataCorrectionRepository } from "@/lib/server/data-correction";
import { apiError, correlationId, json } from "@/lib/server/http";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    return json({ data: await dataCorrectionRepository().list(identity), correlationId: id });
  } catch (error) { return apiError(error, id); }
}

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action ?? "open");
    const repository = dataCorrectionRepository();

    if (action === "open") {
      const data = await repository.open(identity, {
        idempotencyKey: String(body.idempotencyKey ?? ""), fundId: String(body.fundId ?? ""), reportPeriod: String(body.reportPeriod ?? ""),
        metricCode: typeof body.metricCode === "string" ? body.metricCode : undefined,
        snapshotId: typeof body.snapshotId === "string" ? body.snapshotId : undefined,
        snapshotVersion: typeof body.snapshotVersion === "number" ? body.snapshotVersion : undefined,
        documentId: typeof body.documentId === "string" ? body.documentId : undefined,
        rootCause: String(body.rootCause ?? ""), correctionIntent: String(body.correctionIntent ?? ""),
      });
      return json({ data, correlationId: id }, { status: 201 });
    }

    const incidentId = String(body.incidentId ?? "");
    if (!UUID.test(incidentId)) return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    if (action === "replay") return json({ data: await repository.replay(identity, incidentId), correlationId: id }, { status: 202 });
    if (action === "resolve") {
      const replacementSnapshotId = String(body.replacementSnapshotId ?? "");
      const replacementSnapshotVersion = Number(body.replacementSnapshotVersion ?? 0);
      if (!UUID.test(replacementSnapshotId) || !Number.isInteger(replacementSnapshotVersion) || replacementSnapshotVersion <= 0) {
        return json({ error: "invalid_request", correlationId: id }, { status: 400 });
      }
      const evidence = body.evidence && typeof body.evidence === "object" && !Array.isArray(body.evidence) ? body.evidence as Record<string, unknown> : {};
      await repository.resolve(identity, { incidentId, replacementSnapshotId, replacementSnapshotVersion, evidence });
      return json({ data: { incidentId, state: "resolved" }, correlationId: id });
    }
    return json({ error: "invalid_request", correlationId: id }, { status: 400 });
  } catch (error) { return apiError(error, id); }
}
