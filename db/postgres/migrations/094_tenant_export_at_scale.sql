-- F10b (#322) and F10c (#323): the full tenant export at scale.
-- Depends on migrations 001-092 (084 for the export tables, the build queue and tenant_export_rights, 089 for the
-- follow-ups this extends).
--
-- A build is no longer one buffered pass. The archive streams to the object store, carries the source document files, and
-- writes data files in parts, so a build can run for much longer than the lease it was claimed with and a person waiting
-- for it needs to see how far it is. Two additions:
--
--   * build_progress (jsonb): what the worker last reported about the running attempt, a size estimate taken when the build
--     started and what has been written since. The application shows it on the request while it is building. It is a
--     display value only (no rule reads it) and is replaced wholesale by each report.
--   * record_tenant_export_build_progress: stores that report AND extends the build lease, in one statement bound to the
--     claiming attempt. Reporting is the heartbeat: a worker that is still writing keeps its lease, so a long build is not
--     reclaimed from under it, while a worker that stopped reporting loses the lease after the same ten minutes as before
--     and the reclaim and retry behaviour of claim_next_tenant_export_build is unchanged. It returns false when the attempt
--     no longer owns the request (its lease was reclaimed, or the build finished), and the worker stops.
--   * tenant_export_scope_changed: whether the funds, documents and source document files an archive holds are still all
--     redistributable (and, for a source file, still released for source access). The check that blocks a download link and
--     a redemption after contractual rights change, moved into SQL so the list of what the archive holds (which grows with
--     the number of documents) never has to travel to the application. The scope lives in manifest.artifact, written by
--     complete_tenant_export_build as before; archives built before this migration have no sourceDocumentIds and are
--     checked on funds and documents alone, exactly as they were.
--
-- Forward-only; RLS is unchanged (enabled and forced, no client policy: both functions are security invoker).

begin;

alter table corvis_control.tenant_export_request add column if not exists build_progress jsonb;
alter table corvis_control.tenant_export_request drop constraint if exists tenant_export_request_build_progress_check;
alter table corvis_control.tenant_export_request add constraint tenant_export_request_build_progress_check
  check (build_progress is null or jsonb_typeof(build_progress) = 'object');

create or replace function corvis_control.record_tenant_export_build_progress(
  p_tenant_id uuid,
  p_request_id uuid,
  p_attempt integer,
  p_progress jsonb,
  p_lease_minutes integer
)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control
as $$
declare
  v_updated integer;
begin
  update corvis_control.tenant_export_request r
  set build_progress = p_progress,
      build_lease_expires_at = greatest(coalesce(r.build_lease_expires_at, now()), now() + make_interval(mins => greatest(1, p_lease_minutes)))
  where r.tenant_id = p_tenant_id and r.request_id = p_request_id
    and r.state = 'building' and r.build_attempts = p_attempt;
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

create or replace function corvis_control.tenant_export_scope_changed(p_tenant_id uuid, p_request_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, corvis_control
as $$
  with scope as (
    select coalesce(r.manifest -> 'artifact', '{}'::jsonb) as artifact
    from corvis_control.tenant_export_request r
    where r.tenant_id = p_tenant_id and r.request_id = p_request_id
  ), held as (
    select h.resource_type, h.resource_id, h.source_document_access_allowed
    from corvis_control.tenant_export_rights(p_tenant_id) h
  ), listed as (
    select 'fund'::text as resource_type, f.id, false as needs_source_access
    from scope s, jsonb_array_elements_text(case when jsonb_typeof(s.artifact -> 'fundIds') = 'array' then s.artifact -> 'fundIds' else '[]'::jsonb end) as f(id)
    union all
    select 'document', d.id, false
    from scope s, jsonb_array_elements_text(case when jsonb_typeof(s.artifact -> 'documentIds') = 'array' then s.artifact -> 'documentIds' else '[]'::jsonb end) as d(id)
    union all
    select 'document', d.id, true
    from scope s, jsonb_array_elements_text(case when jsonb_typeof(s.artifact -> 'sourceDocumentIds') = 'array' then s.artifact -> 'sourceDocumentIds' else '[]'::jsonb end) as d(id)
  )
  select exists (
    select 1 from listed l
    where not exists (
      select 1 from held h
      where h.resource_type = l.resource_type and h.resource_id = l.id
        and (not l.needs_source_access or h.source_document_access_allowed is true)
    )
  )
$$;

commit;
