-- corvis_control.control_evidence (the automated runtime-snapshot evidence table written by
-- listControlEvidence's insert in src/modules/governance/server/operations/operations.ts) had no
-- append-only guard at all, unlike its adjacent sibling corvis_control.control_evidence_record,
-- which already has both a BEFORE DELETE OR UPDATE row trigger and a BEFORE TRUNCATE statement
-- trigger (corvis_control.reject_control_evidence_mutation(), migrations 001 and 003). The runtime
-- role's own GRANT on control_evidence is already insert/select only
-- (002_runtime_database_role.sql), the same "second line of defence" its sibling documents, but the
-- "first line" (the trigger, which also protects the table owner/migration role and rejects
-- TRUNCATE, which row-level triggers never catch) was missing. control_evidence is never UPDATEd or
-- DELETEd anywhere in this repository's migrations or application code (confirmed by grep).
--
-- Also adds the (tenant_id, generated_at) index its only read path needs: listControlEvidence's
-- `where tenant_id=$1 order by generated_at desc limit 500`, matching the equivalent index already
-- present on its shape-sibling corvis_control.audit_event.

begin;

CREATE FUNCTION corvis_control.reject_control_evidence_row_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception 'corvis_control.control_evidence is append-only';
end;
$$;

CREATE TRIGGER control_evidence_append_only BEFORE DELETE OR UPDATE ON corvis_control.control_evidence
  FOR EACH ROW EXECUTE FUNCTION corvis_control.reject_control_evidence_row_mutation();

CREATE TRIGGER control_evidence_no_truncate BEFORE TRUNCATE ON corvis_control.control_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION corvis_control.reject_control_evidence_row_mutation();

CREATE INDEX control_evidence_tenant_time_idx ON corvis_control.control_evidence USING btree (tenant_id, generated_at DESC);

commit;
