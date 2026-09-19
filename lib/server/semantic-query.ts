import type { RequestIdentity } from "../../core/enterprise.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";

export type SemanticOperation = "values" | "sum" | "average" | "minimum" | "maximum" | "count";
export type SemanticQueryStatus = "executed" | "unresolved" | "unsupported";

export type GovernedSemanticQueryShape = {
  version: "v2";
  source: "corvis_serving.observations";
  reviewState: "approved";
  fundIds: string[];
  documentIds: string[];
  metricCode?: string;
  metricDisplayName?: string;
  operation: SemanticOperation;
  aggregationBehavior?: string;
  economicPeriodTokens: string[];
  reportYears: number[];
  limit: number;
  status: "planned" | "unresolved" | "unsupported";
  reason?: string;
};

export type GovernedSemanticQueryResult = {
  shape: GovernedSemanticQueryShape;
  rows: PostgresRow[];
  factIds: string[];
  status: SemanticQueryStatus;
};

type MetricCandidate = {
  metricCode: string;
  displayName: string;
  dataType: string;
  aggregationBehavior: string;
};

type MetricMatch = { candidate: MetricCandidate; score: number };

function text(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function containsPhrase(haystack: string, needle: string): boolean {
  if (!needle) return false;
  return haystack === needle || haystack.startsWith(`${needle} `) || haystack.endsWith(` ${needle}`) || haystack.includes(` ${needle} `);
}

function aliases(candidate: MetricCandidate): string[] {
  const values = new Set<string>();
  const add = (value: string) => {
    const normalized = normalize(value);
    if (normalized.length >= 2) values.add(normalized);
  };
  add(candidate.metricCode);
  add(candidate.metricCode.replace(/[._:-]+/g, " "));
  add(candidate.displayName);
  for (const match of candidate.displayName.matchAll(/\(([^)]+)\)/g)) add(match[1] ?? "");
  const codeParts = candidate.metricCode.split(/[._:-]+/).filter(Boolean);
  if (codeParts.length > 1) add(codeParts.at(-1) ?? "");
  return [...values];
}

export function inferSemanticOperation(question: string): SemanticOperation {
  const normalized = normalize(question);
  if (/\b(total|sum|combined)\b/.test(normalized)) return "sum";
  if (/\b(average|avg|mean)\b/.test(normalized)) return "average";
  if (/\b(minimum|min|lowest|smallest)\b/.test(normalized)) return "minimum";
  if (/\b(maximum|max|highest|largest)\b/.test(normalized)) return "maximum";
  if (/\b(how many|count|number of)\b/.test(normalized)) return "count";
  return "values";
}

function extractPeriodFilters(question: string): { economicPeriodTokens: string[]; reportYears: number[] } {
  const upper = question.toUpperCase();
  const periodTokens = new Set<string>();
  const specificYears = new Set<number>();

  for (const match of upper.matchAll(/\bQ([1-4])\s*[-/]?\s*(20\d{2})\b/g)) {
    const quarter = match[1];
    const year = match[2];
    if (quarter && year) {
      periodTokens.add(`q${quarter}${year}`);
      periodTokens.add(`${year}q${quarter}`);
      specificYears.add(Number(year));
    }
  }
  for (const match of upper.matchAll(/\b(20\d{2})\s*[-/]?\s*Q([1-4])\b/g)) {
    const year = match[1];
    const quarter = match[2];
    if (quarter && year) {
      periodTokens.add(`q${quarter}${year}`);
      periodTokens.add(`${year}q${quarter}`);
      specificYears.add(Number(year));
    }
  }
  for (const match of upper.matchAll(/\bFY\s*[-/]?\s*(20\d{2})\b/g)) {
    const year = match[1];
    if (year) {
      periodTokens.add(`fy${year}`);
      specificYears.add(Number(year));
    }
  }

  const allYears = new Set<number>();
  for (const match of upper.matchAll(/\b(20\d{2})\b/g)) {
    const year = Number(match[1]);
    if (Number.isInteger(year)) allYears.add(year);
  }

  return {
    economicPeriodTokens: [...periodTokens].sort(),
    reportYears: periodTokens.size > 0 ? [] : [...allYears].filter((year) => !specificYears.has(year)).sort(),
  };
}

function exactFundScope(question: string, entitledFundIds: string[]): string[] {
  const normalizedQuestion = normalize(question);
  const mentioned = entitledFundIds.filter((fundId) => containsPhrase(normalizedQuestion, normalize(fundId)));
  return (mentioned.length > 0 ? mentioned : entitledFundIds).slice().sort();
}

function resolveMetric(question: string, candidates: MetricCandidate[]): { candidate?: MetricCandidate; reason?: string } {
  const normalizedQuestion = normalize(question);
  const matches: MetricMatch[] = [];
  for (const candidate of candidates) {
    const matchedAliases = aliases(candidate).filter((alias) => containsPhrase(normalizedQuestion, alias));
    if (matchedAliases.length === 0) continue;
    matches.push({ candidate, score: Math.max(...matchedAliases.map((alias) => alias.length)) });
  }
  if (matches.length === 0) return { reason: "metric_not_resolved" };
  matches.sort((a, b) => b.score - a.score || a.candidate.metricCode.localeCompare(b.candidate.metricCode));
  const best = matches[0];
  if (!best) return { reason: "metric_not_resolved" };
  const tiedCodes = new Set(matches.filter((match) => match.score === best.score).map((match) => match.candidate.metricCode));
  if (tiedCodes.size > 1) return { reason: "ambiguous_metric" };
  return { candidate: best.candidate };
}

function aggregationSupported(operation: SemanticOperation, aggregationBehavior: string): boolean {
  if (operation === "values" || operation === "count" || operation === "minimum" || operation === "maximum") return true;
  const normalized = normalize(aggregationBehavior);
  if (operation === "sum") return /\b(sum|additive|total)\b/.test(normalized);
  if (operation === "average") return /\b(average|avg|mean)\b/.test(normalized);
  return false;
}

function factIds(rows: PostgresRow[]): string[] {
  const result = new Set<string>();
  for (const row of rows) {
    const observationId = text(row.observation_id);
    if (observationId) result.add(observationId);
    const sourceIds = row.source_observation_ids;
    if (Array.isArray(sourceIds)) {
      for (const value of sourceIds) {
        const id = text(value);
        if (id) result.add(id);
      }
    }
  }
  return [...result].sort();
}

export class GovernedSemanticQueryService {
  private readonly db: PostgresSqlApi;

  constructor(db: PostgresSqlApi) {
    this.db = db;
  }

  private async metricCandidates(identity: RequestIdentity, fundIds: string[], documentIds: string[]): Promise<MetricCandidate[]> {
    if (fundIds.length === 0 || documentIds.length === 0) return [];
    const rows = await this.db.query(`select distinct o.metric_code,
        coalesce(md.display_name,o.metric_code) as display_name,
        coalesce(md.data_type,'unknown') as data_type,
        coalesce(md.aggregation_behavior,'unspecified') as aggregation_behavior
      from corvis_serving.observations o
      join corvis_source.source_reference r
        on r.tenant_id=o.tenant_id and r.source_reference_id=o.source_reference_id
      left join lateral (
        select m.display_name,m.data_type,m.aggregation_behavior
        from corvis_semantic.metric_definition m
        where m.metric_code=o.metric_code and m.active=true
        order by m.definition_version desc
        limit 1
      ) md on true
      where o.tenant_id=$1
        and o.review_state='approved'
        and o.fund_id in (select jsonb_array_elements_text($2::jsonb))
        and r.document_id::text in (select jsonb_array_elements_text($3::jsonb))
      order by o.metric_code
      limit 500`, [identity.tenantId, JSON.stringify(fundIds), JSON.stringify(documentIds)]);
    return rows.map((row) => ({
      metricCode: text(row.metric_code),
      displayName: text(row.display_name) || text(row.metric_code),
      dataType: text(row.data_type) || "unknown",
      aggregationBehavior: text(row.aggregation_behavior) || "unspecified",
    })).filter((candidate) => candidate.metricCode.length > 0);
  }

  private async executeRows(identity: RequestIdentity, shape: GovernedSemanticQueryShape): Promise<PostgresRow[]> {
    if (!shape.metricCode) return [];
    const aggregateExpression: Record<Exclude<SemanticOperation, "values">, string> = {
      sum: "sum(value_number)",
      average: "avg(value_number)",
      minimum: "min(value_number)",
      maximum: "max(value_number)",
      count: "count(*)::bigint",
    };
    const scoped = `with scoped as (
      select distinct on (o.fund_id,coalesce(o.company_id,''),o.metric_code,coalesce(o.currency,''))
        o.observation_id,o.fund_id,o.company_id,o.metric_code,o.value_number,o.value_string,
        o.currency,o.economic_period,o.report_date,o.source_reference_id,o.version,o.updated_at
      from corvis_serving.observations o
      join corvis_source.source_reference r
        on r.tenant_id=o.tenant_id and r.source_reference_id=o.source_reference_id
      where o.tenant_id=$1
        and o.review_state='approved'
        and o.fund_id in (select jsonb_array_elements_text($2::jsonb))
        and r.document_id::text in (select jsonb_array_elements_text($3::jsonb))
        and o.metric_code=$4
        and ($5::jsonb='[]'::jsonb or regexp_replace(lower(coalesce(o.economic_period,'')),'[^a-z0-9]+','','g') in (select jsonb_array_elements_text($5::jsonb)))
        and ($6::jsonb='[]'::jsonb or extract(year from o.report_date)::int in (select jsonb_array_elements_text($6::jsonb)::int))
      order by o.fund_id,coalesce(o.company_id,''),o.metric_code,coalesce(o.currency,''),
        o.report_date desc nulls last,o.economic_period desc nulls last,o.version desc,o.updated_at desc
      limit $7
    )`;
    const parameters: PostgresPrimitive[] = [
      identity.tenantId,
      JSON.stringify(shape.fundIds),
      JSON.stringify(shape.documentIds),
      shape.metricCode,
      JSON.stringify(shape.economicPeriodTokens),
      JSON.stringify(shape.reportYears),
      shape.limit,
    ];
    if (shape.operation === "values") {
      return this.db.query(`${scoped}
        select observation_id,fund_id,company_id,metric_code,value_number,value_string,currency,
          economic_period,report_date,source_reference_id,version
        from scoped
        order by fund_id,company_id nulls first,economic_period desc nulls last,report_date desc nulls last`, parameters);
    }
    const expression = aggregateExpression[shape.operation];
    const numericPredicate = shape.operation === "count" ? "" : "where value_number is not null";
    return this.db.query(`${scoped}
      select fund_id,metric_code,economic_period,currency,
        ${expression} as result_value,count(*)::bigint as row_count,
        jsonb_agg(observation_id::text order by observation_id::text) as source_observation_ids
      from scoped
      ${numericPredicate}
      group by fund_id,metric_code,economic_period,currency
      order by fund_id,economic_period desc nulls last,currency nulls first`, parameters);
  }

  async execute(identity: RequestIdentity, question: string): Promise<GovernedSemanticQueryResult> {
    const entitledFundIds = [...(identity.entitlements.fundIds ?? [])].sort();
    const documentIds = [...(identity.entitlements.documentIds ?? [])].sort();
    const fundIds = exactFundScope(question, entitledFundIds);
    const operation = inferSemanticOperation(question);
    const periods = extractPeriodFilters(question);
    const baseShape: GovernedSemanticQueryShape = {
      version: "v2",
      source: "corvis_serving.observations",
      reviewState: "approved",
      fundIds,
      documentIds,
      operation,
      economicPeriodTokens: periods.economicPeriodTokens,
      reportYears: periods.reportYears,
      limit: 200,
      status: "unresolved",
    };

    if (fundIds.length === 0 || documentIds.length === 0) {
      return { shape: { ...baseShape, reason: "insufficient_authorization_scope" }, rows: [], factIds: [], status: "unresolved" };
    }

    const candidates = await this.metricCandidates(identity, fundIds, documentIds);
    const resolution = resolveMetric(question, candidates);
    if (!resolution.candidate) {
      return { shape: { ...baseShape, reason: resolution.reason ?? "metric_not_resolved" }, rows: [], factIds: [], status: "unresolved" };
    }

    const candidate = resolution.candidate;
    if (!aggregationSupported(operation, candidate.aggregationBehavior)) {
      return {
        shape: {
          ...baseShape,
          metricCode: candidate.metricCode,
          metricDisplayName: candidate.displayName,
          aggregationBehavior: candidate.aggregationBehavior,
          status: "unsupported",
          reason: "aggregation_not_allowed_by_metric_definition",
        },
        rows: [],
        factIds: [],
        status: "unsupported",
      };
    }

    const shape: GovernedSemanticQueryShape = {
      ...baseShape,
      metricCode: candidate.metricCode,
      metricDisplayName: candidate.displayName,
      aggregationBehavior: candidate.aggregationBehavior,
      status: "planned",
    };
    const rows = await this.executeRows(identity, shape);
    return { shape, rows, factIds: factIds(rows), status: "executed" };
  }
}
