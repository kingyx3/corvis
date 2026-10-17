import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluateUatAcceptance, type UatPlan } from "./uat-acceptance.ts";

const NOW = new Date("2026-10-17T12:00:00.000Z");
const DIGEST = `sha256:${"a".repeat(64)}`;

const plan: UatPlan = {
  version: 1,
  environment: "uat",
  requiredEvidence: ["known-good-rollback"],
  scenarios: [
    { id: "success-path", required: true, assertions: ["registered-to-published", "single-publication"] },
    { id: "optional-drill", required: false, assertions: ["drill"] },
  ],
};

function base(overrides: Record<string, unknown> = {}) {
  return {
    environment: "uat", releaseDigest: DIGEST, recordedAt: "2026-10-17T10:00:00.000Z", actor: "uat-operator",
    resourceRef: "tenant:synthetic-1/document:doc-1", expected: "published once", observed: "published once",
    outcome: "passed", evidenceUri: "gs://corvis-uat-evidence/run-1/success.json", ...overrides,
  };
}
const assertion = (assertionId: string, overrides: Record<string, unknown> = {}) => base({ scenarioId: "success-path", assertionId, ...overrides });
const complete = () => ({
  records: [assertion("registered-to-published"), assertion("single-publication"), base({ evidenceKey: "known-good-rollback", resourceRef: "release:previous" })],
});

test("a complete set of sanitized passing records for one release digest is ready", () => {
  const card = evaluateUatAcceptance(plan, complete(), NOW);
  assert.equal(card.status, "ready");
  assert.deepEqual(card.errors, []);
  assert.equal(card.releaseDigest, DIGEST);
  assert.deepEqual(card.scenarios.map((scenario) => [scenario.id, scenario.status]), [["success-path", "passed"], ["optional-drill", "missing"]]);
  assert.deepEqual(card.evidence, [{ key: "known-good-rollback", status: "passed" }]);
});

test("no evidence at all is blocked and reports every required item as missing", () => {
  for (const evidence of [{ records: [] }, {}, null, "nope"]) {
    const card = evaluateUatAcceptance(plan, evidence, NOW);
    assert.equal(card.status, "blocked");
    assert.equal(card.releaseDigest, null);
  }
  const card = evaluateUatAcceptance(plan, { records: [] }, NOW);
  assert.deepEqual(card.errors, []);
  assert.equal(card.scenarios[0]?.status, "missing");
  assert.equal(card.evidence[0]?.status, "missing");
});

test("skipped, failed and missing assertions each keep a required scenario from passing", () => {
  const skipped = evaluateUatAcceptance(plan, { records: [assertion("registered-to-published"), assertion("single-publication", { outcome: "skipped" }), ...complete().records.slice(2)] }, NOW);
  assert.equal(skipped.status, "blocked");
  assert.equal(skipped.scenarios[0]?.status, "skipped");
  const failed = evaluateUatAcceptance(plan, { records: [assertion("registered-to-published", { outcome: "failed" }), assertion("single-publication"), ...complete().records.slice(2)] }, NOW);
  assert.equal(failed.scenarios[0]?.status, "failed");
  const missing = evaluateUatAcceptance(plan, { records: [assertion("registered-to-published"), ...complete().records.slice(2)] }, NOW);
  assert.equal(missing.scenarios[0]?.status, "missing");
  assert.equal(missing.status, "blocked");
  const noEvidenceItem = evaluateUatAcceptance(plan, { records: complete().records.slice(0, 2) }, NOW);
  assert.equal(noEvidenceItem.status, "blocked");
});

test("the latest record decides, so a retest supersedes an earlier failure but a later failure wins", () => {
  const retested = complete();
  retested.records.push(assertion("single-publication", { outcome: "failed", recordedAt: "2026-10-17T08:00:00.000Z" }));
  assert.equal(evaluateUatAcceptance(plan, retested, NOW).status, "ready");
  const regressed = complete();
  regressed.records.push(assertion("single-publication", { outcome: "failed", recordedAt: "2026-10-17T11:00:00.000Z" }));
  assert.equal(evaluateUatAcceptance(plan, regressed, NOW).status, "blocked");
  const tie = complete();
  tie.records.push(assertion("single-publication", { outcome: "failed" }), assertion("registered-to-published", { outcome: "skipped" }));
  const card = evaluateUatAcceptance(plan, tie, NOW);
  assert.equal(card.scenarios[0]?.assertions[1]?.status, "failed");
  assert.equal(card.scenarios[0]?.assertions[0]?.status, "skipped");
});

test("an optional scenario never gates readiness", () => {
  const card = evaluateUatAcceptance(plan, { records: [...complete().records, base({ scenarioId: "optional-drill", assertionId: "drill", outcome: "failed" })] }, NOW);
  assert.equal(card.status, "ready");
  assert.equal(card.scenarios[1]?.status, "failed");
});

test("records for more than one release digest are rejected", () => {
  const mixed = complete();
  mixed.records[1] = assertion("single-publication", { releaseDigest: `sha256:${"b".repeat(64)}` });
  const card = evaluateUatAcceptance(plan, mixed, NOW);
  assert.equal(card.status, "blocked");
  assert.equal(card.releaseDigest, null);
  assert.match(card.errors.join("\n"), /more than one releaseDigest/);
});

test("malformed records are listed individually and block", () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [assertion("single-publication", { environment: "prod" }), /environment must be uat/],
    [assertion("single-publication", { releaseDigest: "latest" }), /immutable sha256 digest/],
    [assertion("single-publication", { recordedAt: "yesterday" }), /ISO timestamp/],
    [assertion("single-publication", { recordedAt: "2026-10-18T00:00:00.000Z" }), /in the future/],
    [assertion("single-publication", { actor: " " }), /actor is required/],
    [assertion("single-publication", { outcome: "ok" }), /outcome must be/],
    [assertion("single-publication", { evidenceUri: "not a uri" }), /absolute URI/],
    [assertion("single-publication", { evidenceUri: "http://example.test/e.json" }), /https: or gs:/],
    [assertion("single-publication", { evidenceUri: "https://example.test/e.json?token=abc" }), /credentials, a query string or a fragment/],
    [assertion("single-publication", { evidenceUri: "https://user@example.test/e.json" }), /credentials, a query string or a fragment/],
    [assertion("unknown-assertion"), /not an assertion of success-path/],
    [base({ scenarioId: "no-such-scenario", assertionId: "x" }), /scenarioId no-such-scenario is not in the acceptance plan/],
    [base({ scenarioId: "success-path" }), /assertionId \(missing\) is not an assertion/],
    [base({ evidenceKey: "not-required" }), /evidenceKey not-required is not in the acceptance plan/],
    [base({ evidenceKey: "known-good-rollback", scenarioId: "success-path" }), /either a scenario assertion or an evidence key/],
    [base({ scenarioId: undefined }), /scenarioId \(missing\)/],
  ];
  for (const [bad, pattern] of cases) {
    const card = evaluateUatAcceptance(plan, { records: [...complete().records, bad] }, NOW);
    assert.equal(card.status, "blocked", String(pattern));
    assert.match(card.errors.join("\n"), pattern);
  }
  const notObject = evaluateUatAcceptance(plan, { records: [...complete().records, 7] }, NOW);
  assert.match(notObject.errors.join("\n"), /records\[3\] must be an object/);
});

test("evidence is rejected when it carries secret material, by key or by value", () => {
  const byKey = evaluateUatAcceptance(plan, { records: [...complete().records.slice(0, 2), { ...base({ evidenceKey: "known-good-rollback" }), accessToken: "x" }] }, NOW);
  assert.equal(byKey.status, "blocked");
  assert.match(byKey.errors.join("\n"), /may contain secret material/);
  for (const observed of ["connected via postgres://app:hunter2@db.example.test/corvis", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345", "-----BEGIN PRIVATE KEY-----", "ghp_abcdefghijklmnopqrstuvwxyz0123"]) {
    const card = evaluateUatAcceptance(plan, { records: [...complete().records, assertion("single-publication", { observed })] }, NOW);
    assert.equal(card.status, "blocked", observed);
    assert.match(card.errors.join("\n"), /appears to contain secret material/);
  }
});

test("an unusable plan never reports ready", () => {
  for (const unusable of [{ ...plan, version: 2 }, { ...plan, environment: "prod" }, { ...plan, scenarios: [], requiredEvidence: [] }] as unknown as UatPlan[]) {
    const card = evaluateUatAcceptance(unusable, { records: [] }, NOW);
    assert.equal(card.status, "blocked");
    assert.match(card.errors.join("\n"), /acceptance plan is unusable/);
  }
});

test("the real acceptance plan stays blocked without evidence and lists every required item as missing", async () => {
  const real = JSON.parse(await readFile("ops/uat/acceptance-plan.json", "utf8")) as UatPlan;
  const card = evaluateUatAcceptance(real, { records: [] }, NOW);
  assert.equal(card.status, "blocked");
  assert.deepEqual(card.errors, []);
  assert.equal(card.scenarios.length, real.scenarios.length);
  assert.ok(card.scenarios.every((scenario) => scenario.status === "missing"));
  assert.ok(card.evidence.every((entry) => entry.status === "missing"));
  assert.ok(card.evidence.length >= 15);
});

test("the CLI exits 2 without arguments, 1 when blocked or unreadable, and 0 only when ready", async () => {
  const run = (...args: string[]) => spawnSync(process.execPath, ["tools/dev/uat-acceptance.ts", ...args], { encoding: "utf8" });
  assert.equal(run().status, 2);
  const dir = await mkdtemp(join(tmpdir(), "uat-acceptance-"));
  try {
    const planPath = join(dir, "plan.json");
    const evidencePath = join(dir, "evidence.json");
    await writeFile(planPath, JSON.stringify(plan));
    await writeFile(evidencePath, JSON.stringify({ records: [] }));
    const blocked = run(evidencePath, planPath);
    assert.equal(blocked.status, 1);
    assert.equal(JSON.parse(blocked.stdout).status, "blocked");
    // The CLI uses the real clock, so date the records well in the past.
    await writeFile(evidencePath, JSON.stringify({ records: complete().records.map((entry) => ({ ...entry, recordedAt: "2026-01-01T00:00:00.000Z" })) }));
    const ready = run(evidencePath, planPath);
    assert.equal(ready.status, 0);
    assert.equal(JSON.parse(ready.stdout).status, "ready");
    assert.equal(run(join(dir, "missing.json"), planPath).status, 1);
    // The default plan path is the real acceptance plan, which this evidence does not satisfy.
    assert.equal(run(evidencePath).status, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
