import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { NativePostgresSqlApi } from '../../../src/lib/server/postgres-native.ts';
import { getUserPreferences, mutateSavedView, saveDisplayPreferences } from '../../../src/lib/server/user-preferences.ts';
import { PostgresProductionPlatform } from '../../../src/lib/server/platform.ts';
process.env.CORVIS_DEMO_MODE='false';
const db=new NativePostgresSqlApi(process.env.CORVIS_POSTGRES_DSN);
const rollback=new Error('ROLLBACK_PREFERENCE_FIXTURES');
const tenant='11111111-1111-4111-8111-111111111264', workspace='22222222-2222-4222-8222-222222222264', otherWorkspace='22222222-2222-4222-8222-222222222270';
try { await db.transaction(async tx=>{
  const nested={...tx,transaction: async fn=>{await tx.execute('savepoint preference_mutation');try{const result=await fn(nested);await tx.execute('release savepoint preference_mutation');return result;}catch(e){await tx.execute('rollback to savepoint preference_mutation');await tx.execute('release savepoint preference_mutation');throw e;}}};
  await tx.execute(`insert into corvis_control.tenant(tenant_id,slug,display_name) values($1,'preference-fixture','Preference fixture')`,[tenant]);
  for(const w of [workspace,otherWorkspace]) await tx.execute(`insert into corvis_control.workspace(tenant_id,workspace_id,slug,display_name) values($1::uuid,$2::uuid,$2::text,'Workspace')`,[tenant,w]);
  const owner={tenantId:tenant,workspaceId:workspace,subject:'owner',authMethod:'oidc',sessionId:'test',roles:['analyst'],entitlements:{workspaceIds:[workspace],fundIds:['fund-a'],documentIds:[],sourceDocumentAccessAllowed:false}};
  const viewer={...owner,subject:'viewer',entitlements:{...owner.entitlements,fundIds:[]}};
  await mutateSavedView(owner,{action:'create',screen:'documents',name:'Private',configuration:{query:'Fund A',columns:['Document','Status']}},nested);
  let mine=await getUserPreferences(owner,tx); const id=mine.views[0].id;
  assert.equal((await getUserPreferences(viewer,tx)).views.length,0);
  await mutateSavedView(owner,{action:'share',screen:'documents',id,shared:true},nested);
  const shared=await getUserPreferences(viewer,tx); assert.equal(shared.views.length,1);assert.equal(shared.views[0].owned,false);assert.deepEqual(viewer.entitlements.fundIds,[]);
  for(const action of ['rename','delete','share']) await assert.rejects(mutateSavedView(viewer,{action,screen:'documents',id,name:'Hijacked',shared:false},nested),e=>e.status===404);
  await mutateSavedView(viewer,{action:'default',screen:'documents',id},nested);
  assert.equal((await getUserPreferences(viewer,tx)).defaults.documents,id);
  assert.equal((await getUserPreferences({...owner,workspaceId:otherWorkspace},tx)).views.length,0);
  assert.equal((await getUserPreferences({...owner,tenantId:'11111111-1111-4111-8111-111111111999'},tx)).views.length,0);
  await assert.rejects(mutateSavedView({...owner,workspaceId:otherWorkspace},{action:'delete',screen:'documents',id},nested),e=>e.status===404);
  const display={timeZone:'America/Los_Angeles',dateFormat:'iso',numberFormat:'de-DE'};
  await saveDisplayPreferences(owner,display,nested);assert.deepEqual((await getUserPreferences(owner,tx)).display,display);
  assert.deepEqual((await getUserPreferences({...owner,workspaceId:otherWorkspace},tx)).display,display);
  assert.equal((await getUserPreferences(viewer,tx)).display,null);
  await mutateSavedView(owner,{action:'rename',screen:'documents',id,name:'Renamed'},nested);
  assert.equal((await getUserPreferences(viewer,tx)).views[0].name,'Renamed');
  await mutateSavedView(owner,{action:'delete',screen:'documents',id},nested);assert.equal((await getUserPreferences(viewer,tx)).views.length,0);
  // Published-history reads preserve subject/metric, choose the most recent four economic periods,
  // and disappear when the source-document or fund entitlement is revoked.
  const doc=randomUUID(),artifact=randomUUID(),ref=randomUUID(),snapshot=randomUUID();
  await tx.execute(`insert into corvis_source.document(tenant_id,document_id,display_name,media_type,status,created_by) values($1,$2,'History.pdf','application/pdf','published','fixture')`,[tenant,doc]);
  await tx.execute(`insert into corvis_source.document_artifact_version(tenant_id,document_artifact_version_id,document_id,ingestion_id,object_uri,size_bytes,storage_generation,malware_scan_status,quarantine_status) values($1,$2,$3,'history-fixture','gs://test/history',1,'42','clean','released')`,[tenant,artifact,doc]);
  await tx.execute(`insert into corvis_source.source_reference(tenant_id,source_reference_id,document_id,document_artifact_version_id) values($1,$2,$3,$4)`,[tenant,ref,doc,artifact]);
  const periods=['Q1 2025','Q2 2025','Q3 2025','Q4 2025','Q1 2026'];
  for(let index=0;index<periods.length;index++) {
    const observation=randomUUID(),fact=randomUUID(),pastSnapshot=randomUUID(),published=`${index===4?'2026':'2025'}-${String((index%4)*3+3).padStart(2,'0')}-28T00:00:00Z`;
    await tx.execute(`insert into corvis_facts.observation(tenant_id,observation_id,fund_id,company_id,metric_code,value_number,currency,economic_period,review_state,source_reference_id,schema_version) values($1,$2,'fund-a','company-a','revenue',$3,'USD',$4,'approved',$5,'v1')`,[tenant,observation,100+index,periods[index],ref]);
    await tx.execute(`insert into corvis_consolidated.consolidated_fact(tenant_id,consolidated_fact_id,fund_id,subject_type,subject_id,metric_code,economic_period,value,source_observation_ids,consolidation_rule_version) values($1,$2,'fund-a','company','company-a','revenue',$3,$4::jsonb,array[$5::uuid],'fixture')`,[tenant,fact,periods[index],JSON.stringify({number:100+index,currency:'USD',semanticDimensions:{subjectLevel:'company'},isRestatement:index===3}),observation]);
    await tx.execute(`insert into corvis_consolidated.fund_period_snapshot(tenant_id,snapshot_id,fund_id,report_period,version,status,fact_ids,schema_version,taxonomy_version,published_at,created_at) values($1,$2,'fund-a',$3,1,'published',array[$4::uuid],'v1','v1',$5::timestamptz,$5::timestamptz)`,[tenant,pastSnapshot,periods[index],fact,published]);
  }
  await tx.execute(`insert into corvis_consolidated.fund_period_snapshot(tenant_id,snapshot_id,fund_id,report_period,version,status,schema_version,taxonomy_version,created_at) values($1,$2,'fund-a','Q2 2026',1,'blocked','v1','v1','2026-07-01')`,[tenant,snapshot]);
  await tx.execute(`insert into corvis_consolidated.reconciliation_exception(tenant_id,snapshot_id,snapshot_version,exception_key,fund_id,report_period,exception_type,subject_type,subject_id,metric_code,summary,created_by,created_at,context) values($1,$2,1,'history','fund-a','Q2 2026','source_authority','company','company-a','revenue','History fixture','fixture','2026-07-01',$3::jsonb)`,[tenant,snapshot,JSON.stringify({observations:[{value:{number:105,currency:'USD'}}]})]);
  const reader={...owner,entitlements:{...owner.entitlements,documentIds:[doc]}};
  const platform=new PostgresProductionPlatform(tx);
  const exceptions=await platform.listReconciliationExceptions(reader,snapshot,1);
  assert.equal(exceptions.length,1);const history=exceptions[0].context.publishedHistory;
  assert.deepEqual(history.map(p=>p.reportPeriod),['Q2 2025','Q3 2025','Q4 2025','Q1 2026']);assert.equal(history[2].restated,true);
  assert.equal((await platform.listReconciliationExceptions(owner,snapshot,1))[0].context.publishedHistory.length,0);
  assert.equal((await platform.listReconciliationExceptions(viewer,snapshot,1)).length,0);
  throw rollback;
}); } catch(e){if(e!==rollback)throw e;} finally {await db.close();}
console.log('POSTGRES_USER_PREFERENCES_OWNERSHIP_SHARING_AND_HISTORY_QUERY_PASS');
