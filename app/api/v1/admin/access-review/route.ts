import { assertPermission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { getServerConfig } from "@/lib/server/config";
import { apiError, correlationId, json } from "@/lib/server/http";
import { postgres } from "@/lib/server/postgres";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    const db = postgres(getServerConfig().postgresDsn);
    const [memberships, entitlements, rights, serviceGrants, supportGrants] = await Promise.all([
      db.query(`select s.subject,s.auth_method,s.user_id::text,s.status as subject_status,
          m.workspace_id::text,w.display_name as workspace_name,m.role_name,m.status as membership_status,
          m.valid_from,m.valid_until
        from corvis_control.identity_subject s
        left join corvis_control.membership m
          on m.tenant_id=s.tenant_id and m.user_id=s.user_id
        left join corvis_control.workspace w
          on w.tenant_id=m.tenant_id and w.workspace_id=m.workspace_id
        where s.tenant_id=$1
        order by s.subject,m.workspace_id,m.role_name
        limit 500`, [identity.tenantId]),
      db.query(`select subject_user_id::text,workspace_id::text,resource_type,resource_id,permission,valid_from,valid_until
        from corvis_control.resource_entitlement
        where tenant_id=$1
        order by subject_user_id,workspace_id,resource_type,resource_id,permission
        limit 1000`, [identity.tenantId]),
      db.query(`select rights_id::text,resource_type,resource_id,client_visible,internal_analytics_allowed,
          model_training_allowed,redistribution_allowed,source_document_access_allowed,
          effective_from,effective_to,contract_reference
        from corvis_control.data_rights
        where tenant_id=$1
        order by resource_type,resource_id,effective_from desc
        limit 1000`, [identity.tenantId]),
      db.query(`select subject,purpose,status,valid_from,valid_until,reviewed_at,next_review_at,reviewed_by_subject,disabled_at
        from corvis_control.service_identity_grant
        where tenant_id=$1
        order by subject
        limit 500`, [identity.tenantId]),
      db.query(`select support_grant_id::text,subject,user_id::text,workspace_id::text,role_name,purpose,approval_reference,
          valid_from,valid_until,status,approved_by_subject,revoked_at,revoked_by_subject,revoke_reason
        from corvis_control.support_access_grant
        where tenant_id=$1
        order by created_at desc
        limit 500`, [identity.tenantId]),
    ]);

    return json({
      data: {
        memberships,
        resourceEntitlements: entitlements,
        dataRights: rights,
        serviceIdentityGrants: serviceGrants,
        supportAccessGrants: supportGrants,
      },
      correlationId: id,
    });
  } catch (error) {
    return apiError(error, id);
  }
}
