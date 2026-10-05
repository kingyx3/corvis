import { AuthorizationError, type RequestIdentity } from "../../core/enterprise.ts";
import { nameOrder, SCORECARD_METRIC_CODES, scorecardPeriodOptions, type ScorecardFact, type ScorecardFilters, type ScorecardFund, type ScorecardPayload } from "../../core/performance-scorecard.ts";
import { getServerConfig } from "./config.ts";
import { decodeCursor, encodeCursor, InvalidCursorError } from "./pagination.ts";
import { postgres, type PostgresPrimitive, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";

/**
 * Upper bound on the facts one scorecard *page* reads. The query already reduces each subject/metric/currency to its single
 * latest fact, so this is far above any realistic fund. The scorecard is read by fund (keyset pages), so a tenant whose total
 * is above it still loads: a page that would exceed it is halved and retried, never truncated, because truncating silently
 * would turn published figures into false "Not reported" cells. Only a single fund above the cap fails the request.
 */
export const SCORECARD_MAX_FACTS = 50_000;
/** Funds per page when the caller does not say, and the most a caller may ask for. */
export const SCORECARD_DEFAULT_PAGE_FUNDS = 25;
export const SCORECARD_MAX_PAGE_FUNDS = 100;

export class ScorecardTooLargeError extends Error {
  readonly code = "performance_scorecard_too_large";
  constructor() {
    super(`A single fund of the performance scorecard has more than ${SCORECARD_MAX_FACTS} reported figures; narrow the scorecard to a period`);
    this.name = "ScorecardTooLargeError";
  }
}

export type PerformanceScorecardQuery = ScorecardFilters & {
  /** Restrict to these published snapshots (a governed export pins the snapshots it was requested for). */
  snapshotIds?: readonly string[];
};

export type ScorecardPageRequest = {
  /** Opaque cursor of the previous page (the keyset of its last fund); absent for the first page. */
  cursor?: string | null;
  /** Funds per page, 1 to SCORECARD_MAX_PAGE_FUNDS. A page may hold fewer when its figures would exceed the cap. */
  limit?: number;
  /** Also compute the reporting periods the scorecard can be filtered by (the view asks on its first page only). */
  periods?: boolean;
};

export type ScorecardPageResult = {
  /** The page's funds (complete) and every figure of those funds. */
  payload: ScorecardPayload;
  /** Every entitled fund, whatever the filters, for the fund filter. */
  fundOptions: ScorecardFund[];
  /** Every period with a published figure; empty unless the request asked for it (`periods`). */
  periodOptions: string[];
  nextCursor: string | null;
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
 * The facts of the entitled funds' current published snapshots, up to the ranking CTE `ranked_fact` (which keeps the latest fact
 * per fund, subject, metric, currency and unit). Positional parameters: $1 tenant, $2 funds, $3 entitled documents, $4 metric codes,
 * then the optional snapshot pin and period filter, whose placeholders the caller supplies.
 */
function factChain(snapshotPredicate: string, periodPredicate: string): string {
  return `with current_snapshot as (
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
          and nullif(btrim(f.value->'semanticDimensions'->>'lookthroughSource'),'') is null${periodPredicate}
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
      )`;
}

function encodePageCursor(fund: ScorecardFund): string { return encodeCursor(JSON.stringify([fund.fund, fund.fundId])); }

function decodePageCursor(cursor: string): { name: string; id: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(decodeCursor(cursor)); } catch { throw new InvalidCursorError(); }
  if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "string" || typeof parsed[1] !== "string") throw new InvalidCursorError();
  return { name: parsed[0], id: parsed[1] };
}

/** Funds per page for a requested size: the default when absent, never below 1 or above SCORECARD_MAX_PAGE_FUNDS. */
export function scorecardPageSize(limit: number | undefined): number {
  return Math.min(Math.max(Math.trunc(limit ?? SCORECARD_DEFAULT_PAGE_FUNDS), 1), SCORECARD_MAX_PAGE_FUNDS);
}

/**
 * The funds after the cursor's keyset position, in scorecard order. The cursor is decoded here, so a tampered one fails
 * (`InvalidCursorError`) before anything is read; one whose fund has since left the list still resumes after its position.
 */
export function fundsAfterCursor(funds: readonly ScorecardFund[], cursor: string | null | undefined): ScorecardFund[] {
  if (!cursor) return [...funds];
  const after = decodePageCursor(cursor);
  return funds.filter((fund) => nameOrder({ name: fund.fund, id: fund.fundId }, { name: after.name, id: after.id }) > 0);
}

/** The cursor of the page that ends the given funds, or null when it ends the scorecard. */
export function nextFundCursor(page: readonly ScorecardFund[], remainingCount: number): string | null {
  return page.length < remainingCount ? encodePageCursor(page[page.length - 1]!) : null;
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
 *
 * Filters (F1c): `fundId` narrows to one entitled fund (a fund the caller is not entitled to is refused, never ignored);
 * `period` keeps only the facts stated for that reporting period *before* the latest one is chosen, so the figures shown are
 * the latest of that period and an older period never degrades into "Not reported".
 *
 * Paging (F1c): funds are paged by keyset on (name, id), the order the scorecard lists them in. A fund's figures are read
 * whole, in one query per page, so a tenant of any size loads page by page and a figure is never dropped to fit.
 */
export class PostgresPerformanceScorecardRepository {
  private readonly db: PostgresSqlApi;
  constructor(db: PostgresSqlApi) { this.db = db; }

  /** Every entitled fund, in scorecard order. */
  private async entitledFunds(fundIds: readonly string[]): Promise<ScorecardFund[]> {
    const rows = await this.db.query(`select a.fund_id,coalesce(f.canonical_name,a.fund_id) as fund_name
      from (select distinct value as fund_id from jsonb_array_elements_text($1::jsonb)) a
      left join corvis_identity.fund f on f.global_fund_id=a.fund_id
      order by coalesce(f.canonical_name,a.fund_id),a.fund_id`, [jsonList(fundIds)]);
    return rows.map((row): ScorecardFund => ({ fundId: text(row, "fund_id"), fund: text(row, "fund_name") }))
      .sort((a, b) => nameOrder({ name: a.fund, id: a.fundId }, { name: b.fund, id: b.fundId }));
  }

  private parameters(identity: RequestIdentity, fundIds: readonly string[], query: PerformanceScorecardQuery): { values: PostgresPrimitive[]; snapshotPredicate: string; periodPredicate: string } {
    const values: PostgresPrimitive[] = [identity.tenantId, jsonList(fundIds), jsonList(identity.entitlements.documentIds!), jsonList(SCORECARD_METRIC_CODES)];
    let snapshotPredicate = "";
    if (query.snapshotIds) {
      values.push(jsonList(query.snapshotIds));
      snapshotPredicate = `\n          and s.snapshot_id::text in (select jsonb_array_elements_text($${values.length}::jsonb))`;
    }
    let periodPredicate = "";
    if (query.period !== undefined) {
      values.push(query.period);
      periodPredicate = `\n          and coalesce(nullif(f.economic_period,''),cs.report_period)=$${values.length}`;
    }
    return { values, snapshotPredicate, periodPredicate };
  }

  /** The latest facts of exactly these funds. Fails (rather than truncating) above SCORECARD_MAX_FACTS. */
  private async facts(identity: RequestIdentity, fundIds: readonly string[], query: PerformanceScorecardQuery): Promise<ScorecardFact[]> {
    const { values, snapshotPredicate, periodPredicate } = this.parameters(identity, fundIds, query);
    const rows = await this.db.query(`${factChain(snapshotPredicate, periodPredicate)}
      select fact_id::text as fact_id,snapshot_id::text as snapshot_id,published_at,fund_id,level,investment_key,investment_name,
             holding_id,company_id,metric_code,value_number,value_string,value_raw,currency,unit,as_of,
             coalesce(nullif(economic_period,''),report_period) as economic_period,
             actuality,scenario_type,is_restated,is_derived,derivation_formula,
             document_id,source_reference_id,page_number,sheet_name,cell_range
      from ranked_fact
      where latest_rank=1
      order by fund_id,level,investment_key nulls first,metric_code,as_of desc nulls last,fact_id
      limit ${SCORECARD_MAX_FACTS + 1}`, values);
    if (rows.length > SCORECARD_MAX_FACTS) throw new ScorecardTooLargeError();
    return rows.map(mapFact);
  }

  /** Every reporting period that has a figure the caller can see, latest first, ignoring the period filter itself. */
  private async periodOptions(identity: RequestIdentity, fundIds: readonly string[], query: PerformanceScorecardQuery): Promise<string[]> {
    const { values, snapshotPredicate } = this.parameters(identity, fundIds, { snapshotIds: query.snapshotIds });
    const rows = await this.db.query(`${factChain(snapshotPredicate, "")}
      select coalesce(nullif(economic_period,''),report_period) as period,max(as_of) as as_of
      from sourced_fact
      group by 1`, values);
    return scorecardPeriodOptions(rows.map((row) => ({ period: text(row, "period"), asOf: nullableText(row, "as_of") })));
  }

  /**
   * One page of whole funds. `request.cursor` is the previous page's `nextCursor`; a page is `limit` funds (default
   * SCORECARD_DEFAULT_PAGE_FUNDS) unless their figures would exceed the cap, in which case the page is halved until they fit.
   */
  async loadPage(identity: RequestIdentity, query: PerformanceScorecardQuery = {}, request: ScorecardPageRequest = {}): Promise<ScorecardPageResult> {
    const entitledIds = identity.entitlements.fundIds ?? [];
    const documentIds = identity.entitlements.documentIds ?? [];
    // Without both entitlements nothing may be shown: fail closed rather than list funds with empty cells.
    if (entitledIds.length === 0 || documentIds.length === 0) return { payload: { funds: [], facts: [] }, fundOptions: [], periodOptions: [], nextCursor: null };
    if (query.fundId !== undefined && !entitledIds.includes(query.fundId)) throw new AuthorizationError("performance_scorecard:fund");
    const fundOptions = await this.entitledFunds(entitledIds);
    // A tampered cursor fails here, before any figure is read; it is only ever compared with fund names, never bound into SQL.
    const remaining = fundsAfterCursor(fundOptions.filter((fund) => query.fundId === undefined || fund.fundId === query.fundId), request.cursor);

    let size = Math.min(scorecardPageSize(request.limit), remaining.length);
    let facts: ScorecardFact[] = [];
    while (size > 0) {
      try {
        facts = await this.facts(identity, remaining.slice(0, size).map((fund) => fund.fundId), query);
        break;
      } catch (error) {
        // Halve and retry: the page gets smaller, no figure is ever left out. One fund over the cap cannot be split, so it fails.
        if (!(error instanceof ScorecardTooLargeError) || size === 1) throw error;
        size = Math.ceil(size / 2);
      }
    }
    const page = remaining.slice(0, size);
    const periodOptions = request.periods ? await this.periodOptions(identity, entitledIds, query) : [];
    return { payload: { funds: page, facts }, fundOptions, periodOptions, nextCursor: nextFundCursor(page, remaining.length) };
  }

  /** Every page in turn, for a reader that needs the whole scorecard (a governed export) without holding it all at once. */
  async *pages(identity: RequestIdentity, query: PerformanceScorecardQuery = {}): AsyncGenerator<ScorecardPayload> {
    let cursor: string | null = null;
    do {
      const page: ScorecardPageResult = await this.loadPage(identity, query, { cursor, limit: SCORECARD_MAX_PAGE_FUNDS });
      yield page.payload;
      cursor = page.nextCursor;
    } while (cursor !== null);
  }

  /** The whole scorecard: every page, concatenated. */
  async load(identity: RequestIdentity, query: PerformanceScorecardQuery = {}): Promise<ScorecardPayload> {
    const all: ScorecardPayload = { funds: [], facts: [] };
    for await (const page of this.pages(identity, query)) {
      all.funds.push(...page.funds);
      all.facts.push(...page.facts);
    }
    return all;
  }
}

let singleton: PostgresPerformanceScorecardRepository | undefined;
export function performanceScorecard(dsn = getServerConfig().postgresDsn): PostgresPerformanceScorecardRepository {
  if (!singleton) singleton = new PostgresPerformanceScorecardRepository(postgres(dsn));
  return singleton;
}
