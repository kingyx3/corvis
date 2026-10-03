import type { RequestIdentity } from "../../core/enterprise.ts";
import { SCORECARD_METRIC_CODES, type ScorecardFact, type ScorecardFund, type ScorecardPayload } from "../../core/performance-scorecard.ts";
import { getServerConfig } from "./config.ts";
import { postgres, type PostgresPrimitive, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";

/**
 * Upper bound on the facts one scorecard load reads. The query already reduces each subject/metric/currency
 * to its single latest fact, so this is far above any realistic tenant. Truncating silently would turn
 * published figures into false "Not reported" cells, so exceeding it fails the request instead.
 */
export const SCORECARD_MAX_FACTS = 50_000;

export class ScorecardTooLargeError extends Error {
  readonly code = "performance_scorecard_too_large";
  constructor() {
    super(`The performance scorecard has more than ${SCORECARD_MAX_FACTS} reported figures; narrow the entitled scope`);
    this.name = "ScorecardTooLargeError";
  }
}

export type PerformanceScorecardQuery = {
  /** Restrict to these published snapshots (a governed export pins the snapshots it was requested for). */
  snapshotIds?: readonly string[];
};

function text(row: PostgresRow, key: string): string { return row[key] == null ? "" : String(row[key]); }
function nullableText(row: PostgresRow, key: string): string | null {
  const value = row[key];
  return value == null || String(value) === "" ? null : String(value);
}
function nullableNumber(row: PostgresRow, key: string): number | null {
  if (row[key] == null) return null;
  const value = Number(row[key]);
  return Number.isFinite(value) ? value : null;
}
function bool(row: PostgresRow, key: string): boolean { return row[key] === true || row[key] === "true"; }
function timestamp(row: PostgresRow, key: string): string | null {
  const value = row[key];
  if (value == null || value === "") return null;
  return value instanceof Date ? value.toISOString() : String(value);
}
function jsonList(values: readonly string[]): string { return JSON.stringify(values); }

function mapFact(row: PostgresRow): ScorecardFact {
  return {
    factId: text(row, "fact_id"),
    snapshotId: text(row, "snapshot_id"),
    publishedAt: timestamp(row, "published_at"),
    fundId: text(row, "fund_id"),
    level: text(row, "level") === "fund" ? "fund" : "investment",
    investmentKey: nullableText(row, "investment_key"),
    investment: nullableText(row, "investment_name"),
    holdingId: nullableText(row, "holding_id"),
    companyId: nullableText(row, "company_id"),
    metricCode: text(row, "metric_code"),
    valueNumber: nullableText(row, "value_number"),
    valueString: nullableText(row, "value_string"),
    valueRaw: nullableText(row, "value_raw"),
    currency: nullableText(row, "currency"),
    unit: nullableText(row, "unit"),
    asOf: nullableText(row, "as_of"),
    period: text(row, "economic_period"),
    actuality: nullableText(row, "actuality"),
    scenarioType: nullableText(row, "scenario_type"),
    isRestated: bool(row, "is_restated"),
    isDerived: bool(row, "is_derived"),
    derivationFormula: nullableText(row, "derivation_formula"),
    source: {
      documentId: text(row, "document_id"),
      sourceReferenceId: text(row, "source_reference_id"),
      page: nullableNumber(row, "page_number"),
      sheetName: nullableText(row, "sheet_name"),
      cellRange: nullableText(row, "cell_range"),
    },
  };
}

/**
 * Published, GP-reported fund and investment performance facts for the Analytics scorecard.
 *
 * Source of truth: consolidated facts of every entitled fund snapshot whose *current* version is published
 * (a draft, blocked, withdrawn or superseded version contributes nothing, exactly like the Overview rollup).
 * A conflicting alternative, a breakdown row and a look-through row are left out, as is anything whose source
 * document the caller is not entitled to: a figure with no entitled source is not served.
 *
 * Each fact is served with the first entitled source reference of its first source observation (document, page,
 * sheet, cells) so every figure drills through to its document. Per fund, subject, metric, currency and unit only
 * the latest fact is returned. Its order (as-of date, publication time, snapshot id, fact id; undated and
 * unpublished last) is the order of `compareLatestFirst` in core/performance-scorecard.ts, which makes the final
 * selection among the returned candidates.
 */
export class PostgresPerformanceScorecardRepository {
  private readonly db: PostgresSqlApi;
  constructor(db: PostgresSqlApi) { this.db = db; }

  async load(identity: RequestIdentity, query: PerformanceScorecardQuery = {}): Promise<ScorecardPayload> {
    const fundIds = identity.entitlements.fundIds ?? [];
    const documentIds = identity.entitlements.documentIds ?? [];
    // Without both entitlements nothing may be shown: fail closed rather than list funds with empty cells.
    if (fundIds.length === 0 || documentIds.length === 0) return { funds: [], facts: [] };

    const fundRows = await this.db.query(`select a.fund_id,coalesce(f.canonical_name,a.fund_id) as fund_name
      from (select distinct value as fund_id from jsonb_array_elements_text($1::jsonb)) a
      left join corvis_identity.fund f on f.global_fund_id=a.fund_id
      order by coalesce(f.canonical_name,a.fund_id),a.fund_id`, [jsonList(fundIds)]);
    const funds: ScorecardFund[] = fundRows.map((row) => ({ fundId: text(row, "fund_id"), fund: text(row, "fund_name") }));

    const parameters: PostgresPrimitive[] = [identity.tenantId, jsonList(fundIds), jsonList(documentIds), jsonList(SCORECARD_METRIC_CODES)];
    let snapshotPredicate = "";
    if (query.snapshotIds) {
      parameters.push(jsonList(query.snapshotIds));
      snapshotPredicate = `\n          and s.snapshot_id::text in (select jsonb_array_elements_text($${parameters.length}::jsonb))`;
    }
    const rows = await this.db.query(`with current_snapshot as (
        select distinct on (s.snapshot_id)
               s.tenant_id,s.snapshot_id,s.version,s.fund_id,s.report_period,s.status,s.fact_ids,s.published_at
        from corvis_consolidated.fund_period_snapshot s
        where s.tenant_id=$1::uuid
          and s.fund_id in (select jsonb_array_elements_text($2::jsonb))${snapshotPredicate}
        order by s.snapshot_id,s.version desc
      ), published_fact as (
        select cs.snapshot_id,cs.fund_id,cs.report_period,cs.published_at,
               f.consolidated_fact_id as fact_id,f.metric_code,f.subject_id,f.economic_period,f.source_observation_ids,
               coalesce(nullif(btrim(f.value->'semanticDimensions'->>'subjectLevel'),''),f.subject_type) as subject_level,
               f.value->>'number' as value_number,
               f.value->>'string' as value_string,
               f.value->>'raw' as value_raw,
               f.value->>'currency' as currency,
               f.value->>'unit' as unit,
               coalesce(nullif(btrim(f.value->'semanticDimensions'->>'asOfDate'),''),nullif(btrim(f.value->'semanticDimensions'->>'periodEnd'),'')) as as_of,
               nullif(btrim(f.value->'semanticDimensions'->>'actuality'),'') as actuality,
               nullif(btrim(f.value->'semanticDimensions'->>'scenarioType'),'') as scenario_type,
               coalesce(f.value->'semanticDimensions'->>'isRestated','')='true' as is_restated,
               coalesce(f.value->'semanticDimensions'->>'isDerived','')='true' as is_derived,
               nullif(btrim(f.value->'semanticDimensions'->>'derivationFormula'),'') as derivation_formula
        from current_snapshot cs
        cross join lateral unnest(cs.fact_ids) as published(fact_id)
        join corvis_consolidated.consolidated_fact f
          on f.tenant_id=cs.tenant_id and f.consolidated_fact_id=published.fact_id and f.fund_id=cs.fund_id
        where cs.status='published'
          and f.metric_code in (select jsonb_array_elements_text($4::jsonb))
          and coalesce(f.value->>'semanticGrainRelationship','')<>'conflicting_alternative'
          and nullif(btrim(f.value->'semanticDimensions'->>'breakdownCategory'),'') is null
          and nullif(btrim(f.value->'semanticDimensions'->>'lookthroughSource'),'') is null
      ), scoped_fact as (
        select pf.*,
               case when pf.subject_level='fund' then 'fund' else 'investment' end as level
        from published_fact pf
        where pf.subject_level in ('fund','holding','company')
      ), identified_fact as (
        select sf.*,
               h.target_fund_id,
               case when sf.subject_level='holding' then sf.subject_id end as holding_id,
               co.global_company_id as company_id,
               coalesce(co.canonical_name,tf.canonical_name) as investment_name,
               case when sf.level='investment' then coalesce(co.global_company_id,h.target_fund_id,sf.subject_id) end as investment_key
        from scoped_fact sf
        left join corvis_serving.holdings h
          on sf.subject_level='holding' and h.tenant_id=$1::uuid and h.holding_id::text=sf.subject_id and h.fund_id=sf.fund_id
        left join corvis_identity.company co
          on co.global_company_id=case when sf.subject_level='company' then sf.subject_id else h.target_company_id end
        left join corvis_identity.fund tf
          on tf.global_fund_id=h.target_fund_id
      ), sourced_fact as (
        select idf.*,src.document_id,src.source_reference_id,src.page_number,src.sheet_name,src.cell_range
        from identified_fact idf
        cross join lateral (
          select r.document_id::text as document_id,r.source_reference_id::text as source_reference_id,
                 r.page_number,r.sheet_name,r.cell_range
          from unnest(idf.source_observation_ids) with ordinality as source_observation(observation_id,ordinal)
          join corvis_facts.observation_source_reference osr
            on osr.tenant_id=$1::uuid and osr.observation_id=source_observation.observation_id
          join corvis_source.source_reference r
            on r.tenant_id=osr.tenant_id and r.source_reference_id=osr.source_reference_id
          where r.document_id in (select entitled.id::uuid from jsonb_array_elements_text($3::jsonb) as entitled(id) where entitled.id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
          order by source_observation.ordinal,osr.ordinal,r.source_reference_id
          limit 1
        ) src
      ), ranked_fact as (
        select sf.*,
               row_number() over (
                 partition by sf.fund_id,sf.level,sf.investment_key,sf.metric_code,coalesce(lower(btrim(sf.currency)),''),coalesce(lower(btrim(sf.unit)),'')
                 order by sf.as_of desc nulls last,sf.published_at desc nulls last,sf.snapshot_id desc,sf.fact_id desc
               ) as latest_rank
        from sourced_fact sf
      )
      select fact_id::text as fact_id,snapshot_id::text as snapshot_id,published_at,fund_id,level,investment_key,investment_name,
             holding_id,company_id,metric_code,value_number,value_string,value_raw,currency,unit,as_of,
             coalesce(nullif(economic_period,''),report_period) as economic_period,
             actuality,scenario_type,is_restated,is_derived,derivation_formula,
             document_id,source_reference_id,page_number,sheet_name,cell_range
      from ranked_fact
      where latest_rank=1
      order by fund_id,level,investment_key nulls first,metric_code,as_of desc nulls last,fact_id
      limit ${SCORECARD_MAX_FACTS + 1}`, parameters);
    if (rows.length > SCORECARD_MAX_FACTS) throw new ScorecardTooLargeError();
    return { funds, facts: rows.map(mapFact) };
  }
}

let singleton: PostgresPerformanceScorecardRepository | undefined;
export function performanceScorecard(dsn = getServerConfig().postgresDsn): PostgresPerformanceScorecardRepository {
  if (!singleton) singleton = new PostgresPerformanceScorecardRepository(postgres(dsn));
  return singleton;
}
