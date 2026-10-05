import type { RequestIdentity } from "../../core/enterprise.ts";
import {
  sectorName,
  type CompanySectorAssignment,
  type CompanySectorAssignmentOutcome,
  type CompanySectorRecord,
} from "../../core/sector-taxonomy.ts";
import { getServerConfig } from "./config.ts";
import { demoCompanySectorStore } from "../../adapters/demo/company-sector-store.ts";
import { ConflictError } from "./platform.ts";
import { postgres, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";

/**
 * Governed company → sector classification (issue #175 A4, migration 055).
 * Listing and assignment are both scoped to the companies the caller's
 * entitled funds hold: a company outside that set answers exactly like an
 * unknown one, so the endpoint never confirms another fund's holdings.
 */
export interface CompanySectorsPort {
  list(identity: RequestIdentity): Promise<CompanySectorRecord[]>;
  /** Runs inside the caller's audited transaction when `db` is given. */
  assign(identity: RequestIdentity, command: CompanySectorAssignment, db?: PostgresSqlApi): Promise<CompanySectorAssignmentOutcome>;
}

function text(row: PostgresRow, key: string): string | null { const value = row[key]; return value == null || value === "" ? null : String(value); }
function iso(row: PostgresRow, key: string): string | null {
  const value = row[key];
  if (value == null || value === "") return null;
  return value instanceof Date ? value.toISOString() : String(value);
}
function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    const inner = value.replace(/^\{|\}$/g, "");
    return inner ? inner.split(",").map((item) => item.replace(/^"|"$/g, "")) : [];
  }
  return [];
}

function toRecord(row: PostgresRow): CompanySectorRecord {
  const sectorCode = text(row, "sector_code");
  return {
    companyId: text(row, "company_id") ?? "",
    company: text(row, "company_name") ?? text(row, "company_id") ?? "",
    fundIds: stringArray(row.fund_ids),
    sectorCode,
    sectorName: text(row, "sector_name") ?? (sectorCode ? sectorName(sectorCode) ?? null : null),
    taxonomyVersion: text(row, "taxonomy_version"),
    basis: sectorCode ? "reviewer_assigned" : null,
    classifiedBy: text(row, "classified_by"),
    classifiedAt: iso(row, "classified_at"),
    version: Number(row.version ?? 0) || 0,
  };
}

const ENTITLED_COMPANIES = `with entitled_company as (
    select h.target_company_id as company_id, array_agg(distinct h.fund_id order by h.fund_id) as fund_ids
    from corvis_serving.holdings h
    where h.tenant_id=$1::uuid
      and h.fund_id in (select jsonb_array_elements_text($2::jsonb))
      and h.target_type='company'
      and h.target_company_id is not null
    group by h.target_company_id
  )`;

export class PostgresCompanySectorRepository implements CompanySectorsPort {
  private readonly db: PostgresSqlApi;
  constructor(db?: PostgresSqlApi) { this.db = db ?? postgres(getServerConfig().postgresDsn); }

  async list(identity: RequestIdentity): Promise<CompanySectorRecord[]> {
    const fundIds = identity.entitlements.fundIds ?? [];
    if (fundIds.length === 0) return [];
    const rows = await this.db.query(`${ENTITLED_COMPANIES}
      select ec.company_id, coalesce(c.canonical_name, ec.company_id) as company_name, ec.fund_ids,
             cs.sector_code, cs.sector_name, cs.taxonomy_version, cs.version, cs.classified_by, cs.classified_at
      from entitled_company ec
      left join corvis_identity.company c on c.global_company_id=ec.company_id
      left join corvis_serving.company_sectors cs on cs.tenant_id=$1::uuid and cs.company_id=ec.company_id
      order by company_name, ec.company_id
      limit 5000`, [identity.tenantId, JSON.stringify(fundIds)]);
    return rows.map(toRecord);
  }

  async assign(identity: RequestIdentity, command: CompanySectorAssignment, db: PostgresSqlApi = this.db): Promise<CompanySectorAssignmentOutcome> {
    const fundIds = identity.entitlements.fundIds ?? [];
    if (fundIds.length === 0) throw new ConflictError("company_not_found_or_version_conflict");
    const entitled = await db.query(`${ENTITLED_COMPANIES}
      select 1 from entitled_company where company_id=$3`, [identity.tenantId, JSON.stringify(fundIds), command.companyId]);
    if (entitled.length === 0) throw new ConflictError("company_not_found_or_version_conflict");
    const rows = await db.query(
      "select corvis_facts.assign_company_sector($1::uuid,$2,$3,$4,$5,$6) as new_version",
      [identity.tenantId, command.companyId, command.sectorCode, command.expectedVersion, identity.subject, command.reason],
    );
    const newVersion = Number(rows[0]?.new_version);
    if (!Number.isInteger(newVersion) || newVersion !== command.expectedVersion + 1) throw new ConflictError("company_sector_version_conflict");
    return { accepted: true, companyId: command.companyId, sectorCode: command.sectorCode, newVersion };
  }
}

/** Demo mode: the in-memory store behind the same port and error contract. */
class DemoCompanySectors implements CompanySectorsPort {
  async list(): Promise<CompanySectorRecord[]> { return demoCompanySectorStore().list(); }
  async assign(identity: RequestIdentity, command: CompanySectorAssignment): Promise<CompanySectorAssignmentOutcome> {
    const result = demoCompanySectorStore().assign(identity.subject, command);
    if ("refused" in result) throw new ConflictError(result.refused);
    return { accepted: true, companyId: command.companyId, sectorCode: command.sectorCode, newVersion: result.newVersion };
  }
}

let singleton: CompanySectorsPort | undefined;
export function companySectors(): CompanySectorsPort {
  if (!singleton) singleton = getServerConfig().demoMode ? new DemoCompanySectors() : new PostgresCompanySectorRepository();
  return singleton;
}
