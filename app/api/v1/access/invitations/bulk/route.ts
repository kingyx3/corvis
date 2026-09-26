import { assertPermission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { getServerConfig } from "@/lib/server/config";
import { apiError, correlationId, json } from "@/lib/server/http";
import { postgres, withTransaction } from "@/lib/server/postgres";
import { createTenantInvitation, normalizeTenantInvitation } from "@/lib/server/tenant-invitations";
import { parseBulkInviteCsv } from "@/lib/server/tenant-admin-self-service";

export async function POST(request:Request){
  const id=correlationId(request);
  try{
    const identity=await resolveAuthorizedRequestIdentity(request);assertPermission(identity,"admin:manage");if(identity.isTenantAdmin!==true)return json({error:"tenant_admin_required",correlationId:id},{status:403});
    const csv=await request.text();if(csv.length>1_000_000)return json({error:"csv_too_large",correlationId:id},{status:413});
    const parsed=parseBulkInviteCsv(csv);if(parsed.rows.length>500)return json({error:"too_many_rows",correlationId:id},{status:400});
    const db=postgres(getServerConfig().postgresDsn);const created:Array<Record<string,unknown>>=[];const errors=[...parsed.errors];
    for(const row of parsed.rows){
      const command=normalizeTenantInvitation({tenantId:identity.tenantId,workspaceId:row.workspaceId,email:row.email,roleName:row.roleName,reason:row.reason,confirmTenantAdmin:row.roleName==="tenant_admin"});
      if(!command){errors.push({row:row.row,error:"Invalid invitation"});continue;}
      try{const data=await withTransaction(db,(tx)=>createTenantInvitation(identity,command,`${id}:${row.row}`,tx));created.push({row:row.row,name:row.name,...data});}
      catch(error){errors.push({row:row.row,error:error instanceof Error?error.message:"Invitation failed"});}
    }
    return json({data:{created,errors,summary:{total:parsed.rows.length+parsed.errors.length,created:created.length,failed:errors.length}},correlationId:id},{status:errors.length&&created.length===0?422:201});
  }catch(error){return apiError(error,id);}
}
