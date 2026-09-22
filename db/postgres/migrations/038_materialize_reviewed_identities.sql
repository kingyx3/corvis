-- Corvis reviewed fund/company identity materialization v1
-- Depends on migrations 001-037.
--
-- New durable identities must exist before reviewed holdings/instruments and metric
-- observations can validate their foreign economic graph. We therefore pre-materialize
-- only the exact ready reviewed fund/company set, run the existing v3 -> v2 -> v1
-- canonicalization chain, then attach canonical source-reference lineage. All work is
-- one Postgres statement: any downstream validation failure rolls every pre-write back.

begin;

create table if not exists corvis_identity.tenant_entity_revision (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  canonicalization_run_id uuid not null,
  candidate_id uuid not null,
  entity_type text not null check (entity_type in ('fund','company')),
  global_entity_id text not null check (btrim(global_entity_id) <> ''),
  candidate_fingerprint_sha256 text not null,
  effective_payload jsonb not null,
  source_reference_ids uuid[] not null,
  recorded_at timestamptz not null default now(),
  primary key (tenant_id,canonicalization_run_id,candidate_id),
  foreign key (tenant_id,canonicalization_run_id,candidate_id)
    references corvis_facts.canonical_candidate(tenant_id,canonicalization_run_id,candidate_id),
  check (candidate_fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
  check (jsonb_typeof(effective_payload)='object'),
  check (cardinality(source_reference_ids) > 0)
);

alter table corvis_identity.tenant_entity_revision enable row level security;
alter table corvis_identity.tenant_entity_revision force row level security;
create policy tenant_entity_revision_select
  on corvis_identity.tenant_entity_revision
  for select using (corvis_control.has_tenant_access(tenant_id));

create index if not exists tenant_entity_revision_identity_idx
  on corvis_identity.tenant_entity_revision
    (tenant_id,entity_type,global_entity_id,recorded_at desc);

create or replace function corvis_identity.pre_materialize_reviewed_entity_candidates(
  p_tenant_id uuid,
  p_document_id uuid,
  p_extraction_run_id uuid,
  p_review_policy_version text,
  p_candidate_set_sha256 text,
  p_decision_set_sha256 text
)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, corvis_identity, corvis_source, corvis_review, corvis_control
as $$
declare
  candidate_row record;
  effective_payload jsonb;
  entity_id_value text;
  canonical_name_value text;
  source_name_value text;
  manager_name_value text;
  seen_fund_ids text[] := '{}'::text[];
  seen_company_ids text[] := '{}'::text[];
begin
  -- Mirror v2's proven fail-before-projection gate. v1 later rechecks this exact
  -- gate plus the committed reviewed-stage predecessor and all evidence/identity
  -- invariants; a failure there rolls these writes back atomically.
  if not exists (
    select 1
    from corvis_review.extraction_review_gate g
    join corvis_source.extraction_run r
      on r.tenant_id=g.tenant_id and r.extraction_run_id=g.extraction_run_id
    where g.tenant_id=p_tenant_id
      and g.extraction_run_id=p_extraction_run_id
      and r.document_id=p_document_id
      and r.status='ready'
      and g.review_policy_version=p_review_policy_version
      and g.status='ready'
      and g.blocking_candidate_count=0
      and g.candidate_set_sha256=p_candidate_set_sha256
      and g.decision_set_sha256=p_decision_set_sha256
      and r.candidate_set_sha256=p_candidate_set_sha256
  ) then
    raise exception 'entity materialization requires exact ready reviewed candidate set';
  end if;

  for candidate_row in
    select c.*,
      c.payload || coalesce((
        select e.correction_payload
        from corvis_review.candidate_review_event e
        where e.tenant_id=c.tenant_id
          and e.extraction_run_id=c.extraction_run_id
          and e.candidate_id=c.candidate_id
          and e.review_policy_version=p_review_policy_version
          and e.decision='correct'
        order by e.event_sequence desc limit 1
      ),'{}'::jsonb) as reviewed_payload
    from corvis_source.extraction_candidate c
    where c.tenant_id=p_tenant_id
      and c.extraction_run_id=p_extraction_run_id
      and c.candidate_type in ('fund','company')
    order by c.candidate_type,c.candidate_key
  loop
    effective_payload := candidate_row.reviewed_payload;

    if candidate_row.candidate_type='fund' then
      entity_id_value := nullif(btrim(coalesce(
        effective_payload->>'global_fund_id',effective_payload->>'globalFundId',
        effective_payload->>'fund_id',effective_payload->>'fundId','')),'');
      canonical_name_value := nullif(btrim(coalesce(
        effective_payload->>'canonical_name',effective_payload->>'canonicalName','')),'');
      source_name_value := nullif(btrim(coalesce(
        effective_payload->>'source_name',effective_payload->>'sourceName',
        effective_payload->>'fund_name',effective_payload->>'fundName',effective_payload->>'name',
        canonical_name_value,'')),'');
      manager_name_value := nullif(btrim(coalesce(
        effective_payload->>'manager_name',effective_payload->>'managerName',
        effective_payload->>'gp_name',effective_payload->>'gpName','')),'');

      if entity_id_value is null then raise exception 'reviewed fund candidate requires resolved global_fund_id'; end if;
      if source_name_value is null then raise exception 'reviewed fund candidate requires source or canonical name'; end if;
      if entity_id_value=any(seen_fund_ids) then raise exception 'reviewed candidate set contains duplicate global_fund_id'; end if;
      seen_fund_ids := array_append(seen_fund_ids,entity_id_value);

      if not exists (select 1 from corvis_identity.fund f where f.global_fund_id=entity_id_value) then
        if canonical_name_value is null then raise exception 'new reviewed fund identity requires explicit canonical_name'; end if;
        insert into corvis_identity.fund (global_fund_id,canonical_name,manager_name)
        values (entity_id_value,canonical_name_value,manager_name_value)
        on conflict (global_fund_id) do nothing;
      end if;
      if not exists (select 1 from corvis_identity.fund f where f.global_fund_id=entity_id_value) then
        raise exception 'reviewed fund identity could not be materialized';
      end if;
    else
      entity_id_value := nullif(btrim(coalesce(
        effective_payload->>'global_company_id',effective_payload->>'globalCompanyId',
        effective_payload->>'company_id',effective_payload->>'companyId','')),'');
      canonical_name_value := nullif(btrim(coalesce(
        effective_payload->>'canonical_name',effective_payload->>'canonicalName','')),'');
      source_name_value := nullif(btrim(coalesce(
        effective_payload->>'source_name',effective_payload->>'sourceName',
        effective_payload->>'company_name',effective_payload->>'companyName',effective_payload->>'name',
        canonical_name_value,'')),'');

      if entity_id_value is null then raise exception 'reviewed company candidate requires resolved global_company_id'; end if;
      if source_name_value is null then raise exception 'reviewed company candidate requires source or canonical name'; end if;
      if entity_id_value=any(seen_company_ids) then raise exception 'reviewed candidate set contains duplicate global_company_id'; end if;
      seen_company_ids := array_append(seen_company_ids,entity_id_value);

      if not exists (select 1 from corvis_identity.company c where c.global_company_id=entity_id_value) then
        if canonical_name_value is null then raise exception 'new reviewed company identity requires explicit canonical_name'; end if;
        insert into corvis_identity.company (global_company_id,canonical_name)
        values (entity_id_value,canonical_name_value)
        on conflict (global_company_id) do nothing;
      end if;
      if not exists (select 1 from corvis_identity.company c where c.global_company_id=entity_id_value) then
        raise exception 'reviewed company identity could not be materialized';
      end if;
    end if;
  end loop;
end;
$$;

create or replace function corvis_identity.record_reviewed_entity_candidate_lineage(
  p_tenant_id uuid,
  p_canonicalization_run_id uuid
)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, corvis_identity, corvis_facts, corvis_source, corvis_control
as $$
declare
  candidate_row record;
  entity_id_value text;
  source_name_value text;
  entity_confidence numeric(5,4);
begin
  if not exists (
    select 1 from corvis_facts.canonicalization_run r
    where r.tenant_id=p_tenant_id
      and r.canonicalization_run_id=p_canonicalization_run_id
      and r.status='ready'
  ) then
    raise exception 'entity lineage requires finalized reviewed canonicalization';
  end if;

  for candidate_row in
    select c.*
    from corvis_facts.canonical_candidate c
    where c.tenant_id=p_tenant_id
      and c.canonicalization_run_id=p_canonicalization_run_id
      and c.candidate_type in ('fund','company')
    order by c.candidate_type,c.candidate_key
  loop
    if candidate_row.candidate_type='fund' then
      entity_id_value := nullif(btrim(coalesce(
        candidate_row.effective_payload->>'global_fund_id',candidate_row.effective_payload->>'globalFundId',
        candidate_row.effective_payload->>'fund_id',candidate_row.effective_payload->>'fundId','')),'');
      source_name_value := nullif(btrim(coalesce(
        candidate_row.effective_payload->>'source_name',candidate_row.effective_payload->>'sourceName',
        candidate_row.effective_payload->>'fund_name',candidate_row.effective_payload->>'fundName',
        candidate_row.effective_payload->>'name',candidate_row.effective_payload->>'canonical_name',
        candidate_row.effective_payload->>'canonicalName','')),'');
      if entity_id_value is null or source_name_value is null then
        raise exception 'canonical fund candidate lost reviewed identity/name lineage';
      end if;
      if not exists (select 1 from corvis_identity.fund f where f.global_fund_id=entity_id_value) then
        raise exception 'canonical fund identity is unresolved after materialization';
      end if;
    else
      entity_id_value := nullif(btrim(coalesce(
        candidate_row.effective_payload->>'global_company_id',candidate_row.effective_payload->>'globalCompanyId',
        candidate_row.effective_payload->>'company_id',candidate_row.effective_payload->>'companyId','')),'');
      source_name_value := nullif(btrim(coalesce(
        candidate_row.effective_payload->>'source_name',candidate_row.effective_payload->>'sourceName',
        candidate_row.effective_payload->>'company_name',candidate_row.effective_payload->>'companyName',
        candidate_row.effective_payload->>'name',candidate_row.effective_payload->>'canonical_name',
        candidate_row.effective_payload->>'canonicalName','')),'');
      if entity_id_value is null or source_name_value is null then
        raise exception 'canonical company candidate lost reviewed identity/name lineage';
      end if;
      if not exists (select 1 from corvis_identity.company c where c.global_company_id=entity_id_value) then
        raise exception 'canonical company identity is unresolved after materialization';
      end if;
    end if;

    begin
      entity_confidence := nullif(candidate_row.confidence->>'entity','')::numeric(5,4);
    exception when others then
      entity_confidence := null;
    end;

    -- Canonical source references exist only after v1 has finalized the reviewed set.
    insert into corvis_identity.tenant_entity_name (
      tenant_id,tenant_entity_name_id,fund_id,company_id,name,name_kind,
      source_reference_id,confidence,review_status
    ) values (
      p_tenant_id,candidate_row.candidate_id,
      case when candidate_row.candidate_type='fund' then entity_id_value else null end,
      case when candidate_row.candidate_type='company' then entity_id_value else null end,
      source_name_value,'source_label',candidate_row.source_reference_ids[1],entity_confidence,'approved'
    ) on conflict (tenant_id,tenant_entity_name_id) do nothing;

    if not exists (
      select 1 from corvis_identity.tenant_entity_name n
      where n.tenant_id=p_tenant_id
        and n.tenant_entity_name_id=candidate_row.candidate_id
        and n.name=source_name_value
        and n.name_kind='source_label'
        and n.review_status='approved'
        and n.source_reference_id=candidate_row.source_reference_ids[1]
        and ((candidate_row.candidate_type='fund' and n.fund_id=entity_id_value and n.company_id is null)
          or (candidate_row.candidate_type='company' and n.company_id=entity_id_value and n.fund_id is null))
    ) then
      raise exception 'reviewed entity candidate conflicts with existing tenant identity evidence';
    end if;

    insert into corvis_identity.tenant_entity_revision (
      tenant_id,canonicalization_run_id,candidate_id,entity_type,global_entity_id,
      candidate_fingerprint_sha256,effective_payload,source_reference_ids
    ) values (
      p_tenant_id,p_canonicalization_run_id,candidate_row.candidate_id,candidate_row.candidate_type,
      entity_id_value,candidate_row.candidate_fingerprint_sha256,
      candidate_row.effective_payload,candidate_row.source_reference_ids
    ) on conflict do nothing;
  end loop;
end;
$$;

create or replace function corvis_facts.canonicalize_reviewed_extraction_v4(
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
set search_path = pg_catalog, corvis_facts, corvis_identity, corvis_source, corvis_review, corvis_control
as $$
declare
  v_result record;
begin
  -- Dependency order for a new graph in one report:
  -- identity -> v2 holding/instrument preprojection -> v1 observations -> lifecycle.
  perform corvis_identity.pre_materialize_reviewed_entity_candidates(
    p_tenant_id,p_document_id,p_extraction_run_id,p_review_policy_version,
    p_candidate_set_sha256,p_decision_set_sha256
  );

  select * into v_result
  from corvis_facts.canonicalize_reviewed_extraction_v3(
    p_tenant_id,p_document_id,p_extraction_run_id,p_review_policy_version,
    p_candidate_set_sha256,p_decision_set_sha256,p_idempotency_key
  );
  if v_result.canonicalization_run_id is null then
    raise exception 'entity materialization requires finalized canonicalization';
  end if;

  perform corvis_identity.record_reviewed_entity_candidate_lineage(
    p_tenant_id,v_result.canonicalization_run_id
  );

  return query select
    v_result.canonicalization_run_id,
    v_result.candidate_count,
    v_result.canonical_candidate_count,
    v_result.observation_count,
    v_result.source_reference_count;
end;
$$;

commit;
