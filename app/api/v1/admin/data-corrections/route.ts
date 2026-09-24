import { randomUUID } from "crypto";
import { assertPermission, type RequestIdentity } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { getServerConfig } from "@/lib/server/config";
import { DataCorrectionRequestError, dataCorrectionRepository, PostgresDataCorrectionRepository } from "@/lib/server/data-correction";
import { readJsonObject } from "@/lib/server/admin-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import { PostgresOperationsRepository } from "@/lib/server/platform-repositories";
import { postgres, type PostgresSqlApi, withTransaction } from "@/lib/server/postgres";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function correctionError(error: unknown, id: string): Response {
  if (error instanceof DataCorrectionRequestError) return json({ error: error.code, correlationId: id }, { status: error.status });
  return apiError(error, id);
}

function audit(db: PostgresSqlApi, identity: RequestIdentity, id: string, action: string, incidentId: string, metadata: Record<string, string | number | boolean | null> = {}) {
  return new PostgresOperationsRepository(db).audit({
    id: randomUUID(), occurredAt: new Date().toISOString(), tenantId: identity.tenantId, workspaceId: identity.workspaceId,
    actorSubject: identity.subject, sessionId: identity.sessionId, action, targetType: "data_correction_incident",
    targetId: incidentId, outcome: "success", correlationId: id, metadata,
  });
}

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    return json({ data: await dataCorrectionRepository().list(identity), correlationId: id });
  } catch (error) { return correctionError(error, id); }
}

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    const body = await readJsonObject(request) as Record<string, unknown> | undefined;
    if (!body) return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    const action = String(body.action ?? "open");
    // Every mutation below and its audit event must commit or roll back
    // together, so a failed audit insert never leaves an unaudited data
    // correction command in place.
    const db = postgres(getServerConfig().postgresDsn);

    if (action === "open") {
      const data = await withTransaction(db, async (tx) => {
        const opened = await new PostgresDataCorrectionRepository(tx).open(identity, {
          idempotencyKey: String(body.idempotencyKey ?? ""), fundId: String(body.fundId ?? ""), reportPeriod: String(body.reportPeriod ?? ""),
          metricCode: typeof body.metricCode === "string" ? body.metricCode : undefined,
          snapshotId: typeof body.snapshotId === "string" ? body.snapshotId : undefined,
          snapshotVersion: typeof body.snapshotVersion === "number" ? body.snapshotVersion : undefined,
          documentId: typeof body.documentId === "string" ? body.documentId : undefined,
          rootCause: String(body.rootCause ?? ""), correctionIntent: String(body.correctionIntent ?? ""),
        });
        await audit(tx, identity, id, "data_correction.open", opened.incidentId, { state: opened.state });
        return opened;
      });
      return json({ data, correlationId: id }, { status: 201 });
    }

    const incidentId = String(body.incidentId ?? "");
    if (!UUID.test(incidentId)) return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    if (action === "replay") {
      const data = await withTransaction(db, async (tx) => {
        const replayed = await new PostgresDataCorrectionRepository(tx).replay(identity, incidentId);
        await audit(tx, identity, id, "data_correction.replay", incidentId, { jobId: replayed.jobId });
        return replayed;
      });
      return json({ data, correlationId: id }, { status: 202 });
    }
    if (action === "resolve") {
      const replacementSnapshotId = String(body.replacementSnapshotId ?? "");
      const replacementSnapshotVersion = Number(body.replacementSnapshotVersion ?? 0);
      if (!UUID.test(replacementSnapshotId) || !Number.isInteger(replacementSnapshotVersion) || replacementSnapshotVersion <= 0) {
        return json({ error: "invalid_request", correlationId: id }, { status: 400 });
      }
      const evidence = body.evidence && typeof body.evidence === "object" && !Array.isArray(body.evidence) ? body.evidence as Record<string, unknown> : {};
      await withTransaction(db, async (tx) => {
        await new PostgresDataCorrectionRepository(tx).resolve(identity, { incidentId, replacementSnapshotId, replacementSnapshotVersion, evidence });
        await audit(tx, identity, id, "data_correction.resolve", incidentId, { replacementSnapshotId, replacementSnapshotVersion });
      });
      return json({ data: { incidentId, state: "resolved" }, correlationId: id });
    }
    return json({ error: "invalid_request", correlationId: id }, { status: 400 });
  } catch (error) { return correctionError(error, id); }
}
