import { assertPermission } from "@/shared/domain/enterprise";
import { readJsonObject } from "@/modules/identity-access/server/request/admin-request";
import { resolveAuthorizedRequestIdentity } from "@/modules/identity-access/server/request/authorized-request";
import { getServerConfig } from "@/platform/config/config";
import { apiError, correlationId, json } from "@/platform/http/api/http";
import { postgres, withTransaction } from "@/platform/database/postgres";
import { acknowledgeSupportAccess, markTenantAccessNotificationsRead, tenantSupportAccessState } from "@/modules/identity-access/server/tenants/tenant-admin-self-service";

export async function GET(request:Request){
  const id=correlationId(request);
  try{const identity=await resolveAuthorizedRequestIdentity(request);assertPermission(identity,"admin:manage");if(identity.isTenantAdmin!==true)return json({error:"tenant_admin_required",correlationId:id},{status:403});return json({data:await tenantSupportAccessState(identity),correlationId:id});}catch(error){return apiError(error,id);}
}

export async function POST(request:Request){
  const id=correlationId(request);
  try{
    const identity=await resolveAuthorizedRequestIdentity(request);assertPermission(identity,"admin:manage");if(identity.isTenantAdmin!==true)return json({error:"tenant_admin_required",correlationId:id},{status:403});
    const body=await readJsonObject(request) as Record<string,unknown>|undefined;if(!body)return json({error:"invalid_request",correlationId:id},{status:400});
    const db=postgres(getServerConfig().databaseDsn);
    if(body.action==="mark_read"){await markTenantAccessNotificationsRead(identity,db);return json({data:{ok:true},correlationId:id});}
    if(body.action==="acknowledge"&&typeof body.supportGrantId==="string"){
      await withTransaction(db,(tx)=>acknowledgeSupportAccess(identity,body.supportGrantId as string,id,tx));return json({data:{supportGrantId:body.supportGrantId,status:"active"},correlationId:id});
    }
    return json({error:"invalid_request",correlationId:id},{status:400});
  }catch(error){return apiError(error,id);}
}
