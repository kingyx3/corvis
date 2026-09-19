import { randomUUID } from "crypto";
import { assertPermission } from "@/core/enterprise";
import { apiError, correlationId, json } from "@/lib/server/http";
import { executeDeletionRequest } from "@/lib/server/operations";
import { platform } from "@/lib/server/platform";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";

export async function POST(request: Request, context: {params: Promise<{requestId:string}>}) {
  const id=correlationId(request);
  try {
    const identity=await resolveAuthorizedRequestIdentity(request); assertPermission(identity,"admin:manage");
    const {requestId}=await context.params; const evidence=await executeDeletionRequest(identity,requestId);
    await platform().audit({id:randomUUID(),occurredAt:new Date().toISOString(),tenantId:identity.tenantId,workspaceId:identity.workspaceId,actorSubject:identity.subject,sessionId:identity.sessionId,action:"deletion_request.execute",targetType:"deletion_request",targetId:requestId,outcome:"success",correlationId:id});
    return json({data:{requestId,state:"completed",evidence},correlationId:id});
  } catch(error){ return apiError(error,id); }
}
