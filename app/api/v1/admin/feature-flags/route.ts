import { randomUUID } from "crypto";
import { assertPermission } from "@/core/enterprise";
import { apiError, correlationId, json } from "@/lib/server/http";
import { listFeatureFlags, setFeatureFlag } from "@/lib/server/operations";
import { platform } from "@/lib/server/platform";
import { resolveRequestIdentity } from "@/lib/server/request-context";

export async function GET(request: Request) {
  const id = correlationId(request);
  try { const identity=resolveRequestIdentity(request); assertPermission(identity,"admin:manage"); return json({data:await listFeatureFlags(identity),correlationId:id}); }
  catch(error){ return apiError(error,id); }
}

export async function PUT(request: Request) {
  const id = correlationId(request);
  try {
    const identity=resolveRequestIdentity(request); assertPermission(identity,"admin:manage");
    const body=await request.json() as {key?:string;enabled?:boolean;config?:unknown};
    if(!body.key || typeof body.enabled!=="boolean") return json({error:"invalid_request",correlationId:id},{status:400});
    await setFeatureFlag(identity,body.key,body.enabled,body.config);
    await platform().audit({id:randomUUID(),occurredAt:new Date().toISOString(),tenantId:identity.tenantId,workspaceId:identity.workspaceId,actorSubject:identity.subject,sessionId:identity.sessionId,action:"feature_flag.update",targetType:"feature_flag",targetId:body.key,outcome:"success",correlationId:id,metadata:{enabled:body.enabled}});
    return json({data:{key:body.key,enabled:body.enabled},correlationId:id});
  } catch(error){ return apiError(error,id); }
}
