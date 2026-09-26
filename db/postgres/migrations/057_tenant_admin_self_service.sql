-- Tenant-admin self-service depth: customer-visible support access, notifications,
-- pending acknowledgements and SCIM provisioning configuration.
-- Server routes remain the only access path; no direct client RLS policies are created.

begin;

alter table corvis_control.support_access_grant
  add column if not exists requires_tenant_ack boolean not null default false,
  add column if not exists acknowledged_at timestamptz,
  add column if not exists acknowledged_by_subject text;

alter table corvis_control.support_access_grant
  drop constraint if exists support_access_grant_status_check;
alter table corvis_control.support_access_grant
  add constraint support_access_grant_status_check
  check (status in ('pending_ack','active','revoked'));

alter table corvis_control.support_access_grant
  drop constraint if exists support_access_grant_check1;
alter table corvis_control.support_access_grant
  drop constraint if exists support_access_grant_revocation_state_check;
alter table corvis_control.support_access_grant
  add constraint support_access_grant_revocation_state_check check (
    (status in ('pending_ack','active') and revoked_at is null)
    or status='revoked'
  );

create index if not exists support_access_grant_pending_ack_idx
  on corvis_control.support_access_grant (tenant_id,valid_until,created_at)
  where status='pending_ack';

create table if not exists corvis_control.tenant_access_notification (
  tenant_id uuid not null references corvis_control.tenant(tenant_id) on delete cascade,
  notification_id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('support_access_active','support_access_pending_ack')),
  support_grant_id uuid not null references corvis_control.support_access_grant(support_grant_id) on delete cascade,
  title text not null check (length(trim(title)) between 1 and 200),
  message text not null check (length(trim(message)) between 1 and 2000),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique (tenant_id,support_grant_id,kind)
);
create index if not exists tenant_access_notification_unread_idx
  on corvis_control.tenant_access_notification (tenant_id,created_at desc)
  where read_at is null;
alter table corvis_control.tenant_access_notification enable row level security;
alter table corvis_control.tenant_access_notification force row level security;

create table if not exists corvis_control.tenant_scim_configuration (
  tenant_id uuid primary key references corvis_control.tenant(tenant_id) on delete cascade,
  enabled boolean not null default true,
  token_sha256 text not null check (token_sha256 ~ '^[0-9a-f]{64}$'),
  auth_method text not null check (auth_method in ('oidc','saml')),
  default_workspace_id uuid not null,
  default_role_name text not null check (default_role_name in ('accountadmin','reviewer','analyst','viewer')),
  updated_by_subject text not null check (length(updated_by_subject) between 1 and 1024),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id,default_workspace_id)
    references corvis_control.workspace(tenant_id,workspace_id)
);
alter table corvis_control.tenant_scim_configuration enable row level security;
alter table corvis_control.tenant_scim_configuration force row level security;

create table if not exists corvis_control.tenant_scim_identity (
  tenant_id uuid not null references corvis_control.tenant(tenant_id) on delete cascade,
  scim_user_id uuid not null default gen_random_uuid(),
  external_id text not null check (length(trim(external_id)) between 1 and 1024),
  user_id uuid not null,
  auth_method text not null check (auth_method in ('oidc','saml')),
  subject text not null check (length(subject) between 1 and 1024),
  user_name text not null check (length(trim(user_name)) between 1 and 320),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id,scim_user_id),
  unique (tenant_id,external_id),
  unique (tenant_id,user_name)
);
create index if not exists tenant_scim_identity_user_idx
  on corvis_control.tenant_scim_identity (tenant_id,user_id);
alter table corvis_control.tenant_scim_identity enable row level security;
alter table corvis_control.tenant_scim_identity force row level security;

commit;
