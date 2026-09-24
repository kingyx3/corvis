import { randomUUID } from "crypto";
import { assertPermission } from "@/core/enterprise";
import { readJsonObject } from "@/lib/server/admin-request";
import { getServerConfig } from "@/lib/server/config";
import { apiError, correlationId, json } from "@/lib/server/http";
import { createDeletionRequest, listDeletionRequests } from "@/lib/server/operations";
import { PostgresOperationsRepository } from "@/lib/server/platform-repositories";
import { postgres, withTransaction } from "@/lib/server/postgres";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";

export async function GET(request: Request) {
  const id=correlationId(request);
  try {
    const identity=await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity,"admin:manage");
    const rows=await listDeletionRequests(identity);
    return json({data:rows,correlationId:id});
  } catch(error){ return apiError(error,id); }
}

export async function POST(request: Request) {
  const id=correlationId(request);
  try {
    const identity=await resolveAuthorizedRequestIdentity(request); assertPermission(identity,"admin:manage");
    const body = await readJsonObject(request) as {scope?:unknown;reason?:unknown} | undefined;
    if (!body) return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    const reason=typeof body.reason==="string"?body.reason.trim():"";
    if(body.scope==null || !reason || reason.length>1000) return json({error:"invalid_request",correlationId:id},{status:400});
    // The request write and its audit event must commit or roll back
    // together, so a failed audit insert never leaves an unaudited deletion
    // request in place (and a retry cannot silently duplicate it).
    const requestId=await withTransaction(postgres(getServerConfig().postgresDsn), async (tx) => {
      const created=await createDeletionRequest(identity,body.scope,reason,tx);
      await new PostgresOperationsRepository(tx).audit({id:randomUUID(),occurredAt:new Date().toISOString(),tenantId:identity.tenantId,workspaceId:identity.workspaceId,actorSubject:identity.subject,sessionId:identity.sessionId,action:"deletion_request.create",targetType:"deletion_request",targetId:created,outcome:"success",correlationId:id});
      return created;
    });
    return json({data:{requestId,state:"requested"},correlationId:id},{status:201});
  } catch(error){ return apiError(error,id); }
}
