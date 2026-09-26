import { assertPermission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import { listTenantAccessAudit, tenantAccessAuditCsv } from "@/lib/server/tenant-admin-self-service";

export async function GET(request: Request) {
  const id=correlationId(request);
  try {
    const identity=await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity,"admin:manage");
    if(identity.isTenantAdmin!==true) return json({error:"tenant_admin_required",correlationId:id},{status:403});
    const events=await listTenantAccessAudit(identity);
    if(new URL(request.url).searchParams.get("format")==="csv") {
      return new Response(tenantAccessAuditCsv(events),{status:200,headers:{"content-type":"text/csv; charset=utf-8","content-disposition":"attachment; filename=corvis-access-audit.csv","cache-control":"no-store"}});
    }
    return json({data:events,correlationId:id});
  } catch(error) { return apiError(error,id); }
}
