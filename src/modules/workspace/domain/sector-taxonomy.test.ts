import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isSectorCode, normalizeSectorLabel, resolveSectorAlias, SECTOR_ALIASES, SECTOR_TAXONOMY_VERSION, SECTORS } from "./sector-taxonomy.ts";

const BASELINE = "db/postgres/migrations/001_baseline.sql";

function sqlString(value: string): string { return value.replaceAll("''", "'"); }

test("the baseline seeds exactly the sectors src/modules/workspace/domain/sector-taxonomy.ts defines", async () => {
  const sql = await readFile(BASELINE, "utf8");
  const seeded = [
    ...sql.matchAll(
      /^INSERT INTO corvis_semantic\.sector \(taxonomy_version, sector_code, display_name, description, display_order\) VALUES \('([^']+)', '([^']+)', '((?:[^']|'')+)', '((?:[^']|'')+)', (\d+)\);$/gm,
    ),
  ]
    .map(([, version, code, name, description, order]) => ({ version, code, name: sqlString(name!), description: sqlString(description!), displayOrder: Number(order) }));
  assert.deepEqual(seeded, SECTORS.map((sector) => ({ version: SECTOR_TAXONOMY_VERSION, code: sector.code, name: sector.name, description: sector.description, displayOrder: sector.displayOrder })));
});

test("the baseline seeds exactly the aliases src/modules/workspace/domain/sector-taxonomy.ts defines", async () => {
  const sql = await readFile(BASELINE, "utf8");
  const seeded = Object.fromEntries(
    [
      ...sql.matchAll(
        /^INSERT INTO corvis_semantic\.sector_alias \(taxonomy_version, alias_normalized, sector_code\) VALUES \('([^']+)', '([^']+)', '([^']+)'\);$/gm,
      ),
    ].map(([, version, alias, code]) => {
      assert.equal(version, SECTOR_TAXONOMY_VERSION);
      return [alias, code];
    }),
  );
  assert.deepEqual(seeded, SECTOR_ALIASES);
  // The baseline's normalize function must use the same rules as normalizeSectorLabel.
  assert.match(sql, /regexp_replace\(lower\(coalesce\(p_label,''\)\), '\[&\+\]', ' and ', 'g'\), '\[\^a-z0-9 \]\+', ' ', 'g'\)/);
});

test("the taxonomy is well-formed: unique codes and order, every alias normalized and targeting a sector", () => {
  assert.equal(new Set(SECTORS.map((sector) => sector.code)).size, SECTORS.length);
  assert.deepEqual(SECTORS.map((sector) => sector.displayOrder), SECTORS.map((_, index) => index + 1));
  for (const sector of SECTORS) assert.match(sector.code, /^[a-z][a-z0-9_]*$/);
  for (const [alias, code] of Object.entries(SECTOR_ALIASES)) {
    assert.equal(normalizeSectorLabel(alias), alias, `${alias} must be stored normalized`);
    assert.ok(isSectorCode(code), `${alias} targets unknown sector ${code}`);
  }
});

test("GP labels resolve through normalization, and ambiguous labels stay unclassified", () => {
  assert.equal(normalizeSectorLabel("  Health-Care & Life   Sciences "), "health care and life sciences");
  assert.equal(resolveSectorAlias("Health Care"), "healthcare");
  assert.equal(resolveSectorAlias("TMT"), "technology");
  assert.equal(resolveSectorAlias("Food & Beverage"), "consumer_staples");
  assert.equal(resolveSectorAlias("Fintech"), null);
  assert.equal(resolveSectorAlias(""), null);
  assert.equal(resolveSectorAlias(null), null);
  assert.equal(isSectorCode("crypto"), false);
});
