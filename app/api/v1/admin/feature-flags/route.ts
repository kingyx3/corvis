import { randomUUID } from "crypto";
import { assertPermission } from "@/core/enterprise";
import { apiError, correlationId, json } from "@/lib/server/http";
import { setFeatureFlag } from "@/lib/server/feature-flags";
import { listFeatureFlags } from "@/lib/server/operations";
import { platform } from "@/lib/server/platform";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";

export async function GET(request: Request) {
  const id = correlationId(request);
  try { const identity=await resolveAuthorizedRequestIdentity(request); assertPermission(identity,"admin:manage"); return json({data:await listFeatureFlags(identity),correlationId:id}); }
  catch(error){ return apiError(error,id); }
}

export async function PUT(request: Request) {
  const id = correlationId(request);
  try {
    const identity=await resolveAuthorizedRequestIdentity(request); assertPermission(identity,"admin:manage");
    const body=await request.json() as {key?:string;enabled?:boolean;config?:unknown;owner?:string;retireBy?:string};
    if(!body.key || typeof body.enabled!=="boolean") return json({error:"invalid_request",correlationId:id},{status:400});
    await setFeatureFlag(identity,{key:body.key,enabled:body.enabled,config:body.config,owner:body.owner,retireBy:body.retireBy});
    await platform().audit({id:randomUUID(),occurredAt:new Date().toISOString(),tenantId:identity.tenantId,workspaceId:identity.workspaceId,actorSubject:identity.subject,sessionId:identity.sessionId,action:"feature_flag.update",targetType:"feature_flag",targetId:body.key,outcome:"success",correlationId:id,metadata:{enabled:body.enabled,owner:body.owner,retireBy:body.retireBy}});
    return json({data:{key:body.key,enabled:body.enabled},correlationId:id});
  } catch(error){ return apiError(error,id); }
}
