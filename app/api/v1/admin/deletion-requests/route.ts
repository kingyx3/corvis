import { randomUUID } from "crypto";
import { assertPermission } from "@/core/enterprise";
import { apiError, correlationId, json } from "@/lib/server/http";
import { createDeletionRequest } from "@/lib/server/operations";
import { platform } from "@/lib/server/platform";
import { resolveRequestIdentity } from "@/lib/server/request-context";
import { snowflake } from "@/lib/server/snowflake";

export async function GET(request: Request) {
  const id=correlationId(request);
  try { const identity=resolveRequestIdentity(request); assertPermission(identity,"admin:manage"); const rows=await snowflake().query(`SELECT * FROM PM_CONTROL.DELETION_REQUEST WHERE TENANT_ID=? ORDER BY REQUESTED_AT DESC LIMIT 500`,[identity.tenantId]); return json({data:rows,correlationId:id}); }
  catch(error){ return apiError(error,id); }
}

export async function POST(request: Request) {
  const id=correlationId(request);
  try {
    const identity=resolveRequestIdentity(request); assertPermission(identity,"admin:manage");
    const body=await request.json() as {scope?:unknown;reason?:string};
    if(body.scope==null || !body.reason?.trim()) return json({error:"invalid_request",correlationId:id},{status:400});
    const requestId=await createDeletionRequest(identity,body.scope,body.reason.trim());
    await platform().audit({id:randomUUID(),occurredAt:new Date().toISOString(),tenantId:identity.tenantId,workspaceId:identity.workspaceId,actorSubject:identity.subject,sessionId:identity.sessionId,action:"deletion_request.create",targetType:"deletion_request",targetId:requestId,outcome:"success",correlationId:id});
    return json({data:{requestId,state:"requested"},correlationId:id},{status:201});
  } catch(error){ return apiError(error,id); }
}
