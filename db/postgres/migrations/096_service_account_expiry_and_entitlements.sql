-- F6c (#342) and F6d (#341, expiry notices): service account expiry notices and customer entitlement self-service.
-- Depends on migrations 001-095 (088/092 service accounts, 040/078 resource entitlements and data rights, 071/090 the
-- notification outbox and its category check).
--
-- 1. Expiry notices. `service_account_expiry` is a new MANDATORY F2 category for Organization Admins (the F2 rule for a
--    notice that makes a lifecycle control work: an account's finite lifetime is the 009 control, and an admin who
--    could opt out of hearing that a credential is about to stop would defeat it). It is queued by
--    `queue_service_account_expiry_notices`, which the private delivery tick calls. For every ACTIVE account of an ACTIVE
--    tenant it queues one notice per Organization Admin and per window when the account, or the credential in use,
--    enters its warning window: 'warning' within 14 days of the expiry, 'final' within 3 days. Only the tightest window
--    that applies is queued, so an item first seen late gets one notice, not two. The outbox `dedupe_key` carries the
--    account (or credential), the window, the exact expiry and the recipient, so a sweep that runs every minute queues
--    each notice once, a renewal (a new expiry) starts its own windows and never repeats the old one, a rotated or
--    revoked credential and a deactivated or expired account are no longer candidates, and a credential that ends with
--    its account (its expiry is clamped to the account's) is covered by the account's notice rather than announced twice.
--    The email carries words only (template_params = {subject, window}); it names no account, workspace or person.
--
-- 2. Entitlement self-service. Until now a new account saw nothing until Corvis operations granted fund and document
--    entitlements through `apply_resource_entitlement_admin` (the operator path, still unchanged). An Organization Admin may
--    now grant and revoke them for a SERVICE ACCOUNT, in the account's own workspace, writing the same
--    `resource_entitlement` rows the authorization lookup already reads (no parallel plane). The functions refuse, in SQL,
--    anything the tenant does not hold: the fund or document must belong to the tenant
--    (`access_policy_resource_belongs_to_tenant`, 078) AND the tenant must hold an effective, client-visible contractual
--    data right for it (the same test the authorization lookup applies to a person, `service_account_data_right_effective`).
--    Both refusals raise one message, so a caller cannot probe which resources other tenants hold. Only `read` can be granted
--    (the one permission the lookup consumes for fund and document visibility); a machine never receives review, publish or
--    admin permission here. A grant is for one account, one resource, and the account's workspace, bounded per account.
--    Revocation ends every entitlement of the account on that resource at once and is never refused for a data-right
--    reason (access can always be removed). If a data right later lapses the entitlement stays on record but the lookup
--    ignores it, so access ends with the right. People are untouched: no function here accepts an arbitrary user.

begin;

-- ---------------------------------------------------------------------------
-- 1. The notification category (the full list from 090, plus service_account_expiry). Mandatory categories are never
--    stored as preferences, so the preference check is unchanged.
-- ---------------------------------------------------------------------------

alter table corvis_control.email_outbox drop constraint if exists email_outbox_category_check;
alter table corvis_control.email_outbox add constraint email_outbox_category_check check (category in (
  'invitation','export_ready','pinned_fund_published','source_attention',
  'support_access','role_changed','digest','data_issue_update','review_discussion','security_policy',
  'tenant_export_approval','tenant_export_outcome','export_schedule_failed','service_account_expiry'
));

create index if not exists service_account_active_expiry_idx
  on corvis_control.service_account (expires_at) where status = 'active';
create index if not exists service_account_credential_current_expiry_idx
  on corvis_control.service_account_credential (expires_at) where status = 'active' and ends_at is null;

-- Queues the expiry notices that are due and returns how many it queued (at most p_limit per call; the rest wait for the
-- next tick, and a notice already queued never counts against the limit).
create or replace function corvis_control.queue_service_account_expiry_notices(p_limit integer default 500)
returns integer
language plpgsql
volatile
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_count integer;
begin
  if p_limit is null or p_limit < 1 or p_limit > 5000 then
    raise exception 'service account expiry notice limit is out of range';
  end if;

  insert into corvis_control.email_outbox (tenant_id, category, recipient_user_id, required_roles, template_params, dedupe_key)
  select due.tenant_id, 'service_account_expiry', due.user_id, array['tenant_admin']::text[],
    jsonb_build_object('subject', due.item_kind, 'window', due.warning_window),
    due.dedupe_key
  from (
    select c.tenant_id, c.item_kind, c.warning_window, c.expires_at, r.user_id,
      'service_account_expiry:' || c.item_kind || ':' || c.item_id || ':' || c.warning_window || ':'
        || floor(extract(epoch from c.expires_at))::bigint::text || ':' || r.user_id::text as dedupe_key
    from (
      -- An active account inside its warning window.
      select a.tenant_id, 'account'::text as item_kind, a.service_account_id::text as item_id, a.expires_at,
        case when a.expires_at <= now() + interval '3 days' then 'final' else 'warning' end as warning_window
      from corvis_control.service_account a
      where a.status = 'active' and a.expires_at > now() and a.expires_at <= now() + interval '14 days'
      union all
      -- The credential in use (not one already rotating out or revoked) of an active, unexpired account, when it ends
      -- before the account does: a credential clamped to its account's expiry is covered by the account's own notice.
      select k.tenant_id, 'credential'::text, k.credential_id::text, k.expires_at,
        case when k.expires_at <= now() + interval '3 days' then 'final' else 'warning' end
      from corvis_control.service_account_credential k
      join corvis_control.service_account a on a.tenant_id = k.tenant_id and a.service_account_id = k.service_account_id
      where a.status = 'active' and a.expires_at > now()
        and k.status = 'active' and k.ends_at is null
        and k.expires_at > now() and k.expires_at <= now() + interval '14 days'
        and k.expires_at < a.expires_at
    ) c
    join corvis_control.tenant t on t.tenant_id = c.tenant_id and t.status = 'active'
    -- Every active human Organization Admin of the tenant. Eligibility is re-checked when the email is sent.
    join lateral (
      select distinct m.user_id
      from corvis_control.membership m
      where m.tenant_id = c.tenant_id and m.role_name = 'tenant_admin' and m.status = 'active'
        and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now())
        and exists (
          select 1 from corvis_control.identity_subject s
          where s.tenant_id = m.tenant_id and s.user_id = m.user_id and s.status = 'active' and s.auth_method in ('oidc','saml')
        )
    ) r on true
  ) due
  where not exists (
    select 1 from corvis_control.email_outbox o where o.tenant_id = due.tenant_id and o.dedupe_key = due.dedupe_key
  )
  order by due.expires_at, due.dedupe_key
  limit p_limit
  on conflict (tenant_id, dedupe_key) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Entitlement self-service for service accounts
-- ---------------------------------------------------------------------------

-- True only while the tenant holds at least one effective data right for the resource and every effective right is
-- client-visible: the test the authorization lookup applies to a person's entitlement, so a grant made here can never
-- be wider than what the lookup would honour.
create or replace function corvis_control.service_account_data_right_effective(
  p_tenant_id uuid,
  p_resource_type text,
  p_resource_id text
)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, corvis_control
as $$
  select coalesce((
    select bool_and(dr.client_visible)
    from corvis_control.data_rights dr
    where dr.tenant_id = p_tenant_id and dr.resource_type = p_resource_type and dr.resource_id = p_resource_id
      and dr.effective_from <= now() and (dr.effective_to is null or dr.effective_to > now())
  ), false)
$$;

-- Grants the account read access to one fund or document of its tenant, in its own workspace.
create or replace function corvis_control.grant_service_account_entitlement(
  p_tenant_id uuid,
  p_service_account_id uuid,
  p_actor_auth_method text,
  p_actor_subject text,
  p_resource_type text,
  p_resource_id text,
  p_max_entitlements integer
)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_account corvis_control.service_account%rowtype;
begin
  if corvis_control.service_account_admin_user(p_tenant_id, p_actor_auth_method, p_actor_subject) is null then
    raise exception 'service account requires an active organization admin';
  end if;
  if p_resource_type is null or p_resource_type not in ('fund','document') then
    raise exception 'service account resource type not allowed';
  end if;
  if length(btrim(coalesce(p_resource_id, ''))) not between 1 and 512 then
    raise exception 'service account resource required';
  end if;
  if p_max_entitlements is null or p_max_entitlements < 1 then
    raise exception 'service account entitlement limit reached';
  end if;

  select * into v_account from corvis_control.service_account a
  where a.tenant_id = p_tenant_id and a.service_account_id = p_service_account_id
  for update;
  if not found then
    raise exception 'service account not found';
  end if;
  if v_account.status <> 'active' or v_account.expires_at <= now() then
    raise exception 'service account is not active';
  end if;

  -- Nothing the tenant does not own and does not hold a client-visible data right for. One message for both, so the
  -- answer never says whether another tenant holds the resource.
  if not corvis_control.access_policy_resource_belongs_to_tenant(p_tenant_id, p_resource_type, p_resource_id)
     or not corvis_control.service_account_data_right_effective(p_tenant_id, p_resource_type, p_resource_id) then
    raise exception 'service account resource outside organization data rights';
  end if;

  if exists (
    select 1 from corvis_control.resource_entitlement e
    where e.tenant_id = p_tenant_id and e.subject_user_id = v_account.user_id
      and e.resource_type = p_resource_type and e.resource_id = p_resource_id and e.permission = 'read'
      and e.valid_from <= now() and (e.valid_until is null or e.valid_until > now())
  ) then
    raise exception 'service account entitlement already granted';
  end if;
  if (
    select count(*) from corvis_control.resource_entitlement e
    where e.tenant_id = p_tenant_id and e.subject_user_id = v_account.user_id
      and e.valid_from <= now() and (e.valid_until is null or e.valid_until > now())
  ) >= p_max_entitlements then
    raise exception 'service account entitlement limit reached';
  end if;

  insert into corvis_control.resource_entitlement
    (tenant_id, workspace_id, subject_user_id, resource_type, resource_id, permission, valid_from, valid_until)
  values
    (p_tenant_id, v_account.workspace_id, v_account.user_id, p_resource_type, p_resource_id, 'read', now(), null)
  on conflict (tenant_id, workspace_id, subject_user_id, resource_type, resource_id, permission)
  do update set valid_from = excluded.valid_from, valid_until = null;
end;
$$;

-- Ends every entitlement the account holds on the resource, effective now; returns how many it ended. Never refused for a
-- data-right or ownership reason: access can always be removed, including after the right or the resource is gone.
create or replace function corvis_control.revoke_service_account_entitlement(
  p_tenant_id uuid,
  p_service_account_id uuid,
  p_actor_auth_method text,
  p_actor_subject text,
  p_resource_type text,
  p_resource_id text
)
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_account corvis_control.service_account%rowtype;
  v_count integer;
begin
  if corvis_control.service_account_admin_user(p_tenant_id, p_actor_auth_method, p_actor_subject) is null then
    raise exception 'service account requires an active organization admin';
  end if;
  if p_resource_type is null or p_resource_type not in ('fund','document') then
    raise exception 'service account resource type not allowed';
  end if;
  if length(btrim(coalesce(p_resource_id, ''))) not between 1 and 512 then
    raise exception 'service account resource required';
  end if;
  select * into v_account from corvis_control.service_account a
  where a.tenant_id = p_tenant_id and a.service_account_id = p_service_account_id
  for update;
  if not found then
    raise exception 'service account not found';
  end if;

  update corvis_control.resource_entitlement e
  set valid_from = least(e.valid_from, now() - interval '1 microsecond'), valid_until = now()
  where e.tenant_id = p_tenant_id and e.subject_user_id = v_account.user_id
    and e.resource_type = p_resource_type and e.resource_id = p_resource_id
    and (e.valid_until is null or e.valid_until > now());
  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'service account entitlement not found';
  end if;
  return v_count;
end;
$$;

commit;
