-- Acceptance: the two ledgers guarded by
-- 009_entity_lifecycle_observation_correction_append_only.sql are actually append-only.
--
--   corvis_identity.entity_lifecycle_event
--   corvis_facts.observation_correction
--
-- Before 009, neither had a BEFORE DELETE OR UPDATE row trigger or a BEFORE
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
values ('b1000000-0000-4000-8000-000000000001','entity-lifecycle-append-only','Entity Lifecycle Append Only');

--------------------------------------------------------------------------------
-- 1. corvis_identity.entity_lifecycle_event (no tenant_id - shared/governed table)
--------------------------------------------------------------------------------

insert into corvis_identity.entity_lifecycle_event (
  lifecycle_event_id,event_type,event_status,announced_date,effective_date,description,source_kind
) values (
  'b2000000-0000-4000-8000-000000000101','acquisition','completed','2024-01-01','2024-02-01',
  'fixture lifecycle event','governed'
);

do $$
declare
  r uuid := 'b2000000-0000-4000-8000-000000000101';
begin
  perform pg_temp.expect_error(format($f$update corvis_identity.entity_lifecycle_event set description = 'changed' where lifecycle_event_id = %L$f$, r),
    'corvis_identity.entity_lifecycle_event is append-only');
  perform pg_temp.expect_error(format($f$delete from corvis_identity.entity_lifecycle_event where lifecycle_event_id = %L$f$, r),
    'corvis_identity.entity_lifecycle_event is append-only');
  -- plain TRUNCATE fails first on Postgres's own FK-reference check (entity_relationship,
  -- tenant_entity_lifecycle_evidence, tenant_lifecycle_revision all reference it); CASCADE
  -- lets execution reach this table's own BEFORE TRUNCATE trigger.
  perform pg_temp.expect_error('truncate corvis_identity.entity_lifecycle_event cascade',
    'corvis_identity.entity_lifecycle_event is append-only');
end $$;

insert into corvis_identity.entity_lifecycle_event (
  lifecycle_event_id,event_type,event_status,announced_date,effective_date,description,source_kind
) values (
  'b2000000-0000-4000-8000-000000000102','merger','completed','2024-03-01','2024-04-01',
  'second fixture lifecycle event','governed'
);

do $$
begin
  if (select count(*) from corvis_identity.entity_lifecycle_event where lifecycle_event_id in ('b2000000-0000-4000-8000-000000000101','b2000000-0000-4000-8000-000000000102')) <> 2 then
    raise exception 'recording a new lifecycle event must not be blocked by the append-only guard';
  end if;
end $$;

--------------------------------------------------------------------------------
-- 2. corvis_facts.observation_correction (needs corvis_facts.observation, which needs
--    a document + document_artifact_version + source_reference)
--------------------------------------------------------------------------------

insert into corvis_source.document (
  tenant_id,document_id,display_name,media_type,status,created_by
) values (
  'b1000000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000204',
  'Correction fixture document','application/pdf','registered','ci'
);

insert into corvis_source.document_artifact_version (
  tenant_id,document_artifact_version_id,document_id,ingestion_id,object_uri,size_bytes
) values (
  'b1000000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000205',
  'b2000000-0000-4000-8000-000000000204','correction-ci-v1','gs://ci-fixture/correction.pdf',1024
);

insert into corvis_source.source_reference (
  tenant_id,source_reference_id,document_id,document_artifact_version_id
) values (
  'b1000000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000206',
  'b2000000-0000-4000-8000-000000000204','b2000000-0000-4000-8000-000000000205'
);

insert into corvis_facts.observation (
  tenant_id,observation_id,fund_id,metric_code,value_number,source_reference_id,schema_version
) values (
  'b1000000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000201',
  'fund-1','nav',100.00,'b2000000-0000-4000-8000-000000000206','1'
);

insert into corvis_facts.observation_correction (
  tenant_id,correction_id,observation_id,based_on_observation_version,corrected_value_number,reason_code,actor_subject
) values (
  'b1000000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000202',
  'b2000000-0000-4000-8000-000000000201',1,110.00,'restatement','reviewer@example.test'
);

do $$
declare
  r uuid := 'b2000000-0000-4000-8000-000000000202';
begin
  perform pg_temp.expect_error(format($f$update corvis_facts.observation_correction set reason_code = 'changed' where correction_id = %L$f$, r),
    'corvis_facts.observation_correction is append-only');
  perform pg_temp.expect_error(format($f$delete from corvis_facts.observation_correction where correction_id = %L$f$, r),
    'corvis_facts.observation_correction is append-only');
  perform pg_temp.expect_error('truncate corvis_facts.observation_correction',
    'corvis_facts.observation_correction is append-only');
end $$;

insert into corvis_facts.observation_correction (
  tenant_id,correction_id,observation_id,based_on_observation_version,corrected_value_number,reason_code,actor_subject
) values (
  'b1000000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000203',
  'b2000000-0000-4000-8000-000000000201',2,120.00,'restatement','reviewer@example.test'
);

do $$
begin
  if (select count(*) from corvis_facts.observation_correction where tenant_id = 'b1000000-0000-4000-8000-000000000001') <> 2 then
    raise exception 'recording a new correction must not be blocked by the append-only guard';
  end if;
end $$;

rollback;
