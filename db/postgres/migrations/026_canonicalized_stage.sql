-- Corvis governed reviewed-candidate canonicalization v1
-- Depends on migrations 001-025.

begin;

-- Canonicalization keeps the extraction/review ledger immutable and records the
-- exact reviewed hashes that authorized each canonical row. Non-metric reviewed
-- candidates are retained in the canonical candidate ledger; metric observations
-- additionally materialize into the canonical facts/source-reference model.
create table if not exists corvis_facts.canonicalization_run (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  canonicalization_run_id uuid not null,
  extraction_run_id uuid not null,
  document_id uuid not null,
  review_policy_version text not null,
  candidate_set_sha256 text not null,
  decision_set_sha256 text not null,
  idempotency_key text not null,
  status text not null check (status in ('writing','ready')),
  candidate_count integer not null check (candidate_count >= 0),
  canonical_candidate_count integer check (canonical_candidate_count is null or canonical_candidate_count >= 0),
  observation_count integer check (observation_count is null or observation_count >= 0),
  source_reference_count integer check (source_reference_count is null or source_reference_count >= 0),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (tenant_id, canonicalization_run_id),
  foreign key (tenant_id, extraction_run_id)
    references corvis_source.extraction_run(tenant_id, extraction_run_id),
  foreign key (tenant_id, document_id)
    references corvis_source.document(tenant_id, document_id),
  unique (tenant_id, extraction_run_id, review_policy_version, candidate_set_sha256, decision_set_sha256),
  check (candidate_set_sha256 ~ '^[0-9a-f]{64}$'),
  check (decision_set_sha256 ~ '^[0-9a-f]{64}$'),
  check (btrim(idempotency_key) <> ''),
  check ((status='writing' and completed_at is null)
      or (status='ready' and completed_at is not null
          and canonical_candidate_count is not null
          and observation_count is not null
          and source_reference_count is not null))
);

create table if not exists corvis_facts.canonical_candidate (
  tenant_id uuid not null,
  canonicalization_run_id uuid not null,
  extraction_run_id uuid not null,
  candidate_id uuid not null,
  candidate_key text not null,
  candidate_type text not null,
  review_policy_version text not null,
  candidate_fingerprint_sha256 text not null,
  candidate_set_sha256 text not null,
  decision_set_sha256 text not null,
  original_payload jsonb not null,
  effective_payload jsonb not null,
  confidence jsonb not null,
  provenance jsonb not null,
  exception_codes jsonb not null,
  correction_review_event_id uuid,
  source_reference_ids uuid[] not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, canonicalization_run_id, candidate_id),
  foreign key (tenant_id, canonicalization_run_id)
    references corvis_facts.canonicalization_run(tenant_id, canonicalization_run_id),
  foreign key (tenant_id, extraction_run_id, candidate_id)
    references corvis_source.extraction_candidate(tenant_id, extraction_run_id, candidate_id),
  check (candidate_fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
  check (candidate_set_sha256 ~ '^[0-9a-f]{64}$'),
  check (decision_set_sha256 ~ '^[0-9a-f]{64}$'),
  check (jsonb_typeof(original_payload)='object'),
  check (jsonb_typeof(effective_payload)='object'),
  check (jsonb_typeof(confidence)='object'),
  check (jsonb_typeof(provenance)='object'),
  check (jsonb_typeof(exception_codes)='array'),
  check (cardinality(source_reference_ids) > 0)
);

alter table corvis_facts.canonicalization_run enable row level security;
alter table corvis_facts.canonicalization_run force row level security;
alter table corvis_facts.canonical_candidate enable row level security;
alter table corvis_facts.canonical_candidate force row level security;

-- Canonicalization metadata is server/worker managed. No direct client policies are
-- intentionally created; customer access continues through governed serving models.
create index if not exists canonicalization_run_document_idx
  on corvis_facts.canonicalization_run (tenant_id, document_id, completed_at desc);
create index if not exists canonical_candidate_run_type_idx
  on corvis_facts.canonical_candidate (tenant_id, canonicalization_run_id, candidate_type, candidate_key);

-- Preserve the richer extraction evidence locator and exact upstream lineage on the
-- existing canonical source-reference record. Columns are nullable for historical rows.
alter table corvis_source.source_reference
  add column if not exists extraction_run_id uuid,
  add column if not exists candidate_id uuid,
  add column if not exists representation_id uuid,
  add column if not exists reference_key text,
  add column if not exists section_title text,
  add column if not exists table_title text,
  add column if not exists row_label text,
  add column if not exists column_label text,
  add column if not exists footnote_marker text,
  add column if not exists extraction_method text;

create unique index if not exists source_reference_extraction_lineage_uniq
  on corvis_source.source_reference (tenant_id, extraction_run_id, candidate_id, reference_key)
  where extraction_run_id is not null and candidate_id is not null and reference_key is not null;

-- Preserve canonical semantic dimensions and the exact reviewed authorization hashes
-- directly on immutable source observations. Existing rows remain valid and nullable.
alter table corvis_facts.observation
  add column if not exists canonicalization_run_id uuid,
  add column if not exists candidate_id uuid,
  add column if not exists candidate_key text,
  add column if not exists candidate_fingerprint_sha256 text,
  add column if not exists candidate_set_sha256 text,
  add column if not exists decision_set_sha256 text,
  add column if not exists review_policy_version text,
  add column if not exists subject_type text,
  add column if not exists subject_level text,
  add column if not exists value_raw text,
  add column if not exists value_qualifier text,
  add column if not exists unit text,
  add column if not exists reported_multiplier text,
  add column if not exists source_precision text,
  add column if not exists period_type text,
  add column if not exists period_start date,
  add column if not exists period_end date,
  add column if not exists as_of_date date,
  add column if not exists scenario_type text,
  add column if not exists is_adjusted boolean,
  add column if not exists adjustment_note text,
  add column if not exists valuation_method text,
  add column if not exists breakdown_category text,
  add column if not exists breakdown_value text,
  add column if not exists lookthrough_source text,
  add column if not exists is_derived boolean,
  add column if not exists derivation_formula text,
  add column if not exists is_restated boolean,
  add column if not exists recorded_at timestamptz not null default now();

create unique index if not exists observation_extraction_candidate_uniq
  on corvis_facts.observation (tenant_id, extraction_run_id, candidate_id)
  where extraction_run_id is not null and candidate_id is not null;

create table if not exists corvis_facts.observation_source_reference (
  tenant_id uuid not null,
  observation_id uuid not null,
  source_reference_id uuid not null,
  ordinal integer not null check (ordinal > 0),
  created_at timestamptz not null default now(),
  primary key (tenant_id, observation_id, source_reference_id),
  foreign key (tenant_id, observation_id)
    references corvis_facts.observation(tenant_id, observation_id),
  foreign key (tenant_id, source_reference_id)
    references corvis_source.source_reference(tenant_id, source_reference_id)
);

alter table corvis_facts.observation_source_reference enable row level security;
alter table corvis_facts.observation_source_reference force row level security;
create index if not exists observation_source_reference_source_idx
  on corvis_facts.observation_source_reference (tenant_id, source_reference_id, observation_id);

create or replace function corvis_facts.canonicalize_reviewed_extraction(
  p_tenant_id uuid,
  p_document_id uuid,
  p_extraction_run_id uuid,
  p_review_policy_version text,
  p_candidate_set_sha256 text,
  p_decision_set_sha256 text,
  p_idempotency_key text
)
returns table(
  canonicalization_run_id uuid,
  candidate_count integer,
  canonical_candidate_count integer,
  observation_count integer,
  source_reference_count integer
)
language plpgsql
security invoker
set search_path = pg_catalog, corvis_facts, corvis_source, corvis_review, corvis_semantic, corvis_identity, corvis_control
as $$
declare
  run_row corvis_source.extraction_run%rowtype;
  gate_row corvis_review.extraction_review_gate%rowtype;
  canonical_run_id uuid;
  existing_run corvis_facts.canonicalization_run%rowtype;
  candidate_row record;
  requirement_row corvis_review.candidate_review_requirement%rowtype;
  correction_event_id uuid;
  correction_payload jsonb;
  effective_payload jsonb;
  reference_ids uuid[];
  primary_reference_id uuid;
  expected_reference_count integer;
  actual_reference_count integer;
  actual_candidate_count integer;
  actual_observation_count integer;
  fund_id_value text;
  company_id_value text;
  holding_id_value text;
  instrument_id_value text;
  metric_code_value text;
  subject_type_value text;
  subject_level_value text;
  value_number_text text;
  value_string_value text;
  confidence_value double precision;
  observation_id_value uuid;
  holding_uuid uuid;
  instrument_uuid uuid;
  period_start_value date;
  period_end_value date;
  as_of_date_value date;
  report_date_value date;
begin
  if p_review_policy_version is null or btrim(p_review_policy_version)='' then
    raise exception 'canonicalization requires review policy version';
  end if;
  if p_candidate_set_sha256 !~ '^[0-9a-f]{64}$' or p_decision_set_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'canonicalization requires valid reviewed hashes';
  end if;
  if p_idempotency_key is null or btrim(p_idempotency_key)='' then
    raise exception 'canonicalization requires idempotency key';
  end if;

  select * into run_row
  from corvis_source.extraction_run
  where tenant_id=p_tenant_id
    and extraction_run_id=p_extraction_run_id
    and document_id=p_document_id
    and status='ready'
  for share;
  if not found then raise exception 'canonicalization requires finalized extraction run'; end if;
  if run_row.candidate_set_sha256 <> p_candidate_set_sha256 then
    raise exception 'canonicalization extraction candidate set no longer matches reviewed result';
  end if;

  select * into gate_row
  from corvis_review.extraction_review_gate
  where tenant_id=p_tenant_id
    and extraction_run_id=p_extraction_run_id
    and review_policy_version=p_review_policy_version
    and status='ready'
    and blocking_candidate_count=0
    and candidate_set_sha256=p_candidate_set_sha256
    and decision_set_sha256=p_decision_set_sha256
  for share;
  if not found then raise exception 'canonicalization requires exact ready review gate'; end if;
  if gate_row.candidate_count <> run_row.candidate_count then
    raise exception 'canonicalization review gate candidate count mismatch';
  end if;

  -- Require the exact predecessor reviewed effect to be durably complete. This
  -- prevents direct invocation from bypassing the reviewed processing boundary.
  if not exists (
    select 1
    from corvis_control.processing_job j
    join corvis_control.processing_stage_effect e
      on e.tenant_id=j.tenant_id and e.job_id=j.job_id
    where j.tenant_id=p_tenant_id
      and j.job_id='reviewed:' || p_document_id::text
      and j.document_id=p_document_id
      and j.stage='reviewed'
      and j.state='succeeded'
      and e.stage='reviewed'
      and e.state='complete'
      and e.result ->> 'extractionRunId'=p_extraction_run_id::text
      and e.result ->> 'reviewPolicyVersion'=p_review_policy_version
      and e.result ->> 'candidateSetSha256'=p_candidate_set_sha256
      and e.result ->> 'decisionSetSha256'=p_decision_set_sha256
      and e.result ->> 'canonicalizationReady'='true'
  ) then
    raise exception 'canonicalization requires committed reviewed-stage predecessor effect';
  end if;

  canonical_run_id := md5(
    p_tenant_id::text || ':' || p_extraction_run_id::text || ':' || p_review_policy_version || ':' ||
    p_candidate_set_sha256 || ':' || p_decision_set_sha256
  )::uuid;

  insert into corvis_facts.canonicalization_run (
    tenant_id,canonicalization_run_id,extraction_run_id,document_id,review_policy_version,
    candidate_set_sha256,decision_set_sha256,idempotency_key,status,candidate_count
  ) values (
    p_tenant_id,canonical_run_id,p_extraction_run_id,p_document_id,p_review_policy_version,
    p_candidate_set_sha256,p_decision_set_sha256,p_idempotency_key,'writing',run_row.candidate_count
  ) on conflict (tenant_id,canonicalization_run_id) do nothing;

  select * into existing_run
  from corvis_facts.canonicalization_run
  where tenant_id=p_tenant_id and canonicalization_run_id=canonical_run_id
  for update;
  if not found then raise exception 'canonicalization run could not be persisted'; end if;
  if existing_run.extraction_run_id <> p_extraction_run_id
    or existing_run.document_id <> p_document_id
    or existing_run.review_policy_version <> p_review_policy_version
    or existing_run.candidate_set_sha256 <> p_candidate_set_sha256
    or existing_run.decision_set_sha256 <> p_decision_set_sha256
    or existing_run.idempotency_key <> p_idempotency_key
    or existing_run.candidate_count <> run_row.candidate_count then
    raise exception 'existing canonicalization run conflicts with reviewed lineage';
  end if;

  if existing_run.status='ready' then
    return query select existing_run.canonicalization_run_id,existing_run.candidate_count,
      existing_run.canonical_candidate_count,existing_run.observation_count,existing_run.source_reference_count;
    return;
  end if;

  for candidate_row in
    select *
    from corvis_source.extraction_candidate
    where tenant_id=p_tenant_id and extraction_run_id=p_extraction_run_id
    order by candidate_key
  loop
    select * into requirement_row
    from corvis_review.candidate_review_requirement
    where tenant_id=p_tenant_id
      and extraction_run_id=p_extraction_run_id
      and candidate_id=candidate_row.candidate_id
      and review_policy_version=p_review_policy_version
    limit 1;
    if not found then raise exception 'canonicalization candidate is missing immutable review requirement'; end if;

    correction_event_id := null;
    correction_payload := null;
    select review_event_id,correction_payload
      into correction_event_id,correction_payload
    from corvis_review.candidate_review_event
    where tenant_id=p_tenant_id
      and extraction_run_id=p_extraction_run_id
      and candidate_id=candidate_row.candidate_id
      and review_policy_version=p_review_policy_version
      and decision='correct'
    order by event_sequence desc
    limit 1;

    -- Corrections are overlays. The extraction candidate payload/evidence/confidence/
    -- provenance remain immutable and are recorded alongside the effective payload.
    effective_payload := candidate_row.payload || coalesce(correction_payload,'{}'::jsonb);

    select coalesce(array_agg(r.source_reference_id order by r.reference_key),'{}'::uuid[]),count(*)::integer
      into reference_ids,expected_reference_count
    from corvis_source.extraction_candidate_source_reference r
    where r.tenant_id=p_tenant_id
      and r.extraction_run_id=p_extraction_run_id
      and r.candidate_id=candidate_row.candidate_id
      and r.document_id=p_document_id
      and r.representation_id=run_row.representation_id;

    if expected_reference_count <> candidate_row.source_reference_count or expected_reference_count <= 0 then
      raise exception 'canonicalization source-reference lineage is incomplete';
    end if;

    insert into corvis_source.source_reference (
      tenant_id,source_reference_id,document_id,document_artifact_version_id,
      page_number,sheet_name,cell_range,bbox,excerpt,created_at,
      extraction_run_id,candidate_id,representation_id,reference_key,
      section_title,table_title,row_label,column_label,footnote_marker,extraction_method
    )
    select
      r.tenant_id,r.source_reference_id,r.document_id,run_row.document_artifact_version_id,
      r.page_number,r.sheet_name,r.cell_or_range,r.bounding_box,r.source_text,now(),
      r.extraction_run_id,r.candidate_id,r.representation_id,r.reference_key,
      r.section_title,r.table_title,r.row_label,r.column_label,r.footnote_marker,r.extraction_method
    from corvis_source.extraction_candidate_source_reference r
    where r.tenant_id=p_tenant_id
      and r.extraction_run_id=p_extraction_run_id
      and r.candidate_id=candidate_row.candidate_id
    on conflict (source_reference_id) do nothing;

    select count(*)::integer into actual_reference_count
    from corvis_source.source_reference r
    where r.tenant_id=p_tenant_id
      and r.extraction_run_id=p_extraction_run_id
      and r.candidate_id=candidate_row.candidate_id
      and r.document_id=p_document_id
      and r.document_artifact_version_id=run_row.document_artifact_version_id
      and r.representation_id=run_row.representation_id
      and r.source_reference_id=any(reference_ids);
    if actual_reference_count <> expected_reference_count then
      raise exception 'canonicalization source-reference conflict or cross-tenant lineage mismatch';
    end if;

    insert into corvis_facts.canonical_candidate (
      tenant_id,canonicalization_run_id,extraction_run_id,candidate_id,candidate_key,candidate_type,
      review_policy_version,candidate_fingerprint_sha256,candidate_set_sha256,decision_set_sha256,
      original_payload,effective_payload,confidence,provenance,exception_codes,
      correction_review_event_id,source_reference_ids
    ) values (
      p_tenant_id,canonical_run_id,p_extraction_run_id,candidate_row.candidate_id,candidate_row.candidate_key,
      candidate_row.candidate_type,p_review_policy_version,requirement_row.candidate_fingerprint_sha256,
      p_candidate_set_sha256,p_decision_set_sha256,candidate_row.payload,effective_payload,
      candidate_row.confidence,candidate_row.provenance,candidate_row.exception_codes,
      correction_event_id,reference_ids
    ) on conflict (tenant_id,canonicalization_run_id,candidate_id) do nothing;

    if not exists (
      select 1 from corvis_facts.canonical_candidate c
      where c.tenant_id=p_tenant_id
        and c.canonicalization_run_id=canonical_run_id
        and c.candidate_id=candidate_row.candidate_id
        and c.extraction_run_id=p_extraction_run_id
        and c.candidate_key=candidate_row.candidate_key
        and c.candidate_type=candidate_row.candidate_type
        and c.review_policy_version=p_review_policy_version
        and c.candidate_fingerprint_sha256=requirement_row.candidate_fingerprint_sha256
        and c.candidate_set_sha256=p_candidate_set_sha256
        and c.decision_set_sha256=p_decision_set_sha256
        and c.original_payload=candidate_row.payload
        and c.effective_payload=effective_payload
        and c.confidence=candidate_row.confidence
        and c.provenance=candidate_row.provenance
        and c.exception_codes=candidate_row.exception_codes
        and c.correction_review_event_id is not distinct from correction_event_id
        and c.source_reference_ids=reference_ids
    ) then
      raise exception 'existing canonical candidate conflicts with immutable reviewed content';
    end if;

    if candidate_row.candidate_type='metric_observation' then
      fund_id_value := nullif(btrim(coalesce(effective_payload ->> 'fund_id','')), '');
      company_id_value := nullif(btrim(coalesce(effective_payload ->> 'company_id','')), '');
      holding_id_value := nullif(btrim(coalesce(effective_payload ->> 'holding_id','')), '');
      instrument_id_value := nullif(btrim(coalesce(effective_payload ->> 'instrument_id','')), '');
      metric_code_value := nullif(btrim(coalesce(effective_payload ->> 'metric_code',effective_payload ->> 'metricCode','')), '');
      subject_type_value := nullif(btrim(coalesce(effective_payload ->> 'subject_type','')), '');
      subject_level_value := nullif(btrim(coalesce(effective_payload ->> 'subject_level','')), '');

      if fund_id_value is null then raise exception 'canonicalization observation requires resolved fund_id'; end if;
      if not exists (select 1 from corvis_identity.fund f where f.global_fund_id=fund_id_value) then
        raise exception 'canonicalization observation fund identity is unresolved';
      end if;
      if metric_code_value is null then raise exception 'canonicalization observation requires metric_code'; end if;
      if not exists (
        select 1 from corvis_semantic.metric_definition m
        where m.metric_code=metric_code_value and m.active=true
      ) then
        raise exception 'canonicalization observation metric taxonomy is unresolved';
      end if;
      if subject_type_value not in ('fund_performance','company_operating','holding_position','instrument_position','fee_expense','lookthrough_exposure') then
        raise exception 'canonicalization observation has unsupported subject_type';
      end if;
      if subject_level_value not in ('fund','company','holding','instrument') then
        raise exception 'canonicalization observation has unsupported subject_level';
      end if;

      if company_id_value is not null and not exists (
        select 1 from corvis_identity.company c where c.global_company_id=company_id_value
      ) then
        raise exception 'canonicalization observation company identity is unresolved';
      end if;
      if subject_level_value='company' and company_id_value is null then
        raise exception 'canonicalization company observation requires company_id';
      end if;

      holding_uuid := null;
      if holding_id_value is not null then
        begin holding_uuid := holding_id_value::uuid;
        exception when others then raise exception 'canonicalization holding_id is not an internal UUID'; end;
        if not exists (
          select 1 from corvis_facts.holding h
          where h.tenant_id=p_tenant_id and h.holding_id=holding_uuid and h.fund_id=fund_id_value
        ) then
          raise exception 'canonicalization observation holding identity is unresolved for tenant/fund';
        end if;
      end if;
      if subject_level_value in ('holding','instrument') and holding_uuid is null then
        raise exception 'canonicalization holding/instrument observation requires holding_id';
      end if;

      instrument_uuid := null;
      if instrument_id_value is not null then
        begin instrument_uuid := instrument_id_value::uuid;
        exception when others then raise exception 'canonicalization instrument_id is not an internal UUID'; end;
        if not exists (
          select 1 from corvis_facts.instrument i
          where i.tenant_id=p_tenant_id and i.instrument_id=instrument_uuid
            and (holding_uuid is null or i.holding_id=holding_uuid)
        ) then
          raise exception 'canonicalization observation instrument identity is unresolved for tenant';
        end if;
      end if;
      if subject_level_value='instrument' and instrument_uuid is null then
        raise exception 'canonicalization instrument observation requires instrument_id';
      end if;

      value_number_text := nullif(btrim(coalesce(effective_payload ->> 'value_numeric',effective_payload ->> 'valueNumeric','')), '');
      value_string_value := coalesce(
        nullif(effective_payload ->> 'value_text',''),
        nullif(effective_payload ->> 'value_qualifier','')
      );
      if value_number_text is not null and value_number_text !~ '^-?[0-9]+([.][0-9]+)?$' then
        raise exception 'canonicalization observation value_numeric is invalid';
      end if;
      if value_number_text is null and value_string_value is null then
        raise exception 'canonicalization observation requires normalized numeric/text/qualifier value';
      end if;

      begin period_start_value := nullif(effective_payload ->> 'period_start','')::date;
      exception when others then raise exception 'canonicalization observation period_start is invalid'; end;
      begin period_end_value := nullif(effective_payload ->> 'period_end','')::date;
      exception when others then raise exception 'canonicalization observation period_end is invalid'; end;
      begin as_of_date_value := nullif(effective_payload ->> 'as_of_date','')::date;
      exception when others then raise exception 'canonicalization observation as_of_date is invalid'; end;
      begin report_date_value := nullif(effective_payload ->> 'report_date','')::date;
      exception when others then raise exception 'canonicalization observation report_date is invalid'; end;

      confidence_value := null;
      if coalesce(effective_payload ->> 'value_confidence',candidate_row.confidence ->> 'value') is not null then
        begin confidence_value := coalesce(effective_payload ->> 'value_confidence',candidate_row.confidence ->> 'value')::double precision;
        exception when others then raise exception 'canonicalization observation value confidence is invalid'; end;
        if confidence_value < 0 or confidence_value > 1 then
          raise exception 'canonicalization observation value confidence must be between 0 and 1';
        end if;
      end if;

      select r.source_reference_id into primary_reference_id
      from corvis_source.extraction_candidate_source_reference r
      where r.tenant_id=p_tenant_id
        and r.extraction_run_id=p_extraction_run_id
        and r.candidate_id=candidate_row.candidate_id
      order by r.reference_key
      limit 1;
      if primary_reference_id is null then raise exception 'canonicalization observation requires source evidence'; end if;

      observation_id_value := md5(
        'canonical-observation:' || p_tenant_id::text || ':' || p_extraction_run_id::text || ':' || candidate_row.candidate_id::text
      )::uuid;

      insert into corvis_facts.observation (
        tenant_id,observation_id,fund_id,company_id,holding_id,instrument_id,metric_code,
        value_number,value_string,currency,economic_period,report_date,actuality,review_state,version,
        source_reference_id,extraction_run_id,schema_version,skill_version,confidence_score,risk_tier,
        canonicalization_run_id,candidate_id,candidate_key,candidate_fingerprint_sha256,
        candidate_set_sha256,decision_set_sha256,review_policy_version,subject_type,subject_level,
        value_raw,value_qualifier,unit,reported_multiplier,source_precision,period_type,period_start,
        period_end,as_of_date,scenario_type,is_adjusted,adjustment_note,valuation_method,
        breakdown_category,breakdown_value,lookthrough_source,is_derived,derivation_formula,is_restated,recorded_at
      ) values (
        p_tenant_id,observation_id_value,fund_id_value,company_id_value,holding_id_value,instrument_id_value,metric_code_value,
        case when value_number_text is null then null else value_number_text::numeric end,value_string_value,
        nullif(effective_payload ->> 'currency',''),
        coalesce(nullif(effective_payload ->> 'period_end',''),nullif(effective_payload ->> 'as_of_date',''),nullif(effective_payload ->> 'period_type','')),
        report_date_value,nullif(effective_payload ->> 'actuality',''),'approved',1,
        primary_reference_id,p_extraction_run_id::text,run_row.schema_version,run_row.skill_version,confidence_value,
        case when requirement_row.risk_tier='critical' then 'critical' else 'normal' end,
        canonical_run_id,candidate_row.candidate_id,candidate_row.candidate_key,requirement_row.candidate_fingerprint_sha256,
        p_candidate_set_sha256,p_decision_set_sha256,p_review_policy_version,subject_type_value,subject_level_value,
        nullif(effective_payload ->> 'value_raw',''),nullif(effective_payload ->> 'value_qualifier',''),
        nullif(effective_payload ->> 'unit',''),nullif(effective_payload ->> 'reported_multiplier',''),
        nullif(effective_payload ->> 'source_precision',''),nullif(effective_payload ->> 'period_type',''),
        period_start_value,period_end_value,as_of_date_value,nullif(effective_payload ->> 'scenario_type',''),
        case when effective_payload ? 'is_adjusted' then (effective_payload ->> 'is_adjusted')::boolean else null end,
        nullif(effective_payload ->> 'adjustment_note',''),nullif(effective_payload ->> 'valuation_method',''),
        nullif(effective_payload ->> 'breakdown_category',''),nullif(effective_payload ->> 'breakdown_value',''),
        nullif(effective_payload ->> 'lookthrough_source',''),
        case when effective_payload ? 'is_derived' then (effective_payload ->> 'is_derived')::boolean else null end,
        nullif(effective_payload ->> 'derivation_formula',''),
        case when effective_payload ? 'is_restated' then (effective_payload ->> 'is_restated')::boolean else null end,
        now()
      ) on conflict (observation_id) do nothing;

      if not exists (
        select 1 from corvis_facts.observation o
        where o.tenant_id=p_tenant_id
          and o.observation_id=observation_id_value
          and o.extraction_run_id=p_extraction_run_id::text
          and o.canonicalization_run_id=canonical_run_id
          and o.candidate_id=candidate_row.candidate_id
          and o.candidate_key=candidate_row.candidate_key
          and o.candidate_fingerprint_sha256=requirement_row.candidate_fingerprint_sha256
          and o.candidate_set_sha256=p_candidate_set_sha256
          and o.decision_set_sha256=p_decision_set_sha256
          and o.review_policy_version=p_review_policy_version
          and o.review_state='approved'
          and o.source_reference_id=primary_reference_id
      ) then
        raise exception 'existing canonical observation conflicts with reviewed lineage';
      end if;

      insert into corvis_facts.observation_source_reference (tenant_id,observation_id,source_reference_id,ordinal)
      select p_tenant_id,observation_id_value,r.source_reference_id,
        row_number() over (order by r.reference_key)::integer
      from corvis_source.extraction_candidate_source_reference r
      where r.tenant_id=p_tenant_id
        and r.extraction_run_id=p_extraction_run_id
        and r.candidate_id=candidate_row.candidate_id
      on conflict (tenant_id,observation_id,source_reference_id) do nothing;
    end if;
  end loop;

  select count(*)::integer into actual_candidate_count
  from corvis_facts.canonical_candidate
  where tenant_id=p_tenant_id and canonicalization_run_id=canonical_run_id;
  if actual_candidate_count <> run_row.candidate_count then
    raise exception 'canonicalization candidate persistence is incomplete';
  end if;

  select count(*)::integer into actual_observation_count
  from corvis_facts.canonical_candidate c
  where c.tenant_id=p_tenant_id and c.canonicalization_run_id=canonical_run_id and c.candidate_type='metric_observation';
  if actual_observation_count <> (
    select count(*)::integer from corvis_facts.observation o
    where o.tenant_id=p_tenant_id and o.canonicalization_run_id=canonical_run_id
  ) then
    raise exception 'canonicalization observation persistence is incomplete';
  end if;

  select count(*)::integer into actual_reference_count
  from corvis_source.source_reference r
  where r.tenant_id=p_tenant_id and r.extraction_run_id=p_extraction_run_id;
  if actual_reference_count <> (
    select count(*)::integer
    from corvis_source.extraction_candidate_source_reference r
    where r.tenant_id=p_tenant_id and r.extraction_run_id=p_extraction_run_id
  ) then
    raise exception 'canonicalization source-reference persistence is incomplete';
  end if;

  update corvis_facts.canonicalization_run
  set status='ready',canonical_candidate_count=actual_candidate_count,
      observation_count=actual_observation_count,source_reference_count=actual_reference_count,
      completed_at=coalesce(completed_at,now())
  where tenant_id=p_tenant_id and canonicalization_run_id=canonical_run_id and status='writing'
  returning * into existing_run;

  if not found then
    select * into existing_run from corvis_facts.canonicalization_run
    where tenant_id=p_tenant_id and canonicalization_run_id=canonical_run_id;
  end if;
  if existing_run.status <> 'ready' then raise exception 'canonicalization run did not finalize'; end if;

  return query select existing_run.canonicalization_run_id,existing_run.candidate_count,
    existing_run.canonical_candidate_count,existing_run.observation_count,existing_run.source_reference_count;
end;
$$;

-- Persistence-bound fail-closed guard. A canonicalized job may not complete and
-- create reconciliation work unless the effect result names the exact ready
-- canonicalization run that the database finalized from the reviewed predecessor.
create or replace function corvis_facts.enforce_ready_canonicalization_before_success()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, corvis_control, corvis_facts
as $$
declare
  canonical_result jsonb;
  canonical_run_id uuid;
  extraction_run_id_value uuid;
  candidate_hash text;
  decision_hash text;
  policy_version text;
begin
  if old.stage='canonicalized' and old.state='running' and new.state='succeeded' then
    select e.result into canonical_result
    from corvis_control.processing_stage_effect e
    where e.tenant_id=old.tenant_id
      and e.job_id=old.job_id
      and e.document_id=old.document_id
      and e.stage='canonicalized'
      and e.state='complete'
    order by e.completed_at desc nulls last
    limit 1;

    if canonical_result is null then
      raise exception 'canonicalized completion requires committed canonicalization effect';
    end if;
    begin
      canonical_run_id := (canonical_result ->> 'canonicalizationRunId')::uuid;
      extraction_run_id_value := (canonical_result ->> 'extractionRunId')::uuid;
    exception when others then
      raise exception 'canonicalized completion identifiers are invalid';
    end;
    candidate_hash := canonical_result ->> 'candidateSetSha256';
    decision_hash := canonical_result ->> 'decisionSetSha256';
    policy_version := canonical_result ->> 'reviewPolicyVersion';

    if not exists (
      select 1
      from corvis_facts.canonicalization_run c
      where c.tenant_id=old.tenant_id
        and c.canonicalization_run_id=canonical_run_id
        and c.extraction_run_id=extraction_run_id_value
        and c.document_id=old.document_id
        and c.review_policy_version=policy_version
        and c.candidate_set_sha256=candidate_hash
        and c.decision_set_sha256=decision_hash
        and c.status='ready'
        and c.canonical_candidate_count=c.candidate_count
    ) then
      raise exception 'canonicalization persistence blocks reconciliation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists processing_job_canonicalization_guard
  on corvis_control.processing_job;
create trigger processing_job_canonicalization_guard
before update of state on corvis_control.processing_job
for each row
execute function corvis_facts.enforce_ready_canonicalization_before_success();

commit;
