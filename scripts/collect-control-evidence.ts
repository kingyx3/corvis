import { readFile } from "node:fs/promises";
import {
  collectSecurityAcceptanceEvidence,
  parseSecurityAcceptanceEvidence,
} from "../lib/server/control-evidence-collector.ts";

/**
 * CI entry point that turns a security-acceptance JSON evidence artifact
 * into a control_evidence_record row (issue #14's "no automated collector"
 * gap). Invoked as an added step in .github/workflows/security-acceptance.yml
 * after that workflow's existing evidence-artifact step, with the evidence
 * file path as the sole argument:
 *
 *   node scripts/collect-control-evidence.ts postgres-rls-security-acceptance-evidence.json
 *
 * The control-evidence Postgres database is not provisioned in CI yet, so a
 * missing CORVIS_POSTGRES_DSN or CORVIS_CONTROL_TENANT_ID is treated as a
 * clean, zero-exit-code skip rather than a failure — this script only ever
 * fails the calling step once those are configured and a real collection
 * error occurs.
 */

function sourceRunUri(): string | undefined {
  const serverUrl = process.env.GITHUB_SERVER_URL;
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  if (!serverUrl || !repository || !runId) return undefined;
  return `${serverUrl}/${repository}/actions/runs/${runId}`;
}

async function readEvidenceFile(path: string): Promise<unknown> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw);
}

async function main(): Promise<void> {
  const evidencePath = process.argv[2];
  if (!evidencePath) {
    console.error("Usage: collect-control-evidence.ts <evidence-file.json>");
    process.exitCode = 1;
    return;
  }

  const dsn = process.env.CORVIS_POSTGRES_DSN;
  const tenantId = process.env.CORVIS_CONTROL_TENANT_ID;
  if (!dsn || !tenantId) {
    const missing = [!dsn && "CORVIS_POSTGRES_DSN", !tenantId && "CORVIS_CONTROL_TENANT_ID"].filter(Boolean).join(", ");
    console.log(
      `::notice::Skipping control-evidence collection: ${missing} not configured for this environment yet. ` +
        "This artifact still uploads normally; nothing else depends on this step.",
    );
    return;
  }

  const raw = await readEvidenceFile(evidencePath);
  const evidence = parseSecurityAcceptanceEvidence(raw);
  const collectedBy = process.env.CORVIS_CONTROL_EVIDENCE_COLLECTED_BY || "ci:security-acceptance";

  const outcome = await collectSecurityAcceptanceEvidence({
    tenantId,
    evidence,
    collectedBy,
    sourceRunUri: sourceRunUri(),
  });

  console.log(
    `Recorded control evidence ${outcome.sourceKey} revision ${outcome.revision} (${outcome.result}) for ${outcome.controlCode}.`,
  );
  if (outcome.promotedVersion != null) {
    console.log(`Promoted ${outcome.controlCode} to implementation version ${outcome.promotedVersion}.`);
  }
}

main().catch((error) => {
  console.error("Control evidence collection failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
