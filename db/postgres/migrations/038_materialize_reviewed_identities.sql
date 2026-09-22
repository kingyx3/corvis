-- Corvis reviewed fund/company identity materialization v1
-- Depends on migrations 001-037.
--
-- Reviewed fund/company candidates may establish a new durable global identity only
-- when the candidate already carries an explicit resolved immutable ID. Names never
-- create identity by similarity. Existing global identities are never silently
-- renamed from tenant evidence; tenant-observed labels remain tenant scoped.

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

create or replace function corvis_identity.materialize_reviewed_entity_candidates(
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
  canonical_name_value text;
  source_name_value text;
  manager_name_value text;
  duplicate_count integer;
  entity_confidence numeric(5,4);
  identity_preexisted boolean;
begin
  if not exists (
    select 1 from corvis_facts.canonicalization_run r
    where r.tenant_id=p_tenant_id
      and r.canonicalization_run_id=p_canonicalization_run_id
      and r.status='ready'
  ) then
    raise exception 'entity materialization requires finalized reviewed canonicalization';
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
        candidate_row.effective_payload->>'global_fund_id',
        candidate_row.effective_payload->>'globalFundId',
        candidate_row.effective_payload->>'fund_id',
        candidate_row.effective_payload->>'fundId','')),'');
      canonical_name_value := nullif(btrim(coalesce(
        candidate_row.effective_payload->>'canonical_name',
        candidate_row.effective_payload->>'canonicalName',
        candidate_row.effective_payload->>'fund_name',
        candidate_row.effective_payload->>'fundName',
        candidate_row.effective_payload->>'name','')),'');
      source_name_value := nullif(btrim(coalesce(
        candidate_row.effective_payload->>'source_name',
        candidate_row.effective_payload->>'sourceName',
        candidate_row.effective_payload->>'fund_name',
        candidate_row.effective_payload->>'fundName',
        candidate_row.effective_payload->>'name',
        canonical_name_value,'')),'');
      manager_name_value := nullif(btrim(coalesce(
        candidate_row.effective_payload->>'manager_name',
        candidate_row.effective_payload->>'managerName',
        candidate_row.effective_payload->>'gp_name',
        candidate_row.effective_payload->>'gpName','')),'');
      if entity_id_value is null then raise exception 'reviewed fund candidate requires resolved global_fund_id'; end if;
      if canonical_name_value is null then raise exception 'reviewed fund candidate requires canonical/source name'; end if;

      select count(*)::integer into duplicate_count
      from corvis_facts.canonical_candidate c2
      where c2.tenant_id=p_tenant_id
        and c2.canonicalization_run_id=p_canonicalization_run_id
        and c2.candidate_type='fund'
        and nullif(btrim(coalesce(
          c2.effective_payload->>'global_fund_id',c2.effective_payload->>'globalFundId',
          c2.effective_payload->>'fund_id',c2.effective_payload->>'fundId','')),'')=entity_id_value;
      if duplicate_count <> 1 then raise exception 'reviewed candidate set contains duplicate global_fund_id'; end if;

      select exists(select 1 from corvis_identity.fund f where f.global_fund_id=entity_id_value)
        into identity_preexisted;
      if not identity_preexisted then
        insert into corvis_identity.fund (global_fund_id,canonical_name,manager_name)
        values (entity_id_value,canonical_name_value,manager_name_value)
        on conflict (global_fund_id) do nothing;
      end if;
      if not exists (select 1 from corvis_identity.fund f where f.global_fund_id=entity_id_value) then
        raise exception 'reviewed fund identity could not be materialized';
      end if;
    else
      entity_id_value := nullif(btrim(coalesce(
        candidate_row.effective_payload->>'global_company_id',
        candidate_row.effective_payload->>'globalCompanyId',
        candidate_row.effective_payload->>'company_id',
        candidate_row.effective_payload->>'companyId','')),'');
      canonical_name_value := nullif(btrim(coalesce(
        candidate_row.effective_payload->>'canonical_name',
        candidate_row.effective_payload->>'canonicalName',
        candidate_row.effective_payload->>'company_name',
        candidate_row.effective_payload->>'companyName',
        candidate_row.effective_payload->>'name','')),'');
      source_name_value := nullif(btrim(coalesce(
        candidate_row.effective_payload->>'source_name',
        candidate_row.effective_payload->>'sourceName',
        candidate_row.effective_payload->>'company_name',
        candidate_row.effective_payload->>'companyName',
        candidate_row.effective_payload->>'name',
        canonical_name_value,'')),'');
      manager_name_value := null;
      if entity_id_value is null then raise exception 'reviewed company candidate requires resolved global_company_id'; end if;
      if canonical_name_value is null then raise exception 'reviewed company candidate requires canonical/source name'; end if;

      select count(*)::integer into duplicate_count
      from corvis_facts.canonical_candidate c2
      where c2.tenant_id=p_tenant_id
        and c2.canonicalization_run_id=p_canonicalization_run_id
        and c2.candidate_type='company'
        and nullif(btrim(coalesce(
          c2.effective_payload->>'global_company_id',c2.effective_payload->>'globalCompanyId',
          c2.effective_payload->>'company_id',c2.effective_payload->>'companyId','')),'')=entity_id_value;
      if duplicate_count <> 1 then raise exception 'reviewed candidate set contains duplicate global_company_id'; end if;

      select exists(select 1 from corvis_identity.company c where c.global_company_id=entity_id_value)
        into identity_preexisted;
      if not identity_preexisted then
        insert into corvis_identity.company (global_company_id,canonical_name)
        values (entity_id_value,canonical_name_value)
        on conflict (global_company_id) do nothing;
      end if;
      if not exists (select 1 from corvis_identity.company c where c.global_company_id=entity_id_value) then
        raise exception 'reviewed company identity could not be materialized';
      end if;
    end if;

    -- A private report may use a former/legal/trading/codename label. Preserve it
    -- as tenant-scoped evidence even when the global identity already has a different
    -- current canonical name. Never promote a tenant label into the global name table.
    begin
      entity_confidence := nullif(candidate_row.confidence->>'entity','')::numeric(5,4);
    exception when others then
      entity_confidence := null;
    end;
    if source_name_value is null then source_name_value := canonical_name_value; end if;

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
  v_seed record;
  v_result record;
begin
  -- v1 owns exact reviewed-gate validation and canonical-candidate/source-reference
  -- creation. Establish that immutable reviewed ledger first so identity materialization
  -- consumes the same effective payload used by all downstream canonical facts.
  select * into v_seed
  from corvis_facts.canonicalize_reviewed_extraction(
    p_tenant_id,p_document_id,p_extraction_run_id,p_review_policy_version,
    p_candidate_set_sha256,p_decision_set_sha256,p_idempotency_key
  );
  if v_seed.canonicalization_run_id is null then
    raise exception 'entity materialization requires finalized canonicalization';
  end if;

  perform corvis_identity.materialize_reviewed_entity_candidates(
    p_tenant_id,v_seed.canonicalization_run_id
  );

  -- v3 re-enters the replay-safe v2/v1 chain, then materializes holdings,
  -- instruments and lifecycle events. Because identities now exist, a newly reviewed
  -- fund/company can be referenced by those downstream candidates in the same atomic
  -- canonicalization statement. Any later failure rolls the entire v4 statement back.
  select * into v_result
  from corvis_facts.canonicalize_reviewed_extraction_v3(
    p_tenant_id,p_document_id,p_extraction_run_id,p_review_policy_version,
    p_candidate_set_sha256,p_decision_set_sha256,p_idempotency_key
  );
  if v_result.canonicalization_run_id is distinct from v_seed.canonicalization_run_id then
    raise exception 'entity materialization canonicalization lineage changed during replay';
  end if;

  return query select
    v_result.canonicalization_run_id,
    v_result.candidate_count,
    v_result.canonical_candidate_count,
    v_result.observation_count,
    v_result.source_reference_count;
end;
$$;

commit;
