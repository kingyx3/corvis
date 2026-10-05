-- F3 (#259): assign and discuss review items.
-- Depends on migrations 001-083 (012 reconciliation exceptions, 058/063 serving observations, 071 email notifications,
-- 083 for the pattern of adding a notification category).
--
-- A Review Analyst can assign an observation or a reconciliation exception to a teammate and discuss it in a comment
-- thread. A thread is the one row per (workspace, review item) that holds the current assignee; the discussion itself is
-- an append-only list of comments.
--
-- Discussion is deliberately inert. Nothing here writes to observations, review events, reconciliation resolutions,
-- snapshots or publication, and nothing here reads a comment when deciding dual control: a decision is still a review
-- action (`corvis_facts.review_event`, `reconciliation_resolution_event`) made through the existing review routes.
--
-- Access model (mirrors 071/083, not 022): both tables are server-managed. Whether a person may see a thread depends on
-- their fund and document entitlement and their review role, which tenant membership alone cannot express, so there is
-- deliberately no client-facing policy: the application service role reads and writes with explicit tenant/workspace
-- predicates after request authorization has succeeded. RLS is enabled and forced so a role without BYPASSRLS sees
-- nothing.
--
-- Only workspace members with review access can be assigned or mentioned: an active membership of the workspace in a role
-- that can review (tenant_admin, accountadmin, reviewer), an active human identity, and read entitlement to the item's
-- fund (corvis_control.review_member_eligible, the same entitlement rule the notification outbox re-checks at send time).

begin;

create table if not exists corvis_control.review_item_thread (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  workspace_id uuid not null,
  subject_kind text not null check (subject_kind in ('observation','reconciliation_exception')),
  subject_id uuid not null,
  -- Denormalized from the subject when the thread is created, so assignment lists and the notice's send-time
  -- eligibility check never have to join the subject again. Immutable (see the guard trigger).
  fund_id text not null check (length(fund_id) between 1 and 512),
  report_period text check (report_period is null or length(report_period) <= 128),
  -- Null when unassigned. `version` counts changes of assignee (0 until the first one), so a stale screen cannot
  -- overwrite a newer assignment; comments never move it.
  assignee_user_id uuid,
  previous_assignee_user_id uuid,
  assignment_changed_by text,
  assignment_changed_at timestamptz,
  version integer not null default 0 check (version >= 0),
  comment_count integer not null default 0 check (comment_count between 0 and 200),
  last_comment_at timestamptz,
  created_at timestamptz not null default now(),
  constraint review_item_thread_pkey primary key (tenant_id, workspace_id, subject_kind, subject_id),
  foreign key (tenant_id, workspace_id) references corvis_control.workspace(tenant_id, workspace_id),
  check ((assignee_user_id is null) or (assignment_changed_at is not null and assignment_changed_by is not null))
);

alter table corvis_control.review_item_thread enable row level security;
alter table corvis_control.review_item_thread force row level security;

create index if not exists review_item_thread_assignee_idx
  on corvis_control.review_item_thread (tenant_id, workspace_id, assignee_user_id, assignment_changed_at desc)
  where assignee_user_id is not null;
create index if not exists review_item_thread_listing_idx
  on corvis_control.review_item_thread (tenant_id, workspace_id, subject_kind, subject_id);

-- Append-only discussion. A comment is never edited or deleted: a mistake is answered with another comment.
create table if not exists corvis_control.review_item_comment (
  tenant_id uuid not null,
  workspace_id uuid not null,
  subject_kind text not null,
  subject_id uuid not null,
  comment_id uuid not null default gen_random_uuid(),
  -- Total order within a thread even when several comments share one transaction timestamp.
  comment_seq bigint generated always as identity,
  author_auth_method text not null check (author_auth_method in ('oidc','saml')),
  author_subject text not null check (length(author_subject) between 1 and 1024),
  author_user_id uuid not null,
  idempotency_key text not null check (length(idempotency_key) between 1 and 256),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  body text not null check (length(btrim(body)) between 1 and 2000),
  -- Teammates named with @ in the body, each verified eligible when the comment was written.
  mentioned_user_ids uuid[] not null default '{}' check (cardinality(mentioned_user_ids) <= 10),
  created_at timestamptz not null default now(),
  primary key (tenant_id, comment_id),
  unique (tenant_id, author_auth_method, author_subject, idempotency_key),
  foreign key (tenant_id, workspace_id, subject_kind, subject_id)
    references corvis_control.review_item_thread (tenant_id, workspace_id, subject_kind, subject_id)
);

alter table corvis_control.review_item_comment enable row level security;
alter table corvis_control.review_item_comment force row level security;

create index if not exists review_item_comment_thread_idx
  on corvis_control.review_item_comment (tenant_id, workspace_id, subject_kind, subject_id, comment_seq);

create or replace function corvis_control.reject_review_item_comment_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, corvis_control
as $$
begin
  raise exception 'review item comments are append-only';
end;
$$;

drop trigger if exists review_item_comment_append_only on corvis_control.review_item_comment;
create trigger review_item_comment_append_only
  before update or delete on corvis_control.review_item_comment
  for each row execute function corvis_control.reject_review_item_comment_mutation();
drop trigger if exists review_item_comment_no_truncate on corvis_control.review_item_comment;
create trigger review_item_comment_no_truncate
  before truncate on corvis_control.review_item_comment
  for each statement execute function corvis_control.reject_review_item_comment_mutation();

-- Which item a thread belongs to, and the fund it was opened under, never change; counters and versions only move forward.
create or replace function corvis_control.guard_review_item_thread_update()
returns trigger
language plpgsql
set search_path = pg_catalog, corvis_control
as $$
begin
  if (new.tenant_id, new.workspace_id, new.subject_kind, new.subject_id, new.fund_id, new.report_period, new.created_at)
     is distinct from
     (old.tenant_id, old.workspace_id, old.subject_kind, old.subject_id, old.fund_id, old.report_period, old.created_at) then
    raise exception 'review item thread identity is immutable';
  end if;
  if new.version < old.version or new.comment_count < old.comment_count then
    raise exception 'review item thread counters only move forward';
  end if;
  return new;
end;
$$;

drop trigger if exists review_item_thread_guard_update on corvis_control.review_item_thread;
create trigger review_item_thread_guard_update
  before update on corvis_control.review_item_thread
  for each row execute function corvis_control.guard_review_item_thread_update();

create or replace function corvis_control.reject_review_item_thread_removal()
returns trigger
language plpgsql
set search_path = pg_catalog, corvis_control
as $$
begin
  raise exception 'review item threads cannot be deleted';
end;
$$;

drop trigger if exists review_item_thread_no_delete on corvis_control.review_item_thread;
create trigger review_item_thread_no_delete
  before delete on corvis_control.review_item_thread
  for each row execute function corvis_control.reject_review_item_thread_removal();
drop trigger if exists review_item_thread_no_truncate on corvis_control.review_item_thread;
create trigger review_item_thread_no_truncate
  before truncate on corvis_control.review_item_thread
  for each statement execute function corvis_control.reject_review_item_thread_removal();

-- The F3 notification category (docs/features/NOTIFICATIONS.md): outbox rows and per-user preferences may now name it.
alter table corvis_control.email_outbox drop constraint if exists email_outbox_category_check;
alter table corvis_control.email_outbox add constraint email_outbox_category_check check (category in (
  'invitation','export_ready','pinned_fund_published','source_attention',
  'support_access','role_changed','digest','data_issue_update','review_discussion'
));
alter table corvis_control.notification_preference drop constraint if exists notification_preference_category_check;
alter table corvis_control.notification_preference add constraint notification_preference_category_check
  check (category in ('export_ready','pinned_fund_published','source_attention','data_issue_update','review_discussion'));

-- Whether `p_user_id` may be assigned or mentioned on an item of `p_fund_id` in the workspace: an active membership in a
-- review role, an active human identity and read entitlement to the fund (the rule the outbox re-checks at send time).
create or replace function corvis_control.review_member_eligible(
  p_tenant_id uuid,
  p_workspace_id uuid,
  p_user_id uuid,
  p_fund_id text
)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, corvis_control
as $$
  select exists (
    select 1
    from corvis_control.membership m
    join corvis_control.workspace w
      on w.tenant_id = m.tenant_id and w.workspace_id = m.workspace_id and w.status = 'active'
    join corvis_control.tenant t
      on t.tenant_id = m.tenant_id and t.status = 'active'
    where m.tenant_id = p_tenant_id and m.workspace_id = p_workspace_id and m.user_id = p_user_id
      and m.role_name in ('tenant_admin','accountadmin','reviewer')
      and m.status = 'active' and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now())
  )
  and exists (
    select 1
    from corvis_control.identity_subject s
    where s.tenant_id = p_tenant_id and s.user_id = p_user_id and s.status = 'active' and s.auth_method in ('oidc','saml')
  )
  and exists (
    select 1
    from corvis_control.resource_entitlement e
    where e.tenant_id = p_tenant_id and e.workspace_id = p_workspace_id and e.subject_user_id = p_user_id
      and e.resource_type = 'fund' and e.resource_id = p_fund_id and e.permission = 'read'
      and e.valid_from <= now() and (e.valid_until is null or e.valid_until > now())
      and coalesce((
        select bool_and(dr.client_visible)
        from corvis_control.data_rights dr
        where dr.tenant_id = e.tenant_id and dr.resource_type = 'fund' and dr.resource_id = e.resource_id
          and dr.effective_from <= now() and (dr.effective_to is null or dr.effective_to > now())
      ), false)
  );
$$;

-- How a teammate is named to other teammates: the verified address first (the same one notifications use), then the
-- invitation address, then the identity subject. Never a name the person typed.
create or replace function corvis_control.review_member_label(
  p_tenant_id uuid,
  p_user_id uuid
)
returns text
language sql
stable
security invoker
set search_path = pg_catalog, corvis_control
as $$
  select coalesce(
    (select r.email from corvis_control.notification_recipient r
      where r.tenant_id = p_tenant_id and r.user_id = p_user_id),
    (select i.email from corvis_control.tenant_invitation i
      where i.tenant_id = p_tenant_id and i.accepted_user_id = p_user_id and i.status = 'accepted'
      order by i.accepted_at desc limit 1),
    (select s.subject from corvis_control.identity_subject s
      where s.tenant_id = p_tenant_id and s.user_id = p_user_id and s.status = 'active' and s.auth_method in ('oidc','saml')
      order by s.auth_method, s.subject limit 1)
  );
$$;

create or replace function corvis_control.review_member_labels(
  p_tenant_id uuid,
  p_user_ids uuid[]
)
returns table (member_user_id uuid, member_label text)
language sql
stable
security invoker
set search_path = pg_catalog, corvis_control
as $$
  select u.id, corvis_control.review_member_label(p_tenant_id, u.id)
  from unnest(p_user_ids) as u(id);
$$;

-- Everyone who may be assigned or mentioned on an item of `p_fund_id` in the workspace, with the review roles they hold.
create or replace function corvis_control.review_eligible_members(
  p_tenant_id uuid,
  p_workspace_id uuid,
  p_fund_id text
)
returns table (member_user_id uuid, member_label text, member_roles text[])
language sql
stable
security invoker
set search_path = pg_catalog, corvis_control
as $$
  select m.user_id,
         corvis_control.review_member_label(p_tenant_id, m.user_id),
         array_agg(distinct m.role_name order by m.role_name)
  from corvis_control.membership m
  where m.tenant_id = p_tenant_id and m.workspace_id = p_workspace_id
    and m.role_name in ('tenant_admin','accountadmin','reviewer')
    and m.status = 'active' and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now())
    and corvis_control.review_member_eligible(p_tenant_id, p_workspace_id, m.user_id, p_fund_id)
  group by m.user_id;
$$;

-- The fund and period of a review item the caller may see, or no row. `p_fund_ids` and `p_document_ids` are the caller's
-- entitlements (JSON arrays of text) exactly as the review lists apply them, so a thread can be opened only on an item
-- the caller could already read in Data review.
create or replace function corvis_control.resolve_review_subject(
  p_tenant_id uuid,
  p_subject_kind text,
  p_subject_id uuid,
  p_fund_ids jsonb,
  p_document_ids jsonb
)
returns table (subject_fund_id text, subject_report_period text)
language plpgsql
stable
security invoker
set search_path = pg_catalog, corvis_control, corvis_consolidated, corvis_source, corvis_serving
as $$
begin
  if p_subject_kind = 'observation' then
    return query
      select o.fund_id::text, o.economic_period::text
      from corvis_serving.observations o
      join corvis_source.source_reference r
        on r.tenant_id = o.tenant_id and r.source_reference_id = o.source_reference_id
      where o.tenant_id = p_tenant_id and o.observation_id = p_subject_id
        and o.fund_id in (select jsonb_array_elements_text(p_fund_ids))
        and lower(r.document_id::text) in (select lower(entitled.id) from jsonb_array_elements_text(p_document_ids) as entitled(id))
      limit 1;
  elsif p_subject_kind = 'reconciliation_exception' then
    return query
      select e.fund_id::text, e.report_period::text
      from corvis_consolidated.reconciliation_exception e
      where e.tenant_id = p_tenant_id and e.exception_id = p_subject_id
        and e.fund_id in (select jsonb_array_elements_text(p_fund_ids))
      limit 1;
  end if;
end;
$$;

-- Assigns, reassigns or unassigns (`p_assignee_user_id` null) a review item. Compare-and-set on the thread's version
-- (0 when it has never been assigned), so two people assigning at once cannot silently overwrite each other. Assigning the person who
-- already holds the item changes nothing and keeps the version. Writes only the thread row.
create or replace function corvis_control.set_review_item_assignee(
  p_tenant_id uuid,
  p_workspace_id uuid,
  p_subject_kind text,
  p_subject_id uuid,
  p_fund_ids jsonb,
  p_document_ids jsonb,
  p_actor_auth_method text,
  p_actor_subject text,
  p_assignee_user_id uuid,
  p_expected_version integer
)
returns setof corvis_control.review_item_thread
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control, corvis_consolidated, corvis_source, corvis_serving
as $$
declare
  v_fund_id text;
  v_period text;
  v_thread corvis_control.review_item_thread%rowtype;
begin
  select s.subject_fund_id, s.subject_report_period into v_fund_id, v_period
  from corvis_control.resolve_review_subject(p_tenant_id, p_subject_kind, p_subject_id, p_fund_ids, p_document_ids) s;
  if v_fund_id is null then
    raise exception 'review item not found';
  end if;
  if not exists (
    select 1 from corvis_control.identity_subject s
    where s.tenant_id = p_tenant_id and s.auth_method = p_actor_auth_method and s.subject = p_actor_subject
      and s.status = 'active' and s.auth_method in ('oidc','saml')
  ) then
    raise exception 'review item actor not found';
  end if;
  if p_assignee_user_id is not null
     and not corvis_control.review_member_eligible(p_tenant_id, p_workspace_id, p_assignee_user_id, v_fund_id) then
    raise exception 'review assignee not eligible';
  end if;

  insert into corvis_control.review_item_thread
    (tenant_id, workspace_id, subject_kind, subject_id, fund_id, report_period, version)
  values (p_tenant_id, p_workspace_id, p_subject_kind, p_subject_id, v_fund_id, v_period, 0)
  on conflict on constraint review_item_thread_pkey do nothing;
  select * into v_thread from corvis_control.review_item_thread t
  where t.tenant_id = p_tenant_id and t.workspace_id = p_workspace_id and t.subject_kind = p_subject_kind and t.subject_id = p_subject_id
  for update;

  if p_expected_version <> v_thread.version then
    raise exception 'review item assignment changed';
  end if;

  if v_thread.assignee_user_id is not distinct from p_assignee_user_id then
    return next v_thread;
    return;
  end if;

  update corvis_control.review_item_thread t
  set previous_assignee_user_id = v_thread.assignee_user_id,
      assignee_user_id = p_assignee_user_id,
      assignment_changed_by = p_actor_subject,
      assignment_changed_at = now(),
      version = v_thread.version + 1
  where t.tenant_id = p_tenant_id and t.workspace_id = p_workspace_id and t.subject_kind = p_subject_kind and t.subject_id = p_subject_id
  returning * into v_thread;

  return next v_thread;
end;
$$;

-- Appends a comment. Idempotent per author: the same key and content returns the existing comment, the same key with
-- different content is refused. Every mentioned teammate must be eligible for the item. Writes only the comment and the
-- thread's counters.
create or replace function corvis_control.add_review_item_comment(
  p_tenant_id uuid,
  p_workspace_id uuid,
  p_subject_kind text,
  p_subject_id uuid,
  p_fund_ids jsonb,
  p_document_ids jsonb,
  p_comment_id uuid,
  p_actor_auth_method text,
  p_actor_subject text,
  p_idempotency_key text,
  p_request_hash text,
  p_body text,
  p_mentioned_user_ids uuid[]
)
returns setof corvis_control.review_item_comment
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control, corvis_consolidated, corvis_source, corvis_serving
as $$
declare
  v_fund_id text;
  v_period text;
  v_author uuid;
  v_comment corvis_control.review_item_comment%rowtype;
  v_thread corvis_control.review_item_thread%rowtype;
  v_mention uuid;
begin
  select * into v_comment from corvis_control.review_item_comment c
  where c.tenant_id = p_tenant_id and c.author_auth_method = p_actor_auth_method
    and c.author_subject = p_actor_subject and c.idempotency_key = p_idempotency_key;
  if found then
    if v_comment.request_hash <> p_request_hash
       or (v_comment.workspace_id, v_comment.subject_kind, v_comment.subject_id) is distinct from (p_workspace_id, p_subject_kind, p_subject_id) then
      raise exception 'idempotency key reused with different review comment';
    end if;
    return next v_comment;
    return;
  end if;

  select s.subject_fund_id, s.subject_report_period into v_fund_id, v_period
  from corvis_control.resolve_review_subject(p_tenant_id, p_subject_kind, p_subject_id, p_fund_ids, p_document_ids) s;
  if v_fund_id is null then
    raise exception 'review item not found';
  end if;
  select s.user_id into v_author from corvis_control.identity_subject s
  where s.tenant_id = p_tenant_id and s.auth_method = p_actor_auth_method and s.subject = p_actor_subject
    and s.status = 'active' and s.auth_method in ('oidc','saml');
  if v_author is null then
    raise exception 'review item actor not found';
  end if;
  foreach v_mention in array coalesce(p_mentioned_user_ids, '{}'::uuid[]) loop
    if not corvis_control.review_member_eligible(p_tenant_id, p_workspace_id, v_mention, v_fund_id) then
      raise exception 'review mention not eligible';
    end if;
  end loop;

  insert into corvis_control.review_item_thread
    (tenant_id, workspace_id, subject_kind, subject_id, fund_id, report_period, version)
  values (p_tenant_id, p_workspace_id, p_subject_kind, p_subject_id, v_fund_id, v_period, 0)
  on conflict on constraint review_item_thread_pkey do nothing;
  select * into v_thread from corvis_control.review_item_thread t
  where t.tenant_id = p_tenant_id and t.workspace_id = p_workspace_id and t.subject_kind = p_subject_kind and t.subject_id = p_subject_id
  for update;
  if v_thread.comment_count >= 200 then
    raise exception 'review comment limit reached';
  end if;

  insert into corvis_control.review_item_comment
    (tenant_id, workspace_id, subject_kind, subject_id, comment_id, author_auth_method, author_subject, author_user_id,
     idempotency_key, request_hash, body, mentioned_user_ids)
  values
    (p_tenant_id, p_workspace_id, p_subject_kind, p_subject_id, p_comment_id, p_actor_auth_method, p_actor_subject, v_author,
     p_idempotency_key, p_request_hash, btrim(p_body), coalesce(p_mentioned_user_ids, '{}'::uuid[]))
  returning * into v_comment;

  update corvis_control.review_item_thread t
  set comment_count = t.comment_count + 1, last_comment_at = v_comment.created_at
  where t.tenant_id = p_tenant_id and t.workspace_id = p_workspace_id and t.subject_kind = p_subject_kind and t.subject_id = p_subject_id;

  return next v_comment;
end;
$$;

commit;
