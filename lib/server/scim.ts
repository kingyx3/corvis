import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { PostgresIdentityLifecycleRepository, type HumanAuthMethod, type IdentityLifecycleRole } from "./identity-lifecycle.ts";
import { getServerConfig } from "./config.ts";
import { postgres, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES=new Set<IdentityLifecycleRole>(["accountadmin","reviewer","analyst","viewer"]);
function text(row:PostgresRow,key:string){return row[key]==null?"":String(row[key]);}

export type ScimConfiguration={tenantId:string;authMethod:HumanAuthMethod;defaultWorkspaceId:string;defaultRoleName:IdentityLifecycleRole};
export async function configureScim(identity:RequestIdentity,authMethod:HumanAuthMethod,workspaceId:string,roleName:IdentityLifecycleRole,db:PostgresSqlApi=postgres(getServerConfig().postgresDsn)):Promise<{configuration:ScimConfiguration;token:string}>{
  if(identity.isTenantAdmin!==true) throw new Error("tenant_admin_required");if(!UUID.test(workspaceId)||!ROLES.has(roleName))throw new Error("invalid_scim_configuration");
  const workspace=await db.query(`select 1 from corvis_control.workspace where tenant_id=$1::uuid and workspace_id=$2::uuid and status='active' limit 1`,[identity.tenantId,workspaceId]);if(!workspace.length)throw new Error("workspace_not_found");
  const token=randomBytes(32).toString("base64url");const hash=createHash("sha256").update(token).digest("hex");
  await db.execute(`insert into corvis_control.tenant_scim_configuration(tenant_id,enabled,token_sha256,auth_method,default_workspace_id,default_role_name,updated_by_subject)
    values($1::uuid,true,$2,$3,$4::uuid,$5,$6) on conflict(tenant_id) do update set enabled=true,token_sha256=excluded.token_sha256,auth_method=excluded.auth_method,default_workspace_id=excluded.default_workspace_id,default_role_name=excluded.default_role_name,updated_by_subject=excluded.updated_by_subject,updated_at=now()`,[identity.tenantId,hash,authMethod,workspaceId,roleName,identity.subject]);
  return {configuration:{tenantId:identity.tenantId,authMethod,defaultWorkspaceId:workspaceId,defaultRoleName:roleName},token};
}

export async function authenticateScim(request:Request,db:PostgresSqlApi=postgres(getServerConfig().postgresDsn)):Promise<ScimConfiguration>{
  const tenantId=request.headers.get("x-corvis-tenant")?.trim()??"";const authorization=request.headers.get("authorization")??"";const match=/^Bearer\s+([A-Za-z0-9_-]{40,100})$/.exec(authorization);
  if(!UUID.test(tenantId)||!match)throw new ScimError(401,"invalidToken","Valid SCIM bearer token and tenant are required");
  const hash=createHash("sha256").update(match[1]).digest("hex");const rows=await db.query(`select auth_method,default_workspace_id::text,default_role_name from corvis_control.tenant_scim_configuration where tenant_id=$1::uuid and enabled=true and token_sha256=$2 limit 1`,[tenantId,hash]);const row=rows[0];if(!row)throw new ScimError(401,"invalidToken","SCIM bearer token is invalid");
  return {tenantId,authMethod:text(row,"auth_method") as HumanAuthMethod,defaultWorkspaceId:text(row,"default_workspace_id"),defaultRoleName:text(row,"default_role_name") as IdentityLifecycleRole};
}

export class ScimError extends Error{constructor(readonly status:number,readonly scimType:string,message:string){super(message);this.name="ScimError";}}
export function scimErrorResponse(error:unknown):Response{const resolved=error instanceof ScimError?error:new ScimError(500,"serverError","SCIM request failed");return Response.json({schemas:["urn:ietf:params:scim:api:messages:2.0:Error"],status:String(resolved.status),scimType:resolved.scimType,detail:resolved.message},{status:resolved.status,headers:{"cache-control":"no-store"}});}

export type ScimUser={id:string;externalId:string;userName:string;active:boolean;meta:{resourceType:"User";location:string}};
function user(row:PostgresRow,base:string):ScimUser{const id=text(row,"scim_user_id");return {id,externalId:text(row,"external_id"),userName:text(row,"user_name"),active:row.active===true,meta:{resourceType:"User",location:`${base}/${id}`}};}

export async function listScimUsers(config:ScimConfiguration,base:string,filter:string|null,db:PostgresSqlApi):Promise<ScimUser[]>{
  let sql=`select scim_user_id::text,external_id,user_name,active from corvis_control.tenant_scim_identity where tenant_id=$1::uuid`;const parameters:Array<string>=[config.tenantId];
  const match=/^\s*(userName|externalId)\s+eq\s+"([^"]+)"\s*$/.exec(filter??"");if(filter&& !match)throw new ScimError(400,"invalidFilter","Only userName eq and externalId eq filters are supported");if(match){sql+=match[1]==="userName"?` and user_name=$2`:` and external_id=$2`;parameters.push(match[2]);}sql+=` order by created_at limit 200`;
  return (await db.query(sql,parameters)).map((row)=>user(row,base));
}

export async function createScimUser(config:ScimConfiguration,input:Record<string,unknown>,base:string,correlationId:string,db:PostgresSqlApi):Promise<ScimUser>{
  const userName=typeof input.userName==="string"?input.userName.trim().toLowerCase():"";const externalId=typeof input.externalId==="string"?input.externalId.trim():"";const active=input.active!==false;if(!EMAIL.test(userName)||!externalId||externalId.length>1024)throw new ScimError(400,"invalidValue","userName email and externalId are required");
  const existing=await db.query(`select 1 from corvis_control.tenant_scim_identity where tenant_id=$1::uuid and (external_id=$2 or user_name=$3) limit 1`,[config.tenantId,externalId,userName]);if(existing.length)throw new ScimError(409,"uniqueness","SCIM user already exists");
  const scimUserId=randomUUID(),userId=randomUUID(),subject=externalId,eventKey=`scim:${scimUserId}:create`;
  const lifecycle=new PostgresIdentityLifecycleRepository(db);await lifecycle.apply({tenantId:config.tenantId,eventKey,actorSubject:`scim:${config.tenantId}`,actorWorkspaceId:config.defaultWorkspaceId,correlationId,operation:"sync",authMethod:config.authMethod,subject,userId,memberships:[{workspaceId:config.defaultWorkspaceId,roleName:config.defaultRoleName}],reason:"SCIM provision"});
  if(!active)await lifecycle.apply({tenantId:config.tenantId,eventKey:`scim:${scimUserId}:create-disable`,actorSubject:`scim:${config.tenantId}`,actorWorkspaceId:config.defaultWorkspaceId,correlationId,operation:"disable",authMethod:config.authMethod,subject,userId,memberships:[],reason:"SCIM provisioned inactive"});
  const rows=await db.query(`insert into corvis_control.tenant_scim_identity(tenant_id,scim_user_id,external_id,user_id,auth_method,subject,user_name,active) values($1::uuid,$2::uuid,$3,$4::uuid,$5,$6,$7,$8) returning scim_user_id::text,external_id,user_name,active`,[config.tenantId,scimUserId,externalId,userId,config.authMethod,subject,userName,active]);return user(rows[0],base);
}

export async function getScimUser(config:ScimConfiguration,id:string,base:string,db:PostgresSqlApi):Promise<ScimUser>{if(!UUID.test(id))throw new ScimError(404,"notFound","SCIM user not found");const rows=await db.query(`select scim_user_id::text,external_id,user_name,active from corvis_control.tenant_scim_identity where tenant_id=$1::uuid and scim_user_id=$2::uuid limit 1`,[config.tenantId,id]);if(!rows[0])throw new ScimError(404,"notFound","SCIM user not found");return user(rows[0],base);}

export async function setScimUserActive(config:ScimConfiguration,id:string,active:boolean,correlationId:string,db:PostgresSqlApi):Promise<void>{
  if(!UUID.test(id))throw new ScimError(404,"notFound","SCIM user not found");const rows=await db.query(`select user_id::text,auth_method,subject,active from corvis_control.tenant_scim_identity where tenant_id=$1::uuid and scim_user_id=$2::uuid for update`,[config.tenantId,id]);const row=rows[0];if(!row)throw new ScimError(404,"notFound","SCIM user not found");if(row.active===active)return;
  const lifecycle=new PostgresIdentityLifecycleRepository(db);if(!active){await lifecycle.apply({tenantId:config.tenantId,eventKey:`scim:${id}:disable:${randomUUID()}`,actorSubject:`scim:${config.tenantId}`,actorWorkspaceId:config.defaultWorkspaceId,correlationId,operation:"disable",authMethod:text(row,"auth_method") as HumanAuthMethod,subject:text(row,"subject"),userId:text(row,"user_id"),memberships:[],reason:"SCIM deprovision"});}
  else{await db.query(`select corvis_control.reactivate_identity_admin($1::uuid,$2,$3,$4::uuid,$5,$6,$7,$8::uuid,$9::jsonb,$10) as result`,[config.tenantId,`scim:${id}:reactivate:${randomUUID()}`,`scim:${config.tenantId}`,config.defaultWorkspaceId,correlationId,text(row,"auth_method"),text(row,"subject"),text(row,"user_id"),JSON.stringify([{workspaceId:config.defaultWorkspaceId,roleName:config.defaultRoleName}]),"SCIM reactivate"]);}
  await db.execute(`update corvis_control.tenant_scim_identity set active=$3,updated_at=now() where tenant_id=$1::uuid and scim_user_id=$2::uuid`,[config.tenantId,id,active]);
}

export function newScimToken():string{return randomBytes(32).toString("base64url");}
