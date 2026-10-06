-- End-to-end execution of the database-side processing stages that #218 repaired
-- (SQLSTATE 42702) but that nothing ever ran:
--   canonicalize_reviewed_extraction_v4 -> reconcile_canonicalization
--   -> consolidate_reconciliation -> publish_consolidation
-- Each stage is driven the way production drives it: a running processing job plus
-- a `started` stage effect keyed by the idempotency key exist before the function
-- is called, the predecessor stage's effect is `complete` with its documented
-- result, and the predecessor job is `succeeded` (which fires the real
-- enforce_ready_*_before_success guards). Also covers idempotent replay (same key
-- -> same run ids, no duplicate rows) and stage-boundary negatives.
-- Run after the full migration chain on an isolated disposable database. The whole
-- scenario is one transaction and is rolled back.

\set ON_ERROR_STOP on

begin;

create temporary table e2e_ids (name text primary key, id uuid, extra text) on commit drop;

-- ---------------------------------------------------------------- seed
insert into corvis_control.tenant (tenant_id,slug,display_name)
values ('e2e00000-0000-4000-8000-000000000001','stage-pipeline-ci','Stage Pipeline CI');

insert into corvis_source.document (tenant_id,document_id,display_name,media_type,status,created_by)
values ('e2e00000-0000-4000-8000-000000000001','e2e00000-0000-4000-8000-000000000002',
        'Stage pipeline fixture','application/pdf','registered','ci');

insert into corvis_source.document_artifact_version (
  tenant_id,document_artifact_version_id,document_id,ingestion_id,object_uri,
  size_bytes,sha256,storage_generation,malware_scan_status,quarantine_status
) values (
  'e2e00000-0000-4000-8000-000000000001','e2e00000-0000-4000-8000-000000000003',
  'e2e00000-0000-4000-8000-000000000002','stage-pipeline-ci-v1','gs://ci-fixture/pipeline.pdf',
  1024,repeat('1',64),'1','clean','released'
);

insert into corvis_source.document_representation (
  tenant_id,representation_id,document_id,document_artifact_version_id,
  representation_type,object_uri,storage_generation,content_sha256,size_bytes,
  producer,producer_version,method,status
) values (
  'e2e00000-0000-4000-8000-000000000001','e2e00000-0000-4000-8000-000000000004',
  'e2e00000-0000-4000-8000-000000000002','e2e00000-0000-4000-8000-000000000003',
  'document_interpretation_v1','gs://ci-fixture/pipeline-representation.json','1',repeat('2',64),2048,
  'ci','1','native','ready'
);

insert into corvis_source.extraction_run (
  tenant_id,extraction_run_id,document_id,document_artifact_version_id,representation_id,
  extraction_contract_version,schema_version,skill_id,skill_version,bundle_object_uri,
  bundle_storage_generation,bundle_content_sha256,bundle_size_bytes,producer,producer_version,
  model_provider,model_name,model_version,status,candidate_count,candidate_set_sha256,completed_at
) values (
  'e2e00000-0000-4000-8000-000000000001','e2e00000-0000-4000-8000-000000000005',
  'e2e00000-0000-4000-8000-000000000002','e2e00000-0000-4000-8000-000000000003',
  'e2e00000-0000-4000-8000-000000000004','1','1.2','quarterly_fund_report_extraction','1.6',
  'gs://ci-fixture/pipeline-candidates.jsonl','1',repeat('3',64),4096,'ci','1','ci','extractor','1',
  'ready',6,repeat('a',64),now()
);

-- One fund -> company-target holding -> instrument graph with two metric observations.
-- period_type/period_start/period_end are mandatory: reconciliation requires exactly
-- one explicit report period per canonicalization run.
insert into corvis_source.extraction_candidate (
  tenant_id,extraction_run_id,candidate_id,candidate_key,document_id,representation_id,
  candidate_type,payload,confidence,provenance,exception_codes,source_reference_count
) values
('e2e00000-0000-4000-8000-000000000001','e2e00000-0000-4000-8000-000000000005',
 'e2e60000-0000-4000-8000-000000000001','fund:e2e','e2e00000-0000-4000-8000-000000000002',
 'e2e00000-0000-4000-8000-000000000004','fund',
 '{"global_fund_id":"e2e-fund","canonical_name":"Pipeline Fund I","source_name":"Pipeline Fund I"}',
 '{"entity":0.99}','{"fixture":"ci"}','[]',1),
('e2e00000-0000-4000-8000-000000000001','e2e00000-0000-4000-8000-000000000005',
 'e2e60000-0000-4000-8000-000000000002','company:e2e','e2e00000-0000-4000-8000-000000000002',
 'e2e00000-0000-4000-8000-000000000004','company',
 '{"global_company_id":"e2e-company","canonical_name":"Pipeline Company","source_name":"Project Pipeline"}',
 '{"entity":0.99}','{"fixture":"ci"}','[]',1),
('e2e00000-0000-4000-8000-000000000001','e2e00000-0000-4000-8000-000000000005',
 'e2e60000-0000-4000-8000-000000000003','holding:e2e','e2e00000-0000-4000-8000-000000000002',
 'e2e00000-0000-4000-8000-000000000004','holding',
 '{"holding_id":"e2e00000-0000-4000-8000-000000000077","fund_id":"e2e-fund","target_type":"company","target_company_id":"e2e-company"}',
 '{"entity":0.99}','{"fixture":"ci"}','[]',1),
('e2e00000-0000-4000-8000-000000000001','e2e00000-0000-4000-8000-000000000005',
 'e2e60000-0000-4000-8000-000000000004','instrument:e2e','e2e00000-0000-4000-8000-000000000002',
 'e2e00000-0000-4000-8000-000000000004','instrument',
 '{"instrument_id":"e2e00000-0000-4000-8000-000000000088","holding_id":"e2e00000-0000-4000-8000-000000000077","instrument_type":"equity","security_name":"Common Equity","currency":"USD"}',
 '{"entity":0.99}','{"fixture":"ci"}','[]',1),
('e2e00000-0000-4000-8000-000000000001','e2e00000-0000-4000-8000-000000000005',
 'e2e60000-0000-4000-8000-000000000005','metric:fair_value','e2e00000-0000-4000-8000-000000000002',
 'e2e00000-0000-4000-8000-000000000004','metric_observation',
 '{"fund_id":"e2e-fund","company_id":"e2e-company","holding_id":"e2e00000-0000-4000-8000-000000000077","instrument_id":"e2e00000-0000-4000-8000-000000000088","metric_code":"e2e_fair_value","subject_type":"instrument_position","subject_level":"instrument","value_numeric":"123.45","currency":"USD","actuality":"actual","period_type":"quarter","period_start":"2026-01-01","period_end":"2026-03-31"}',
 '{"value":0.99,"entity":0.99}','{"fixture":"ci"}','[]',1),
('e2e00000-0000-4000-8000-000000000001','e2e00000-0000-4000-8000-000000000005',
 'e2e60000-0000-4000-8000-000000000006','metric:cost','e2e00000-0000-4000-8000-000000000002',
 'e2e00000-0000-4000-8000-000000000004','metric_observation',
 '{"fund_id":"e2e-fund","company_id":"e2e-company","holding_id":"e2e00000-0000-4000-8000-000000000077","instrument_id":"e2e00000-0000-4000-8000-000000000088","metric_code":"e2e_cost","subject_type":"instrument_position","subject_level":"instrument","value_numeric":"100.00","currency":"USD","actuality":"actual","period_type":"quarter","period_start":"2026-01-01","period_end":"2026-03-31"}',
 '{"value":0.99,"entity":0.99}','{"fixture":"ci"}','[]',1);

insert into corvis_source.extraction_candidate_source_reference (
  tenant_id,extraction_run_id,candidate_id,source_reference_id,reference_key,
  document_id,representation_id,page_number,source_text,extraction_method
)
select
  'e2e00000-0000-4000-8000-000000000001'::uuid,'e2e00000-0000-4000-8000-000000000005'::uuid,
  c.candidate_id,
  ('e2e70000-0000-4000-8000-' || lpad(row_number() over (order by c.candidate_key)::text,12,'0'))::uuid,
  'ref:' || c.candidate_key,'e2e00000-0000-4000-8000-000000000002'::uuid,
  'e2e00000-0000-4000-8000-000000000004'::uuid,1,c.candidate_key,'native_text'
from corvis_source.extraction_candidate c
where c.tenant_id='e2e00000-0000-4000-8000-000000000001'
  and c.extraction_run_id='e2e00000-0000-4000-8000-000000000005';

insert into corvis_review.candidate_review_requirement (
  tenant_id,extraction_run_id,candidate_id,review_policy_version,candidate_fingerprint_sha256,
  risk_tier,required_approvals,requires_exception_resolution,blocking_reasons
)
select tenant_id,extraction_run_id,candidate_id,'candidate_review_v1',
       encode(digest(candidate_id::text,'sha256'),'hex'),'standard',1,false,'[]'::jsonb
from corvis_source.extraction_candidate
where tenant_id='e2e00000-0000-4000-8000-000000000001'
  and extraction_run_id='e2e00000-0000-4000-8000-000000000005';

insert into corvis_review.extraction_review_gate (
  tenant_id,extraction_run_id,review_policy_version,candidate_set_sha256,decision_set_sha256,
  status,candidate_count,blocking_candidate_count,critical_candidate_count,exception_candidate_count
) values (
  'e2e00000-0000-4000-8000-000000000001','e2e00000-0000-4000-8000-000000000005',
  'candidate_review_v1',repeat('a',64),repeat('b',64),'ready',6,0,0,0
);

insert into corvis_semantic.metric_definition (
  metric_code,definition_version,display_name,data_type,aggregation_behavior,unit_type,active
) values
  ('e2e_fair_value','1','Pipeline fair value','numeric','none','currency',true),
  ('e2e_cost','1','Pipeline cost','numeric','none','currency',true);

-- Predecessor: the reviewed stage succeeded (fires the real review guard).
insert into corvis_control.processing_job (tenant_id,job_id,document_id,stage,state,attempt,max_attempts,correlation_id,version)
values ('e2e00000-0000-4000-8000-000000000001','reviewed:e2e00000-0000-4000-8000-000000000002',
        'e2e00000-0000-4000-8000-000000000002','reviewed','running',1,3,'stage-pipeline-ci',1);
insert into corvis_control.processing_stage_effect (tenant_id,job_id,effect_key,document_id,stage,state,attempt_count,completed_at,result)
values ('e2e00000-0000-4000-8000-000000000001','reviewed:e2e00000-0000-4000-8000-000000000002',
  'reviewed-fixture','e2e00000-0000-4000-8000-000000000002','reviewed','complete',1,now(),
  jsonb_build_object('extractionRunId','e2e00000-0000-4000-8000-000000000005',
    'reviewPolicyVersion','candidate_review_v1','candidateSetSha256',repeat('a',64),
    'decisionSetSha256',repeat('b',64),'canonicalizationReady',true));
update corvis_control.processing_job set state='succeeded',version=version+1
where tenant_id='e2e00000-0000-4000-8000-000000000001'
  and job_id='reviewed:e2e00000-0000-4000-8000-000000000002';

-- ------------------------------------------------- stage 1: canonicalized
insert into corvis_control.processing_job (tenant_id,job_id,document_id,stage,state,attempt,max_attempts,correlation_id,version)
values ('e2e00000-0000-4000-8000-000000000001','canonicalized:e2e00000-0000-4000-8000-000000000002',
        'e2e00000-0000-4000-8000-000000000002','canonicalized','running',1,3,'stage-pipeline-ci',1);
insert into corvis_control.processing_stage_effect (tenant_id,job_id,effect_key,document_id,stage,state,attempt_count)
values ('e2e00000-0000-4000-8000-000000000001','canonicalized:e2e00000-0000-4000-8000-000000000002',
        'e2e-canonicalize','e2e00000-0000-4000-8000-000000000002','canonicalized','started',1);

do $$
declare r record;
begin
  select * into r from corvis_facts.canonicalize_reviewed_extraction_v4(
    'e2e00000-0000-4000-8000-000000000001','e2e00000-0000-4000-8000-000000000002',
    'e2e00000-0000-4000-8000-000000000005','candidate_review_v1',repeat('a',64),repeat('b',64),
    'e2e-canonicalize');
  if r.candidate_count <> 6 or r.canonical_candidate_count <> 6 or r.observation_count <> 2 then
    raise exception 'unexpected canonicalization counts: %', r;
  end if;
  insert into e2e_ids values ('canonicalization', r.canonicalization_run_id,
    r.observation_count || ':' || r.source_reference_count);

  -- Commit the stage effect exactly as the worker does, then succeed the job (real guard).
  update corvis_control.processing_stage_effect
  set state='complete',completed_at=now(),result=jsonb_build_object(
    'canonicalizationRunId',r.canonicalization_run_id::text,
    'extractionRunId','e2e00000-0000-4000-8000-000000000005',
    'candidateSetSha256',repeat('a',64),'decisionSetSha256',repeat('b',64),
    'reviewPolicyVersion','candidate_review_v1')
  where tenant_id='e2e00000-0000-4000-8000-000000000001'
    and job_id='canonicalized:e2e00000-0000-4000-8000-000000000002' and effect_key='e2e-canonicalize';
  update corvis_control.processing_job set state='succeeded',version=version+1
  where tenant_id='e2e00000-0000-4000-8000-000000000001'
    and job_id='canonicalized:e2e00000-0000-4000-8000-000000000002';
end $$;

-- --------------------------------------------------- stage 2: reconciled
insert into corvis_control.processing_job (tenant_id,job_id,document_id,stage,state,attempt,max_attempts,correlation_id,version)
values ('e2e00000-0000-4000-8000-000000000001','reconciled:e2e00000-0000-4000-8000-000000000002',
        'e2e00000-0000-4000-8000-000000000002','reconciled','running',1,3,'stage-pipeline-ci',1);
insert into corvis_control.processing_stage_effect (tenant_id,job_id,effect_key,document_id,stage,state,attempt_count)
values ('e2e00000-0000-4000-8000-000000000001','reconciled:e2e00000-0000-4000-8000-000000000002',
        'e2e-reconcile','e2e00000-0000-4000-8000-000000000002','reconciled','started',1);

do $$
declare
  canon uuid := (select id from e2e_ids where name='canonicalization');
  obs integer := (select split_part(extra,':',1)::integer from e2e_ids where name='canonicalization');
  refs integer := (select split_part(extra,':',2)::integer from e2e_ids where name='canonicalization');
  r record; r2 record; failure text; n integer;
begin
  -- Negative: a wrong reviewed hash never reconciles.
  begin
    perform corvis_consolidated.reconcile_canonicalization(
      'e2e00000-0000-4000-8000-000000000001','e2e00000-0000-4000-8000-000000000002',canon,
      'e2e00000-0000-4000-8000-000000000005',repeat('c',64),repeat('b',64),obs,refs,'e2e-reconcile');
    raise exception 'a wrong candidate-set hash must be rejected';
  exception when others then
    get stacked diagnostics failure = message_text;
    if failure <> 'reconciliation requires exact ready canonicalization run' then
      raise exception 'unexpected wrong-hash failure: %', failure;
    end if;
  end;

  -- Negative: an idempotency key with no started reconciled effect cannot borrow the
  -- canonicalized predecessor (stage boundary is re-checked inside Postgres).
  begin
    perform corvis_consolidated.reconcile_canonicalization(
      'e2e00000-0000-4000-8000-000000000001','e2e00000-0000-4000-8000-000000000002',canon,
      'e2e00000-0000-4000-8000-000000000005',repeat('a',64),repeat('b',64),obs,refs,'e2e-no-such-effect');
    raise exception 'a call without a started reconciled effect must be rejected';
  exception when others then
    get stacked diagnostics failure = message_text;
    if failure <> 'reconciliation requires committed canonicalized-stage predecessor effect' then
      raise exception 'unexpected missing-effect failure: %', failure;
    end if;
  end;

  select * into r from corvis_consolidated.reconcile_canonicalization(
    'e2e00000-0000-4000-8000-000000000001','e2e00000-0000-4000-8000-000000000002',canon,
    'e2e00000-0000-4000-8000-000000000005',repeat('a',64),repeat('b',64),obs,refs,'e2e-reconcile');
  if not r.reconciliation_ready or r.blocking_exception_count <> 0 or r.observation_count <> 2
     or r.snapshot_version <> 1 or r.fund_id <> 'e2e-fund' or r.report_period <> '2026-03-31' then
    raise exception 'unexpected reconciliation result: %', r;
  end if;

  -- Replay with the same key: same run/snapshot ids, no duplicate rows.
  select * into r2 from corvis_consolidated.reconcile_canonicalization(
    'e2e00000-0000-4000-8000-000000000001','e2e00000-0000-4000-8000-000000000002',canon,
    'e2e00000-0000-4000-8000-000000000005',repeat('a',64),repeat('b',64),obs,refs,'e2e-reconcile');
  if r2.reconciliation_run_id <> r.reconciliation_run_id or r2.snapshot_id <> r.snapshot_id
     or not r2.reconciliation_ready then
    raise exception 'reconciliation replay must return the same run: % vs %', r, r2;
  end if;
  select count(*) into n from corvis_consolidated.reconciliation_run
    where tenant_id='e2e00000-0000-4000-8000-000000000001';
  if n <> 1 then raise exception 'expected one reconciliation run, got %', n; end if;
  select count(*) into n from corvis_consolidated.fund_period_snapshot
    where tenant_id='e2e00000-0000-4000-8000-000000000001';
  if n <> 1 then raise exception 'expected one draft snapshot, got %', n; end if;
  select count(*) into n from corvis_consolidated.reconciliation_exception
    where tenant_id='e2e00000-0000-4000-8000-000000000001';
  if n <> 0 then raise exception 'expected no reconciliation exceptions, got %', n; end if;

  insert into e2e_ids values ('reconciliation', r.reconciliation_run_id, null), ('snapshot', r.snapshot_id, null);

  update corvis_control.processing_stage_effect
  set state='complete',completed_at=now(),result=jsonb_build_object(
    'reconciliationRunId',r.reconciliation_run_id::text,'snapshotId',r.snapshot_id::text,
    'snapshotVersion',r.snapshot_version,'reconciliationReady',true,'blockingExceptionCount',0)
  where tenant_id='e2e00000-0000-4000-8000-000000000001'
    and job_id='reconciled:e2e00000-0000-4000-8000-000000000002' and effect_key='e2e-reconcile';
  update corvis_control.processing_job set state='succeeded',version=version+1
  where tenant_id='e2e00000-0000-4000-8000-000000000001'
    and job_id='reconciled:e2e00000-0000-4000-8000-000000000002';
end $$;

-- -------------------------------------------------- stage 3: consolidated
insert into corvis_control.processing_job (tenant_id,job_id,document_id,stage,state,attempt,max_attempts,correlation_id,version)
values ('e2e00000-0000-4000-8000-000000000001','consolidated:e2e00000-0000-4000-8000-000000000002',
        'e2e00000-0000-4000-8000-000000000002','consolidated','running',1,3,'stage-pipeline-ci',1);
insert into corvis_control.processing_stage_effect (tenant_id,job_id,effect_key,document_id,stage,state,attempt_count)
values ('e2e00000-0000-4000-8000-000000000001','consolidated:e2e00000-0000-4000-8000-000000000002',
        'e2e-consolidate','e2e00000-0000-4000-8000-000000000002','consolidated','started',1);

do $$
declare
  rec uuid := (select id from e2e_ids where name='reconciliation');
  snap uuid := (select id from e2e_ids where name='snapshot');
  r record; r2 record; failure text; n integer; facts uuid[];
begin
  -- Negative: the predecessor observation count is pinned.
  begin
    perform corvis_consolidated.consolidate_reconciliation(
      'e2e00000-0000-4000-8000-000000000001','e2e00000-0000-4000-8000-000000000002',rec,snap,1,99,'e2e-consolidate');
    raise exception 'a changed observation count must be rejected';
  exception when others then
    get stacked diagnostics failure = message_text;
    if failure <> 'consolidation predecessor observation count changed' then
      raise exception 'unexpected count-mismatch failure: %', failure;
    end if;
  end;

  select * into r from corvis_consolidated.consolidate_reconciliation(
    'e2e00000-0000-4000-8000-000000000001','e2e00000-0000-4000-8000-000000000002',rec,snap,1,2,'e2e-consolidate');
  if not r.consolidation_ready or r.fact_count <> 2 or r.source_observation_count <> 2
     or r.fund_id <> 'e2e-fund' or r.snapshot_version <> 1 then
    raise exception 'unexpected consolidation result: %', r;
  end if;

  select * into r2 from corvis_consolidated.consolidate_reconciliation(
    'e2e00000-0000-4000-8000-000000000001','e2e00000-0000-4000-8000-000000000002',rec,snap,1,2,'e2e-consolidate');
  if r2.consolidation_run_id <> r.consolidation_run_id or r2.fact_count <> 2 then
    raise exception 'consolidation replay must return the same run: % vs %', r, r2;
  end if;
  select count(*) into n from corvis_consolidated.consolidation_run
    where tenant_id='e2e00000-0000-4000-8000-000000000001';
  if n <> 1 then raise exception 'expected one consolidation run, got %', n; end if;
  select count(*) into n from corvis_consolidated.consolidated_fact
    where tenant_id='e2e00000-0000-4000-8000-000000000001';
  if n <> 2 then raise exception 'expected two consolidated facts, got %', n; end if;
  select fact_ids into facts from corvis_consolidated.fund_period_snapshot
    where tenant_id='e2e00000-0000-4000-8000-000000000001' and snapshot_id=snap and version=1;
  if cardinality(facts) <> 2 then raise exception 'draft snapshot must reference both facts'; end if;

  insert into e2e_ids values ('consolidation', r.consolidation_run_id, null);

  update corvis_control.processing_stage_effect
  set state='complete',completed_at=now(),result=jsonb_build_object(
    'consolidationRunId',r.consolidation_run_id::text,'snapshotId',snap::text,
    'snapshotVersion',1,'consolidationReady',true,'factCount',r.fact_count)
  where tenant_id='e2e00000-0000-4000-8000-000000000001'
    and job_id='consolidated:e2e00000-0000-4000-8000-000000000002' and effect_key='e2e-consolidate';
  update corvis_control.processing_job set state='succeeded',version=version+1
  where tenant_id='e2e00000-0000-4000-8000-000000000001'
    and job_id='consolidated:e2e00000-0000-4000-8000-000000000002';
end $$;

-- ---------------------------------------------------- stage 4: published
insert into corvis_control.processing_job (tenant_id,job_id,document_id,stage,state,attempt,max_attempts,correlation_id,version)
values ('e2e00000-0000-4000-8000-000000000001','published:e2e00000-0000-4000-8000-000000000002',
        'e2e00000-0000-4000-8000-000000000002','published','running',1,3,'stage-pipeline-ci',1);
insert into corvis_control.processing_stage_effect (tenant_id,job_id,effect_key,document_id,stage,state,attempt_count)
values ('e2e00000-0000-4000-8000-000000000001','published:e2e00000-0000-4000-8000-000000000002',
        'e2e-publish','e2e00000-0000-4000-8000-000000000002','published','started',1);

do $$
declare
  cons uuid := (select id from e2e_ids where name='consolidation');
  snap uuid := (select id from e2e_ids where name='snapshot');
  r record; r2 record; failure text; n integer; snapshot_row record;
begin
  -- Negative: publishing under a key with no started published effect is refused.
  begin
    perform corvis_consolidated.publish_consolidation(
      'e2e00000-0000-4000-8000-000000000001','e2e00000-0000-4000-8000-000000000002',cons,snap,1,'e2e-no-such-effect');
    raise exception 'publication without a started published effect must be rejected';
  exception when others then
    get stacked diagnostics failure = message_text;
    if failure <> 'publication requires committed consolidated-stage predecessor effect' then
      raise exception 'unexpected publish failure: %', failure;
    end if;
  end;

  select * into r from corvis_consolidated.publish_consolidation(
    'e2e00000-0000-4000-8000-000000000001','e2e00000-0000-4000-8000-000000000002',cons,snap,1,'e2e-publish');
  if not r.publication_ready or r.fact_count <> 2 or r.source_snapshot_version <> 1 or r.snapshot_version <> 2 then
    raise exception 'unexpected publication result: %', r;
  end if;

  select * into r2 from corvis_consolidated.publish_consolidation(
    'e2e00000-0000-4000-8000-000000000001','e2e00000-0000-4000-8000-000000000002',cons,snap,1,'e2e-publish');
  if r2.publication_run_id <> r.publication_run_id or r2.publication_event_id <> r.publication_event_id
     or r2.snapshot_version <> 2 then
    raise exception 'publication replay must return the same run: % vs %', r, r2;
  end if;

  select count(*) into n from corvis_consolidated.publication_run
    where tenant_id='e2e00000-0000-4000-8000-000000000001';
  if n <> 1 then raise exception 'expected one publication run, got %', n; end if;
  select count(*) into n from corvis_consolidated.snapshot_publication_event
    where tenant_id='e2e00000-0000-4000-8000-000000000001' and action='publish';
  if n <> 1 then raise exception 'expected one publication event, got %', n; end if;
  select count(*) into n from corvis_control.outbox_event
    where tenant_id='e2e00000-0000-4000-8000-000000000001' and event_type='SnapshotPublicationChanged';
  if n <> 1 then raise exception 'expected one SnapshotPublicationChanged outbox event, got %', n; end if;

  select * into snapshot_row from corvis_consolidated.fund_period_snapshot
    where tenant_id='e2e00000-0000-4000-8000-000000000001' and snapshot_id=snap and version=2;
  if snapshot_row.status <> 'published' or cardinality(snapshot_row.fact_ids) <> 2 or snapshot_row.published_at is null then
    raise exception 'published snapshot version 2 is wrong: %', snapshot_row;
  end if;
  if (select status from corvis_consolidated.fund_period_snapshot
      where tenant_id='e2e00000-0000-4000-8000-000000000001' and snapshot_id=snap and version=1) <> 'draft' then
    raise exception 'the source draft version must remain immutable history';
  end if;

  -- Complete the published stage through the real publication guard.
  update corvis_control.processing_stage_effect
  set state='complete',completed_at=now(),result=jsonb_build_object(
    'publicationRunId',r.publication_run_id::text,'snapshotId',snap::text,
    'sourceSnapshotVersion',1,'snapshotVersion',2,'publicationEventId',r.publication_event_id::text,
    'publicationReady',true,'factCount',r.fact_count)
  where tenant_id='e2e00000-0000-4000-8000-000000000001'
    and job_id='published:e2e00000-0000-4000-8000-000000000002' and effect_key='e2e-publish';
  update corvis_control.processing_job set state='succeeded',version=version+1
  where tenant_id='e2e00000-0000-4000-8000-000000000001'
    and job_id='published:e2e00000-0000-4000-8000-000000000002';
end $$;

-- ---------------------------- correction replay of the published snapshot
-- request_data_correction_replay resolves the exact retained clean artifact behind
-- the published snapshot's facts and enqueues a namespaced `registered` job.
do $$
declare
  snap uuid := (select id from e2e_ids where name='snapshot');
  incident uuid := 'e2e00000-0000-4000-8000-0000000000c1';
  job_id_value text;
  again text;
  failure text;
  n integer;
  incident_row record;
  expected_job text := 'correction:e2e00000-0000-4000-8000-0000000000c1:registered:e2e00000-0000-4000-8000-000000000002';
begin
  perform corvis_control.open_data_correction_incident(
    'e2e00000-0000-4000-8000-000000000001',incident,'e2e-correction',repeat('d',64),
    'e2e-fund','2026-03-31',null,snap,2,'e2e00000-0000-4000-8000-000000000002',
    'wrong currency on fair value','restate fair value','ci');

  -- An unknown incident is a clean null, not an error.
  if corvis_control.request_data_correction_replay(
       'e2e00000-0000-4000-8000-000000000001','e2e00000-0000-4000-8000-0000000000c2','ci') is not null then
    raise exception 'an unknown incident must return null';
  end if;

  -- The schema lets a first-stage (`registered`) ProcessingStageReady event through the
  -- predecessor trigger, so the replay enqueues its job and announces the retained artifact.
  -- (Before 068 this always raised 'missing predecessor job id'.)
  begin
    job_id_value := corvis_control.request_data_correction_replay(
      'e2e00000-0000-4000-8000-000000000001',incident,'ci');
    if job_id_value <> expected_job then
      raise exception 'unexpected replay job id: %', job_id_value;
    end if;

    select * into incident_row from corvis_control.data_correction_incident
      where tenant_id='e2e00000-0000-4000-8000-000000000001' and incident_id=incident;
    if incident_row.state <> 'reprocessing' or incident_row.replay_job_id <> expected_job
       or incident_row.replacement_snapshot_id is null then
      raise exception 'incident must move to reprocessing with its replay job: %', incident_row;
    end if;

    if not exists (
      select 1 from corvis_control.processing_job
      where tenant_id='e2e00000-0000-4000-8000-000000000001' and job_id=expected_job
        and stage='registered' and state='queued'
        and correlation_id='data-correction:e2e00000-0000-4000-8000-0000000000c1'
    ) then raise exception 'the replay must enqueue a namespaced registered job'; end if;
    -- The original journey's jobs are untouched history.
    select count(*) into n from corvis_control.processing_job
      where tenant_id='e2e00000-0000-4000-8000-000000000001' and correlation_id='stage-pipeline-ci';
    if n <> 5 then raise exception 'the original processing trail must be retained, found % jobs', n; end if;

    if not exists (
      select 1 from corvis_control.outbox_event
      where tenant_id='e2e00000-0000-4000-8000-000000000001' and event_type='ProcessingStageReady'
        and aggregate_id=expected_job
        and payload ->> 'artifactVersionId'='e2e00000-0000-4000-8000-000000000003'
        and payload ->> 'ingestionId'='stage-pipeline-ci-v1'
        and payload ->> 'correctionIncidentId'=incident::text
    ) then raise exception 'the replay must announce the retained artifact on the outbox'; end if;

    -- Replay is idempotent: same job id, still one job and one ready event.
    again := corvis_control.request_data_correction_replay(
      'e2e00000-0000-4000-8000-000000000001',incident,'ci');
    if again <> job_id_value then raise exception 'replay must return the same job id, got %', again; end if;
    select count(*) into n from corvis_control.processing_job
      where tenant_id='e2e00000-0000-4000-8000-000000000001' and job_id=expected_job;
    if n <> 1 then raise exception 'expected one replay job, got %', n; end if;
    select count(*) into n from corvis_control.outbox_event
      where tenant_id='e2e00000-0000-4000-8000-000000000001' and event_type='ProcessingStageReady'
        and aggregate_id=expected_job;
    if n <> 1 then raise exception 'expected one ProcessingStageReady event, got %', n; end if;
  end;

  -- The retained-job identity guard must really compare correlation ids. (Under
  -- `#variable_conflict use_column` the unqualified variable used to resolve to the column, making
  -- the guard a tautology that accepted a job id owned by a different correlation.)
  perform corvis_control.open_data_correction_incident(
    'e2e00000-0000-4000-8000-000000000001','e2e00000-0000-4000-8000-0000000000c4','e2e-correction-conflict',repeat('f',64),
    'e2e-fund','2026-03-31',null,snap,2,'e2e00000-0000-4000-8000-000000000002',
    'conflicting retained job','restate fair value','ci');
  insert into corvis_control.processing_job
    (tenant_id,job_id,document_id,stage,state,attempt,max_attempts,correlation_id,version,created_at,updated_at)
  values ('e2e00000-0000-4000-8000-000000000001',
    corvis_control.scoped_processing_job_id('data-correction:e2e00000-0000-4000-8000-0000000000c4','registered','e2e00000-0000-4000-8000-000000000002'),
    'e2e00000-0000-4000-8000-000000000002','registered','queued',0,5,'some-other-correlation',1,now(),now());
  begin
    perform corvis_control.request_data_correction_replay(
      'e2e00000-0000-4000-8000-000000000001','e2e00000-0000-4000-8000-0000000000c4','ci');
    raise exception 'a retained job owned by another correlation must block the replay';
  exception when others then
    get stacked diagnostics failure = message_text;
    if failure <> 'correction replay job identity conflicts with retained state' then
      raise exception 'unexpected conflict failure: %', failure;
    end if;
  end;

  -- A resolved incident is no longer replayable.
  update corvis_control.data_correction_incident set state='resolved',resolved_by='ci',resolved_at=now()
    where tenant_id='e2e00000-0000-4000-8000-000000000001' and incident_id=incident;
  begin
    perform corvis_control.request_data_correction_replay(
      'e2e00000-0000-4000-8000-000000000001',incident,'ci');
    raise exception 'a resolved incident must not replay';
  exception when others then
    get stacked diagnostics failure = message_text;
    if failure <> 'correction incident is not replayable' then
      raise exception 'unexpected resolved-incident failure: %', failure;
    end if;
  end;

  -- An incident whose snapshot lineage is not a retained published version is refused.
  perform corvis_control.open_data_correction_incident(
    'e2e00000-0000-4000-8000-000000000001','e2e00000-0000-4000-8000-0000000000c3','e2e-correction-draft',repeat('e',64),
    'e2e-fund','2026-03-31',null,snap,1,'e2e00000-0000-4000-8000-000000000002',
    'draft lineage','n/a','ci');
  begin
    perform corvis_control.request_data_correction_replay(
      'e2e00000-0000-4000-8000-000000000001','e2e00000-0000-4000-8000-0000000000c3','ci');
    raise exception 'a draft snapshot lineage must not replay';
  exception when others then
    get stacked diagnostics failure = message_text;
    if failure <> 'correction incident snapshot lineage is not a retained published version' then
      raise exception 'unexpected draft-lineage failure: %', failure;
    end if;
  end;
end $$;

rollback;
