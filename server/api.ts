import { assertInternalWorker, assertSameOrigin, requireSession } from "@/server/security";
import { json, noContent, problem, readJson, requestContext } from "@/server/http";
import {
  abortUpload,
  audit,
  bootstrapWorkspace,
  completeJob,
  completeUpload,
  createExport,
  createPartUrl,
  getSourceReference,
  initiateUpload,
  leaseJob,
  listDocuments,
  listObservations,
  publishSnapshot,
  readiness,
  retentionDeleteDocument,
  reviewObservation,
  uploadStatus,
} from "@/server/platform";
import { askCorvis } from "@/server/research";
import { execute, query } from "@/server/snowflake";

function segment(path: string[], index: number): string {
  return decodeURIComponent(path[index] || "");
}

function integer(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw Object.assign(new Error(`${name} must be an integer`), { status: 400, code: "VALIDATION_ERROR" });
  return parsed;
}

function stringValue(value: unknown, name: string, max = 1000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw Object.assign(new Error(`${name} is invalid`), { status: 400, code: "VALIDATION_ERROR" });
  return value.trim();
}

export async function handleV1(request: Request, path: string[]): Promise<Response> {
  const context = requestContext(request);
  try {
    const resource = segment(path, 0);
    const id = segment(path, 1);
    const action = segment(path, 2);

    if (resource === "internal" && id === "jobs") {
      assertInternalWorker(request);
      if (request.method === "POST" && action === "lease") {
        const body = await readJson<{ workerId?: string }>(request);
        const job = await leaseJob(stringValue(body.workerId, "workerId", 200));
        return json({ job }, {}, context.requestId);
      }
      const jobId = segment(path, 2);
      const jobAction = segment(path, 3);
      if (request.method === "POST" && jobId && jobAction === "complete") {
        const body = await readJson<{ status?: "SUCCEEDED" | "FAILED" | "RETRY"; error?: string }>(request);
        if (!body.status || !["SUCCEEDED", "FAILED", "RETRY"].includes(body.status)) throw Object.assign(new Error("Invalid job status"), { status: 400, code: "VALIDATION_ERROR" });
        await completeJob(jobId, { status: body.status, error: typeof body.error === "string" ? body.error.slice(0, 4000) : undefined });
        return noContent(context.requestId);
      }
      throw Object.assign(new Error("Internal endpoint not found"), { status: 404, code: "NOT_FOUND" });
    }

    assertSameOrigin(request);

    if (resource === "session" && request.method === "GET") {
      const session = requireSession(request);
      return json({ name: session.name, email: session.email, tenantId: session.tenantId, workspaceName: session.workspaceName, roles: session.roles }, {}, context.requestId);
    }

    if (resource === "bootstrap" && request.method === "GET") {
      const session = requireSession(request, "documents:read");
      return json(await bootstrapWorkspace(session), {}, context.requestId);
    }

    if (resource === "documents" && request.method === "GET" && !id) {
      const session = requireSession(request, "documents:read");
      return json({ items: await listDocuments(session) }, {}, context.requestId);
    }

    if (resource === "observations" && request.method === "GET" && !id) {
      const session = requireSession(request, "observations:read");
      return json({ items: await listObservations(session) }, {}, context.requestId);
    }

    if (resource === "observations" && id && action === "review" && request.method === "PATCH") {
      const session = requireSession(request, "observations:review");
      const body = await readJson<{ decision?: "approve" | "reject" | "correct"; correctedValue?: string; reason?: string }>(request);
      if (!body.decision || !["approve", "reject", "correct"].includes(body.decision)) throw Object.assign(new Error("Review decision is invalid"), { status: 400, code: "VALIDATION_ERROR" });
      await reviewObservation(session, id, { decision: body.decision, correctedValue: body.correctedValue, reason: body.reason?.slice(0, 2000) }, context.requestId);
      return noContent(context.requestId);
    }

    if (resource === "snapshots" && id && action === "publish" && request.method === "POST") {
      const session = requireSession(request, "snapshots:publish");
      await publishSnapshot(session, id, context.requestId);
      return noContent(context.requestId);
    }

    if (resource === "uploads" && id === "initiate" && request.method === "POST") {
      const session = requireSession(request, "documents:write");
      const body = await readJson<{ fileName?: string; contentType?: string; sizeBytes?: number; lastModified?: number }>(request, 50_000);
      const result = await initiateUpload(session, {
        fileName: stringValue(body.fileName, "fileName", 255),
        contentType: typeof body.contentType === "string" ? body.contentType.slice(0, 200) : undefined,
        sizeBytes: integer(body.sizeBytes, "sizeBytes"),
        lastModified: body.lastModified === undefined ? undefined : integer(body.lastModified, "lastModified"),
      }, request.headers.get("idempotency-key") || "", context.requestId);
      return json(result, { status: 201 }, context.requestId);
    }

    if (resource === "uploads" && id && request.method === "GET") {
      const session = requireSession(request, "documents:write");
      return json(await uploadStatus(session, id), {}, context.requestId);
    }

    if (resource === "uploads" && id && action === "parts" && request.method === "POST") {
      const session = requireSession(request, "documents:write");
      const body = await readJson<{ partNumber?: number; contentLength?: number }>(request, 20_000);
      return json(await createPartUrl(session, id, integer(body.partNumber, "partNumber"), integer(body.contentLength, "contentLength")), {}, context.requestId);
    }

    if (resource === "uploads" && id && action === "complete" && request.method === "POST") {
      const session = requireSession(request, "documents:write");
      const body = await readJson<{ parts?: Array<{ partNumber?: number; etag?: string }> }>(request, 500_000);
      if (!Array.isArray(body.parts) || body.parts.length > 10_000) throw Object.assign(new Error("parts is invalid"), { status: 400, code: "VALIDATION_ERROR" });
      const parts = body.parts.map((part) => ({ partNumber: integer(part.partNumber, "partNumber"), etag: stringValue(part.etag, "etag", 500).replaceAll('"', "") }));
      return json(await completeUpload(session, id, parts, context.requestId), {}, context.requestId);
    }

    if (resource === "uploads" && id && request.method === "DELETE") {
      const session = requireSession(request, "documents:write");
      await abortUpload(session, id, context.requestId);
      return noContent(context.requestId);
    }

    if (resource === "source-references" && id && request.method === "GET") {
      const session = requireSession(request, "source:read");
      return json(await getSourceReference(session, id, context.requestId), {}, context.requestId);
    }

    if (resource === "research" && request.method === "POST") {
      const session = requireSession(request, "research:ask");
      const body = await readJson<{ question?: string }>(request, 50_000);
      const question = stringValue(body.question, "question", 4000);
      const answer = await askCorvis(session, question);
      await audit(session, { action: "research.asked", resourceType: "research_query", resourceId: context.requestId, requestId: context.requestId, metadata: { citationCount: answer.citations.length, toolTrace: answer.toolTrace } });
      return json(answer, {}, context.requestId);
    }

    if (resource === "exports" && request.method === "POST") {
      const session = requireSession(request, "exports:create");
      const body = await readJson<{ snapshotId?: string; format?: "csv" | "json" }>(request, 20_000);
      const snapshotId = stringValue(body.snapshotId, "snapshotId", 200);
      if (body.format && !["csv", "json"].includes(body.format)) throw Object.assign(new Error("Export format is invalid"), { status: 400, code: "VALIDATION_ERROR" });
      return json(await createExport(session, { snapshotId, format: body.format }, context.requestId), { status: 201 }, context.requestId);
    }

    if (resource === "admin" && id === "readiness" && request.method === "GET") {
      const session = requireSession(request, "admin:read");
      return json(await readiness(session), {}, context.requestId);
    }

    if (resource === "admin" && id === "audit" && request.method === "GET") {
      const session = requireSession(request, "admin:read");
      const rows = await query<Record<string, string | null>>(
        `SELECT audit_event_id, actor_subject, actor_email, action, resource_type, resource_id, outcome, request_id, metadata,
                TO_VARCHAR(occurred_at) AS occurred_at
         FROM PM_CONTROL.AUDIT_EVENT WHERE tenant_id = ? ORDER BY occurred_at DESC LIMIT 500`,
        [session.tenantId],
        { tenantId: session.tenantId },
      );
      return json({ items: rows }, {}, context.requestId);
    }

    if (resource === "admin" && id === "entitlements" && request.method === "GET") {
      const session = requireSession(request, "admin:read");
      const rows = await query<Record<string, string | null>>(
        `SELECT entitlement_id, subject, resource_type, resource_id, permission, allowed, TO_VARCHAR(effective_from) AS effective_from,
                TO_VARCHAR(effective_to) AS effective_to
         FROM PM_CONTROL.ENTITLEMENT WHERE tenant_id = ? ORDER BY subject, resource_type, resource_id`,
        [session.tenantId],
        { tenantId: session.tenantId },
      );
      return json({ items: rows }, {}, context.requestId);
    }

    if (resource === "admin" && id === "entitlements" && request.method === "PUT") {
      const session = requireSession(request, "admin:write");
      const body = await readJson<{ entitlementId?: string; subject?: string; resourceType?: string; resourceId?: string; permission?: string; allowed?: boolean }>(request);
      const entitlementId = body.entitlementId ? stringValue(body.entitlementId, "entitlementId", 200) : `ent_${crypto.randomUUID()}`;
      const subject = stringValue(body.subject, "subject", 300);
      const resourceType = stringValue(body.resourceType, "resourceType", 100);
      const resourceId = stringValue(body.resourceId, "resourceId", 300);
      const permission = stringValue(body.permission, "permission", 100);
      const allowed = body.allowed !== false;
      await execute(
        `MERGE INTO PM_CONTROL.ENTITLEMENT target USING (SELECT ? entitlement_id, ? tenant_id) source
         ON target.tenant_id = source.tenant_id AND target.entitlement_id = source.entitlement_id
         WHEN MATCHED THEN UPDATE SET subject = ?, resource_type = ?, resource_id = ?, permission = ?, allowed = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP()
         WHEN NOT MATCHED THEN INSERT (entitlement_id, tenant_id, subject, resource_type, resource_id, permission, allowed, effective_from, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(), ?, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())`,
        [entitlementId, session.tenantId, subject, resourceType, resourceId, permission, allowed, session.subject,
         entitlementId, session.tenantId, subject, resourceType, resourceId, permission, allowed, session.subject],
        { tenantId: session.tenantId },
      );
      await audit(session, { action: "entitlement.upserted", resourceType: "entitlement", resourceId: entitlementId, requestId: context.requestId, metadata: { subject, resourceType, resourceId, permission, allowed } });
      return json({ entitlementId }, {}, context.requestId);
    }

    if (resource === "admin" && id === "documents" && action && segment(path, 3) === "delete" && request.method === "POST") {
      const session = requireSession(request, "admin:write");
      await retentionDeleteDocument(session, action, context.requestId);
      return noContent(context.requestId);
    }

    throw Object.assign(new Error("Endpoint not found"), { status: 404, code: "NOT_FOUND" });
  } catch (error) {
    return problem(error, context.requestId);
  }
}
