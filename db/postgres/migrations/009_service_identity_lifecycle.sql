-- Corvis service identity lifecycle authorization v1
-- Depends on migrations 001-008.
-- Service-account subjects require an explicit, time-bounded grant in addition
-- to the normal identity_subject + membership authorization path.

begin;

create table if not exists corvis_control.service_identity_grant (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  auth_method text not null default 'service_account' check (auth_method = 'service_account'),
  subject text not null check (length(subject) between 1 and 1024),
  purpose text not null check (length(trim(purpose)) between 1 and 512),
  status text not null default 'active' check (status in ('active','disabled')),
  valid_from timestamptz not null default now(),
  valid_until timestamptz not null,
  reviewed_at timestamptz not null default now(),
  next_review_at timestamptz not null,
  reviewed_by_subject text not null check (length(reviewed_by_subject) between 1 and 1024),
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (tenant_id, auth_method, subject),
  foreign key (tenant_id, auth_method, subject)
    references corvis_control.identity_subject(tenant_id, auth_method, subject)
    on delete cascade,
  check (valid_until > valid_from),
  check (next_review_at > reviewed_at),
  check (next_review_at <= valid_until),
  check ((status = 'active' and disabled_at is null) or status = 'disabled')
);

create index if not exists service_identity_grant_active_expiry_idx
  on corvis_control.service_identity_grant (tenant_id, valid_until, next_review_at)
  where status = 'active';

alter table corvis_control.service_identity_grant enable row level security;
alter table corvis_control.service_identity_grant force row level security;

-- Deliberately no client RLS policies. Provisioning, renewal, review and disable
-- operations must use the audited server/service-role control path with explicit
-- tenant predicates. A service identity therefore cannot extend its own access.

commit;
