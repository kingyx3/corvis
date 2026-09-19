-- Corvis Postgres identity, review and publication v1
-- Depends on migrations 001-003.

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

create table if not exists corvis_facts.observation_correction (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  correction_id uuid primary key default gen_random_uuid(),
  observation_id uuid not null,
  observation_version integer not null,
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
