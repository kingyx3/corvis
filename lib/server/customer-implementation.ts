export type CustomerImplementationManifest = {
  schemaVersion: "1";
  customerKey: string;
  environment: "uat" | "prod";
  tenantId: string;
  workspaceId: string;
  release: {
    commitSha: string;
    imageDigest: string;
    migrationVersion: number;
  };
  rights: {
    fundIds: string[];
    sourceDocumentAccessAllowed: boolean;
    redistributionAllowed: boolean;
  };
  providers: {
    postgresSecretName: string;
    objectBucket: string;
    sourceConnectionIds: string[];
    deliveryWebhookIds: string[];
  };
  cutover: {
    rollbackImageDigest: string;
    owner: string;
    changeReference: string;
  };
};

export type CustomerAcceptanceEvidence = {
  releaseGovernancePassed: boolean;
  migrationsCurrent: boolean;
  runtimeSecretsReady: boolean;
  sourceConnectivity: boolean;
  deliveryConnectivity: boolean;
  tenantIsolationVerified: boolean;
  lineageComplete: boolean;
  backfillReconciled: boolean;
  rollbackVerified: boolean;
  unresolvedExceptions: number;
  undocumentedManualInterventions: number;
};

export type AcceptanceCheck = { key: string; passed: boolean; detail: string };
export type CustomerAcceptanceScorecard = {
  status: "ready" | "blocked";
  checks: AcceptanceCheck[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/i;
const DIGEST = /^sha256:[0-9a-f]{64}$/i;
const CUSTOMER_KEY = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) return undefined;
  return value.map((entry) => entry.trim());
}
function unique(values: string[]): boolean { return new Set(values).size === values.length; }

function isSecretReferenceKey(key: string): boolean {
  const compact = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return compact.endsWith("secretname") || compact.endsWith("secretid") || compact.endsWith("secretreference");
}

function collectSecretMaterial(value: unknown, path = "$", errors: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectSecretMaterial(entry, `${path}[${index}]`, errors));
    return errors;
  }
  const obj = record(value);
  if (!obj) return errors;
  for (const [key, entry] of Object.entries(obj)) {
    const compact = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    const secretLike = /(password|passwd|token|dsn|credential|privatekey|clientsecret|apikey|secret)/.test(compact);
    if (secretLike && !isSecretReferenceKey(key)) errors.push(`${path}.${key} may contain secret material; store only a provider/Secret Manager reference`);
    collectSecretMaterial(entry, `${path}.${key}`, errors);
  }
  return errors;
}

export function validateCustomerImplementationManifest(value: unknown): {
  valid: boolean;
  errors: string[];
  manifest?: CustomerImplementationManifest;
} {
  const errors = collectSecretMaterial(value);
  const root = record(value);
  if (!root) return { valid: false, errors: [...errors, "manifest must be an object"] };
  const release = record(root.release);
  const rights = record(root.rights);
  const providers = record(root.providers);
  const cutover = record(root.cutover);
  if (root.schemaVersion !== "1") errors.push("schemaVersion must be 1");
  if (!CUSTOMER_KEY.test(text(root.customerKey))) errors.push("customerKey must be a stable lowercase slug");
  if (root.environment !== "uat" && root.environment !== "prod") errors.push("environment must be uat or prod");
  if (!UUID.test(text(root.tenantId))) errors.push("tenantId must be a UUID");
  if (!UUID.test(text(root.workspaceId))) errors.push("workspaceId must be a UUID");
  if (!release) errors.push("release is required");
  if (!rights) errors.push("rights is required");
  if (!providers) errors.push("providers is required");
  if (!cutover) errors.push("cutover is required");

  const fundIds = stringArray(rights?.fundIds);
  const sourceConnectionIds = stringArray(providers?.sourceConnectionIds);
  const deliveryWebhookIds = stringArray(providers?.deliveryWebhookIds);
  if (!release || !SHA.test(text(release.commitSha))) errors.push("release.commitSha must be an exact 40-character commit SHA");
  if (!release || !DIGEST.test(text(release.imageDigest))) errors.push("release.imageDigest must be an immutable sha256 digest");
  if (!release || !Number.isInteger(release.migrationVersion) || Number(release.migrationVersion) <= 0) errors.push("release.migrationVersion must be a positive integer");
  if (!rights || !fundIds || fundIds.length === 0 || !unique(fundIds)) errors.push("rights.fundIds must be a non-empty unique string array");
  if (!rights || typeof rights.sourceDocumentAccessAllowed !== "boolean") errors.push("rights.sourceDocumentAccessAllowed must be boolean");
  if (!rights || typeof rights.redistributionAllowed !== "boolean") errors.push("rights.redistributionAllowed must be boolean");
  if (!providers || !text(providers.postgresSecretName)) errors.push("providers.postgresSecretName must reference the runtime secret container");
  if (!providers || !text(providers.objectBucket)) errors.push("providers.objectBucket is required");
  if (!providers || !sourceConnectionIds || !unique(sourceConnectionIds)) errors.push("providers.sourceConnectionIds must be a unique string array");
  if (!providers || !deliveryWebhookIds || !unique(deliveryWebhookIds)) errors.push("providers.deliveryWebhookIds must be a unique string array");
  if (!cutover || !DIGEST.test(text(cutover.rollbackImageDigest))) errors.push("cutover.rollbackImageDigest must be an immutable sha256 digest");
  if (!cutover || !text(cutover.owner)) errors.push("cutover.owner is required");
  if (!cutover || !text(cutover.changeReference)) errors.push("cutover.changeReference is required");

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, errors: [], manifest: value as CustomerImplementationManifest };
}

export function evaluateCustomerAcceptance(evidence: CustomerAcceptanceEvidence): CustomerAcceptanceScorecard {
  const checks: AcceptanceCheck[] = [
    { key: "release_governance", passed: evidence.releaseGovernancePassed, detail: "exact release commit passed effective review/check governance" },
    { key: "migrations_current", passed: evidence.migrationsCurrent, detail: "database migration ledger matches the reviewed release" },
    { key: "runtime_secrets", passed: evidence.runtimeSecretsReady, detail: "required runtime secret references have usable current versions" },
    { key: "source_connectivity", passed: evidence.sourceConnectivity, detail: "approved source/upload path is reachable with scoped credentials" },
    { key: "delivery_connectivity", passed: evidence.deliveryConnectivity, detail: "enabled customer delivery bindings pass a live preflight" },
    { key: "tenant_isolation", passed: evidence.tenantIsolationVerified, detail: "tenant/RLS negative acceptance passed for this implementation" },
    { key: "lineage", passed: evidence.lineageComplete, detail: "representative source-to-serving lineage is complete" },
    { key: "backfill", passed: evidence.backfillReconciled, detail: "historical backfill/reconciliation is complete or explicitly not required" },
    { key: "rollback", passed: evidence.rollbackVerified, detail: "known-good rollback/cutback path was exercised" },
    { key: "exceptions", passed: Number.isInteger(evidence.unresolvedExceptions) && evidence.unresolvedExceptions === 0, detail: "no unresolved acceptance exception remains" },
    { key: "manual_dependency", passed: Number.isInteger(evidence.undocumentedManualInterventions) && evidence.undocumentedManualInterventions === 0, detail: "no undocumented recurring engineering intervention is required" },
  ];
  return { status: checks.every((check) => check.passed) ? "ready" : "blocked", checks };
}
