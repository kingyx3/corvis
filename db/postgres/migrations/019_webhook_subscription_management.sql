-- Webhook subscription lifecycle and per-subscription signing-key rotation.
-- Depends on migrations 001-018.
--
-- 006_upload_delivery_operations.sql introduced webhook_subscription/
-- webhook_delivery with a single boolean `active` flag and delivery signed by
-- one shared CORVIS_WEBHOOK_SIGNING_SECRET for every tenant. A shared secret
-- lets any tenant forge a signature that verifies for another tenant's
-- webhook, and a boolean has no terminal "revoked" state distinct from a
-- resumable "paused" one. This migration replaces both with a tenant/
-- subscription-scoped signing key that can be rotated without a gap.

begin;

alter table corvis_control.webhook_subscription
  add column if not exists status text not null default 'active' check (status in ('active','paused','revoked')),
  add column if not exists paused_at timestamptz,
  add column if not exists paused_by text,
  add column if not exists revoked_at timestamptz,
  add column if not exists revoked_by text;

update corvis_control.webhook_subscription
  set status = case when active then 'active' else 'paused' end;

alter table corvis_control.webhook_subscription
  drop column if exists active;

create table if not exists corvis_control.webhook_signing_key (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  webhook_id uuid not null,
  key_id uuid primary key default gen_random_uuid(),
  secret text not null check (length(secret) >= 32),
  status text not null default 'active' check (status in ('active','retiring','revoked')),
  created_at timestamptz not null default now(),
  created_by text not null,
  retire_by timestamptz,
  revoked_at timestamptz,
  unique (tenant_id, key_id),
  foreign key (tenant_id, webhook_id) references corvis_control.webhook_subscription(tenant_id, webhook_id)
);

-- At most one active key per subscription, so outbound delivery never has to
-- guess which key is authoritative for signing.
create unique index if not exists webhook_signing_key_one_active_idx
  on corvis_control.webhook_signing_key (tenant_id, webhook_id)
  where status = 'active';

alter table corvis_control.webhook_signing_key enable row level security;
alter table corvis_control.webhook_signing_key force row level security;
create policy webhook_signing_key_tenant_select on corvis_control.webhook_signing_key
  for select using (corvis_control.has_tenant_access(tenant_id));

create index if not exists webhook_signing_key_lookup_idx
  on corvis_control.webhook_signing_key (tenant_id, webhook_id, status);

-- Creates a subscription and its first signing key atomically, so a
-- subscription can never exist with zero signing keys.
create or replace function corvis_control.create_webhook_subscription(
  p_tenant_id uuid,
  p_webhook_id uuid,
  p_endpoint_url text,
  p_event_types text[],
  p_created_by text,
  p_key_id uuid,
  p_secret text
)
returns uuid
language plpgsql
security invoker
as $$
begin
  if p_endpoint_url is null or p_endpoint_url !~ '^https://' then
    raise exception 'webhook endpoint url must be https';
  end if;
  if p_event_types is null or array_length(p_event_types, 1) is null then
    raise exception 'at least one event type is required';
  end if;
  if p_secret is null or length(p_secret) < 32 then
    raise exception 'signing secret must be at least 32 characters';
  end if;

  insert into corvis_control.webhook_subscription
    (tenant_id, webhook_id, endpoint_url, event_types, status, created_by, created_at, updated_at)
  values (p_tenant_id, p_webhook_id, p_endpoint_url, p_event_types, 'active', p_created_by, now(), now());

  insert into corvis_control.webhook_signing_key
    (tenant_id, webhook_id, key_id, secret, status, created_at, created_by)
  values (p_tenant_id, p_webhook_id, p_key_id, p_secret, 'active', now(), p_created_by);

  return p_webhook_id;
end;
$$;

-- Atomically retires the current active key (with a grace deadline retained
-- only as lifecycle/audit metadata) and activates a freshly generated one, so
-- a subscription is never left with zero or two concurrently active keys.
create or replace function corvis_control.rotate_webhook_signing_key(
  p_tenant_id uuid,
  p_webhook_id uuid,
  p_new_key_id uuid,
  p_new_secret text,
  p_created_by text,
  p_grace_seconds integer default 86400
)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_exists boolean;
begin
  if p_new_secret is null or length(p_new_secret) < 32 then
    raise exception 'signing secret must be at least 32 characters';
  end if;
  if p_grace_seconds < 0 or p_grace_seconds > 2592000 then
    raise exception 'grace period out of range';
  end if;

  select exists(
    select 1 from corvis_control.webhook_subscription
    where tenant_id = p_tenant_id and webhook_id = p_webhook_id and status <> 'revoked'
  ) into v_exists;
  if not v_exists then raise exception 'webhook subscription not found'; end if;

  update corvis_control.webhook_signing_key
  set status = 'retiring', retire_by = now() + make_interval(secs => p_grace_seconds)
  where tenant_id = p_tenant_id and webhook_id = p_webhook_id and status = 'active';

  insert into corvis_control.webhook_signing_key
    (tenant_id, webhook_id, key_id, secret, status, created_at, created_by)
  values (p_tenant_id, p_webhook_id, p_new_key_id, p_new_secret, 'active', now(), p_created_by);

  return p_new_key_id;
end;
$$;

commit;
