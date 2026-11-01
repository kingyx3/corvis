-- Four canonicalization-revision tables had gaps vs. their already-guarded siblings
-- (tenant_entity_revision's own sibling tables, and the pattern migrations 005/007/008
-- established for other write-once ledgers):
--
--   corvis_facts.holding_revision       - no append-only guard trigger at all
--   corvis_facts.instrument_revision    - no append-only guard trigger at all
--   corvis_identity.tenant_entity_revision    - has a tenant-scoped SELECT policy already
--   corvis_identity.tenant_lifecycle_revision - has a tenant-scoped SELECT policy already
--
-- All four are immutable point-in-time snapshots keyed by
-- (canonicalization_run_id, candidate_id) and are never UPDATEd or DELETEd anywhere in
-- this repository's migrations or application code (confirmed by grep); corvis_runtime
-- already holds insert/select-only grants on them (002_runtime_database_role.sql). That
-- grant is the "second line of defence" these tables' siblings already document; the
-- "first line" (the trigger, which also protects the table owner/migration role and
-- rejects TRUNCATE, which row-level triggers never catch) was missing on holding_revision
-- and instrument_revision.
--
-- Separately, holding_revision and instrument_revision have RLS FORCEd with no policy at
-- all, unlike tenant_entity_revision and tenant_lifecycle_revision which each have a
-- tenant-scoped SELECT policy. Currently inert (the only reader is the runtime role via
-- the service-context policy), but inconsistent with the pattern their own sibling
-- revision tables establish: add the matching SELECT policy so a future end-user-context
-- read path is scoped by design rather than silently fail-closed.

begin;

CREATE FUNCTION corvis_facts.reject_holding_revision_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception 'corvis_facts.holding_revision is append-only';
end;
$$;

CREATE TRIGGER holding_revision_append_only BEFORE DELETE OR UPDATE ON corvis_facts.holding_revision
  FOR EACH ROW EXECUTE FUNCTION corvis_facts.reject_holding_revision_mutation();

CREATE TRIGGER holding_revision_no_truncate BEFORE TRUNCATE ON corvis_facts.holding_revision
  FOR EACH STATEMENT EXECUTE FUNCTION corvis_facts.reject_holding_revision_mutation();

CREATE FUNCTION corvis_facts.reject_instrument_revision_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception 'corvis_facts.instrument_revision is append-only';
end;
$$;

CREATE TRIGGER instrument_revision_append_only BEFORE DELETE OR UPDATE ON corvis_facts.instrument_revision
  FOR EACH ROW EXECUTE FUNCTION corvis_facts.reject_instrument_revision_mutation();

CREATE TRIGGER instrument_revision_no_truncate BEFORE TRUNCATE ON corvis_facts.instrument_revision
  FOR EACH STATEMENT EXECUTE FUNCTION corvis_facts.reject_instrument_revision_mutation();

CREATE POLICY holding_revision_select ON corvis_facts.holding_revision FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));

CREATE POLICY instrument_revision_select ON corvis_facts.instrument_revision FOR SELECT USING (corvis_control.has_tenant_access(tenant_id));

commit;
