-- Acceptance: the six audit/ledger tables guarded by
-- 007_audit_tables_append_only.sql are actually append-only.
--
--   corvis_control.identity_lifecycle_event
--   corvis_control.processing_recovery_event
--   corvis_control.deletion_execution_evidence
--   corvis_consolidated.reconciliation_resolution_event
--   corvis_consolidated.snapshot_publication_event
--   corvis_facts.review_event
--
-- Before 007, none of these had a BEFORE DELETE OR UPDATE row trigger or a BEFORE
-- TRUNCATE statement trigger. This proves UPDATE, DELETE and TRUNCATE are all
-- rejected with the documented error text for each table, and that a fresh INSERT
-- is never blocked by the guard.
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
values ('b1000000-0000-4000-8000-000000000001','audit-append-only','Audit Append Only');

--------------------------------------------------------------------------------
-- 1. corvis_control.identity_lifecycle_event (tenant_id FK only)
--------------------------------------------------------------------------------

insert into corvis_control.identity_lifecycle_event (
  tenant_id,lifecycle_event_id,event_key,request_hash,operation,auth_method,subject,
  user_id,actor_subject,reason
) values (
  'b1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000101',
  'sync:user-1',repeat('a',64),'sync','oidc','user-1@example.test',
  'b1000000-0000-4000-8000-000000000102','admin@example.test','initial sync'
);

do $$
declare
  r uuid := 'b1000000-0000-4000-8000-000000000101';
begin
  perform pg_temp.expect_error(format($f$update corvis_control.identity_lifecycle_event set reason = 'changed' where lifecycle_event_id = %L$f$, r),
    'corvis_control.identity_lifecycle_event is append-only');
  perform pg_temp.expect_error(format($f$delete from corvis_control.identity_lifecycle_event where lifecycle_event_id = %L$f$, r),
    'corvis_control.identity_lifecycle_event is append-only');
  perform pg_temp.expect_error('truncate corvis_control.identity_lifecycle_event',
    'corvis_control.identity_lifecycle_event is append-only');
end $$;

insert into corvis_control.identity_lifecycle_event (
  tenant_id,lifecycle_event_id,event_key,request_hash,operation,auth_method,subject,
  user_id,actor_subject,reason
) values (
  'b1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000103',
  'sync:user-2',repeat('a',64),'sync','oidc','user-2@example.test',
  'b1000000-0000-4000-8000-000000000104','admin@example.test','second sync'
);

do $$
begin
  if (select count(*) from corvis_control.identity_lifecycle_event where tenant_id = 'b1000000-0000-4000-8000-000000000001') <> 2 then
    raise exception 'recording a new lifecycle event must not be blocked by the append-only guard';
  end if;
end $$;

--------------------------------------------------------------------------------
-- 2. corvis_control.processing_recovery_event
--    (needs corvis_source.document + corvis_control.processing_job)
--------------------------------------------------------------------------------

insert into corvis_source.document (
  tenant_id,document_id,display_name,media_type,status,created_by
) values (
  'b1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000201',
  'Recovery fixture document','application/pdf','registered','ci'
);

insert into corvis_control.processing_job (
  tenant_id,job_id,document_id,stage,state,attempt,max_attempts,correlation_id,version
) values (
  'b1000000-0000-4000-8000-000000000001','recovery-test-job',
  'b1000000-0000-4000-8000-000000000201','extracted','dead_letter',3,3,'recovery-ci',1
);

insert into corvis_control.processing_recovery_event (
  tenant_id,recovery_event_id,job_id,document_id,stage,action,actor_subject,reason_code,
  source_event_id,source_job_version,source_attempt,source_max_attempts,recovery_count,
  result_job_version,before_state,after_state
) values (
  'b1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000202',
  'recovery-test-job','b1000000-0000-4000-8000-000000000201','extracted','recover_dead_letter',
  'admin@example.test','manual_retry','b1000000-0000-4000-8000-000000000203',1,3,3,1,2,
  '{}'::jsonb,'{}'::jsonb
);

do $$
declare
  r uuid := 'b1000000-0000-4000-8000-000000000202';
begin
  perform pg_temp.expect_error(format($f$update corvis_control.processing_recovery_event set note = 'edited' where recovery_event_id = %L$f$, r),
    'corvis_control.processing_recovery_event is append-only');
  perform pg_temp.expect_error(format($f$delete from corvis_control.processing_recovery_event where recovery_event_id = %L$f$, r),
    'corvis_control.processing_recovery_event is append-only');
  perform pg_temp.expect_error('truncate corvis_control.processing_recovery_event',
    'corvis_control.processing_recovery_event is append-only');
end $$;

insert into corvis_control.processing_recovery_event (
  tenant_id,recovery_event_id,job_id,document_id,stage,action,actor_subject,reason_code,
  source_event_id,source_job_version,source_attempt,source_max_attempts,recovery_count,
  result_job_version,before_state,after_state
) values (
  'b1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000204',
  'recovery-test-job','b1000000-0000-4000-8000-000000000201','extracted','recover_dead_letter',
  'admin@example.test','manual_retry','b1000000-0000-4000-8000-000000000205',2,3,3,2,3,
  '{}'::jsonb,'{}'::jsonb
);

do $$
begin
  if (select count(*) from corvis_control.processing_recovery_event where tenant_id = 'b1000000-0000-4000-8000-000000000001') <> 2 then
    raise exception 'recording a new recovery event must not be blocked by the append-only guard';
  end if;
end $$;

--------------------------------------------------------------------------------
-- 3. corvis_control.deletion_execution_evidence (needs corvis_control.deletion_request)
--------------------------------------------------------------------------------

insert into corvis_control.deletion_request (
  tenant_id,deletion_request_id,requested_by,scope,reason,state
) values (
  'b1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000301',
  'admin@example.test','{"all":true}'::jsonb,'gdpr erasure request','pending'
);

insert into corvis_control.deletion_execution_evidence (
  tenant_id,deletion_request_id,attempt,outcome,evidence,evidence_hash,recorded_by
) values (
  'b1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000301',
  1,'completed','{}'::jsonb,repeat('b',64),'ci'
);

do $$
declare
  did uuid := 'b1000000-0000-4000-8000-000000000301';
begin
  perform pg_temp.expect_error(format($f$update corvis_control.deletion_execution_evidence set outcome = 'failed' where deletion_request_id = %L and attempt = 1$f$, did),
    'corvis_control.deletion_execution_evidence is append-only');
  perform pg_temp.expect_error(format($f$delete from corvis_control.deletion_execution_evidence where deletion_request_id = %L and attempt = 1$f$, did),
    'corvis_control.deletion_execution_evidence is append-only');
  perform pg_temp.expect_error('truncate corvis_control.deletion_execution_evidence',
    'corvis_control.deletion_execution_evidence is append-only');
end $$;

insert into corvis_control.deletion_execution_evidence (
  tenant_id,deletion_request_id,attempt,outcome,evidence,evidence_hash,recorded_by
) values (
  'b1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000301',
  2,'completed','{}'::jsonb,repeat('c',64),'ci'
);

do $$
begin
  if (select count(*) from corvis_control.deletion_execution_evidence where tenant_id = 'b1000000-0000-4000-8000-000000000001') <> 2 then
    raise exception 'recording new execution evidence must not be blocked by the append-only guard';
  end if;
end $$;

--------------------------------------------------------------------------------
-- 4. corvis_consolidated.reconciliation_resolution_event
--    (needs corvis_consolidated.fund_period_snapshot + reconciliation_exception)
--------------------------------------------------------------------------------

insert into corvis_consolidated.fund_period_snapshot (
  tenant_id,snapshot_id,fund_id,report_period,version,status,schema_version,taxonomy_version
) values (
  'b1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000401',
  'fund-1','2024-Q1',1,'draft','1','1'
);

insert into corvis_consolidated.reconciliation_exception (
  tenant_id,exception_id,snapshot_id,snapshot_version,exception_key,fund_id,report_period,
  exception_type,summary,created_by
) values (
  'b1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000402',
  'b1000000-0000-4000-8000-000000000401',1,'exc-key-1','fund-1','2024-Q1',
  'source_authority','conflicting values across sources','ci'
);

insert into corvis_consolidated.reconciliation_resolution_event (
  tenant_id,resolution_event_id,exception_id,exception_version,action,reason_code,
  actor_subject,before_state,after_state
) values (
  'b1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000403',
  'b1000000-0000-4000-8000-000000000402',1,'mark_immaterial','low_impact',
  'reviewer@example.test','{}'::jsonb,'{}'::jsonb
);

do $$
declare
  r uuid := 'b1000000-0000-4000-8000-000000000403';
begin
  perform pg_temp.expect_error(format($f$update corvis_consolidated.reconciliation_resolution_event set note = 'edited' where resolution_event_id = %L$f$, r),
    'corvis_consolidated.reconciliation_resolution_event is append-only');
  perform pg_temp.expect_error(format($f$delete from corvis_consolidated.reconciliation_resolution_event where resolution_event_id = %L$f$, r),
    'corvis_consolidated.reconciliation_resolution_event is append-only');
  perform pg_temp.expect_error('truncate corvis_consolidated.reconciliation_resolution_event',
    'corvis_consolidated.reconciliation_resolution_event is append-only');
end $$;

insert into corvis_consolidated.reconciliation_resolution_event (
  tenant_id,resolution_event_id,exception_id,exception_version,action,reason_code,
  actor_subject,before_state,after_state
) values (
  'b1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000404',
  'b1000000-0000-4000-8000-000000000402',1,'accept_reconciliation','second_look',
  'reviewer@example.test','{}'::jsonb,'{}'::jsonb
);

do $$
begin
  if (select count(*) from corvis_consolidated.reconciliation_resolution_event where tenant_id = 'b1000000-0000-4000-8000-000000000001') <> 2 then
    raise exception 'recording a new resolution event must not be blocked by the append-only guard';
  end if;
end $$;

--------------------------------------------------------------------------------
-- 5. corvis_consolidated.snapshot_publication_event (tenant_id FK only; snapshot_id
--    has no FK of its own - it is referenced BY publication_run, not the other way)
--------------------------------------------------------------------------------

insert into corvis_consolidated.snapshot_publication_event (
  tenant_id,publication_event_id,snapshot_id,from_version,to_version,action,actor_subject
) values (
  'b1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000502',
  'b1000000-0000-4000-8000-000000000501',1,2,'publish','ci'
);

do $$
declare
  r uuid := 'b1000000-0000-4000-8000-000000000502';
begin
  perform pg_temp.expect_error(format($f$update corvis_consolidated.snapshot_publication_event set reason = 'edited' where publication_event_id = %L$f$, r),
    'corvis_consolidated.snapshot_publication_event is append-only');
  perform pg_temp.expect_error(format($f$delete from corvis_consolidated.snapshot_publication_event where publication_event_id = %L$f$, r),
    'corvis_consolidated.snapshot_publication_event is append-only');
  -- plain TRUNCATE on this table fails first on Postgres's own FK-reference
  -- check (publication_run references it), before any trigger fires; CASCADE
  -- lets execution reach this table's own BEFORE TRUNCATE trigger.
  perform pg_temp.expect_error('truncate corvis_consolidated.snapshot_publication_event cascade',
    'corvis_consolidated.snapshot_publication_event is append-only');
end $$;

insert into corvis_consolidated.snapshot_publication_event (
  tenant_id,publication_event_id,snapshot_id,from_version,to_version,action,actor_subject
) values (
  'b1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000503',
  'b1000000-0000-4000-8000-000000000501',2,3,'supersede','ci'
);

do $$
begin
  if (select count(*) from corvis_consolidated.snapshot_publication_event where tenant_id = 'b1000000-0000-4000-8000-000000000001') <> 2 then
    raise exception 'recording a new publication event must not be blocked by the append-only guard';
  end if;
end $$;

--------------------------------------------------------------------------------
-- 6. corvis_facts.review_event
--    (needs corvis_source.document_artifact_version + corvis_source.source_reference
--     + corvis_facts.observation; reuses the document from section 2)
--------------------------------------------------------------------------------

insert into corvis_source.document_artifact_version (
  tenant_id,document_artifact_version_id,document_id,ingestion_id,object_uri,size_bytes
) values (
  'b1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000602',
  'b1000000-0000-4000-8000-000000000201','review-ci-v1','gs://ci-fixture/review.pdf',1024
);

insert into corvis_source.source_reference (
  tenant_id,source_reference_id,document_id,document_artifact_version_id
) values (
  'b1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000603',
  'b1000000-0000-4000-8000-000000000201','b1000000-0000-4000-8000-000000000602'
);

insert into corvis_facts.observation (
  tenant_id,observation_id,fund_id,metric_code,value_number,source_reference_id,schema_version
) values (
  'b1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000604',
  'fund-1','nav',100.00,'b1000000-0000-4000-8000-000000000603','1'
);

insert into corvis_facts.review_event (
  tenant_id,review_event_id,observation_id,actor_subject,decision,reason_code,observation_version
) values (
  'b1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000605',
  'b1000000-0000-4000-8000-000000000604','reviewer@example.test','approve','looks_correct',1
);

do $$
declare
  r uuid := 'b1000000-0000-4000-8000-000000000605';
begin
  perform pg_temp.expect_error(format($f$update corvis_facts.review_event set reason_code = 'changed_mind' where review_event_id = %L$f$, r),
    'corvis_facts.review_event is append-only');
  perform pg_temp.expect_error(format($f$delete from corvis_facts.review_event where review_event_id = %L$f$, r),
    'corvis_facts.review_event is append-only');
  perform pg_temp.expect_error('truncate corvis_facts.review_event',
    'corvis_facts.review_event is append-only');
end $$;

insert into corvis_facts.review_event (
  tenant_id,review_event_id,observation_id,actor_subject,decision,reason_code,observation_version
) values (
  'b1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000606',
  'b1000000-0000-4000-8000-000000000604','reviewer@example.test','reject','on_second_look',1
);

do $$
begin
  if (select count(*) from corvis_facts.review_event where tenant_id = 'b1000000-0000-4000-8000-000000000001') <> 2 then
    raise exception 'recording a new review event must not be blocked by the append-only guard';
  end if;
end $$;

rollback;
