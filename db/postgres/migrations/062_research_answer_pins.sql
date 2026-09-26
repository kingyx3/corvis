-- Corvis Ask Corvis saved/pinned answers v1 (#182 D7)
-- Depends on migrations 001-061.
--
-- Lets a signed-in subject save a specific governed Ask Corvis answer for
-- later reference. The stored payload is the exact answer/citations returned
-- at ask time, plus the as-of moment it was generated; reopening a pin always
-- redisplays this stored payload instead of silently re-running the
-- question, so a later data change cannot rewrite what the user actually
-- read and saved. This table is server-managed: authorization continues to
-- come from authoritative permission/entitlement resolution on every
-- request, not from anything stored here.

begin;

create table if not exists corvis_control.research_answer_pin (
  pin_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  workspace_id uuid not null,
  auth_method text not null check (auth_method in ('oidc','saml','service_account')),
  subject text not null check (length(subject) between 1 and 1024),
  question text not null check (length(question) between 1 and 2000),
  answer jsonb not null,
  asked_at timestamptz not null,
  pinned_at timestamptz not null default now(),
  foreign key (tenant_id, workspace_id)
    references corvis_control.workspace(tenant_id, workspace_id)
);

create index if not exists research_answer_pin_subject_idx
  on corvis_control.research_answer_pin
    (tenant_id, workspace_id, auth_method, subject, pinned_at desc);

alter table corvis_control.research_answer_pin enable row level security;
alter table corvis_control.research_answer_pin force row level security;

-- No browser/client policy is intentionally created, matching
-- corvis_control.workspace_user_preference (059): the application service
-- role reads and mutates this table with explicit tenant/workspace/subject
-- predicates after request authorization (research:query) has already
-- succeeded.

commit;
