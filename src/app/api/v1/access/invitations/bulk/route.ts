import { assertPermission } from "@/core/enterprise";
import { readBoundedRequestText, RequestBodyTooLargeError } from "@/lib/server/bounded-body";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { getServerConfig } from "@/lib/server/config";
import { apiError, correlationId, json } from "@/lib/server/http";
import { postgres } from "@/lib/server/postgres";
import { createBulkInvitations, parseBulkInviteCsv } from "@/lib/server/tenant-admin-self-service";

const MAX_CSV_BYTES=1_000_000;

export async function POST(request:Request){
  const id=correlationId(request);
  try{
    const identity=await resolveAuthorizedRequestIdentity(request);assertPermission(identity,"admin:manage");if(identity.isTenantAdmin!==true)return json({error:"tenant_admin_required",correlationId:id},{status:403});
    let csv:string;
    try{csv=await readBoundedRequestText(request,MAX_CSV_BYTES);}
    catch(error){if(error instanceof RequestBodyTooLargeError)return json({error:"csv_too_large",correlationId:id},{status:413});throw error;}
    const parsed=parseBulkInviteCsv(csv);if(parsed.rows.length>500)return json({error:"too_many_rows",correlationId:id},{status:400});
    // Tenant-admin rows grant organization-wide administration: they are only invited when the caller explicitly confirms it for this request.
    const confirmTenantAdmin=new URL(request.url).searchParams.get("confirmTenantAdmin")==="true";
    const db=postgres(getServerConfig().postgresDsn);
    const {created,errors:rowErrors}=await createBulkInvitations(identity,parsed.rows,{confirmTenantAdmin,correlationId:id,db});const errors=[...parsed.errors,...rowErrors];
    return json({data:{created,errors,summary:{total:parsed.rows.length+parsed.errors.length,created:created.length,failed:errors.length}},correlationId:id},{status:errors.length&&created.length===0?422:201});
  }catch(error){return apiError(error,id);}
}
