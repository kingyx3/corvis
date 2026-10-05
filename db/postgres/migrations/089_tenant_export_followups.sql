-- F10 follow-ups to the full tenant data export (#266, migration 084): approval notices (F10d, #324) and export
-- hygiene (F10f, #326).
-- Depends on migrations 001-088 (071 notification outbox, 083/086/087 for the pattern of adding a notification
-- category, 084 for the export tables and functions this extends).
--
-- Notifications (F10d). Two F2 categories, queued by a trigger on the export request history, so every path that
-- moves a request (the approval workflow, the build worker, a lapsed build lease reclaimed inside the claim function)
-- queues its notice in the same transaction, without each caller having to remember to:
--   tenant_export_approval  MANDATORY  A request was made and needs a different Organization Admin. To every other
--                                      active Organization Admin. It is the notice that lets the four-eyes control work
--                                      (an admin cannot opt out of being asked, and an unexpected request is itself a
--                                      security signal), so like support_access and security_policy it is not a
--                                      preference.
--   tenant_export_outcome   OPTIONAL   The requester's export was approved, rejected, is ready, or could not be built.
--                                      A preference category (default on, immediate) like export_ready.
-- Rows carry only the recipient, the role to re-check at send time and a words-only `event` parameter: never a reason,
-- a note, a name or any data. The dispatcher (src/lib/server/notifications.ts) re-checks the identity and the Organization
-- Admin membership when it sends, so a person demoted in between is suppressed.
--
-- Hygiene (F10f). A swept artifact is recorded (`artifact_deleted_at`) instead of clearing `object_uri`, because the
-- table's own check ties a complete request to its artifact columns. The sweep functions below write their own audit
-- events in the transaction that does the work.

begin;

-- ---------------------------------------------------------------------------
-- Notification categories
-- ---------------------------------------------------------------------------

alter table corvis_control.email_outbox drop constraint if exists email_outbox_category_check;
alter table corvis_control.email_outbox add constraint email_outbox_category_check check (category in (
  'invitation','export_ready','pinned_fund_published','source_attention',
  'support_access','role_changed','digest','data_issue_update','review_discussion','security_policy',
  'tenant_export_approval','tenant_export_outcome'
));
alter table corvis_control.notification_preference drop constraint if exists notification_preference_category_check;
alter table corvis_control.notification_preference add constraint notification_preference_category_check
  check (category in ('export_ready','pinned_fund_published','source_attention','data_issue_update','review_discussion','tenant_export_outcome'));

-- Queues the notices for one history row. A failure to queue is raised as a warning and never undoes the step that
-- caused it: a notification fault must not block the approval workflow or the build (the subtransaction below rolls
-- back only the notice).
create or replace function corvis_control.notify_tenant_export_event()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_requester uuid;
begin
  if new.event_type not in ('requested','approved','rejected','build_completed','build_failed') then
    return new;
  end if;
  begin
    select r.requested_by_user_id into v_requester
    from corvis_control.tenant_export_request r
    where r.tenant_id = new.tenant_id and r.request_id = new.request_id;

    if new.event_type = 'requested' then
      -- Every other active Organization Admin with an active human identity: the people who may approve it.
      insert into corvis_control.email_outbox
        (tenant_id, category, recipient_user_id, required_roles, template_params, dedupe_key)
      select distinct m.tenant_id, 'tenant_export_approval', m.user_id, array['tenant_admin']::text[],
        jsonb_build_object('event', 'approval_needed'),
        'tenant_export_approval:' || new.request_id::text || ':' || m.user_id::text
      from corvis_control.membership m
      where m.tenant_id = new.tenant_id
        and m.role_name = 'tenant_admin' and m.status = 'active'
        and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now())
        and m.user_id <> v_requester
        and exists (
          select 1 from corvis_control.identity_subject s
          where s.tenant_id = m.tenant_id and s.user_id = m.user_id and s.status = 'active' and s.auth_method in ('oidc','saml')
        )
      on conflict (tenant_id, dedupe_key) do nothing;
    else
      insert into corvis_control.email_outbox
        (tenant_id, category, recipient_user_id, required_roles, template_params, dedupe_key)
      values (new.tenant_id, 'tenant_export_outcome', v_requester, array['tenant_admin']::text[],
        jsonb_build_object('event', case new.event_type
          when 'approved' then 'approved'
          when 'rejected' then 'rejected'
          when 'build_completed' then 'ready'
          else 'failed' end),
        'tenant_export_outcome:' || new.request_id::text || ':' || new.event_type)
      on conflict (tenant_id, dedupe_key) do nothing;
    end if;
  exception when others then
    raise warning 'tenant export notification not queued: %', sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists tenant_export_request_event_notify on corvis_control.tenant_export_request_event;
create trigger tenant_export_request_event_notify
  after insert on corvis_control.tenant_export_request_event
  for each row execute function corvis_control.notify_tenant_export_event();

-- ---------------------------------------------------------------------------
-- Hygiene: stored artifacts and download grants
-- ---------------------------------------------------------------------------

alter table corvis_control.tenant_export_request add column if not exists artifact_deleted_at timestamptz;
alter table corvis_control.tenant_export_request drop constraint if exists tenant_export_request_artifact_deleted_check;
alter table corvis_control.tenant_export_request add constraint tenant_export_request_artifact_deleted_check
  check (artifact_deleted_at is null or state = 'complete');

alter table corvis_control.tenant_export_request_event drop constraint if exists tenant_export_request_event_event_type_check;
alter table corvis_control.tenant_export_request_event add constraint tenant_export_request_event_event_type_check check (event_type in (
  'requested','approved','rejected','cancelled','expired','build_started','build_retry_scheduled','build_completed','build_failed','artifact_deleted'
));

create index if not exists tenant_export_request_artifact_sweep_idx
  on corvis_control.tenant_export_request (artifact_expires_at)
  where state = 'complete' and artifact_deleted_at is null;
create index if not exists tenant_export_request_failed_idx
  on corvis_control.tenant_export_request (state_changed_at desc, request_id desc)
  where state = 'failed' or last_error is not null;
create index if not exists tenant_export_download_grant_expiry_idx
  on corvis_control.tenant_export_download_grant (expires_at);

-- The completed exports whose artifact lifetime has passed and whose stored object is still there: what the sweep
-- must delete from the object store.
create or replace function corvis_control.expired_tenant_export_artifacts(p_limit integer)
returns table (tenant_id uuid, request_id uuid, object_uri text)
language sql
stable
security invoker
set search_path = pg_catalog, corvis_control
as $$
  select r.tenant_id, r.request_id, r.object_uri
  from corvis_control.tenant_export_request r
  where r.state = 'complete' and r.artifact_deleted_at is null and r.artifact_expires_at <= now()
  order by r.artifact_expires_at, r.request_id
  limit greatest(1, least(coalesce(p_limit, 100), 500))
$$;

-- Records that the stored object of an expired export was deleted: stamps the request, removes every download grant
-- for it (the artifact they pointed at is gone), appends the history row and writes the audit event, in one
-- transaction. False (and nothing written) when the request is not a complete export with an expired artifact still
-- on record, so a repeated or racing sweep changes nothing twice.
create or replace function corvis_control.mark_tenant_export_artifact_deleted(p_tenant_id uuid, p_request_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_row corvis_control.tenant_export_request%rowtype;
  v_grants integer;
begin
  update corvis_control.tenant_export_request r
  set artifact_deleted_at = now()
  where r.tenant_id = p_tenant_id and r.request_id = p_request_id
    and r.state = 'complete' and r.artifact_deleted_at is null and r.artifact_expires_at <= now()
  returning * into v_row;
  if not found then
    return false;
  end if;
  delete from corvis_control.tenant_export_download_grant g
  where g.tenant_id = p_tenant_id and g.request_id = p_request_id;
  get diagnostics v_grants = row_count;
  insert into corvis_control.tenant_export_request_event (tenant_id, request_id, event_type, from_state, to_state, actor_subject, note)
  values (p_tenant_id, p_request_id, 'artifact_deleted', 'complete', 'complete', 'system:tenant-export', 'artifact lifetime passed');
  perform corvis_control.tenant_export_system_audit(p_tenant_id, v_row.workspace_id, p_request_id, 'data_export.artifact_deleted', 'success',
    jsonb_build_object('status', 'complete', 'grantsDeleted', v_grants));
  return true;
end;
$$;

-- Deletes download grants that expired more than p_retention_hours ago (a grant lives ten minutes and works once, so
-- one past its expiry can never be redeemed again), at most p_limit per call, and writes one audit event per request
-- with the number removed. Returns the total deleted; a full batch means more remain for the next tick.
create or replace function corvis_control.sweep_tenant_export_grants(p_retention_hours integer, p_limit integer)
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_total integer := 0;
  v_item record;
begin
  for v_item in
    with doomed as (
      select g.tenant_id, g.grant_id
      from corvis_control.tenant_export_download_grant g
      where g.expires_at < now() - make_interval(hours => greatest(1, p_retention_hours))
      order by g.expires_at
      limit greatest(1, least(coalesce(p_limit, 1000), 5000))
      for update skip locked
    ), gone as (
      delete from corvis_control.tenant_export_download_grant g
      using doomed d
      where g.tenant_id = d.tenant_id and g.grant_id = d.grant_id
      returning g.tenant_id, g.request_id
    )
    select gone.tenant_id, gone.request_id, count(*)::integer as deleted
    from gone
    group by gone.tenant_id, gone.request_id
  loop
    perform corvis_control.tenant_export_system_audit(v_item.tenant_id,
      (select r.workspace_id from corvis_control.tenant_export_request r where r.tenant_id = v_item.tenant_id and r.request_id = v_item.request_id),
      v_item.request_id, 'data_export.grants_swept', 'success', jsonb_build_object('deleted', v_item.deleted));
    v_total := v_total + v_item.deleted;
  end loop;
  return v_total;
end;
$$;

commit;
