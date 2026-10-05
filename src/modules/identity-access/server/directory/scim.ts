import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AuditEvent, RequestIdentity } from "../../../../shared/domain/enterprise.ts";
import { emailDomainAllowed } from "./identity-records.ts";
import { PostgresIdentityLifecycleRepository, type HumanAuthMethod, type IdentityLifecycleRole } from "./identity-lifecycle.ts";
import { getServerConfig } from "../../../../platform/config/config.ts";
import { PostgresOperationsRepository } from "../../../../platform/data/platform-repositories.ts";
import { postgres, withTransaction, type PostgresRow, type PostgresSqlApi } from "../../../../platform/database/postgres.ts";
import { isTransientPostgresError } from "../../../../platform/database/postgres-native.ts";
import { RATE_LIMIT_WINDOW_MS, RateLimitError, RateLimiter } from "../../../../platform/http/limits/rate-limit.ts";
import { userBearerAuthorization } from "../../../../platform/http/identity/request-context.ts";
import { sqlApplicationErrorOf } from "../../../../platform/database/sql-application-errors.ts";
import { logEvent } from "../../../../platform/observability/telemetry.ts";
import { TenantInvitationError } from "../tenants/tenant-invitations.ts";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES=new Set<IdentityLifecycleRole>(["accountadmin","reviewer","analyst","viewer"]);
function text(row:PostgresRow,key:string){return row[key]==null?"":String(row[key]);}

export type ScimConfiguration={tenantId:string;authMethod:HumanAuthMethod;defaultWorkspaceId:string;defaultRoleName:IdentityLifecycleRole};
/**
 * Mints (or rotates) the tenant's SCIM bearer token. The token can provision
 * users with the configured default role, so every mint/rotation is a
 * security event: the configuration write and its `audit_event` commit in one
 * transaction (a failed audit insert rolls the new token back), and the audit
 * row records who changed what and whether an earlier token was replaced,
 * never the token or its hash.
 */
export async function configureScim(identity:RequestIdentity,authMethod:HumanAuthMethod,workspaceId:string,roleName:IdentityLifecycleRole,db:PostgresSqlApi=postgres(getServerConfig().databaseDsn),correlationId:string=randomUUID()):Promise<{configuration:ScimConfiguration;token:string}>{
  if(identity.isTenantAdmin!==true) throw new TenantInvitationError("tenant_admin_required", 403);if(!UUID.test(workspaceId)||!ROLES.has(roleName))throw new TenantInvitationError("invalid_scim_configuration", 400);
  return withTransaction(db,async(tx)=>{
    const workspace=await tx.query(`select 1 from corvis_control.workspace where tenant_id=$1::uuid and workspace_id=$2::uuid and status='active' limit 1`,[identity.tenantId,workspaceId]);if(!workspace.length)throw new TenantInvitationError("workspace_not_found", 404);
    const previous=(await tx.query(`select enabled,auth_method,default_workspace_id::text,default_role_name from corvis_control.tenant_scim_configuration where tenant_id=$1::uuid for update`,[identity.tenantId]))[0];
    const token=randomBytes(32).toString("base64url");const hash=createHash("sha256").update(token).digest("hex");
    await tx.execute(`insert into corvis_control.tenant_scim_configuration(tenant_id,enabled,token_sha256,auth_method,default_workspace_id,default_role_name,updated_by_subject)
      values($1::uuid,true,$2,$3,$4::uuid,$5,$6) on conflict(tenant_id) do update set enabled=true,token_sha256=excluded.token_sha256,auth_method=excluded.auth_method,default_workspace_id=excluded.default_workspace_id,default_role_name=excluded.default_role_name,updated_by_subject=excluded.updated_by_subject,updated_at=now()`,[identity.tenantId,hash,authMethod,workspaceId,roleName,identity.subject]);
    const event:AuditEvent={id:randomUUID(),occurredAt:new Date().toISOString(),tenantId:identity.tenantId,workspaceId,actorSubject:identity.subject,sessionId:identity.sessionId,action:"access.scim.configured",targetType:"scim_configuration",targetId:identity.tenantId,outcome:"success",correlationId,
      metadata:{authMethod,defaultWorkspaceId:workspaceId,defaultRoleName:roleName,rotated:previous!==undefined,previousEnabled:previous?previous.enabled===true:null,previousAuthMethod:previous?text(previous,"auth_method"):null,previousDefaultWorkspaceId:previous?text(previous,"default_workspace_id"):null,previousDefaultRoleName:previous?text(previous,"default_role_name"):null}};
    await new PostgresOperationsRepository(tx).audit(event);
    return {configuration:{tenantId:identity.tenantId,authMethod,defaultWorkspaceId:workspaceId,defaultRoleName:roleName},token};
  });
}

/**
 * Unauthenticated SCIM traffic is limited before it can cost a Postgres query.
 * These process-local limiters bound the work one instance does per client and
 * per targeted tenant (the same in-memory pattern as rate-limit.ts; each Cloud
 * Run instance enforces its own budget).
 *
 * - The client key is Cloudflare's `cf-connecting-ip` (set by the edge, which
 *   overwrites any caller-supplied value), falling back to the first
 *   x-forwarded-for hop off-edge. It is best-effort; the tenant budget is the
 *   bound a rotating client address cannot evade.
 * - The tenant budget counts only failed authentications, so a tenant's own IdP
 *   never spends it. While a tenant is over it, a token this instance verified
 *   within VERIFIED_TOKEN_TTL_MS may pass the tenant throttle to revalidate against Postgres, so an
 *   attacker who knows a tenant id cannot lock that tenant's IdP out. The cache
 *   is only a throttle exemption, never authentication authority. Every accepted
 *   request re-checks Postgres, including during attacks and after rotation.
 */
export const VERIFIED_TOKEN_TTL_MS = 5 * 60_000;
const VERIFIED_TOKEN_MAX = 1_000;
type VerifiedTokens=Map<string,{config:ScimConfiguration;expiresAt:number}>;
export type ScimRateLimits={clientLimiter?:RateLimiter;tenantLimiter?:RateLimiter;verifiedTokens?:VerifiedTokens;now?:number};
let sharedScimLimiters:{client:RateLimiter;tenant:RateLimiter;verified:VerifiedTokens}|undefined;
function scimLimiters(){
  if(!sharedScimLimiters){const limit=getServerConfig().rateLimitRequestsPerMinute;sharedScimLimiters={client:new RateLimiter(limit,RATE_LIMIT_WINDOW_MS),tenant:new RateLimiter(limit,RATE_LIMIT_WINDOW_MS),verified:new Map()};}
  return sharedScimLimiters;
}
/** Test-only: drop the shared limiters so the next request rebuilds them from configuration. */
export function resetScimRateLimiters():void{sharedScimLimiters=undefined;}
function clientKey(request:Request):string{
  const edge=request.headers.get("cf-connecting-ip")?.trim();
  const forwarded=request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (edge||forwarded||request.headers.get("x-real-ip")?.trim()||"unknown").slice(0,64);
}
function enforceScimLimit(limiter:RateLimiter,key:string,now:number):void{
  const decision=limiter.consume(key,now);if(!decision.allowed)throw new ScimError(429,"tooMany","SCIM rate limit exceeded",decision.retryAfterSeconds);
}
function rememberVerified(verified:VerifiedTokens,key:string,config:ScimConfiguration,now:number):void{
  verified.delete(key);
  // Map iteration is insertion order, so the first key is the least recently verified.
  if(verified.size>=VERIFIED_TOKEN_MAX){const oldest=verified.keys().next().value;if(oldest!==undefined)verified.delete(oldest);}
  verified.set(key,{config,expiresAt:now+VERIFIED_TOKEN_TTL_MS});
}

export async function authenticateScim(request:Request,db:PostgresSqlApi=postgres(getServerConfig().databaseDsn),limits:ScimRateLimits={}):Promise<ScimConfiguration>{
  const shared=limits.clientLimiter&&limits.tenantLimiter?undefined:scimLimiters();
  const clientLimiter=limits.clientLimiter??shared!.client,tenantLimiter=limits.tenantLimiter??shared!.tenant,verified=limits.verifiedTokens??shared?.verified??new Map();
  const now=limits.now??Date.now();
  enforceScimLimit(clientLimiter,clientKey(request),now);
  const tenantId=request.headers.get("x-corvis-tenant")?.trim()??"";const authorization=userBearerAuthorization(request)??"";const match=/^Bearer\s+([A-Za-z0-9_-]{40,100})$/.exec(authorization);
  if(!UUID.test(tenantId)||!match)throw new ScimError(401,"invalidToken","Valid SCIM bearer token and tenant are required");
  const tenantKey=tenantId.toLowerCase();const hash=createHash("sha256").update(match[1]).digest("hex");const verifiedKey=`${tenantKey}:${hash}`;
  const budget=tenantLimiter.peek(tenantKey,now);
  if(!budget.allowed){
    const known=verified.get(verifiedKey);
    if(!known||known.expiresAt<=now)throw new ScimError(429,"tooMany","SCIM rate limit exceeded",budget.retryAfterSeconds);
  }
  const rows=await db.query(`select auth_method,default_workspace_id::text,default_role_name from corvis_control.tenant_scim_configuration where tenant_id=$1::uuid and enabled=true and token_sha256=$2 limit 1`,[tenantId,hash]);const row=rows[0];
  if(!row){verified.delete(verifiedKey);tenantLimiter.consume(tenantKey,now);throw new ScimError(401,"invalidToken","SCIM bearer token is invalid");}
  const config:ScimConfiguration={tenantId,authMethod:text(row,"auth_method") as HumanAuthMethod,defaultWorkspaceId:text(row,"default_workspace_id"),defaultRoleName:text(row,"default_role_name") as IdentityLifecycleRole};
  rememberVerified(verified,verifiedKey,config,now);
  return config;
}

export class ScimError extends Error{
  readonly status:number;
  readonly scimType:string;
  readonly retryAfterSeconds?:number;
  constructor(status:number,scimType:string,message:string,retryAfterSeconds?:number){super(message);this.name="ScimError";this.status=status;this.scimType=scimType;if(retryAfterSeconds!==undefined)this.retryAfterSeconds=retryAfterSeconds;}
}
/**
 * Maps any failure to a SCIM error response. Expected ScimErrors keep their
 * status; a transient database outage is a retryable 503; everything else is
 * an opaque 500 whose cause class is logged (never the message, which can
 * carry SQL values) so operators can tell a bug from an outage.
 */
export function scimErrorResponse(error:unknown,correlationId:string="scim"):Response{
  let resolved:ScimError;
  if(error instanceof ScimError)resolved=error;
  else if(error instanceof RateLimitError)resolved=new ScimError(429,"tooMany","SCIM rate limit exceeded",error.retryAfterSeconds);
  else if(isTransientPostgresError(error)){
    logEvent("error","scim.database_unavailable",{correlationId},{phase:error.phase,code:error.code});
    resolved=new ScimError(503,"serverError","SCIM service temporarily unavailable",5);
  }else{
    const code=(error as {code?:unknown}|null)?.code;
    logEvent("error","scim.request_failed",{correlationId},{errorName:error instanceof Error?error.name:typeof error,...(typeof code==="string"?{code}:{})});
    resolved=new ScimError(500,"serverError","SCIM request failed");
  }
  return Response.json({schemas:["urn:ietf:params:scim:api:messages:2.0:Error"],status:String(resolved.status),scimType:resolved.scimType,detail:resolved.message},{status:resolved.status,headers:{"cache-control":"no-store",...(resolved.retryAfterSeconds!==undefined?{"retry-after":String(resolved.retryAfterSeconds)}:{})}});
}

export type ScimUser={id:string;externalId:string;userName:string;active:boolean;meta:{resourceType:"User";location:string}};
function user(row:PostgresRow,base:string):ScimUser{const id=text(row,"scim_user_id");return {id,externalId:text(row,"external_id"),userName:text(row,"user_name"),active:row.active===true,meta:{resourceType:"User",location:`${base}/${id}`}};}

const SCIM_MAX_PAGE_SIZE=200;
// `offset $n::int` raises 22003 above int4; SCIM treats an out-of-range startIndex as an empty page.
const SCIM_MAX_START_INDEX=2147483647;

export type ScimUserPage={resources:ScimUser[];totalResults:number;startIndex:number};

export async function listScimUsers(config:ScimConfiguration,base:string,filter:string|null,db:PostgresSqlApi,startIndex=1,count=SCIM_MAX_PAGE_SIZE):Promise<ScimUserPage>{
  const safeStartIndex=Number.isInteger(startIndex)&&startIndex>=1?Math.min(startIndex,SCIM_MAX_START_INDEX):1;
  const safeCount=Number.isInteger(count)&&count>=0?Math.min(count,SCIM_MAX_PAGE_SIZE):SCIM_MAX_PAGE_SIZE;
  let where=`tenant_id=$1::uuid`;const parameters:Array<string>=[config.tenantId];
  const match=/^\s*(userName|externalId)\s+eq\s+"([^"]+)"\s*$/.exec(filter??"");if(filter&& !match)throw new ScimError(400,"invalidFilter","Only userName eq and externalId eq filters are supported");if(match){where+=match[1]==="userName"?` and user_name=$2`:` and external_id=$2`;
    // user_name is stored lower-cased (createScimUser), and SCIM userName comparison is case-insensitive.
    parameters.push(match[1]==="userName"?match[2].trim().toLowerCase():match[2]);}
  const totalRows=await db.query(`select count(*)::int as count from corvis_control.tenant_scim_identity where ${where}`,parameters);
  const totalResults=Number(totalRows[0]?.count??0);
  const limitIndex=parameters.length+1,offsetIndex=parameters.length+2;
  const rows=await db.query(
    `select scim_user_id::text,external_id,user_name,active from corvis_control.tenant_scim_identity where ${where} order by created_at limit $${limitIndex}::int offset $${offsetIndex}::int`,
    [...parameters,String(safeCount),String(safeStartIndex-1)],
  );
  return {resources:rows.map((row)=>user(row,base)),totalResults,startIndex:safeStartIndex};
}

/**
 * Provisioning is all-or-nothing: the identity lifecycle apply (and the
 * optional disable for an inactive user) and the tenant_scim_identity row
 * share one transaction, so a crash between them cannot leave a provisioned
 * identity with no SCIM record for a retry to re-provision under new ids.
 */
export async function createScimUser(config:ScimConfiguration,input:Record<string,unknown>,base:string,correlationId:string,db:PostgresSqlApi):Promise<ScimUser>{
  const userName=typeof input.userName==="string"?input.userName.trim().toLowerCase():"";const externalId=typeof input.externalId==="string"?input.externalId.trim():"";const active=input.active!==false;if(!EMAIL.test(userName)||!externalId||externalId.length>1024)throw new ScimError(400,"invalidValue","userName email and externalId are required");
  return withTransaction(db,async(tx)=>{
    const existing=await tx.query(`select 1 from corvis_control.tenant_scim_identity where tenant_id=$1::uuid and (external_id=$2 or user_name=$3) limit 1`,[config.tenantId,externalId,userName]);if(existing.length)throw new ScimError(409,"uniqueness","SCIM user already exists");
    // F7b (#335): off unless the tenant has a verified domain; only a NEW user is checked, so nobody who already exists is locked out.
    if(!await emailDomainAllowed(tx,config.tenantId,userName))throw new ScimError(400,"invalidValue","userName domain is not verified for this organization");
    const scimUserId=randomUUID(),userId=randomUUID(),subject=externalId,eventKey=`scim:${scimUserId}:create`;
    const lifecycle=new PostgresIdentityLifecycleRepository(tx);
    try{await lifecycle.apply({tenantId:config.tenantId,eventKey,actorSubject:`scim:${config.tenantId}`,actorWorkspaceId:config.defaultWorkspaceId,correlationId,operation:"sync",authMethod:config.authMethod,subject,userId,memberships:[{workspaceId:config.defaultWorkspaceId,roleName:config.defaultRoleName}],reason:"SCIM provision"});
    if(!active)await lifecycle.apply({tenantId:config.tenantId,eventKey:`scim:${scimUserId}:create-disable`,actorSubject:`scim:${config.tenantId}`,actorWorkspaceId:config.defaultWorkspaceId,correlationId,operation:"disable",authMethod:config.authMethod,subject,userId,memberships:[],reason:"SCIM provisioned inactive"});}
    catch(error){
      // The externalId is the identity subject: one that is already mapped to another user (e.g. an accepted invitation) or disabled is a conflict, not a server failure.
      const code=sqlApplicationErrorOf(error);
      if(code.includes("identity subject is already mapped to a different user")||code.includes("disabled identity requires explicit reactivation"))throw new ScimError(409,"uniqueness","SCIM user already exists");
      throw error;
    }
    let rows:PostgresRow[];
    try{rows=await tx.query(`insert into corvis_control.tenant_scim_identity(tenant_id,scim_user_id,external_id,user_id,auth_method,subject,user_name,active) values($1::uuid,$2::uuid,$3,$4::uuid,$5,$6,$7,$8) returning scim_user_id::text,external_id,user_name,active`,[config.tenantId,scimUserId,externalId,userId,config.authMethod,subject,userName,active]);}
    catch(error){
      // A concurrent create for the same user passed the check above; the unique constraint decides, and the whole transaction (including the lifecycle apply) rolls back.
      if((error as {code?:unknown}|null)?.code==="23505")throw new ScimError(409,"uniqueness","SCIM user already exists");
      throw error;
    }
    return user(rows[0],base);
  });
}

export async function getScimUser(config:ScimConfiguration,id:string,base:string,db:PostgresSqlApi):Promise<ScimUser>{if(!UUID.test(id))throw new ScimError(404,"notFound","SCIM user not found");const rows=await db.query(`select scim_user_id::text,external_id,user_name,active from corvis_control.tenant_scim_identity where tenant_id=$1::uuid and scim_user_id=$2::uuid limit 1`,[config.tenantId,id]);if(!rows[0])throw new ScimError(404,"notFound","SCIM user not found");return user(rows[0],base);}

export async function setScimUserActive(config:ScimConfiguration,id:string,active:boolean,correlationId:string,db:PostgresSqlApi):Promise<void>{
  if(!UUID.test(id))throw new ScimError(404,"notFound","SCIM user not found");
  return withTransaction(db,(tx)=>setScimUserActiveIn(config,id,active,correlationId,tx));
}
async function setScimUserActiveIn(config:ScimConfiguration,id:string,active:boolean,correlationId:string,db:PostgresSqlApi):Promise<void>{
  const rows=await db.query(`select user_id::text,auth_method,subject,active from corvis_control.tenant_scim_identity where tenant_id=$1::uuid and scim_user_id=$2::uuid for update`,[config.tenantId,id]);const row=rows[0];if(!row)throw new ScimError(404,"notFound","SCIM user not found");if(row.active===active)return;
  const lifecycle=new PostgresIdentityLifecycleRepository(db);if(!active){await lifecycle.apply({tenantId:config.tenantId,eventKey:`scim:${id}:disable:${randomUUID()}`,actorSubject:`scim:${config.tenantId}`,actorWorkspaceId:config.defaultWorkspaceId,correlationId,operation:"disable",authMethod:text(row,"auth_method") as HumanAuthMethod,subject:text(row,"subject"),userId:text(row,"user_id"),memberships:[],reason:"SCIM deprovision"});}
  else{await db.query(`select corvis_control.reactivate_identity_admin($1::uuid,$2,$3,$4::uuid,$5,$6,$7,$8::uuid,$9::jsonb,$10) as result`,[config.tenantId,`scim:${id}:reactivate:${randomUUID()}`,`scim:${config.tenantId}`,config.defaultWorkspaceId,correlationId,text(row,"auth_method"),text(row,"subject"),text(row,"user_id"),JSON.stringify([{workspaceId:config.defaultWorkspaceId,roleName:config.defaultRoleName}]),"SCIM reactivate"]);}
  await db.execute(`update corvis_control.tenant_scim_identity set active=$3,updated_at=now() where tenant_id=$1::uuid and scim_user_id=$2::uuid`,[config.tenantId,id,active]);
}

export function newScimToken():string{return randomBytes(32).toString("base64url");}
