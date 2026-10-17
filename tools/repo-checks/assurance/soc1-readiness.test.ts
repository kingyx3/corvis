import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const readiness = JSON.parse(readFileSync(new URL("../../../ops/soc1-controls.json", import.meta.url), "utf8")) as {
  schemaVersion: string;
  target: { report: string; scopeBasis: string; claimState: string };
  controlObjectives: Array<{ id: string; name: string; status: string; owners: string[]; evidence: string[] }>;
  auditGates: string[];
};

const REQUIRED_OBJECTIVES = ["FR1", "FR2", "FR3", "FR4", "FR5", "FR6", "FR7", "FR8", "FR9", "FR10", "FR11"];

const REQUIRED_GATES = [
  "financial_reporting_relevance_confirmed",
  "system_description_and_control_objectives_approved",
  "subservice_and_cuec_treatment_agreed",
  "end_to_end_financially_relevant_data_flow_mapped",
  "production_like_provider_evidence_current",
  "input_completeness_evidenced",
  "review_reconciliation_publication_authorization_evidenced",
  "output_integrity_and_reproducibility_evidenced",
  "access_change_incident_vendor_controls_operating",
  "auditor_readiness_assessment_closed",
  "type_ii_observation_period_completed",
  "independent_report_issued",
];

test("SOC 1 readiness map covers every intended financially relevant control objective", () => {
  assert.equal(readiness.schemaVersion, "corvis.soc1-readiness.v1");
  assert.equal(readiness.target.report, "SOC 1 Type II");
  assert.equal(
    readiness.target.scopeBasis,
    "controls_likely_relevant_to_user_entities_internal_control_over_financial_reporting",
  );
  assert.deepEqual(new Set(readiness.controlObjectives.map((objective) => objective.id)), new Set(REQUIRED_OBJECTIVES));

  for (const objective of readiness.controlObjectives) {
    assert.ok(objective.name.trim(), `${objective.id} must have a name`);
    assert.ok(objective.status.trim(), `${objective.id} must have a readiness status`);
    assert.ok(objective.owners.length > 0, `${objective.id} must have an owner`);
    assert.ok(objective.evidence.length > 0, `${objective.id} must have evidence references`);
    assert.ok(objective.evidence.every((item) => item.trim().length > 0), `${objective.id} evidence references must be non-empty`);
  }
});

test("SOC 1 readiness remains readiness-only until the independent report is issued", () => {
  assert.equal(readiness.target.claimState, "readiness_only_until_independent_report_issued");
  assert.deepEqual(new Set(readiness.auditGates), new Set(REQUIRED_GATES));
  assert.ok(
    readiness.auditGates.indexOf("independent_report_issued") > readiness.auditGates.indexOf("type_ii_observation_period_completed"),
  );
});

// Evidence references mix prose (Confluence pages, auditor decisions) with repository files. Prose is not checkable
// here, but an entry that is nothing but a repository path must still exist, so a renamed or deleted file cannot leave
// the readiness map pointing at evidence that is gone.
test("SOC 1 control objective evidence entries that name repository files point at files that exist", () => {
  const repositoryPath = /^[\w./-]+\.(?:md|json|ts|sql|ya?ml|tf|sh|mjs)$/;
  const entries = readiness.controlObjectives.flatMap((item) => item.evidence.filter((entry) => repositoryPath.test(entry)).map((entry) => [item.id, entry] as const));
  assert.ok(entries.length > 0, "expected at least one repository-path evidence entry");
  for (const [id, entry] of entries) assert.ok(existsSync(new URL(`../../../${entry}`, import.meta.url)), `${id} evidence points at a missing file: ${entry}`);
});
