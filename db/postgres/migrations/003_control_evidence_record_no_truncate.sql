-- corvis_control.control_evidence_record had an append-only trigger for UPDATE/DELETE
-- (control_evidence_record_append_only, 001_baseline.sql) but, unlike every sibling append-only
-- audit/evidence table (audit_event, data_issue_case_event, export_schedule, export_schedule_run,
-- review_item_comment, review_item_thread, tenant_export_request_event), it had no BEFORE TRUNCATE
-- statement trigger. Row-level triggers never fire for TRUNCATE, so this compliance evidence ledger
-- could be wiped in one statement despite being append-only everywhere else. The existing trigger
-- function corvis_control.reject_control_evidence_mutation() already raises unconditionally and
-- needs no change; it is reused here for a FOR EACH STATEMENT trigger, exactly as
-- review_item_comment_no_truncate reuses reject_review_item_comment_mutation().

begin;

CREATE TRIGGER control_evidence_record_no_truncate BEFORE TRUNCATE ON corvis_control.control_evidence_record
  FOR EACH STATEMENT EXECUTE FUNCTION corvis_control.reject_control_evidence_mutation();

commit;
