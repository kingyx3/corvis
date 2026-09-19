-- Corvis Postgres upload, delivery and operator recovery v1
-- Depends on migrations 001-005.

begin;

-- Processing job IDs are external/API-visible opaque identifiers. Retain UUIDs
-- as a valid shape, but do not require every durable scheduler key to be UUID.
alter table corvis_control.processing_job
  alter column job_id drop default;
alter table corvis_control.processing_job
  alter column job_id type text using job_id::text;

create table if not exists corvis_control.webhook_subscription (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  webhook_id uuid primary key default gen_random_uuid(),
  endpoint_url text not null,
  event_types text[] not null,
  active boolean not null default true,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, webhook_id)
);

create table if not exists corvis_control.webhook_delivery (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  delivery_id uuid primary key default gen_random_uuid(),
  webhook_id uuid not null,
  event_id uuid not null,
  attempt integer not null check (attempt > 0),
  status_code integer,
  state text not null check (state in ('complete','retryable','failed')),
  next_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  last_error text,
  unique (tenant_id, delivery_id),
  foreign key (tenant_id, webhook_id) references corvis_control.webhook_subscription(tenant_id, webhook_id),
  foreign key (tenant_id, event_id) references corvis_control.outbox_event(tenant_id, event_id)
);

alter table corvis_control.webhook_subscription enable row level security;
alter table corvis_control.webhook_delivery enable row level security;
create policy webhook_subscription_tenant_select on corvis_control.webhook_subscription
  for select using (corvis_control.has_tenant_access(tenant_id));
create policy webhook_delivery_tenant_select on corvis_control.webhook_delivery
  for select using (corvis_control.has_tenant_access(tenant_id));

create index if not exists webhook_subscription_active_idx
  on corvis_control.webhook_subscription (tenant_id, active);
create index if not exists webhook_delivery_retry_idx
  on corvis_control.webhook_delivery (tenant_id, state, next_attempt_at);

-- Release of a clean artifact is one atomic transition: source metadata,
-- document state, first processing job and outbox event cannot diverge.
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
begin
  update corvis_source.document_artifact_version
  set storage_generation=p_storage_generation,
      malware_scan_status='clean',
      quarantine_status='released'
  where tenant_id=p_tenant_id and document_artifact_version_id=p_artifact_version_id;

  if not found then raise exception 'artifact not found'; end if;

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

-- Operator retry is similarly atomic with the outbox signal. It returns no row
-- when the optimistic version/state/attempt gate is not satisfied.
create or replace function corvis_control.retry_processing_job(
  p_tenant_id uuid,
  p_job_id text,
  p_expected_version integer,
  p_requested_by text
)
returns integer
language plpgsql
security invoker
as $$
declare
  v_new_version integer;
begin
  update corvis_control.processing_job
  set state='queued', last_error=null, version=version+1, updated_at=now()
  where tenant_id=p_tenant_id and job_id=p_job_id and version=p_expected_version
    and state in ('retryable','failed','dead_letter') and attempt < max_attempts
  returning version into v_new_version;

  if v_new_version is null then return null; end if;

  insert into corvis_control.outbox_event
    (tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload,created_at)
  values (
    p_tenant_id,gen_random_uuid(),'ProcessingJobRetryRequested','processing_job',p_job_id,
    jsonb_build_object('jobId',p_job_id,'requestedBy',p_requested_by),now()
  );
  return v_new_version;
end;
$$;

commit;
