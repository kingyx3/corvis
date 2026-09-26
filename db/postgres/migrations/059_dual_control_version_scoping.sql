-- Fixes a dual-control bypass: corvis_facts.apply_review_decision's
-- critical-observation "2 distinct approvers" count (migration 005) and the
-- approved_reviewer_count exposed by corvis_serving.observations (migration
-- 058) both counted every approve review_event ever recorded for an
-- observation_id, with no regard for corrections. Because a 'correct'
-- decision changes the value and resets review_state to 'review_required'
-- without invalidating prior review_events, a stale approval recorded
-- before a correction could combine with a single fresh approval on the
-- corrected value to satisfy the second-approver requirement -- silently
-- bypassing dual control on the data that actually ships.
--
-- The count cannot simply be scoped to the observation's *current* version:
-- apply_review_decision increments `version` on every decision (approve,
-- reject or correct), so two approvals on the same never-corrected value
-- are recorded at two different observation_versions, and matching on the
-- exact current version would make the two-approver requirement
-- unsatisfiable in the common case. Instead, scope the count to approvals
-- recorded at or after the version following the most recent correction (or
-- all approvals, if the observation has never been corrected), which
-- resets the count exactly when the underlying value changes.

create index if not exists review_event_tenant_observation_decision_idx
  on corvis_facts.review_event (tenant_id, observation_id, decision);

create or replace function corvis_facts.apply_review_decision(
  p_tenant_id uuid,
  p_observation_id uuid,
  p_expected_version integer,
  p_review_event_id uuid,
  p_actor_subject text,
  p_decision text,
  p_reason_code text,
  p_corrected_value text default null
)
returns table(new_version integer, next_state text)
language plpgsql
security invoker
as $$
declare
  current_row corvis_facts.observation%rowtype;
  computed_state text;
  reviewer_count integer;
  since_version integer;
begin
  select * into current_row
  from corvis_facts.observation
  where tenant_id=p_tenant_id and observation_id=p_observation_id and version=p_expected_version
  for update;

  if not found then
    return;
  end if;

  if p_decision not in ('approve','reject','correct') then
    raise exception 'invalid review decision';
  end if;
  if p_decision='correct' and p_corrected_value is null then
    raise exception 'corrected value is required';
  end if;

  insert into corvis_facts.review_event
    (tenant_id,review_event_id,observation_id,actor_subject,decision,reason_code,before_value,after_value,observation_version,created_at)
  values (
    p_tenant_id,p_review_event_id,p_observation_id,p_actor_subject,p_decision,p_reason_code,
    jsonb_build_object('valueNumber',current_row.value_number,'valueString',current_row.value_string,'reviewState',current_row.review_state),
    case when p_decision='correct'
      then jsonb_build_object('valueString',p_corrected_value,'reviewState','review_required')
      else jsonb_build_object('valueNumber',current_row.value_number,'valueString',current_row.value_string,'reviewState',case when p_decision='reject' then 'rejected' else 'approved' end)
    end,
    p_expected_version,now()
  );

  if p_decision='correct' then
    insert into corvis_facts.observation_correction
      (tenant_id,observation_id,based_on_observation_version,corrected_value_string,reason_code,actor_subject)
    values (p_tenant_id,p_observation_id,p_expected_version,p_corrected_value,p_reason_code,p_actor_subject);
    computed_state := 'review_required';
  elsif p_decision='reject' then
    computed_state := 'rejected';
  elsif current_row.risk_tier='critical' then
    select coalesce(max(based_on_observation_version) + 1, 0) into since_version
    from corvis_facts.observation_correction
    where tenant_id=p_tenant_id and observation_id=p_observation_id;

    select count(distinct actor_subject) into reviewer_count
    from corvis_facts.review_event
    where tenant_id=p_tenant_id and observation_id=p_observation_id and decision='approve'
      and observation_version >= since_version;
    computed_state := case when reviewer_count >= 2 then 'approved' else 'review_required' end;
  else
    computed_state := 'approved';
  end if;

  update corvis_facts.observation
  set review_state=computed_state, version=version+1, updated_at=now()
  where tenant_id=p_tenant_id and observation_id=p_observation_id and version=p_expected_version;

  return query select p_expected_version + 1, computed_state;
end;
$$;

create or replace view corvis_serving.observations as
with latest_correction as (
  select distinct on (tenant_id, observation_id)
         tenant_id, observation_id, corrected_value_string, corrected_value_number,
         based_on_observation_version, created_at
  from corvis_facts.observation_correction
  order by tenant_id, observation_id, created_at desc
)
select o.tenant_id,
       o.observation_id,
       o.fund_id,
       o.company_id,
       o.holding_id,
       o.instrument_id,
       o.metric_code,
       coalesce(lc.corrected_value_number, o.value_number) as value_number,
       coalesce(lc.corrected_value_string, o.value_string) as value_string,
       o.currency,
       o.economic_period,
       o.report_date,
       o.review_state,
       o.source_reference_id,
       o.version,
       o.updated_at,
       c.canonical_name as company_name,
       r.document_id,
       r.page_number,
       r.sheet_name,
       r.cell_range,
       o.confidence_score,
       o.delta_display,
       o.risk_tier,
       (
         select count(distinct actor_subject)::integer
         from corvis_facts.review_event e
         where e.tenant_id=o.tenant_id and e.observation_id=o.observation_id and e.decision='approve'
           and e.observation_version >= coalesce(lc.based_on_observation_version + 1, 0)
       ) as approved_reviewer_count
from corvis_facts.observation o
left join corvis_identity.company c on c.global_company_id = o.company_id
left join corvis_source.source_reference r
  on r.tenant_id=o.tenant_id and r.source_reference_id=o.source_reference_id
left join latest_correction lc
  on lc.tenant_id=o.tenant_id and lc.observation_id=o.observation_id
where o.review_state in ('approved','review_required');
