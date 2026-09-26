import { assertPermission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { getServerConfig } from "@/lib/server/config";
import { apiError, correlationId, json } from "@/lib/server/http";
import { postgres } from "@/lib/server/postgres";

export async function GET(request:Request){
  const id=correlationId(request);
  try{
    const identity=await resolveAuthorizedRequestIdentity(request);assertPermission(identity,"admin:manage");
    const operationsTenant=getServerConfig().operationsTenantId;if(!operationsTenant||identity.tenantId!==operationsTenant||!identity.roles.includes("admin"))return json({error:"operations_admin_required",correlationId:id},{status:403});
    const db=postgres(getServerConfig().postgresDsn);
    const rows=await db.query(`select t.tenant_id::text,t.display_name,
      (select count(*)::int from corvis_control.workspace w where w.tenant_id=t.tenant_id and w.status='active') as workspace_count,
      (select count(distinct m.user_id)::int from corvis_control.membership m where m.tenant_id=t.tenant_id and m.role_name='tenant_admin' and m.status='active' and m.valid_from<=now() and (m.valid_until is null or m.valid_until>now())) as tenant_admin_count,
      (select count(*)::int from corvis_control.support_access_grant s where s.tenant_id=t.tenant_id and s.status='active' and s.valid_from<=now() and s.valid_until>now() and s.revoked_at is null) as active_support_grants,
      (select count(*)::int from corvis_control.support_access_grant s where s.tenant_id=t.tenant_id and s.status='pending_ack' and s.valid_until>now()) as pending_support_acknowledgements,
      (select count(*)::int from corvis_control.tenant_invitation i where i.tenant_id=t.tenant_id and i.status='pending' and i.expires_at>now()) as pending_invitations
      from corvis_control.tenant t order by t.display_name,t.tenant_id`);
    return json({data:rows.map((row)=>({tenantId:String(row.tenant_id),tenantName:String(row.display_name??row.tenant_id),workspaceCount:Number(row.workspace_count??0),tenantAdminCount:Number(row.tenant_admin_count??0),activeSupportGrants:Number(row.active_support_grants??0),pendingSupportAcknowledgements:Number(row.pending_support_acknowledgements??0),pendingInvitations:Number(row.pending_invitations??0)})),correlationId:id});
  }catch(error){return apiError(error,id);}
}
