import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const readiness = JSON.parse(readFileSync(new URL("../../ops/soc2-controls.json", import.meta.url), "utf8")) as {
  schemaVersion: string;
  target: { report: string; claimState: string; mandatoryCategories: string[]; conditionalCategories: string[] };
  families: Array<{ id: string; name: string; status: string; owners: string[]; evidence: string[] }>;
  auditGates: string[];
};

const REQUIRED_FAMILIES = ["CC1", "CC2", "CC3", "CC4", "CC5", "CC6", "CC7", "CC8", "CC9", "A", "C", "PI", "P"];

const REQUIRED_GATES = [
  "scope_and_system_description_approved",
  "policies_approved_and_acknowledged",
  "risk_assessment_operating",
  "production_like_uat_evidence_current",
  "access_reviews_current",
  "backup_restore_dr_exercised",
  "incident_tabletop_exercised",
  "vulnerability_program_operating",
  "vendor_diligence_current",
  "independent_security_assessment_closed",
  "auditor_readiness_and_sampling_agreed",
  "type_ii_observation_period_completed",
  "independent_report_issued",
];

test("SOC 2 readiness map covers every intended criteria family with owners and evidence", () => {
  assert.equal(readiness.schemaVersion, "corvis.soc2-readiness.v1");
  assert.equal(readiness.target.report, "SOC 2 Type II");
  assert.equal(readiness.target.claimState, "readiness_only_until_independent_report_issued");
  assert.deepEqual(new Set(readiness.families.map((family) => family.id)), new Set(REQUIRED_FAMILIES));

  for (const family of readiness.families) {
    assert.ok(family.name.trim(), `${family.id} must have a name`);
    assert.ok(family.status.trim(), `${family.id} must have a readiness status`);
    assert.ok(family.owners.length > 0, `${family.id} must have an owner`);
    assert.ok(family.evidence.length > 0, `${family.id} must have evidence references`);
    assert.ok(family.evidence.every((item) => item.trim().length > 0), `${family.id} evidence references must be non-empty`);
  }
});

test("SOC 2 readiness map keeps audit issuance as an external final gate", () => {
  assert.deepEqual(new Set(readiness.auditGates), new Set(REQUIRED_GATES));
  assert.ok(readiness.auditGates.indexOf("independent_report_issued") > readiness.auditGates.indexOf("type_ii_observation_period_completed"));
  assert.ok(readiness.target.mandatoryCategories.includes("security"));
  assert.ok(readiness.target.mandatoryCategories.includes("availability"));
  assert.ok(readiness.target.mandatoryCategories.includes("confidentiality"));
  assert.ok(readiness.target.mandatoryCategories.includes("processing_integrity"));
  assert.ok(readiness.target.conditionalCategories.includes("privacy"));
});
