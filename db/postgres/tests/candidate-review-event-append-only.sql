-- Acceptance: corvis_review.candidate_review_event is append-only.
--
-- Every other audit/evidence table in this schema (control_evidence_record,
-- data_issue_case_event, export_schedule_run, review_item_comment,
-- tenant_export_request_event) has a dedicated acceptance test asserting its
-- append-only trigger guard actually fires with the expected error text.
-- candidate_review_event (the GP-review decision ledger) had no such coverage: a typo
-- in the trigger definition or a migration that dropped it would pass every other
-- suite silently. This proves UPDATE, DELETE and TRUNCATE are all rejected.
--
-- Run after the full migration chain on an isolated disposable database. Rolled back.

\set ON_ERROR_STOP on

begin;

create function pg_temp.expect_error(statement text, fragment text) returns void language plpgsql as $$
declare
  raised text;
begin
  begin
    execute statement;
  exception when others then
    raised := sqlerrm;
  end;
  if raised is null then
    raise exception 'expected failure containing "%" but the statement succeeded: %', fragment, statement;
  end if;
  if position(fragment in raised) = 0 then
    raise exception 'expected failure containing "%" but got "%"', fragment, raised;
  end if;
end;
$$;

insert into corvis_control.tenant (tenant_id,slug,display_name)
values ('c4e00000-0000-4000-8000-00000000000a','candidate-review-a','Candidate Review A');

insert into corvis_source.document (
  tenant_id,document_id,display_name,media_type,status,created_by
) values (
  'c4e00000-0000-4000-8000-00000000000a','c4e00000-0000-4000-8000-00000000000d',
  'Candidate review fixture','application/pdf','registered','ci'
);

insert into corvis_source.document_artifact_version (
  tenant_id,document_artifact_version_id,document_id,ingestion_id,object_uri,
  size_bytes,sha256,storage_generation,malware_scan_status,quarantine_status
) values (
  'c4e00000-0000-4000-8000-00000000000a','c4e00000-0000-4000-8000-00000000000e',
  'c4e00000-0000-4000-8000-00000000000d','candidate-review-a-v1','gs://ci-fixture/document.pdf',
  1024,repeat('1',64),'1','clean','released'
);

insert into corvis_source.document_representation (
  tenant_id,representation_id,document_id,document_artifact_version_id,
  representation_type,object_uri,storage_generation,content_sha256,size_bytes,
  producer,producer_version,method,status
) values (
  'c4e00000-0000-4000-8000-00000000000a','c4e00000-0000-4000-8000-00000000000f',
  'c4e00000-0000-4000-8000-00000000000d','c4e00000-0000-4000-8000-00000000000e',
  'document_interpretation_v1','gs://ci-fixture/representation.json','1',repeat('2',64),2048,
  'ci','1','native','ready'
);

insert into corvis_source.extraction_run (
  tenant_id,extraction_run_id,document_id,document_artifact_version_id,representation_id,
  extraction_contract_version,schema_version,skill_id,skill_version,bundle_object_uri,
  bundle_storage_generation,bundle_content_sha256,bundle_size_bytes,producer,producer_version,
  model_provider,model_name,model_version,status,candidate_count,candidate_set_sha256,completed_at
) values (
  'c4e00000-0000-4000-8000-00000000000a','c4e00000-0000-4000-8000-000000000011',
  'c4e00000-0000-4000-8000-00000000000d','c4e00000-0000-4000-8000-00000000000e',
  'c4e00000-0000-4000-8000-00000000000f','1','1.2','quarterly_fund_report_extraction','1.6',
  'gs://ci-fixture/candidates.jsonl','1',repeat('3',64),4096,'ci','1','ci','extractor','1',
  'ready',1,repeat('a',64),now()
);

insert into corvis_source.extraction_candidate (
  tenant_id,extraction_run_id,candidate_id,candidate_key,document_id,representation_id,
  candidate_type,payload,confidence,provenance,exception_codes,source_reference_count
) values (
  'c4e00000-0000-4000-8000-00000000000a','c4e00000-0000-4000-8000-000000000011',
  'c4e00000-0000-4000-8000-000000000012','fund:new','c4e00000-0000-4000-8000-00000000000d',
  'c4e00000-0000-4000-8000-00000000000f','fund',
  '{"global_fund_id":"fund-new","canonical_name":"New Fund I","source_name":"New Fund I"}',
  '{"entity":0.99}','{"fixture":"ci"}','[]',1
);

-- The lifecycle guard trigger requires a committed extracted-stage effect and a scoped,
-- not-yet-running-or-succeeded reviewed job sharing its correlation id — mirrors the real
-- processing boundary reviewed-economic-graph.sql exercises for canonicalization.
insert into corvis_control.processing_job (
  tenant_id,job_id,document_id,stage,state,attempt,max_attempts,correlation_id,version
) values (
  'c4e00000-0000-4000-8000-00000000000a','extracted:c4e00000-0000-4000-8000-00000000000d',
  'c4e00000-0000-4000-8000-00000000000d','extracted','succeeded',1,3,'candidate-review-ci',1
);

insert into corvis_control.processing_stage_effect (
  tenant_id,job_id,effect_key,document_id,stage,state,attempt_count,completed_at,result
) values (
  'c4e00000-0000-4000-8000-00000000000a','extracted:c4e00000-0000-4000-8000-00000000000d',
  'extracted-fixture','c4e00000-0000-4000-8000-00000000000d','extracted','complete',1,now(),
  jsonb_build_object('extractionRunId','c4e00000-0000-4000-8000-000000000011')
);

insert into corvis_control.processing_job (
  tenant_id,job_id,document_id,stage,state,attempt,max_attempts,correlation_id,version
) values (
  'c4e00000-0000-4000-8000-00000000000a','reviewed:c4e00000-0000-4000-8000-00000000000d',
  'c4e00000-0000-4000-8000-00000000000d','reviewed','queued',1,3,'candidate-review-ci',1
);

insert into corvis_review.candidate_review_event (
  tenant_id,review_event_id,extraction_run_id,candidate_id,review_policy_version,
  actor_subject,decision,reason_code
) values (
  'c4e00000-0000-4000-8000-00000000000a','c4e00000-0000-4000-8000-000000000013',
  'c4e00000-0000-4000-8000-000000000011','c4e00000-0000-4000-8000-000000000012',
  'candidate_review_v1','reviewer@example.test','approve','looks_correct'
);

-- 1. The trigger rejects UPDATE, DELETE and TRUNCATE with its documented message, whatever column is touched.
do $$
declare
  r uuid := 'c4e00000-0000-4000-8000-000000000013';
begin
  perform pg_temp.expect_error(format($f$update corvis_review.candidate_review_event set reason_code = 'changed_mind' where review_event_id = %L$f$, r),
    'corvis_review.candidate_review_event is append-only');
  perform pg_temp.expect_error(format($f$update corvis_review.candidate_review_event set decision = 'reject' where review_event_id = %L$f$, r),
    'corvis_review.candidate_review_event is append-only');
  perform pg_temp.expect_error(format($f$delete from corvis_review.candidate_review_event where review_event_id = %L$f$, r),
    'corvis_review.candidate_review_event is append-only');
  perform pg_temp.expect_error('truncate corvis_review.candidate_review_event',
    'corvis_review.candidate_review_event is append-only');
end $$;

-- 2. A new decision is a plain insert, not blocked by the guard, and both events coexist.
insert into corvis_review.candidate_review_event (
  tenant_id,review_event_id,extraction_run_id,candidate_id,review_policy_version,
  actor_subject,decision,reason_code
) values (
  'c4e00000-0000-4000-8000-00000000000a','c4e00000-0000-4000-8000-000000000014',
  'c4e00000-0000-4000-8000-000000000011','c4e00000-0000-4000-8000-000000000012',
  'candidate_review_v1','reviewer@example.test','reject','on_second_look'
);

do $$
begin
  if (select count(*) from corvis_review.candidate_review_event where tenant_id = 'c4e00000-0000-4000-8000-00000000000a') <> 2 then
    raise exception 'recording a new decision must not be blocked by the append-only guard';
  end if;
end $$;

rollback;
