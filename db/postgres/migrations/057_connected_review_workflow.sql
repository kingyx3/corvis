-- Issue #177 D4/D5: make review causality and prioritization explicit without
-- inventing a global SLA. A deadline is nullable and is expected to be supplied
-- by the tenant/customer workflow that owns the reporting commitment.

alter table corvis_consolidated.fund_period_snapshot
  add column if not exists review_deadline_at timestamptz;

-- Snapshot transitions append a new version. Preserve an explicitly configured
-- deadline across those immutable versions even though older transition
-- functions pre-date the column and therefore do not name it in their INSERT.
create or replace function corvis_consolidated.inherit_snapshot_review_deadline()
returns trigger
language plpgsql
security invoker
as $$
begin
  if new.review_deadline_at is null and new.version > 1 then
    select previous.review_deadline_at
      into new.review_deadline_at
    from corvis_consolidated.fund_period_snapshot previous
    where previous.tenant_id=new.tenant_id
      and previous.snapshot_id=new.snapshot_id
      and previous.version < new.version
    order by previous.version desc
    limit 1;
  end if;
  return new;
end;
$$;

drop trigger if exists fund_period_snapshot_inherit_review_deadline on corvis_consolidated.fund_period_snapshot;
create trigger fund_period_snapshot_inherit_review_deadline
before insert on corvis_consolidated.fund_period_snapshot
for each row execute function corvis_consolidated.inherit_snapshot_review_deadline();

-- Keep the established serving-view prefix intact and append the deadline so
-- existing consumers remain binary/column-order compatible.
create or replace view corvis_serving.fund_period_snapshots as
select s.tenant_id,
       s.snapshot_id,
       s.fund_id,
       s.report_period,
       s.version,
       s.status,
       s.fact_ids,
       case
         when exists (
           select 1 from corvis_consolidated.reconciliation_exception e
           where e.tenant_id=s.tenant_id and e.snapshot_id=s.snapshot_id and e.snapshot_version=s.version
         ) then (
           select count(*)::integer from corvis_consolidated.reconciliation_exception e
           where e.tenant_id=s.tenant_id and e.snapshot_id=s.snapshot_id and e.snapshot_version=s.version and e.status='open'
         )
         else s.blocking_exception_count
       end as blocking_exception_count,
       s.schema_version,
       s.taxonomy_version,
       s.created_at,
       s.published_at,
       f.canonical_name as fund_name,
       cardinality(s.fact_ids) as fact_count,
       s.review_deadline_at
from corvis_consolidated.fund_period_snapshot s
left join corvis_identity.fund f on f.global_fund_id=s.fund_id;

-- Enrich the existing exception contract at the serving boundary. The stored
-- exception remains immutable/auditable; derived context answers the two review
-- questions the UI needs: "which rule fired?" and "what did we publish before?".
-- `competingValues` also binds each current conflicting observation to its
-- primary source reference so deltas can be rendered per competing value.
create or replace view corvis_serving.reconciliation_exceptions as
select e.tenant_id,e.exception_id,e.snapshot_id,e.snapshot_version,e.exception_key,
       e.fund_id,e.report_period,e.exception_type,e.subject_type,e.subject_id,e.metric_code,
       e.summary,e.materiality,e.competing_source_reference_ids,
       coalesce(e.context,'{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
         'triggerRule', case e.exception_type
           when 'reconciliation_conflict' then 'exact_semantic_grain_value_disagreement'
           when 'source_authority' then 'source_authority_selection_required'
           when 'materiality' then 'materiality_review_required'
           else 'reconciliation_review_required'
         end,
         'triggerRuleVersion', coalesce(nullif(e.context->>'policyVersion',''),'reconciliation_v1'),
         'reviewDeadlineAt', current_snapshot.review_deadline_at,
         'priorPublished', (
           select jsonb_build_object(
             'snapshotId', prior.snapshot_id::text,
             'reportPeriod', prior.report_period,
             'publishedAt', prior.published_at,
             'value', fact.value
           )
           from corvis_consolidated.fund_period_snapshot prior
           cross join lateral unnest(prior.fact_ids) published_fact(fact_id)
           join corvis_consolidated.consolidated_fact fact
             on fact.tenant_id=prior.tenant_id
            and fact.consolidated_fact_id=published_fact.fact_id
           where prior.tenant_id=e.tenant_id
             and prior.fund_id=e.fund_id
             and prior.status='published'
             and prior.snapshot_id<>e.snapshot_id
             and prior.report_period<>e.report_period
             and prior.created_at<current_snapshot.created_at
             and e.subject_type is not null
             and e.subject_id is not null
             and e.metric_code is not null
             and fact.subject_type=e.subject_type
             and fact.subject_id=e.subject_id
             and fact.metric_code=e.metric_code
             and coalesce(fact.value->>'semanticGrainRelationship','')<>'conflicting_alternative'
             and not exists (
               select 1 from corvis_consolidated.fund_period_snapshot newer
               where newer.tenant_id=prior.tenant_id
                 and newer.snapshot_id=prior.snapshot_id
                 and newer.version>prior.version
             )
           order by prior.published_at desc nulls last, prior.created_at desc, fact.created_at desc
           limit 1
         ),
         'competingValues', (
           select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'observationId', candidate.item->>'observationId',
             'value', candidate.item->'value',
             'riskTier', candidate.item->>'riskTier',
             'sourceReferenceId', observation.source_reference_id::text
           )) order by candidate.ordinality), '[]'::jsonb)
           from jsonb_array_elements(coalesce(e.context->'observations','[]'::jsonb)) with ordinality candidate(item, ordinality)
           left join corvis_facts.observation observation
             on observation.tenant_id=e.tenant_id
            and observation.observation_id::text=candidate.item->>'observationId'
         )
       )) as context,
       e.status,e.version,e.created_by,e.created_at,e.resolved_by,e.resolved_at
from corvis_consolidated.reconciliation_exception e
join corvis_consolidated.fund_period_snapshot current_snapshot
  on current_snapshot.tenant_id=e.tenant_id
 and current_snapshot.snapshot_id=e.snapshot_id
 and current_snapshot.version=e.snapshot_version;

comment on column corvis_consolidated.fund_period_snapshot.review_deadline_at is
  'Optional tenant/workflow supplied review deadline. Null means no configured deadline; Corvis does not fabricate one.';
