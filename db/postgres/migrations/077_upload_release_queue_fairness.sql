-- Fair, indexed ordering for the scheduled upload release (src/lib/server/upload-release.ts).
-- Depends on migrations 001-076.
--
-- The release poll took the 50 oldest quarantined/pending artifacts. A row that stays pending (the
-- scanner has not reported, or processing it throws) sits at the head for the whole 7-day
-- quarantine window and, with enough of them, starves newer clean uploads of the batch limit; one
-- tenant's backlog could do the same to every other tenant. The poll now records when it last
-- attempted an unreleased artifact and orders never-attempted / least-recently-attempted rows first,
-- interleaved per tenant. The partial index covers exactly the rows the poll selects, so the queue
-- scan stays proportional to the pending set rather than to the whole artifact table.
-- release_clean_artifact is unchanged; the column is operational state and grants no access.

begin;

alter table corvis_source.document_artifact_version
  add column if not exists last_release_attempt_at timestamptz;

create index if not exists document_artifact_version_release_queue_idx
  on corvis_source.document_artifact_version (tenant_id, last_release_attempt_at nulls first, created_at)
  where malware_scan_status='pending' and quarantine_status='quarantined' and storage_generation is not null;

commit;
