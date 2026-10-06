import { assertPermission } from "@/shared/domain/enterprise";
import { readJsonObject } from "@/modules/identity-access/server/request/admin-request";
import { resolveAuthorizedRequestIdentity } from "@/modules/identity-access/server/request/authorized-request";
import { getServerConfig } from "@/platform/config/config";
import { apiError, correlationId, json } from "@/platform/http/api/http";
import { postgres } from "@/platform/database/postgres";
import { configureScim } from "@/modules/identity-access/server/directory/scim";
import type { HumanAuthMethod, IdentityLifecycleRole } from "@/modules/identity-access/server/directory/identity-lifecycle";

const ROLES=new Set(["accountadmin","reviewer","analyst","viewer"]);
export async function POST(request:Request){const id=correlationId(request);try{const identity=await resolveAuthorizedRequestIdentity(request);assertPermission(identity,"admin:manage");if(identity.isTenantAdmin!==true)return json({error:"tenant_admin_required",correlationId:id},{status:403});const body=await readJsonObject(request) as Record<string,unknown>|undefined;const authMethod=body?.authMethod==="oidc"||body?.authMethod==="saml"?body.authMethod as HumanAuthMethod:undefined;const workspaceId=typeof body?.workspaceId==="string"?body.workspaceId:"";const roleName=typeof body?.roleName==="string"&&ROLES.has(body.roleName)?body.roleName as IdentityLifecycleRole:undefined;if(!authMethod||!workspaceId||!roleName)return json({error:"invalid_request",correlationId:id},{status:400});const db=postgres(getServerConfig().databaseDsn);const data=await configureScim(identity,authMethod,workspaceId,roleName,db,id);return json({data,correlationId:id},{status:201});}catch(error){return apiError(error,id);}}
