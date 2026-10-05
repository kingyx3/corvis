-- F10e (#325): customer-visible deletion requests, and an Organization Admin's own dual-approved request for deletion.
-- Depends on migrations 001-097 (003/017/066 deletion requests, retention policies and legal holds, 071/090/096 the
-- notification outbox and its category check, 084 `tenant_export_admin_user` and the four-eyes pattern this follows).
--
-- Deletion requests were operator-only: Corvis operations create a `corvis_control.deletion_request` and execute it from
-- the admin console (`lib/server/data-lifecycle.ts`, default-deny on retention coverage and legal holds). This migration
-- lets an Organization Admin (`tenant_admin`) see the requests that affect their tenant (a read the application does
-- over safe columns; nothing here exposes an operator identity or note) and ask for one themselves, WITHOUT touching the
-- operator flow:
--
--   * One table, one lifecycle. A customer request is a `deletion_request` row with `origin = 'customer'` that starts in
--     the new state `pending_customer_approval`. That state is not in the executable set of `data-lifecycle.ts`
--     (requested, approved, retryable, blocked), and the table's own CHECK constraints refuse a customer row in any
--     later state (approved, executing, completed, ...) unless a *different* Organization Admin decided it. So Corvis
--     operations cannot run a customer's request before the second admin approves it, and nobody can bypass that by
--     writing the row directly. Approval moves the row to `approved`; from there the unchanged operator flow executes it
--     (still blocked by a missing retention policy or an active legal hold, and still needing a requester who is not the
--     executor).
--   * Four eyes in SQL. `decide_customer_deletion` refuses an approver who is the requester (same identity subject or
--     same user), and a CHECK constraint refuses any row that records the requester as its decider. Request and decision
--     both require an active human Organization Admin (`tenant_export_admin_user`), so a demoted or disabled admin cannot act.
--   * Legal holds block it. Request and approval both refuse a scope under an active legal hold, by the same rule
--     deletion execution applies (`deletion_scope_legal_hold`: a hold on the data class, or a tenant-wide hold).
--   * A customer names only data classes (whole classes, each with an effective retention policy), at most 20, never a
--     document, fund or person selector: the narrower operator scopes stay with operations.
--   * One customer request may be pending per tenant, and one nobody approved within the window lapses (and is audited).
--   * Audited. The application writes the audit event for every human step in the transaction that calls these
--     functions; the lapse of an unapproved request writes its own, here, in the transaction that does it.
--   * Notice (F2). `deletion_request_approval` is a new MANDATORY category (like `tenant_export_approval`: it is the
--     notice that lets the four-eyes control work, so an admin cannot opt out of being asked). It is queued to every
--     other active human Organization Admin when a request is made, in words only (`{event: 'approval_needed'}`), never
--     the reason or the scope. A failure to queue it never blocks the request. There is deliberately no outcome
--     category: the request list shows where a request stands, and the requester sees the decision there.
--
-- Operator rows are unchanged (`origin` defaults to 'operator', and a guard trigger only restricts customer rows).

begin;

-- ---------------------------------------------------------------------------
-- 1. The notification category (the full list from 096, plus deletion_request_approval). Mandatory categories are never
--    stored as preferences, so the preference check is unchanged.
-- ---------------------------------------------------------------------------

alter table corvis_control.email_outbox drop constraint if exists email_outbox_category_check;
alter table corvis_control.email_outbox add constraint email_outbox_category_check check (category in (
  'invitation','export_ready','pinned_fund_published','source_attention',
  'support_access','role_changed','digest','data_issue_update','review_discussion','security_policy',
  'tenant_export_approval','tenant_export_outcome','export_schedule_failed','service_account_expiry',
  'deletion_request_approval'
));

-- ---------------------------------------------------------------------------
-- 2. The customer side of a deletion request
-- ---------------------------------------------------------------------------

alter table corvis_control.deletion_request
  add column if not exists origin text not null default 'operator',
  add column if not exists workspace_id uuid,
  add column if not exists requested_by_auth_method text,
  add column if not exists requested_by_user_id uuid,
  add column if not exists approval_expires_at timestamptz,
  add column if not exists customer_decided_by_subject text,
  add column if not exists customer_decided_by_user_id uuid,
  add column if not exists customer_decided_at timestamptz,
  add column if not exists customer_decision_note text,
  add column if not exists customer_cancelled_at timestamptz;

alter table corvis_control.deletion_request drop constraint if exists deletion_request_origin_check;
alter table corvis_control.deletion_request add constraint deletion_request_origin_check
  check (origin in ('operator','customer'));
-- States that exist only for a customer request. An operator row can never be in one.
alter table corvis_control.deletion_request drop constraint if exists deletion_request_customer_state_check;
alter table corvis_control.deletion_request add constraint deletion_request_customer_state_check
  check (origin = 'customer' or state not in ('pending_customer_approval','rejected','cancelled','expired'));
-- A customer row names who asked, from which workspace, and how long the second admin has.
alter table corvis_control.deletion_request drop constraint if exists deletion_request_customer_fields_check;
alter table corvis_control.deletion_request add constraint deletion_request_customer_fields_check
  check (origin <> 'customer' or (
    workspace_id is not null
    and requested_by_auth_method in ('oidc','saml')
    and requested_by_user_id is not null
    and approval_expires_at is not null and approval_expires_at > requested_at
    and length(btrim(reason)) between 3 and 1000
  ));
-- An operator row carries nothing of the customer decision.
alter table corvis_control.deletion_request drop constraint if exists deletion_request_operator_fields_check;
alter table corvis_control.deletion_request add constraint deletion_request_operator_fields_check
  check (origin = 'customer' or (
    requested_by_user_id is null and approval_expires_at is null and customer_decided_by_subject is null
    and customer_decided_at is null and customer_cancelled_at is null
  ));
-- A decision is recorded as a whole.
alter table corvis_control.deletion_request drop constraint if exists deletion_request_customer_decision_check;
alter table corvis_control.deletion_request add constraint deletion_request_customer_decision_check
  check ((customer_decided_by_subject is null) = (customer_decided_by_user_id is null)
    and (customer_decided_by_subject is null) = (customer_decided_at is null)
    and (customer_decision_note is null or length(customer_decision_note) <= 1000));
-- A customer request is decided before it can be anything but waiting, withdrawn or lapsed: every other state (approved,
-- rejected, and everything the operator flow does afterwards) records a decision.
alter table corvis_control.deletion_request drop constraint if exists deletion_request_customer_state_decision_check;
alter table corvis_control.deletion_request add constraint deletion_request_customer_state_decision_check
  check (origin <> 'customer'
    or ((state in ('pending_customer_approval','expired','cancelled')) = (customer_decided_by_subject is null)));
alter table corvis_control.deletion_request drop constraint if exists deletion_request_customer_rejected_note_check;
alter table corvis_control.deletion_request add constraint deletion_request_customer_rejected_note_check
  check (state <> 'rejected' or customer_decision_note is not null);
alter table corvis_control.deletion_request drop constraint if exists deletion_request_customer_cancelled_check;
alter table corvis_control.deletion_request add constraint deletion_request_customer_cancelled_check
  check ((state = 'cancelled') = (customer_cancelled_at is not null));
-- Four eyes: nobody may approve or reject their own request, by identity subject or by user.
alter table corvis_control.deletion_request drop constraint if exists deletion_request_customer_four_eyes_check;
alter table corvis_control.deletion_request add constraint deletion_request_customer_four_eyes_check
  check (customer_decided_by_subject is null
    or (customer_decided_by_subject <> requested_by and customer_decided_by_user_id <> requested_by_user_id));

-- One customer request waits for approval per tenant.
create unique index if not exists deletion_request_customer_pending_idx
  on corvis_control.deletion_request (tenant_id)
  where state = 'pending_customer_approval';
create index if not exists deletion_request_tenant_requested_idx
  on corvis_control.deletion_request (tenant_id, requested_at desc, deletion_request_id desc);

-- What a customer request is never changes after the fact, its decision is final, and a customer request only moves
-- along the allowed transitions:
--   pending_customer_approval -> approved | rejected | cancelled | expired
--   approved -> (the operator flow: executing, completed, blocked, retryable, ...)
-- It never returns to a customer-only state, and rejected, cancelled and expired are final. Operator rows are not
-- restricted here beyond keeping their origin.
create or replace function corvis_control.guard_deletion_request_update()
returns trigger
language plpgsql
set search_path = pg_catalog, corvis_control
as $$
begin
  if new.origin is distinct from old.origin then
    raise exception 'deletion request origin is immutable';
  end if;
  if old.origin <> 'customer' then
    return new;
  end if;
  if (new.tenant_id, new.deletion_request_id, new.requested_by, new.requested_by_auth_method, new.requested_by_user_id,
      new.workspace_id, new.scope, new.reason, new.requested_at, new.approval_expires_at)
    is distinct from
     (old.tenant_id, old.deletion_request_id, old.requested_by, old.requested_by_auth_method, old.requested_by_user_id,
      old.workspace_id, old.scope, old.reason, old.requested_at, old.approval_expires_at) then
    raise exception 'customer deletion request content is immutable';
  end if;
  if old.customer_decided_by_subject is not null
     and (new.customer_decided_by_subject, new.customer_decided_by_user_id, new.customer_decided_at, new.customer_decision_note)
       is distinct from (old.customer_decided_by_subject, old.customer_decided_by_user_id, old.customer_decided_at, old.customer_decision_note) then
    raise exception 'customer deletion decision is immutable';
  end if;
  if new.state is distinct from old.state then
    if old.state = 'pending_customer_approval' then
      if new.state not in ('approved','rejected','cancelled','expired') then
        raise exception 'customer deletion transition not allowed';
      end if;
    elsif old.state in ('rejected','cancelled','expired')
       or new.state in ('pending_customer_approval','rejected','cancelled','expired') then
      raise exception 'customer deletion transition not allowed';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists deletion_request_guard_update on corvis_control.deletion_request;
create trigger deletion_request_guard_update
  before update on corvis_control.deletion_request
  for each row execute function corvis_control.guard_deletion_request_update();

-- ---------------------------------------------------------------------------
-- 3. Functions
-- ---------------------------------------------------------------------------

-- True when an active legal hold covers any of the data classes: a hold on the class (a retention policy flagged
-- legal_hold, or an unreleased legal_hold row for it) or an unreleased tenant-wide hold. The same rule deletion
-- execution applies (`activeLegalHolds` in data-lifecycle.ts). A scope that is not an array of classes matches nothing.
create or replace function corvis_control.deletion_scope_legal_hold(p_tenant_id uuid, p_data_classes jsonb)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, corvis_control
as $$
  select exists (
    select 1
    from jsonb_array_elements_text(case when jsonb_typeof(p_data_classes) = 'array' then p_data_classes else '[]'::jsonb end) as c(data_class)
    where exists (
        select 1 from corvis_control.retention_policy p
        where p.tenant_id = p_tenant_id and p.data_class = c.data_class and p.legal_hold
      )
      or exists (
        select 1 from corvis_control.legal_hold l
        where l.tenant_id = p_tenant_id and l.released_at is null and (l.data_class is null or l.data_class = c.data_class)
      )
  )
$$;

-- A lapsed request has no caller to carry an audit event, so it writes its own, in the transaction that lapses it.
create or replace function corvis_control.customer_deletion_system_audit(
  p_tenant_id uuid,
  p_workspace_id uuid,
  p_request_id uuid,
  p_action text,
  p_outcome text,
  p_metadata jsonb
)
returns void
language sql
security invoker
set search_path = pg_catalog, corvis_control
as $$
  insert into corvis_control.audit_event
    (tenant_id, workspace_id, actor_subject, action, target_type, target_id, outcome, correlation_id, metadata)
  values
    (p_tenant_id, p_workspace_id, 'system:customer-deletion', p_action, 'deletion_request', p_request_id::text, p_outcome,
     'customer-deletion:' || p_request_id::text, p_metadata)
$$;

-- Records a customer deletion request. Lapses any pending request whose approval window has passed (so it cannot
-- block a new one), then refuses while another is still pending. Writes only the request and the approval notice.
create or replace function corvis_control.request_customer_deletion(
  p_tenant_id uuid,
  p_request_id uuid,
  p_workspace_id uuid,
  p_auth_method text,
  p_subject text,
  p_data_classes jsonb,
  p_reason text,
  p_approval_window_hours integer
)
returns setof corvis_control.deletion_request
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_user uuid;
  v_classes jsonb;
  v_stale corvis_control.deletion_request%rowtype;
  v_row corvis_control.deletion_request%rowtype;
begin
  if length(btrim(coalesce(p_reason, ''))) < 3 or length(btrim(p_reason)) > 1000 then
    raise exception 'customer deletion purpose required';
  end if;
  v_user := corvis_control.tenant_export_admin_user(p_tenant_id, p_auth_method, p_subject);
  if v_user is null then
    raise exception 'customer deletion requires an active organization admin';
  end if;
  if not exists (select 1 from corvis_control.workspace w where w.tenant_id = p_tenant_id and w.workspace_id = p_workspace_id) then
    raise exception 'workspace not found';
  end if;

  -- The scope: 1 to 20 distinct, non-blank data class names, each with a retention policy in effect. Anything else
  -- (a selector, a class the organization has no policy for) is refused rather than widened or guessed at.
  if p_data_classes is null or jsonb_typeof(p_data_classes) <> 'array' then
    raise exception 'customer deletion scope invalid';
  end if;
  if jsonb_array_length(p_data_classes) not between 1 and 20
     or exists (
       select 1 from jsonb_array_elements(p_data_classes) e
       where jsonb_typeof(e) <> 'string' or length(btrim(e #>> '{}')) not between 1 and 100
     ) then
    raise exception 'customer deletion scope invalid';
  end if;
  select jsonb_agg(c.name order by c.name) into v_classes
  from (select distinct btrim(e #>> '{}') as name from jsonb_array_elements(p_data_classes) e) c;
  if (select count(distinct p.data_class) from corvis_control.retention_policy p
      where p.tenant_id = p_tenant_id and p.effective_from <= now()
        and p.data_class in (select jsonb_array_elements_text(v_classes)))
     <> jsonb_array_length(v_classes) then
    raise exception 'customer deletion scope invalid';
  end if;
  if corvis_control.deletion_scope_legal_hold(p_tenant_id, v_classes) then
    raise exception 'customer deletion blocked by legal hold';
  end if;

  for v_stale in
    select * from corvis_control.deletion_request r
    where r.tenant_id = p_tenant_id and r.state = 'pending_customer_approval' and r.approval_expires_at <= now()
    order by r.requested_at
    for update
  loop
    update corvis_control.deletion_request r set state = 'expired'
    where r.tenant_id = p_tenant_id and r.deletion_request_id = v_stale.deletion_request_id;
    perform corvis_control.customer_deletion_system_audit(p_tenant_id, v_stale.workspace_id, v_stale.deletion_request_id,
      'deletion_request.customer_expired', 'success', jsonb_build_object('status', 'expired'));
  end loop;

  if exists (
    select 1 from corvis_control.deletion_request r
    where r.tenant_id = p_tenant_id and r.state = 'pending_customer_approval'
  ) then
    raise exception 'customer deletion already pending';
  end if;

  insert into corvis_control.deletion_request
    (tenant_id, deletion_request_id, requested_by, scope, reason, state, origin, workspace_id,
     requested_by_auth_method, requested_by_user_id, approval_expires_at)
  values
    (p_tenant_id, p_request_id, p_subject, jsonb_build_object('dataClasses', v_classes), btrim(p_reason),
     'pending_customer_approval', 'customer', p_workspace_id, p_auth_method, v_user,
     now() + make_interval(hours => p_approval_window_hours))
  returning * into v_row;

  -- The mandatory notice to every other active human Organization Admin: the people who may approve it. A failure to
  -- queue it is a warning and never undoes the request (the subtransaction rolls back only the notice).
  begin
    insert into corvis_control.email_outbox
      (tenant_id, category, recipient_user_id, required_roles, template_params, dedupe_key)
    select distinct m.tenant_id, 'deletion_request_approval', m.user_id, array['tenant_admin']::text[],
      jsonb_build_object('event', 'approval_needed'),
      'deletion_request_approval:' || p_request_id::text || ':' || m.user_id::text
    from corvis_control.membership m
    where m.tenant_id = p_tenant_id
      and m.role_name = 'tenant_admin' and m.status = 'active'
      and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now())
      and m.user_id <> v_user
      and exists (
        select 1 from corvis_control.identity_subject s
        where s.tenant_id = m.tenant_id and s.user_id = m.user_id and s.status = 'active' and s.auth_method in ('oidc','saml')
      )
    on conflict (tenant_id, dedupe_key) do nothing;
  exception when others then
    raise warning 'customer deletion notification not queued: %', sqlerrm;
  end;

  return next v_row;
end;
$$;

-- Decides a customer request.
--   approve  pending_customer_approval -> approved   (a different active Organization Admin, inside the approval
--                                                      window, and only while no legal hold covers the scope)
--   reject   pending_customer_approval -> rejected   (a different active Organization Admin; a note is required)
--   cancel   pending_customer_approval -> cancelled  (the requester only, before anyone approves)
-- Approval hands the request to Corvis operations: it records the approval (`approved_by`, `approved_at`) and the
-- operator flow runs it from there. Returns no row when the request does not exist in the tenant as a customer request.
create or replace function corvis_control.decide_customer_deletion(
  p_tenant_id uuid,
  p_request_id uuid,
  p_action text,
  p_auth_method text,
  p_subject text,
  p_note text,
  p_expected_state text
)
returns setof corvis_control.deletion_request
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_row corvis_control.deletion_request%rowtype;
  v_user uuid;
  v_to text;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if p_action not in ('approve','reject','cancel') then
    raise exception 'customer deletion transition not allowed';
  end if;
  select * into v_row from corvis_control.deletion_request r
  where r.tenant_id = p_tenant_id and r.deletion_request_id = p_request_id and r.origin = 'customer'
  for update;
  if not found then
    return;
  end if;
  if p_expected_state is not null and v_row.state <> p_expected_state then
    raise exception 'customer deletion status changed';
  end if;
  v_user := corvis_control.tenant_export_admin_user(p_tenant_id, p_auth_method, p_subject);
  if v_user is null then
    raise exception 'customer deletion requires an active organization admin';
  end if;
  if v_row.state <> 'pending_customer_approval' then
    raise exception 'customer deletion transition not allowed';
  end if;

  if p_action = 'cancel' then
    if v_user <> v_row.requested_by_user_id or p_subject <> v_row.requested_by then
      raise exception 'customer deletion can only be cancelled by its requester';
    end if;
    v_to := 'cancelled';
  else
    if v_user = v_row.requested_by_user_id or p_subject = v_row.requested_by then
      raise exception 'customer deletion requires an independent approver';
    end if;
    if v_row.approval_expires_at <= now() then
      raise exception 'customer deletion approval window has passed';
    end if;
    if p_action = 'reject' and v_note is null then
      raise exception 'customer deletion decision note required';
    end if;
    if p_action = 'approve' and corvis_control.deletion_scope_legal_hold(p_tenant_id, v_row.scope -> 'dataClasses') then
      raise exception 'customer deletion blocked by legal hold';
    end if;
    v_to := case p_action when 'approve' then 'approved' else 'rejected' end;
  end if;

  update corvis_control.deletion_request r
  set state = v_to,
      customer_decided_by_subject = case when p_action = 'cancel' then null else p_subject end,
      customer_decided_by_user_id = case when p_action = 'cancel' then null else v_user end,
      customer_decided_at = case when p_action = 'cancel' then null else now() end,
      customer_decision_note = case when p_action = 'cancel' then null else v_note end,
      customer_cancelled_at = case when p_action = 'cancel' then now() end,
      approved_by = case when p_action = 'approve' then p_subject else r.approved_by end,
      approved_at = case when p_action = 'approve' then now() else r.approved_at end
  where r.tenant_id = p_tenant_id and r.deletion_request_id = p_request_id
  returning * into v_row;

  return next v_row;
end;
$$;

commit;
