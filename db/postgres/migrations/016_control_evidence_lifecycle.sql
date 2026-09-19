-- Corvis Postgres control evidence lifecycle v1
-- Depends on migrations 001-003.
-- Evidence revisions are append-only and hash-chained, so freshness, expiry and
-- escalation are derived from immutable history rather than in-place mutation.
-- Confidential payloads stay in the access-controlled evidence store: only the
-- digest, the locator and the attributable collector are persisted here.

begin;

create table if not exists corvis_control.control_definition (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  control_code text not null check (length(control_code) between 1 and 128),
  title text not null,
  domain text not null,
  owner text not null,
  implementation_state text not null default 'planned'
    check (implementation_state in ('planned','in_progress','implemented','not_applicable')),
  promoted_at timestamptz,
  promoted_by text,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, control_code),
  check ((implementation_state = 'implemented') = (promoted_at is not null and promoted_by is not null))
);

create table if not exists corvis_control.control_evidence_requirement (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  control_code text not null,
  source_key text not null check (length(source_key) between 1 and 128),
  title text not null,
  producer text not null,
  owner text not null,
  cadence_days integer not null check (cadence_days between 1 and 1095),
  grace_days integer not null default 0 check (grace_days >= 0),
  collection text not null check (collection in ('automated','provider_gated')),
  collectable boolean not null default false,
  mandatory boolean not null default false,
  confidentiality text not null default 'restricted' check (confidentiality in ('internal','restricted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, control_code, source_key),
  foreign key (tenant_id, control_code) references corvis_control.control_definition(tenant_id, control_code),
  check ((collection = 'automated') = collectable)
);

create table if not exists corvis_control.control_evidence_record (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  evidence_record_id uuid primary key default gen_random_uuid(),
  control_code text not null,
  source_key text not null,
  revision integer not null check (revision > 0),
  result text not null check (result in ('pass','fail')),
  collection_method text not null check (collection_method in ('automated','attested_manual')),
  collected_at timestamptz not null,
  valid_through timestamptz not null,
  collected_by text not null check (length(collected_by) between 1 and 512),
  source_run_uri text,
  payload_digest text not null check (payload_digest ~ '^[0-9a-f]{64}$'),
  payload_location text,
  previous_digest text check (previous_digest ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz not null default now(),
  unique (tenant_id, evidence_record_id),
  unique (tenant_id, control_code, source_key, revision),
  check (valid_through > collected_at),
  foreign key (tenant_id, control_code, source_key)
    references corvis_control.control_evidence_requirement(tenant_id, control_code, source_key)
);

create table if not exists corvis_control.control_evidence_escalation (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  escalation_id uuid primary key default gen_random_uuid(),
  control_code text not null,
  source_key text not null,
  lifecycle_state text not null
    check (lifecycle_state in ('due_soon','stale','expired','failing','missing','not_collectable')),
  escalation_level text not null check (escalation_level in ('notice','warning','breach')),
  detail text not null,
  detected_at timestamptz not null default now(),
  detected_by text not null,
  resolved_at timestamptz,
  resolved_by text,
  unique (tenant_id, escalation_id),
  foreign key (tenant_id, control_code, source_key)
    references corvis_control.control_evidence_requirement(tenant_id, control_code, source_key)
);

create unique index if not exists control_evidence_escalation_open_idx
  on corvis_control.control_evidence_escalation (tenant_id, control_code, source_key)
  where resolved_at is null;

create index if not exists control_evidence_record_currency_idx
  on corvis_control.control_evidence_record (tenant_id, control_code, source_key, revision desc);

-- Evidence must stay tamper-evident. Corrections are recorded as a new revision
-- that chains to the previous digest, never as an edit or a delete.
create or replace function corvis_control.reject_control_evidence_mutation()
returns trigger
language plpgsql
security invoker
as $$
begin
  raise exception 'corvis_control.control_evidence_record is append-only; record a new revision instead';
end;
$$;

drop trigger if exists control_evidence_record_append_only on corvis_control.control_evidence_record;
create trigger control_evidence_record_append_only
  before update or delete on corvis_control.control_evidence_record
  for each row execute function corvis_control.reject_control_evidence_mutation();

-- A planned control is only promoted when every mandatory evidence source has a
-- passing record that is still within its validity window at evaluation time.
-- Returns null when the gate is not satisfied so callers cannot promote blindly.
create or replace function corvis_control.promote_control_implementation(
  p_tenant_id uuid,
  p_control_code text,
  p_promoted_by text,
  p_evaluated_at timestamptz
)
returns integer
language plpgsql
security invoker
as $$
declare
  v_required integer;
  v_unsatisfied integer;
  v_new_version integer;
begin
  select count(*) into v_required
  from corvis_control.control_evidence_requirement r
  where r.tenant_id = p_tenant_id and r.control_code = p_control_code and r.mandatory;

  if v_required = 0 then return null; end if;

  select count(*) into v_unsatisfied
  from corvis_control.control_evidence_requirement r
  where r.tenant_id = p_tenant_id
    and r.control_code = p_control_code
    and r.mandatory
    and not exists (
      select 1
      from corvis_control.control_evidence_record e
      where e.tenant_id = r.tenant_id
        and e.control_code = r.control_code
        and e.source_key = r.source_key
        and e.result = 'pass'
        and e.collected_at <= p_evaluated_at
        and e.valid_through > p_evaluated_at
    );

  if v_unsatisfied > 0 then return null; end if;

  update corvis_control.control_definition
  set implementation_state = 'implemented',
      promoted_at = p_evaluated_at,
      promoted_by = p_promoted_by,
      version = version + 1,
      updated_at = now()
  where tenant_id = p_tenant_id and control_code = p_control_code
  returning version into v_new_version;

  return v_new_version;
end;
$$;

alter table corvis_control.control_definition enable row level security;
alter table corvis_control.control_definition force row level security;
alter table corvis_control.control_evidence_requirement enable row level security;
alter table corvis_control.control_evidence_requirement force row level security;
alter table corvis_control.control_evidence_record enable row level security;
alter table corvis_control.control_evidence_record force row level security;
alter table corvis_control.control_evidence_escalation enable row level security;
alter table corvis_control.control_evidence_escalation force row level security;

create policy control_definition_tenant_select on corvis_control.control_definition for select using (corvis_control.has_tenant_access(tenant_id));
create policy control_evidence_requirement_tenant_select on corvis_control.control_evidence_requirement for select using (corvis_control.has_tenant_access(tenant_id));
create policy control_evidence_record_tenant_select on corvis_control.control_evidence_record for select using (corvis_control.has_tenant_access(tenant_id));
create policy control_evidence_escalation_tenant_select on corvis_control.control_evidence_escalation for select using (corvis_control.has_tenant_access(tenant_id));

commit;
