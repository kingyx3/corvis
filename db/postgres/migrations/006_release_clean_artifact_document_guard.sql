-- corvis_source.release_clean_artifact(tenant, document_id, artifact_version_id, ...) looked up
-- the artifact by (tenant_id, document_artifact_version_id) only and never checked that the
-- looked-up row's own document_id matches the caller-supplied p_document_id. Every current call
-- site passes both ids from the same already-joined row, so this wasn't reachable today, but
-- unlike sibling functions (e.g. apply_review_decision, disable_service_account) it never
-- re-derived or cross-checked the linked id: a future caller passing a mismatched (tenant-scoped)
-- pair would have silently flipped an unrelated document's status to 'queued', enqueued a
-- processing_job keyed to the wrong document, and announced the wrong document in a
-- DocumentRegistered outbox event.

begin;

create or replace function corvis_source.release_clean_artifact(p_tenant_id uuid, p_document_id uuid, p_artifact_version_id uuid, p_storage_generation text, p_ingestion_id text) returns text
    language plpgsql
    as $$
declare
  v_job_id text := 'registered:' || p_document_id::text;
  v_document_id uuid;
  v_previous text;
  v_scan text;
begin
  select a.document_id, a.quarantine_status, a.malware_scan_status into v_document_id, v_previous, v_scan
  from corvis_source.document_artifact_version a
  where a.tenant_id=p_tenant_id and a.document_artifact_version_id=p_artifact_version_id
  for update;

  if not found then raise exception 'artifact not found'; end if;
  if v_document_id <> p_document_id then raise exception 'artifact does not belong to document'; end if;
  if v_previous not in ('pending','quarantined','released') then
    raise exception 'artifact was purged and cannot be released';
  end if;
  -- A threat, integrity or content-validation verdict is terminal: never overwrite it with 'clean'.
  if v_scan not in ('pending','clean') then
    raise exception 'artifact scan verdict % blocks release', v_scan;
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
