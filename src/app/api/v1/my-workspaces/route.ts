import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { getServerConfig } from "@/lib/server/config";
import { apiError, correlationId, json } from "@/lib/server/http";
import { postgres } from "@/lib/server/postgres";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    const memberships=identity.workspaceMemberships ?? [];
    if(identity.authMethod==="demo"||identity.authMethod==="service_account") return json({data:memberships,correlationId:id});
    const db=postgres(getServerConfig().postgresDsn);
    const grants=await db.query(`select support_grant_id::text,workspace_id::text,role_name,purpose,valid_until
      from corvis_control.support_access_grant where tenant_id=$1::uuid and subject=$2 and status='active'
        and valid_from<=now() and valid_until>now() and revoked_at is null`,[identity.tenantId,identity.subject]);
    const byWorkspace=new Map(grants.map((row)=>[String(row.workspace_id),{supportGrantId:String(row.support_grant_id),roleName:String(row.role_name),purpose:String(row.purpose),expiresAt:String(row.valid_until)}]));
    return json({data:memberships.map((membership)=>({...membership,supportAccess:byWorkspace.get(membership.workspaceId)})),correlationId:id});
  } catch (error) { return apiError(error, id); }
}
