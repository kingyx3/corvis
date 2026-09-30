-- release_clean_artifact must never resurrect a purged artifact and must be idempotent.
-- Depends on migrations 001-070.
--
-- 006 released unconditionally: it set quarantine_status='released' and re-queued the document
-- on every call. Two consequences found in review:
--   * A release that raced an abort, an expiry or the upload sweep (all of which mark the artifact
--     `purged` and delete its bytes) overwrote `purged` with `released` and queued a processing job
--     for bytes that no longer exist.
--   * A second call for an already released artifact reset the document back to `queued`, moving
--     it backwards after processing had started (worked around in application code by #268).
-- The function now takes a row lock, refuses anything that is not pending, quarantined or already
-- released, and returns the existing job id without touching state when the artifact is already
-- released.

begin;

create or replace function corvis_source.release_clean_artifact(
  p_tenant_id uuid,
  p_document_id uuid,
  p_artifact_version_id uuid,
  p_storage_generation text,
  p_ingestion_id text
)
returns text
language plpgsql
security invoker
as $$
declare
  v_job_id text := 'registered:' || p_document_id::text;
  v_previous text;
begin
  select a.quarantine_status into v_previous
  from corvis_source.document_artifact_version a
  where a.tenant_id=p_tenant_id and a.document_artifact_version_id=p_artifact_version_id
  for update;

  if not found then raise exception 'artifact not found'; end if;
  if v_previous not in ('pending','quarantined','released') then
    raise exception 'artifact was purged and cannot be released';
  end if;
  -- Idempotent: an artifact that is already released keeps its job and its document status.
  if v_previous = 'released' then return v_job_id; end if;

  update corvis_source.document_artifact_version
  set storage_generation=p_storage_generation,
      malware_scan_status='clean',
      quarantine_status='released'
  where tenant_id=p_tenant_id and document_artifact_version_id=p_artifact_version_id;

  update corvis_source.document set status='queued'
  where tenant_id=p_tenant_id and document_id=p_document_id;

  insert into corvis_control.processing_job
    (tenant_id,job_id,document_id,stage,state,attempt,max_attempts,correlation_id,version,created_at,updated_at)
  values (p_tenant_id,v_job_id,p_document_id,'registered','queued',0,5,p_ingestion_id,1,now(),now())
  on conflict (tenant_id, job_id) do nothing;

  if not exists (
    select 1 from corvis_control.outbox_event
    where tenant_id=p_tenant_id and event_type='DocumentRegistered'
      and aggregate_type='document' and aggregate_id=p_document_id::text
  ) then
    insert into corvis_control.outbox_event
      (tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload,created_at)
    values (
      p_tenant_id,gen_random_uuid(),'DocumentRegistered','document',p_document_id::text,
      jsonb_build_object('documentId',p_document_id,'artifactVersionId',p_artifact_version_id,'ingestionId',p_ingestion_id),now()
    );
  end if;

  return v_job_id;
end;
$$;

commit;
