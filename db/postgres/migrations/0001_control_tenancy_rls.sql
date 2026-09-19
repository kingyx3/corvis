begin;

create schema if not exists control;

create table control.tenants (
  tenant_id uuid primary key,
  name text not null,
  status text not null default 'active' check (status in ('active', 'suspended', 'closed')),
  created_at timestamptz not null default now()
);

create table control.workspaces (
  workspace_id uuid primary key,
  tenant_id uuid not null references control.tenants(tenant_id),
  name text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, workspace_id)
);

create table control.memberships (
  tenant_id uuid not null references control.tenants(tenant_id),
  workspace_id uuid not null,
  subject_id text not null,
  role text not null check (role in ('viewer', 'reviewer', 'publisher', 'admin')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, workspace_id, subject_id),
  foreign key (tenant_id, workspace_id) references control.workspaces(tenant_id, workspace_id)
);

create index memberships_subject_idx on control.memberships(subject_id, tenant_id, workspace_id);

create or replace function control.current_tenant_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('corvis.tenant_id', true), '')::uuid
$$;

create or replace function control.current_subject_id()
returns text
language sql
stable
as $$
  select nullif(current_setting('corvis.subject_id', true), '')
$$;

create or replace function control.has_workspace_access(target_tenant_id uuid, target_workspace_id uuid)
returns boolean
language sql
stable
security invoker
as $$
  select target_tenant_id = control.current_tenant_id()
    and exists (
      select 1
      from control.memberships m
      where m.tenant_id = target_tenant_id
        and m.workspace_id = target_workspace_id
        and m.subject_id = control.current_subject_id()
    )
$$;

alter table control.tenants enable row level security;
alter table control.tenants force row level security;
alter table control.workspaces enable row level security;
alter table control.workspaces force row level security;
alter table control.memberships enable row level security;
alter table control.memberships force row level security;

create policy tenant_isolation on control.tenants
  using (tenant_id = control.current_tenant_id());

create policy workspace_membership_read on control.workspaces
  for select
  using (control.has_workspace_access(tenant_id, workspace_id));

create policy membership_self_read on control.memberships
  for select
  using (
    tenant_id = control.current_tenant_id()
    and subject_id = control.current_subject_id()
  );

comment on function control.current_tenant_id() is
  'Request-scoped tenant identity set by the trusted server transaction; absence fails closed.';
comment on function control.current_subject_id() is
  'Request-scoped authenticated subject set by the trusted server transaction; absence fails closed.';
comment on function control.has_workspace_access(uuid, uuid) is
  'Defense-in-depth workspace membership check. Backend authorization remains authoritative.';

commit;
