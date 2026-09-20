-- Corvis governed extraction candidate persistence v1
-- Depends on migrations 001-023.

begin;

create table if not exists corvis_source.extraction_run (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  extraction_run_id uuid not null,
  document_id uuid not null,
  document_artifact_version_id uuid not null,
  representation_id uuid not null,
  extraction_contract_version text not null,
  schema_version text not null,
  skill_id text not null,
  skill_version text not null,
  bundle_object_uri text not null,
  bundle_storage_generation text not null,
  bundle_content_sha256 text not null,
  bundle_size_bytes bigint not null check (bundle_size_bytes >= 0),
  producer text not null,
  producer_version text not null,
  model_provider text not null,
  model_name text not null,
  model_version text not null,
  status text not null check (status in ('writing','ready')),
  candidate_count integer check (candidate_count is null or candidate_count >= 0),
  candidate_set_sha256 text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (tenant_id, extraction_run_id),
  foreign key (tenant_id, document_id)
    references corvis_source.document(tenant_id, document_id),
  foreign key (tenant_id, document_artifact_version_id)
    references corvis_source.document_artifact_version(tenant_id, document_artifact_version_id),
  foreign key (tenant_id, representation_id)
    references corvis_source.document_representation(tenant_id, representation_id),
  unique (tenant_id, representation_id, extraction_contract_version),
  check (bundle_object_uri like 'gs://%'),
  check (bundle_storage_generation <> ''),
  check (bundle_content_sha256 ~ '^[0-9a-f]{64}$'),
  check (candidate_set_sha256 is null or candidate_set_sha256 ~ '^[0-9a-f]{64}$'),
  check ((status='writing' and completed_at is null)
      or (status='ready' and completed_at is not null and candidate_count is not null and candidate_set_sha256 is not null))
);

create table if not exists corvis_source.extraction_candidate (
  tenant_id uuid not null,
  extraction_run_id uuid not null,
  candidate_id uuid not null,
  candidate_key text not null,
  document_id uuid not null,
  representation_id uuid not null,
  candidate_type text not null check (candidate_type in (
    'fund','company','holding','instrument','lifecycle_event','metric_observation','exception'
  )),
  payload jsonb not null,
  confidence jsonb not null,
  provenance jsonb not null,
  exception_codes jsonb not null default '[]'::jsonb,
  review_status text not null default 'candidate' check (review_status='candidate'),
  source_reference_count integer not null check (source_reference_count > 0),
  created_at timestamptz not null default now(),
  primary key (tenant_id, extraction_run_id, candidate_id),
  foreign key (tenant_id, extraction_run_id)
    references corvis_source.extraction_run(tenant_id, extraction_run_id),
  foreign key (tenant_id, document_id)
    references corvis_source.document(tenant_id, document_id),
  foreign key (tenant_id, representation_id)
    references corvis_source.document_representation(tenant_id, representation_id),
  unique (tenant_id, extraction_run_id, candidate_key),
  check (btrim(candidate_key) <> ''),
  check (jsonb_typeof(payload)='object'),
  check (jsonb_typeof(confidence)='object'),
  check (jsonb_typeof(provenance)='object'),
  check (jsonb_typeof(exception_codes)='array')
);

create table if not exists corvis_source.extraction_candidate_source_reference (
  tenant_id uuid not null,
  extraction_run_id uuid not null,
  candidate_id uuid not null,
  source_reference_id uuid not null,
  reference_key text not null,
  document_id uuid not null,
  representation_id uuid not null,
  page_number integer check (page_number is null or page_number > 0),
  sheet_name text,
  section_title text,
  table_title text,
  row_label text,
  column_label text,
  cell_or_range text,
  footnote_marker text,
  source_text text,
  extraction_method text not null check (extraction_method in (
    'native_text','table_parser','ocr','vision','spreadsheet_parser'
  )),
  bounding_box jsonb,
  created_at timestamptz not null default now(),
  primary key (tenant_id, extraction_run_id, source_reference_id),
  foreign key (tenant_id, extraction_run_id, candidate_id)
    references corvis_source.extraction_candidate(tenant_id, extraction_run_id, candidate_id),
  foreign key (tenant_id, document_id)
    references corvis_source.document(tenant_id, document_id),
  foreign key (tenant_id, representation_id)
    references corvis_source.document_representation(tenant_id, representation_id),
  unique (tenant_id, extraction_run_id, candidate_id, reference_key),
  check (btrim(reference_key) <> ''),
  check (page_number is not null or nullif(btrim(coalesce(sheet_name,'')), '') is not null),
  check (bounding_box is null or jsonb_typeof(bounding_box)='object')
);

alter table corvis_source.extraction_run enable row level security;
alter table corvis_source.extraction_run force row level security;
alter table corvis_source.extraction_candidate enable row level security;
alter table corvis_source.extraction_candidate force row level security;
alter table corvis_source.extraction_candidate_source_reference enable row level security;
alter table corvis_source.extraction_candidate_source_reference force row level security;

-- Extraction scratch/candidate state is server/worker managed and is not a customer
-- serving contract. No direct client policies are intentionally created here.
create index if not exists extraction_run_document_idx
  on corvis_source.extraction_run (tenant_id, document_id, representation_id, created_at desc);
create index if not exists extraction_candidate_document_idx
  on corvis_source.extraction_candidate (tenant_id, document_id, extraction_run_id, candidate_type);
create index if not exists extraction_candidate_reference_candidate_idx
  on corvis_source.extraction_candidate_source_reference
    (tenant_id, extraction_run_id, candidate_id, created_at);

commit;
