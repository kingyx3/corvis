import type { RequestIdentity } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { sqlKeyset, type KeysetPage } from "./pagination.ts";
import { postgres, type PostgresPrimitive, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";

export type ClientPortfolio = {
  id: string;
  key: string;
  displayName: string;
  baseCurrency: string | null;
  externalPortfolioId: string | null;
  fundPositionCount: number;
};

export type PortfolioHoldingAttribution = {
  id: string;
  portfolioId: string;
  portfolioFundPositionId: string;
  rootFundId: string;
  owningFundId: string;
  holdingId: string;
  targetType: "company" | "fund";
  targetCompanyId: string | null;
  targetFundId: string | null;
  holdingStatus: string | null;
  investmentDate: string | null;
  strategy: string | null;
  geography: string | null;
  sourceReferenceId: string | null;
  fundPath: string[];
  holdingPath: string[];
  lookthroughDepth: number;
};

export type PortfolioHoldingQuery = {
  portfolioId?: string;
  companyId?: string;
};

function text(row: PostgresRow, key: string): string {
  return row[key] == null ? "" : String(row[key]);
}

function nullableText(row: PostgresRow, key: string): string | null {
  return row[key] == null ? null : String(row[key]);
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  if (value.startsWith("{") && value.endsWith("}")) {
    return value.slice(1,-1).split(",").filter(Boolean).map((entry) => entry.replace(/^"|"$/g,""));
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch { return []; }
}

function jsonParameter(values: string[] | undefined): string {
  return JSON.stringify(values ?? []);
}

/**
 * Portfolio membership is an attribution dimension, never an authorization grant.
 * Every read intersects portfolio membership with the request's authoritative fund
 * entitlements and exact workspace. A portfolio cannot expose an otherwise hidden
 * invested or look-through fund.
 */
export class PostgresClientPortfolioAttributionRepository {
  private readonly db: PostgresSqlApi;

  constructor(db: PostgresSqlApi) { this.db = db; }

  async portfolios(identity: RequestIdentity, page?: KeysetPage): Promise<ClientPortfolio[]> {
    const fundIds = identity.entitlements.fundIds ?? [];
    if (fundIds.length === 0) return [];
    const parameters: PostgresPrimitive[] = [identity.tenantId,identity.workspaceId,jsonParameter(fundIds)];
    const keyset = page ? sqlKeyset("p.portfolio_id::text",page,parameters) : { where: "", tail: "order by p.portfolio_id" };
    const rows = await this.db.query(`
      with allowed_fund as (
        select value as fund_id from jsonb_array_elements_text($3::jsonb)
      )
      select p.portfolio_id,p.portfolio_key,p.display_name,p.base_currency,p.external_portfolio_id,
             count(distinct pf.portfolio_fund_position_id)::integer as fund_position_count
      from corvis_serving.client_portfolios p
      join corvis_serving.client_portfolio_fund_positions pf
        on pf.tenant_id=p.tenant_id and pf.portfolio_id=p.portfolio_id
      join allowed_fund af on af.fund_id=pf.fund_id
      where p.tenant_id=$1::uuid
        and p.workspace_id::text=$2${keyset.where}
      group by p.portfolio_id,p.portfolio_key,p.display_name,p.base_currency,p.external_portfolio_id
      ${keyset.tail}`,parameters);
    return rows.map((row) => ({
      id: text(row,"portfolio_id"),
      key: text(row,"portfolio_key"),
      displayName: text(row,"display_name"),
      baseCurrency: nullableText(row,"base_currency"),
      externalPortfolioId: nullableText(row,"external_portfolio_id"),
      fundPositionCount: Number(row.fund_position_count ?? 0),
    }));
  }

  async holdings(identity: RequestIdentity, query: PortfolioHoldingQuery = {}, page?: KeysetPage): Promise<PortfolioHoldingAttribution[]> {
    const fundIds = identity.entitlements.fundIds ?? [];
    if (fundIds.length === 0) return [];
    const parameters: PostgresPrimitive[] = [identity.tenantId,identity.workspaceId,jsonParameter(fundIds)];
    const predicates = [
      "a.tenant_id=$1::uuid",
      "a.workspace_id::text=$2",
      "a.root_fund_id in (select value from jsonb_array_elements_text($3::jsonb))",
      "a.owning_fund_id in (select value from jsonb_array_elements_text($3::jsonb))",
      `(a.target_type<>'fund' or a.target_fund_id in (select value from jsonb_array_elements_text($3::jsonb)))`,
    ];
    if (query.portfolioId) {
      parameters.push(query.portfolioId);
      predicates.push(`a.portfolio_id::text=$${parameters.length}`);
    }
    if (query.companyId) {
      parameters.push(query.companyId);
      predicates.push(`a.target_type='company' and a.target_company_id=$${parameters.length}`);
    }
    const keyset = page ? sqlKeyset("a.attribution_key",page,parameters) : { where: "", tail: "order by a.attribution_key" };
    const rows = await this.db.query(`
      select a.attribution_key,a.portfolio_id,a.portfolio_fund_position_id,a.root_fund_id,
             a.owning_fund_id,a.holding_id,a.target_type,a.target_company_id,a.target_fund_id,
             a.holding_status,a.investment_date,a.strategy,a.geography,a.source_reference_id,
             a.fund_path,a.holding_path,a.lookthrough_depth
      from corvis_serving.client_portfolio_holding_attribution a
      where ${predicates.join("\n        and ")}${keyset.where}
      ${keyset.tail}`,parameters);
    return rows.map((row) => ({
      id: text(row,"attribution_key"),
      portfolioId: text(row,"portfolio_id"),
      portfolioFundPositionId: text(row,"portfolio_fund_position_id"),
      rootFundId: text(row,"root_fund_id"),
      owningFundId: text(row,"owning_fund_id"),
      holdingId: text(row,"holding_id"),
      targetType: text(row,"target_type") as "company" | "fund",
      targetCompanyId: nullableText(row,"target_company_id"),
      targetFundId: nullableText(row,"target_fund_id"),
      holdingStatus: nullableText(row,"holding_status"),
      investmentDate: nullableText(row,"investment_date"),
      strategy: nullableText(row,"strategy"),
      geography: nullableText(row,"geography"),
      sourceReferenceId: nullableText(row,"source_reference_id"),
      fundPath: stringArray(row.fund_path),
      holdingPath: stringArray(row.holding_path),
      lookthroughDepth: Number(row.lookthrough_depth ?? 0),
    }));
  }
}

let singleton: PostgresClientPortfolioAttributionRepository | undefined;
export function clientPortfolioAttribution(dsn = getServerConfig().postgresDsn): PostgresClientPortfolioAttributionRepository {
  if (!singleton) singleton = new PostgresClientPortfolioAttributionRepository(postgres(dsn));
  return singleton;
}
