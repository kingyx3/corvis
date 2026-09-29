-- Acceptance for migration 067: the latest-artifact index exists and is usable by the
-- documents view's DISTINCT ON, export_job_state_check is validated on a database
-- with no violating rows, and entity_lifecycle_participant has a primary key that
-- ordinary inserts (explicit column list) populate automatically. Run after the full
-- migration chain on an isolated disposable database. Rolled back.

\set ON_ERROR_STOP on

begin;

do $$
declare
  participant record;
begin
  if not exists (
    select 1 from pg_indexes
    where schemaname='corvis_source' and tablename='document_artifact_version'
      and indexname='document_artifact_version_document_created_idx'
      and indexdef like '%(tenant_id, document_id, created_at DESC)%'
  ) then raise exception 'document_artifact_version latest-artifact index is missing'; end if;

  if exists (select 1 from pg_constraint where conname='export_job_state_check'
             and conrelid='corvis_serving.export_job'::regclass and not convalidated) then
    raise exception 'export_job_state_check must be validated when no row violates it';
  end if;

  if not exists (select 1 from pg_constraint where contype='p'
                 and conrelid='corvis_identity.entity_lifecycle_participant'::regclass) then
    raise exception 'entity_lifecycle_participant must have a primary key';
  end if;

  insert into corvis_identity.company (global_company_id,canonical_name) values ('integrity-c1','Integrity C1'),('integrity-c2','Integrity C2');
  insert into corvis_identity.entity_lifecycle_event (lifecycle_event_id,event_type,event_status,source_kind)
    values ('e6700000-0000-4000-8000-000000000001','acquisition','completed','governed');
  insert into corvis_identity.entity_lifecycle_participant (lifecycle_event_id,company_id,participant_role)
    values ('e6700000-0000-4000-8000-000000000001','integrity-c1','acquirer'),
           ('e6700000-0000-4000-8000-000000000001','integrity-c2','acquired');
  select count(distinct participant_id) as ids, count(*) as total into participant
    from corvis_identity.entity_lifecycle_participant where lifecycle_event_id='e6700000-0000-4000-8000-000000000001';
  if participant.ids <> 2 or participant.total <> 2 then
    raise exception 'each participant row must get its own generated key: %', participant;
  end if;
end $$;

-- The ordering key of the documents view is now index-orderable without a sort.
set local enable_seqscan = off;
do $$
declare
  plan text;
begin
  for plan in execute 'explain select distinct on (tenant_id, document_id) tenant_id, document_id from corvis_source.document_artifact_version order by tenant_id, document_id, created_at desc' loop
    if plan like '%document_artifact_version_document_created_idx%' then return; end if;
  end loop;
  raise exception 'the latest-artifact query must be able to use document_artifact_version_document_created_idx';
end $$;

rollback;
