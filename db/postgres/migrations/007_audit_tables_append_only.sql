-- Six write-once audit/ledger tables had no append-only guard at all: unlike their
-- siblings (audit_event, data_issue_case_event, export_schedule_run,
-- review_item_comment, tenant_export_request_event, control_evidence_record,
-- candidate_review_event), none of these had either a BEFORE DELETE OR UPDATE row
-- trigger or a BEFORE TRUNCATE statement trigger rejecting mutation. None of them are
-- ever UPDATEd or DELETEd anywhere in this repository's migrations or application code
-- (confirmed by grep), and corvis_runtime's own GRANTs on them are already
-- insert/select only (002_runtime_database_role.sql) - but that GRANT list is the
-- "second line of defence" these tables' own sibling tables already documented; the
-- "first line" (the trigger, which also protects the table owner/migration role and
-- rejects TRUNCATE, which row-level triggers never catch) was missing on these six:
--   corvis_control.identity_lifecycle_event
--   corvis_control.processing_recovery_event
--   corvis_control.deletion_execution_evidence
--   corvis_consolidated.reconciliation_resolution_event
--   corvis_consolidated.snapshot_publication_event
--   corvis_facts.review_event
-- semantic_query_log was considered and correctly excluded: research.ts legitimately
-- UPDATEs it to backfill result_rows_sha256/completed_at, so it is not append-only.

begin;

CREATE FUNCTION corvis_control.reject_identity_lifecycle_event_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception 'corvis_control.identity_lifecycle_event is append-only';
end;
$$;

CREATE TRIGGER identity_lifecycle_event_append_only BEFORE DELETE OR UPDATE ON corvis_control.identity_lifecycle_event
  FOR EACH ROW EXECUTE FUNCTION corvis_control.reject_identity_lifecycle_event_mutation();

CREATE TRIGGER identity_lifecycle_event_no_truncate BEFORE TRUNCATE ON corvis_control.identity_lifecycle_event
  FOR EACH STATEMENT EXECUTE FUNCTION corvis_control.reject_identity_lifecycle_event_mutation();

CREATE FUNCTION corvis_control.reject_processing_recovery_event_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception 'corvis_control.processing_recovery_event is append-only';
end;
$$;

CREATE TRIGGER processing_recovery_event_append_only BEFORE DELETE OR UPDATE ON corvis_control.processing_recovery_event
  FOR EACH ROW EXECUTE FUNCTION corvis_control.reject_processing_recovery_event_mutation();

CREATE TRIGGER processing_recovery_event_no_truncate BEFORE TRUNCATE ON corvis_control.processing_recovery_event
  FOR EACH STATEMENT EXECUTE FUNCTION corvis_control.reject_processing_recovery_event_mutation();

CREATE FUNCTION corvis_control.reject_deletion_execution_evidence_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception 'corvis_control.deletion_execution_evidence is append-only';
end;
$$;

CREATE TRIGGER deletion_execution_evidence_append_only BEFORE DELETE OR UPDATE ON corvis_control.deletion_execution_evidence
  FOR EACH ROW EXECUTE FUNCTION corvis_control.reject_deletion_execution_evidence_mutation();

CREATE TRIGGER deletion_execution_evidence_no_truncate BEFORE TRUNCATE ON corvis_control.deletion_execution_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION corvis_control.reject_deletion_execution_evidence_mutation();

CREATE FUNCTION corvis_consolidated.reject_reconciliation_resolution_event_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception 'corvis_consolidated.reconciliation_resolution_event is append-only';
end;
$$;

CREATE TRIGGER reconciliation_resolution_event_append_only BEFORE DELETE OR UPDATE ON corvis_consolidated.reconciliation_resolution_event
  FOR EACH ROW EXECUTE FUNCTION corvis_consolidated.reject_reconciliation_resolution_event_mutation();

CREATE TRIGGER reconciliation_resolution_event_no_truncate BEFORE TRUNCATE ON corvis_consolidated.reconciliation_resolution_event
  FOR EACH STATEMENT EXECUTE FUNCTION corvis_consolidated.reject_reconciliation_resolution_event_mutation();

CREATE FUNCTION corvis_consolidated.reject_snapshot_publication_event_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception 'corvis_consolidated.snapshot_publication_event is append-only';
end;
$$;

CREATE TRIGGER snapshot_publication_event_append_only BEFORE DELETE OR UPDATE ON corvis_consolidated.snapshot_publication_event
  FOR EACH ROW EXECUTE FUNCTION corvis_consolidated.reject_snapshot_publication_event_mutation();

CREATE TRIGGER snapshot_publication_event_no_truncate BEFORE TRUNCATE ON corvis_consolidated.snapshot_publication_event
  FOR EACH STATEMENT EXECUTE FUNCTION corvis_consolidated.reject_snapshot_publication_event_mutation();

CREATE FUNCTION corvis_facts.reject_review_event_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception 'corvis_facts.review_event is append-only';
end;
$$;

CREATE TRIGGER review_event_append_only BEFORE DELETE OR UPDATE ON corvis_facts.review_event
  FOR EACH ROW EXECUTE FUNCTION corvis_facts.reject_review_event_mutation();

CREATE TRIGGER review_event_no_truncate BEFORE TRUNCATE ON corvis_facts.review_event
  FOR EACH STATEMENT EXECUTE FUNCTION corvis_facts.reject_review_event_mutation();

commit;
