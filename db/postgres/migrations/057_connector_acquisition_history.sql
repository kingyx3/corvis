-- Retain every connector acquisition outcome for run-level auditability.
-- The original v1 uniqueness constraint intentionally deduplicated ingestion,
-- but it also prevented recording later duplicate discoveries. Ingestion stays
-- idempotent through acquisitionKey checks; this index only prevents the same
-- outcome from being recorded twice inside one run.

begin;

alter table corvis_source.acquired_document
  drop constraint if exists acquired_document_tenant_id_source_connection_id_acquisition_key_key;

drop index if exists corvis_source.acquired_document_run_outcome_unique_idx;
create unique index acquired_document_run_outcome_unique_idx
  on corvis_source.acquired_document
    (tenant_id, source_connection_id, run_id, acquisition_key, disposition);

commit;
