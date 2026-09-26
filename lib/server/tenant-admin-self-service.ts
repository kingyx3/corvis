import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AuthorizationError, type RequestIdentity } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { PostgresOperationsRepository } from "./platform-repositories.ts";
import { postgres, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";
import { createTenantInvitation, INVITATION_TTL_DAYS, normalizeTenantInvitation, type TenantInvitation } from "./tenant-invitations.ts";

export const SUPPORT_ACK_THRESHOLD_HOURS = 4;
export const ROLE_EXPLANATIONS: Record<string, string> = {
  reviewer: "Can review checklists, enter evidence, and draft narratives. Cannot manage users or system settings.",
  analyst: "Can analyze tenant data and prepare working outputs. Cannot manage users or system settings.",
  viewer: "Can view entitled tenant data. Cannot change reviews, users, or system settings.",
  accountadmin: "Can oversee all reviews and submit evidence packages. Cannot manage organization-wide users or system settings.",
  workspace_admin: "Can administer the selected workspace, including workspace-level access. Cannot administer the whole organization.",
  tenant_admin: "Full customer-side access, including user management and review oversight. Reserved for designated customer administrators.",
  support: "Temporary elevated access for authorized Corvis support staff. Always time-limited and fully audited.",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BULK_ROLES = new Set(["tenant_admin", "workspace_admin", "reviewer", "analyst", "viewer"]);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(row: PostgresRow, key: string): string { return row[key] == null ? "" : String(row[key]); }
function requireTenantAdmin(identity: RequestIdentity): void {
  if (identity.isTenantAdmin !== true) throw new AuthorizationError("admin:tenant_manage");
}

export type TenantAccessAuditEvent = {
  auditEventId: string;
  occurredAt: string;
  workspaceId?: string;
  actorSubject: string;
  action: string;
  targetType: string;
  targetId: string;
  outcome: string;
  metadata: Record<string, unknown>;
};

export async function listTenantAccessAudit(identity: RequestIdentity, db: PostgresSqlApi = postgres(getServerConfig().postgresDsn)): Promise<TenantAccessAuditEvent[]> {
  requireTenantAdmin(identity);
  const rows = await db.query(`select audit_event_id::text,occurred_at,workspace_id::text,actor_subject,action,target_type,target_id,outcome,metadata
    from corvis_control.audit_event
    where tenant_id=$1::uuid and (
      action like 'tenant_invitation.%' or action like 'access.member.%' or action like 'access.support.%'
      or action like 'identity.lifecycle.%' or target_type in ('membership','tenant_invitation','support_access_grant')
    )
    order by occurred_at desc,audit_event_id desc limit 2000`, [identity.tenantId]);
  return rows.map((row) => ({
    auditEventId: text(row, "audit_event_id"), occurredAt: text(row, "occurred_at"), workspaceId: text(row, "workspace_id") || undefined,
    actorSubject: text(row, "actor_subject"), action: text(row, "action"), targetType: text(row, "target_type"), targetId: text(row, "target_id"),
    outcome: text(row, "outcome"), metadata: row.metadata && typeof row.metadata === "object" ? row.metadata as Record<string, unknown> : {},
  }));
}

function csvCell(value: unknown): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return /[",\r\n]/.test(raw) ? `"${raw.replaceAll('"', '""')}"` : raw;
}
export function tenantAccessAuditCsv(events: TenantAccessAuditEvent[]): string {
  const rows = [["occurred_at","actor","action","workspace_id","target_type","target_id","outcome","metadata"],
    ...events.map((event) => [event.occurredAt,event.actorSubject,event.action,event.workspaceId ?? "",event.targetType,event.targetId,event.outcome,event.metadata])];
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export type SupportAccessSummary = {
  supportGrantId: string; workspaceId: string; roleName: string; purpose: string; validFrom: string; validUntil: string;
  status: "pending_ack" | "active"; requiresTenantAck: boolean; acknowledgedAt?: string; subject: string;
};
export type TenantAccessNotification = {
  notificationId: string; kind: string; supportGrantId: string; title: string; message: string; createdAt: string; readAt?: string;
};

export async function tenantSupportAccessState(identity: RequestIdentity, db: PostgresSqlApi = postgres(getServerConfig().postgresDsn)) {
  requireTenantAdmin(identity);
  const [grants, notifications] = await Promise.all([
    db.query(`select support_grant_id::text,workspace_id::text,role_name,purpose,valid_from,valid_until,status,requires_tenant_ack,acknowledged_at,subject
      from corvis_control.support_access_grant
      where tenant_id=$1::uuid and status in ('pending_ack','active') and valid_until>now()
      order by valid_until`, [identity.tenantId]),
    db.query(`select notification_id::text,kind,support_grant_id::text,title,message,created_at,read_at
      from corvis_control.tenant_access_notification where tenant_id=$1::uuid order by created_at desc limit 100`, [identity.tenantId]),
  ]);
  return {
    grants: grants.map((row) => ({ supportGrantId:text(row,"support_grant_id"),workspaceId:text(row,"workspace_id"),roleName:text(row,"role_name"),purpose:text(row,"purpose"),validFrom:text(row,"valid_from"),validUntil:text(row,"valid_until"),status:text(row,"status") as SupportAccessSummary["status"],requiresTenantAck:row.requires_tenant_ack===true,acknowledgedAt:text(row,"acknowledged_at")||undefined,subject:text(row,"subject") })),
    notifications: notifications.map((row) => ({ notificationId:text(row,"notification_id"),kind:text(row,"kind"),supportGrantId:text(row,"support_grant_id"),title:text(row,"title"),message:text(row,"message"),createdAt:text(row,"created_at"),readAt:text(row,"read_at")||undefined })),
  };
}

export async function markTenantAccessNotificationsRead(identity: RequestIdentity, db: PostgresSqlApi = postgres(getServerConfig().postgresDsn)): Promise<void> {
  requireTenantAdmin(identity);
  await db.execute(`update corvis_control.tenant_access_notification set read_at=coalesce(read_at,now()) where tenant_id=$1::uuid and read_at is null`, [identity.tenantId]);
}

export async function acknowledgeSupportAccess(identity: RequestIdentity, supportGrantId: string, correlationId: string, db: PostgresSqlApi): Promise<void> {
  requireTenantAdmin(identity);
  if (!UUID.test(supportGrantId)) throw new Error("invalid_support_grant_id");
  const rows = await db.query(`select auth_method,subject,user_id::text,workspace_id::text,role_name,purpose,approval_reference,valid_from,valid_until,approved_by_subject
    from corvis_control.support_access_grant where tenant_id=$1::uuid and support_grant_id=$2::uuid and status='pending_ack' and valid_until>now() for update`, [identity.tenantId,supportGrantId]);
  const grant = rows[0];
  if (!grant) throw new Error("support_grant_not_pending");
  await db.execute(`delete from corvis_control.support_access_grant where tenant_id=$1::uuid and support_grant_id=$2::uuid and status='pending_ack'`, [identity.tenantId,supportGrantId]);
  await db.query(`select corvis_control.apply_support_access_admin($1::uuid,$2,$3::uuid,$4,'grant',$5::uuid,$6,$7,$8::uuid,$9::uuid,$10,$11,$12,$13::timestamptz,$14::timestamptz,$15) as result`, [
    identity.tenantId,text(grant,"approved_by_subject"),identity.workspaceId,correlationId,supportGrantId,text(grant,"auth_method"),text(grant,"subject"),text(grant,"user_id"),text(grant,"workspace_id"),text(grant,"role_name"),text(grant,"purpose"),text(grant,"approval_reference"),text(grant,"valid_from"),text(grant,"valid_until"),"Tenant administrator acknowledged elevated support access",
  ]);
  await db.execute(`update corvis_control.support_access_grant set requires_tenant_ack=true,acknowledged_at=now(),acknowledged_by_subject=$3 where tenant_id=$1::uuid and support_grant_id=$2::uuid`, [identity.tenantId,supportGrantId,identity.subject]);
  await new PostgresOperationsRepository(db).audit({ id:randomUUID(),occurredAt:new Date().toISOString(),tenantId:identity.tenantId,workspaceId:identity.workspaceId,actorSubject:identity.subject,sessionId:identity.sessionId,action:"access.support.acknowledged",targetType:"support_access_grant",targetId:supportGrantId,outcome:"success",correlationId,metadata:{ supportGrantId } });
}

export async function revokeTenantInvitation(identity: RequestIdentity, invitationId: string, reason: string, correlationId: string, db: PostgresSqlApi): Promise<void> {
  requireTenantAdmin(identity);
  if (!UUID.test(invitationId) || reason.trim().length < 3 || reason.length > 1000) throw new Error("invalid_request");
  const changed = await db.query(`update corvis_control.tenant_invitation set status='revoked'
    where tenant_id=$1::uuid and invitation_id=$2::uuid and status='pending' and expires_at>now()
    returning workspace_id::text,email,role_name`, [identity.tenantId,invitationId]);
  if (!changed[0]) throw new Error("invitation_not_pending");
  await new PostgresOperationsRepository(db).audit({ id:randomUUID(),occurredAt:new Date().toISOString(),tenantId:identity.tenantId,workspaceId:text(changed[0],"workspace_id"),actorSubject:identity.subject,sessionId:identity.sessionId,action:"tenant_invitation.revoked",targetType:"tenant_invitation",targetId:invitationId,outcome:"success",correlationId,metadata:{email:text(changed[0],"email"),roleName:text(changed[0],"role_name"),reason:reason.trim()} });
}

export async function resendTenantInvitation(identity: RequestIdentity, invitationId: string, reason: string, correlationId: string, db: PostgresSqlApi): Promise<{ invitation: TenantInvitation; token: string }> {
  requireTenantAdmin(identity);
  if (!UUID.test(invitationId) || reason.trim().length < 3 || reason.length > 1000) throw new Error("invalid_request");
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now()+INVITATION_TTL_DAYS*86400000).toISOString();
  const rows = await db.query(`update corvis_control.tenant_invitation i set token_sha256=$3,expires_at=$4::timestamptz
    from corvis_control.workspace w where i.tenant_id=$1::uuid and i.invitation_id=$2::uuid and i.status='pending' and i.expires_at>now()
      and w.tenant_id=i.tenant_id and w.workspace_id=i.workspace_id
    returning i.invitation_id::text,i.tenant_id::text,i.workspace_id::text,w.display_name as workspace_name,i.email,i.role_name,i.status,i.created_at,i.expires_at`, [identity.tenantId,invitationId,tokenHash,expiresAt]);
  const row=rows[0]; if(!row) throw new Error("invitation_not_pending");
  await new PostgresOperationsRepository(db).audit({ id:randomUUID(),occurredAt:new Date().toISOString(),tenantId:identity.tenantId,workspaceId:text(row,"workspace_id"),actorSubject:identity.subject,sessionId:identity.sessionId,action:"tenant_invitation.resent",targetType:"tenant_invitation",targetId:invitationId,outcome:"success",correlationId,metadata:{email:text(row,"email"),roleName:text(row,"role_name"),reason:reason.trim(),expiresAt} });
  return { token, invitation:{invitationId:text(row,"invitation_id"),tenantId:text(row,"tenant_id"),workspaceId:text(row,"workspace_id"),workspaceName:text(row,"workspace_name"),email:text(row,"email"),roleName:text(row,"role_name") as TenantInvitation["roleName"],status:"pending",createdAt:text(row,"created_at"),expiresAt:text(row,"expires_at")} };
}

function parseCsvLine(line: string): string[] {
  const fields:string[]=[]; let value=""; let quoted=false;
  for(let i=0;i<line.length;i++){ const char=line[i]; if(char==='"'){ if(quoted&&line[i+1]==='"'){value+='"';i++;}else quoted=!quoted; } else if(char===','&&!quoted){fields.push(value.trim());value="";} else value+=char; }
  if(quoted) throw new Error("unterminated_quote"); fields.push(value.trim()); return fields;
}
export type BulkInviteRow = { row:number; name:string; email:string; roleName:string; workspaceId:string; reason:string };
export function parseBulkInviteCsv(csv:string): { rows:BulkInviteRow[]; errors:Array<{row:number;error:string}> } {
  const lines=csv.replace(/^\uFEFF/,"").split(/\r?\n/).filter((line)=>line.trim());
  if(lines.length<2) return {rows:[],errors:[{row:1,error:"CSV requires a header and at least one data row"}]};
  let header:string[]; try{header=parseCsvLine(lines[0]).map((v)=>v.toLowerCase().replaceAll("_",""));}catch{return {rows:[],errors:[{row:1,error:"Invalid CSV header"}]};}
  const index=(...names:string[])=>header.findIndex((value)=>names.includes(value));
  const nameIndex=index("name","fullname"),emailIndex=index("email","emailaddress"),roleIndex=index("role","rolename"),workspaceIndex=index("workspace","workspaceid"),reasonIndex=index("reason");
  if(emailIndex<0||roleIndex<0||workspaceIndex<0) return {rows:[],errors:[{row:1,error:"Required columns: email, role, workspaceId"}]};
  const rows:BulkInviteRow[]=[]; const errors:Array<{row:number;error:string}>=[];
  for(let i=1;i<lines.length;i++){const rowNumber=i+1;try{const values=parseCsvLine(lines[i]);const email=(values[emailIndex]??"").trim().toLowerCase(),roleName=(values[roleIndex]??"").trim(),workspaceId=(values[workspaceIndex]??"").trim(),name=nameIndex>=0?(values[nameIndex]??"").trim():"",reason=reasonIndex>=0?(values[reasonIndex]??"").trim():"Bulk enterprise onboarding";if(!EMAIL.test(email)||!BULK_ROLES.has(roleName)||!UUID.test(workspaceId)||reason.length<3||reason.length>1000){errors.push({row:rowNumber,error:"Invalid email, role, workspaceId, or reason"});continue;}rows.push({row:rowNumber,name,email,roleName,workspaceId,reason});}catch{errors.push({row:rowNumber,error:"Invalid CSV row"});}}
  return {rows,errors};
}

export async function bulkInvite(identity: RequestIdentity,csv:string,correlationId:string,dbFactory:()=>PostgresSqlApi):Promise<{created:Array<{row:number;invitation:TenantInvitation;token:string}>;errors:Array<{row:number;error:string}>}> {
  requireTenantAdmin(identity); if(csv.length>1_000_000) throw new Error("csv_too_large"); const parsed=parseBulkInviteCsv(csv); const created:Array<{row:number;invitation:TenantInvitation;token:string}>=[]; const errors=[...parsed.errors];
  if(parsed.rows.length>500) return {created:[],errors:[...errors,{row:0,error:"Bulk import is limited to 500 valid rows"}]};
  for(const row of parsed.rows){ const command=normalizeTenantInvitation({tenantId:identity.tenantId,workspaceId:row.workspaceId,email:row.email,roleName:row.roleName,reason:row.reason,confirmTenantAdmin:row.roleName==="tenant_admin"}); if(!command){errors.push({row:row.row,error:"Invalid invitation"});continue;} try{const result=await createTenantInvitation(identity,command,`${correlationId}:${row.row}`,dbFactory());created.push({row:row.row,...result});}catch(error){errors.push({row:row.row,error:error instanceof Error?error.message:"Invitation failed"});} }
  return {created,errors};
}
