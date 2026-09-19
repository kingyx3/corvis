-- Corvis Postgres operations, delivery and governance v1
-- Depends on 001_control_plane.sql and 002_source_canonical_serving.sql.

begin;

alter table corvis_source.document add column if not exists fund_name text;
alter table corvis_source.document add column if not exists report_period text;
alter table corvis_source.document add column if not exists document_type text;
alter table corvis_source.document add column if not exists page_count integer;
alter table corvis_source.document add column if not exists quality text;

alter table corvis_facts.observation add column if not exists confidence_score double precision;
alter table corvis_facts.observation add column if not exists delta_display text;
alter table corvis_facts.observation add column if not exists risk_tier text not null default 'normal';

create table if not exists corvis_facts.holding (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  holding_id uuid primary key default gen_random_uuid(),
  fund_id text not null,
  target_type text not null check (target_type in ('company','fund','other')),
  target_company_id text,
  target_fund_id text,
  status text,
  investment_date date,
  strategy text,
  geography text,
  source_reference_id uuid,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, holding_id),
  foreign key (tenant_id, source_reference_id) references corvis_source.source_reference(tenant_id, source_reference_id),
  check ((target_type = 'company' and target_company_id is not null) or
         (target_type = 'fund' and target_fund_id is not null) or
         target_type = 'other')
);

create table if not exists corvis_facts.instrument (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  instrument_id uuid primary key default gen_random_uuid(),
  holding_id uuid not null,
  instrument_type text not null,
  security_name text,
  currency text,
  seniority text,
  maturity_date date,
  coupon_rate numeric(18,8),
  source_reference_id uuid,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, instrument_id),
  foreign key (tenant_id, holding_id) references corvis_facts.holding(tenant_id, holding_id),
  foreign key (tenant_id, source_reference_id) references corvis_source.source_reference(tenant_id, source_reference_id)
);

create table if not exists corvis_control.processing_job (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  job_id uuid primary key default gen_random_uuid(),
  document_id uuid not null,
  stage text not null,
  state text not null,
  attempt integer not null default 0 check (attempt >= 0),
  max_attempts integer not null check (max_attempts > 0),
  correlation_id text not null,
  version integer not null default 1 check (version > 0),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, job_id),
  foreign key (tenant_id, document_id) references corvis_source.document(tenant_id, document_id)
);

create table if not exists corvis_control.outbox_event (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  event_id uuid primary key default gen_random_uuid(),
  event_type text not null,
  aggregate_type text not null,
  aggregate_id text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_error text,
  unique (tenant_id, event_id)
);

create table if not exists corvis_control.exception (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  exception_id uuid primary key default gen_random_uuid(),
  snapshot_id uuid,
  document_id uuid,
  observation_id uuid,
  code text not null,
  severity text not null,
  state text not null default 'open',
  detail text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text,
  unique (tenant_id, exception_id)
);

create table if not exists corvis_consolidated.reconciliation (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  reconciliation_id uuid primary key default gen_random_uuid(),
  fund_id text not null,
  subject_type text not null,
  subject_id text not null,
  metric_code text not null,
  economic_period text,
  source_observation_ids uuid[] not null,
  status text not null,
  resolution_rule text,
  resolved_observation_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, reconciliation_id)
);

create table if not exists corvis_control.data_rights (
  rights_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  resource_type text not null,
  resource_id text not null,
  client_visible boolean not null default true,
  internal_analytics_allowed boolean not null default false,
  model_training_allowed boolean not null default false,
  redistribution_allowed boolean not null default false,
  source_document_access_allowed boolean not null default false,
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  contract_reference text,
  unique (tenant_id, rights_id),
  check (effective_to is null or effective_to > effective_from)
);

create table if not exists corvis_control.retention_policy (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  data_class text not null,
  retention_days integer,
  legal_hold boolean not null default false,
  delete_on_termination boolean not null default false,
  policy_version text not null,
  effective_from timestamptz not null default now(),
  primary key (tenant_id, data_class, policy_version),
  check (retention_days is null or retention_days >= 0)
);

create table if not exists corvis_control.deletion_request (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  deletion_request_id uuid primary key default gen_random_uuid(),
  requested_by text not null,
  scope jsonb not null,
  reason text not null,
  state text not null,
  requested_at timestamptz not null default now(),
  approved_by text,
  approved_at timestamptz,
  completed_at timestamptz,
  completion_evidence jsonb,
  execution_attempts integer not null default 0 check (execution_attempts >= 0),
  last_error text,
  unique (tenant_id, deletion_request_id)
);

create table if not exists corvis_control.semantic_query_log (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  semantic_query_id text not null,
  actor_subject text not null,
  question_hash text not null,
  result_fact_ids uuid[] not null default '{}',
  result_row_count integer not null default 0 check (result_row_count >= 0),
  created_at timestamptz not null default now(),
  primary key (tenant_id, semantic_query_id)
);

create table if not exists corvis_control.control_evidence (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  evidence_id uuid primary key default gen_random_uuid(),
  control_code text not null,
  evidence_type text not null,
  evidence_uri text,
  evidence_payload jsonb,
  period_start timestamptz,
  period_end timestamptz,
  result text not null,
  generated_at timestamptz not null default now(),
  generated_by text not null,
  valid_through timestamptz,
  unique (tenant_id, evidence_id)
);

create table if not exists corvis_serving.export_job (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  export_id uuid primary key default gen_random_uuid(),
  requested_by text not null,
  format text not null check (format in ('csv','xlsx','parquet')),
  snapshot_ids uuid[] not null default '{}',
  state text not null default 'queued',
  object_uri text,
  expires_at timestamptz,
  checksum_sha256 text,
  manifest jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  delivery_attempts integer not null default 0 check (delivery_attempts >= 0),
  last_error text,
  unique (tenant_id, export_id)
);

alter table corvis_facts.holding enable row level security;
alter table corvis_facts.instrument enable row level security;
alter table corvis_control.processing_job enable row level security;
alter table corvis_control.outbox_event enable row level security;
alter table corvis_control.exception enable row level security;
alter table corvis_consolidated.reconciliation enable row level security;
alter table corvis_control.data_rights enable row level security;
alter table corvis_control.retention_policy enable row level security;
alter table corvis_control.deletion_request enable row level security;
alter table corvis_control.semantic_query_log enable row level security;
alter table corvis_control.control_evidence enable row level security;
alter table corvis_serving.export_job enable row level security;

create policy holding_tenant_select on corvis_facts.holding for select using (corvis_control.has_tenant_access(tenant_id));
create policy instrument_tenant_select on corvis_facts.instrument for select using (corvis_control.has_tenant_access(tenant_id));
create policy processing_job_tenant_select on corvis_control.processing_job for select using (corvis_control.has_tenant_access(tenant_id));
create policy outbox_tenant_select on corvis_control.outbox_event for select using (corvis_control.has_tenant_access(tenant_id));
create policy exception_tenant_select on corvis_control.exception for select using (corvis_control.has_tenant_access(tenant_id));
create policy reconciliation_tenant_select on corvis_consolidated.reconciliation for select using (corvis_control.has_tenant_access(tenant_id));
create policy data_rights_tenant_select on corvis_control.data_rights for select using (corvis_control.has_tenant_access(tenant_id));
create policy retention_tenant_select on corvis_control.retention_policy for select using (corvis_control.has_tenant_access(tenant_id));
create policy deletion_tenant_select on corvis_control.deletion_request for select using (corvis_control.has_tenant_access(tenant_id));
create policy semantic_query_log_tenant_select on corvis_control.semantic_query_log for select using (corvis_control.has_tenant_access(tenant_id));
create policy control_evidence_tenant_select on corvis_control.control_evidence for select using (corvis_control.has_tenant_access(tenant_id));
create policy export_job_tenant_select on corvis_serving.export_job for select using (corvis_control.has_tenant_access(tenant_id));

create or replace view corvis_serving.documents as
with latest_artifact as (
  select distinct on (tenant_id, document_id)
         tenant_id, document_id, size_bytes, malware_scan_status, quarantine_status
  from corvis_source.document_artifact_version
  order by tenant_id, document_id, created_at desc
), latest_job as (
  select distinct on (tenant_id, document_id)
         tenant_id, document_id, stage, state, updated_at
  from corvis_control.processing_job
  order by tenant_id, document_id, updated_at desc
), document_observations as (
  select o.tenant_id, r.document_id, count(*)::integer as observation_count
  from corvis_facts.observation o
  join corvis_source.source_reference r
    on r.tenant_id = o.tenant_id and r.source_reference_id = o.source_reference_id
  group by o.tenant_id, r.document_id
)
select d.tenant_id, d.document_id, d.display_name, d.fund_name, d.report_period,
       coalesce(d.document_type, d.media_type) as document_type, d.page_count,
       a.size_bytes, d.status, d.quality,
       coalesce(obs.observation_count, 0) as observation_count,
       j.stage as processing_stage, j.state as processing_state,
       j.updated_at as processing_updated_at,
       a.malware_scan_status, a.quarantine_status, d.created_at
from corvis_source.document d
left join latest_artifact a on a.tenant_id=d.tenant_id and a.document_id=d.document_id
left join latest_job j on j.tenant_id=d.tenant_id and j.document_id=d.document_id
left join document_observations obs on obs.tenant_id=d.tenant_id and obs.document_id=d.document_id;

create or replace view corvis_serving.source_references as
select r.tenant_id, r.source_reference_id, r.document_id, r.document_artifact_version_id,
       r.page_number, r.sheet_name, r.cell_range, r.bbox, r.excerpt,
       a.object_uri, a.storage_generation, a.quarantine_status
from corvis_source.source_reference r
join corvis_source.document_artifact_version a
  on a.tenant_id=r.tenant_id and a.document_artifact_version_id=r.document_artifact_version_id
where a.quarantine_status='released';

create index if not exists processing_job_document_idx on corvis_control.processing_job (tenant_id, document_id, updated_at desc);
create index if not exists outbox_unpublished_idx on corvis_control.outbox_event (created_at) where published_at is null;
create index if not exists exception_open_idx on corvis_control.exception (tenant_id, snapshot_id, severity) where state = 'open';
create index if not exists export_job_tenant_state_idx on corvis_serving.export_job (tenant_id, state, created_at desc);

commit;
