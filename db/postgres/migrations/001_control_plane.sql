-- Corvis Postgres control plane v1
-- Supabase Postgres is the authoritative operational structured data platform.
-- This migration is intentionally separate from db/migrations/, which contains
-- legacy Snowflake DDL retained only as a migration reference.

begin;

create extension if not exists pgcrypto;

create schema if not exists corvis_control;
create schema if not exists corvis_source;
create schema if not exists corvis_facts;
create schema if not exists corvis_consolidated;
create schema if not exists corvis_semantic;
create schema if not exists corvis_serving;

create table if not exists corvis_control.tenant (
  tenant_id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  display_name text not null,
  status text not null default 'active' check (status in ('active','suspended','closed')),
  created_at timestamptz not null default now()
);

create table if not exists corvis_control.workspace (
  workspace_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  slug text not null,
  display_name text not null,
  status text not null default 'active' check (status in ('active','suspended','closed')),
  created_at timestamptz not null default now(),
  unique (tenant_id, slug),
  unique (tenant_id, workspace_id)
);

create table if not exists corvis_control.membership (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  workspace_id uuid not null,
  user_id uuid not null,
  role_name text not null check (role_name in ('tenant_admin','workspace_admin','reviewer','analyst','viewer')),
  status text not null default 'active' check (status in ('active','suspended','revoked')),
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  created_at timestamptz not null default now(),
  primary key (tenant_id, workspace_id, user_id, role_name),
  foreign key (tenant_id, workspace_id) references corvis_control.workspace(tenant_id, workspace_id),
  check (valid_until is null or valid_until > valid_from)
);

create table if not exists corvis_control.resource_entitlement (
  entitlement_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  workspace_id uuid not null,
  subject_user_id uuid not null,
  resource_type text not null,
  resource_id text not null,
  permission text not null check (permission in ('read','review','publish','admin')),
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, workspace_id) references corvis_control.workspace(tenant_id, workspace_id),
  unique (tenant_id, workspace_id, subject_user_id, resource_type, resource_id, permission),
  check (valid_until is null or valid_until > valid_from)
);

create table if not exists corvis_control.feature_flag (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  flag_key text not null,
  enabled boolean not null default false,
  kill_switch boolean not null default false,
  configuration jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (tenant_id, flag_key)
);

create table if not exists corvis_control.idempotency_key (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  scope text not null,
  idempotency_key text not null,
  request_hash text not null,
  response_status integer,
  response_body jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (tenant_id, scope, idempotency_key),
  check (expires_at > created_at)
);

create table if not exists corvis_control.audit_event (
  audit_event_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  workspace_id uuid,
  occurred_at timestamptz not null default now(),
  actor_subject text not null,
  action text not null,
  target_type text not null,
  target_id text,
  outcome text not null,
  correlation_id text not null,
  metadata jsonb not null default '{}'::jsonb
);

-- Human/API access is authorized from Supabase Auth identity plus membership.
-- Service-role access must still apply explicit tenant predicates in repository
-- queries because Supabase service_role intentionally bypasses RLS.
create or replace function corvis_control.current_user_id()
returns uuid
language sql
stable
security invoker
as $$
  select auth.uid();
$$;

create or replace function corvis_control.has_tenant_access(row_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = corvis_control, public
as $$
  select exists (
    select 1
    from corvis_control.membership m
    where m.tenant_id = row_tenant_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and m.valid_from <= now()
      and (m.valid_until is null or m.valid_until > now())
  );
$$;

create or replace function corvis_control.has_workspace_access(row_tenant_id uuid, row_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = corvis_control, public
as $$
  select exists (
    select 1
    from corvis_control.membership m
    where m.tenant_id = row_tenant_id
      and m.workspace_id = row_workspace_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and m.valid_from <= now()
      and (m.valid_until is null or m.valid_until > now())
  );
$$;

alter table corvis_control.tenant enable row level security;
alter table corvis_control.workspace enable row level security;
alter table corvis_control.membership enable row level security;
alter table corvis_control.resource_entitlement enable row level security;
alter table corvis_control.feature_flag enable row level security;
alter table corvis_control.idempotency_key enable row level security;
alter table corvis_control.audit_event enable row level security;

create policy tenant_select on corvis_control.tenant
  for select using (corvis_control.has_tenant_access(tenant_id));
create policy workspace_select on corvis_control.workspace
  for select using (corvis_control.has_workspace_access(tenant_id, workspace_id));
create policy membership_select on corvis_control.membership
  for select using (user_id = auth.uid() or corvis_control.has_workspace_access(tenant_id, workspace_id));
create policy entitlement_select on corvis_control.resource_entitlement
  for select using (subject_user_id = auth.uid() and corvis_control.has_workspace_access(tenant_id, workspace_id));
create policy feature_flag_select on corvis_control.feature_flag
  for select using (corvis_control.has_tenant_access(tenant_id));
create policy audit_event_select on corvis_control.audit_event
  for select using (corvis_control.has_tenant_access(tenant_id));

-- No broad client insert/update/delete policies are intentionally created for
-- privileged control tables. Mutations flow through reviewed server-side APIs.

create index if not exists membership_user_active_idx
  on corvis_control.membership (user_id, tenant_id, workspace_id)
  where status = 'active';
create index if not exists entitlement_subject_idx
  on corvis_control.resource_entitlement (tenant_id, workspace_id, subject_user_id, resource_type, resource_id);
create index if not exists audit_event_tenant_time_idx
  on corvis_control.audit_event (tenant_id, occurred_at desc);

commit;
