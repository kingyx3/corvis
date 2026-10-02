-- Cross-document reconciliation semantics (migration 080).
--
-- Documents for the same fund-period share one draft snapshot. This fixture drives
-- real documents through canonicalize -> reconcile -> consolidate -> publish exactly the
-- way processing-stage-pipeline.sql does, for several scenarios (one fund-period each):
--   1. one document (unchanged behavior: single observations, publishes, replay safe)
--   2. two documents, CONFLICTING values: exception opened on the later document, its run
--      and the snapshot are blocked, consolidation/publication refuse, the existing
--      resolution flow resumes the run, every fact of the grain is a conflicting
--      alternative, nothing is summed, and the publication backstop rejects mislabeled facts
--   3/4. two documents, IDENTICAL values, either consolidation order: lineage is merged
--      (no dead-letter), the shared fact is `equivalent_grain`, totals are not doubled
--   5. a genuinely conflicting deterministic-lineage replay is still refused
--   6. conflicting values where the later document consolidates before the earlier one
-- Run after the full migration chain on an isolated disposable database. The whole
-- scenario is one transaction and is rolled back.

\set ON_ERROR_STOP on

begin;

create temporary table cd_state (scenario integer, doc integer, key text, value text, primary key (scenario, doc, key)) on commit drop;

create function pg_temp.cd_tenant() returns uuid language sql immutable as $$ select 'cd000000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.cd_uid(s integer, d integer, k text) returns uuid language sql immutable
  as $$ select md5('cd:' || s || ':' || d || ':' || k)::uuid $$;
create function pg_temp.cd_get(s integer, d integer, k text) returns text language sql stable
  as $$ select value from cd_state where scenario=s and doc=d and key=k $$;

-- Runs a statement that must fail and checks the exact refusal message.
create function pg_temp.cd_expect_error(statement text, expected text) returns void language plpgsql as $$
declare failure text;
begin
  begin
    execute statement;
  exception when others then
    get stacked diagnostics failure = message_text;
    if failure <> expected then
      raise exception 'expected refusal "%" but got "%"', expected, failure;
    end if;
    return;
  end;
  raise exception 'expected refusal "%" but the statement succeeded', expected;
end $$;

insert into corvis_control.tenant (tenant_id,slug,display_name)
values (pg_temp.cd_tenant(),'cross-document-ci','Cross Document CI');

insert into corvis_semantic.metric_definition (
  metric_code,definition_version,display_name,data_type,aggregation_behavior,unit_type,active
) values
  ('cd_fair_value','1','Cross-document fair value','numeric','none','currency',true),
  ('cd_cost','1','Cross-document cost','numeric','none','currency',true);

-- One reviewed document of scenario s: fund -> company -> holding -> instrument plus
-- fair_value (value fv) and cost 100.00 observations.
create function pg_temp.cd_seed(s integer, d integer, fv text) returns void language plpgsql as $$
declare
  t uuid := pg_temp.cd_tenant();
  doc uuid := pg_temp.cd_uid(s,d,'document');
  run uuid := pg_temp.cd_uid(s,d,'extraction');
  rep uuid := pg_temp.cd_uid(s,d,'representation');
  art uuid := pg_temp.cd_uid(s,d,'artifact');
  fund text := 'cd-fund-' || s;
  company text := 'cd-company-' || s;
  holding uuid := pg_temp.cd_uid(s,0,'holding');
  instrument uuid := pg_temp.cd_uid(s,0,'instrument');
  n integer := 6;
  metric_payload text := ',"fund_id":"' || fund || '","company_id":"' || company || '","holding_id":"' || holding
    || '","instrument_id":"' || instrument || '","subject_type":"instrument_position","subject_level":"instrument","currency":"USD","actuality":"actual","period_type":"quarter","period_start":"2026-01-01","period_end":"2026-03-31"}';
  job text := 'reviewed:' || doc::text;
begin
  insert into corvis_source.document (tenant_id,document_id,display_name,media_type,status,created_by)
  values (t,doc,'Cross-document fixture ' || s || '/' || d,'application/pdf','registered','ci');
  insert into corvis_source.document_artifact_version (
    tenant_id,document_artifact_version_id,document_id,ingestion_id,object_uri,
    size_bytes,sha256,storage_generation,malware_scan_status,quarantine_status
  ) values (t,art,doc,'cd-' || s || '-' || d,'gs://ci-fixture/cd-' || s || '-' || d || '.pdf',
            1024,repeat('1',64),'1','clean','released');
  insert into corvis_source.document_representation (
    tenant_id,representation_id,document_id,document_artifact_version_id,
    representation_type,object_uri,storage_generation,content_sha256,size_bytes,
    producer,producer_version,method,status
  ) values (t,rep,doc,art,'document_interpretation_v1','gs://ci-fixture/cd-rep-' || s || '-' || d || '.json',
            '1',repeat('2',64),2048,'ci','1','native','ready');
  insert into corvis_source.extraction_run (
    tenant_id,extraction_run_id,document_id,document_artifact_version_id,representation_id,
    extraction_contract_version,schema_version,skill_id,skill_version,bundle_object_uri,
    bundle_storage_generation,bundle_content_sha256,bundle_size_bytes,producer,producer_version,
    model_provider,model_name,model_version,status,candidate_count,candidate_set_sha256,completed_at
  ) values (t,run,doc,art,rep,'1','1.2','quarterly_fund_report_extraction','1.6',
            'gs://ci-fixture/cd-candidates-' || s || '-' || d || '.jsonl','1',repeat('3',64),4096,
            'ci','1','ci','extractor','1','ready',n,repeat('a',64),now());

  insert into corvis_source.extraction_candidate (
    tenant_id,extraction_run_id,candidate_id,candidate_key,document_id,representation_id,
    candidate_type,payload,confidence,provenance,exception_codes,source_reference_count
  ) values
  (t,run,pg_temp.cd_uid(s,d,'c-fund'),'fund:cd',doc,rep,'fund',
   ('{"global_fund_id":"' || fund || '","canonical_name":"Cross Document Fund ' || s || '","source_name":"Cross Document Fund ' || s || '"}')::jsonb,
   '{"entity":0.99}','{"fixture":"ci"}','[]',1),
  (t,run,pg_temp.cd_uid(s,d,'c-company'),'company:cd',doc,rep,'company',
   ('{"global_company_id":"' || company || '","canonical_name":"Cross Document Company ' || s || '","source_name":"Project CD ' || s || '"}')::jsonb,
   '{"entity":0.99}','{"fixture":"ci"}','[]',1),
  (t,run,pg_temp.cd_uid(s,d,'c-holding'),'holding:cd',doc,rep,'holding',
   ('{"holding_id":"' || holding || '","fund_id":"' || fund || '","target_type":"company","target_company_id":"' || company || '"}')::jsonb,
   '{"entity":0.99}','{"fixture":"ci"}','[]',1),
  (t,run,pg_temp.cd_uid(s,d,'c-instrument'),'instrument:cd',doc,rep,'instrument',
   ('{"instrument_id":"' || instrument || '","holding_id":"' || holding || '","instrument_type":"equity","security_name":"Common Equity","currency":"USD"}')::jsonb,
   '{"entity":0.99}','{"fixture":"ci"}','[]',1),
  (t,run,pg_temp.cd_uid(s,d,'c-fv'),'metric:fair_value',doc,rep,'metric_observation',
   ('{"metric_code":"cd_fair_value","value_numeric":"' || fv || '"' || metric_payload)::jsonb,
   '{"value":0.99,"entity":0.99}','{"fixture":"ci"}','[]',1),
  (t,run,pg_temp.cd_uid(s,d,'c-cost'),'metric:cost',doc,rep,'metric_observation',
   ('{"metric_code":"cd_cost","value_numeric":"100.00"' || metric_payload)::jsonb,
   '{"value":0.99,"entity":0.99}','{"fixture":"ci"}','[]',1);

  insert into corvis_source.extraction_candidate_source_reference (
    tenant_id,extraction_run_id,candidate_id,source_reference_id,reference_key,
    document_id,representation_id,page_number,source_text,extraction_method
  )
  select t,run,c.candidate_id,pg_temp.cd_uid(s,d,'ref:' || c.candidate_key),'ref:' || c.candidate_key,
         doc,rep,1,c.candidate_key,'native_text'
  from corvis_source.extraction_candidate c
  where c.tenant_id=t and c.extraction_run_id=run;

  insert into corvis_review.candidate_review_requirement (
    tenant_id,extraction_run_id,candidate_id,review_policy_version,candidate_fingerprint_sha256,
    risk_tier,required_approvals,requires_exception_resolution,blocking_reasons
  )
  select tenant_id,extraction_run_id,candidate_id,'candidate_review_v1',
         encode(digest(candidate_id::text,'sha256'),'hex'),'standard',1,false,'[]'::jsonb
  from corvis_source.extraction_candidate where tenant_id=t and extraction_run_id=run;

  insert into corvis_review.extraction_review_gate (
    tenant_id,extraction_run_id,review_policy_version,candidate_set_sha256,decision_set_sha256,
    status,candidate_count,blocking_candidate_count,critical_candidate_count,exception_candidate_count
  ) values (t,run,'candidate_review_v1',repeat('a',64),repeat('b',64),'ready',n,0,0,0);

  -- Predecessor: the reviewed stage succeeded (fires the real review guard).
  insert into corvis_control.processing_job (tenant_id,job_id,document_id,stage,state,attempt,max_attempts,correlation_id,version)
  values (t,job,doc,'reviewed','running',1,3,'cross-document-ci',1);
  insert into corvis_control.processing_stage_effect (tenant_id,job_id,effect_key,document_id,stage,state,attempt_count,completed_at,result)
  values (t,job,'reviewed-fixture',doc,'reviewed','complete',1,now(),
    jsonb_build_object('extractionRunId',run,'reviewPolicyVersion','candidate_review_v1',
      'candidateSetSha256',repeat('a',64),'decisionSetSha256',repeat('b',64),'canonicalizationReady',true));
  update corvis_control.processing_job set state='succeeded',version=version+1 where tenant_id=t and job_id=job;
end $$;

-- Creates the running job and the `started` stage effect for one stage of one document.
create function pg_temp.cd_start(s integer, d integer, p_stage text) returns void language plpgsql as $$
declare doc uuid := pg_temp.cd_uid(s,d,'document');
begin
  insert into corvis_control.processing_job (tenant_id,job_id,document_id,stage,state,attempt,max_attempts,correlation_id,version)
  values (pg_temp.cd_tenant(),p_stage || ':' || doc::text,doc,p_stage,'running',1,3,'cross-document-ci',1);
  insert into corvis_control.processing_stage_effect (tenant_id,job_id,effect_key,document_id,stage,state,attempt_count)
  values (pg_temp.cd_tenant(),p_stage || ':' || doc::text,'cd-' || p_stage || '-' || s || '-' || d,doc,p_stage,'started',1);
end $$;

-- Commits the stage effect with its documented result and succeeds the job (real guards).
create function pg_temp.cd_finish(s integer, d integer, p_stage text, p_result jsonb) returns void language plpgsql as $$
declare doc uuid := pg_temp.cd_uid(s,d,'document');
begin
  update corvis_control.processing_stage_effect
  set state='complete',completed_at=now(),result=p_result
  where tenant_id=pg_temp.cd_tenant() and job_id=p_stage || ':' || doc::text and effect_key='cd-' || p_stage || '-' || s || '-' || d;
  update corvis_control.processing_job set state='succeeded',version=version+1
  where tenant_id=pg_temp.cd_tenant() and job_id=p_stage || ':' || doc::text;
end $$;

create function pg_temp.cd_canonicalize(s integer, d integer) returns void language plpgsql as $$
declare
  t uuid := pg_temp.cd_tenant();
  doc uuid := pg_temp.cd_uid(s,d,'document');
  run uuid := pg_temp.cd_uid(s,d,'extraction');
  r record;
begin
  perform pg_temp.cd_start(s,d,'canonicalized');
  select * into r from corvis_facts.canonicalize_reviewed_extraction_v4(
    t,doc,run,'candidate_review_v1',repeat('a',64),repeat('b',64),'cd-canonicalized-' || s || '-' || d);
  insert into cd_state values (s,d,'canonicalization',r.canonicalization_run_id::text),
    (s,d,'observations',r.observation_count::text),(s,d,'references',r.source_reference_count::text);
  perform pg_temp.cd_finish(s,d,'canonicalized',jsonb_build_object(
    'canonicalizationRunId',r.canonicalization_run_id::text,'extractionRunId',run::text,
    'candidateSetSha256',repeat('a',64),'decisionSetSha256',repeat('b',64),
    'reviewPolicyVersion','candidate_review_v1'));
end $$;

-- Starts the reconciled stage once and, if the run is ready, commits it. A blocked run
-- leaves the effect `started` and blocks the job, as the worker does.
create function pg_temp.cd_reconcile(s integer, d integer, first_call boolean default true) returns jsonb language plpgsql as $$
declare
  t uuid := pg_temp.cd_tenant();
  did uuid := pg_temp.cd_uid(s,d,'document');
  r record;
begin
  if first_call then perform pg_temp.cd_start(s,d,'reconciled'); end if;
  select * into r from corvis_consolidated.reconcile_canonicalization(
    t,did,pg_temp.cd_get(s,d,'canonicalization')::uuid,pg_temp.cd_uid(s,d,'extraction'),
    repeat('a',64),repeat('b',64),pg_temp.cd_get(s,d,'observations')::integer,
    pg_temp.cd_get(s,d,'references')::integer,'cd-reconciled-' || s || '-' || d);
  insert into cd_state values (s,d,'reconciliation',r.reconciliation_run_id::text)
  on conflict (scenario,doc,key) do nothing;
  insert into cd_state values (s,d,'snapshot',r.snapshot_id::text) on conflict (scenario,doc,key) do nothing;
  if r.reconciliation_ready then
    update corvis_control.processing_job set state='running'
    where tenant_id=t and job_id='reconciled:' || did::text and state='queued';
    perform pg_temp.cd_finish(s,d,'reconciled',jsonb_build_object(
      'reconciliationRunId',r.reconciliation_run_id::text,'snapshotId',r.snapshot_id::text,
      'snapshotVersion',r.snapshot_version,'reconciliationReady',true,'blockingExceptionCount',0));
  else
    update corvis_control.processing_job set state='blocked',blocked_reason='reconciliation_exceptions_open',version=version+1
    where tenant_id=t and job_id='reconciled:' || did::text;
  end if;
  return to_jsonb(r);
end $$;

create function pg_temp.cd_consolidate(s integer, d integer) returns jsonb language plpgsql as $$
declare
  t uuid := pg_temp.cd_tenant();
  doc uuid := pg_temp.cd_uid(s,d,'document');
  r record;
begin
  perform pg_temp.cd_start(s,d,'consolidated');
  select * into r from corvis_consolidated.consolidate_reconciliation(
    t,doc,pg_temp.cd_get(s,d,'reconciliation')::uuid,pg_temp.cd_get(s,d,'snapshot')::uuid,1,
    pg_temp.cd_get(s,d,'observations')::integer,'cd-consolidated-' || s || '-' || d);
  insert into cd_state values (s,d,'consolidation',r.consolidation_run_id::text);
  perform pg_temp.cd_finish(s,d,'consolidated',jsonb_build_object(
    'consolidationRunId',r.consolidation_run_id::text,'snapshotId',r.snapshot_id::text,
    'snapshotVersion',1,'consolidationReady',true,'factCount',r.fact_count));
  return to_jsonb(r);
end $$;

create function pg_temp.cd_publish(s integer, d integer) returns jsonb language plpgsql as $$
declare
  t uuid := pg_temp.cd_tenant();
  doc uuid := pg_temp.cd_uid(s,d,'document');
  r record;
begin
  if not exists (select 1 from corvis_control.processing_job where tenant_id=t and job_id='published:' || doc::text) then
    perform pg_temp.cd_start(s,d,'published');
  end if;
  select * into r from corvis_consolidated.publish_consolidation(
    t,doc,pg_temp.cd_get(s,d,'consolidation')::uuid,pg_temp.cd_get(s,d,'snapshot')::uuid,1,
    'cd-published-' || s || '-' || d);
  return to_jsonb(r);
end $$;

-- Facts of the snapshot as the published-value queries see them (fair_value only).
create function pg_temp.cd_counted_fair_value(s integer) returns numeric language sql stable as $$
  select sum((f.value->>'number')::numeric)
  from corvis_consolidated.fund_period_snapshot sn
  cross join lateral unnest(sn.fact_ids) fid(id)
  join corvis_consolidated.consolidated_fact f on f.tenant_id=sn.tenant_id and f.consolidated_fact_id=fid.id
  where sn.tenant_id=pg_temp.cd_tenant() and sn.snapshot_id=pg_temp.cd_get(s,1,'snapshot')::uuid and sn.version=1
    and f.metric_code='cd_fair_value'
    and coalesce(f.value->>'semanticGrainRelationship','')<>'conflicting_alternative'
$$;

create function pg_temp.cd_draft_fact_ids(s integer) returns uuid[] language sql stable as $$
  select fact_ids from corvis_consolidated.fund_period_snapshot
  where tenant_id=pg_temp.cd_tenant() and snapshot_id=pg_temp.cd_get(s,1,'snapshot')::uuid and version=1
$$;

-- ============================================================ scenario 1: one document
do $$
declare r jsonb; r2 jsonb; p jsonb; n integer; relationships text[];
begin
  perform pg_temp.cd_seed(1,1,'123.45');
  perform pg_temp.cd_canonicalize(1,1);
  r := pg_temp.cd_reconcile(1,1);
  if (r->>'reconciliation_ready')::boolean is not true or (r->>'blocking_exception_count')::integer <> 0 then
    raise exception 'scenario 1: a single document must reconcile cleanly: %', r;
  end if;
  -- Replays return the same runs without duplicate rows.
  r2 := pg_temp.cd_reconcile(1,1,false);
  if r2->>'reconciliation_run_id' <> pg_temp.cd_get(1,1,'reconciliation') then
    raise exception 'scenario 1: reconciliation replay changed the run: %', r2;
  end if;
  r := pg_temp.cd_consolidate(1,1);
  if (r->>'fact_count')::integer <> 2 then raise exception 'scenario 1: unexpected consolidation %', r; end if;
  select array_agg(semantic_grain_relationship order by metric_code) into relationships
  from corvis_consolidated.consolidated_fact
  where tenant_id=pg_temp.cd_tenant() and consolidated_fact_id=any(pg_temp.cd_draft_fact_ids(1));
  if relationships <> array['single_observation','single_observation'] then
    raise exception 'scenario 1: single-document facts must stay single_observation, got %', relationships;
  end if;
  p := pg_temp.cd_publish(1,1);
  if (p->>'fact_count')::integer <> 2 or (p->>'publication_ready')::boolean is not true then
    raise exception 'scenario 1: single-document publication failed: %', p;
  end if;
  if pg_temp.cd_counted_fair_value(1) <> 123.45 then
    raise exception 'scenario 1: unexpected fair value total %', pg_temp.cd_counted_fair_value(1);
  end if;
  select count(*) into n from corvis_consolidated.reconciliation_exception
  where tenant_id=pg_temp.cd_tenant() and snapshot_id=pg_temp.cd_get(1,1,'snapshot')::uuid;
  if n <> 0 then raise exception 'scenario 1: expected no exceptions, got %', n; end if;
end $$;

-- ============================================ scenario 2: conflicting values, two documents
do $$
declare
  t uuid := pg_temp.cd_tenant();
  r jsonb; exc record; n integer; facts uuid[]; fv_facts integer; ev uuid := pg_temp.cd_uid(2,0,'resolution-event');
  resolved record; job_state text; cost_fact record;
begin
  perform pg_temp.cd_seed(2,1,'123.45');
  perform pg_temp.cd_seed(2,2,'130.00');
  perform pg_temp.cd_canonicalize(2,1);
  perform pg_temp.cd_canonicalize(2,2);

  -- Document 1 is first: nothing to disagree with.
  r := pg_temp.cd_reconcile(2,1);
  if (r->>'reconciliation_ready')::boolean is not true or (r->>'blocking_exception_count')::integer <> 0 then
    raise exception 'scenario 2: the first document must reconcile cleanly: %', r;
  end if;

  -- Document 2 reports a different value for the same grain: blocked with a cross-document exception.
  r := pg_temp.cd_reconcile(2,2);
  if (r->>'reconciliation_ready')::boolean is not false or (r->>'blocking_exception_count')::integer <> 1 then
    raise exception 'scenario 2: conflicting second document must be blocked with one exception: %', r;
  end if;
  if r->>'snapshot_id' <> pg_temp.cd_get(2,1,'snapshot') then
    raise exception 'scenario 2: both documents must share one draft snapshot';
  end if;
  select * into exc from corvis_consolidated.reconciliation_exception
  where tenant_id=t and snapshot_id=pg_temp.cd_get(2,1,'snapshot')::uuid;
  if exc.exception_type <> 'reconciliation_conflict' or exc.status <> 'open'
     or exc.reconciliation_run_id <> pg_temp.cd_get(2,2,'reconciliation')::uuid
     or exc.metric_code <> 'cd_fair_value' or exc.context->>'conflictScope' <> 'cross_document'
     or jsonb_array_length(exc.context->'observations') <> 2
     or cardinality(exc.competing_source_reference_ids) <> 2
     or jsonb_array_length(exc.context->'peerReconciliationRunIds') <> 1 then
    raise exception 'scenario 2: unexpected cross-document exception: %', to_jsonb(exc);
  end if;
  if not exists (
    select 1 from jsonb_array_elements(exc.context->'observations') o(item)
    where (item->'value'->>'number')::numeric = 123.45
  ) or not exists (
    select 1 from jsonb_array_elements(exc.context->'observations') o(item)
    where (item->'value'->>'number')::numeric = 130.00
  ) then
    raise exception 'scenario 2: the exception must list both competing values: %', exc.context;
  end if;
  select count(*) into n from corvis_consolidated.reconciliation_exception where tenant_id=t
    and snapshot_id=pg_temp.cd_get(2,1,'snapshot')::uuid;
  if n <> 1 then raise exception 'scenario 2: only the conflicting grain may raise an exception (identical cost must not), got %', n; end if;
  if (select status from corvis_consolidated.reconciliation_run where tenant_id=t
      and reconciliation_run_id=pg_temp.cd_get(2,2,'reconciliation')::uuid) <> 'blocked' then
    raise exception 'scenario 2: the conflicting run must be blocked';
  end if;

  -- The blocked run cannot consolidate.
  perform pg_temp.cd_start(2,2,'consolidated');
  perform pg_temp.cd_expect_error(format(
    'select * from corvis_consolidated.consolidate_reconciliation(%L,%L,%L,%L,1,%s,%L)',
    t,pg_temp.cd_uid(2,2,'document'),pg_temp.cd_get(2,2,'reconciliation'),pg_temp.cd_get(2,2,'snapshot'),
    pg_temp.cd_get(2,2,'observations'),'cd-consolidated-2-2'),
    'consolidation requires exact ready reconciliation run');
  delete from corvis_control.processing_stage_effect where tenant_id=t and job_id='consolidated:' || pg_temp.cd_uid(2,2,'document')::text;
  delete from corvis_control.processing_job where tenant_id=t and job_id='consolidated:' || pg_temp.cd_uid(2,2,'document')::text;

  -- Document 1 may still consolidate, but its fair value is now a retained alternative
  -- (never a plain fact) while the identical cost is an equivalent grain.
  r := pg_temp.cd_consolidate(2,1);
  if (r->>'fact_count')::integer <> 2 then raise exception 'scenario 2: unexpected document 1 consolidation %', r; end if;
  if (select semantic_grain_relationship from corvis_consolidated.consolidated_fact
      where tenant_id=t and consolidated_fact_id=any(pg_temp.cd_draft_fact_ids(2)) and metric_code='cd_fair_value')
     <> 'conflicting_alternative' then
    raise exception 'scenario 2: document 1 fair value must be a conflicting alternative';
  end if;

  -- The open exception blocks publication through the real gate.
  perform pg_temp.cd_start(2,1,'published');
  perform pg_temp.cd_expect_error(format(
    'select * from corvis_consolidated.publish_consolidation(%L,%L,%L,%L,1,%L)',
    t,pg_temp.cd_uid(2,1,'document'),pg_temp.cd_get(2,1,'consolidation'),pg_temp.cd_get(2,1,'snapshot'),'cd-published-2-1'),
    'blocking reconciliation exceptions remain');
  perform pg_temp.cd_expect_error(format(
    'select corvis_consolidated.assert_snapshot_publishable(%L,%L,1)',t,pg_temp.cd_get(2,1,'snapshot')),
    'blocking reconciliation exceptions remain');

  -- Governed resolution (existing flow) resumes the blocked job and run.
  select * into resolved from corvis_consolidated.resolve_reconciliation_exception(
    t,exc.exception_id,1,ev,'ci-reviewer','accept_reconciliation','cross_document_alternatives_retained');
  if resolved.next_status <> 'resolved' then raise exception 'scenario 2: resolution failed: %', resolved; end if;
  select state into job_state from corvis_control.processing_job
  where tenant_id=t and job_id='reconciled:' || pg_temp.cd_uid(2,2,'document')::text;
  if job_state <> 'queued' then raise exception 'scenario 2: resolution must requeue the blocked job, got %', job_state; end if;
  r := pg_temp.cd_reconcile(2,2,false);
  if (r->>'reconciliation_ready')::boolean is not true or (r->>'blocking_exception_count')::integer <> 0 then
    raise exception 'scenario 2: resolved run must be ready on replay (no re-block): %', r;
  end if;
  select count(*) into n from corvis_consolidated.reconciliation_exception where tenant_id=t
    and snapshot_id=pg_temp.cd_get(2,1,'snapshot')::uuid;
  if n <> 1 then raise exception 'scenario 2: replay must not open further exceptions, got %', n; end if;

  r := pg_temp.cd_consolidate(2,2);
  if (r->>'fact_count')::integer <> 2 then raise exception 'scenario 2: unexpected document 2 consolidation %', r; end if;
  facts := pg_temp.cd_draft_fact_ids(2);
  -- Two fair_value alternatives plus one cost fact merged from both documents.
  if cardinality(facts) <> 3 then raise exception 'scenario 2: expected 3 draft facts, got %', cardinality(facts); end if;
  select count(*) into fv_facts from corvis_consolidated.consolidated_fact
  where tenant_id=t and consolidated_fact_id=any(facts) and metric_code='cd_fair_value'
    and semantic_grain_relationship='conflicting_alternative'
    and value->>'semanticGrainRelationship'='conflicting_alternative';
  if fv_facts <> 2 then raise exception 'scenario 2: both fair values must be conflicting alternatives (column and value copy)'; end if;
  select * into cost_fact from corvis_consolidated.consolidated_fact
  where tenant_id=t and consolidated_fact_id=any(facts) and metric_code='cd_cost';
  if cost_fact.semantic_grain_relationship <> 'equivalent_grain' or cardinality(cost_fact.source_observation_ids) <> 2
     or cost_fact.value->>'semanticGrainRelationship' <> 'equivalent_grain' then
    raise exception 'scenario 2: identical cost must merge both documents: %', to_jsonb(cost_fact);
  end if;
  if pg_temp.cd_counted_fair_value(2) is not null then
    raise exception 'scenario 2: conflicting values must never be counted, got %', pg_temp.cd_counted_fair_value(2);
  end if;

  -- Backstop: a mislabeled fact (as if reconcile/consolidate had been bypassed) is refused
  -- even with the exception resolved.
  update corvis_consolidated.consolidated_fact set semantic_grain_relationship='single_observation'
  where tenant_id=t and consolidated_fact_id=any(facts) and metric_code='cd_fair_value'
    and consolidated_fact_id=(select f.consolidated_fact_id from corvis_consolidated.consolidated_fact f
                              where f.tenant_id=t and f.consolidated_fact_id=any(facts) and f.metric_code='cd_fair_value'
                              order by f.consolidated_fact_id limit 1);
  perform pg_temp.cd_expect_error(format(
    'select corvis_consolidated.assert_snapshot_publishable(%L,%L,1)',t,pg_temp.cd_get(2,1,'snapshot')),
    'snapshot facts disagree on a semantic grain without conflicting-alternative classification');
  update corvis_consolidated.consolidated_fact set semantic_grain_relationship='conflicting_alternative'
  where tenant_id=t and consolidated_fact_id=any(facts) and metric_code='cd_fair_value';

  -- With the conflict explicitly resolved, the alternatives publish as retained
  -- alternatives (zero counted), never as a summed number.
  r := pg_temp.cd_publish(2,1);
  if (r->>'publication_ready')::boolean is not true or (r->>'fact_count')::integer <> 3 then
    raise exception 'scenario 2: resolved alternatives must publish: %', r;
  end if;
end $$;

-- ===================================== scenarios 3 and 4: identical values, both orders
do $$
declare
  t uuid := pg_temp.cd_tenant();
  s integer; first_doc integer; second_doc integer;
  r jsonb; r2 jsonb; p jsonb; facts uuid[]; n integer; run1 uuid; cons_facts uuid[];
begin
  foreach s in array array[3,4] loop
    first_doc := case when s=3 then 1 else 2 end;
    second_doc := 3 - first_doc;
    perform pg_temp.cd_seed(s,1,'123.45');
    perform pg_temp.cd_seed(s,2,'123.45');
    perform pg_temp.cd_canonicalize(s,1);
    perform pg_temp.cd_canonicalize(s,2);
    -- Both documents reconcile (identical values are not a conflict) before either consolidates.
    r := pg_temp.cd_reconcile(s,1);
    r2 := pg_temp.cd_reconcile(s,2);
    if (r->>'reconciliation_ready')::boolean is not true or (r2->>'reconciliation_ready')::boolean is not true
       or (r2->>'blocking_exception_count')::integer <> 0 then
      raise exception 'scenario %: identical values must not raise an exception: % / %', s, r, r2;
    end if;

    r := pg_temp.cd_consolidate(s,first_doc);
    if (r->>'fact_count')::integer <> 2 then raise exception 'scenario %: unexpected first consolidation %', s, r; end if;
    -- Previously this raised 'existing consolidated fact conflicts with deterministic lineage'.
    r2 := pg_temp.cd_consolidate(s,second_doc);
    if (r2->>'fact_count')::integer <> 2 or (r2->>'consolidation_ready')::boolean is not true
       or (r2->>'source_observation_count')::integer <> 2 then
      raise exception 'scenario %: identical second document must consolidate: %', s, r2;
    end if;

    facts := pg_temp.cd_draft_fact_ids(s);
    if cardinality(facts) <> 2 then raise exception 'scenario %: identical facts must be shared, got %', s, cardinality(facts); end if;
    run1 := pg_temp.cd_get(s,first_doc,'reconciliation')::uuid;
    select count(*) into n from corvis_consolidated.consolidated_fact
    where tenant_id=t and consolidated_fact_id=any(facts)
      and semantic_grain_relationship='equivalent_grain'
      and value->>'semanticGrainRelationship'='equivalent_grain'
      and cardinality(source_observation_ids)=2
      and reconciliation_run_id=run1;
    if n <> 2 then raise exception 'scenario %: both facts must merge both documents'' observations (got %)', s, n; end if;
    -- The merged lineage is exactly the two documents' observations.
    if exists (
      select 1 from corvis_consolidated.consolidated_fact cf
      where cf.tenant_id=t and cf.consolidated_fact_id=any(facts)
        and cf.source_observation_ids <> (
          select array_agg(o.observation_id order by o.observation_id)
          from corvis_facts.observation o
          where o.tenant_id=t and o.metric_code=cf.metric_code
            and o.canonicalization_run_id in (pg_temp.cd_get(s,1,'canonicalization')::uuid,pg_temp.cd_get(s,2,'canonicalization')::uuid))
    ) then
      raise exception 'scenario %: merged lineage lost an observation', s;
    end if;
    select fact_ids into cons_facts from corvis_consolidated.consolidation_run
    where tenant_id=t and consolidation_run_id=pg_temp.cd_get(s,second_doc,'consolidation')::uuid;
    if cons_facts <> facts then raise exception 'scenario %: the second consolidation run must record the shared facts', s; end if;

    -- Replay is idempotent.
    if (select consolidation_run_id from corvis_consolidated.consolidate_reconciliation(
          t,pg_temp.cd_uid(s,second_doc,'document'),pg_temp.cd_get(s,second_doc,'reconciliation')::uuid,
          pg_temp.cd_get(s,second_doc,'snapshot')::uuid,1,2,'cd-consolidated-' || s || '-' || second_doc))
       <> pg_temp.cd_get(s,second_doc,'consolidation')::uuid then
      raise exception 'scenario %: consolidation replay changed the run', s;
    end if;

    p := pg_temp.cd_publish(s,second_doc);
    if (p->>'publication_ready')::boolean is not true or (p->>'fact_count')::integer <> 2 then
      raise exception 'scenario %: identical documents must publish: %', s, p;
    end if;
    if pg_temp.cd_counted_fair_value(s) <> 123.45 then
      raise exception 'scenario %: identical values must count once, got %', s, pg_temp.cd_counted_fair_value(s);
    end if;
  end loop;
end $$;

-- ================================== scenario 5: genuinely conflicting lineage replays still fail
do $$
declare t uuid := pg_temp.cd_tenant(); fact uuid;
begin
  perform pg_temp.cd_seed(5,1,'123.45');
  perform pg_temp.cd_seed(5,2,'123.45');
  perform pg_temp.cd_canonicalize(5,1);
  perform pg_temp.cd_canonicalize(5,2);
  perform pg_temp.cd_reconcile(5,1);
  perform pg_temp.cd_reconcile(5,2);
  perform pg_temp.cd_consolidate(5,1);
  -- A fact that claims document 2's own reconciliation run but carries other lineage is
  -- not a mergeable peer: the deterministic-lineage refusal still applies.
  update corvis_consolidated.consolidated_fact
  set reconciliation_run_id=pg_temp.cd_get(5,2,'reconciliation')::uuid
  where tenant_id=t and consolidated_fact_id=any(pg_temp.cd_draft_fact_ids(5));
  perform pg_temp.cd_start(5,2,'consolidated');
  perform pg_temp.cd_expect_error(format(
    'select * from corvis_consolidated.consolidate_reconciliation(%L,%L,%L,%L,1,2,%L)',
    t,pg_temp.cd_uid(5,2,'document'),pg_temp.cd_get(5,2,'reconciliation'),pg_temp.cd_get(5,2,'snapshot'),'cd-consolidated-5-2'),
    'existing consolidated fact conflicts with deterministic lineage');
end $$;

-- ======= scenario 6: conflicting values, the later document consolidates BEFORE the earlier one
do $$
declare
  t uuid := pg_temp.cd_tenant();
  r jsonb; exc record; facts uuid[]; resolved record;
begin
  perform pg_temp.cd_seed(6,1,'123.45');
  perform pg_temp.cd_seed(6,2,'130.00');
  perform pg_temp.cd_canonicalize(6,1);
  perform pg_temp.cd_canonicalize(6,2);
  perform pg_temp.cd_reconcile(6,1);
  r := pg_temp.cd_reconcile(6,2);
  if (r->>'blocking_exception_count')::integer <> 1 then raise exception 'scenario 6: expected a blocked second document: %', r; end if;
  select * into exc from corvis_consolidated.reconciliation_exception
  where tenant_id=t and snapshot_id=pg_temp.cd_get(6,1,'snapshot')::uuid;
  select * into resolved from corvis_consolidated.resolve_reconciliation_exception(
    t,exc.exception_id,1,pg_temp.cd_uid(6,0,'resolution-event'),'ci-reviewer','accept_reconciliation','alternatives_retained');
  perform pg_temp.cd_reconcile(6,2,false);

  -- Document 2 consolidates first (document 1 is still only reconciled): its value is
  -- already a conflicting alternative because document 1's observation disagrees.
  r := pg_temp.cd_consolidate(6,2);
  if exists (
    select 1 from corvis_consolidated.consolidated_fact
    where tenant_id=t and consolidated_fact_id=any(pg_temp.cd_draft_fact_ids(6)) and metric_code='cd_fair_value'
      and semantic_grain_relationship<>'conflicting_alternative'
  ) then raise exception 'scenario 6: document 2 fair value must be a conflicting alternative'; end if;
  r := pg_temp.cd_consolidate(6,1);
  facts := pg_temp.cd_draft_fact_ids(6);
  if cardinality(facts) <> 3 or (
    select count(*) from corvis_consolidated.consolidated_fact
    where tenant_id=t and consolidated_fact_id=any(facts) and metric_code='cd_fair_value'
      and semantic_grain_relationship='conflicting_alternative') <> 2 then
    raise exception 'scenario 6: expected two conflicting fair values and one merged cost, got % facts', cardinality(facts);
  end if;
  if pg_temp.cd_counted_fair_value(6) is not null then
    raise exception 'scenario 6: conflicting values must never be counted';
  end if;
  r := pg_temp.cd_publish(6,1);
  if (r->>'publication_ready')::boolean is not true then raise exception 'scenario 6: resolved alternatives must publish: %', r; end if;
end $$;

rollback;
