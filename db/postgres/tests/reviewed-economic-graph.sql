-- End-to-end acceptance for a reviewed report that introduces a complete
-- fund -> company-target holding -> instrument -> metric graph.
-- Run only after the full migration chain on an isolated disposable database.

\set ON_ERROR_STOP on

begin;

insert into corvis_control.tenant (tenant_id,slug,display_name)
values ('11111111-1111-4111-8111-111111111111','economic-graph-ci','Economic Graph CI');

insert into corvis_source.document (
  tenant_id,document_id,display_name,media_type,status,created_by
) values (
  '11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',
  'Reviewed economic graph fixture','application/pdf','registered','ci'
);

insert into corvis_source.document_artifact_version (
  tenant_id,document_artifact_version_id,document_id,ingestion_id,object_uri,
  size_bytes,sha256,storage_generation,malware_scan_status,quarantine_status
) values (
  '11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333',
  '22222222-2222-4222-8222-222222222222','economic-graph-ci-v1','gs://ci-fixture/document.pdf',
  1024,repeat('1',64),'1','clean','released'
);

insert into corvis_source.document_representation (
  tenant_id,representation_id,document_id,document_artifact_version_id,
  representation_type,object_uri,storage_generation,content_sha256,size_bytes,
  producer,producer_version,method,status
) values (
  '11111111-1111-4111-8111-111111111111','44444444-4444-4444-8444-444444444444',
  '22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333',
  'document_interpretation_v1','gs://ci-fixture/representation.json','1',repeat('2',64),2048,
  'ci','1','native','ready'
);

insert into corvis_source.extraction_run (
  tenant_id,extraction_run_id,document_id,document_artifact_version_id,representation_id,
  extraction_contract_version,schema_version,skill_id,skill_version,bundle_object_uri,
  bundle_storage_generation,bundle_content_sha256,bundle_size_bytes,producer,producer_version,
  model_provider,model_name,model_version,status,candidate_count,candidate_set_sha256,completed_at
) values (
  '11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555',
  '22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444','1','1.2','quarterly_fund_report_extraction','1.6',
  'gs://ci-fixture/candidates.jsonl','1',repeat('3',64),4096,'ci','1','ci','extractor','1',
  'ready',5,repeat('a',64),now()
);

insert into corvis_source.extraction_candidate (
  tenant_id,extraction_run_id,candidate_id,candidate_key,document_id,representation_id,
  candidate_type,payload,confidence,provenance,exception_codes,source_reference_count
) values
('11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555',
 '60000000-0000-4000-8000-000000000001','fund:new','22222222-2222-4222-8222-222222222222',
 '44444444-4444-4444-8444-444444444444','fund',
 '{"global_fund_id":"fund-new","canonical_name":"New Fund I","source_name":"New Fund I"}',
 '{"entity":0.99}','{"fixture":"ci"}','[]',1),
('11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555',
 '60000000-0000-4000-8000-000000000002','company:new','22222222-2222-4222-8222-222222222222',
 '44444444-4444-4444-8444-444444444444','company',
 '{"global_company_id":"company-new","canonical_name":"New Company","source_name":"Project New Company"}',
 '{"entity":0.99}','{"fixture":"ci"}','[]',1),
('11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555',
 '60000000-0000-4000-8000-000000000003','holding:new','22222222-2222-4222-8222-222222222222',
 '44444444-4444-4444-8444-444444444444','holding',
 '{"holding_id":"77777777-7777-4777-8777-777777777777","fund_id":"fund-new","target_type":"company","target_company_id":"company-new"}',
 '{"entity":0.99}','{"fixture":"ci"}','[]',1),
('11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555',
 '60000000-0000-4000-8000-000000000004','instrument:new','22222222-2222-4222-8222-222222222222',
 '44444444-4444-4444-8444-444444444444','instrument',
 '{"instrument_id":"88888888-8888-4888-8888-888888888888","holding_id":"77777777-7777-4777-8777-777777777777","instrument_type":"equity","security_name":"Common Equity","currency":"USD"}',
 '{"entity":0.99}','{"fixture":"ci"}','[]',1),
('11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555',
 '60000000-0000-4000-8000-000000000005','metric:new','22222222-2222-4222-8222-222222222222',
 '44444444-4444-4444-8444-444444444444','metric_observation',
 '{"fund_id":"fund-new","company_id":"company-new","holding_id":"77777777-7777-4777-8777-777777777777","instrument_id":"88888888-8888-4888-8888-888888888888","metric_code":"fair_value","subject_type":"instrument_position","subject_level":"instrument","value_numeric":"123.45","currency":"USD","actuality":"actual"}',
 '{"value":0.99,"entity":0.99}','{"fixture":"ci"}','[]',1);

insert into corvis_source.extraction_candidate_source_reference (
  tenant_id,extraction_run_id,candidate_id,source_reference_id,reference_key,
  document_id,representation_id,page_number,source_text,extraction_method
)
select
  '11111111-1111-4111-8111-111111111111'::uuid,'55555555-5555-4555-8555-555555555555'::uuid,
  c.candidate_id,
  ('70000000-0000-4000-8000-' || lpad(row_number() over (order by c.candidate_key)::text,12,'0'))::uuid,
  'ref:' || c.candidate_key,'22222222-2222-4222-8222-222222222222'::uuid,
  '44444444-4444-4444-8444-444444444444'::uuid,1,c.candidate_key,'native_text'
from corvis_source.extraction_candidate c
where c.tenant_id='11111111-1111-4111-8111-111111111111'
  and c.extraction_run_id='55555555-5555-4555-8555-555555555555';

insert into corvis_review.candidate_review_requirement (
  tenant_id,extraction_run_id,candidate_id,review_policy_version,candidate_fingerprint_sha256,
  risk_tier,required_approvals,requires_exception_resolution,blocking_reasons
)
select tenant_id,extraction_run_id,candidate_id,'candidate_review_v1',
       encode(digest(candidate_id::text,'sha256'),'hex'),'standard',1,false,'[]'::jsonb
from corvis_source.extraction_candidate
where tenant_id='11111111-1111-4111-8111-111111111111'
  and extraction_run_id='55555555-5555-4555-8555-555555555555';

insert into corvis_review.extraction_review_gate (
  tenant_id,extraction_run_id,review_policy_version,candidate_set_sha256,decision_set_sha256,
  status,candidate_count,blocking_candidate_count,critical_candidate_count,exception_candidate_count
) values (
  '11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555',
  'candidate_review_v1',repeat('a',64),repeat('b',64),'ready',5,0,0,0
);

-- Exercise the actual reviewed-job success guard. The reviewed effect and successful
-- predecessor job must be committed before canonicalization starts, matching the
-- durable stage boundary enforced by production processing.
insert into corvis_control.processing_job (
  tenant_id,job_id,document_id,stage,state,attempt,max_attempts,correlation_id,version
) values (
  '11111111-1111-4111-8111-111111111111','reviewed:22222222-2222-4222-8222-222222222222',
  '22222222-2222-4222-8222-222222222222','reviewed','running',1,3,'economic-graph-ci',1
);

insert into corvis_control.processing_stage_effect (
  tenant_id,job_id,effect_key,document_id,stage,state,attempt_count,completed_at,result
) values (
  '11111111-1111-4111-8111-111111111111','reviewed:22222222-2222-4222-8222-222222222222',
  'reviewed-fixture','22222222-2222-4222-8222-222222222222','reviewed','complete',1,now(),
  jsonb_build_object('extractionRunId','55555555-5555-4555-8555-555555555555',
    'reviewPolicyVersion','candidate_review_v1','candidateSetSha256',repeat('a',64),
    'decisionSetSha256',repeat('b',64),'canonicalizationReady',true)
);

update corvis_control.processing_job
set state='succeeded',version=version+1
where tenant_id='11111111-1111-4111-8111-111111111111'
  and job_id='reviewed:22222222-2222-4222-8222-222222222222'
  and stage='reviewed' and state='running';

-- Migration 031 scopes predecessor lookup through the currently executing
-- canonicalized effect. Model that exact runtime boundary so this acceptance
-- proves the production correlation contract instead of bypassing it.
insert into corvis_control.processing_job (
  tenant_id,job_id,document_id,stage,state,attempt,max_attempts,correlation_id,version
) values (
  '11111111-1111-4111-8111-111111111111','canonicalized:22222222-2222-4222-8222-222222222222',
  '22222222-2222-4222-8222-222222222222','canonicalized','running',1,3,'economic-graph-ci',1
);

insert into corvis_control.processing_stage_effect (
  tenant_id,job_id,effect_key,document_id,stage,state,attempt_count
) values (
  '11111111-1111-4111-8111-111111111111','canonicalized:22222222-2222-4222-8222-222222222222',
  'economic-graph-ci','22222222-2222-4222-8222-222222222222','canonicalized','started',1
);

insert into corvis_semantic.metric_definition (
  metric_code,definition_version,display_name,data_type,aggregation_behavior,unit_type,active
) values ('fair_value','1','Fair value','numeric','none','currency',true)
on conflict (metric_code,definition_version) do update set active=true;

commit;

begin;

select * from corvis_facts.canonicalize_reviewed_extraction_v4(
  '11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',
  '55555555-5555-4555-8555-555555555555','candidate_review_v1',repeat('a',64),repeat('b',64),
  'economic-graph-ci'
);
select * from corvis_facts.canonicalize_reviewed_extraction_v4(
  '11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',
  '55555555-5555-4555-8555-555555555555','candidate_review_v1',repeat('a',64),repeat('b',64),
  'economic-graph-ci'
);

do $$
declare n integer;
begin
  select count(*) into n from corvis_identity.fund where global_fund_id='fund-new';
  if n <> 1 then raise exception 'expected one materialized fund, got %',n; end if;
  select count(*) into n from corvis_identity.company where global_company_id='company-new';
  if n <> 1 then raise exception 'expected one materialized company, got %',n; end if;
  select count(*) into n from corvis_facts.holding
    where tenant_id='11111111-1111-4111-8111-111111111111' and holding_id='77777777-7777-4777-8777-777777777777';
  if n <> 1 then raise exception 'expected one materialized holding, got %',n; end if;
  select count(*) into n from corvis_facts.instrument
    where tenant_id='11111111-1111-4111-8111-111111111111' and instrument_id='88888888-8888-4888-8888-888888888888';
  if n <> 1 then raise exception 'expected one materialized instrument, got %',n; end if;
  select count(*) into n from corvis_facts.observation
    where tenant_id='11111111-1111-4111-8111-111111111111' and company_id='company-new'
      and holding_id='77777777-7777-4777-8777-777777777777'
      and instrument_id='88888888-8888-4888-8888-888888888888';
  if n <> 1 then raise exception 'expected one canonical observation, got %',n; end if;
  select count(*) into n from corvis_identity.tenant_entity_name
    where tenant_id='11111111-1111-4111-8111-111111111111' and review_status='approved';
  if n <> 2 then raise exception 'expected two tenant entity labels, got %',n; end if;
  select count(*) into n from corvis_identity.tenant_entity_revision
    where tenant_id='11111111-1111-4111-8111-111111111111';
  if n <> 2 then raise exception 'expected two entity revisions, got %',n; end if;
  select count(*) into n from corvis_facts.canonicalization_run
    where tenant_id='11111111-1111-4111-8111-111111111111' and status='ready';
  if n <> 1 then raise exception 'expected one replay-safe canonicalization run, got %',n; end if;
end;
$$;

rollback;
