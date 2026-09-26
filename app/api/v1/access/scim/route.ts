import { assertPermission } from "@/core/enterprise";
import { readJsonObject } from "@/lib/server/admin-request";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { getServerConfig } from "@/lib/server/config";
import { apiError, correlationId, json } from "@/lib/server/http";
import { postgres, withTransaction } from "@/lib/server/postgres";
import { configureScim } from "@/lib/server/scim";
import type { HumanAuthMethod, IdentityLifecycleRole } from "@/lib/server/identity-lifecycle";

const ROLES=new Set(["accountadmin","reviewer","analyst","viewer"]);
export async function POST(request:Request){const id=correlationId(request);try{const identity=await resolveAuthorizedRequestIdentity(request);assertPermission(identity,"admin:manage");if(identity.isTenantAdmin!==true)return json({error:"tenant_admin_required",correlationId:id},{status:403});const body=await readJsonObject(request) as Record<string,unknown>|undefined;const authMethod=body?.authMethod==="oidc"||body?.authMethod==="saml"?body.authMethod as HumanAuthMethod:undefined;const workspaceId=typeof body?.workspaceId==="string"?body.workspaceId:"";const roleName=typeof body?.roleName==="string"&&ROLES.has(body.roleName)?body.roleName as IdentityLifecycleRole:undefined;if(!authMethod||!workspaceId||!roleName)return json({error:"invalid_request",correlationId:id},{status:400});const db=postgres(getServerConfig().postgresDsn);const data=await withTransaction(db,(tx)=>configureScim(identity,authMethod,workspaceId,roleName,tx));return json({data,correlationId:id},{status:201});}catch(error){return apiError(error,id);}}
