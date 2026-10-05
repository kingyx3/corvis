import { randomUUID } from "crypto";
import { readJsonObject, resolveAdminRequestIdentity } from "@/platform/http/admin-request";
import { getServerConfig } from "@/platform/config/config";
import { apiError, correlationId, json } from "@/platform/http/http";
import { setFeatureFlag } from "@/modules/admin/server/feature-flags";
import { listFeatureFlags } from "@/platform/data/operations";
import { PostgresOperationsRepository } from "@/platform/data/platform-repositories";
import { postgres, withTransaction } from "@/platform/database/postgres";

export async function GET(request: Request) {
  const id = correlationId(request);
  try { const identity=await resolveAdminRequestIdentity(request); return json({data:await listFeatureFlags(identity),correlationId:id}); }
  catch(error){ return apiError(error,id); }
}

export async function PUT(request: Request) {
  const id = correlationId(request);
  try {
    const identity=await resolveAdminRequestIdentity(request);
    const body = await readJsonObject(request) as {key?:string;enabled?:boolean;config?:unknown;owner?:string;retireBy?:string} | undefined;
    if (!body) return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    if(typeof body.key!=="string" || !body.key || body.key.length>128 || typeof body.enabled!=="boolean") return json({error:"invalid_request",correlationId:id},{status:400});
    const metadata: Record<string,string|number|boolean|null> = { enabled: body.enabled };
    if (body.owner) metadata.owner = body.owner;
    if (body.retireBy) metadata.retireBy = body.retireBy;
    // The rollout write and its audit event must commit or roll back together,
    // so a failed audit insert never leaves an unaudited flag change in place.
    await withTransaction(postgres(getServerConfig().databaseDsn), async (tx) => {
      await setFeatureFlag(identity,{key:body.key as string,enabled:body.enabled as boolean,config:body.config,owner:body.owner,retireBy:body.retireBy},tx);
      await new PostgresOperationsRepository(tx).audit({id:randomUUID(),occurredAt:new Date().toISOString(),tenantId:identity.tenantId,workspaceId:identity.workspaceId,actorSubject:identity.subject,sessionId:identity.sessionId,action:"feature_flag.update",targetType:"feature_flag",targetId:body.key as string,outcome:"success",correlationId:id,metadata});
    });
    return json({data:{key:body.key,enabled:body.enabled},correlationId:id});
  } catch(error){ return apiError(error,id); }
}
