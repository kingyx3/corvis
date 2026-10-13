-- corvis_review.candidate_review_event (the GP-review decision ledger: decision,
-- reason_code, event_sequence, correction_payload) is the only event-sourced ledger in
-- this schema with no append-only guard. Every sibling table (audit_event,
-- data_issue_case_event, export_schedule_run, review_item_comment,
-- tenant_export_request_event, control_evidence_record) has both a BEFORE DELETE OR
-- UPDATE row trigger and a BEFORE TRUNCATE statement trigger rejecting mutation. Its
-- only protection today is the corvis_runtime role's GRANT list (select, insert only,
-- 002_runtime_database_role.sql) — the "second line of defence" that migration's own
-- comment describes; the "first line" (the trigger) was missing here, unlike every
-- sibling ledger, so a table-owner connection or a future migration that (even
-- accidentally) grants UPDATE/DELETE to a broader role could silently edit or erase
-- review-decision history with no database-level objection.

begin;

CREATE FUNCTION corvis_review.reject_candidate_review_event_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception 'corvis_review.candidate_review_event is append-only';
end;
$$;

CREATE TRIGGER candidate_review_event_append_only BEFORE DELETE OR UPDATE ON corvis_review.candidate_review_event
  FOR EACH ROW EXECUTE FUNCTION corvis_review.reject_candidate_review_event_mutation();

CREATE TRIGGER candidate_review_event_no_truncate BEFORE TRUNCATE ON corvis_review.candidate_review_event
  FOR EACH STATEMENT EXECUTE FUNCTION corvis_review.reject_candidate_review_event_mutation();

commit;
