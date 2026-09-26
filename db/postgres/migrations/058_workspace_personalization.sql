-- Corvis customer workspace personalization and visit cursor v1
-- Depends on migrations 001-057.
--
-- This table is server-managed. It stores only UX preferences and the last
-- acknowledged Overview visit cursor; authorization continues to come from
-- authoritative membership/entitlement resolution on every request.

begin;

create table if not exists corvis_control.workspace_user_preference (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  workspace_id uuid not null,
  auth_method text not null check (auth_method in ('oidc','saml','service_account')),
  subject text not null check (length(subject) between 1 and 1024),
  pinned_fund_ids text[] not null default '{}',
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, workspace_id, auth_method, subject),
  foreign key (tenant_id, workspace_id)
    references corvis_control.workspace(tenant_id, workspace_id),
  check (cardinality(pinned_fund_ids) <= 100)
);

create index if not exists workspace_user_preference_subject_idx
  on corvis_control.workspace_user_preference
    (tenant_id, auth_method, subject, workspace_id);

alter table corvis_control.workspace_user_preference enable row level security;
alter table corvis_control.workspace_user_preference force row level security;

-- No browser/client policy is intentionally created. The application service
-- role reads and mutates this table with explicit tenant/workspace/subject
-- predicates after request authorization has already succeeded.

commit;
