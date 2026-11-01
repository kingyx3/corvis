-- Two write-once ledgers had no append-only guard at all:
--
--   corvis_identity.entity_lifecycle_event
--   corvis_facts.observation_correction
--
-- Neither is ever UPDATEd or DELETEd anywhere in this repository's migrations or
-- application code (confirmed by grep): entity_lifecycle_event is only ever written
-- via an INSERT ... ON CONFLICT (lifecycle_event_id) DO NOTHING followed by an
-- explicit re-read that raises if the row differs (001_baseline.sql, the reviewed
-- lifecycle candidate canonicalization path) - application code already assumes this
-- table is immutable once a lifecycle_event_id exists. observation_correction is a
-- pure correction ledger read via "latest correction wins" (observation_correction_latest_idx
-- ordered by created_at desc), the same insert-only-ledger shape already guarded on
-- control_evidence (008_control_evidence_append_only.sql). Both tables' corvis_runtime
-- GRANTs are already insert/select only (002_runtime_database_role.sql) - the "second
-- line of defence" their sibling ledgers already document - but the "first line" (the
-- trigger, which also protects the table owner/migration role and rejects TRUNCATE,
-- which row-level triggers never catch) was missing on these two.
--
-- entity_lifecycle_event has no tenant_id (it is a shared/governed identity table, not
-- RLS-scoped), unlike observation_correction.

begin;

CREATE FUNCTION corvis_identity.reject_entity_lifecycle_event_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception 'corvis_identity.entity_lifecycle_event is append-only';
end;
$$;

CREATE TRIGGER entity_lifecycle_event_append_only BEFORE DELETE OR UPDATE ON corvis_identity.entity_lifecycle_event
  FOR EACH ROW EXECUTE FUNCTION corvis_identity.reject_entity_lifecycle_event_mutation();

CREATE TRIGGER entity_lifecycle_event_no_truncate BEFORE TRUNCATE ON corvis_identity.entity_lifecycle_event
  FOR EACH STATEMENT EXECUTE FUNCTION corvis_identity.reject_entity_lifecycle_event_mutation();

CREATE FUNCTION corvis_facts.reject_observation_correction_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception 'corvis_facts.observation_correction is append-only';
end;
$$;

CREATE TRIGGER observation_correction_append_only BEFORE DELETE OR UPDATE ON corvis_facts.observation_correction
  FOR EACH ROW EXECUTE FUNCTION corvis_facts.reject_observation_correction_mutation();

CREATE TRIGGER observation_correction_no_truncate BEFORE TRUNCATE ON corvis_facts.observation_correction
  FOR EACH STATEMENT EXECUTE FUNCTION corvis_facts.reject_observation_correction_mutation();

commit;
