import type { RequestIdentity } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { sqlKeyset, type KeysetPage } from "./pagination.ts";
import { postgres, type PostgresPrimitive, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";

function text(row: PostgresRow, key: string): string { return row[key] == null ? "" : String(row[key]); }
function nullableText(row: PostgresRow, key: string): string | null { return row[key] == null ? null : String(row[key]); }
function allowedFundJson(identity: RequestIdentity): string { return JSON.stringify(identity.entitlements.fundIds ?? []); }

export type PublicHolding = {
  id: string;
  fundId: string;
  targetType: "company" | "fund";
  targetCompanyId: string | null;
  targetFundId: string | null;
  sourceReferenceId: string | null;
  validFrom: string | null;
  validTo: string | null;
  updatedAt: string;
};

export type PublicInstrument = {
  id: string;
  holdingId: string;
  fundId: string;
  companyId: string;
  securityDescription: string;
  instrumentType: string | null;
  currency: string | null;
  sourceReferenceId: string | null;
  updatedAt: string;
};

export class PostgresHoldingInstrumentServingRepository {
  private readonly db: PostgresSqlApi;
  constructor(db: PostgresSqlApi) { this.db = db; }

  /** `page` pushes one keyset page (by holding id) down to SQL; see sqlKeyset. */
  async holdings(identity: RequestIdentity, page?: KeysetPage): Promise<PublicHolding[]> {
    const parameters: PostgresPrimitive[] = [identity.tenantId, allowedFundJson(identity)];
    const keyset = page ? sqlKeyset("h.holding_id::text", page, parameters) : { where: "", tail: "order by h.holding_id" };
    const rows = await this.db.query(`
      with allowed_fund as (
        select value as fund_id from jsonb_array_elements_text($2::jsonb)
      )
      select h.holding_id,h.fund_id,h.target_type,h.target_company_id,h.target_fund_id,
             h.source_reference_id,h.valid_from,h.valid_to,h.updated_at
      from corvis_serving.holdings h
      join allowed_fund a on a.fund_id=h.fund_id
      where h.tenant_id=$1::uuid
        and (
          h.target_type='company'
          or exists (select 1 from allowed_fund target where target.fund_id=h.target_fund_id)
        )${keyset.where}
      ${keyset.tail}`, parameters);
    return rows.map((row) => ({
      id: text(row,"holding_id"), fundId: text(row,"fund_id"), targetType: text(row,"target_type") as "company"|"fund",
      targetCompanyId: nullableText(row,"target_company_id"), targetFundId: nullableText(row,"target_fund_id"),
      sourceReferenceId: nullableText(row,"source_reference_id"), validFrom: nullableText(row,"valid_from"),
      validTo: nullableText(row,"valid_to"), updatedAt: text(row,"updated_at"),
    }));
  }

  /** `page` pushes one keyset page (by instrument id) down to SQL; see sqlKeyset. */
  async instruments(identity: RequestIdentity, page?: KeysetPage): Promise<PublicInstrument[]> {
    const parameters: PostgresPrimitive[] = [identity.tenantId, allowedFundJson(identity)];
    const keyset = page ? sqlKeyset("i.instrument_id::text", page, parameters) : { where: "", tail: "order by i.instrument_id" };
    const rows = await this.db.query(`
      with allowed_fund as (
        select value as fund_id from jsonb_array_elements_text($2::jsonb)
      )
      select i.instrument_id,i.holding_id,i.fund_id,i.company_id,i.security_description,
             i.instrument_type,i.currency,i.source_reference_id,i.updated_at
      from corvis_serving.instruments i
      join allowed_fund a on a.fund_id=i.fund_id
      where i.tenant_id=$1::uuid${keyset.where}
      ${keyset.tail}`, parameters);
    return rows.map((row) => ({
      id: text(row,"instrument_id"), holdingId: text(row,"holding_id"), fundId: text(row,"fund_id"),
      companyId: text(row,"company_id"), securityDescription: text(row,"security_description"),
      instrumentType: nullableText(row,"instrument_type"), currency: nullableText(row,"currency"),
      sourceReferenceId: nullableText(row,"source_reference_id"), updatedAt: text(row,"updated_at"),
    }));
  }
}

let singleton: PostgresHoldingInstrumentServingRepository | undefined;
export function holdingInstrumentServing(dsn = getServerConfig().postgresDsn): PostgresHoldingInstrumentServingRepository {
  if (!singleton) singleton = new PostgresHoldingInstrumentServingRepository(postgres(dsn));
  return singleton;
}
