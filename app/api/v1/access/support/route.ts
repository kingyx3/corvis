import { assertPermission } from "@/core/enterprise";
import { readJsonObject } from "@/lib/server/admin-request";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { getServerConfig } from "@/lib/server/config";
import { apiError, correlationId, json } from "@/lib/server/http";
import { postgres, withTransaction } from "@/lib/server/postgres";
import { acknowledgeSupportAccess, markTenantAccessNotificationsRead, tenantSupportAccessState } from "@/lib/server/tenant-admin-self-service";

export async function GET(request:Request){
  const id=correlationId(request);
  try{const identity=await resolveAuthorizedRequestIdentity(request);assertPermission(identity,"admin:manage");if(identity.isTenantAdmin!==true)return json({error:"tenant_admin_required",correlationId:id},{status:403});return json({data:await tenantSupportAccessState(identity),correlationId:id});}catch(error){return apiError(error,id);}
}

export async function POST(request:Request){
  const id=correlationId(request);
  try{
    const identity=await resolveAuthorizedRequestIdentity(request);assertPermission(identity,"admin:manage");if(identity.isTenantAdmin!==true)return json({error:"tenant_admin_required",correlationId:id},{status:403});
    const body=await readJsonObject(request) as Record<string,unknown>|undefined;if(!body)return json({error:"invalid_request",correlationId:id},{status:400});
    const db=postgres(getServerConfig().postgresDsn);
    if(body.action==="mark_read"){await markTenantAccessNotificationsRead(identity,db);return json({data:{ok:true},correlationId:id});}
    if(body.action==="acknowledge"&&typeof body.supportGrantId==="string"){
      await withTransaction(db,(tx)=>acknowledgeSupportAccess(identity,body.supportGrantId as string,id,tx));return json({data:{supportGrantId:body.supportGrantId,status:"active"},correlationId:id});
    }
    return json({error:"invalid_request",correlationId:id},{status:400});
  }catch(error){return apiError(error,id);}
}
