-- Corvis reviewed holding/instrument materialization v1
-- Depends on migrations 001-035.
--
-- The extraction/review ledger stays immutable. This wrapper projects only an
-- exact ready reviewed candidate set into the governed holding/instrument facts
-- before metric observations are canonicalized, then binds immutable revision
-- lineage after the existing canonicalizer has persisted canonical candidates
-- and source references. The whole function call is one database transaction.

begin;

create table if not exists corvis_facts.holding_revision (
  tenant_id uuid not null,
  holding_id uuid not null,
  canonicalization_run_id uuid not null,
  candidate_id uuid not null,
  candidate_fingerprint_sha256 text not null,
  effective_payload jsonb not null,
  source_reference_ids uuid[] not null,
  recorded_at timestamptz not null default now(),
  primary key (tenant_id,holding_id,canonicalization_run_id,candidate_id),
  foreign key (tenant_id,holding_id) references corvis_facts.holding(tenant_id,holding_id),
  foreign key (tenant_id,canonicalization_run_id)
    references corvis_facts.canonicalization_run(tenant_id,canonicalization_run_id),
  check (candidate_fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
  check (jsonb_typeof(effective_payload)='object'),
  check (cardinality(source_reference_ids) > 0)
);

create table if not exists corvis_facts.instrument_revision (
  tenant_id uuid not null,
  instrument_id uuid not null,
  canonicalization_run_id uuid not null,
  candidate_id uuid not null,
  candidate_fingerprint_sha256 text not null,
  effective_payload jsonb not null,
  source_reference_ids uuid[] not null,
  recorded_at timestamptz not null default now(),
  primary key (tenant_id,instrument_id,canonicalization_run_id,candidate_id),
  foreign key (tenant_id,instrument_id) references corvis_facts.instrument(tenant_id,instrument_id),
  foreign key (tenant_id,canonicalization_run_id)
    references corvis_facts.canonicalization_run(tenant_id,canonicalization_run_id),
  check (candidate_fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
  check (jsonb_typeof(effective_payload)='object'),
  check (cardinality(source_reference_ids) > 0)
);

alter table corvis_facts.holding_revision enable row level security;
alter table corvis_facts.holding_revision force row level security;
alter table corvis_facts.instrument_revision enable row level security;
alter table corvis_facts.instrument_revision force row level security;

create index if not exists holding_revision_lineage_idx
  on corvis_facts.holding_revision (tenant_id,canonicalization_run_id,candidate_id);
create index if not exists instrument_revision_lineage_idx
  on corvis_facts.instrument_revision (tenant_id,canonicalization_run_id,candidate_id);

create or replace function corvis_facts.canonicalize_reviewed_extraction_v2(
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
set search_path = pg_catalog, corvis_facts, corvis_source, corvis_review, corvis_identity, corvis_control
as $$
declare
  candidate_row record;
  v_result record;
  effective_payload jsonb;
  holding_uuid uuid;
  instrument_uuid uuid;
  parent_holding_uuid uuid;
  fund_id_value text;
  target_type_value text;
  target_company_id_value text;
  target_fund_id_value text;
  security_name_value text;
  instrument_type_value text;
  investment_date_value date;
  valid_from_value date;
  valid_to_value date;
  maturity_date_value date;
  coupon_rate_value numeric(18,8);
  seen_holding_ids uuid[] := '{}'::uuid[];
  seen_instrument_ids uuid[] := '{}'::uuid[];
begin
  -- Fail before projection unless this is the exact ready reviewed set. The v1
  -- canonicalizer rechecks this gate again, so the wrapper cannot weaken it.
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
    raise exception 'economic materialization requires exact ready reviewed candidate set';
  end if;

  -- Holdings must exist before instruments and before holding/instrument metric
  -- observations are validated by the existing canonicalizer.
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
      and c.candidate_type='holding'
    order by c.candidate_key
  loop
    effective_payload := candidate_row.reviewed_payload;
    begin
      holding_uuid := nullif(btrim(coalesce(effective_payload->>'holding_id',effective_payload->>'holdingId','')),'')::uuid;
    exception when others then raise exception 'reviewed holding candidate requires UUID holding_id'; end;
    if holding_uuid is null then raise exception 'reviewed holding candidate requires holding_id'; end if;
    if holding_uuid=any(seen_holding_ids) then raise exception 'reviewed candidate set contains duplicate holding_id'; end if;
    seen_holding_ids := array_append(seen_holding_ids,holding_uuid);

    fund_id_value := nullif(btrim(coalesce(effective_payload->>'fund_id',effective_payload->>'fundId','')),'');
    target_type_value := lower(nullif(btrim(coalesce(effective_payload->>'target_type',effective_payload->>'targetType','')),''));
    target_company_id_value := nullif(btrim(coalesce(effective_payload->>'target_company_id',effective_payload->>'targetCompanyId','')),'');
    target_fund_id_value := nullif(btrim(coalesce(effective_payload->>'target_fund_id',effective_payload->>'targetFundId','')),'');
    if fund_id_value is null then raise exception 'reviewed holding candidate requires fund_id'; end if;
    if target_type_value not in ('company','fund') then raise exception 'reviewed holding candidate requires governed target_type'; end if;
    if target_type_value='company' and (target_company_id_value is null or target_fund_id_value is not null) then
      raise exception 'reviewed company holding requires exactly target_company_id';
    end if;
    if target_type_value='fund' and (target_fund_id_value is null or target_company_id_value is not null) then
      raise exception 'reviewed fund holding requires exactly target_fund_id';
    end if;
    if not exists (select 1 from corvis_identity.fund f where f.global_fund_id=fund_id_value) then
      raise exception 'reviewed holding fund identity is unresolved';
    end if;
    if target_company_id_value is not null and not exists (
      select 1 from corvis_identity.company c where c.global_company_id=target_company_id_value
    ) then raise exception 'reviewed holding company target identity is unresolved'; end if;
    if target_fund_id_value is not null and not exists (
      select 1 from corvis_identity.fund f where f.global_fund_id=target_fund_id_value
    ) then raise exception 'reviewed holding fund target identity is unresolved'; end if;

    begin investment_date_value := nullif(effective_payload->>'investment_date','')::date;
    exception when others then raise exception 'reviewed holding investment_date is invalid'; end;
    begin valid_from_value := nullif(effective_payload->>'valid_from','')::date;
    exception when others then raise exception 'reviewed holding valid_from is invalid'; end;
    begin valid_to_value := nullif(effective_payload->>'valid_to','')::date;
    exception when others then raise exception 'reviewed holding valid_to is invalid'; end;

    update corvis_facts.holding h
    set fund_id=fund_id_value,
        target_type=target_type_value,
        target_company_id=target_company_id_value,
        target_fund_id=target_fund_id_value,
        status=nullif(effective_payload->>'status',''),
        investment_date=investment_date_value,
        strategy=nullif(effective_payload->>'strategy',''),
        geography=nullif(effective_payload->>'geography',''),
        valid_from=valid_from_value,
        valid_to=valid_to_value,
        review_state='approved',
        version=h.version+1,
        updated_at=now()
    where h.tenant_id=p_tenant_id and h.holding_id=holding_uuid
      and row(h.fund_id,h.target_type,h.target_company_id,h.target_fund_id,h.status,h.investment_date,
              h.strategy,h.geography,h.valid_from,h.valid_to,h.review_state)
          is distinct from
          row(fund_id_value,target_type_value,target_company_id_value,target_fund_id_value,
              nullif(effective_payload->>'status',''),investment_date_value,
              nullif(effective_payload->>'strategy',''),nullif(effective_payload->>'geography',''),
              valid_from_value,valid_to_value,'approved');

    insert into corvis_facts.holding (
      tenant_id,holding_id,fund_id,target_type,target_company_id,target_fund_id,status,
      investment_date,strategy,geography,source_reference_id,version,valid_from,valid_to,review_state
    )
    select p_tenant_id,holding_uuid,fund_id_value,target_type_value,target_company_id_value,target_fund_id_value,
      nullif(effective_payload->>'status',''),investment_date_value,nullif(effective_payload->>'strategy',''),
      nullif(effective_payload->>'geography',''),null,1,valid_from_value,valid_to_value,'approved'
    where not exists (select 1 from corvis_facts.holding h where h.holding_id=holding_uuid)
    on conflict (holding_id) do nothing;

    if not exists (
      select 1 from corvis_facts.holding h
      where h.tenant_id=p_tenant_id and h.holding_id=holding_uuid
        and h.fund_id=fund_id_value and h.target_type=target_type_value
        and h.target_company_id is not distinct from target_company_id_value
        and h.target_fund_id is not distinct from target_fund_id_value
        and h.review_state='approved'
    ) then raise exception 'reviewed holding conflicts with existing tenant/identity state'; end if;
  end loop;

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
      and c.candidate_type='instrument'
    order by c.candidate_key
  loop
    effective_payload := candidate_row.reviewed_payload;
    begin
      instrument_uuid := nullif(btrim(coalesce(effective_payload->>'instrument_id',effective_payload->>'instrumentId','')),'')::uuid;
    exception when others then raise exception 'reviewed instrument candidate requires UUID instrument_id'; end;
    begin
      parent_holding_uuid := nullif(btrim(coalesce(effective_payload->>'holding_id',effective_payload->>'holdingId','')),'')::uuid;
    exception when others then raise exception 'reviewed instrument candidate requires UUID holding_id'; end;
    if instrument_uuid is null or parent_holding_uuid is null then raise exception 'reviewed instrument requires instrument_id and holding_id'; end if;
    if instrument_uuid=any(seen_instrument_ids) then raise exception 'reviewed candidate set contains duplicate instrument_id'; end if;
    seen_instrument_ids := array_append(seen_instrument_ids,instrument_uuid);

    security_name_value := nullif(btrim(coalesce(effective_payload->>'security_name',effective_payload->>'security_description',effective_payload->>'securityName','')),'');
    instrument_type_value := nullif(btrim(coalesce(effective_payload->>'instrument_type',effective_payload->>'instrumentType','')),'');
    if security_name_value is null then raise exception 'reviewed instrument requires exact security_name'; end if;
    if instrument_type_value is null then raise exception 'reviewed instrument requires governed instrument_type'; end if;
    if not exists (
      select 1 from corvis_facts.holding h
      where h.tenant_id=p_tenant_id and h.holding_id=parent_holding_uuid
        and h.target_type='company' and h.review_state='approved'
    ) then raise exception 'reviewed instrument parent holding is unresolved or not company-targeted'; end if;

    begin maturity_date_value := nullif(effective_payload->>'maturity_date','')::date;
    exception when others then raise exception 'reviewed instrument maturity_date is invalid'; end;
    begin coupon_rate_value := nullif(effective_payload->>'coupon_rate','')::numeric(18,8);
    exception when others then raise exception 'reviewed instrument coupon_rate is invalid'; end;

    update corvis_facts.instrument i
    set holding_id=parent_holding_uuid,
        instrument_type=instrument_type_value,
        security_name=security_name_value,
        currency=nullif(effective_payload->>'currency',''),
        seniority=nullif(effective_payload->>'seniority',''),
        maturity_date=maturity_date_value,
        coupon_rate=coupon_rate_value,
        review_state='approved',
        version=i.version+1,
        updated_at=now()
    where i.tenant_id=p_tenant_id and i.instrument_id=instrument_uuid
      and row(i.holding_id,i.instrument_type,i.security_name,i.currency,i.seniority,i.maturity_date,i.coupon_rate,i.review_state)
          is distinct from
          row(parent_holding_uuid,instrument_type_value,security_name_value,
              nullif(effective_payload->>'currency',''),nullif(effective_payload->>'seniority',''),
              maturity_date_value,coupon_rate_value,'approved');

    insert into corvis_facts.instrument (
      tenant_id,instrument_id,holding_id,instrument_type,security_name,currency,seniority,
      maturity_date,coupon_rate,source_reference_id,version,review_state
    )
    select p_tenant_id,instrument_uuid,parent_holding_uuid,instrument_type_value,security_name_value,
      nullif(effective_payload->>'currency',''),nullif(effective_payload->>'seniority',''),
      maturity_date_value,coupon_rate_value,null,1,'approved'
    where not exists (select 1 from corvis_facts.instrument i where i.instrument_id=instrument_uuid)
    on conflict (instrument_id) do nothing;

    if not exists (
      select 1 from corvis_facts.instrument i
      where i.tenant_id=p_tenant_id and i.instrument_id=instrument_uuid
        and i.holding_id=parent_holding_uuid and i.instrument_type=instrument_type_value
        and i.security_name=security_name_value and i.review_state='approved'
    ) then raise exception 'reviewed instrument conflicts with existing tenant/identity state'; end if;
  end loop;

  select * into v_result
  from corvis_facts.canonicalize_reviewed_extraction(
    p_tenant_id,p_document_id,p_extraction_run_id,p_review_policy_version,
    p_candidate_set_sha256,p_decision_set_sha256,p_idempotency_key
  );
  if v_result.canonicalization_run_id is null then raise exception 'canonicalization did not finalize reviewed economic candidates'; end if;

  -- Canonical source references exist now. Attach the deterministic primary
  -- reference to the current projection without creating a new economic version.
  update corvis_facts.holding h
  set source_reference_id=c.source_reference_ids[1]
  from corvis_facts.canonical_candidate c
  where c.tenant_id=p_tenant_id
    and c.canonicalization_run_id=v_result.canonicalization_run_id
    and c.candidate_type='holding'
    and h.tenant_id=c.tenant_id
    and h.holding_id=(coalesce(c.effective_payload->>'holding_id',c.effective_payload->>'holdingId'))::uuid
    and h.source_reference_id is distinct from c.source_reference_ids[1];

  update corvis_facts.instrument i
  set source_reference_id=c.source_reference_ids[1]
  from corvis_facts.canonical_candidate c
  where c.tenant_id=p_tenant_id
    and c.canonicalization_run_id=v_result.canonicalization_run_id
    and c.candidate_type='instrument'
    and i.tenant_id=c.tenant_id
    and i.instrument_id=(coalesce(c.effective_payload->>'instrument_id',c.effective_payload->>'instrumentId'))::uuid
    and i.source_reference_id is distinct from c.source_reference_ids[1];

  insert into corvis_facts.holding_revision (
    tenant_id,holding_id,canonicalization_run_id,candidate_id,candidate_fingerprint_sha256,
    effective_payload,source_reference_ids
  )
  select c.tenant_id,(coalesce(c.effective_payload->>'holding_id',c.effective_payload->>'holdingId'))::uuid,
    c.canonicalization_run_id,c.candidate_id,c.candidate_fingerprint_sha256,c.effective_payload,c.source_reference_ids
  from corvis_facts.canonical_candidate c
  where c.tenant_id=p_tenant_id and c.canonicalization_run_id=v_result.canonicalization_run_id
    and c.candidate_type='holding'
  on conflict do nothing;

  insert into corvis_facts.instrument_revision (
    tenant_id,instrument_id,canonicalization_run_id,candidate_id,candidate_fingerprint_sha256,
    effective_payload,source_reference_ids
  )
  select c.tenant_id,(coalesce(c.effective_payload->>'instrument_id',c.effective_payload->>'instrumentId'))::uuid,
    c.canonicalization_run_id,c.candidate_id,c.candidate_fingerprint_sha256,c.effective_payload,c.source_reference_ids
  from corvis_facts.canonical_candidate c
  where c.tenant_id=p_tenant_id and c.canonicalization_run_id=v_result.canonicalization_run_id
    and c.candidate_type='instrument'
  on conflict do nothing;

  return query select
    v_result.canonicalization_run_id,
    v_result.candidate_count,
    v_result.canonical_candidate_count,
    v_result.observation_count,
    v_result.source_reference_count;
end;
$$;

commit;
