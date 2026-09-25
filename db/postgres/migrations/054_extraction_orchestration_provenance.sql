-- Corvis multi-fund / large-document extraction orchestration provenance v1
-- Depends on migrations 001-053.
--
-- These fields are source/execution lineage only. document_segment_id and
-- work_unit_id must never become canonical economic identity or an authorization
-- scope. Canonical fund/company/holding identity remains governed independently.

begin;

alter table corvis_source.extraction_run
  add column if not exists orchestration_policy_version text,
  add column if not exists orchestration_manifest_object_uri text,
  add column if not exists orchestration_manifest_storage_generation text,
  add column if not exists orchestration_manifest_content_sha256 text,
  add column if not exists orchestration_manifest_size_bytes bigint,
  add column if not exists page_count integer,
  add column if not exists covered_page_count integer,
  add column if not exists document_segment_count integer,
  add column if not exists work_unit_count integer,
  add column if not exists unexplained_page_gap_count integer,
  add column if not exists unresolved_material_attribution_count integer;

alter table corvis_source.extraction_candidate_source_reference
  add column if not exists document_segment_id text,
  add column if not exists work_unit_id text,
  add column if not exists fund_context_ids jsonb not null default '[]'::jsonb,
  add column if not exists page_coverage_state text;

alter table corvis_source.extraction_run
  drop constraint if exists extraction_run_orchestration_manifest_size_check,
  drop constraint if exists extraction_run_page_count_check,
  drop constraint if exists extraction_run_covered_page_count_check,
  drop constraint if exists extraction_run_document_segment_count_check,
  drop constraint if exists extraction_run_work_unit_count_check,
  drop constraint if exists extraction_run_unexplained_page_gap_count_check,
  drop constraint if exists extraction_run_unresolved_material_attribution_count_check,
  drop constraint if exists extraction_run_orchestration_manifest_sha256_check,
  drop constraint if exists extraction_run_orchestration_manifest_uri_check,
  drop constraint if exists extraction_run_skill_2_1_orchestration_check;

alter table corvis_source.extraction_run
  add constraint extraction_run_orchestration_manifest_size_check
    check (orchestration_manifest_size_bytes is null or orchestration_manifest_size_bytes >= 0),
  add constraint extraction_run_page_count_check
    check (page_count is null or page_count >= 0),
  add constraint extraction_run_covered_page_count_check
    check (covered_page_count is null or covered_page_count >= 0),
  add constraint extraction_run_document_segment_count_check
    check (document_segment_count is null or document_segment_count > 0),
  add constraint extraction_run_work_unit_count_check
    check (work_unit_count is null or work_unit_count >= 0),
  add constraint extraction_run_unexplained_page_gap_count_check
    check (unexplained_page_gap_count is null or unexplained_page_gap_count >= 0),
  add constraint extraction_run_unresolved_material_attribution_count_check
    check (unresolved_material_attribution_count is null or unresolved_material_attribution_count >= 0),
  add constraint extraction_run_orchestration_manifest_sha256_check
    check (orchestration_manifest_content_sha256 is null or orchestration_manifest_content_sha256 ~ '^[0-9a-f]{64}$'),
  add constraint extraction_run_orchestration_manifest_uri_check
    check (orchestration_manifest_object_uri is null or orchestration_manifest_object_uri like 'gs://%'),
  add constraint extraction_run_skill_2_1_orchestration_check
    check (
      not (
        skill_id='quarterly_fund_report_extraction'
        and skill_version='2.1'
        and schema_version='1.6'
      )
      or (
        orchestration_policy_version is not null
        and orchestration_policy_version='1'
        and orchestration_manifest_object_uri is not null
        and orchestration_manifest_object_uri like 'gs://%'
        and orchestration_manifest_storage_generation is not null
        and nullif(btrim(orchestration_manifest_storage_generation),'') is not null
        and orchestration_manifest_content_sha256 is not null
        and orchestration_manifest_content_sha256 ~ '^[0-9a-f]{64}$'
        and orchestration_manifest_size_bytes is not null
        and orchestration_manifest_size_bytes >= 0
        and page_count is not null
        and page_count >= 0
        and covered_page_count is not null
        and covered_page_count=page_count
        and document_segment_count is not null
        and document_segment_count > 0
        and work_unit_count is not null
        and work_unit_count >= 0
        and unexplained_page_gap_count is not null
        and unexplained_page_gap_count=0
        and unresolved_material_attribution_count is not null
        and unresolved_material_attribution_count=0
      )
    );

alter table corvis_source.extraction_candidate_source_reference
  drop constraint if exists extraction_candidate_source_reference_segment_id_check,
  drop constraint if exists extraction_candidate_source_reference_work_unit_id_check,
  drop constraint if exists extraction_candidate_source_reference_fund_context_ids_check,
  drop constraint if exists extraction_candidate_source_reference_page_coverage_state_check;

alter table corvis_source.extraction_candidate_source_reference
  add constraint extraction_candidate_source_reference_segment_id_check
    check (document_segment_id is null or nullif(btrim(document_segment_id),'') is not null),
  add constraint extraction_candidate_source_reference_work_unit_id_check
    check (work_unit_id is null or nullif(btrim(work_unit_id),'') is not null),
  add constraint extraction_candidate_source_reference_fund_context_ids_check
    check (jsonb_typeof(fund_context_ids)='array'),
  add constraint extraction_candidate_source_reference_page_coverage_state_check
    check (
      page_coverage_state is null
      or page_coverage_state in ('primary','overlap_shared','excluded','exception')
    );

create index if not exists extraction_candidate_reference_segment_idx
  on corvis_source.extraction_candidate_source_reference
    (tenant_id, extraction_run_id, document_segment_id, work_unit_id)
  where document_segment_id is not null;

create index if not exists extraction_run_orchestration_contract_idx
  on corvis_source.extraction_run
    (tenant_id, skill_id, skill_version, schema_version, orchestration_policy_version, created_at desc);

commit;
