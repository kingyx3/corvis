import assert from 'node:assert/strict';
import { NativePostgresSqlApi } from '../../../src/platform/database/postgres-native.ts';
import { computedRowsDigest } from '../../../src/modules/research/server/research-grounding.ts';
import { pinResearchAnswer, listResearchPins } from '../../../src/modules/research/server/research-pins.ts';
import { authenticateScim, ScimError } from '../../../src/modules/identity-access/server/directory/scim.ts';
import { RateLimiter } from '../../../src/platform/http/limits/rate-limit.ts';
import { createHash } from 'node:crypto';
process.env.CORVIS_DEMO_MODE = 'false';
if (!process.env.CORVIS_DATABASE_DSN) throw new Error('CORVIS_DATABASE_DSN is required');
const db = new NativePostgresSqlApi(process.env.CORVIS_DATABASE_DSN);
const tenantId='11111111-1111-4111-8111-111111111184', workspaceId='22222222-2222-4222-8222-222222222284';
// All fixtures and mutations roll back; safe to run after the migration acceptance suites.
const rollback = new Error('ROLLBACK_REVIEW_FIXTURES');
try {
await db.transaction(async tx => {
  await tx.execute(`insert into corvis_control.tenant(tenant_id,slug,display_name) values($1,'review-revocation-fixture','Review fixture')`,[tenantId]);
  await tx.execute(`insert into corvis_control.workspace(tenant_id,workspace_id,slug,display_name) values($1,$2,'review','Review')`,[tenantId,workspaceId]);
  const sq='sq_0123456789abcdef01234567', rows=[{value_number:100}];
  const answer={answer:'Revenue was 100.',citations:[],semanticQueryIds:[sq],computedResults:[{semanticQueryId:sq,status:'executed',metricCode:'revenue',operation:'values',rows}]};
  const identity={tenantId,workspaceId,subject:'review-user',authMethod:'oidc',sessionId:'review-session',roles:['read_only'],entitlements:{workspaceIds:[workspaceId],fundIds:['fund-1'],documentIds:['doc-1'],sourceDocumentAccessAllowed:false}};
  await tx.execute(`insert into corvis_control.semantic_query_log(tenant_id,semantic_query_id,actor_subject,question_hash,result_row_count,query_shape,result_rows_sha256) values($1,$2,$3,'review',1,$4::jsonb,$5)`,[tenantId,sq,identity.subject,JSON.stringify({fundIds:['fund-1'],documentIds:['doc-1']}),computedRowsDigest(rows)]);
  await pinResearchAnswer(identity,{question:'Revenue?',answer,askedAt:'2026-09-30T00:00:00Z'},tx);
  assert.equal((await listResearchPins(identity,tx)).length,1);
  for(const entitlements of [{...identity.entitlements,fundIds:[]},{...identity.entitlements,documentIds:[]}]) {
    const revoked={...identity,entitlements};
    assert.equal((await listResearchPins(revoked,tx)).length,0);
    await assert.rejects(pinResearchAnswer(revoked,{question:'Revenue?',answer,askedAt:'2026-09-30T00:00:00Z'},tx),e=>e.code==='answer_not_permitted');
  }
  const token='r'.repeat(43), hash=createHash('sha256').update(token).digest('hex');
  await tx.execute(`insert into corvis_control.tenant_scim_configuration(tenant_id,enabled,token_sha256,auth_method,default_workspace_id,default_role_name,updated_by_subject) values($1,true,$2,'oidc',$3,'viewer','review')`,[tenantId,hash,workspaceId]);
  const request=(t=token)=>new Request('https://corvis.test/scim',{headers:{'x-corvis-tenant':tenantId,authorization:`Bearer ${t}`}});
  const limits={clientLimiter:new RateLimiter(100),tenantLimiter:new RateLimiter(1),verifiedTokens:new Map(),now:1000};
  await authenticateScim(request(),tx,limits);
  await assert.rejects(authenticateScim(request('a'.repeat(43)),tx,limits));
  await tx.execute(`update corvis_control.tenant_scim_configuration set enabled=false where tenant_id=$1`,[tenantId]);
  await assert.rejects(authenticateScim(request(),tx,limits),e=>e instanceof ScimError && e.status===401);
  throw rollback;
});
} catch (error) { if (error !== rollback) throw error; }
console.log('POSTGRES_REVIEW_SCOPE_REVOCATION_AND_SCIM_REVOCATION_PASS');
