-- Corvis governed reconciliation exceptions and publication enforcement v1
-- Depends on migrations 001-011.

begin;

create table if not exists corvis_consolidated.reconciliation_exception (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  exception_id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null,
  snapshot_version integer not null check (snapshot_version > 0),
  exception_key text not null,
  fund_id text not null,
  report_period text not null,
  exception_type text not null check (exception_type in ('source_authority','materiality','reconciliation_conflict')),
  subject_type text,
  subject_id text,
  metric_code text,
  summary text not null,
  materiality text not null default 'unknown' check (materiality in ('unknown','immaterial','material')),
  competing_source_reference_ids uuid[] not null default '{}',
  context jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open','resolved')),
  version integer not null default 1 check (version > 0),
  created_by text not null,
  created_at timestamptz not null default now(),
  resolved_by text,
  resolved_at timestamptz,
  foreign key (tenant_id, snapshot_id, snapshot_version)
    references corvis_consolidated.fund_period_snapshot(tenant_id, snapshot_id, version),
  unique (tenant_id, exception_id),
  unique (tenant_id, snapshot_id, snapshot_version, exception_key)
);

create table if not exists corvis_consolidated.reconciliation_resolution_event (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  resolution_event_id uuid primary key default gen_random_uuid(),
  exception_id uuid not null,
  exception_version integer not null check (exception_version > 0),
  action text not null check (action in ('select_source','mark_immaterial','accept_reconciliation')),
  selected_source_reference_id uuid,
  reason_code text not null,
  note text,
  actor_subject text not null,
  before_state jsonb not null,
  after_state jsonb not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, exception_id)
    references corvis_consolidated.reconciliation_exception(tenant_id, exception_id),
  unique (tenant_id, resolution_event_id)
);

alter table corvis_consolidated.reconciliation_exception enable row level security;
alter table corvis_consolidated.reconciliation_resolution_event enable row level security;

create policy reconciliation_exception_tenant_select on corvis_consolidated.reconciliation_exception
  for select using (corvis_control.has_tenant_access(tenant_id));
create policy reconciliation_resolution_event_tenant_select on corvis_consolidated.reconciliation_resolution_event
  for select using (corvis_control.has_tenant_access(tenant_id));

create index if not exists reconciliation_exception_snapshot_idx
  on corvis_consolidated.reconciliation_exception (tenant_id, snapshot_id, snapshot_version, status, created_at);
create index if not exists reconciliation_exception_fund_idx
  on corvis_consolidated.reconciliation_exception (tenant_id, fund_id, report_period, status);
create index if not exists reconciliation_resolution_exception_idx
  on corvis_consolidated.reconciliation_resolution_event (tenant_id, exception_id, created_at desc);

-- Preserve existing blocker counts as individually resolvable records so the
-- migration cannot accidentally turn historical publication blockers into zero.
insert into corvis_consolidated.reconciliation_exception (
  tenant_id,snapshot_id,snapshot_version,exception_key,fund_id,report_period,
  exception_type,summary,materiality,context,created_by
)
select
  s.tenant_id,s.snapshot_id,s.version,'legacy:blocker:' || blocker.n,s.fund_id,s.report_period,
  'reconciliation_conflict','Migrated publication blocker ' || blocker.n,'unknown',
  jsonb_build_object('legacyBlockingExceptionIndex',blocker.n,'legacyBlockingExceptionCount',s.blocking_exception_count),
  'migration:012'
from corvis_consolidated.fund_period_snapshot s
cross join lateral generate_series(1, s.blocking_exception_count) blocker(n)
where s.blocking_exception_count > 0
on conflict (tenant_id, snapshot_id, snapshot_version, exception_key) do nothing;

create or replace function corvis_consolidated.resolve_reconciliation_exception(
  p_tenant_id uuid,
  p_exception_id uuid,
  p_expected_version integer,
  p_resolution_event_id uuid,
  p_actor_subject text,
  p_action text,
  p_reason_code text,
  p_selected_source_reference_id uuid default null,
  p_note text default null
)
returns table(new_version integer, next_status text)
language plpgsql
security invoker
as $$
declare
  current_row corvis_consolidated.reconciliation_exception%rowtype;
  before_payload jsonb;
  after_payload jsonb;
begin
  select * into current_row
  from corvis_consolidated.reconciliation_exception
  where tenant_id=p_tenant_id
    and exception_id=p_exception_id
    and version=p_expected_version
    and status='open'
  for update;

  if not found then
    return;
  end if;

  if current_row.exception_type='source_authority' then
    if p_action <> 'select_source' then raise exception 'invalid source-authority resolution'; end if;
    if p_selected_source_reference_id is null or not (p_selected_source_reference_id = any(current_row.competing_source_reference_ids)) then
      raise exception 'selected source is not a competing source';
    end if;
  elsif current_row.exception_type='materiality' then
    if p_action <> 'mark_immaterial' then raise exception 'invalid materiality resolution'; end if;
  elsif current_row.exception_type='reconciliation_conflict' then
    if p_action <> 'accept_reconciliation' then raise exception 'invalid reconciliation resolution'; end if;
  else
    raise exception 'unknown reconciliation exception type';
  end if;

  before_payload := jsonb_build_object(
    'status',current_row.status,
    'version',current_row.version,
    'materiality',current_row.materiality,
    'competingSourceReferenceIds',current_row.competing_source_reference_ids
  );
  after_payload := jsonb_build_object(
    'status','resolved',
    'version',current_row.version + 1,
    'action',p_action,
    'selectedSourceReferenceId',p_selected_source_reference_id,
    'reasonCode',p_reason_code
  );

  insert into corvis_consolidated.reconciliation_resolution_event (
    tenant_id,resolution_event_id,exception_id,exception_version,action,
    selected_source_reference_id,reason_code,note,actor_subject,before_state,after_state,created_at
  ) values (
    p_tenant_id,p_resolution_event_id,p_exception_id,p_expected_version,p_action,
    p_selected_source_reference_id,p_reason_code,p_note,p_actor_subject,before_payload,after_payload,now()
  );

  update corvis_consolidated.reconciliation_exception
  set status='resolved', version=version+1, resolved_by=p_actor_subject, resolved_at=now(),
      materiality=case when p_action='mark_immaterial' then 'immaterial' else materiality end
  where tenant_id=p_tenant_id and exception_id=p_exception_id and version=p_expected_version;

  return query select p_expected_version + 1, 'resolved'::text;
end;
$$;

create or replace view corvis_serving.reconciliation_exceptions as
select e.tenant_id,e.exception_id,e.snapshot_id,e.snapshot_version,e.exception_key,
       e.fund_id,e.report_period,e.exception_type,e.subject_type,e.subject_id,e.metric_code,
       e.summary,e.materiality,e.competing_source_reference_ids,e.context,e.status,e.version,
       e.created_by,e.created_at,e.resolved_by,e.resolved_at
from corvis_consolidated.reconciliation_exception e;

create or replace view corvis_serving.fund_period_snapshots as
select s.tenant_id,
       s.snapshot_id,
       s.fund_id,
       f.canonical_name as fund_name,
       s.report_period,
       s.version,
       s.status,
       cardinality(s.fact_ids) as fact_count,
       case
         when exists (
           select 1 from corvis_consolidated.reconciliation_exception e
           where e.tenant_id=s.tenant_id and e.snapshot_id=s.snapshot_id and e.snapshot_version=s.version
         ) then (
           select count(*)::integer from corvis_consolidated.reconciliation_exception e
           where e.tenant_id=s.tenant_id and e.snapshot_id=s.snapshot_id and e.snapshot_version=s.version and e.status='open'
         )
         else s.blocking_exception_count
       end as blocking_exception_count,
       s.schema_version,
       s.taxonomy_version,
       s.created_at,
       s.published_at
from corvis_consolidated.fund_period_snapshot s
left join corvis_identity.fund f on f.global_fund_id=s.fund_id;

-- Publication enforcement is repeated at the persistence boundary. Application
-- checks improve UX, but callers cannot bypass unresolved exceptions or the
-- critical-observation four-eyes rule by invoking this function directly.
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
  effective_blockers integer;
begin
  select * into current_row
  from corvis_consolidated.fund_period_snapshot
  where tenant_id=p_tenant_id and snapshot_id=p_snapshot_id and version=p_expected_version
  for update;

  if not found then return null; end if;
  if p_action not in ('publish','withdraw','supersede') then raise exception 'invalid publication action'; end if;

  if exists (
    select 1 from corvis_consolidated.reconciliation_exception e
    where e.tenant_id=p_tenant_id and e.snapshot_id=p_snapshot_id and e.snapshot_version=p_expected_version
  ) then
    select count(*)::integer into effective_blockers
    from corvis_consolidated.reconciliation_exception e
    where e.tenant_id=p_tenant_id and e.snapshot_id=p_snapshot_id and e.snapshot_version=p_expected_version and e.status='open';
  else
    effective_blockers := current_row.blocking_exception_count;
  end if;

  if p_action='publish' then
    if effective_blockers > 0 then raise exception 'blocking reconciliation exceptions remain'; end if;
    if exists (
      select 1 from corvis_facts.observation o
      where o.tenant_id=p_tenant_id and o.fund_id=current_row.fund_id and o.review_state='review_required'
    ) then raise exception 'observations still require review'; end if;
    if exists (
      select 1
      from corvis_facts.observation o
      where o.tenant_id=p_tenant_id and o.fund_id=current_row.fund_id and o.risk_tier='critical'
        and (
          select count(distinct r.actor_subject)
          from corvis_facts.review_event r
          where r.tenant_id=o.tenant_id and r.observation_id=o.observation_id and r.decision='approve'
        ) < 2
    ) then raise exception 'critical observations require independent review'; end if;
  end if;

  next_status := case p_action when 'publish' then 'published' when 'withdraw' then 'withdrawn' else 'superseded' end;
  next_version := p_expected_version + 1;

  insert into corvis_consolidated.fund_period_snapshot
    (tenant_id,snapshot_id,fund_id,report_period,version,status,fact_ids,blocking_exception_count,schema_version,taxonomy_version,created_at,published_at)
  values (
    current_row.tenant_id,current_row.snapshot_id,current_row.fund_id,current_row.report_period,next_version,next_status,
    current_row.fact_ids,effective_blockers,current_row.schema_version,current_row.taxonomy_version,now(),
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

commit;
