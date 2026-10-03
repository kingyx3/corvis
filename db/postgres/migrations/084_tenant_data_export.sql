-- F10 (#266): customer-facing retention visibility and full tenant data export with dual approval.
-- Depends on migrations 001-083 (003/017 retention policy and legal holds, 078 contractual data rights,
-- 083 for the server-managed case/event/function template this follows).
--
-- Retention periods and legal holds already exist (003, 017) and stay operated by Corvis from the admin
-- console; this story only adds a customer read path, so it adds no table for them.
--
-- A full tenant export is requested by one Organization Admin (`tenant_admin` membership) and must be approved
-- by a *different* Organization Admin before anything is built. It then moves
--   pending_approval -> approved -> building -> complete | failed        (the build)
--   pending_approval -> rejected | cancelled | expired                   (no build ever starts)
-- Independence is enforced here, not only in the application: the decide function refuses an approver who is the
-- requester (same identity subject or same user), and the table's own CHECK constraints refuse any row that records
-- a requester as the approver, so no code path can bypass it. Every step appends an immutable history row; the
-- application writes the matching audit_event in the same transaction.
--
-- Access model (mirrors 071/083): all three tables are server-managed. Organization-Admin-only visibility is a
-- predicate on the caller's role, not on tenant membership, so there is deliberately no client-facing policy: the
-- application service role reads and writes with explicit tenant predicates after request authorization has
-- succeeded. RLS is enabled and forced so a role without BYPASSRLS sees nothing.

begin;

create table if not exists corvis_control.tenant_export_request (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  request_id uuid not null,
  workspace_id uuid not null,
  requested_by_auth_method text not null check (requested_by_auth_method in ('oidc','saml')),
  requested_by_subject text not null check (length(requested_by_subject) between 1 and 1024),
  requested_by_user_id uuid not null,
  reason text not null check (length(btrim(reason)) between 3 and 1000),
  state text not null default 'pending_approval'
    check (state in ('pending_approval','approved','building','complete','failed','rejected','cancelled','expired')),
  requested_at timestamptz not null default now(),
  -- The second Organization Admin has this long to decide; after it the request lapses and a new one may be made.
  approval_expires_at timestamptz not null,
  -- The approver or rejecter. A request that was approved and then withdrawn keeps its approval here.
  decided_by_subject text check (decided_by_subject is null or length(decided_by_subject) between 1 and 1024),
  decided_by_user_id uuid,
  decided_at timestamptz,
  decision_note text check (decision_note is null or length(decision_note) <= 1000),
  -- Set when the requester withdraws the request before its build starts.
  cancelled_at timestamptz,
  state_changed_at timestamptz not null default now(),
  -- Build bookkeeping (the delivery worker).
  build_attempts integer not null default 0 check (build_attempts >= 0),
  build_started_at timestamptz,
  build_lease_expires_at timestamptz,
  build_next_attempt_at timestamptz,
  last_error text check (last_error is null or length(last_error) <= 2000),
  -- The delivered artifact: a checksum manifest, and a link that expires with the artifact.
  object_uri text,
  artifact_expires_at timestamptz,
  checksum_sha256 text check (checksum_sha256 is null or checksum_sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  manifest jsonb,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (tenant_id, request_id),
  foreign key (tenant_id, workspace_id) references corvis_control.workspace(tenant_id, workspace_id),
  check (approval_expires_at > requested_at),
  -- A decision is recorded as a whole, exists for every state past approval, and never for one that lapsed undecided.
  check ((decided_by_subject is null) = (decided_by_user_id is null)),
  check ((decided_by_subject is null) = (decided_at is null)),
  check (state not in ('approved','building','complete','failed','rejected') or decided_by_subject is not null),
  check (state not in ('pending_approval','expired') or decided_by_subject is null),
  -- Four eyes: nobody may approve or reject their own request, by identity subject or by user.
  check (decided_by_subject is null
    or (decided_by_subject <> requested_by_subject and decided_by_user_id <> requested_by_user_id)),
  check ((state = 'cancelled') = (cancelled_at is not null)),
  check (state <> 'rejected' or decision_note is not null),
  check ((state = 'complete') = (object_uri is not null and artifact_expires_at is not null
    and checksum_sha256 is not null and size_bytes is not null and manifest is not null and completed_at is not null))
);

alter table corvis_control.tenant_export_request enable row level security;
alter table corvis_control.tenant_export_request force row level security;

-- One open request per tenant: a second cannot start while one is pending, approved or building.
create unique index if not exists tenant_export_request_active_idx
  on corvis_control.tenant_export_request (tenant_id)
  where state in ('pending_approval','approved','building');
create index if not exists tenant_export_request_tenant_requested_idx
  on corvis_control.tenant_export_request (tenant_id, requested_at desc, request_id desc);
create index if not exists tenant_export_request_build_queue_idx
  on corvis_control.tenant_export_request (build_next_attempt_at)
  where state = 'approved';

-- Append-only history: who did what, in order, to a request.
create table if not exists corvis_control.tenant_export_request_event (
  tenant_id uuid not null,
  event_id uuid not null default gen_random_uuid(),
  -- Total order within the request even when several steps share one transaction timestamp.
  event_seq bigint generated always as identity,
  request_id uuid not null,
  event_type text not null check (event_type in (
    'requested','approved','rejected','cancelled','expired','build_started','build_retry_scheduled','build_completed','build_failed'
  )),
  from_state text check (from_state is null or from_state in ('pending_approval','approved','building','complete','failed','rejected','cancelled','expired')),
  to_state text not null check (to_state in ('pending_approval','approved','building','complete','failed','rejected','cancelled','expired')),
  actor_subject text not null,
  note text check (note is null or length(note) <= 2000),
  occurred_at timestamptz not null default now(),
  primary key (tenant_id, event_id),
  foreign key (tenant_id, request_id) references corvis_control.tenant_export_request(tenant_id, request_id)
);

alter table corvis_control.tenant_export_request_event enable row level security;
alter table corvis_control.tenant_export_request_event force row level security;

create index if not exists tenant_export_request_event_request_idx
  on corvis_control.tenant_export_request_event (tenant_id, request_id, event_seq);

create or replace function corvis_control.reject_tenant_export_event_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, corvis_control
as $$
begin
  raise exception 'tenant export history is append-only';
end;
$$;

drop trigger if exists tenant_export_request_event_append_only on corvis_control.tenant_export_request_event;
create trigger tenant_export_request_event_append_only
  before update or delete on corvis_control.tenant_export_request_event
  for each row execute function corvis_control.reject_tenant_export_event_mutation();
drop trigger if exists tenant_export_request_event_no_truncate on corvis_control.tenant_export_request_event;
create trigger tenant_export_request_event_no_truncate
  before truncate on corvis_control.tenant_export_request_event
  for each statement execute function corvis_control.reject_tenant_export_event_mutation();

-- Single-use, subject-bound, short-lived download links for a completed export (the expiring link).
create table if not exists corvis_control.tenant_export_download_grant (
  tenant_id uuid not null,
  grant_id uuid not null default gen_random_uuid(),
  request_id uuid not null,
  subject text not null check (length(subject) between 1 and 1024),
  token_sha256 text not null check (token_sha256 ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (tenant_id, grant_id),
  unique (tenant_id, token_sha256),
  foreign key (tenant_id, request_id) references corvis_control.tenant_export_request(tenant_id, request_id)
);

alter table corvis_control.tenant_export_download_grant enable row level security;
alter table corvis_control.tenant_export_download_grant force row level security;

create index if not exists tenant_export_download_grant_request_idx
  on corvis_control.tenant_export_download_grant (tenant_id, request_id, expires_at desc);

-- What was requested never changes after the fact, and a request only moves along the allowed transitions:
--   pending_approval -> approved | rejected | cancelled | expired
--   approved         -> building | cancelled
--   building         -> approved (retry) | complete | failed
-- Everything else (complete, failed, rejected, cancelled, expired) is final.
create or replace function corvis_control.guard_tenant_export_request_update()
returns trigger
language plpgsql
set search_path = pg_catalog, corvis_control
as $$
begin
  if (new.tenant_id, new.request_id, new.workspace_id, new.requested_by_auth_method, new.requested_by_subject,
      new.requested_by_user_id, new.reason, new.requested_at, new.approval_expires_at, new.created_at)
    is distinct from
     (old.tenant_id, old.request_id, old.workspace_id, old.requested_by_auth_method, old.requested_by_subject,
      old.requested_by_user_id, old.reason, old.requested_at, old.approval_expires_at, old.created_at) then
    raise exception 'tenant export request content is immutable';
  end if;
  if old.decided_by_subject is not null
     and (new.decided_by_subject, new.decided_by_user_id, new.decided_at, new.decision_note)
       is distinct from (old.decided_by_subject, old.decided_by_user_id, old.decided_at, old.decision_note) then
    raise exception 'tenant export decision is immutable';
  end if;
  if new.state is distinct from old.state and not (
       (old.state = 'pending_approval' and new.state in ('approved','rejected','cancelled','expired'))
    or (old.state = 'approved' and new.state in ('building','cancelled'))
    or (old.state = 'building' and new.state in ('approved','complete','failed'))
  ) then
    raise exception 'tenant export transition not allowed';
  end if;
  return new;
end;
$$;

drop trigger if exists tenant_export_request_guard_update on corvis_control.tenant_export_request;
create trigger tenant_export_request_guard_update
  before update on corvis_control.tenant_export_request
  for each row execute function corvis_control.guard_tenant_export_request_update();

-- The user behind an active human identity that holds an active Organization Admin (`tenant_admin`) membership in
-- the tenant, or null. Request and decision both require it, so a demoted or disabled admin cannot act.
create or replace function corvis_control.tenant_export_admin_user(
  p_tenant_id uuid,
  p_auth_method text,
  p_subject text
)
returns uuid
language sql
stable
security invoker
set search_path = pg_catalog, corvis_control
as $$
  select s.user_id
  from corvis_control.identity_subject s
  where s.tenant_id = p_tenant_id
    and s.auth_method = p_auth_method
    and p_auth_method in ('oidc','saml')
    and s.subject = p_subject
    and s.status = 'active'
    and exists (
      select 1 from corvis_control.membership m
      where m.tenant_id = s.tenant_id and m.user_id = s.user_id
        and m.role_name = 'tenant_admin' and m.status = 'active'
        and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now())
    )
  limit 1
$$;

-- System-driven transitions (a lapsed approval window, the build worker) have no request to carry an audit event,
-- so these functions write theirs here, in the same transaction as the transition. Human decisions are audited by
-- the application in the transaction that calls request/decide, with the caller's session and correlation id.
create or replace function corvis_control.tenant_export_system_audit(
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
    (p_tenant_id, p_workspace_id, 'system:tenant-export', p_action, 'tenant_export_request', p_request_id::text, p_outcome,
     'tenant-export:' || p_request_id::text, p_metadata)
$$;

-- Records a request. Lapses any pending request whose approval window has passed (so it cannot block a new one),
-- then refuses while another request is still open. Writes only the request and its first history row.
create or replace function corvis_control.request_tenant_export(
  p_tenant_id uuid,
  p_request_id uuid,
  p_workspace_id uuid,
  p_auth_method text,
  p_subject text,
  p_reason text,
  p_approval_window_hours integer
)
returns setof corvis_control.tenant_export_request
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_user uuid;
  v_stale corvis_control.tenant_export_request%rowtype;
  v_row corvis_control.tenant_export_request%rowtype;
begin
  if length(btrim(coalesce(p_reason, ''))) < 3 or length(btrim(p_reason)) > 1000 then
    raise exception 'tenant export purpose required';
  end if;
  v_user := corvis_control.tenant_export_admin_user(p_tenant_id, p_auth_method, p_subject);
  if v_user is null then
    raise exception 'tenant export requires an active organization admin';
  end if;
  if not exists (select 1 from corvis_control.workspace w where w.tenant_id = p_tenant_id and w.workspace_id = p_workspace_id) then
    raise exception 'workspace not found';
  end if;

  for v_stale in
    select * from corvis_control.tenant_export_request r
    where r.tenant_id = p_tenant_id and r.state = 'pending_approval' and r.approval_expires_at <= now()
    order by r.requested_at
    for update
  loop
    update corvis_control.tenant_export_request r set state = 'expired', state_changed_at = now()
    where r.tenant_id = p_tenant_id and r.request_id = v_stale.request_id;
    insert into corvis_control.tenant_export_request_event (tenant_id, request_id, event_type, from_state, to_state, actor_subject, note)
    values (p_tenant_id, v_stale.request_id, 'expired', 'pending_approval', 'expired', 'system:tenant-export', 'no second organization admin approved in time');
    perform corvis_control.tenant_export_system_audit(p_tenant_id, v_stale.workspace_id, v_stale.request_id, 'data_export.expired', 'success',
      jsonb_build_object('status', 'expired'));
  end loop;

  if exists (
    select 1 from corvis_control.tenant_export_request r
    where r.tenant_id = p_tenant_id and r.state in ('pending_approval','approved','building')
  ) then
    raise exception 'tenant export already in progress';
  end if;

  insert into corvis_control.tenant_export_request
    (tenant_id, request_id, workspace_id, requested_by_auth_method, requested_by_subject, requested_by_user_id,
     reason, state, approval_expires_at)
  values
    (p_tenant_id, p_request_id, p_workspace_id, p_auth_method, p_subject, v_user,
     btrim(p_reason), 'pending_approval', now() + make_interval(hours => p_approval_window_hours))
  returning * into v_row;

  insert into corvis_control.tenant_export_request_event (tenant_id, request_id, event_type, from_state, to_state, actor_subject, note)
  values (p_tenant_id, p_request_id, 'requested', null, 'pending_approval', p_subject, null);

  return next v_row;
end;
$$;

-- Decides a request.
--   approve  pending_approval -> approved    (a different active Organization Admin, inside the approval window)
--   reject   pending_approval -> rejected    (a different active Organization Admin; a note is required)
--   cancel   pending_approval | approved -> cancelled   (the requester only, before the build starts)
-- Returns no row when the request does not exist in the tenant.
create or replace function corvis_control.decide_tenant_export(
  p_tenant_id uuid,
  p_request_id uuid,
  p_action text,
  p_auth_method text,
  p_subject text,
  p_note text,
  p_expected_state text
)
returns setof corvis_control.tenant_export_request
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_row corvis_control.tenant_export_request%rowtype;
  v_user uuid;
  v_to text;
  v_from text;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if p_action not in ('approve','reject','cancel') then
    raise exception 'tenant export transition not allowed';
  end if;
  select * into v_row from corvis_control.tenant_export_request r
  where r.tenant_id = p_tenant_id and r.request_id = p_request_id
  for update;
  if not found then
    return;
  end if;
  if p_expected_state is not null and v_row.state <> p_expected_state then
    raise exception 'tenant export status changed';
  end if;
  v_user := corvis_control.tenant_export_admin_user(p_tenant_id, p_auth_method, p_subject);
  if v_user is null then
    raise exception 'tenant export requires an active organization admin';
  end if;
  v_from := v_row.state;

  if p_action = 'cancel' then
    if v_row.state not in ('pending_approval','approved') then
      raise exception 'tenant export transition not allowed';
    end if;
    if v_user <> v_row.requested_by_user_id or p_subject <> v_row.requested_by_subject then
      raise exception 'tenant export can only be cancelled by its requester';
    end if;
    v_to := 'cancelled';
  else
    if v_row.state <> 'pending_approval' then
      raise exception 'tenant export transition not allowed';
    end if;
    if v_user = v_row.requested_by_user_id or p_subject = v_row.requested_by_subject then
      raise exception 'tenant export requires an independent approver';
    end if;
    if v_row.approval_expires_at <= now() then
      raise exception 'tenant export approval window has passed';
    end if;
    if p_action = 'reject' and v_note is null then
      raise exception 'tenant export decision note required';
    end if;
    v_to := case p_action when 'approve' then 'approved' else 'rejected' end;
  end if;

  update corvis_control.tenant_export_request r
  set state = v_to,
      state_changed_at = now(),
      decided_by_subject = case when p_action = 'cancel' then r.decided_by_subject else p_subject end,
      decided_by_user_id = case when p_action = 'cancel' then r.decided_by_user_id else v_user end,
      decided_at = case when p_action = 'cancel' then r.decided_at else now() end,
      decision_note = case when p_action = 'cancel' then r.decision_note else v_note end,
      cancelled_at = case when p_action = 'cancel' then now() end,
      build_next_attempt_at = case when v_to = 'approved' then now() end
  where r.tenant_id = p_tenant_id and r.request_id = p_request_id
  returning * into v_row;

  insert into corvis_control.tenant_export_request_event (tenant_id, request_id, event_type, from_state, to_state, actor_subject, note)
  values (p_tenant_id, p_request_id, v_to, v_from, v_to, p_subject, v_note);

  return next v_row;
end;
$$;

-- The delivery worker's queue. One claim per call (skip locked, so concurrent workers never take the same
-- request). A build abandoned by a crashed worker (its lease passed) is first put back in the queue, or failed once
-- its attempts are used up, so nothing is stuck in `building` forever.
create or replace function corvis_control.claim_next_tenant_export_build(
  p_lease_minutes integer,
  p_max_attempts integer
)
returns setof corvis_control.tenant_export_request
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_stale corvis_control.tenant_export_request%rowtype;
  v_row corvis_control.tenant_export_request%rowtype;
begin
  for v_stale in
    select * from corvis_control.tenant_export_request r
    where r.state = 'building' and coalesce(r.build_lease_expires_at, '-infinity'::timestamptz) < now()
    order by r.requested_at
    for update skip locked
  loop
    if v_stale.build_attempts >= p_max_attempts then
      update corvis_control.tenant_export_request r
      set state = 'failed', state_changed_at = now(), build_lease_expires_at = null,
          last_error = 'export build lease expired before completion'
      where r.tenant_id = v_stale.tenant_id and r.request_id = v_stale.request_id;
      insert into corvis_control.tenant_export_request_event (tenant_id, request_id, event_type, from_state, to_state, actor_subject, note)
      values (v_stale.tenant_id, v_stale.request_id, 'build_failed', 'building', 'failed', 'system:tenant-export', 'export build lease expired before completion');
      perform corvis_control.tenant_export_system_audit(v_stale.tenant_id, v_stale.workspace_id, v_stale.request_id, 'data_export.build_failed', 'failure',
        jsonb_build_object('status', 'failed', 'attempt', v_stale.build_attempts));
    else
      update corvis_control.tenant_export_request r
      set state = 'approved', state_changed_at = now(), build_lease_expires_at = null, build_next_attempt_at = now(),
          last_error = 'export build lease expired before completion'
      where r.tenant_id = v_stale.tenant_id and r.request_id = v_stale.request_id;
      insert into corvis_control.tenant_export_request_event (tenant_id, request_id, event_type, from_state, to_state, actor_subject, note)
      values (v_stale.tenant_id, v_stale.request_id, 'build_retry_scheduled', 'building', 'approved', 'system:tenant-export', 'export build lease expired before completion');
      perform corvis_control.tenant_export_system_audit(v_stale.tenant_id, v_stale.workspace_id, v_stale.request_id, 'data_export.build_retry_scheduled', 'failure',
        jsonb_build_object('status', 'approved', 'attempt', v_stale.build_attempts));
    end if;
  end loop;

  select * into v_row from corvis_control.tenant_export_request r
  where r.state = 'approved' and coalesce(r.build_next_attempt_at, '-infinity'::timestamptz) <= now()
  order by r.decided_at, r.requested_at
  limit 1
  for update skip locked;
  if not found then
    return;
  end if;

  update corvis_control.tenant_export_request r
  set state = 'building', state_changed_at = now(), build_attempts = r.build_attempts + 1,
      build_started_at = now(), build_lease_expires_at = now() + make_interval(mins => p_lease_minutes),
      build_next_attempt_at = null, last_error = null
  where r.tenant_id = v_row.tenant_id and r.request_id = v_row.request_id
  returning * into v_row;
  insert into corvis_control.tenant_export_request_event (tenant_id, request_id, event_type, from_state, to_state, actor_subject, note)
  values (v_row.tenant_id, v_row.request_id, 'build_started', 'approved', 'building', 'system:tenant-export', null);
  perform corvis_control.tenant_export_system_audit(v_row.tenant_id, v_row.workspace_id, v_row.request_id, 'data_export.build_started', 'success',
    jsonb_build_object('status', 'building', 'attempt', v_row.build_attempts));

  return next v_row;
end;
$$;

-- A build finished. Bound to the attempt that claimed it: a stale worker (one whose lease was reclaimed) matches
-- no row and so can never overwrite the attempt that replaced it.
create or replace function corvis_control.complete_tenant_export_build(
  p_tenant_id uuid,
  p_request_id uuid,
  p_attempt integer,
  p_object_uri text,
  p_artifact_expires_at timestamptz,
  p_checksum_sha256 text,
  p_size_bytes bigint,
  p_manifest jsonb
)
returns setof corvis_control.tenant_export_request
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_row corvis_control.tenant_export_request%rowtype;
begin
  update corvis_control.tenant_export_request r
  set state = 'complete', state_changed_at = now(), completed_at = now(), build_lease_expires_at = null, last_error = null,
      object_uri = p_object_uri, artifact_expires_at = p_artifact_expires_at, checksum_sha256 = p_checksum_sha256,
      size_bytes = p_size_bytes, manifest = p_manifest
  where r.tenant_id = p_tenant_id and r.request_id = p_request_id and r.state = 'building' and r.build_attempts = p_attempt
  returning * into v_row;
  if not found then
    return;
  end if;
  insert into corvis_control.tenant_export_request_event (tenant_id, request_id, event_type, from_state, to_state, actor_subject, note)
  values (p_tenant_id, p_request_id, 'build_completed', 'building', 'complete', 'system:tenant-export', null);
  perform corvis_control.tenant_export_system_audit(p_tenant_id, v_row.workspace_id, p_request_id, 'data_export.build_completed', 'success',
    jsonb_build_object('status', 'complete', 'attempt', p_attempt, 'sizeBytes', p_size_bytes, 'checksumSha256', p_checksum_sha256));
  return next v_row;
end;
$$;

-- A build attempt failed. Permanent failures (and exhausted attempts) end the request; anything else goes back in the
-- queue for p_next_attempt_at. Bound to the claiming attempt, like completion.
create or replace function corvis_control.fail_tenant_export_build(
  p_tenant_id uuid,
  p_request_id uuid,
  p_attempt integer,
  p_error text,
  p_permanent boolean,
  p_next_attempt_at timestamptz,
  p_max_attempts integer
)
returns setof corvis_control.tenant_export_request
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_row corvis_control.tenant_export_request%rowtype;
  v_final boolean;
begin
  select * into v_row from corvis_control.tenant_export_request r
  where r.tenant_id = p_tenant_id and r.request_id = p_request_id and r.state = 'building' and r.build_attempts = p_attempt
  for update;
  if not found then
    return;
  end if;
  v_final := p_permanent or v_row.build_attempts >= p_max_attempts;
  update corvis_control.tenant_export_request r
  set state = case when v_final then 'failed' else 'approved' end,
      state_changed_at = now(), build_lease_expires_at = null,
      build_next_attempt_at = case when v_final then null else p_next_attempt_at end,
      last_error = left(p_error, 2000)
  where r.tenant_id = p_tenant_id and r.request_id = p_request_id
  returning * into v_row;
  insert into corvis_control.tenant_export_request_event (tenant_id, request_id, event_type, from_state, to_state, actor_subject, note)
  values (p_tenant_id, p_request_id, case when v_final then 'build_failed' else 'build_retry_scheduled' end, 'building', v_row.state,
          'system:tenant-export', left(p_error, 2000));
  perform corvis_control.tenant_export_system_audit(p_tenant_id, v_row.workspace_id, p_request_id,
    case when v_final then 'data_export.build_failed' else 'data_export.build_retry_scheduled' end, 'failure',
    jsonb_build_object('status', v_row.state, 'attempt', p_attempt));
  return next v_row;
end;
$$;

-- Contractual data rights for a tenant export (#266, criterion 4): the funds and documents whose data the tenant may
-- redistribute right now. Fail closed at every level:
--   * a resource counts only while *every* effective data_rights row for it (effective_from <= now < effective_to)
--     is both client-visible and redistribution-allowed; a resource with no effective row is excluded;
--   * the tenant must also hold an effective workspace-level redistribution right, the same gate every other export
--     already applies (assertRedistributionAllowed), otherwise nothing is returned at all.
-- source_document_access_allowed is reported for documents so source files are only ever offered where it is granted.
create or replace function corvis_control.tenant_export_rights(p_tenant_id uuid)
returns table (resource_type text, resource_id text, source_document_access_allowed boolean)
language sql
stable
security invoker
set search_path = pg_catalog, corvis_control
as $$
  with effective as (
    select dr.resource_type, dr.resource_id,
           bool_and(dr.client_visible) as client_visible,
           bool_and(dr.redistribution_allowed) as redistribution_allowed,
           bool_and(dr.source_document_access_allowed) as source_access
    from corvis_control.data_rights dr
    where dr.tenant_id = p_tenant_id
      and dr.effective_from <= now()
      and (dr.effective_to is null or dr.effective_to > now())
    group by dr.resource_type, dr.resource_id
  )
  select e.resource_type, e.resource_id, e.source_access
  from effective e
  where e.resource_type in ('fund','document')
    and e.client_visible and e.redistribution_allowed
    and exists (select 1 from effective w where w.resource_type = 'workspace' and w.redistribution_allowed)
  order by e.resource_type, e.resource_id
$$;

commit;
