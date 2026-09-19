-- Corvis authoritative session revocation v1
-- Depends on migrations 001-007.
-- Revocation is checked on every authoritative production authorization lookup.

begin;

create table if not exists corvis_control.session_revocation (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  auth_method text not null check (auth_method in ('oidc','saml','service_account')),
  subject text not null check (length(subject) between 1 and 1024),
  session_id text not null check (length(session_id) between 1 and 1024),
  revoked_at timestamptz not null default now(),
  revoked_by_subject text not null check (length(revoked_by_subject) between 1 and 1024),
  reason text not null check (length(btrim(reason)) between 1 and 1000),
  primary key (tenant_id, auth_method, subject, session_id)
);

create index if not exists session_revocation_tenant_subject_idx
  on corvis_control.session_revocation (tenant_id, auth_method, subject, revoked_at desc);

alter table corvis_control.session_revocation enable row level security;
alter table corvis_control.session_revocation force row level security;

-- Session revocations are server-managed security controls. No customer/client
-- SELECT or mutation policy is intentionally created. The application service
-- role must still use explicit tenant predicates when reading or writing them.

commit;
