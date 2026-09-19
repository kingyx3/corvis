-- Corvis Postgres identity, immutable correction and snapshot-history v1
-- Depends on migrations 001-004.

begin;

create schema if not exists corvis_identity;

create table if not exists corvis_identity.fund (
  global_fund_id text primary key,
  canonical_name text not null,
  manager_name text,
  created_at timestamptz not null default now()
);

create table if not exists corvis_identity.company (
  global_company_id text primary key,
  canonical_name text not null,
  created_at timestamptz not null default now()
);

-- Source observations remain immutable. A correction is a reviewed overlay that
-- is itself append-only and attributable; serving views select the latest one.
create table if not exists corvis_facts.observation_correction (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  correction_id uuid primary key default gen_random_uuid(),
  observation_id uuid not null,
  based_on_observation_version integer not null check (based_on_observation_version > 0),
  corrected_value_string text,
  corrected_value_number numeric(38,10),
  reason_code text not null,
  actor_subject text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, correction_id),
  foreign key (tenant_id, observation_id) references corvis_facts.observation(tenant_id, observation_id),
  check (corrected_value_string is not null or corrected_value_number is not null)
);

alter table corvis_facts.observation_correction enable row level security;
create policy observation_correction_tenant_select on corvis_facts.observation_correction
  for select using (corvis_control.has_tenant_access(tenant_id));

create index if not exists observation_correction_latest_idx
  on corvis_facts.observation_correction (tenant_id, observation_id, created_at desc);

-- One database call owns the complete review transition so a failed correction,
-- review-event insert or optimistic version check cannot leave partial state.
create or replace function corvis_facts.apply_review_decision(
  p_tenant_id uuid,
  p_observation_id uuid,
  p_expected_version integer,
  p_review_event_id uuid,
  p_actor_subject text,
  p_decision text,
  p_reason_code text,
  p_corrected_value text default null
)
returns table(new_version integer, next_state text)
language plpgsql
security invoker
as $$
declare
  current_row corvis_facts.observation%rowtype;
  computed_state text;
  reviewer_count integer;
begin
  select * into current_row
  from corvis_facts.observation
  where tenant_id=p_tenant_id and observation_id=p_observation_id and version=p_expected_version
  for update;

  if not found then
    return;
  end if;

  if p_decision not in ('approve','reject','correct') then
    raise exception 'invalid review decision';
  end if;
  if p_decision='correct' and p_corrected_value is null then
    raise exception 'corrected value is required';
  end if;

  insert into corvis_facts.review_event
    (tenant_id,review_event_id,observation_id,actor_subject,decision,reason_code,before_value,after_value,observation_version,created_at)
  values (
    p_tenant_id,p_review_event_id,p_observation_id,p_actor_subject,p_decision,p_reason_code,
    jsonb_build_object('valueNumber',current_row.value_number,'valueString',current_row.value_string,'reviewState',current_row.review_state),
    case when p_decision='correct'
      then jsonb_build_object('valueString',p_corrected_value,'reviewState','review_required')
      else jsonb_build_object('valueNumber',current_row.value_number,'valueString',current_row.value_string,'reviewState',case when p_decision='reject' then 'rejected' else 'approved' end)
    end,
    p_expected_version,now()
  );

  if p_decision='correct' then
    insert into corvis_facts.observation_correction
      (tenant_id,observation_id,based_on_observation_version,corrected_value_string,reason_code,actor_subject)
    values (p_tenant_id,p_observation_id,p_expected_version,p_corrected_value,p_reason_code,p_actor_subject);
    computed_state := 'review_required';
  elsif p_decision='reject' then
    computed_state := 'rejected';
  elsif current_row.risk_tier='critical' then
    select count(distinct actor_subject) into reviewer_count
    from corvis_facts.review_event
    where tenant_id=p_tenant_id and observation_id=p_observation_id and decision='approve';
    computed_state := case when reviewer_count >= 2 then 'approved' else 'review_required' end;
  else
    computed_state := 'approved';
  end if;

  update corvis_facts.observation
  set review_state=computed_state, version=version+1, updated_at=now()
  where tenant_id=p_tenant_id and observation_id=p_observation_id and version=p_expected_version;

  return query select p_expected_version + 1, computed_state;
end;
$$;

-- Publication transitions are append-only. Each command creates a new immutable
-- snapshot version plus attributable publication/outbox events in one transaction.
create table if not exists corvis_consolidated.snapshot_publication_event (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  publication_event_id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null,
  from_version integer not null check (from_version > 0),
  to_version integer not null check (to_version > from_version),
  action text not null check (action in ('publish','withdraw','supersede')),
  actor_subject text not null,
  reason text,
  created_at timestamptz not null default now(),
  unique (tenant_id, publication_event_id)
);

alter table corvis_consolidated.snapshot_publication_event enable row level security;
create policy snapshot_publication_event_tenant_select on corvis_consolidated.snapshot_publication_event
  for select using (corvis_control.has_tenant_access(tenant_id));

create or replace function corvis_consolidated.append_snapshot_transition(
  p_tenant_id uuid,
  p_snapshot_id uuid,
  p_expected_version integer,
  p_publication_event_id uuid,
  p_action text,
  p_actor_subject text,
  p_reason text default null
)
returns integer
language plpgsql
security invoker
as $$
declare
  current_row corvis_consolidated.fund_period_snapshot%rowtype;
  next_status text;
  next_version integer;
begin
  select * into current_row
  from corvis_consolidated.fund_period_snapshot
  where tenant_id=p_tenant_id and snapshot_id=p_snapshot_id and version=p_expected_version
  for update;

  if not found then return null; end if;
  if p_action not in ('publish','withdraw','supersede') then raise exception 'invalid publication action'; end if;

  next_status := case p_action when 'publish' then 'published' when 'withdraw' then 'withdrawn' else 'superseded' end;
  next_version := p_expected_version + 1;

  insert into corvis_consolidated.fund_period_snapshot
    (tenant_id,snapshot_id,fund_id,report_period,version,status,fact_ids,blocking_exception_count,schema_version,taxonomy_version,created_at,published_at)
  values (
    current_row.tenant_id,current_row.snapshot_id,current_row.fund_id,current_row.report_period,next_version,next_status,
    current_row.fact_ids,current_row.blocking_exception_count,current_row.schema_version,current_row.taxonomy_version,now(),
    case when next_status='published' then now() else current_row.published_at end
  );

  insert into corvis_consolidated.snapshot_publication_event
    (tenant_id,publication_event_id,snapshot_id,from_version,to_version,action,actor_subject,reason)
  values (p_tenant_id,p_publication_event_id,p_snapshot_id,p_expected_version,next_version,p_action,p_actor_subject,p_reason);

  insert into corvis_control.outbox_event
    (tenant_id,event_id,event_type,aggregate_type,aggregate_id,payload,created_at)
  values (
    p_tenant_id,gen_random_uuid(),'SnapshotPublicationChanged','fund_period_snapshot',p_snapshot_id::text,
    jsonb_build_object('action',p_action,'actor',p_actor_subject,'reason',p_reason,'version',next_version),now()
  );

  return next_version;
end;
$$;

create or replace view corvis_serving.observations as
with latest_correction as (
  select distinct on (tenant_id, observation_id)
         tenant_id, observation_id, corrected_value_string, corrected_value_number, created_at
  from corvis_facts.observation_correction
  order by tenant_id, observation_id, created_at desc
)
select o.tenant_id,
       o.observation_id,
       o.fund_id,
       o.company_id,
       c.canonical_name as company_name,
       o.holding_id,
       o.instrument_id,
       o.metric_code,
       coalesce(lc.corrected_value_number, o.value_number) as value_number,
       coalesce(lc.corrected_value_string, o.value_string) as value_string,
       o.currency,
       o.economic_period,
       o.report_date,
       o.review_state,
       o.source_reference_id,
       r.document_id,
       r.page_number,
       r.sheet_name,
       r.cell_range,
       o.confidence_score,
       o.delta_display,
       o.risk_tier,
       o.version,
       o.updated_at
from corvis_facts.observation o
left join corvis_identity.company c on c.global_company_id = o.company_id
left join corvis_source.source_reference r
  on r.tenant_id=o.tenant_id and r.source_reference_id=o.source_reference_id
left join latest_correction lc
  on lc.tenant_id=o.tenant_id and lc.observation_id=o.observation_id
where o.review_state in ('approved','review_required');

create or replace view corvis_serving.fund_period_snapshots as
select s.tenant_id,
       s.snapshot_id,
       s.fund_id,
       f.canonical_name as fund_name,
       s.report_period,
       s.version,
       s.status,
       cardinality(s.fact_ids) as fact_count,
       s.blocking_exception_count,
       s.schema_version,
       s.taxonomy_version,
       s.created_at,
       s.published_at
from corvis_consolidated.fund_period_snapshot s
left join corvis_identity.fund f on f.global_fund_id=s.fund_id;

commit;
