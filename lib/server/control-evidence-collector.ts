import { createHash, randomUUID } from "crypto";
import { getServerConfig } from "./config.ts";
import { postgres, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";
import { evidenceSource } from "./control-evidence-registry.ts";

/**
 * First real collector for the control-evidence lifecycle schema
 * (db/postgres/migrations/016_control_evidence_lifecycle.sql). It turns the
 * JSON evidence artifact `.github/workflows/security-acceptance.yml` already
 * produces into an append-only, hash-chained `control_evidence_record` row,
 * then attempts the server-side promotion gate. Nothing else in the
 * application writes to this schema yet; see issue #14.
 *
 * Two JSON shapes are accepted, one per security-acceptance job:
 *  - `corvis.security-acceptance.v1` (the edge job's security-acceptance-evidence.json)
 *  - `corvis.postgres-rls-security-acceptance.v1` (the postgres-rls job's evidence file)
 */

export type SecurityAcceptanceCheckResult = "pass" | "fail";

export type SecurityAcceptanceEdgeEvidence = {
  schemaVersion: "corvis.security-acceptance.v1" | "corvis.security-acceptance.v3";
  environment: string;
  checkedAt: string;
  source: string;
  checks: ReadonlyArray<{ name: string; status: SecurityAcceptanceCheckResult | "skip"; startedAt?: string; detail?: unknown }>;
  summary: { passed: number; failed: number; skipped?: number };
};

export type SecurityAcceptancePostgresRlsEvidence = {
  schemaVersion: "corvis.postgres-rls-security-acceptance.v1";
  environment: string;
  checkedAt: string;
  result: SecurityAcceptanceCheckResult;
  source: string;
  checks: ReadonlyArray<string>;
};

export type SecurityAcceptanceEvidenceFile = SecurityAcceptanceEdgeEvidence | SecurityAcceptancePostgresRlsEvidence;

/** Maps each accepted evidence schema to the registry's sourceKey it satisfies. */
const SCHEMA_SOURCE_KEYS: Record<SecurityAcceptanceEvidenceFile["schemaVersion"], string> = {
  "corvis.security-acceptance.v1": "security-acceptance.edge",
  "corvis.security-acceptance.v3": "security-acceptance.edge",
  "corvis.postgres-rls-security-acceptance.v1": "security-acceptance.postgres-rls",
};

export class ControlEvidenceCollectionError extends Error {}

/** Validates and narrows an arbitrary parsed-JSON value to a known evidence shape. */
export function parseSecurityAcceptanceEvidence(raw: unknown): SecurityAcceptanceEvidenceFile {
  if (!raw || typeof raw !== "object") {
    throw new ControlEvidenceCollectionError("Security acceptance evidence must be a JSON object");
  }
  const value = raw as Record<string, unknown>;
  const schemaVersion = value.schemaVersion;
  if (schemaVersion !== "corvis.security-acceptance.v1" && schemaVersion !== "corvis.security-acceptance.v3" && schemaVersion !== "corvis.postgres-rls-security-acceptance.v1") {
    throw new ControlEvidenceCollectionError(`Unsupported security-acceptance evidence schemaVersion: ${JSON.stringify(schemaVersion)}`);
  }
  if (typeof value.checkedAt !== "string" || !value.checkedAt) {
    throw new ControlEvidenceCollectionError("Evidence is missing a string checkedAt timestamp");
  }
  if (typeof value.environment !== "string" || !value.environment) {
    throw new ControlEvidenceCollectionError("Evidence is missing a string environment");
  }
  if (Number.isNaN(Date.parse(value.checkedAt as string))) {
    throw new ControlEvidenceCollectionError("Evidence checkedAt is invalid");
  }
  if (value.source !== "github-actions") {
    throw new ControlEvidenceCollectionError("Evidence source must be github-actions");
  }
  if (!Array.isArray(value.checks) || value.checks.length === 0) {
    throw new ControlEvidenceCollectionError("Evidence must contain nonempty checks");
  }
  if (schemaVersion === "corvis.postgres-rls-security-acceptance.v1") {
    if (value.result !== "pass" && value.result !== "fail") {
      throw new ControlEvidenceCollectionError("Postgres RLS evidence is missing a pass/fail result");
    }
    if (value.checks.some((check) => typeof check !== "string" || !check.trim()) ||
        new Set(value.checks).size !== value.checks.length) {
      throw new ControlEvidenceCollectionError("Postgres RLS checks must be unique nonempty names");
    }
  } else {
    const names = new Set<string>();
    const counts = { pass: 0, fail: 0, skip: 0 };
    for (const check of value.checks) {
      if (!check || typeof check.name !== "string" || !check.name.trim() || names.has(check.name) ||
          !["pass", "fail", "skip"].includes(check.status)) {
        throw new ControlEvidenceCollectionError("Invalid or duplicate edge check");
      }
      names.add(check.name);
      counts[check.status as keyof typeof counts] += 1;
    }
    const summary = value.summary as Record<string, unknown> | undefined;
    if (!summary || summary.passed !== counts.pass || summary.failed !== counts.fail ||
        (summary.skipped ?? 0) !== counts.skip) {
      throw new ControlEvidenceCollectionError("Edge summary does not match individual checks");
    }
    if (schemaVersion === "corvis.security-acceptance.v3") {
      const required = ["customer-edge-https", "admin-edge-https", "api-https-and-cache-isolation",
        "http-redirects-to-https", "csrf-cors-cross-site-block", "cloudflare-waf-probe",
        "cloudflare-rate-limit-probe", "direct-load-balancer-origin-mtls-blocked",
        "direct-cloud-run-origin-bypass-blocked"];
      if (required.some((name) => !names.has(name))) {
        throw new ControlEvidenceCollectionError("Edge evidence is missing required checks");
      }
    }
  }
  return value as unknown as SecurityAcceptanceEvidenceFile;
}

/** The pass/fail this evidence file represents, independent of its two different shapes. */
export function securityAcceptanceResult(evidence: SecurityAcceptanceEvidenceFile): SecurityAcceptanceCheckResult {
  return evidence.schemaVersion === "corvis.postgres-rls-security-acceptance.v1"
    ? evidence.result
    : evidence.checks.length > 0 && evidence.checks.every((check) => check.status === "pass")
      ? "pass"
      : "fail";
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((accumulator, key) => {
        accumulator[key] = canonicalize((value as Record<string, unknown>)[key]);
        return accumulator;
      }, {});
  }
  return value;
}

/**
 * Chains this payload's digest off the previous record's digest, per the
 * hash-chain scheme in migration 016: `payload_digest` is a hex sha256, and
 * a tampered or reordered history changes every digest after the tamper.
 */
export function computePayloadDigest(evidence: SecurityAcceptanceEvidenceFile, previousDigest: string | null): string {
  const canonicalPayload = JSON.stringify(canonicalize(evidence));
  return createHash("sha256").update(previousDigest ?? "", "utf8").update(canonicalPayload, "utf8").digest("hex");
}

function controlDb(dsn = getServerConfig().postgresDsn): PostgresSqlApi {
  return postgres(dsn);
}

export type CollectSecurityAcceptanceEvidenceInput = {
  tenantId: string;
  evidence: SecurityAcceptanceEvidenceFile;
  /** Attributable collector identity recorded on the record, e.g. "ci:security-acceptance". */
  collectedBy: string;
  /** Link back to the CI run that produced this evidence, if available. */
  sourceRunUri?: string;
  /** Evaluation instant for the promotion gate; defaults to now. */
  now?: Date;
};

export type CollectSecurityAcceptanceEvidenceOutcome = {
  evidenceRecordId: string;
  controlCode: string;
  sourceKey: string;
  revision: number;
  result: SecurityAcceptanceCheckResult;
  payloadDigest: string;
  previousDigest: string | null;
  collectedAt: string;
  validThrough: string;
  /** The control's new version when this evidence promoted it, otherwise null. */
  promotedVersion: number | null;
};

/**
 * Records one security-acceptance evidence artifact as a new, hash-chained
 * `control_evidence_record` revision, then attempts
 * `corvis_control.promote_control_implementation` for its control. A passing
 * record is chained and, if every other mandatory source for the control is
 * also current, promotes the control; a failing record is still recorded
 * (evidence is append-only either way) but never attempts promotion, since
 * the gate could not pass with this revision as its own latest record. Any
 * database error — from the lookup, the insert, or the promotion call — is
 * thrown to the caller rather than swallowed.
 */
export async function collectSecurityAcceptanceEvidence(
  input: CollectSecurityAcceptanceEvidenceInput,
  db: PostgresSqlApi = controlDb(),
): Promise<CollectSecurityAcceptanceEvidenceOutcome> {
  const { tenantId, collectedBy } = input;
  const evidence = parseSecurityAcceptanceEvidence(input.evidence);
  if (!tenantId) throw new ControlEvidenceCollectionError("tenantId is required to record control evidence");
  if (!collectedBy) throw new ControlEvidenceCollectionError("collectedBy is required to record control evidence");

  const sourceKey = SCHEMA_SOURCE_KEYS[evidence.schemaVersion];
  const source = evidenceSource(sourceKey);
  if (!source) throw new ControlEvidenceCollectionError(`No evidence-source registry entry for ${sourceKey}`);
  if (source.collection !== "automated") {
    throw new ControlEvidenceCollectionError(`${sourceKey} is provider_gated and cannot be collected automatically`);
  }

  const result = securityAcceptanceResult(evidence);
  const now = input.now ?? new Date();
  const collectedAt = new Date(evidence.checkedAt);
  if (Number.isNaN(collectedAt.getTime())) {
    throw new ControlEvidenceCollectionError(`Evidence checkedAt is not a valid timestamp: ${evidence.checkedAt}`);
  }
  const validThrough = new Date(collectedAt.getTime() + source.cadenceDays * 24 * 60 * 60 * 1000);

  const priorRows: PostgresRow[] = await db.query(
    `select revision, payload_digest from corvis_control.control_evidence_record
      where tenant_id=$1 and control_code=$2 and source_key=$3
      order by revision desc limit 1`,
    [tenantId, source.controlCode, sourceKey],
  );
  const previous = priorRows[0];
  const previousDigest = previous ? String(previous.payload_digest) : null;
  const revision = previous ? Number(previous.revision) + 1 : 1;
  const payloadDigest = computePayloadDigest(evidence, previousDigest);
  const evidenceRecordId = randomUUID();

  await db.execute(
    `insert into corvis_control.control_evidence_record
        (tenant_id, evidence_record_id, control_code, source_key, revision, result, collection_method,
         collected_at, valid_through, collected_by, source_run_uri, payload_digest, payload_location, previous_digest)
      values ($1,$2::uuid,$3,$4,$5,$6,'automated',$7::timestamptz,$8::timestamptz,$9,$10,$11,$12,$13)`,
    [
      tenantId,
      evidenceRecordId,
      source.controlCode,
      sourceKey,
      revision,
      result,
      collectedAt.toISOString(),
      validThrough.toISOString(),
      collectedBy,
      input.sourceRunUri ?? null,
      payloadDigest,
      null,
      previousDigest,
    ],
  );

  let promotedVersion: number | null = null;
  if (result === "pass") {
    const promotionRows = await db.query(
      `select corvis_control.promote_control_implementation($1::uuid,$2,$3,$4::timestamptz) as new_version`,
      [tenantId, source.controlCode, collectedBy, now.toISOString()],
    );
    const value = promotionRows[0]?.new_version;
    promotedVersion = value == null ? null : Number(value);
  }

  return {
    evidenceRecordId,
    controlCode: source.controlCode,
    sourceKey,
    revision,
    result,
    payloadDigest,
    previousDigest,
    collectedAt: collectedAt.toISOString(),
    validThrough: validThrough.toISOString(),
    promotedVersion,
  };
}
