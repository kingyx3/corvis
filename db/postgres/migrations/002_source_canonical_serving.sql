-- Corvis Postgres source/canonical/serving v1
-- Depends on 001_control_plane.sql.

begin;

create table if not exists corvis_source.document (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  document_id uuid primary key default gen_random_uuid(),
  document_family_id uuid,
  display_name text not null,
  media_type text not null,
  status text not null,
  created_at timestamptz not null default now(),
  created_by text not null,
  unique (tenant_id, document_id)
);

create table if not exists corvis_source.document_artifact_version (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  document_artifact_version_id uuid primary key default gen_random_uuid(),
  document_id uuid not null,
  ingestion_id text not null,
  object_uri text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  sha256 text,
  storage_generation text,
  malware_scan_status text not null default 'pending',
  quarantine_status text not null default 'pending',
  created_at timestamptz not null default now(),
  foreign key (tenant_id, document_id) references corvis_source.document(tenant_id, document_id),
  unique (tenant_id, document_artifact_version_id),
  unique (tenant_id, ingestion_id)
);

create table if not exists corvis_source.source_reference (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  source_reference_id uuid primary key default gen_random_uuid(),
  document_id uuid not null,
  document_artifact_version_id uuid not null,
  page_number integer,
  sheet_name text,
  cell_range text,
  bbox jsonb,
  excerpt text,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, document_id) references corvis_source.document(tenant_id, document_id),
  foreign key (tenant_id, document_artifact_version_id) references corvis_source.document_artifact_version(tenant_id, document_artifact_version_id),
  unique (tenant_id, source_reference_id)
);

create table if not exists corvis_facts.observation (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  observation_id uuid primary key default gen_random_uuid(),
  fund_id text not null,
  company_id text,
  holding_id text,
  instrument_id text,
  metric_code text not null,
  value_number numeric(38,10),
  value_string text,
  currency text,
  economic_period text,
  report_date date,
  actuality text,
  review_state text not null default 'review_required',
  version integer not null default 1 check (version > 0),
  source_reference_id uuid not null,
  extraction_run_id text,
  schema_version text not null,
  skill_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, source_reference_id) references corvis_source.source_reference(tenant_id, source_reference_id),
  unique (tenant_id, observation_id),
  check (value_number is not null or value_string is not null)
);

create table if not exists corvis_facts.review_event (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  review_event_id uuid primary key default gen_random_uuid(),
  observation_id uuid not null,
  actor_subject text not null,
  decision text not null,
  reason_code text not null,
  before_value jsonb,
  after_value jsonb,
  observation_version integer not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, observation_id) references corvis_facts.observation(tenant_id, observation_id),
  unique (tenant_id, review_event_id)
);

create table if not exists corvis_consolidated.consolidated_fact (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  consolidated_fact_id uuid primary key default gen_random_uuid(),
  fund_id text not null,
  subject_type text not null,
  subject_id text not null,
  metric_code text not null,
  economic_period text,
  value jsonb not null,
  source_observation_ids uuid[] not null,
  consolidation_rule_version text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, consolidated_fact_id)
);

create table if not exists corvis_consolidated.fund_period_snapshot (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  snapshot_id uuid not null default gen_random_uuid(),
  fund_id text not null,
  report_period text not null,
  version integer not null check (version > 0),
  status text not null check (status in ('draft','blocked','published','withdrawn','superseded')),
  fact_ids uuid[] not null default '{}',
  blocking_exception_count integer not null default 0 check (blocking_exception_count >= 0),
  schema_version text not null,
  taxonomy_version text not null,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  primary key (tenant_id, snapshot_id, version)
);

create table if not exists corvis_semantic.metric_definition (
  metric_code text not null,
  definition_version text not null,
  display_name text not null,
  data_type text not null,
  aggregation_behavior text not null,
  unit_type text,
  fx_behavior text,
  compatibility_rule jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  primary key (metric_code, definition_version)
);

alter table corvis_source.document enable row level security;
alter table corvis_source.document_artifact_version enable row level security;
alter table corvis_source.source_reference enable row level security;
alter table corvis_facts.observation enable row level security;
alter table corvis_facts.review_event enable row level security;
alter table corvis_consolidated.consolidated_fact enable row level security;
alter table corvis_consolidated.fund_period_snapshot enable row level security;

create policy document_tenant_select on corvis_source.document
  for select using (corvis_control.has_tenant_access(tenant_id));
create policy artifact_tenant_select on corvis_source.document_artifact_version
  for select using (corvis_control.has_tenant_access(tenant_id));
create policy source_reference_tenant_select on corvis_source.source_reference
  for select using (corvis_control.has_tenant_access(tenant_id));
create policy observation_tenant_select on corvis_facts.observation
  for select using (corvis_control.has_tenant_access(tenant_id));
create policy review_event_tenant_select on corvis_facts.review_event
  for select using (corvis_control.has_tenant_access(tenant_id));
create policy consolidated_fact_tenant_select on corvis_consolidated.consolidated_fact
  for select using (corvis_control.has_tenant_access(tenant_id));
create policy snapshot_tenant_select on corvis_consolidated.fund_period_snapshot
  for select using (corvis_control.has_tenant_access(tenant_id));

create or replace view corvis_serving.observations as
select tenant_id, observation_id, fund_id, company_id, holding_id, instrument_id,
       metric_code, value_number, value_string, currency, economic_period,
       report_date, review_state, source_reference_id, version, updated_at
from corvis_facts.observation
where review_state in ('approved','review_required');

create or replace view corvis_serving.fund_period_snapshots as
select tenant_id, snapshot_id, fund_id, report_period, version, status, fact_ids,
       blocking_exception_count, schema_version, taxonomy_version, created_at, published_at
from corvis_consolidated.fund_period_snapshot;

create index if not exists document_tenant_created_idx
  on corvis_source.document (tenant_id, created_at desc);
create index if not exists source_reference_document_idx
  on corvis_source.source_reference (tenant_id, document_id);
create index if not exists observation_tenant_fund_metric_idx
  on corvis_facts.observation (tenant_id, fund_id, metric_code, updated_at desc);
create index if not exists observation_source_reference_idx
  on corvis_facts.observation (tenant_id, source_reference_id);
create index if not exists snapshot_tenant_fund_period_idx
  on corvis_consolidated.fund_period_snapshot (tenant_id, fund_id, report_period, version desc);

commit;
