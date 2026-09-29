-- Index and integrity hardening from the production-readiness review (#239).
-- Depends on migrations 001-066 (066 is owned by a parallel change; the runner
-- requires contiguous versions, so this file can only be applied after it).
--
-- 1. corvis_serving.documents picks each document's latest artifact with
--    DISTINCT ON (tenant_id, document_id) ORDER BY ..., created_at DESC, but
--    document_artifact_version had no index on that key, so the view sorted the
--    whole artifact table per query. The index also supports the
--    (tenant_id, document_id) foreign key.
--    The other unindexed foreign keys reviewed (holding.fund_id and friends,
--    webhook_delivery.event_id, source_reference.document_artifact_version_id,
--    the position-financial and correction tables) are either already served by
--    a tenant-led composite index that the application queries use, or are only
--    ever scanned on a parent delete that nothing in the application performs, so
--    indexing them would add write cost without a reader.
-- 2. export_job_state_check was added NOT VALID in 047. Validate it now, but only
--    when existing rows satisfy it: a violating historical row leaves the
--    constraint NOT VALID with a warning instead of failing the deploy.
-- 3. corvis_identity.entity_lifecycle_participant has no natural primary key
--    (its subject is either a fund or a company, both nullable), so it gets a
--    surrogate key. Every existing row receives its own generated value, so the
--    change cannot conflict with existing data; the table is small global
--    reference data, so the one-time rewrite is acceptable. Application code
--    always inserts with an explicit column list.
--
-- The runner applies each migration in one transaction, so indexes are built
-- without CONCURRENTLY.

begin;

create index if not exists document_artifact_version_document_created_idx
  on corvis_source.document_artifact_version (tenant_id, document_id, created_at desc);

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'corvis_serving.export_job'::regclass
      and conname = 'export_job_state_check'
      and not convalidated
  ) then
    begin
      alter table corvis_serving.export_job validate constraint export_job_state_check;
    exception when check_violation then
      raise warning 'export_job_state_check left NOT VALID: existing export_job rows have an unrecognised state; repair them and validate the constraint manually';
    end;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'corvis_identity.entity_lifecycle_participant'::regclass
      and contype = 'p'
  ) then
    alter table corvis_identity.entity_lifecycle_participant
      add column if not exists participant_id uuid not null default gen_random_uuid();
    alter table corvis_identity.entity_lifecycle_participant
      add constraint entity_lifecycle_participant_pkey primary key (participant_id);
  end if;
end $$;

commit;
