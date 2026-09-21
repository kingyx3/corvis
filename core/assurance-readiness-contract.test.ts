import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

type AssuranceEntry = {
  id: string;
  name: string;
  status: string;
  owners: string[];
  evidence: string[];
};

type AssuranceMap = {
  schemaVersion: string;
  authority: {
    businessControlSource: string;
    technicalImplementationSource: string;
  };
  target: {
    report: string;
    claimState: string;
  };
  auditGates: string[];
  families?: AssuranceEntry[];
  controlObjectives?: AssuranceEntry[];
};

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function load(path: string): AssuranceMap {
  return JSON.parse(readFileSync(join(repoRoot, path), "utf8")) as AssuranceMap;
}

const programs = [
  {
    name: "SOC 1",
    mapPath: "ops/soc1-controls.json",
    docPath: "docs/SOC1_READINESS.md",
    canonicalSource: "https://corvis.atlassian.net/wiki/spaces/FUNDATA/pages/3440643/SOC+1+Readiness+ICFR+Control+Mapping+Audit+Plan",
  },
  {
    name: "SOC 2",
    mapPath: "ops/soc2-controls.json",
    docPath: "docs/SOC2_READINESS.md",
    canonicalSource: "https://corvis.atlassian.net/wiki/spaces/FUNDATA/pages/2523160",
  },
] as const;

function entries(map: AssuranceMap): AssuranceEntry[] {
  return map.controlObjectives ?? map.families ?? [];
}

function concreteRepoReference(value: string): string | null {
  const trimmed = value.trim();
  return /^(?:\.github|app|core|db|docs|infra|lib|ops|scripts)\/[A-Za-z0-9_.\-/]+$/.test(trimmed)
    ? trimmed
    : null;
}

for (const program of programs) {
  test(`${program.name} readiness contract is internally consistent and points to live repository evidence`, () => {
    const map = load(program.mapPath);
    const doc = readFileSync(join(repoRoot, program.docPath), "utf8");
    const mappedEntries = entries(map);

    assert.equal(map.authority.businessControlSource, program.canonicalSource);
    assert.equal(map.authority.technicalImplementationSource, "https://github.com/kingyx3/corvis");
    assert.equal(map.target.claimState, "readiness_only_until_independent_report_issued");
    assert.match(map.target.report, /^SOC [12] Type II$/);
    assert.ok(mappedEntries.length > 0, `${program.name} must define mapped controls`);

    const ids = mappedEntries.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length, `${program.name} control IDs must be unique`);

    for (const entry of mappedEntries) {
      assert.ok(entry.id.trim(), `${program.name} control ID must be non-empty`);
      assert.ok(entry.name.trim(), `${entry.id} name must be non-empty`);
      assert.ok(entry.status.trim(), `${entry.id} readiness status must be non-empty`);
      assert.doesNotMatch(entry.status, /certified|attested|compliant|report_issued/i, `${entry.id} must not encode an assurance claim as readiness status`);
      assert.ok(entry.owners.length > 0, `${entry.id} must have at least one owner`);
      assert.equal(new Set(entry.owners).size, entry.owners.length, `${entry.id} owners must be unique`);
      assert.ok(entry.owners.every((owner) => owner.trim().length > 0), `${entry.id} owners must be non-empty`);
      assert.ok(entry.evidence.length > 0, `${entry.id} must have evidence references`);
      assert.equal(new Set(entry.evidence).size, entry.evidence.length, `${entry.id} evidence references must be unique`);

      for (const evidence of entry.evidence) {
        assert.ok(evidence.trim(), `${entry.id} evidence references must be non-empty`);
        const repoReference = concreteRepoReference(evidence);
        if (repoReference) {
          assert.ok(existsSync(join(repoRoot, repoReference)), `${entry.id} references missing repository evidence: ${repoReference}`);
        }
      }
    }

    assert.equal(new Set(map.auditGates).size, map.auditGates.length, `${program.name} audit gates must be unique`);
    assert.ok(map.auditGates.length >= 10, `${program.name} must retain a substantive audit gate sequence`);
    assert.equal(map.auditGates[map.auditGates.length - 1], "independent_report_issued", `${program.name} report issuance must remain the final gate`);
    assert.ok(map.auditGates.includes("type_ii_observation_period_completed"), `${program.name} must require a Type II observation period`);
    assert.ok(
      map.auditGates.indexOf("type_ii_observation_period_completed") < map.auditGates.indexOf("independent_report_issued"),
      `${program.name} observation period must precede report issuance`,
    );

    assert.match(doc, /not[\s\S]*?(?:certified|attested|audited)|must not be represented as[\s\S]*?(?:certified|attested|audited)/i);
    assert.match(doc, /production-like/i, `${program.name} readiness documentation must require production-like evidence`);
    assert.match(doc, /independent/i, `${program.name} readiness documentation must preserve independent assurance as an external gate`);
  });
}
