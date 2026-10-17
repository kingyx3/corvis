// Evaluates sanitized UAT evidence records against ops/uat/acceptance-plan.json.
// It never produces evidence: with no records, or with skipped/failed/missing
// ones, the campaign is `blocked`. Only provider-derived records for the exact
// release digest under test can make a scenario or required evidence item pass.

export type UatPlan = {
  version: 1;
  environment: "uat";
  requiredEvidence: string[];
  scenarios: Array<{ id: string; required: boolean; assertions: string[] }>;
};

export type UatOutcome = "passed" | "failed" | "skipped";

type UatRecordBase = {
  environment: "uat";
  releaseDigest: string;
  recordedAt: string;
  actor: string;
  resourceRef: string;
  expected: string;
  observed: string;
  outcome: UatOutcome;
  evidenceUri: string;
};

/** One assertion of a plan scenario, or one required evidence item (exactly one of the two subjects). */
export type UatEvidenceRecord = UatRecordBase & ({ scenarioId: string; assertionId: string; evidenceKey?: undefined } | { evidenceKey: string; scenarioId?: undefined; assertionId?: undefined });

export type UatItemStatus = "passed" | "failed" | "skipped" | "missing";

export type UatScorecard = {
  status: "ready" | "blocked";
  releaseDigest: string | null;
  errors: string[];
  scenarios: Array<{ id: string; required: boolean; status: UatItemStatus; assertions: Array<{ id: string; status: UatItemStatus }> }>;
  evidence: Array<{ key: string; status: UatItemStatus }>;
};

const DIGEST = /^sha256:[0-9a-f]{64}$/i;
const SECRET_VALUE = /(postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@]+@|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b)/;
const OUTCOMES: readonly string[] = ["passed", "failed", "skipped"];

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }

// Keys that look like they hold a credential are refused outright; values are scanned separately per record field.
const SECRET_KEY = /(password|passwd|token|dsn|credential|privatekey|clientsecret|apikey|secret)/;

function collectSecretKeys(value: unknown, path = "$", errors: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectSecretKeys(entry, `${path}[${index}]`, errors));
    return errors;
  }
  const obj = record(value);
  if (!obj) return errors;
  for (const [key, entry] of Object.entries(obj)) {
    if (SECRET_KEY.test(key.toLowerCase().replace(/[^a-z0-9]/g, ""))) errors.push(`${path}.${key} may contain secret material; record a sanitized reference`);
    collectSecretKeys(entry, `${path}.${key}`, errors);
  }
  return errors;
}

function evidenceLocationError(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return "evidenceUri must be an absolute URI"; }
  if (url.protocol !== "https:" && url.protocol !== "gs:") return "evidenceUri must be an https: or gs: location";
  if (url.username || url.password || url.search || url.hash) return "evidenceUri must not carry credentials, a query string or a fragment";
  return null;
}

function validateRecord(value: unknown, index: number, plan: UatPlan, now: Date): { record?: UatEvidenceRecord; errors: string[] } {
  const label = `records[${index}]`;
  const root = record(value);
  if (!root) return { errors: [`${label} must be an object`] };
  const errors: string[] = [];
  if (root.environment !== plan.environment) errors.push(`${label}.environment must be ${plan.environment}`);
  if (!DIGEST.test(text(root.releaseDigest))) errors.push(`${label}.releaseDigest must be an immutable sha256 digest`);
  const recordedAt = Date.parse(text(root.recordedAt));
  if (!Number.isFinite(recordedAt)) errors.push(`${label}.recordedAt must be an ISO timestamp`);
  else if (recordedAt > now.getTime()) errors.push(`${label}.recordedAt is in the future`);
  for (const field of ["actor", "resourceRef", "expected", "observed"] as const) {
    if (!text(root[field])) errors.push(`${label}.${field} is required`);
    else if (SECRET_VALUE.test(text(root[field]))) errors.push(`${label}.${field} appears to contain secret material; record a sanitized reference`);
  }
  if (!OUTCOMES.includes(text(root.outcome))) errors.push(`${label}.outcome must be passed, failed or skipped`);
  const locationError = evidenceLocationError(text(root.evidenceUri));
  if (locationError) errors.push(`${label}.${locationError}`);

  const scenarioId = text(root.scenarioId);
  const assertionId = text(root.assertionId);
  const evidenceKey = text(root.evidenceKey);
  if (evidenceKey && (scenarioId || assertionId)) errors.push(`${label} must name either a scenario assertion or an evidence key, not both`);
  else if (evidenceKey) {
    if (!plan.requiredEvidence.includes(evidenceKey)) errors.push(`${label}.evidenceKey ${evidenceKey} is not in the acceptance plan`);
  } else {
    const scenario = plan.scenarios.find((entry) => entry.id === scenarioId);
    if (!scenario) errors.push(`${label}.scenarioId ${scenarioId || "(missing)"} is not in the acceptance plan`);
    else if (!scenario.assertions.includes(assertionId)) errors.push(`${label}.assertionId ${assertionId || "(missing)"} is not an assertion of ${scenarioId}`);
  }
  if (errors.length > 0) return { errors };
  return { record: root as unknown as UatEvidenceRecord, errors: [] };
}

function statusOf(records: readonly UatEvidenceRecord[]): UatItemStatus {
  if (records.length === 0) return "missing";
  // The latest record decides, so a retest can supersede an earlier failure; a tie resolves to the worse outcome.
  const latest = Math.max(...records.map((entry) => Date.parse(entry.recordedAt)));
  const outcomes = records.filter((entry) => Date.parse(entry.recordedAt) === latest).map((entry) => entry.outcome);
  if (outcomes.includes("failed")) return "failed";
  if (outcomes.includes("skipped")) return "skipped";
  return "passed";
}

export function evaluateUatAcceptance(plan: UatPlan, evidence: unknown, now: Date = new Date()): UatScorecard {
  const errors: string[] = collectSecretKeys(evidence);
  const root = record(evidence);
  const rawRecords = root && Array.isArray(root.records) ? root.records : undefined;
  if (!rawRecords) errors.push("evidence must be an object with a records array");

  const records: UatEvidenceRecord[] = [];
  (rawRecords ?? []).forEach((value, index) => {
    const result = validateRecord(value, index, plan, now);
    errors.push(...result.errors);
    if (result.record) records.push(result.record);
  });

  const digests = [...new Set(records.map((entry) => entry.releaseDigest.toLowerCase()))];
  if (digests.length > 1) errors.push("records name more than one releaseDigest; one campaign evidences exactly one release");

  const forScenario = (id: string, assertion: string) => records.filter((entry) => entry.scenarioId === id && entry.assertionId === assertion);
  const scenarios = plan.scenarios.map((scenario) => {
    const assertions = scenario.assertions.map((id) => ({ id, status: statusOf(forScenario(scenario.id, id)) }));
    const status: UatItemStatus = assertions.every((entry) => entry.status === "passed") ? "passed"
      : assertions.some((entry) => entry.status === "failed") ? "failed"
        : assertions.some((entry) => entry.status === "skipped") ? "skipped" : "missing";
    return { id: scenario.id, required: scenario.required, status, assertions };
  });
  const required = plan.requiredEvidence.map((key) => ({ key, status: statusOf(records.filter((entry) => entry.evidenceKey === key)) }));

  const planUsable = plan.version === 1 && plan.environment === "uat" && (plan.scenarios.length > 0 || plan.requiredEvidence.length > 0);
  if (!planUsable) errors.push("acceptance plan is unusable: it must be version 1, target uat and require something");
  const ready = planUsable && errors.length === 0
    && scenarios.every((scenario) => !scenario.required || scenario.status === "passed")
    && required.every((entry) => entry.status === "passed");
  return { status: ready ? "ready" : "blocked", releaseDigest: digests.length === 1 ? digests[0] as string : null, errors, scenarios, evidence: required };
}
