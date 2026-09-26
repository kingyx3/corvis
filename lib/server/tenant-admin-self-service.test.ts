import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { parseBulkInviteCsv, tenantAccessAuditCsv, SUPPORT_ACK_THRESHOLD_HOURS } from "./tenant-admin-self-service.ts";
import { supportAccessRequiresTenantAck } from "./support-access-self-service.ts";

const workspace="11111111-1111-4111-8111-111111111111";

test("bulk invite CSV validates rows and supports quoted names",()=>{
  const parsed=parseBulkInviteCsv(`name,email,role,workspaceId,reason\n"Doe, Jane",jane@example.com,reviewer,${workspace},Finance onboarding\nBad,bad,owner,not-a-uuid,x`);
  assert.equal(parsed.rows.length,1);assert.equal(parsed.rows[0]?.name,"Doe, Jane");assert.equal(parsed.rows[0]?.email,"jane@example.com");assert.equal(parsed.errors.length,1);assert.equal(parsed.errors[0]?.row,3);
});

test("tenant access CSV quotes metadata without leaking columns",()=>{
  const csv=tenantAccessAuditCsv([{auditEventId:"a",occurredAt:"2026-09-26T00:00:00Z",actorSubject:"admin@example.com",action:"tenant_invitation.issued",targetType:"tenant_invitation",targetId:"i",outcome:"success",metadata:{email:"a,b@example.com"}}]);
  assert.match(csv,/occurred_at,actor,action/);assert.match(csv,/"\{""email"":""a,b@example.com""\}"/);
});

test("support acknowledgement threshold covers privilege and duration",()=>{
  const base={supportGrantId:null,authMethod:"oidc" as const,subject:"support",userId:workspace,workspaceId:workspace,roleName:"reviewer",purpose:"diagnostic",approvalReference:"INC-1",validFrom:"2026-09-26T00:00:00.000Z",validUntil:"2026-09-26T03:00:00.000Z",reason:"diagnostic"};
  assert.equal(SUPPORT_ACK_THRESHOLD_HOURS,4);assert.equal(supportAccessRequiresTenantAck(base),false);assert.equal(supportAccessRequiresTenantAck({...base,roleName:"tenant_admin"}),true);assert.equal(supportAccessRequiresTenantAck({...base,validUntil:"2026-09-26T05:00:01.000Z"}),true);
});

test("migration persists notification, acknowledgement and SCIM state behind server-only RLS",async()=>{
  const sql=(await readFile("db/postgres/migrations/060_tenant_admin_self_service.sql","utf8")).toLowerCase();
  for(const relation of ["tenant_access_notification","tenant_scim_configuration","tenant_scim_identity"])assert.match(sql,new RegExp(`create table if not exists corvis_control\\.${relation}`));
  assert.match(sql,/pending_ack/);assert.match(sql,/acknowledged_by_subject/);assert.match(sql,/force row level security/);assert.doesNotMatch(sql,/create policy/);
});

test("tenant-facing routes enforce admin scope and expose audit CSV, notices, bulk invite and pending invite actions",async()=>{
  const paths=["app/api/v1/access/audit/route.ts","app/api/v1/access/support/route.ts","app/api/v1/access/invitations/bulk/route.ts","app/api/v1/access/invitations/[invitationId]/route.ts"];
  for(const path of paths){const source=await readFile(path,"utf8");assert.match(source,/admin:manage/);assert.match(source,/tenant_admin_required/);}
  assert.match(await readFile(paths[0],"utf8"),/text\/csv/);assert.match(await readFile(paths[2],"utf8"),/parseBulkInviteCsv/);assert.match(await readFile(paths[3],"utf8"),/resendTenantInvitation/);assert.match(await readFile(paths[3],"utf8"),/revokeTenantInvitation/);
});

test("customer and operations UI surfaces all #181 controls",async()=>{
  const page=await readFile("app/access-self-service/page.tsx","utf8");for(const phrase of ["Bulk invite users by CSV","Pending invitations","Access audit trail","Acknowledge & activate","What each role means","Export CSV"])assert.ok(page.includes(phrase),phrase);
  const switcher=await readFile("components/workspace/workspace-switcher.tsx","utf8");assert.match(switcher,/Corvis support session active/);assert.match(switcher,/supportAccess\.purpose/);assert.match(switcher,/supportAccess\.expiresAt/);
  const health=await readFile("app/admin/tenant-health/page.tsx","utf8");assert.match(health,/Tenant health/);assert.match(health,/Pending support ack/);
});

test("SCIM endpoints are token authenticated and lifecycle-backed",async()=>{
  const scim=await readFile("lib/server/scim.ts","utf8");assert.match(scim,/token_sha256/);assert.match(scim,/PostgresIdentityLifecycleRepository/);assert.match(scim,/reactivate_identity_admin/);assert.match(scim,/SCIM deprovision/);
  const users=await readFile("app/api/v1/scim/v2/Users/route.ts","utf8");const user=await readFile("app/api/v1/scim/v2/Users/[id]/route.ts","utf8");assert.match(users,/authenticateScim/);assert.match(user,/setScimUserActive/);
});
