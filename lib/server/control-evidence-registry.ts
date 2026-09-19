/**
 * Typed registry mapping enterprise controls to the evidence sources that this
 * repository actually produces, plus the cadence each source must satisfy.
 *
 * Sources that need a live provider (identity provider, cloud project, vendor
 * register) are declared `provider_gated` and are never collectable here. They
 * stay visible in the register as an open gap instead of being fabricated.
 */

export type EvidenceCollection = "automated" | "provider_gated";
export type EvidenceConfidentiality = "internal" | "restricted";
export type ControlDomain =
  | "access"
  | "change_management"
  | "secure_development"
  | "tenant_isolation"
  | "resilience"
  | "data_lifecycle"
  | "vendor_management";

export type ControlDefinition = {
  controlCode: string;
  title: string;
  domain: ControlDomain;
  owner: string;
};

export type EvidenceSourceDefinition = {
  sourceKey: string;
  controlCode: string;
  title: string;
  /** In-repository artefact that emits the evidence. Verified by tests. */
  producer: string;
  owner: string;
  cadenceDays: number;
  graceDays: number;
  collection: EvidenceCollection;
  mandatory: boolean;
  confidentiality: EvidenceConfidentiality;
  /** Why a provider-gated source cannot yet be collected in-repository. */
  gatedOn?: string;
};

export const CONTROL_DEFINITIONS: readonly ControlDefinition[] = [
  { controlCode: "CHG-CI-GATE", title: "Merge-blocking quality and build gate", domain: "change_management", owner: "platform-engineering" },
  { controlCode: "CHG-IAC-DEPLOY", title: "Infrastructure change planned, reviewed and applied from version control", domain: "change_management", owner: "platform-engineering" },
  { controlCode: "SDL-DEPENDENCY", title: "Third-party dependency vulnerability gate", domain: "secure_development", owner: "security-engineering" },
  { controlCode: "SDL-SAST", title: "Static application security testing", domain: "secure_development", owner: "security-engineering" },
  { controlCode: "SDL-SECRET-SCAN", title: "Secret and forbidden-artifact scanning of the public repository", domain: "secure_development", owner: "security-engineering" },
  { controlCode: "ISO-TENANT-RLS", title: "Tenant isolation enforced by row level security", domain: "tenant_isolation", owner: "security-engineering" },
  { controlCode: "ISO-EDGE", title: "Edge, transport and origin protection", domain: "tenant_isolation", owner: "security-engineering" },
  { controlCode: "OPS-RUNTIME-READINESS", title: "Production binding readiness of the running service", domain: "resilience", owner: "platform-engineering" },
  { controlCode: "DLM-DELETION", title: "Retention and deletion requests executed and evidenced", domain: "data_lifecycle", owner: "privacy-office" },
  { controlCode: "ACC-REVIEW", title: "Periodic privileged access review", domain: "access", owner: "security-engineering" },
  { controlCode: "RES-BACKUP-RESTORE", title: "Backup, restore and disaster recovery exercise", domain: "resilience", owner: "platform-engineering" },
  { controlCode: "VUL-REMEDIATION", title: "Vulnerability remediation within agreed service levels", domain: "secure_development", owner: "security-engineering" },
  { controlCode: "VND-SUBPROCESSOR", title: "Critical vendor, subprocessor and data-location register", domain: "vendor_management", owner: "vendor-management" },
];

export const EVIDENCE_SOURCES: readonly EvidenceSourceDefinition[] = [
  {
    sourceKey: "ci.frontend-gate",
    controlCode: "CHG-CI-GATE",
    title: "Lint, typecheck, unit, build and browser E2E gate",
    producer: ".github/workflows/ci.yml",
    owner: "platform-engineering",
    cadenceDays: 7,
    graceDays: 3,
    collection: "automated",
    mandatory: true,
    confidentiality: "internal",
  },
  {
    sourceKey: "ci.dependency-audit",
    controlCode: "SDL-DEPENDENCY",
    title: "High-severity dependency audit",
    producer: ".github/workflows/ci.yml",
    owner: "security-engineering",
    cadenceDays: 7,
    graceDays: 3,
    collection: "automated",
    mandatory: true,
    confidentiality: "internal",
  },
  {
    sourceKey: "codeql.analysis",
    controlCode: "SDL-SAST",
    title: "CodeQL static analysis run",
    producer: ".github/workflows/codeql.yml",
    owner: "security-engineering",
    cadenceDays: 7,
    graceDays: 3,
    collection: "automated",
    mandatory: true,
    confidentiality: "internal",
  },
  {
    sourceKey: "leak-guard.secret-scan",
    controlCode: "SDL-SECRET-SCAN",
    title: "Repository history secret and forbidden-artifact scan",
    producer: ".github/workflows/public-repo-leak-guard.yml",
    owner: "security-engineering",
    cadenceDays: 7,
    graceDays: 3,
    collection: "automated",
    mandatory: true,
    confidentiality: "internal",
  },
  {
    sourceKey: "security-acceptance.postgres-rls",
    controlCode: "ISO-TENANT-RLS",
    title: "Two-tenant Postgres RLS acceptance run",
    producer: ".github/workflows/security-acceptance.yml",
    owner: "security-engineering",
    cadenceDays: 30,
    graceDays: 7,
    collection: "automated",
    mandatory: true,
    confidentiality: "restricted",
  },
  {
    sourceKey: "security-acceptance.edge",
    controlCode: "ISO-EDGE",
    title: "Edge, transport and direct-origin acceptance run",
    producer: ".github/workflows/security-acceptance.yml",
    owner: "security-engineering",
    cadenceDays: 30,
    graceDays: 7,
    collection: "automated",
    mandatory: true,
    confidentiality: "restricted",
  },
  {
    sourceKey: "terraform.deployment-record",
    controlCode: "CHG-IAC-DEPLOY",
    title: "Terraform plan and apply change record",
    producer: ".github/workflows/terraform-deploy.yml",
    owner: "platform-engineering",
    cadenceDays: 30,
    graceDays: 14,
    collection: "automated",
    mandatory: true,
    confidentiality: "restricted",
  },
  {
    sourceKey: "runtime.readiness-snapshot",
    controlCode: "OPS-RUNTIME-READINESS",
    title: "Automated runtime readiness snapshot",
    producer: "lib/server/operations.ts",
    owner: "platform-engineering",
    cadenceDays: 1,
    graceDays: 1,
    collection: "automated",
    mandatory: true,
    confidentiality: "internal",
  },
  {
    sourceKey: "lifecycle.deletion-execution",
    controlCode: "DLM-DELETION",
    title: "Executed deletion request completion evidence",
    producer: "lib/server/operations.ts",
    owner: "privacy-office",
    cadenceDays: 30,
    graceDays: 7,
    collection: "automated",
    mandatory: true,
    confidentiality: "restricted",
  },
  {
    sourceKey: "identity.privileged-access-review",
    controlCode: "ACC-REVIEW",
    title: "Quarterly privileged access review attestation",
    producer: "docs/ENTERPRISE_IMPLEMENTATION.md",
    owner: "security-engineering",
    cadenceDays: 90,
    graceDays: 14,
    collection: "provider_gated",
    mandatory: true,
    confidentiality: "restricted",
    gatedOn: "Requires the live identity provider membership export; no in-repository source exists.",
  },
  {
    sourceKey: "platform.backup-restore-exercise",
    controlCode: "RES-BACKUP-RESTORE",
    title: "Restore and disaster recovery exercise report",
    producer: "ops/RUNBOOK.md",
    owner: "platform-engineering",
    cadenceDays: 180,
    graceDays: 30,
    collection: "provider_gated",
    mandatory: true,
    confidentiality: "restricted",
    gatedOn: "Requires a live Postgres and object-store restore in a production-equivalent project.",
  },
  {
    sourceKey: "security.vulnerability-remediation",
    controlCode: "VUL-REMEDIATION",
    title: "Open vulnerability backlog against remediation service levels",
    producer: "ops/slos.yaml",
    owner: "security-engineering",
    cadenceDays: 30,
    graceDays: 7,
    collection: "provider_gated",
    mandatory: true,
    confidentiality: "restricted",
    gatedOn: "Requires the live scanner backlog and ticketing system; counts cannot be derived in-repository.",
  },
  {
    sourceKey: "vendor.subprocessor-register",
    controlCode: "VND-SUBPROCESSOR",
    title: "Critical vendor, subprocessor and data-location inventory",
    producer: "docs/INFRASTRUCTURE.md",
    owner: "vendor-management",
    cadenceDays: 180,
    graceDays: 30,
    collection: "provider_gated",
    mandatory: true,
    confidentiality: "restricted",
    gatedOn: "Requires live GCP, Cloudflare and Supabase configuration reads; copying them here would publish confidential configuration.",
  },
];

const SOURCES_BY_KEY = new Map(EVIDENCE_SOURCES.map((source) => [source.sourceKey, source]));
const CONTROLS_BY_CODE = new Map(CONTROL_DEFINITIONS.map((control) => [control.controlCode, control]));

export function evidenceSource(sourceKey: string): EvidenceSourceDefinition | undefined {
  return SOURCES_BY_KEY.get(sourceKey);
}

export function controlDefinition(controlCode: string): ControlDefinition | undefined {
  return CONTROLS_BY_CODE.get(controlCode);
}

export function isCollectable(source: EvidenceSourceDefinition): boolean {
  return source.collection === "automated";
}

export function evidenceSourcesForControl(controlCode: string): EvidenceSourceDefinition[] {
  return EVIDENCE_SOURCES.filter((source) => source.controlCode === controlCode);
}
