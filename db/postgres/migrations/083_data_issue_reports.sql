-- F5 (#261): customer data-issue reports on published figures.
-- Depends on migrations 001-082 (022 governed data correction, 071 email notifications).
--
-- A customer who doubts a published figure reports it with the figure, its scope
-- (fund / company / metric / period / snapshot version) and a comment. The report
-- becomes a tenant-scoped *case* routed to Data Operations. Cases move
--   received -> investigating -> corrected | no_change
-- and a `corrected` case links to the governed correction (022) that republished the
-- figure, exposing the replacement snapshot id and version.
--
-- Reporting is deliberately inert. Nothing here writes to observations, facts,
-- snapshots, publication events, data_correction_incident or the outbox: a report
-- records a claim; only the governed correction flow can change data or publication.
--
-- Access model (mirrors 071, not 022): both tables are server-managed. A case is
-- visible to its reporter and to Organization Admins only, which is a predicate on
-- the reporter's identity rather than on tenant membership, so there is deliberately
-- no client-facing policy: the application service role reads and writes with
-- explicit tenant/reporter predicates after request authorization has succeeded.
-- RLS is enabled and forced so a role without BYPASSRLS sees nothing.

begin;

create table if not exists corvis_control.data_issue_case (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  case_id uuid not null,
  workspace_id uuid not null,
  reporter_auth_method text not null check (reporter_auth_method in ('oidc','saml','service_account')),
  reporter_subject text not null check (length(reporter_subject) between 1 and 1024),
  -- Null for a reporter with no active human identity row; such a reporter is never emailed.
  reporter_user_id uuid,
  idempotency_key text not null check (length(idempotency_key) between 1 and 256),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  figure text not null check (figure in ('overview','position_financials','review')),
  fund_id text not null check (length(fund_id) between 1 and 512),
  fund_label text check (fund_label is null or length(fund_label) <= 200),
  company_id text check (company_id is null or length(company_id) between 1 and 512),
  company_label text check (company_label is null or length(company_label) <= 200),
  metric_code text check (metric_code is null or length(metric_code) between 1 and 256),
  metric_label text check (metric_label is null or length(metric_label) <= 200),
  report_period text not null check (length(report_period) between 1 and 128),
  snapshot_id uuid,
  snapshot_version integer check (snapshot_version is null or snapshot_version > 0),
  comment text not null check (length(btrim(comment)) between 1 and 2000),
  status text not null default 'received' check (status in ('received','investigating','corrected','no_change')),
  routed_to text not null default 'data_operations' check (routed_to = 'data_operations'),
  correction_incident_id uuid,
  replacement_snapshot_id uuid,
  replacement_snapshot_version integer check (replacement_snapshot_version is null or replacement_snapshot_version > 0),
  resolution_note text check (resolution_note is null or length(resolution_note) <= 2000),
  status_changed_at timestamptz not null default now(),
  status_changed_by text not null,
  -- The status the reporter last looked at; an in-app "updated" badge shows while it differs from `status`.
  reporter_seen_status text not null default 'received' check (reporter_seen_status in ('received','investigating','corrected','no_change')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, case_id),
  unique (tenant_id, reporter_auth_method, reporter_subject, idempotency_key),
  foreign key (tenant_id, workspace_id) references corvis_control.workspace(tenant_id, workspace_id),
  foreign key (tenant_id, correction_incident_id) references corvis_control.data_correction_incident(tenant_id, incident_id),
  check (snapshot_version is null or snapshot_id is not null),
  check ((status = 'corrected') = (replacement_snapshot_id is not null and replacement_snapshot_version is not null)),
  check ((replacement_snapshot_id is null) = (replacement_snapshot_version is null)),
  check (status <> 'corrected' or correction_incident_id is not null),
  check (status <> 'no_change' or resolution_note is not null)
);

alter table corvis_control.data_issue_case enable row level security;
alter table corvis_control.data_issue_case force row level security;

create index if not exists data_issue_case_tenant_created_idx
  on corvis_control.data_issue_case (tenant_id, created_at desc, case_id desc);
create index if not exists data_issue_case_reporter_idx
  on corvis_control.data_issue_case (tenant_id, reporter_auth_method, reporter_subject, created_at desc, case_id desc);
create index if not exists data_issue_case_correction_idx
  on corvis_control.data_issue_case (tenant_id, correction_incident_id)
  where correction_incident_id is not null;

-- Append-only status history (the case row only holds the current status).
create table if not exists corvis_control.data_issue_case_event (
  tenant_id uuid not null,
  event_id uuid not null default gen_random_uuid(),
  -- Total order within the case even when several steps share one transaction timestamp.
  event_seq bigint generated always as identity,
  case_id uuid not null,
  from_status text check (from_status is null or from_status in ('received','investigating','corrected','no_change')),
  to_status text not null check (to_status in ('received','investigating','corrected','no_change')),
  actor_subject text not null,
  note text check (note is null or length(note) <= 2000),
  occurred_at timestamptz not null default now(),
  primary key (tenant_id, event_id),
  foreign key (tenant_id, case_id) references corvis_control.data_issue_case(tenant_id, case_id)
);

alter table corvis_control.data_issue_case_event enable row level security;
alter table corvis_control.data_issue_case_event force row level security;

create index if not exists data_issue_case_event_case_idx
  on corvis_control.data_issue_case_event (tenant_id, case_id, event_seq);

create or replace function corvis_control.reject_data_issue_event_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, corvis_control
as $$
begin
  raise exception 'data issue case history is append-only';
end;
$$;

drop trigger if exists data_issue_case_event_append_only on corvis_control.data_issue_case_event;
create trigger data_issue_case_event_append_only
  before update or delete on corvis_control.data_issue_case_event
  for each row execute function corvis_control.reject_data_issue_event_mutation();
drop trigger if exists data_issue_case_event_no_truncate on corvis_control.data_issue_case_event;
create trigger data_issue_case_event_no_truncate
  before truncate on corvis_control.data_issue_case_event
  for each statement execute function corvis_control.reject_data_issue_event_mutation();

-- What was reported never changes after the fact: only the workflow columns may move.
create or replace function corvis_control.guard_data_issue_case_update()
returns trigger
language plpgsql
set search_path = pg_catalog, corvis_control
as $$
begin
  if (new.tenant_id, new.case_id, new.workspace_id, new.reporter_auth_method, new.reporter_subject, new.reporter_user_id,
      new.idempotency_key, new.request_hash, new.figure, new.fund_id, new.fund_label, new.company_id, new.company_label,
      new.metric_code, new.metric_label, new.report_period, new.snapshot_id, new.snapshot_version, new.comment,
      new.routed_to, new.created_at)
    is distinct from
     (old.tenant_id, old.case_id, old.workspace_id, old.reporter_auth_method, old.reporter_subject, old.reporter_user_id,
      old.idempotency_key, old.request_hash, old.figure, old.fund_id, old.fund_label, old.company_id, old.company_label,
      old.metric_code, old.metric_label, old.report_period, old.snapshot_id, old.snapshot_version, old.comment,
      old.routed_to, old.created_at) then
    raise exception 'data issue report content is immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists data_issue_case_guard_update on corvis_control.data_issue_case;
create trigger data_issue_case_guard_update
  before update on corvis_control.data_issue_case
  for each row execute function corvis_control.guard_data_issue_case_update();

-- The F5 notification category (docs/NOTIFICATIONS.md): outbox rows and per-user preferences may now name it.
alter table corvis_control.email_outbox drop constraint if exists email_outbox_category_check;
alter table corvis_control.email_outbox add constraint email_outbox_category_check check (category in (
  'invitation','export_ready','pinned_fund_published','source_attention',
  'support_access','role_changed','digest','data_issue_update'
));
alter table corvis_control.notification_preference drop constraint if exists notification_preference_category_check;
alter table corvis_control.notification_preference add constraint notification_preference_category_check
  check (category in ('export_ready','pinned_fund_published','source_attention','data_issue_update'));

-- Records a report. Idempotent per reporter: the same key and content returns the existing case, the same key with
-- different content is refused. Writes only the case and its first history row.
create or replace function corvis_control.report_data_issue(
  p_tenant_id uuid,
  p_case_id uuid,
  p_workspace_id uuid,
  p_reporter_auth_method text,
  p_reporter_subject text,
  p_idempotency_key text,
  p_request_hash text,
  p_figure text,
  p_fund_id text,
  p_fund_label text,
  p_company_id text,
  p_company_label text,
  p_metric_code text,
  p_metric_label text,
  p_report_period text,
  p_snapshot_id uuid,
  p_snapshot_version integer,
  p_comment text
)
returns setof corvis_control.data_issue_case
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control, corvis_consolidated
as $$
declare
  v_case corvis_control.data_issue_case%rowtype;
  v_user_id uuid;
begin
  select * into v_case from corvis_control.data_issue_case c
  where c.tenant_id = p_tenant_id and c.reporter_auth_method = p_reporter_auth_method
    and c.reporter_subject = p_reporter_subject and c.idempotency_key = p_idempotency_key
  for update;
  if found then
    if v_case.request_hash <> p_request_hash then
      raise exception 'idempotency key reused with different data issue report';
    end if;
    return next v_case;
    return;
  end if;

  if p_snapshot_id is not null and not exists (
    select 1 from corvis_consolidated.fund_period_snapshot s
    where s.tenant_id = p_tenant_id and s.snapshot_id = p_snapshot_id and s.fund_id = p_fund_id
      and (p_snapshot_version is null or s.version = p_snapshot_version)
  ) then
    raise exception 'data issue snapshot not found for fund';
  end if;

  select s.user_id into v_user_id from corvis_control.identity_subject s
  where s.tenant_id = p_tenant_id and s.auth_method = p_reporter_auth_method
    and s.subject = p_reporter_subject and s.status = 'active';

  insert into corvis_control.data_issue_case
    (tenant_id, case_id, workspace_id, reporter_auth_method, reporter_subject, reporter_user_id, idempotency_key, request_hash,
     figure, fund_id, fund_label, company_id, company_label, metric_code, metric_label, report_period, snapshot_id,
     snapshot_version, comment, status, status_changed_by, reporter_seen_status)
  values
    (p_tenant_id, p_case_id, p_workspace_id, p_reporter_auth_method, p_reporter_subject, v_user_id, p_idempotency_key, p_request_hash,
     p_figure, p_fund_id, p_fund_label, p_company_id, p_company_label, p_metric_code, p_metric_label, p_report_period, p_snapshot_id,
     p_snapshot_version, btrim(p_comment), 'received', p_reporter_subject, 'received')
  returning * into v_case;

  insert into corvis_control.data_issue_case_event (tenant_id, case_id, from_status, to_status, actor_subject)
  values (p_tenant_id, p_case_id, null, 'received', p_reporter_subject);

  return next v_case;
end;
$$;

-- Moves a case along received -> investigating -> corrected | no_change.
--   investigate  received      -> investigating   (optionally links a governed correction incident)
--   correct      investigating -> corrected       (needs a *resolved* incident for the same fund and period; the
--                                                  replacement snapshot id/version are copied from that incident)
--   no_change    investigating -> no_change       (needs a resolution note)
-- Returns no row when the case does not exist in the tenant.
create or replace function corvis_control.transition_data_issue_case(
  p_tenant_id uuid,
  p_case_id uuid,
  p_action text,
  p_expected_status text,
  p_actor_subject text,
  p_note text,
  p_correction_incident_id uuid
)
returns setof corvis_control.data_issue_case
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_case corvis_control.data_issue_case%rowtype;
  v_incident corvis_control.data_correction_incident%rowtype;
  v_to text;
  v_incident_id uuid;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into v_case from corvis_control.data_issue_case c
  where c.tenant_id = p_tenant_id and c.case_id = p_case_id
  for update;
  if not found then
    return;
  end if;
  if p_expected_status is not null and v_case.status <> p_expected_status then
    raise exception 'data issue case status changed';
  end if;

  if p_action = 'investigate' and v_case.status = 'received' then
    v_to := 'investigating';
  elsif p_action = 'correct' and v_case.status = 'investigating' then
    v_to := 'corrected';
  elsif p_action = 'no_change' and v_case.status = 'investigating' then
    v_to := 'no_change';
  else
    raise exception 'data issue transition not allowed';
  end if;

  v_incident_id := coalesce(p_correction_incident_id, v_case.correction_incident_id);
  if v_incident_id is not null then
    select * into v_incident from corvis_control.data_correction_incident i
    where i.tenant_id = p_tenant_id and i.incident_id = v_incident_id;
    if not found then
      raise exception 'data issue correction not found';
    end if;
    if v_incident.fund_id <> v_case.fund_id or v_incident.report_period <> v_case.report_period then
      raise exception 'data issue correction scope mismatch';
    end if;
  end if;

  if v_to = 'investigating' then
    if v_incident_id is not null and v_incident.state = 'cancelled' then
      raise exception 'data issue correction was cancelled';
    end if;
  elsif v_to = 'corrected' then
    if v_incident_id is null then
      raise exception 'data issue correction required';
    end if;
    if v_incident.state <> 'resolved' then
      raise exception 'data issue correction is not resolved';
    end if;
  elsif v_note is null then
    raise exception 'data issue resolution note required';
  end if;

  update corvis_control.data_issue_case c
  set status = v_to,
      status_changed_at = now(),
      status_changed_by = p_actor_subject,
      correction_incident_id = v_incident_id,
      replacement_snapshot_id = case when v_to = 'corrected' then v_incident.replacement_snapshot_id end,
      replacement_snapshot_version = case when v_to = 'corrected' then v_incident.replacement_snapshot_version end,
      resolution_note = case when v_to in ('corrected','no_change') then v_note end
  where c.tenant_id = p_tenant_id and c.case_id = p_case_id
  returning * into v_case;

  insert into corvis_control.data_issue_case_event (tenant_id, case_id, from_status, to_status, actor_subject, note)
  values (p_tenant_id, p_case_id,
    case v_to when 'investigating' then 'received' else 'investigating' end,
    v_to, p_actor_subject, v_note);

  return next v_case;
end;
$$;

-- When the governed correction (022) resolves, every case still investigating that was linked to it is corrected with
-- the incident's replacement snapshot. Idempotent: a second call finds nothing left to close.
create or replace function corvis_control.close_data_issue_cases_for_correction(
  p_tenant_id uuid,
  p_incident_id uuid,
  p_actor_subject text
)
returns setof corvis_control.data_issue_case
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_incident corvis_control.data_correction_incident%rowtype;
  v_pending corvis_control.data_issue_case%rowtype;
  v_closed corvis_control.data_issue_case%rowtype;
begin
  select * into v_incident from corvis_control.data_correction_incident i
  where i.tenant_id = p_tenant_id and i.incident_id = p_incident_id and i.state = 'resolved';
  if not found then
    return;
  end if;

  for v_pending in
    select * from corvis_control.data_issue_case c
    where c.tenant_id = p_tenant_id and c.correction_incident_id = p_incident_id and c.status = 'investigating'
    order by c.created_at, c.case_id
    for update
  loop
    update corvis_control.data_issue_case c
    set status = 'corrected',
        status_changed_at = now(),
        status_changed_by = p_actor_subject,
        replacement_snapshot_id = v_incident.replacement_snapshot_id,
        replacement_snapshot_version = v_incident.replacement_snapshot_version
    where c.tenant_id = p_tenant_id and c.case_id = v_pending.case_id
    returning * into v_closed;

    insert into corvis_control.data_issue_case_event (tenant_id, case_id, from_status, to_status, actor_subject)
    values (p_tenant_id, v_pending.case_id, 'investigating', 'corrected', p_actor_subject);

    return next v_closed;
  end loop;
end;
$$;

commit;
