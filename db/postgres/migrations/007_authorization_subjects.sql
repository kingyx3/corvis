-- Corvis Postgres external identity subject mapping v1
-- Depends on migrations 001-006.
-- Authenticated OIDC/SAML/service-account subjects are opaque strings. Membership
-- and RLS continue to use stable internal UUID user identifiers.

begin;

create table if not exists corvis_control.identity_subject (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  user_id uuid not null,
  auth_method text not null check (auth_method in ('oidc','saml','service_account')),
  subject text not null check (length(subject) between 1 and 1024),
  status text not null default 'active' check (status in ('active','disabled')),
  created_at timestamptz not null default now(),
  disabled_at timestamptz,
  primary key (tenant_id, auth_method, subject),
  unique (tenant_id, user_id, auth_method, subject),
  check ((status='active' and disabled_at is null) or status='disabled')
);

create index if not exists identity_subject_user_idx
  on corvis_control.identity_subject (tenant_id, user_id)
  where status='active';

alter table corvis_control.identity_subject enable row level security;
alter table corvis_control.identity_subject force row level security;

create policy identity_subject_self_select on corvis_control.identity_subject
  for select
  using (
    corvis_control.has_tenant_access(tenant_id)
    and user_id = auth.uid()
  );

-- Application service identities intentionally receive no broad mutation policy.
-- Provisioning/sync uses the controlled service-role path with explicit tenant
-- predicates and remains auditable outside the customer request path.

commit;
