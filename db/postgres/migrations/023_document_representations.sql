-- Corvis durable document representation lineage v1
-- Depends on migrations 001-022.

begin;

create table if not exists corvis_source.document_representation (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  representation_id uuid not null,
  document_id uuid not null,
  document_artifact_version_id uuid not null,
  representation_type text not null,
  object_uri text not null,
  storage_generation text not null,
  content_sha256 text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  producer text not null,
  producer_version text not null,
  method text not null check (method in ('native','ocr','vision','hybrid')),
  status text not null check (status in ('ready')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, representation_id),
  foreign key (tenant_id, document_id)
    references corvis_source.document(tenant_id, document_id),
  foreign key (tenant_id, document_artifact_version_id)
    references corvis_source.document_artifact_version(tenant_id, document_artifact_version_id),
  unique (tenant_id, document_artifact_version_id, representation_type),
  check (object_uri like 'gs://%'),
  check (storage_generation <> ''),
  check (content_sha256 ~ '^[0-9a-f]{64}$')
);

alter table corvis_source.document_representation enable row level security;
alter table corvis_source.document_representation force row level security;

-- Server/worker managed only. Representation metadata is reached through governed
-- application repositories; no direct client mutation/read policy is created here.
create index if not exists document_representation_document_idx
  on corvis_source.document_representation
    (tenant_id, document_id, document_artifact_version_id, created_at desc);

-- A downstream stage must receive the exact immutable result that its predecessor
-- committed to the processing-stage effect journal. Keep object URIs and source
-- payloads out of the event; the next handler re-resolves them through its own
-- tenant/document-scoped repository.
create or replace function corvis_control.attach_processing_stage_predecessor_result()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  predecessor_job_id text;
  predecessor_result jsonb;
begin
  predecessor_job_id := new.payload ->> 'predecessorJobId';
  if predecessor_job_id is null or btrim(predecessor_job_id) = '' then
    raise exception 'processing stage ready event is missing predecessor job id';
  end if;

  select e.result
    into predecessor_result
  from corvis_control.processing_stage_effect e
  where e.tenant_id = new.tenant_id
    and e.job_id = predecessor_job_id
    and e.state = 'complete'
  order by e.completed_at desc nulls last, e.effect_key
  limit 1;

  if not found then
    raise exception 'processing stage predecessor effect is not complete';
  end if;

  new.payload := jsonb_set(
    new.payload,
    '{predecessorResult}',
    coalesce(predecessor_result, '{}'::jsonb),
    true
  );
  return new;
end;
$$;

drop trigger if exists outbox_processing_stage_predecessor_result
  on corvis_control.outbox_event;
create trigger outbox_processing_stage_predecessor_result
before insert on corvis_control.outbox_event
for each row
when (new.event_type = 'ProcessingStageReady')
execute function corvis_control.attach_processing_stage_predecessor_result();

commit;
