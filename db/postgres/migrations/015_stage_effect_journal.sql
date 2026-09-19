-- Corvis idempotent processing-stage effect journal v1
-- Depends on migrations 001-014.

begin;

create table if not exists corvis_control.processing_stage_effect (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  job_id text not null,
  effect_key text not null,
  document_id uuid not null,
  stage text not null,
  state text not null check (state in ('started','complete')),
  attempt_count integer not null default 1 check (attempt_count > 0),
  first_started_at timestamptz not null default now(),
  last_started_at timestamptz not null default now(),
  completed_at timestamptz,
  result jsonb,
  primary key (tenant_id, job_id, effect_key),
  foreign key (tenant_id, job_id) references corvis_control.processing_job(tenant_id, job_id),
  foreign key (tenant_id, document_id) references corvis_source.document(tenant_id, document_id)
);

alter table corvis_control.processing_stage_effect enable row level security;
alter table corvis_control.processing_stage_effect force row level security;

-- Worker/server managed only. No client mutation policy is intentionally created.
create index if not exists processing_stage_effect_document_idx
  on corvis_control.processing_stage_effect (tenant_id, document_id, stage, last_started_at desc);

create or replace function corvis_control.begin_processing_stage_effect(
  p_tenant_id uuid,
  p_job_id text,
  p_effect_key text,
  p_document_id uuid,
  p_stage text
)
returns table(
  should_execute boolean,
  already_complete boolean,
  effect_attempt integer
)
language plpgsql
security invoker
as $$
declare
  current_effect corvis_control.processing_stage_effect%rowtype;
  current_job corvis_control.processing_job%rowtype;
  inserted_count integer;
begin
  if p_effect_key is null or btrim(p_effect_key)='' then raise exception 'effect key is required'; end if;

  select * into current_job
  from corvis_control.processing_job
  where tenant_id=p_tenant_id and job_id=p_job_id
    and document_id=p_document_id and stage=p_stage
  for update;

  if not found then raise exception 'processing job not found for effect'; end if;
  if current_job.state <> 'running' then raise exception 'processing job is not running'; end if;

  insert into corvis_control.processing_stage_effect (
    tenant_id,job_id,effect_key,document_id,stage,state,attempt_count,first_started_at,last_started_at
  ) values (
    p_tenant_id,p_job_id,p_effect_key,p_document_id,p_stage,'started',1,now(),now()
  ) on conflict (tenant_id,job_id,effect_key) do nothing;
  get diagnostics inserted_count = row_count;

  select * into current_effect
  from corvis_control.processing_stage_effect
  where tenant_id=p_tenant_id and job_id=p_job_id and effect_key=p_effect_key
  for update;

  if current_effect.document_id <> p_document_id or current_effect.stage <> p_stage then
    raise exception 'effect key metadata mismatch';
  end if;

  if current_effect.state='complete' then
    return query select false,true,current_effect.attempt_count;
    return;
  end if;

  if inserted_count=0 then
    update corvis_control.processing_stage_effect
    set attempt_count=attempt_count+1,last_started_at=now()
    where tenant_id=p_tenant_id and job_id=p_job_id and effect_key=p_effect_key
    returning * into current_effect;
  end if;

  return query select true,false,current_effect.attempt_count;
end;
$$;

create or replace function corvis_control.complete_processing_stage_effect(
  p_tenant_id uuid,
  p_job_id text,
  p_effect_key text,
  p_result jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security invoker
as $$
begin
  update corvis_control.processing_stage_effect
  set state='complete',completed_at=coalesce(completed_at,now()),result=coalesce(p_result,'{}'::jsonb)
  where tenant_id=p_tenant_id and job_id=p_job_id and effect_key=p_effect_key
    and state in ('started','complete');
  return found;
end;
$$;

commit;
