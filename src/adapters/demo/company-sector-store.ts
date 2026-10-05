import { demoCompanySectorSeed, demoPortfolioCompanies } from "./catalog.ts";
import {
  isSectorCode,
  sectorName,
  SECTOR_TAXONOMY_VERSION,
  type CompanySectorAssignment,
  type CompanySectorRecord,
} from "../../core/sector-taxonomy.ts";

type DemoClassification = { sectorCode: string; version: number; classifiedBy: string; classifiedAt: string };
export type DemoAssignmentResult = { newVersion: number } | { refused: "company_not_found_or_version_conflict" | "unknown_sector_code" | "company_sector_version_conflict" };

/**
 * In-memory company sector classifications for demo mode and tests; not
 * production evidence. Kept free of platform imports so the demo platform can
 * derive its sector breakdown from it without an import cycle.
 */
export class DemoCompanySectorStore {
  private readonly classifications = new Map<string, DemoClassification>(
    Object.entries(demoCompanySectorSeed).map(([companyId, sectorCode]) => [companyId, { sectorCode, version: 1, classifiedBy: "demo|seed", classifiedAt: "2026-09-01T00:00:00.000Z" }]),
  );

  sectorByCompany(): Map<string, string> {
    return new Map([...this.classifications].map(([companyId, row]) => [companyId, row.sectorCode]));
  }

  list(): CompanySectorRecord[] {
    return demoPortfolioCompanies.map((company) => {
      const current = this.classifications.get(company.companyId);
      return {
        companyId: company.companyId,
        company: company.company,
        fundIds: [...company.fundIds],
        sectorCode: current?.sectorCode ?? null,
        sectorName: current ? sectorName(current.sectorCode) ?? null : null,
        taxonomyVersion: current ? SECTOR_TAXONOMY_VERSION : null,
        basis: current ? "reviewer_assigned" as const : null,
        classifiedBy: current?.classifiedBy ?? null,
        classifiedAt: current?.classifiedAt ?? null,
        version: current?.version ?? 0,
      };
    }).sort((a, b) => a.company.localeCompare(b.company));
  }

  assign(actorSubject: string, command: CompanySectorAssignment): DemoAssignmentResult {
    if (!demoPortfolioCompanies.some((company) => company.companyId === command.companyId)) return { refused: "company_not_found_or_version_conflict" };
    if (!isSectorCode(command.sectorCode)) return { refused: "unknown_sector_code" };
    const current = this.classifications.get(command.companyId);
    if ((current?.version ?? 0) !== command.expectedVersion) return { refused: "company_sector_version_conflict" };
    const newVersion = command.expectedVersion + 1;
    this.classifications.set(command.companyId, { sectorCode: command.sectorCode, version: newVersion, classifiedBy: actorSubject, classifiedAt: new Date().toISOString() });
    return { newVersion };
  }
}

let store: DemoCompanySectorStore | undefined;
export function demoCompanySectorStore(): DemoCompanySectorStore {
  if (!store) store = new DemoCompanySectorStore();
  return store;
}
