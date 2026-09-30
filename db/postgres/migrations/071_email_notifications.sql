-- Email notifications (#258): verified recipient addresses, per-user category
-- preferences and a durable email outbox.
-- Depends on migrations 001-070.
--
-- All three tables are server-managed. There are deliberately no client
-- policies; the application service role reads and writes them with explicit
-- tenant/user predicates after request authorization has succeeded.
--
-- The outbox stores only enums and identifiers. Human-readable names are
-- resolved at send time, and invitation links (which embed a single-use token)
-- are never persisted here.

begin;

-- One verified address per tenant user. Written only from a verified OIDC/SAML
-- email claim or an accepted invitation, never from free-text input.
create table if not exists corvis_control.notification_recipient (
  tenant_id uuid not null references corvis_control.tenant(tenant_id) on delete cascade,
  user_id uuid not null,
  email text not null check (email = lower(btrim(email)) and length(email) between 3 and 320),
  source text not null check (source in ('verified_identity_claim','accepted_invitation')),
  verified_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
alter table corvis_control.notification_recipient enable row level security;
alter table corvis_control.notification_recipient force row level security;

-- Absent row = the category's catalog default. Mandatory categories are never
-- stored here; the application rejects attempts to change them.
create table if not exists corvis_control.notification_preference (
  tenant_id uuid not null references corvis_control.tenant(tenant_id) on delete cascade,
  user_id uuid not null,
  category text not null check (category in ('export_ready','pinned_fund_published','source_attention')),
  enabled boolean not null,
  delivery text not null check (delivery in ('immediate','daily_digest')),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id, category)
);
alter table corvis_control.notification_preference enable row level security;
alter table corvis_control.notification_preference force row level security;

create table if not exists corvis_control.email_outbox (
  email_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references corvis_control.tenant(tenant_id) on delete cascade,
  category text not null check (category in (
    'invitation','export_ready','pinned_fund_published','source_attention',
    'support_access','role_changed','digest'
  )),
  -- Exactly one addressing mode: a tenant user (address resolved at send time)
  -- or an explicit invited address (invitations only).
  recipient_user_id uuid,
  recipient_email text check (recipient_email is null or (recipient_email = lower(btrim(recipient_email)) and length(recipient_email) between 3 and 320)),
  -- Eligibility is re-checked at send time against these scopes, so a user who
  -- lost access in the meantime is never emailed.
  workspace_id uuid,
  fund_id text,
  required_roles text[],
  template_params jsonb not null default '{}'::jsonb check (jsonb_typeof(template_params) = 'object'),
  dedupe_key text not null check (length(dedupe_key) between 1 and 300),
  status text not null default 'queued' check (status in (
    'queued','sending','retry','digest_pending','digested','sent','suppressed','dead_letter'
  )),
  suppression_reason text check (suppression_reason is null or suppression_reason in (
    'opted_out','no_verified_address','not_eligible','provider_not_configured','app_url_not_configured'
  )),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  digest_email_id uuid,
  provider_message_id text,
  last_error_class text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, dedupe_key),
  check ((recipient_user_id is null) <> (recipient_email is null)),
  check ((recipient_email is null) or category = 'invitation'),
  check ((status = 'suppressed') = (suppression_reason is not null)),
  check ((status = 'digested') = (digest_email_id is not null)),
  check ((status = 'sent') = (sent_at is not null))
);

create index if not exists email_outbox_dispatch_idx
  on corvis_control.email_outbox (next_attempt_at, created_at)
  where status in ('queued','retry','sending');
create index if not exists email_outbox_digest_idx
  on corvis_control.email_outbox (tenant_id, recipient_user_id, created_at)
  where status = 'digest_pending';
create index if not exists email_outbox_tenant_created_idx
  on corvis_control.email_outbox (tenant_id, created_at desc);

alter table corvis_control.email_outbox enable row level security;
alter table corvis_control.email_outbox force row level security;

commit;
