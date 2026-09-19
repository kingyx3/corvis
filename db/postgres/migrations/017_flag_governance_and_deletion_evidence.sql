-- Feature-flag governance and data-lifecycle execution evidence.
-- Flags stay rollout/operational controls: this migration adds ownership,
-- retirement and emergency-stop state, never authorization state. Deletion
-- execution gains entity-scoped legal holds and an immutable evidence ledger.

begin;

alter table corvis_control.feature_flag
  add column if not exists owner text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists retire_by timestamptz,
  add column if not exists retired_at timestamptz,
  add column if not exists retired_by text,
  add column if not exists kill_switch_reason text,
  add column if not exists kill_switch_at timestamptz,
  add column if not exists kill_switch_by text;

-- Tenant-wide emergency stop. Engaging it disables every flag evaluation for
-- the tenant without requiring per-flag writes.
create table if not exists corvis_control.feature_flag_emergency_stop (
  tenant_id uuid primary key references corvis_control.tenant(tenant_id),
  engaged boolean not null default false,
  reason text,
  engaged_by text,
  engaged_at timestamptz,
  released_by text,
  released_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Entity-scoped legal holds complement corvis_control.retention_policy, which
-- only carries a data-class level hold.
create table if not exists corvis_control.legal_hold (
  legal_hold_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  data_class text,
  scope jsonb not null default '{}'::jsonb,
  matter_reference text not null,
  placed_by text not null,
  placed_at timestamptz not null default now(),
  released_by text,
  released_at timestamptz,
  unique (tenant_id, legal_hold_id),
  check (released_at is null or released_at >= placed_at)
);

alter table corvis_control.deletion_request
  add column if not exists evidence_hash text,
  add column if not exists evidence_recorded_at timestamptz,
  add column if not exists blocked_reason text;

-- Append-only execution ledger. Completion evidence is retained per attempt so
-- a replayed execution can return the original evidence instead of re-running
-- the destructive adapter call.
create table if not exists corvis_control.deletion_execution_evidence (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  deletion_request_id uuid not null,
  attempt integer not null check (attempt >= 1),
  outcome text not null check (outcome in ('completed','blocked','failed')),
  evidence jsonb not null,
  evidence_hash text not null,
  recorded_by text not null,
  recorded_at timestamptz not null default now(),
  primary key (tenant_id, deletion_request_id, attempt),
  foreign key (tenant_id, deletion_request_id)
    references corvis_control.deletion_request(tenant_id, deletion_request_id)
);

alter table corvis_control.feature_flag_emergency_stop enable row level security;
alter table corvis_control.legal_hold enable row level security;
alter table corvis_control.deletion_execution_evidence enable row level security;

create policy feature_flag_emergency_stop_select on corvis_control.feature_flag_emergency_stop
  for select using (corvis_control.has_tenant_access(tenant_id));
create policy legal_hold_select on corvis_control.legal_hold
  for select using (corvis_control.has_tenant_access(tenant_id));
create policy deletion_execution_evidence_select on corvis_control.deletion_execution_evidence
  for select using (corvis_control.has_tenant_access(tenant_id));

create index if not exists feature_flag_retirement_idx
  on corvis_control.feature_flag (tenant_id, retire_by)
  where retired_at is null;
create index if not exists legal_hold_active_idx
  on corvis_control.legal_hold (tenant_id, data_class)
  where released_at is null;
create index if not exists deletion_execution_evidence_request_idx
  on corvis_control.deletion_execution_evidence (tenant_id, deletion_request_id, attempt desc);

commit;
