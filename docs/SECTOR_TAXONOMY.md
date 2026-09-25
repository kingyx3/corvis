# Sector taxonomy

Corvis classifies portfolio companies into one of eleven sectors of the **Corvis Sector Taxonomy v1** (`corvis_sector_v1`). The Overview's *Exposure by sector* breakdown is built from these classifications.

## Source of truth

- `core/sector-taxonomy.ts` defines the sectors, their descriptions, and the GP-label aliases.
- Migration `055_sector_taxonomy.sql` seeds the same rows into `corvis_semantic.sector` and `corvis_semantic.sector_alias`.
- `core/sector-taxonomy.test.ts` fails if the two ever drift.

To change the taxonomy, add a **new taxonomy version**. Never edit an existing version in place: every classification records the version it was made under.

## Governed classification

`corvis_facts.company_sector_classification` is tenant-scoped and append-only.

- **Writing.** `corvis_facts.assign_company_sector` is the only write path. It takes the company's current version as the expected version, where 0 means never classified. It closes the current row and appends the next version, all under a per-company lock. A stale version returns `null`, which the API reports as a 409.
- **History is immutable.** A trigger rejects any update other than closing the current row.
- **Reading.** `corvis_serving.company_sectors` exposes only the current classification. RLS restricts reads to tenant members, and `db/postgres/tests/tenant-isolation-negative.sql` proves this.
- **API.**
  - `GET /api/v1/company-sectors` lists the companies the caller's entitled funds hold, each with its current sector.
  - `POST /api/v1/company-sectors` (`observations:review`) classifies one company. It is audited in the same transaction and is idempotent.
  - A company outside the caller's entitlement answers like an unknown company.
- **UI.** Review Analysts use **Classify companies** on the Overview's sector panel.

## How the exposure breakdown uses it

For each fund's latest published period (`PostgresWorkspaceRepository.exposureDimensionFacts`):

1. **Holding and instrument fair values.** Each value is classified by the held company's current governed sector. A company with no classification is **Unclassified**.
2. **Fund-level GP breakdowns.** A fund-level fair-value breakdown with a `sector` or `industry` category has its labels mapped through `corvis_semantic.sector_alias` (for example "Health Care" → Healthcare). An ambiguous or unknown label, such as "Fintech", stays **Unclassified**; Corvis never guesses.
3. **One level per snapshot.** Only one subject level counts per snapshot, and the governed holding level wins, so the two sources never add up.
4. **Not attributed.** Value that no fact attributes to a sector is shown as **Not attributed**, for example NAV beyond the reported holdings. Every breakdown therefore sums exactly to the exposure total.
