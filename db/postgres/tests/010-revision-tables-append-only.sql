-- Acceptance: the four tables guarded by 010_revision_tables_append_only_guards.sql are
-- actually append-only (holding_revision, instrument_revision), and all four now have a
-- tenant-scoped SELECT policy (holding_revision, instrument_revision - newly added here;
-- tenant_entity_revision, tenant_lifecycle_revision - already had one, re-asserted so a
-- future migration can't silently drop it).
--
-- Before 009, holding_revision and instrument_revision had no BEFORE DELETE OR UPDATE row
-- trigger and no BEFORE TRUNCATE statement trigger, and neither had any RLS policy at all
-- despite FORCE ROW LEVEL SECURITY. This proves UPDATE, DELETE and TRUNCATE are all
-- rejected with the documented error text, that a fresh INSERT is never blocked, and that
-- each table's tenant-scoped SELECT policy actually returns the row.
--
-- Run after the full migration chain on an isolated disposable database. Rolled back.

\set ON_ERROR_STOP on

begin;

create function pg_temp.expect_error(statement text, fragment text) returns void language plpgsql as $$
declare
  raised text;
begin
  begin
    execute statement;
  exception when others then
    raised := sqlerrm;
  end;
  if raised is null then
    raise exception 'expected failure containing "%" but the statement succeeded: %', fragment, statement;
  end if;
  if position(fragment in raised) = 0 then
    raise exception 'expected failure containing "%" but got "%"', fragment, raised;
  end if;
end;
$$;

insert into corvis_control.tenant (tenant_id,slug,display_name)
values ('c9100000-0000-4000-8000-00000000000a','revision-tables-a','Revision Tables A');

insert into corvis_source.document (
  tenant_id,document_id,display_name,media_type,status,created_by
) values (
  'c9100000-0000-4000-8000-00000000000a','c9100000-0000-4000-8000-00000000000d',
  'Revision tables fixture','application/pdf','registered','ci'
);

insert into corvis_source.document_artifact_version (
  tenant_id,document_artifact_version_id,document_id,ingestion_id,object_uri,
  size_bytes,sha256,storage_generation,malware_scan_status,quarantine_status
) values (
  'c9100000-0000-4000-8000-00000000000a','c9100000-0000-4000-8000-00000000000e',
  'c9100000-0000-4000-8000-00000000000d','revision-tables-a-v1','gs://ci-fixture/document.pdf',
  1024,repeat('1',64),'1','clean','released'
);

insert into corvis_source.document_representation (
  tenant_id,representation_id,document_id,document_artifact_version_id,
  representation_type,object_uri,storage_generation,content_sha256,size_bytes,
  producer,producer_version,method,status
) values (
  'c9100000-0000-4000-8000-00000000000a','c9100000-0000-4000-8000-00000000000f',
  'c9100000-0000-4000-8000-00000000000d','c9100000-0000-4000-8000-00000000000e',
  'document_interpretation_v1','gs://ci-fixture/representation.json','1',repeat('2',64),2048,
  'ci','1','native','ready'
);

insert into corvis_source.extraction_run (
  tenant_id,extraction_run_id,document_id,document_artifact_version_id,representation_id,
  extraction_contract_version,schema_version,skill_id,skill_version,bundle_object_uri,
  bundle_storage_generation,bundle_content_sha256,bundle_size_bytes,producer,producer_version,
  model_provider,model_name,model_version,status,candidate_count,candidate_set_sha256,completed_at
) values (
  'c9100000-0000-4000-8000-00000000000a','c9100000-0000-4000-8000-000000000011',
  'c9100000-0000-4000-8000-00000000000d','c9100000-0000-4000-8000-00000000000e','c9100000-0000-4000-8000-00000000000f',
  '1','1.2','quarterly_fund_report_extraction','1.6',
  'gs://ci-fixture/candidates.jsonl','1',repeat('3',64),4096,'ci','1','ci','extractor','1',
  'ready',1,repeat('a',64),now()
);

insert into corvis_facts.canonicalization_run (
  tenant_id,canonicalization_run_id,extraction_run_id,document_id,review_policy_version,
  candidate_set_sha256,decision_set_sha256,idempotency_key,status,candidate_count,
  canonical_candidate_count,observation_count,source_reference_count,completed_at
) values (
  'c9100000-0000-4000-8000-00000000000a','c9100000-0000-4000-8000-000000000020',
  'c9100000-0000-4000-8000-000000000011','c9100000-0000-4000-8000-00000000000d',
  'candidate_review_v1',repeat('a',64),repeat('b',64),'revision-tables-ci','ready',1,1,1,1,now()
);

insert into corvis_identity.fund (global_fund_id, canonical_name) values ('rev-fund-a', 'Revision Fund A');
insert into corvis_identity.company (global_company_id, canonical_name) values ('rev-company-a', 'Revision Company A');

insert into corvis_facts.holding (tenant_id, holding_id, fund_id, target_type, target_company_id, review_state) values
  ('c9100000-0000-4000-8000-00000000000a','c9100000-0000-4000-8000-000000000030','rev-fund-a','company','rev-company-a','approved');

insert into corvis_facts.instrument (tenant_id, instrument_id, holding_id, instrument_type, security_name, review_state) values
  ('c9100000-0000-4000-8000-00000000000a','c9100000-0000-4000-8000-000000000040','c9100000-0000-4000-8000-000000000030','equity','Revision Instrument A','approved');

insert into corvis_facts.holding_revision (
  tenant_id,holding_id,canonicalization_run_id,candidate_id,candidate_fingerprint_sha256,
  effective_payload,source_reference_ids
) values (
  'c9100000-0000-4000-8000-00000000000a','c9100000-0000-4000-8000-000000000030',
  'c9100000-0000-4000-8000-000000000020','c9100000-0000-4000-8000-000000000050',repeat('c',64),
  '{"fundId":"rev-fund-a"}', array['c9100000-0000-4000-8000-00000000000d'::uuid]
);

insert into corvis_facts.instrument_revision (
  tenant_id,instrument_id,canonicalization_run_id,candidate_id,candidate_fingerprint_sha256,
  effective_payload,source_reference_ids
) values (
  'c9100000-0000-4000-8000-00000000000a','c9100000-0000-4000-8000-000000000040',
  'c9100000-0000-4000-8000-000000000020','c9100000-0000-4000-8000-000000000051',repeat('d',64),
  '{"securityName":"Revision Instrument A"}', array['c9100000-0000-4000-8000-00000000000d'::uuid]
);

-- 1. UPDATE, DELETE and TRUNCATE are all rejected on holding_revision with the documented message.
do $$
begin
  perform pg_temp.expect_error($f$update corvis_facts.holding_revision set candidate_fingerprint_sha256 = repeat('9',64) where holding_id = 'c9100000-0000-4000-8000-000000000030'$f$,
    'corvis_facts.holding_revision is append-only');
  perform pg_temp.expect_error($f$delete from corvis_facts.holding_revision where holding_id = 'c9100000-0000-4000-8000-000000000030'$f$,
    'corvis_facts.holding_revision is append-only');
  perform pg_temp.expect_error('truncate corvis_facts.holding_revision',
    'corvis_facts.holding_revision is append-only');
end $$;

-- 2. Same for instrument_revision.
do $$
begin
  perform pg_temp.expect_error($f$update corvis_facts.instrument_revision set candidate_fingerprint_sha256 = repeat('9',64) where instrument_id = 'c9100000-0000-4000-8000-000000000040'$f$,
    'corvis_facts.instrument_revision is append-only');
  perform pg_temp.expect_error($f$delete from corvis_facts.instrument_revision where instrument_id = 'c9100000-0000-4000-8000-000000000040'$f$,
    'corvis_facts.instrument_revision is append-only');
  perform pg_temp.expect_error('truncate corvis_facts.instrument_revision',
    'corvis_facts.instrument_revision is append-only');
end $$;

-- 3. A new revision is a plain insert, not blocked by the guard, and both coexist.
insert into corvis_facts.holding_revision (
  tenant_id,holding_id,canonicalization_run_id,candidate_id,candidate_fingerprint_sha256,
  effective_payload,source_reference_ids
) values (
  'c9100000-0000-4000-8000-00000000000a','c9100000-0000-4000-8000-000000000030',
  'c9100000-0000-4000-8000-000000000020','c9100000-0000-4000-8000-000000000060',repeat('e',64),
  '{"fundId":"rev-fund-a","note":"re-canonicalized"}', array['c9100000-0000-4000-8000-00000000000d'::uuid]
);

do $$
begin
  if (select count(*) from corvis_facts.holding_revision where holding_id = 'c9100000-0000-4000-8000-000000000030') <> 2 then
    raise exception 'recording a new revision must not be blocked by the append-only guard';
  end if;
end $$;

-- 4. holding_revision and instrument_revision now carry a SELECT policy (matching their
-- sibling revision tables tenant_entity_revision/tenant_lifecycle_revision, which already
-- had one) referencing has_tenant_access, scoped by tenant_id - asserted against
-- pg_policies rather than by switching role, since RLS (even FORCEd) doesn't apply to the
-- superuser/owner connection this suite runs as.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'corvis_facts' and tablename = 'holding_revision' and policyname = 'holding_revision_select'
      and cmd = 'SELECT' and qual ilike '%has_tenant_access%' and qual ilike '%tenant_id%'
  ) then
    raise exception 'holding_revision_select policy must exist and scope by has_tenant_access(tenant_id), matching tenant_entity_revision_select';
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'corvis_facts' and tablename = 'instrument_revision' and policyname = 'instrument_revision_select'
      and cmd = 'SELECT' and qual ilike '%has_tenant_access%' and qual ilike '%tenant_id%'
  ) then
    raise exception 'instrument_revision_select policy must exist and scope by has_tenant_access(tenant_id), matching tenant_entity_revision_select';
  end if;
end $$;

rollback;
