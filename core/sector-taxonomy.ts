/**
 * Corvis Sector Taxonomy v1: the governed sector classification the Overview
 * exposure breakdown uses (issue #175 A4). It is Corvis-owned reference data,
 * deliberately coarse (eleven economic sectors) so a Review Analyst can
 * classify any portfolio company without a licensed industry scheme. The
 * migration that seeds `corvis_semantic.sector` and `corvis_semantic.sector_alias`
 * (db/postgres/migrations/055_sector_taxonomy.sql) must stay identical to
 * this file; core/sector-taxonomy.test.ts enforces that.
 *
 * A new sector or a re-cut of an existing one is a new taxonomy version, never
 * an in-place edit: classifications record the version they were made under.
 */
export const SECTOR_TAXONOMY_VERSION = "corvis_sector_v1";

export type SectorDefinition = {
  code: string;
  name: string;
  description: string;
  displayOrder: number;
};

export const SECTORS: readonly SectorDefinition[] = [
  { code: "technology", name: "Technology", description: "Software, IT services, semiconductors and technology hardware.", displayOrder: 1 },
  { code: "healthcare", name: "Healthcare", description: "Healthcare providers and services, pharmaceuticals, biotechnology, medical devices and life sciences tools.", displayOrder: 2 },
  { code: "financials", name: "Financials", description: "Banks, insurance, asset and wealth management, payments and specialty finance.", displayOrder: 3 },
  { code: "industrials", name: "Industrials", description: "Capital goods, aerospace and defense, transportation, logistics and business services.", displayOrder: 4 },
  { code: "consumer_discretionary", name: "Consumer discretionary", description: "Retail, leisure, hospitality, automotive, education and consumer services.", displayOrder: 5 },
  { code: "consumer_staples", name: "Consumer staples", description: "Food, beverage, household and personal products, and staples retail.", displayOrder: 6 },
  { code: "communication_services", name: "Communication services", description: "Telecommunications, media, entertainment and interactive platforms.", displayOrder: 7 },
  { code: "energy", name: "Energy", description: "Oil, gas and consumable fuels, and energy equipment and services.", displayOrder: 8 },
  { code: "materials", name: "Materials", description: "Chemicals, construction materials, packaging, metals and mining.", displayOrder: 9 },
  { code: "real_estate", name: "Real estate", description: "Real estate owners, operators, developers and services.", displayOrder: 10 },
  { code: "utilities", name: "Utilities", description: "Electric, gas and water utilities, and renewable power producers.", displayOrder: 11 },
];

/**
 * GP-reported sector labels (normalized, see normalizeSectorLabel) that map
 * unambiguously onto one Corvis sector. A label that could reasonably mean
 * two sectors (for example "fintech" or "services") is deliberately absent:
 * it stays unclassified until a reviewer classifies the underlying companies.
 */
export const SECTOR_ALIASES: Readonly<Record<string, string>> = {
  "technology": "technology",
  "tech": "technology",
  "information technology": "technology",
  "it": "technology",
  "software": "technology",
  "software and services": "technology",
  "tmt": "technology",
  "semiconductors": "technology",
  "healthcare": "healthcare",
  "health care": "healthcare",
  "life sciences": "healthcare",
  "pharmaceuticals": "healthcare",
  "biotechnology": "healthcare",
  "medical devices": "healthcare",
  "financials": "financials",
  "financial services": "financials",
  "insurance": "financials",
  "banking": "financials",
  "industrials": "industrials",
  "industrial": "industrials",
  "business services": "industrials",
  "aerospace and defense": "industrials",
  "transportation": "industrials",
  "logistics": "industrials",
  "consumer discretionary": "consumer_discretionary",
  "consumer": "consumer_discretionary",
  "retail": "consumer_discretionary",
  "leisure": "consumer_discretionary",
  "education": "consumer_discretionary",
  "consumer staples": "consumer_staples",
  "food and beverage": "consumer_staples",
  "communication services": "communication_services",
  "communications": "communication_services",
  "media": "communication_services",
  "telecommunications": "communication_services",
  "telecom": "communication_services",
  "energy": "energy",
  "oil and gas": "energy",
  "materials": "materials",
  "chemicals": "materials",
  "real estate": "real_estate",
  "property": "real_estate",
  "utilities": "utilities",
  "infrastructure and utilities": "utilities",
};

/** Lowercase, `&`/`+` → "and", punctuation dropped, whitespace collapsed. Mirrors corvis_semantic.normalize_sector_label. */
export function normalizeSectorLabel(label: string): string {
  return label.toLowerCase().replace(/[&+]/g, " and ").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

export function resolveSectorAlias(label: string | null | undefined): string | null {
  if (!label) return null;
  return SECTOR_ALIASES[normalizeSectorLabel(label)] ?? null;
}

const SECTOR_NAMES = new Map(SECTORS.map((sector) => [sector.code, sector.name]));
export function sectorName(code: string): string | undefined { return SECTOR_NAMES.get(code); }
export function isSectorCode(value: unknown): value is string { return typeof value === "string" && SECTOR_NAMES.has(value); }

/** A company's current governed sector, as served to the workspace. */
export type CompanySectorRecord = {
  companyId: string;
  company: string;
  /** Entitled funds holding this company. */
  fundIds: string[];
  sectorCode: string | null;
  sectorName: string | null;
  taxonomyVersion: string | null;
  basis: "reviewer_assigned" | null;
  classifiedBy: string | null;
  classifiedAt: string | null;
  /** Version of the current classification; 0 when never classified (the expected version for the first assignment). */
  version: number;
};

export type CompanySectorAssignment = {
  companyId: string;
  sectorCode: string;
  expectedVersion: number;
  reason: string;
};

export type CompanySectorAssignmentOutcome = {
  accepted: true;
  companyId: string;
  sectorCode: string;
  newVersion: number;
};
