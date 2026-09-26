import { assertPermission } from "@/core/enterprise";
import { readJsonObject } from "@/lib/server/admin-request";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { getServerConfig } from "@/lib/server/config";
import { apiError, correlationId, json } from "@/lib/server/http";
import { postgres, withTransaction } from "@/lib/server/postgres";
import { resendTenantInvitation, revokeTenantInvitation } from "@/lib/server/tenant-admin-self-service";

export async function POST(request:Request,{params}:{params:Promise<{invitationId:string}>}){
  const id=correlationId(request);
  try{
    const identity=await resolveAuthorizedRequestIdentity(request);assertPermission(identity,"admin:manage");if(identity.isTenantAdmin!==true)return json({error:"tenant_admin_required",correlationId:id},{status:403});
    const body=await readJsonObject(request) as Record<string,unknown>|undefined;const {invitationId}=await params;const reason=typeof body?.reason==="string"?body.reason.trim():"";const db=postgres(getServerConfig().postgresDsn);
    if(body?.action==="revoke"){await withTransaction(db,(tx)=>revokeTenantInvitation(identity,invitationId,reason,id,tx));return json({data:{invitationId,status:"revoked"},correlationId:id});}
    if(body?.action==="resend"){const data=await withTransaction(db,(tx)=>resendTenantInvitation(identity,invitationId,reason,id,tx));return json({data,correlationId:id});}
    return json({error:"invalid_request",correlationId:id},{status:400});
  }catch(error){return apiError(error,id);}
}
