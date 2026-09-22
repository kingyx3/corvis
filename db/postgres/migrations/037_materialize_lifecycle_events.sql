-- Corvis reviewed lifecycle-event materialization v1
-- Depends on migrations 001-036.
--
-- Lifecycle candidates become global durable identity events only after the exact
-- reviewed candidate set has been canonicalized. Private source evidence remains
-- tenant-scoped. Existing global events are never silently overwritten by a
-- tenant report whose facts conflict with already-governed event metadata.

begin;

create table if not exists corvis_identity.tenant_lifecycle_revision (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  lifecycle_event_id uuid not null references corvis_identity.entity_lifecycle_event(lifecycle_event_id),
  canonicalization_run_id uuid not null,
  candidate_id uuid not null,
  candidate_fingerprint_sha256 text not null,
  effective_payload jsonb not null,
  source_reference_ids uuid[] not null,
  recorded_at timestamptz not null default now(),
  primary key (tenant_id,lifecycle_event_id,canonicalization_run_id,candidate_id),
  foreign key (tenant_id,canonicalization_run_id)
    references corvis_facts.canonicalization_run(tenant_id,canonicalization_run_id),
  check (candidate_fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
  check (jsonb_typeof(effective_payload)='object'),
  check (cardinality(source_reference_ids) > 0)
);

alter table corvis_identity.tenant_lifecycle_revision enable row level security;
alter table corvis_identity.tenant_lifecycle_revision force row level security;
create policy tenant_lifecycle_revision_select
  on corvis_identity.tenant_lifecycle_revision
  for select using (corvis_control.has_tenant_access(tenant_id));

create index if not exists tenant_lifecycle_revision_event_idx
  on corvis_identity.tenant_lifecycle_revision
    (tenant_id,lifecycle_event_id,recorded_at desc);

create or replace function corvis_facts.canonicalize_reviewed_extraction_v3(
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
  candidate_row record;
  participant jsonb;
  event_uuid uuid;
  event_type_value text;
  event_status_value text;
  announced_date_value date;
  effective_date_value date;
  closed_date_value date;
  entity_type_value text;
  entity_id_value text;
  role_value text;
  identity_continues_value boolean;
  ownership_before_value numeric(9,6);
  ownership_after_value numeric(9,6);
  supplied_participant_count integer;
  persisted_participant_count integer;
  ref_id uuid;
begin
  -- v2 already verifies the exact ready review gate, materializes economic
  -- holdings/instruments and persists immutable canonical candidates/evidence.
  -- Calling it first gives lifecycle materialization a single authoritative
  -- effective payload and source-reference set. Any failure below rolls v2 back.
  select * into v_result
  from corvis_facts.canonicalize_reviewed_extraction_v2(
    p_tenant_id,p_document_id,p_extraction_run_id,p_review_policy_version,
    p_candidate_set_sha256,p_decision_set_sha256,p_idempotency_key
  );
  if v_result.canonicalization_run_id is null then
    raise exception 'lifecycle materialization requires finalized canonicalization';
  end if;

  for candidate_row in
    select c.*
    from corvis_facts.canonical_candidate c
    where c.tenant_id=p_tenant_id
      and c.canonicalization_run_id=v_result.canonicalization_run_id
      and c.candidate_type='lifecycle_event'
    order by c.candidate_key
  loop
    begin
      event_uuid := nullif(btrim(coalesce(
        candidate_row.effective_payload->>'lifecycle_event_id',
        candidate_row.effective_payload->>'lifecycleEventId',
        candidate_row.effective_payload->>'event_id',
        candidate_row.effective_payload->>'eventId','')),'')::uuid;
    exception when others then
      raise exception 'reviewed lifecycle candidate requires UUID lifecycle_event_id';
    end;
    if event_uuid is null then
      raise exception 'reviewed lifecycle candidate requires lifecycle_event_id';
    end if;

    event_type_value := lower(nullif(btrim(coalesce(
      candidate_row.effective_payload->>'event_type',
      candidate_row.effective_payload->>'eventType','')),''));
    if event_type_value not in (
      'rename','acquisition','merger','demerger','split','spin_off','carve_out',
      'partial_divestiture','reorganization','legal_form_change','domicile_change',
      'formation','dissolution','liquidation','fund_restructure','manager_change',
      'listing','delisting','take_private','successor_transition','other'
    ) then
      raise exception 'reviewed lifecycle candidate requires governed event_type';
    end if;

    event_status_value := lower(coalesce(nullif(btrim(coalesce(
      candidate_row.effective_payload->>'event_status',
      candidate_row.effective_payload->>'eventStatus','')),''),'completed'));
    if event_status_value not in ('announced','pending','completed','cancelled','unknown') then
      raise exception 'reviewed lifecycle candidate requires governed event_status';
    end if;

    begin announced_date_value := nullif(coalesce(candidate_row.effective_payload->>'announced_date',candidate_row.effective_payload->>'announcedDate'),'')::date;
    exception when others then raise exception 'reviewed lifecycle announced_date is invalid'; end;
    begin effective_date_value := nullif(coalesce(candidate_row.effective_payload->>'effective_date',candidate_row.effective_payload->>'effectiveDate'),'')::date;
    exception when others then raise exception 'reviewed lifecycle effective_date is invalid'; end;
    begin closed_date_value := nullif(coalesce(candidate_row.effective_payload->>'closed_date',candidate_row.effective_payload->>'closedDate'),'')::date;
    exception when others then raise exception 'reviewed lifecycle closed_date is invalid'; end;
    if closed_date_value is not null and effective_date_value is not null and closed_date_value < effective_date_value then
      raise exception 'reviewed lifecycle closed_date precedes effective_date';
    end if;

    if jsonb_typeof(candidate_row.effective_payload->'participants') <> 'array'
      or jsonb_array_length(candidate_row.effective_payload->'participants')=0 then
      raise exception 'reviewed lifecycle candidate requires participant array';
    end if;
    supplied_participant_count := jsonb_array_length(candidate_row.effective_payload->'participants');

    insert into corvis_identity.entity_lifecycle_event (
      lifecycle_event_id,event_type,event_status,announced_date,effective_date,closed_date,
      event_subtype_raw,description,source_kind
    ) values (
      event_uuid,event_type_value,event_status_value,announced_date_value,effective_date_value,closed_date_value,
      nullif(coalesce(candidate_row.effective_payload->>'event_subtype_raw',candidate_row.effective_payload->>'eventSubtypeRaw'),''),
      nullif(candidate_row.effective_payload->>'description',''),'tenant_evidence'
    ) on conflict (lifecycle_event_id) do nothing;

    if not exists (
      select 1 from corvis_identity.entity_lifecycle_event e
      where e.lifecycle_event_id=event_uuid
        and e.event_type=event_type_value
        and e.event_status=event_status_value
        and e.announced_date is not distinct from announced_date_value
        and e.effective_date is not distinct from effective_date_value
        and e.closed_date is not distinct from closed_date_value
        and e.event_subtype_raw is not distinct from nullif(coalesce(candidate_row.effective_payload->>'event_subtype_raw',candidate_row.effective_payload->>'eventSubtypeRaw'),'')
        and e.description is not distinct from nullif(candidate_row.effective_payload->>'description','')
    ) then
      raise exception 'reviewed lifecycle candidate conflicts with existing governed event';
    end if;

    for participant in
      select value from jsonb_array_elements(candidate_row.effective_payload->'participants')
    loop
      if jsonb_typeof(participant) <> 'object' then
        raise exception 'reviewed lifecycle participant must be an object';
      end if;
      entity_type_value := lower(nullif(btrim(coalesce(participant->>'entity_type',participant->>'entityType','')),''));
      entity_id_value := nullif(btrim(coalesce(participant->>'entity_id',participant->>'entityId','')),'');
      role_value := lower(nullif(btrim(coalesce(participant->>'participant_role',participant->>'participantRole',participant->>'role','')),''));
      if entity_type_value not in ('fund','company') or entity_id_value is null then
        raise exception 'reviewed lifecycle participant requires fund/company entity identity';
      end if;
      if role_value not in (
        'subject','predecessor','successor','acquirer','acquired','surviving_entity',
        'merged_constituent','source_entity','resulting_entity','parent','child',
        'seller','buyer','transferred_entity','other'
      ) then
        raise exception 'reviewed lifecycle participant requires governed participant_role';
      end if;
      if entity_type_value='fund' and not exists (
        select 1 from corvis_identity.fund f where f.global_fund_id=entity_id_value
      ) then raise exception 'reviewed lifecycle fund participant identity is unresolved'; end if;
      if entity_type_value='company' and not exists (
        select 1 from corvis_identity.company c where c.global_company_id=entity_id_value
      ) then raise exception 'reviewed lifecycle company participant identity is unresolved'; end if;

      if participant ? 'economic_identity_continues' then
        begin identity_continues_value := (participant->>'economic_identity_continues')::boolean;
        exception when others then raise exception 'reviewed lifecycle participant economic_identity_continues is invalid'; end;
      elsif participant ? 'economicIdentityContinues' then
        begin identity_continues_value := (participant->>'economicIdentityContinues')::boolean;
        exception when others then raise exception 'reviewed lifecycle participant economicIdentityContinues is invalid'; end;
      else identity_continues_value := null;
      end if;
      begin ownership_before_value := nullif(coalesce(participant->>'ownership_before',participant->>'ownershipBefore'),'')::numeric(9,6);
      exception when others then raise exception 'reviewed lifecycle ownership_before is invalid'; end;
      begin ownership_after_value := nullif(coalesce(participant->>'ownership_after',participant->>'ownershipAfter'),'')::numeric(9,6);
      exception when others then raise exception 'reviewed lifecycle ownership_after is invalid'; end;
      if ownership_before_value is not null and (ownership_before_value < 0 or ownership_before_value > 1) then raise exception 'reviewed lifecycle ownership_before is outside 0..1'; end if;
      if ownership_after_value is not null and (ownership_after_value < 0 or ownership_after_value > 1) then raise exception 'reviewed lifecycle ownership_after is outside 0..1'; end if;

      insert into corvis_identity.entity_lifecycle_participant (
        lifecycle_event_id,fund_id,company_id,participant_role,economic_identity_continues,
        ownership_before,ownership_after,notes
      ) values (
        event_uuid,
        case when entity_type_value='fund' then entity_id_value else null end,
        case when entity_type_value='company' then entity_id_value else null end,
        role_value,identity_continues_value,ownership_before_value,ownership_after_value,
        nullif(participant->>'notes','')
      ) on conflict do nothing;

      if not exists (
        select 1 from corvis_identity.entity_lifecycle_participant p
        where p.lifecycle_event_id=event_uuid
          and p.participant_role=role_value
          and ((entity_type_value='fund' and p.fund_id=entity_id_value and p.company_id is null)
            or (entity_type_value='company' and p.company_id=entity_id_value and p.fund_id is null))
          and p.economic_identity_continues is not distinct from identity_continues_value
          and p.ownership_before is not distinct from ownership_before_value
          and p.ownership_after is not distinct from ownership_after_value
          and p.notes is not distinct from nullif(participant->>'notes','')
      ) then
        raise exception 'reviewed lifecycle participant conflicts with existing governed participant';
      end if;
    end loop;

    select count(*)::integer into persisted_participant_count
    from corvis_identity.entity_lifecycle_participant p
    where p.lifecycle_event_id=event_uuid;
    if persisted_participant_count < supplied_participant_count then
      raise exception 'reviewed lifecycle participant persistence is incomplete';
    end if;

    foreach ref_id in array candidate_row.source_reference_ids
    loop
      insert into corvis_identity.tenant_entity_lifecycle_evidence (
        tenant_id,lifecycle_event_id,source_reference_id,evidence_role,confidence,review_status
      ) values (p_tenant_id,event_uuid,ref_id,'supporting',null,'approved')
      on conflict (tenant_id,lifecycle_event_id,source_reference_id)
      do update set review_status='approved';
    end loop;

    insert into corvis_identity.tenant_lifecycle_revision (
      tenant_id,lifecycle_event_id,canonicalization_run_id,candidate_id,
      candidate_fingerprint_sha256,effective_payload,source_reference_ids
    ) values (
      p_tenant_id,event_uuid,v_result.canonicalization_run_id,candidate_row.candidate_id,
      candidate_row.candidate_fingerprint_sha256,candidate_row.effective_payload,candidate_row.source_reference_ids
    ) on conflict do nothing;
  end loop;

  return query select
    v_result.canonicalization_run_id,
    v_result.candidate_count,
    v_result.canonical_candidate_count,
    v_result.observation_count,
    v_result.source_reference_count;
end;
$$;

commit;
