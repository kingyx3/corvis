-- Issue #182 D6: dual-control state ("1st approval recorded, 2nd required")
-- for critical observations is already computed server-side (see
-- corvis_facts.apply_review_decision's reviewer_count logic in migration 005)
-- but was never surfaced past that function. Expose the same distinct-approver
-- count at the serving boundary so the UI can render it and filter on it,
-- without re-deriving or duplicating the approval-counting logic.

-- Keep the established serving-view prefix intact and append the count so
-- existing consumers remain binary/column-order compatible.
create or replace view corvis_serving.observations as
with latest_correction as (
  select distinct on (tenant_id, observation_id)
         tenant_id, observation_id, corrected_value_string, corrected_value_number, created_at
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
       ) as approved_reviewer_count
from corvis_facts.observation o
left join corvis_identity.company c on c.global_company_id = o.company_id
left join corvis_source.source_reference r
  on r.tenant_id=o.tenant_id and r.source_reference_id=o.source_reference_id
left join latest_correction lc
  on lc.tenant_id=o.tenant_id and lc.observation_id=o.observation_id
where o.review_state in ('approved','review_required');
