import { randomUUID } from "node:crypto";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { PostgresOperationsRepository } from "./platform-repositories.ts";
import type { PostgresSqlApi } from "./postgres.ts";
import { SUPPORT_ACK_THRESHOLD_HOURS } from "./tenant-admin-self-service.ts";

export type SupportAccessGrantCommand = {
  supportGrantId: string | null;
  authMethod: "oidc" | "saml";
  subject: string;
  userId: string;
  workspaceId: string;
  roleName: string;
  purpose: string;
  approvalReference: string;
  validFrom: string;
  validUntil: string;
  reason: string;
};

export function supportAccessRequiresTenantAck(command: SupportAccessGrantCommand): boolean {
  const durationHours=(Date.parse(command.validUntil)-Date.parse(command.validFrom))/3_600_000;
  return command.roleName === "tenant_admin" || command.roleName === "accountadmin" || durationHours > SUPPORT_ACK_THRESHOLD_HOURS;
}

async function notify(db:PostgresSqlApi,tenantId:string,supportGrantId:string,kind:"support_access_active"|"support_access_pending_ack",command:SupportAccessGrantCommand):Promise<void>{
  const title=kind==="support_access_pending_ack"?"Support access requires your acknowledgement":"Corvis support access is active";
  const message=`Corvis support access for ${command.subject} (${command.roleName}) — ${command.purpose}. Starts ${command.validFrom}; expires ${command.validUntil}.`;
  await db.execute(`insert into corvis_control.tenant_access_notification(tenant_id,kind,support_grant_id,title,message)
    values($1::uuid,$2,$3::uuid,$4,$5) on conflict (tenant_id,support_grant_id,kind) do nothing`,[tenantId,kind,supportGrantId,title,message]);
}

export async function grantSupportAccess(identity:RequestIdentity,command:SupportAccessGrantCommand,correlationId:string,db:PostgresSqlApi):Promise<{operation:"grant";supportGrantId:string;status:"active"|"pending_ack";requiresTenantAck:boolean}> {
  const supportGrantId=command.supportGrantId ?? randomUUID();
  const requiresTenantAck=supportAccessRequiresTenantAck(command);
  if(requiresTenantAck){
    await db.execute(`insert into corvis_control.support_access_grant
      (tenant_id,support_grant_id,auth_method,subject,user_id,workspace_id,role_name,purpose,approval_reference,valid_from,valid_until,status,approved_by_subject,requires_tenant_ack)
      values($1::uuid,$2::uuid,$3,$4,$5::uuid,$6::uuid,$7,$8,$9,$10::timestamptz,$11::timestamptz,'pending_ack',$12,true)`,[
      identity.tenantId,supportGrantId,command.authMethod,command.subject,command.userId,command.workspaceId,command.roleName,command.purpose,command.approvalReference,command.validFrom,command.validUntil,identity.subject,
    ]);
    await new PostgresOperationsRepository(db).audit({id:randomUUID(),occurredAt:new Date().toISOString(),tenantId:identity.tenantId,workspaceId:command.workspaceId,actorSubject:identity.subject,sessionId:identity.sessionId,action:"access.support.pending_ack",targetType:"support_access_grant",targetId:supportGrantId,outcome:"success",correlationId,metadata:{subject:command.subject,roleName:command.roleName,purpose:command.purpose,validFrom:command.validFrom,validUntil:command.validUntil,approvalReference:command.approvalReference,reason:command.reason}});
    await notify(db,identity.tenantId,supportGrantId,"support_access_pending_ack",command);
    return {operation:"grant",supportGrantId,status:"pending_ack",requiresTenantAck:true};
  }
  await db.query(`select corvis_control.apply_support_access_admin(
    $1::uuid,$2,$3::uuid,$4,'grant',$5::uuid,$6,$7,$8::uuid,$9::uuid,$10,$11,$12,$13::timestamptz,$14::timestamptz,$15) as result`,[
    identity.tenantId,identity.subject,identity.workspaceId,correlationId,supportGrantId,command.authMethod,command.subject,command.userId,command.workspaceId,command.roleName,command.purpose,command.approvalReference,command.validFrom,command.validUntil,command.reason,
  ]);
  await notify(db,identity.tenantId,supportGrantId,"support_access_active",command);
  return {operation:"grant",supportGrantId,status:"active",requiresTenantAck:false};
}
