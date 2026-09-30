-- Acceptance for migration 071: corvis_source.release_clean_artifact releases a pending or
-- quarantined artifact once, is idempotent for an already released one (it must not move the
-- document backwards), and refuses an artifact that was purged by an abort, expiry or sweep.
-- Run after the full migration chain on an isolated disposable database. Rolled back.

\set ON_ERROR_STOP on

begin;

insert into corvis_control.tenant (tenant_id,slug,display_name)
values ('a0710000-0000-4000-8000-000000000001','release-guard-ci','Release Guard CI');

insert into corvis_source.document (tenant_id,document_id,display_name,media_type,status,created_by) values
  ('a0710000-0000-4000-8000-000000000001','a0710000-0000-4000-8000-0000000000d1','a.pdf','application/pdf','quarantined','ci'),
  ('a0710000-0000-4000-8000-000000000001','a0710000-0000-4000-8000-0000000000d2','b.pdf','application/pdf','aborted','ci');
insert into corvis_source.document_artifact_version
  (tenant_id,document_artifact_version_id,document_id,ingestion_id,object_uri,size_bytes,malware_scan_status,quarantine_status) values
  ('a0710000-0000-4000-8000-000000000001','a0710000-0000-4000-8000-0000000000a1','a0710000-0000-4000-8000-0000000000d1','ing-1','gs://b/a.pdf',10,'pending','quarantined'),
  ('a0710000-0000-4000-8000-000000000001','a0710000-0000-4000-8000-0000000000a2','a0710000-0000-4000-8000-0000000000d2','ing-2','gs://b/b.pdf',10,'pending','purged');

do $$
declare
  tenant uuid := 'a0710000-0000-4000-8000-000000000001';
  doc_ok uuid := 'a0710000-0000-4000-8000-0000000000d1';
  art_ok uuid := 'a0710000-0000-4000-8000-0000000000a1';
  doc_purged uuid := 'a0710000-0000-4000-8000-0000000000d2';
  art_purged uuid := 'a0710000-0000-4000-8000-0000000000a2';
  job text;
  again text;
  n integer;
  failure text;
  status_value text;
begin
  -- 1. A quarantined artifact is released: registry, document, job and outbox event all move.
  job := corvis_source.release_clean_artifact(tenant,doc_ok,art_ok,'gen-1','ing-1');
  if job <> 'registered:' || doc_ok::text then raise exception 'unexpected job id %', job; end if;
  if (select quarantine_status from corvis_source.document_artifact_version where document_artifact_version_id=art_ok) <> 'released' then
    raise exception 'artifact must be released';
  end if;
  if (select status from corvis_source.document where document_id=doc_ok) <> 'queued' then
    raise exception 'document must be queued after release';
  end if;
  select count(*) into n from corvis_control.processing_job where tenant_id=tenant and job_id=job and stage='registered' and state='queued';
  if n <> 1 then raise exception 'expected one queued registered job, got %', n; end if;

  -- 2. Processing advances; a second release (retry, overlapping tick) must not move it backwards.
  update corvis_source.document set status='extracting' where document_id=doc_ok;
  again := corvis_source.release_clean_artifact(tenant,doc_ok,art_ok,'gen-1','ing-1');
  if again <> job then raise exception 'a repeated release must return the same job id, got %', again; end if;
  select status into status_value from corvis_source.document where document_id=doc_ok;
  if status_value <> 'extracting' then
    raise exception 'a repeated release must not reset the document (status is now %)', status_value;
  end if;
  select count(*) into n from corvis_control.outbox_event
    where tenant_id=tenant and event_type='DocumentRegistered' and aggregate_id=doc_ok::text;
  if n <> 1 then raise exception 'a repeated release must not announce the document again, got % events', n; end if;

  -- 3. A purged artifact (abort / expiry / sweep) is never resurrected and no job is created.
  begin
    perform corvis_source.release_clean_artifact(tenant,doc_purged,art_purged,'gen-2','ing-2');
    raise exception 'a purged artifact must not be released';
  exception when others then
    get stacked diagnostics failure = message_text;
    if failure <> 'artifact was purged and cannot be released' then raise exception 'unexpected purged failure: %', failure; end if;
  end;
  if (select quarantine_status from corvis_source.document_artifact_version where document_artifact_version_id=art_purged) <> 'purged' then
    raise exception 'a refused release must leave the artifact purged';
  end if;
  if (select status from corvis_source.document where document_id=doc_purged) <> 'aborted' then
    raise exception 'a refused release must leave the aborted document alone';
  end if;
  select count(*) into n from corvis_control.processing_job where tenant_id=tenant and document_id=doc_purged;
  if n <> 0 then raise exception 'a refused release must not create a job, got %', n; end if;

  -- 4. An unknown artifact is refused.
  begin
    perform corvis_source.release_clean_artifact(tenant,doc_ok,'a0710000-0000-4000-8000-0000000000ff','gen-3','ing-3');
    raise exception 'an unknown artifact must not be released';
  exception when others then
    get stacked diagnostics failure = message_text;
    if failure <> 'artifact not found' then raise exception 'unexpected unknown-artifact failure: %', failure; end if;
  end;
end;
$$;

rollback;
