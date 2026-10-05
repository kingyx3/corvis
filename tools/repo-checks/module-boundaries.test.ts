import assert from "node:assert/strict";
import test from "node:test";
import { MODULE_BOUNDARIES, scanArchitectureDrift } from "../../services/control-loop/scanners/architecture-drift.ts";
import { loadRepoSnapshot } from "../../services/control-loop/scanners/repo-snapshot.ts";

// The control loop runs the same scan on a schedule; running it here makes a boundary violation fail the
// pull request that introduces it instead of opening an issue days later.

test("no domain or UI file imports across the module layer boundaries", async () => {
  const snapshot = await loadRepoSnapshot(process.cwd());
  const governed = snapshot.files.filter((file) => /^src\/(?:modules\/[^/]+\/(?:domain|ui)|shared\/(?:domain|ui))\//.test(file.path) && !/\.test\.tsx?$/.test(file.path));
  assert.ok(governed.length > 50, "expected the scan to cover the domain and ui layers");
  const findings = scanArchitectureDrift(snapshot.files);
  assert.deepEqual(findings.map((finding) => `${finding.ruleId} ${finding.path}: ${finding.detail}`), []);
});

test("both layer rules are active", () => {
  assert.deepEqual(MODULE_BOUNDARIES.map((boundary) => boundary.ruleId).sort(), ["CL-ARCH-001", "CL-ARCH-002"]);
});
